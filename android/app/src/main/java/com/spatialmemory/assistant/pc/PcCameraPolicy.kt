package com.spatialmemory.assistant.pc

/** Camera startup mirrors the PC's distinction between history and current observation. */
object PcCameraPolicy {
    fun requiresCamera(text: String, pendingFindChoice: Boolean = false): Boolean? {
        val s = text.trim().trimEnd('。', '！', '!', '？', '?')
        if (pendingFindChoice && !Regex("^(?:不是|不对|并非|取消|不用|不要|别)").containsMatchIn(s) &&
            Regex("^(?:好|好的|对|对的|是|是的|没错|确认|就是|第?[一二三四五六七八九十0-9]+(?:件|个|台|只)?$)|(?:黑|白|银|蓝|红|灰|金)色").containsMatchIn(s)) return true
        if (Regex("(?:是不是|是否是|是).*(?:之前|上次|以前).*(?:那|记住|记录|保存)|(?:跟|和).*(?:之前|上次|以前).*(?:一样|一致|同一)").containsMatchIn(s)) return true
        if (Regex("上次|之前|以前|记忆|记得|记住的|记录的|保存的").containsMatchIn(s) &&
            Regex("外观|样子|什么样").containsMatchIn(s) && Regex("位置|哪里|哪儿|放哪").containsMatchIn(s) &&
            !Regex("现在|当前|眼前|画面|镜头").containsMatchIn(s) &&
            !Regex("^(?:请|帮我|再|重新)*(?:记住|记录|保存|记一下)").containsMatchIn(s)) return false
        val history = Regex("上次|以前|历史|还记得|你记得|之前.*(?:记住|记录|保存)").containsMatchIn(s)
        if (!history && Regex("这个|这只|这副|这部|这件|眼前|当前|画面|镜头|刚才.*(?:描述|说|看到)").containsMatchIn(s) &&
            Regex("哪里|哪儿|在哪|位置|旁边|左边|右边|前面|后面|哪边|哪一边").containsMatchIn(s)) return true
        if (Regex("记住|记录|保存|记一下|记下来").containsMatchIn(s) &&
            !Regex("吗|没有|哪里|哪儿|在哪").containsMatchIn(s)) return true
        if (Regex("有没有|是否还在|还在不在").containsMatchIn(s)) return true
        if (Regex("现在").containsMatchIn(s) && Regex("哪里|哪儿|在哪|找|看").containsMatchIn(s)) return true
        if (Regex("帮我找(?:到|一下)?|寻找").containsMatchIn(s)) return true
        if (Regex("上次|之前|以前|历史|外观|样子|记住.*吗|记得.*吗").containsMatchIn(s)) return false
        if (Regex("我的").containsMatchIn(s) && Regex("哪里|哪儿|在哪").containsMatchIn(s)) return true
        if (Regex("哪里|哪儿|在哪|放哪").containsMatchIn(s)) return false
        if (Regex("看一下|再看|看看|看一看|继续找|帮我找|寻找|有什么|有哪些|有啥").containsMatchIn(s)) return true
        return null
    }
}
