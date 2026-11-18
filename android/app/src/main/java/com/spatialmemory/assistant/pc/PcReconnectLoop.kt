package com.spatialmemory.assistant.pc

import java.io.IOException
import kotlinx.coroutines.*

/** One foreground retry loop; never restarts an old camera/search task. */
class PcReconnectLoop(private val scope: CoroutineScope,private val connected: ()->Boolean,private val connect: suspend ()->Unit,private val failed: (Throwable)->Unit) {
    private var active=false
    private var job: Job?=null
    fun resume(){active=true;request()}
    fun pause(){active=false;job?.cancel();job=null}
    fun request(){
        if(!active||job?.isActive==true)return
        job=scope.launch {
            var attempt=0
            while(active&&!connected()){
                try { connect();if(connected())return@launch }
                catch(error: TimeoutCancellationException){failed(error)}
                catch(error: CancellationException){throw error}
                catch(error: IOException){failed(error)}
                catch(error: Exception){failed(error);return@launch}
                delay(listOf(1000L,2000L,4000L,10000L)[attempt.coerceAtMost(3)]);attempt++
            }
        }
    }
}
