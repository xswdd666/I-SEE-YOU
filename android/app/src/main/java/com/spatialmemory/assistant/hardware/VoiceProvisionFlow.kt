package com.spatialmemory.assistant.hardware

enum class GuideCommand {
    YES, NO, CONNECT, RETRY, NEXT, CANCEL, PHONE, DEVICE, REENTER, NETWORK, REVIEW, UNKNOWN;

    companion object {
        fun from(text: String): GuideCommand {
            // Match whole replies so questions, negations and mixed requests stay ambiguous.
            val words = text.trim().replace(Regex("[\\s，。！、,.!]"), "")
                .replace(Regex("^(?:麻烦你|麻烦|请你|请|帮我)"), "")
                .replace(Regex("(?:吧|呀|啊|啦)$"), "")
            return when (words) {
                "确定", "确认", "是", "是的", "好的", "好", "好嘞", "行", "行的", "可以", "可以的",
                "没问题", "需要", "要", "嗯", "嗯嗯", "嗯好", "嗯好的", "嗯可以", "对", "对的", "没错", "正确", "确认无误", "就这样" -> YES
                "连接", "连", "现在连", "现在连接", "连接一下", "连一下", "连上", "连上设备", "连接设备",
                "连接一下设备", "连接蓝牙", "打开蓝牙", "开始", "开始连接", "开始搜索", "搜索设备",
                "扫描设备", "确定连接", "确定要连接", "我要连接", "我想连接", "需要连接", "好现在连", "现在就连", "那就连" -> CONNECT
                "重试", "再试", "再试一次", "再试一下", "试一次", "重新连接", "再连一次", "重新搜索",
                "重新扫描", "再搜一次", "再找一下", "再来一次" -> RETRY
                "不", "不是", "不对", "否", "不要", "不用", "不需要", "暂不连接", "暂时不连接",
                "先不连", "先别连", "先别连接", "不连", "不连接", "不要连", "不要连接", "不用连", "不用连接",
                "别连", "不了", "不用了", "现在不连", "现在不连接", "暂时不用", "先不用" -> NO
                "下一台", "下一个", "换一台", "换一个", "换个设备", "换下一台", "不是这台", "不是这个设备" -> NEXT
                "取消", "退出", "停止配网", "取消连接", "停止连接", "取消配网", "算了", "先算了", "不连了", "不配了" -> CANCEL
                "使用手机相机", "使用手机摄像头", "手机相机", "手机摄像头", "用手机", "使用手机",
                "用手机相机", "用手机摄像头", "切换手机相机", "切换到手机相机", "切换到手机摄像头", "用手机拍" -> PHONE
                "使用设备摄像头", "设备摄像头", "设备相机", "使用设备相机", "用设备", "用设备摄像头",
                "用设备相机", "切换到设备摄像头", "切换设备摄像头", "用眼镜", "眼镜摄像头" -> DEVICE
                "重新输入", "重输", "重新说", "再说一遍", "改密码", "修改密码", "密码不对", "密码错了", "输错了" -> REENTER
                "修改网络", "换网络", "换个网络", "换一个网络", "改网络", "重新输入网络名称", "修改网络名称" -> NETWORK
                "复核密码", "核对密码", "读一下密码", "读一遍密码", "再读一遍密码", "密码再说一遍" -> REVIEW
                else -> UNKNOWN
            }
        }
    }
}

/** Local-only dialogue. Never put this object or its prompts in telemetry. */
class VoiceProvisionFlow {
    enum class Step { SEARCH, SCANNING, DEVICE, CONNECTING, SSID, PASSWORD, CONFIRM, SENDING, RETRY, DONE }
    enum class Action { NONE, SCAN, CONNECT, READ_WIFI, SEND, EXIT }
    var step = Step.SEARCH
        private set
    var prompt = "设备还没连上，现在连吗？"
        private set
    var ssid = ""
        private set
    private var password = charArrayOf()
    private var devices = emptyList<DeviceCandidate>()
    private var index = 0
    val device get() = devices.getOrNull(index)
    val sensitive get() = step == Step.PASSWORD || step == Step.CONFIRM

    fun command(text: String, literal: Boolean = false): GuideCommand {
        if (step == Step.SSID || step == Step.PASSWORD) {
            if (literal) return GuideCommand.UNKNOWN
            // Credential dictation is data. Only explicit escape commands interrupt it.
            return when (text.trim()) {
                "取消", "退出", "停止配网" -> GuideCommand.CANCEL
                "使用手机相机", "使用手机摄像头", "手机相机" -> GuideCommand.PHONE
                else -> GuideCommand.UNKNOWN
            }
        }
        return GuideCommand.from(text)
    }

    fun answer(text: String, literalPassword: Boolean = false): Action {
        val command = command(text, literalPassword)
        if (command == GuideCommand.CANCEL || command == GuideCommand.PHONE) {
            clear(); step = Step.DONE; prompt = "好，用手机相机。"; return Action.EXIT
        }
        val yes = command == GuideCommand.YES || command == GuideCommand.CONNECT
        val no = command == GuideCommand.NO
        return when (step) {
            Step.SEARCH, Step.RETRY -> when {
                yes || command == GuideCommand.RETRY -> { clear(); step = Step.SCANNING; prompt = "我找找附近的设备。"; Action.SCAN }
                no -> { clear(); step = Step.DONE; prompt = "好，用手机相机。"; Action.EXIT }
                else -> { prompt = "现在连接设备吗？可以说连接，或先不连。"; Action.NONE }
            }
            Step.DEVICE -> when {
                yes -> { step = Step.CONNECTING; prompt = "正在连接${device!!.name}。"; Action.CONNECT }
                no || command == GuideCommand.NEXT -> {
                    index++
                    if (device == null) failed("已询问所有设备。") else askDevice()
                    Action.NONE
                }
                else -> { askDevice(); Action.NONE }
            }
            Step.SSID -> {
                if (text.isBlank() || text.toByteArray(Charsets.UTF_8).size > 32) {
                    prompt = "这个网络名字没识别好，再说一次？"
                } else { ssid = text; askPassword() }
                Action.NONE
            }
            Step.PASSWORD -> {
                clearPassword()
                val parsed = if (literalPassword) {
                    if (text == "无密码") charArrayOf() else text.takeIf(::validWifiPassword)?.toCharArray()
                } else parseSpokenPassword(text)
                if (parsed == null) prompt = "密码没听清，咱们一个字一个字说，字母带上大小写。"
                else {
                    password = parsed
                    step = Step.CONFIRM
                    prompt = "连接$ssid，收到${password.size}位密码。对吗？也可以说核对密码。"
                }
                Action.NONE
            }
            Step.CONFIRM -> when {
                command == GuideCommand.REVIEW -> { prompt = "密码是，${spellPassword(password)}。对吗？"; Action.NONE }
                yes -> { step = Step.SENDING; prompt = "正在连Wi-Fi，稍等一下。"; Action.SEND }
                no || command == GuideCommand.REENTER -> { clearPassword(); askPassword(); Action.NONE }
                command == GuideCommand.NETWORK -> { clear(); step = Step.SSID; prompt = "手机连的是哪个Wi-Fi？"; Action.NONE }
                else -> { prompt = "密码对吗？可以说确定、重新输入，或核对密码。"; Action.NONE }
            }
            else -> Action.NONE
        }
    }

    fun scanned(found: List<DeviceCandidate>) {
        devices = found; index = 0
        if (found.isEmpty()) { failed("no_devices"); prompt = "还没找到设备，看看它开机了吗？准备好后说重试。" }
        else { askDevice(); prompt = "找到${found.size}台设备。$prompt" }
    }

    fun connected(currentSsid: String) {
        ssid = currentSsid
        if (ssid.isBlank()) { step = Step.SSID; prompt = "蓝牙连上啦，手机连的是哪个Wi-Fi？" }
        else { askPassword(); prompt = "蓝牙连上啦，手机连着$ssid。$prompt" }
    }

    fun credentials(): CharArray = password.copyOf().also { clearPassword() }

    fun completed() { clear(); step = Step.DONE; prompt = "网络连上啦，正在接收画面。" }
    fun alreadyConfigured() { clear(); step = Step.DONE; prompt = "设备连上啦，正在接收画面。" }
    var lastFailure: String? = null
        private set
    fun failed(reason: String) { clear(); lastFailure = reason; step = Step.RETRY; prompt = "这次没连上，再试一次吗？" }
    fun clear() { clearPassword(); ssid = "" }
    private fun clearPassword() { password.fill('\u0000'); password = charArrayOf() }
    private fun askDevice() { step = Step.DEVICE; prompt = "找到${device!!.name}，连这台吗？也可以说换一台。" }
    private fun askPassword() { step = Step.PASSWORD; prompt = "Wi-Fi密码是什么？字母带上大小写，没有就说无密码。" }
}

private val passwordSymbols = mapOf(
    "下划线" to '_', "横杠" to '-', "减号" to '-', "加号" to '+', "等号" to '=', "艾特" to '@', "井号" to '#',
    "感叹号" to '!', "美元符号" to '$', "百分号" to '%', "星号" to '*', "点" to '.', "空格" to ' ',
    "与号" to '&', "尖号" to '^', "左括号" to '(', "右括号" to ')', "左方括号" to '[', "右方括号" to ']',
    "左花括号" to '{', "右花括号" to '}', "小于号" to '<', "大于号" to '>', "问号" to '?', "冒号" to ':',
    "分号" to ';', "单引号" to '\'', "双引号" to '"', "反引号" to '`', "波浪号" to '~', "竖线" to '|',
    "反斜杠" to '\\', "斜杠" to '/',
)

fun parseSpokenPassword(text: String): CharArray? {
    if (text.trim().trimEnd('。', '！', '.', '!') in listOf("无密码", "没有密码", "不用密码", "不需要密码", "没密码", "这个没有密码", "这是开放网络")) return charArrayOf()
    // Exact ASCII input keeps case and spaces; spoken tokens require explicit case.
    if (text.all { it.code in 32..126 } && text.none { it == ' ' }) {
        return text.takeIf(::validWifiPassword)?.toCharArray()
    }
    val digits = mapOf("零" to '0', "一" to '1', "二" to '2', "三" to '3', "四" to '4', "五" to '5', "六" to '6', "七" to '7', "八" to '8', "九" to '9')
    val symbols = passwordSymbols + digits
    val tokens = Regex("大写\\s*[a-zA-Z]|小写\\s*[a-zA-Z]|" + symbols.keys.sortedByDescending { it.length }.joinToString("|", transform = Regex::escape) + "|[0-9]")
    val compact = text.replace(Regex("[，,。；;、]"), " ").trim()
    val matches = tokens.findAll(compact).toList()
    if (tokens.replace(compact, "").isNotBlank()) return null
    val result = matches.map { match ->
        val token = match.value
        when {
            token.startsWith("大写") -> token.last().uppercaseChar()
            token.startsWith("小写") -> token.last().lowercaseChar()
            token.length == 1 && token[0].isDigit() -> token[0]
            else -> symbols.getValue(token)
        }
    }.joinToString("")
    return result.takeIf(::validWifiPassword)?.toCharArray()
}

fun validWifiPassword(value: CharSequence): Boolean = value.length in 8..63 && value.all { it.code in 32..126 } ||
    value.length == 64 && value.all { it in "0123456789abcdefABCDEF" }

fun spellPassword(value: CharArray): String = if (value.isEmpty()) "无密码" else value.joinToString("，") {
    when {
        it in 'A'..'Z' -> "大写 $it"
        it in 'a'..'z' -> "小写 $it"
        it == ' ' -> "空格"
        else -> passwordSymbols.entries.firstOrNull { symbol -> symbol.value == it }?.key ?: it.toString()
    }
}
