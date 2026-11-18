package com.spatialmemory.assistant.hardware

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class ProvisionPacketsTest {
    @Test fun `open network sends an explicit empty password packet`() {
        val packets = provisionPackets(byteArrayOf(), 42)
        assertEquals(1, packets.size)
        val header = ByteBuffer.wrap(packets.single()).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(10, header.remaining())
        assertEquals(42, header.int)
        assertEquals(0, header.short.toInt())
        assertEquals(1, header.short.toInt())
        assertEquals(0, header.short.toInt())
    }

    @Test fun `nonempty payload keeps its bytes and sequence`() {
        val payload = ByteArray(301) { it.toByte() }
        val decoded = provisionPackets(payload, 7).flatMapIndexed { index, bytes ->
            val packet = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            assertEquals(7, packet.int)
            assertEquals(index, packet.short.toInt())
            assertEquals(3, packet.short.toInt())
            val size = packet.short.toInt()
            assertEquals(size, packet.remaining())
            ByteArray(size).also(packet::get).toList()
        }.toByteArray()
        assertArrayEquals(payload, decoded)
    }

    @Test fun `simulated provisioner accepts open network but rejects missing SSID`() = runTest {
        val provisioner = FakeDeviceProvisioner()
        assertTrue(provisioner.provision("device", "Open network", charArrayOf()) is ProvisionResult.Success)
        assertTrue(provisioner.provision("device", "", charArrayOf()) is ProvisionResult.Failure)
    }
}
