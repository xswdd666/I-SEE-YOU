package com.spatialmemory.assistant.pc

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.SystemClock
import com.spatialmemory.assistant.speech.Pcm16Assembler
import com.spatialmemory.assistant.speech.QwenVoiceProfile
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** Credentials remain on the PC; the tablet only fetches authenticated, fixed-voice PCM. */
internal class PcSpeechClient(context: Context) {
    private val connection = PcConnection(context.applicationContext)
    private var lastProfile: PcProfile? = null
    private var lastNetwork=Long.MIN_VALUE
    private var http: OkHttpClient? = null
    @Synchronized private fun client(): Pair<PcProfile, OkHttpClient> {
        val profile = connection.read() ?: throw IOException("speech_pc_not_connected")
        val network=connection.networkHandle(profile)
        if (profile != lastProfile || network != lastNetwork) {
            http?.connectionPool?.evictAll()
            http = connection.http(profile).newBuilder().callTimeout(180, TimeUnit.SECONDS).build()
            lastProfile = profile
            lastNetwork=network
        }
        return profile to checkNotNull(http)
    }
    fun playback(text: String) = Playback(text)
    inner class Playback(private val words: String) {
        private val cancelled = AtomicBoolean(false)
        @Volatile private var call: Call? = null
        @Volatile private var audio: AudioTrack? = null
        fun cancel() {
            cancelled.set(true); call?.cancel()
            audio?.let { runCatching { it.pause(); it.flush(); it.stop() } }
        }
        suspend fun play(onStarted: () -> Unit): Int = withContext(Dispatchers.IO) {
            var track: AudioTrack? = null
            try {
                ensureActive(); check(!cancelled.get())
                val (profile, client) = client()
                val request = Request.Builder().url(profile.origin + "/v1/speech").header("Authorization", "Bearer " + profile.token)
                    .post(JSONObject().put("text", words).toString().toRequestBody("application/json; charset=utf-8".toMediaType())).build()
                val requestCall = client.newCall(request); call = requestCall
                if (cancelled.get()) requestCall.cancel()
                requestCall.execute().use { response ->
                    if (!response.isSuccessful) throw IOException("speech_http_${response.code}")
                    check(QwenVoiceProfile.accepts(response.header("X-Speech-Provider"), response.header("X-Speech-Model"), response.header("X-Speech-Voice"), response.header("X-Audio-Format"), response.header("X-Audio-Sample-Rate"))) { "speech_voice_invalid" }
                    val body = response.body ?: throw IOException("speech_audio_missing")
                    val minimum = AudioTrack.getMinBufferSize(QwenVoiceProfile.RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
                    check(minimum > 0)
                    val output = AudioTrack.Builder()
                        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                        .setAudioFormat(AudioFormat.Builder().setSampleRate(QwenVoiceProfile.RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                        .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(maxOf(minimum * 2, 9600)).build()
                    track = output; audio = output; ensureActive(); check(!cancelled.get()); output.play()
                    val assembler = Pcm16Assembler(); val buffer = ByteArray(8192); var started = false; var frames = 0L
                    body.byteStream().use { input ->
                        while (true) {
                            ensureActive(); check(!cancelled.get()); val size = input.read(buffer); if (size == -1) break
                            val pcm = assembler.append(buffer, size); var offset = 0
                            while (offset < pcm.size) {
                                ensureActive(); check(!cancelled.get())
                                val written = output.write(pcm, offset, pcm.size - offset, AudioTrack.WRITE_BLOCKING)
                                if (written <= 0) throw IOException("speech_playback_failed")
                                offset += written; frames += written / 2
                                if (!started) { started = true; onStarted() }
                            }
                        }
                    }
                    assembler.finish()
                    val until = SystemClock.elapsedRealtime() + 3000
                    while ((output.playbackHeadPosition.toLong() and 0xffffffffL) < frames) {
                        ensureActive(); check(!cancelled.get()); check(SystemClock.elapsedRealtime() < until) { "speech_drain_timeout" }; delay(20)
                    }
                    assembler.bytes
                }
            } finally {
                audio = null; call = null
                track?.let { runCatching { it.stop() }; it.release() }
            }
        }
    }
}
