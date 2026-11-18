package com.spatialmemory.assistant.speech

internal object QwenVoiceProfile {
    const val PROVIDER = "qwen"
    const val MODEL = "qwen3-tts-flash-realtime"
    const val VOICE = "Cherry"
    const val RATE = 24000
    const val MAX_BYTES = 12 * 1024 * 1024
    fun accepts(provider: String?, model: String?, voice: String?, format: String?, rate: String?) =
        provider == PROVIDER && model == MODEL && voice == VOICE && format == "pcm_s16le" && rate == RATE.toString()
}

/** HTTP reads may split a 16-bit sample between buffers. */
internal class Pcm16Assembler {
    private var tail: Byte? = null
    var bytes: Int = 0
        private set
    fun append(input: ByteArray, size: Int): ByteArray {
        require(size in 0..input.size)
        bytes += size
        require(bytes <= QwenVoiceProfile.MAX_BYTES)
        val data = ByteArray(size + if (tail == null) 0 else 1)
        val offset = if (tail == null) 0 else 1
        tail?.let { data[0] = it }
        input.copyInto(data, offset, 0, size)
        val aligned = data.size / 2 * 2
        tail = if (aligned < data.size) data.last() else null
        return if (aligned == data.size) data else data.copyOf(aligned)
    }
    fun finish() { check(bytes > 0 && tail == null) { "speech_audio_incomplete" } }
}
