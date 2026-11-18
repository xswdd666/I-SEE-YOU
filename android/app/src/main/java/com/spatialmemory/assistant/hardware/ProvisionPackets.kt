package com.spatialmemory.assistant.hardware

import java.nio.ByteBuffer
import java.nio.ByteOrder

internal fun provisionPackets(payload: ByteArray, requestId: Int, chunkSize: Int = 150): List<ByteArray> {
    val chunks = payload.asList().chunked(chunkSize).ifEmpty { listOf(emptyList()) }
    return chunks.mapIndexed { index, values ->
        ByteBuffer.allocate(10 + values.size).order(ByteOrder.LITTLE_ENDIAN)
            .putInt(requestId).putShort(index.toShort()).putShort(chunks.size.toShort()).putShort(values.size.toShort())
            .put(values.toByteArray()).array()
    }
}
