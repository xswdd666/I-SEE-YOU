package com.spatialmemory.assistant.realtime

/** ASR confirmed prefixes replace older drafts; they are not appended twice. */
internal class SpeechTranscriptProgress {
    private val partials = linkedMapOf<String, String>()
    fun update(id: String, confirmed: String?, tentative: String = "", delta: String? = null): QwenEvent.InputSpeech? {
        if (id.isBlank() || id.length > 160) return null
        val words = if (confirmed != null) confirmed + tentative else (partials[id].orEmpty() + delta.orEmpty())
        if (words.isBlank()) return null
        partials[id] = words.take(600)
        while (partials.size > 4) partials.remove(partials.keys.first())
        return QwenEvent.InputSpeech(id, partials[id])
    }
    fun finish(id: String) { partials.remove(id) }
    fun clear() { partials.clear() }
}
