package com.spatialmemory.assistant.hardware

import org.junit.Assert.*
import org.junit.Test

class VoiceProvisionFlowTest {
    @Test fun naturalConnectionAndRetryRepliesKeepOldCommandsWorking() {
        listOf("连接", "确定连接", "现在连", "连吧", "帮我连一下", "请连接一下设备吧！", "行的", "好，现在连", "可以呀").forEach {
            assertEquals(it, VoiceProvisionFlow.Action.SCAN, VoiceProvisionFlow().answer(it))
        }
        listOf("重试", "再试一次", "再连一次", "重新搜索", "麻烦再搜一次吧").forEach {
            val flow = VoiceProvisionFlow().apply { failed("test") }
            assertEquals(it, VoiceProvisionFlow.Action.SCAN, flow.answer(it))
        }
    }

    @Test fun negativesAndUncertainRepliesNeverStartConnection() {
        listOf("先别连接", "不要连接", "不用", "不连", "不了", "不要连", "不用连", "别连", "不用了", "现在不连接", "现在不连", "暂时不用", "取消连接", "算了吧").forEach {
            assertEquals(it, VoiceProvisionFlow.Action.EXIT, VoiceProvisionFlow().answer(it))
        }
        listOf("不确定", "可以吗", "现在连？", "好像可以", "不要连接设备先用手机", "他说连接", "连接还是不连接", "不能连接", "先不要连接然后重试").forEach {
            val flow = VoiceProvisionFlow()
            assertEquals(it, VoiceProvisionFlow.Action.NONE, flow.answer(it))
            assertEquals(VoiceProvisionFlow.Step.SEARCH, flow.step)
        }
    }

    @Test fun deviceChoiceAndPasswordConfirmationAreStateSpecific() {
        val flow = VoiceProvisionFlow()
        flow.answer("现在连")
        flow.scanned(listOf(DeviceCandidate("a", "A", 0), DeviceCandidate("b", "B", 0)))
        flow.answer("换一台吧")
        assertEquals("b", flow.device!!.id)
        assertEquals(VoiceProvisionFlow.Action.CONNECT, flow.answer("连吧"))
        flow.connected("Home")
        flow.answer("Abc12345")
        listOf("重试", "下一台", "再试一次", "不是不对", "正确吗").forEach {
            assertEquals(it, VoiceProvisionFlow.Action.NONE, flow.answer(it))
            assertEquals(VoiceProvisionFlow.Step.CONFIRM, flow.step)
        }
        flow.answer("读一下密码")
        assertTrue(flow.prompt.contains("大写 A"))
        assertEquals(VoiceProvisionFlow.Action.SEND, flow.answer("对的"))
    }

    @Test fun passwordCorrectionAndNetworkAliasesWork() {
        listOf("密码不对", "输错了", "改密码", "重新说").forEach {
            val flow = passwordStep()
            flow.answer("12345678")
            flow.answer(it)
            assertEquals(it, VoiceProvisionFlow.Step.PASSWORD, flow.step)
            assertTrue(flow.credentials().isEmpty())
        }
        val flow = passwordStep()
        flow.answer("12345678")
        flow.answer("换个网络吧")
        assertEquals(VoiceProvisionFlow.Step.SSID, flow.step)
    }

    @Test fun cameraChoiceUsesWholeReplies() {
        listOf("用手机", "手机摄像头", "请用手机拍", "切换到手机相机").forEach {
            assertEquals(it, GuideCommand.PHONE, GuideCommand.from(it))
        }
        listOf("用设备", "设备相机", "用眼镜", "使用设备摄像头").forEach {
            assertEquals(it, GuideCommand.DEVICE, GuideCommand.from(it))
        }
        listOf("不要用设备", "设备坏了吗", "用手机还是设备", "不要用手机").forEach {
            assertEquals(it, GuideCommand.UNKNOWN, GuideCommand.from(it))
        }
    }

    @Test fun credentialDataIsNotRewrittenAsCommands() {
        listOf("现在连", "先别连", "换一台", "用手机", "取消").forEach {
            val flow = passwordStep().apply { connected("") }
            flow.answer(it, literalPassword = true)
            assertEquals(it, flow.ssid)
            assertEquals(VoiceProvisionFlow.Step.PASSWORD, flow.step)
        }
        val flow = passwordStep().apply { connected("") }
        flow.answer("用手机")
        assertEquals("用手机", flow.ssid)
        assertEquals(VoiceProvisionFlow.Action.NONE, flow.answer("换一台"))
        assertEquals(VoiceProvisionFlow.Step.PASSWORD, flow.step)
        assertEquals(VoiceProvisionFlow.Action.EXIT, flow.answer("取消"))
    }

    @Test fun openNetworkAliasesStillRequireConfirmation() {
        listOf("无密码", "没有密码", "不用密码", "不需要密码", "没密码", "这个没有密码。").forEach {
            val flow = passwordStep()
            assertEquals(it, VoiceProvisionFlow.Action.NONE, flow.answer(it))
            assertEquals(VoiceProvisionFlow.Step.CONFIRM, flow.step)
            assertEquals(VoiceProvisionFlow.Action.SEND, flow.answer("没错"))
            assertTrue(flow.credentials().isEmpty())
        }
        assertNull(parseSpokenPassword("是不是没有密码"))
        val literal = passwordStep()
        literal.answer("没有密码", literalPassword = true)
        assertEquals(VoiceProvisionFlow.Step.PASSWORD, literal.step)
    }

    @Test fun startupDeclineExitsWithoutScanning() {
        val flow = VoiceProvisionFlow()
        assertTrue(flow.prompt.contains("设备还没连上"))
        assertEquals(VoiceProvisionFlow.Action.EXIT, flow.answer("暂不连接"))
        assertEquals(VoiceProvisionFlow.Step.DONE, flow.step)
        assertTrue(flow.credentials().isEmpty())
    }

    private fun passwordStep() = VoiceProvisionFlow().apply {
        assertEquals(VoiceProvisionFlow.Action.SCAN, answer("确定"))
        scanned(listOf(DeviceCandidate("a", "相机 A", -30), DeviceCandidate("b", "相机 B", -40)))
        assertTrue(prompt.contains("2台"))
        assertEquals(VoiceProvisionFlow.Action.CONNECT, answer("确定"))
        connected("Phone WiFi")
    }

    @Test fun fullDialogueRequiresExplicitCredentialConfirmation() {
        val flow = passwordStep()
        assertEquals(VoiceProvisionFlow.Step.PASSWORD, flow.step)
        assertEquals(VoiceProvisionFlow.Action.NONE, flow.answer("大写 A 小写 b 一 二 三 四 下划线 井号"))
        assertEquals(VoiceProvisionFlow.Step.CONFIRM, flow.step)
        assertTrue(flow.prompt.contains("8位密码"))
        assertFalse(flow.prompt.contains("大写 A"))
        flow.answer("复核密码")
        assertTrue(flow.prompt.contains("大写 A，小写 b，1，2，3，4，下划线，井号"))
        assertEquals(VoiceProvisionFlow.Action.NONE, flow.answer("不确定"))
        assertEquals(VoiceProvisionFlow.Action.SEND, flow.answer("确定"))
        assertArrayEquals("Ab1234_#".toCharArray(), flow.credentials())
        assertTrue(flow.credentials().isEmpty())
        flow.completed()
        assertEquals(VoiceProvisionFlow.Step.DONE, flow.step)
        assertEquals("", flow.ssid)
    }

    @Test fun nextDeviceAndCancellationNeverConnectWithoutConsent() {
        val flow = VoiceProvisionFlow()
        flow.answer("确定"); flow.scanned(listOf(DeviceCandidate("a", "A", 0), DeviceCandidate("b", "B", 0)))
        assertEquals(VoiceProvisionFlow.Action.NONE, flow.answer("下一台"))
        assertEquals("b", flow.device!!.id)
        assertEquals(VoiceProvisionFlow.Action.EXIT, flow.answer("取消"))
    }

    @Test fun denialErasesPasswordBeforeReentry() {
        val flow = passwordStep()
        flow.answer("Abc12345")
        assertEquals(VoiceProvisionFlow.Action.NONE, flow.answer("重新输入"))
        assertEquals(VoiceProvisionFlow.Step.PASSWORD, flow.step)
        assertTrue(flow.credentials().isEmpty())
    }

    @Test fun missingSsidHasVoiceFallbackAndNetworkCanBeChanged() {
        val flow = passwordStep()
        flow.connected("")
        assertEquals(VoiceProvisionFlow.Step.SSID, flow.step)
        flow.answer("家庭网络"); flow.answer("12345678"); flow.answer("修改网络")
        assertEquals(VoiceProvisionFlow.Step.SSID, flow.step)
        assertTrue(flow.credentials().isEmpty())
    }

    @Test fun invalidAndAmbiguousPasswordsAreNotGuessed() {
        listOf("abc", "大小写 A 一二三四五六七", "密码是12345678", "A B C D E F G H", "一二三四五六七未知").forEach {
            assertNull(it, parseSpokenPassword(it))
        }
    }

    @Test fun digitsSymbolsRawCaseAndOpenNetwork() {
        assertArrayEquals("12345678".toCharArray(), parseSpokenPassword("一二三四五六七八"))
        assertArrayEquals("Ab_@#123".toCharArray(), parseSpokenPassword("大写A，小写B，下划线，艾特，井号，一二三"))
        assertArrayEquals("aBcD123!".toCharArray(), parseSpokenPassword("aBcD123!"))
        assertArrayEquals(charArrayOf(), parseSpokenPassword("无密码"))
        assertNull(parseSpokenPassword("a".repeat(65)))
        assertNotNull(parseSpokenPassword("a".repeat(64)))
        assertNull(parseSpokenPassword("g".repeat(64)))
    }

    @Test fun failureDoesNotPretendWifiConnectedAndCanRetry() {
        val flow = passwordStep(); flow.answer("12345678"); flow.answer("确定")
        flow.failed("密码错误。")
        assertEquals(VoiceProvisionFlow.Step.RETRY, flow.step)
        assertEquals("密码错误。", flow.lastFailure)
        assertEquals("这次没连上，再试一次吗？", flow.prompt)
        assertTrue(flow.credentials().isEmpty())
        assertEquals(VoiceProvisionFlow.Action.SCAN, flow.answer("重试"))
    }

    @Test fun noDevicesAndRejectAllHaveBoundedRetry() {
        val flow = VoiceProvisionFlow(); flow.answer("确定"); flow.scanned(emptyList())
        assertEquals(VoiceProvisionFlow.Step.RETRY, flow.step)
        flow.answer("重试"); flow.scanned(listOf(DeviceCandidate("a", "A", 0))); flow.answer("下一台")
        assertEquals(VoiceProvisionFlow.Step.RETRY, flow.step)
        assertEquals(VoiceProvisionFlow.Action.EXIT, flow.answer("不要"))
    }

    @Test fun defaultMtuPacketsFitTwentyBytesWithoutLosingPayload() {
        val payload = ByteArray(63) { it.toByte() }
        val packets = provisionPackets(payload, 1, 10)
        assertTrue(packets.all { it.size <= 20 })
        assertArrayEquals(payload, packets.flatMap { it.drop(10) }.toByteArray())
    }

    @Test fun literalPasswordPreservesSpacesAndAlreadyConfiguredDoesNotRequestPassword() {
        val flow = passwordStep()
        flow.answer("ab cd123", literalPassword = true)
        assertEquals(VoiceProvisionFlow.Step.CONFIRM, flow.step)
        assertArrayEquals("ab cd123".toCharArray(), flow.credentials())
        flow.alreadyConfigured()
        assertEquals(VoiceProvisionFlow.Step.DONE, flow.step)
        assertTrue(flow.credentials().isEmpty())
        assertTrue(flow.prompt.contains("正在接收画面"))
    }

    @Test fun everyAsciiSymbolCanBeSpokenAndRepeatedUnambiguously() {
        val names = "波浪号 反引号 尖号 与号 左括号 右括号 左方括号 右方括号 左花括号 右花括号 小于号 大于号 问号 冒号 分号 单引号 双引号 反斜杠 竖线 斜杠"
        val expected = "~`^&()[]{}<>?:;'\"\\|/".toCharArray()
        assertArrayEquals(expected, parseSpokenPassword(names))
        assertArrayEquals(expected, parseSpokenPassword(spellPassword(expected)))
    }
}
