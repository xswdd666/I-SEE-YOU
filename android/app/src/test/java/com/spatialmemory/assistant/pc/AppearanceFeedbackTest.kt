package com.spatialmemory.assistant.pc

import org.junit.Assert.*
import org.junit.Test

class AppearanceFeedbackTest {
    private fun scores(base: Double)=AppearanceDisplayScores(base,.46,.66,.97,.05,base+.05)
    @Test fun highShapeScoreDoesNotLookLikeAnAcceptedObject() {
        val result=AppearanceFeedback.format("NO_MATCH",scores(.5532),.65,600)
        assertTrue(result.startsWith("未达匹配门槛 · 匹配分0.553 / 门槛0.650"))
        assertTrue(result.contains("比例0.97"))
    }
    @Test fun belowThresholdCannotRoundUpToTheThreshold() {
        assertTrue(AppearanceFeedback.format("NO_MATCH",scores(.64999),.65,1).contains("匹配分0.649 / 门槛0.650"))
    }
    @Test fun highButStaleScoreStillExplainsWhyItCannotGuide() {
        val result=AppearanceFeedback.format("STALE_FRAME",scores(.95),.65,800)
        assertTrue(result.startsWith("画面已过期"));assertFalse(result.contains("外观相符"))
    }
    @Test fun absentCandidateAndStoppedSearchDoNotDisplayFakeOrPreviousScores() {
        assertEquals("未检测到候选，等待新画面 · 3毫秒",AppearanceFeedback.format("NO_MATCH",null,.65,3))
        assertEquals("本轮寻找已暂停 · 0毫秒",AppearanceFeedback.format("SEARCH_ENDED",null,.65,0))
    }
}
