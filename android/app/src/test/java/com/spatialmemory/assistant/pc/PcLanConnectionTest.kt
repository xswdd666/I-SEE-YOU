package com.spatialmemory.assistant.pc

import java.io.IOException
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class PcLanConnectionTest {
    private val paired=PcProfile("127.0.0.1",8765,"a".repeat(64),"t".repeat(43))
    @Test fun privateDiscoveryCannotRedirectToPublicOrFakeAddresses(){
        for(host in listOf("10.1.1.165","172.16.9.231","192.168.1.5"))assertTrue(PcLanPolicy.privateHost(host))
        for(host in listOf("8.8.8.8","198.18.0.1","127.0.0.1","256.1.1.1","10.1.2","010.1.1.1","localhost"))assertFalse(host,PcLanPolicy.privateHost(host))
        assertTrue(PcLanPolicy.privateHost("127.0.0.1",true))
        val nonce="b".repeat(32)
        assertTrue(PcLanPolicy.acceptOffer("10.1.1.5",8765,PcLanPolicy.PROTOCOL,nonce,nonce,paired.fingerprint,paired.fingerprint))
        assertFalse(PcLanPolicy.acceptOffer("10.1.1.5",8765,PcLanPolicy.PROTOCOL,nonce,"c".repeat(32),paired.fingerprint,paired.fingerprint))
        assertFalse(PcLanPolicy.acceptOffer("10.1.1.5",8765,PcLanPolicy.PROTOCOL,nonce,nonce,"c".repeat(64),paired.fingerprint))
        assertFalse(paired.toString().contains(paired.token))
    }
    @Test fun trustedLanIsPreferredEvenWhenUsbStillWorks()=runTest {
        val lan=paired.copy(host="192.168.50.2");val attempts=mutableListOf<String>();var saved:PcProfile?=null
        val resolver=PcEndpointResolver({listOf(lan)},{emptyList()},{attempts.add(it.host);true},{saved=it})
        assertEquals(lan,resolver.resolve(paired));assertEquals(listOf(lan.host),attempts);assertEquals(lan,saved)
    }
    @Test fun routedWiredAddressIsAllowedEvenIfTabletAndPcHaveDifferentPrefixes()=runTest {
        val old=paired.copy(host="10.1.1.50");val attempts=mutableListOf<String>();var saved:PcProfile?=null
        val resolver=PcEndpointResolver({emptyList()},{listOf("172.16.9.231")},{attempts.add(it.host);it.host=="172.16.9.231"},{saved=it})
        assertEquals("172.16.9.231",resolver.resolve(old).host);assertEquals(listOf("10.1.1.50","172.16.9.231"),attempts);assertEquals(paired.token,saved?.token)
    }
    @Test fun untrustedDiscoveryCannotReplaceThePairedComputer()=runTest {
        val attempts=mutableListOf<PcProfile>();var saves=0
        val resolver=PcEndpointResolver({listOf(paired.copy(host="192.168.1.2",fingerprint="c".repeat(64)))},{emptyList()},{attempts.add(it);it.host=="127.0.0.1"},{saves++})
        assertEquals(paired,resolver.resolve(paired));assertEquals(listOf(paired),attempts);assertEquals(0,saves)
    }
    @Test fun unreachableDiscoveryDoesNotOverwriteTheSavedConnection()=runTest {
        var saves=0;val resolver=PcEndpointResolver({listOf(paired.copy(host="10.1.1.2"))},{emptyList()},{false},{saves++})
        try { resolver.resolve(paired);fail("must not save an unreachable address") } catch(_:IOException){}
        assertEquals(0,saves)
    }
    @Test fun rememberedVirtualAdaptersCannotStarveUsbFallback()=runTest {
        val attempts=mutableListOf<String>();val resolver=PcEndpointResolver({emptyList()},{(1..8).map { "192.168.$it.2" }},{attempts.add(it.host);it.host=="127.0.0.1"},{})
        assertEquals(paired,resolver.resolve(paired));assertEquals(5,attempts.size);assertEquals("127.0.0.1",attempts.last())
    }
    @Test fun oneRetryLoopRecoversAndPausingCancelsOldRetries()=runTest {
        var calls=0;var connected=false
        val loop=PcReconnectLoop(this,{connected},{calls++;if(calls<3)throw IOException("transient");connected=true},{})
        loop.resume();loop.request();runCurrent();assertEquals(1,calls)
        advanceTimeBy(1000);runCurrent();assertEquals(2,calls)
        loop.pause();advanceTimeBy(20000);runCurrent();assertEquals(2,calls)
        loop.resume();runCurrent();assertEquals(3,calls);assertTrue(connected);loop.pause()
    }
    @Test fun invalidAccountOrVersionDoesNotCauseAnAutomaticRequestStorm()=runTest {
        var calls=0;val loop=PcReconnectLoop(this,{false},{calls++;error("account conflict")},{})
        loop.resume();runCurrent();advanceTimeBy(30000);runCurrent();assertEquals(1,calls);loop.pause()
    }
}
