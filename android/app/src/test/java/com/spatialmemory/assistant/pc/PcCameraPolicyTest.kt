package com.spatialmemory.assistant.pc

import org.junit.Assert.assertEquals
import org.junit.Test

class PcCameraPolicyTest {
    @Test fun recallingSavedAppearanceAndLocationDoesNotOpenCameraOrBecomeASave() {
        for (s in listOf("你之前记住的手机的外观和位置是什么", "上次保存的蓝色水杯的样子和位置"))
            assertEquals(s, false, PcCameraPolicy.requiresCamera(s))
        assertEquals(true, PcCameraPolicy.requiresCamera("再记住之前那部手机的外观和位置"))
    }
    @Test fun comparingWithPreviousObjectStartsCamera() {
        for (s in listOf("这个是不是我上次让你记住的那个", "这部手机是之前那部吗", "这个跟上次记住的一样吗"))
            assertEquals(s, true, PcCameraPolicy.requiresCamera(s))
    }
    @Test fun historyDoesNotStartCaptureWhileScreenshotFollowupsDo() {
        for (s in listOf("在哪里呀？告诉我。", "蓝色水杯上次在哪里", "你记住水杯了吗"))
            assertEquals(s, false, PcCameraPolicy.requiresCamera(s))
        for (s in listOf("记住这个杯子", "可以。哦，你看一下。", "现在这个桌面上有没有？", "你看一下这个桌面上有没有之前说过的蓝色水杯。", "水杯现在在哪"))
            assertEquals(s, true, PcCameraPolicy.requiresCamera(s))
    }
    @Test fun personalObjectSearchAndConfirmedSelectionCanStartFreshCamera() {
        for (s in listOf("我的笔记本在哪", "我的水杯在哪里呢", "帮我找一下我的笔记本在哪"))
            assertEquals(s, true, PcCameraPolicy.requiresCamera(s))
        for (s in listOf("对", "是的", "就是那台", "第二个", "银色的"))
            assertEquals(s, true, PcCameraPolicy.requiresCamera(s, pendingFindChoice = true))
        for (s in listOf("不是那台", "取消", "不用找了", "上次笔记本在哪里"))
            org.junit.Assert.assertNotEquals(s, true, PcCameraPolicy.requiresCamera(s, pendingFindChoice = true))
    }
    @Test fun findingAnEarlierRememberedPhoneStillRequiresTheCurrentCamera() {
        for (s in listOf("帮我找上次记住的手机", "根据我现在的画面，帮我找到我的上次我手机在哪里。", "现在这个桌面有什么？"))
            assertEquals(s, true, PcCameraPolicy.requiresCamera(s))
        for (s in listOf("你还记得之前我手机放在哪里吗", "手机的样子"))
            assertEquals(s, false, PcCameraPolicy.requiresCamera(s))
    }
    @Test fun currentSceneLocationQuestionsOpenTheCameraButExplicitHistoryDoesNot() {
        for (s in listOf("这个耳机的位置在哪里", "这副耳机在手机的哪一边", "刚才描述的耳机在哪里", "这个水杯旁边有什么"))
            assertEquals(s, true, PcCameraPolicy.requiresCamera(s))
        for (s in listOf("这个耳机上次在哪里", "你还记得这个手机放在哪里吗"))
            assertEquals(s, false, PcCameraPolicy.requiresCamera(s))
    }
}
