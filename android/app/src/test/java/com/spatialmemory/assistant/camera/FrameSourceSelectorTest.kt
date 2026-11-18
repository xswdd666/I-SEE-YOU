package com.spatialmemory.assistant.camera

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class FrameSourceSelectorTest {
    private class Source(override val source: CameraSource, val fail: Boolean = false) : FrameSource {
        override val frames = MutableSharedFlow<FramePacket>(extraBufferCapacity = 1)
        override val state = MutableStateFlow(FrameSourceState.IDLE)
        var stopped = false
        override suspend fun start() {
            if (fail) error("Camera missing")
            state.value = FrameSourceState.RUNNING
        }
        override suspend fun stop() { stopped = true; state.value = FrameSourceState.STOPPED }
        fun emit(id: Long) = frames.tryEmit(FramePacket(id, source, System.currentTimeMillis(), byteArrayOf(1)))
    }

    @Test fun switchStopsOldSourceAndRejectsItsLateFrames() = runTest {
        val selector = FrameSourceSelector(backgroundScope)
        val phone = Source(CameraSource.PHONE)
        val esp = Source(CameraSource.ESP32)
        selector.switchTo(phone); phone.emit(1); runCurrent()
        assertEquals(CameraSource.PHONE, selector.latestFrame.value?.source)
        selector.switchTo(esp)
        assertTrue(phone.stopped); assertNull(selector.latestFrame.value)
        phone.emit(2); runCurrent(); assertNull(selector.latestFrame.value)
        esp.emit(3); runCurrent(); assertEquals(CameraSource.ESP32, selector.latestFrame.value?.source)
        selector.stop(); assertTrue(esp.stopped); assertNull(selector.latestFrame.value)
        selector.switchTo(phone); phone.emit(4); runCurrent()
        assertEquals(CameraSource.PHONE, selector.latestFrame.value?.source)
        selector.stop()
    }

    @Test fun failedStartClearsFramesAndReleasesSource() = runTest {
        val selector = FrameSourceSelector(backgroundScope)
        val broken = Source(CameraSource.PHONE, fail = true)
        try { selector.switchTo(broken); fail("Must fail") } catch (_: IllegalStateException) { }
        assertTrue(broken.stopped)
        assertNull(selector.latestFrame.value)
        assertEquals(FrameSourceState.FAILED, selector.state.value)
    }
}
