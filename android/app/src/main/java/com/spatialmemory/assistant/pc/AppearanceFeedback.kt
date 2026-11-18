package com.spatialmemory.assistant.pc

import java.util.Locale
import kotlin.math.floor

internal data class AppearanceDisplayScores(val base: Double,val appearance: Double,val color: Double,val ratio: Double,val detail: Double,val total: Double)

internal object AppearanceFeedback {
    fun format(status: String,scores: AppearanceDisplayScores?,threshold: Double,durationMs: Int): String {
        val title=when(status) {
            "LIKELY_MATCH" -> "外观相符"
            "AMBIGUOUS" -> "多个候选相近，请选择"
            "NO_MATCH" -> if(scores==null) "未检测到候选，等待新画面" else "未达匹配门槛"
            "NO_REFERENCE" -> "缺少参考图"
            "STALE_FRAME" -> "画面已过期，重新核对"
            "RECHECKING" -> "目标变化，重新核对"
            "SEARCH_ENDED" -> "本轮寻找已暂停"
            else -> "本次比较未完成"
        }
        if(scores==null)return "$title · ${durationMs}毫秒"
        fun two(value: Double)=String.format(Locale.US,"%.2f",value)
        // Do not round a below-threshold 0.64999 up to the displayed gate 0.650.
        val base=String.format(Locale.US,"%.3f",floor(scores.base*1000)/1000)
        val gate=String.format(Locale.US,"%.3f",threshold)
        return "$title · 匹配分$base / 门槛$gate · ${durationMs}毫秒\n外观${two(scores.appearance)} 颜色${two(scores.color)} 比例${two(scores.ratio)} · 细节+${two(scores.detail)} 总分${two(scores.total)}"
    }
}
