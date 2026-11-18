package com.spatialmemory.assistant.speech

import org.junit.Assert.*
import org.junit.Test

class QwenVoiceProfileTest {
    @Test fun `only the pinned Qwen speaker and audio format can play`() {
        assertTrue(QwenVoiceProfile.accepts("qwen", QwenVoiceProfile.MODEL, "Cherry", "pcm_s16le", "24000"))
        assertFalse(QwenVoiceProfile.accepts("xiaomi", QwenVoiceProfile.MODEL, "Cherry", "pcm_s16le", "24000"))
        assertFalse(QwenVoiceProfile.accepts("qwen", QwenVoiceProfile.MODEL, "Tina", "pcm_s16le", "24000"))
        assertFalse(QwenVoiceProfile.accepts("qwen", QwenVoiceProfile.MODEL, "Cherry", "pcm_s16le", "16000"))
    }
    @Test fun `split samples across HTTP reads reconstruct without losing or duplicating bytes`() {
        val stream = Pcm16Assembler()
        assertArrayEquals(byteArrayOf(), stream.append(byteArrayOf(1), 1))
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), stream.append(byteArrayOf(2, 3, 4), 3))
        stream.finish(); assertEquals(4, stream.bytes)
    }
    @Test fun `truncated PCM cannot be treated as completed speech`() {
        val stream = Pcm16Assembler(); stream.append(byteArrayOf(1), 1)
        assertThrows(IllegalStateException::class.java) { stream.finish() }
        assertThrows(IllegalStateException::class.java) { Pcm16Assembler().finish() }
    }
}
