package com.spatialmemory.assistant.speech

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.spatialmemory.assistant.pc.PcSpeechClient
import java.io.Closeable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

enum class SpeechPriority { P0, P1, P2, P3 }
data class SpeechEvent(val key: String, val text: String, val priority: SpeechPriority, val replacePendingKey: String? = null, val onStarted: (() -> Unit)? = null)
internal class SpeechDeduplicator {
    private val spoken = mutableSetOf<String>()
    fun accept(event: SpeechEvent): Boolean = event.text.isNotBlank() && event.priority != SpeechPriority.P3 && spoken.add(event.key)
    fun clear() = spoken.clear()
}
internal class SpeechQueue {
    private val waiting = ArrayDeque<SpeechEvent>()
    var active: SpeechEvent? = null
        private set
    val idle: Boolean get() = active == null && waiting.isEmpty()
    fun offer(event: SpeechEvent): Boolean {
        val interrupt = event.priority == SpeechPriority.P0
        if (interrupt) clear()
        event.replacePendingKey?.let { group -> waiting.removeAll { it.replacePendingKey == group } }
        waiting.addLast(event); return interrupt
    }
    fun next(): SpeechEvent? {
        if (active != null || waiting.isEmpty()) return null
        return waiting.removeFirst().also { active = it }
    }
    fun complete(key: String?): Boolean {
        if (key == null || active?.key != key) return false
        active = null; return true
    }
    fun clear() { active = null; waiting.clear() }
}

/** The only output path is Qwen Cherry audio. No system TTS or alternate speaker fallback. */
class SpeechCoordinator(context: Context, private val microphoneEnabled: (Boolean) -> Unit) : Closeable {
    private val app = context.applicationContext
    private val handler = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(Dispatchers.Main.immediate + SupervisorJob())
    private val client = PcSpeechClient(app)
    private val deduplicator = SpeechDeduplicator()
    private val queue = SpeechQueue()
    private var player: PcSpeechClient.Playback? = null
    private var job: Job? = null
    @Volatile private var enabled = true
    @Volatile private var epoch = 0L
    @Volatile private var closed = false
    var onVoiceUnavailable: ((String) -> Unit)? = null
    init {
        if (com.spatialmemory.assistant.BuildConfig.DEBUG) runCatching {
            val profile = org.json.JSONObject().put("provider", QwenVoiceProfile.PROVIDER).put("model", QwenVoiceProfile.MODEL).put("voice", QwenVoiceProfile.VOICE).put("sampleRate", QwenVoiceProfile.RATE).put("systemTts", false)
            java.io.File(app.filesDir, "speech-voice-profile.json").writeText(profile.toString())
        }
        handler.post(::consumeVoiceTest)
    }
    fun setEnabled(value: Boolean) { enabled = value; if (!value) reset() }
    fun announce(event: SpeechEvent) {
        if (!enabled || closed || !deduplicator.accept(event)) return
        val acceptedEpoch = epoch
        handler.post {
            if (acceptedEpoch != epoch || !enabled || closed) return@post
            if (queue.offer(event)) cancelPlayback()
            drain()
        }
    }
    private fun cancelPlayback() { player?.cancel(); player = null; job?.cancel(); job = null }
    fun reset() {
        epoch++; deduplicator.clear()
        handler.post { cancelPlayback(); queue.clear(); microphoneEnabled(true); android.util.Log.i("LocalSpeech", "reset epoch=$epoch provider=qwen") }
    }
    private fun drain() {
        if (!enabled || closed) return
        queue.next()?.let(::speak)
    }
    private fun speak(event: SpeechEvent) {
        val speakingEpoch = epoch
        val playback = client.playback(event.text); player = playback
        microphoneEnabled(false)
        android.util.Log.i("LocalSpeech", "synthesis provider=qwen model=${QwenVoiceProfile.MODEL} voice=${QwenVoiceProfile.VOICE} epoch=$epoch")
        job = scope.launch {
            try {
                val bytes = playback.play {
                    handler.post { if (speakingEpoch == epoch && queue.active?.key == event.key) {
                        event.onStarted?.invoke(); android.util.Log.i("LocalSpeech", "started epoch=$epoch provider=qwen voice=${QwenVoiceProfile.VOICE}")
                    } }
                }
                if (speakingEpoch == epoch && queue.complete(event.key)) {
                    android.util.Log.i("LocalSpeech", "finished epoch=$epoch provider=qwen voice=${QwenVoiceProfile.VOICE} bytes=$bytes")
                    player = null; drain(); if (queue.idle) resumeMicrophone(speakingEpoch)
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (speakingEpoch == epoch && queue.complete(event.key)) {
                    android.util.Log.w("LocalSpeech", "qwen_speech_failed type=${error.javaClass.simpleName}")
                    queue.clear(); microphoneEnabled(true); onVoiceUnavailable?.invoke("千问语音暂不可用，回答仍可在对话记录中查看。")
                }
            } finally { if (player === playback) { player = null; job = null } }
        }
    }
    private fun resumeMicrophone(completedEpoch: Long) { handler.postDelayed({ if (completedEpoch == epoch && queue.idle && !closed) microphoneEnabled(true) }, 150) }
    private fun consumeVoiceTest() {
        if (!com.spatialmemory.assistant.BuildConfig.DEBUG) return
        val marker = java.io.File(app.filesDir, "speech-voice-test.once")
        if (!marker.isFile || marker.length() > 16 || marker.readText().trim() != "run" || !marker.delete()) return
        listOf("好，我看一下。", "这是千问统一音色测试。下面的场景描述，使用和刚才提示相同的声音。", "测试完成。提示、场景描述和记忆查询，都由千问同一个发音人朗读。").forEachIndexed { i, words -> announce(SpeechEvent("qwen-voice-test-$epoch-$i", words, SpeechPriority.P1)) }
    }
    override fun close() { closed = true; epoch++; cancelPlayback(); scope.cancel(); handler.post { queue.clear() } }
}
