package com.spatialmemory.assistant.realtime

import org.junit.Assert.*
import org.junit.Test

class SpeechTranscriptProgressTest {
    @Test fun revisedDraftReplacesTentativeWordsWithoutRepeatingPrefix() {
        val p = SpeechTranscriptProgress()
        assertEquals("桌上有什么", p.update("u", "桌上", "有什么")!!.text)
        assertEquals("桌上有哪些东西", p.update("u", "桌上有", "哪些东西")!!.text)
        p.finish("u")
        assertEquals("眼前", p.update("u", null, delta = "眼前")!!.text)
        assertEquals("眼前有什么", p.update("u", null, delta = "有什么")!!.text)
    }
    @Test fun emptyAndInvalidEventsCannotStartPreparationAndBuffersAreBounded() {
        val p = SpeechTranscriptProgress()
        assertNull(p.update("", "桌上有什么"))
        assertNull(p.update("u", ""))
        assertEquals(600, p.update("u", "字".repeat(700))!!.text!!.length)
        p.clear()
        assertEquals("新", p.update("u", null, delta = "新")!!.text)
    }
}
