package com.spatialmemory.assistant.speech

import org.junit.Assert.*
import org.junit.Test

class SpeechQueueTest {
    private fun words(key: String, group: String = "turn") = SpeechEvent(key, key, SpeechPriority.P1, replacePendingKey = group)
    @Test fun `a later result or progress cannot cut an answer already being spoken`() {
        val queue = SpeechQueue()
        assertFalse(queue.offer(words("answer")))
        assertEquals("answer", queue.next()?.key)
        assertFalse(queue.offer(words("progress-1")))
        assertFalse(queue.offer(words("progress-2")))
        assertEquals("answer", queue.active?.key)
        assertNull(queue.next())
        assertTrue(queue.complete("answer"))
        assertEquals("progress-2", queue.next()?.key)
    }
    @Test fun `a new task clears old speech and stale completion cannot finish its replacement`() {
        val queue = SpeechQueue()
        queue.offer(words("old")); queue.next(); queue.offer(words("old-pending"))
        queue.clear(); queue.offer(words("new", "new-turn")); queue.next()
        assertFalse(queue.complete("old"))
        assertEquals("new", queue.active?.key)
        assertTrue(queue.complete("new")); assertTrue(queue.idle)
    }
    @Test fun `a ready result removes an acknowledgement still waiting to start`() {
        val queue = SpeechQueue()
        queue.offer(words("ack")); queue.offer(words("result"))
        assertEquals("result", queue.next()?.key)
        assertTrue(queue.complete("result")); assertTrue(queue.idle)
    }
}
