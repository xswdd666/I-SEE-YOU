package com.spatialmemory.assistant.camera

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Call from the main thread: CameraX binds/unbinds through the host lifecycle. */
class FrameSourceSelector(private val scope: CoroutineScope) {
    private val operations = Mutex()
    private val router = FrameRouter()
    private var active: FrameSource? = null
    private var frameJob: Job? = null
    private var stateJob: Job? = null
    private val mutableState = MutableStateFlow(FrameSourceState.IDLE)
    val state = mutableState.asStateFlow()
    val latestFrame = router.frame

    suspend fun switchTo(source: FrameSource) = operations.withLock {
        stopLocked()
        val generation = router.switchTo(source.source)
        active = source
        mutableState.value = FrameSourceState.STARTING
        frameJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            source.frames.collect { router.offer(it, generation) }
        }
        try {
            source.start()
            stateJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
                source.state.collect {
                    mutableState.value = it
                    if (it == FrameSourceState.FAILED || it == FrameSourceState.STOPPED) router.stop()
                }
            }
        }
        catch (error: Throwable) {
            runCatching { stopLocked() }
            mutableState.value = FrameSourceState.FAILED
            throw error
        }
    }

    suspend fun stop() = operations.withLock { stopLocked() }

    private suspend fun stopLocked() {
        frameJob?.cancelAndJoin(); frameJob = null
        stateJob?.cancelAndJoin(); stateJob = null
        router.stop()
        active?.stop()
        active = null
        mutableState.value = FrameSourceState.STOPPED
    }
}
