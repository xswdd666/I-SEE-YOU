package com.spatialmemory.assistant.ui

import android.Manifest
import android.app.Dialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.ConnectivityManager
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import com.spatialmemory.assistant.BuildConfig
import com.spatialmemory.assistant.R
import com.spatialmemory.assistant.api.AssistantController
import com.spatialmemory.assistant.backup.MemoryBackupCoordinator
import com.spatialmemory.assistant.conversation.ConversationStore
import com.spatialmemory.assistant.debug.MemoryBackupDiagnostics
import com.spatialmemory.assistant.camera.*
import com.spatialmemory.assistant.debug.YoloPreviewView
import com.spatialmemory.assistant.debug.JevDirectDiagnostics
import com.spatialmemory.assistant.hardware.*
import com.spatialmemory.assistant.inference.*
import com.spatialmemory.assistant.memory.*
import com.spatialmemory.assistant.orchestrator.*
import com.spatialmemory.assistant.realtime.*
import com.spatialmemory.assistant.speech.*
import java.io.File
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject

/** DevKit frontend backed by the real device and assistant sessions. */
class PixelHomeActivity : com.iseeyou.demo.DevKitScreen() {
    private lateinit var controller: AssistantController
    private lateinit var qwen: AoqQwenRealtimeClient
    private lateinit var speech: SpeechCoordinator
    private lateinit var detector: FrameDetector
    private var pc: com.spatialmemory.assistant.pc.PcAssistantSession? = null
    private var pcConnectionJob: Job? = null
    private lateinit var records: NativeRecords
    private lateinit var backup: MemoryBackupCoordinator
    private lateinit var provisioner: Esp32Provisioner
    private var lastState = AssistantState()
    private var sourceKind = "phone"
    private var esp32: Esp32Connection? = null
    private var busy = false
    private var foreground = true
    private var sessionSerial = 0L
    private var pendingPermission: CompletableDeferred<Boolean>? = null
    private var recordDialog: Dialog? = null
    private var conversationBody: LinearLayout? = null
    private var conversationScroll: ScrollView? = null
    private enum class RecordsTab { CURRENT, HISTORY, MEMORIES }
    private val recordTabs = mutableMapOf<RecordsTab, Button>()
    private object RecordColors {
        val paper = Color.rgb(237, 243, 249)
        val ink = Color.rgb(23, 51, 79)
        val blue = Color.rgb(39, 88, 121)
        val pale = Color.rgb(248, 251, 255)
        val line = Color.rgb(212, 224, 236)
        val muted = Color.rgb(92, 112, 133)
    }
    private var recordsTab = RecordsTab.CURRENT
    private val showingMemories get() = recordsTab == RecordsTab.MEMORIES
    private var selectedHistory: String? = null
    private var chatLimit = 200
    private var resettingConversation = false
    private var lastSpeech: String? = null
    private var jevDiagnosticJob: Job? = null
    private val conversations by lazy { ConversationStore(this) }
    private val actionMutex = kotlinx.coroutines.sync.Mutex()
    private val prefs by lazy { getSharedPreferences("iseeyou-native", MODE_PRIVATE) }
    private val permission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        pendingPermission?.complete(result.values.all { it }); pendingPermission = null
    }

    private val selector by lazy { FrameSourceSelector(lifecycleScope) }
    private lateinit var previewSurface: CameraPreviewSurface
    private var displayedFrame: FramePacket? = null
    private var previewWanted = false
    private var viewGeneration = 0L
    private var rendered: Pair<String,Boolean>? = null
    private var provisioning = VoiceProvisionFlow()
    private var guideJob: Job? = null
    private var inGuide = true
    private var selectCamera = false

    private fun sendWeb(event: String, vararg values: String) {
        if (!foreground || isDestroyed) return
        val args = JSONArray(listOf(event) + values)
        web.evaluateJavascript("window.deviceEvent && window.deviceEvent.apply(null,$args)",null)
    }

    private suspend fun startPreview() {
        check(requirePermissions(enableVoice=false)) { "请允许使用手机摄像头。" }
        check(foreground) { "请返回应用后再取景。" }
        val source = if(sourceKind=="esp32") Esp32CameraSource(Esp32Api(checkNotNull(esp32))) else PhoneCameraSource(this,this,previewSurface.phone)
        viewGeneration++;previewWanted=true;displayedFrame=null
        previewSurface.start(sourceKind != "esp32")
        try {
            check(withTimeoutOrNull(12000) { selector.switchTo(source); true } == true) { "摄像头连接超时。" }
            check(withTimeoutOrNull(5000) { selector.latestFrame.filterNotNull().first() } != null) { "未收到视频首帧，请重试或切换摄像头。" }
        } catch(e: Throwable) {
            previewWanted=false;selector.stop();sendWeb("clear","没有收到摄像头画面，请重试或切换来源。");throw e
        }
    }

    private suspend fun verified(connection: Esp32Connection, mac: String) {
        check(withTimeout(8000) { Esp32Api(connection).refresh() }.connected) { "设备已配网，但视频服务暂不可达，请检查局域网。" }
        esp32=connection;prefs.edit().putString("selected_ble",mac).apply()
        selectCamera=true;sendWeb("guide","SOURCE","设备连上啦，用设备摄像头，还是手机相机？")
    }

    private fun guidePrompt() = sendWeb("guide",provisioning.step.name,provisioning.prompt)
    private fun guideWork(block:suspend ()->Unit) {
        if(guideJob?.isActive==true)return
        guideJob=lifecycleScope.launch {
            try { block() }
            catch(e: TimeoutCancellationException){provisioning.failed("设备未及时响应。");guidePrompt()}
            catch(e: CancellationException){ throw e }
            catch(e: Exception){ provisioning.failed(e.message ?: "设备连接未完成。");guidePrompt() }
        }
    }

    private suspend fun enterHome(kind:String) {
        provisioning.clear();inGuide=false;sourceKind=kind;selectCamera=false
        sendWeb("home",if(kind=="esp32") "设备摄像头" else "手机摄像头")
        try { startPreview() } catch(e:CancellationException){throw e} catch(e:Exception){notify(e.message ?: "取景失败")}
    }

    private fun guideAnswer(words:String, literal:Boolean) {
        if(!inGuide)return
        val command = if(selectCamera) GuideCommand.from(words) else provisioning.command(words,literal)
        if(command == GuideCommand.PHONE || command == GuideCommand.CANCEL){
            val pending=guideJob;pending?.cancel()
            guideJob=lifecycleScope.launch { pending?.join();provisioner.cancel();enterHome("phone") };return
        }
        guideWork {
            if(selectCamera){
                if(command == GuideCommand.DEVICE || command == GuideCommand.YES) enterHome("esp32")
                else sendWeb("guide","SOURCE","用哪个拍呢？可以说用设备，或用手机。")
                return@guideWork
            }
            when(provisioning.answer(words,literal)){
                VoiceProvisionFlow.Action.SCAN -> {
                    guidePrompt()
                    check(requirePermissions(hardware=true)) { "没有附近设备权限。可重试或选择手机相机。" }
                    provisioning.scanned(withTimeout(9000){provisioner.scan()});guidePrompt()
                }
                VoiceProvisionFlow.Action.CONNECT -> {
                    guidePrompt()
                    val mac=checkNotNull(provisioning.device).id
                    val connection=withTimeout(20000){provisioner.readConnection(mac)}
                    if(connection!=null)verified(connection,mac)
                    else { provisioning.connected(currentSsid());guidePrompt() }
                }
                VoiceProvisionFlow.Action.SEND -> {
                    val mac=checkNotNull(provisioning.device).id
                    val password=provisioning.credentials();guidePrompt()
                    val result=try {withTimeout(70000){provisioner.provision(mac,provisioning.ssid,password)}}finally{password.fill(0.toChar())}
                    when(result){
                        is ProvisionResult.Success -> {provisioning.completed();verified(result.cameraConnection(),mac)}
                        is ProvisionResult.Failure -> {provisioning.failed(result.reason);guidePrompt()}
                    }
                }
                VoiceProvisionFlow.Action.EXIT -> enterHome("phone")
                else -> guidePrompt()
            }
        }
    }

    private fun beginGuide(){
        guideWork {
            inGuide=true;selectCamera=false;provisioning.clear();provisioning=VoiceProvisionFlow()
            if(previewWanted || controller.state.value.running)stopSession()
            val mac=prefs.getString("selected_ble",null)
            if(mac==null){guidePrompt();return@guideWork}
            sendWeb("guide","SCANNING","正在检查上次连接的摄像头。")
            if(requirePermissions(true) && withTimeout(9000){provisioner.scan()}.any{it.id==mac}){
                val conn=withTimeout(20000){provisioner.readConnection(mac)}
                if(conn!=null){verified(conn,mac);return@guideWork}
            }
            guidePrompt()
        }
    }

    override fun applicationBridge(): Any = object {
        @android.webkit.JavascriptInterface fun call(command:String,value:String,literal:Boolean) {
            runOnUiThread {
                if(!foreground || isDestroyed)return@runOnUiThread
                when(command){
                    "previewLayout" -> if (::previewSurface.isInitialized) previewSurface.layout(value.take(512))
                    "guide" -> beginGuide()
                    "answer" -> guideAnswer(value.take(180),literal)
                    "voice" -> if(!inGuide) action { if(controller.state.value.running && controller.state.value.voiceRequested) stopSession() else startSession() }
                    "preview" -> if(!inGuide) action { startPreview() }
                    "stop" -> action { stopSession() }
                    "manage" -> showRecords()
                    "audio" -> { val enabled=value=="on";prefs.edit().putBoolean("readLocal",enabled).apply();speech.setEnabled(enabled);qwen.setPlaybackEnabled(enabled) }
                    "records" -> lifecycleScope.launch {
                        try {
                            val rows=JSONArray()
                            if(value=="long"){val items=records.all(); for(i in 0 until items.length()){val item=items.getJSONObject(i);rows.put(JSONArray(listOf(item.optString("name"),listOf(item.optString("appearance"),item.optString("location")).filter{it.isNotBlank()}.joinToString("，"))))}}
                            else conversations.messages().asReversed().forEach{rows.put(JSONArray(listOf(if(it.role=="user") "我" else "I SEE YOU",it.text)))}
                            sendWeb("records",value,rows.toString())
                        }catch(e:Exception){sendWeb("notice","暂时无法读取记录，请检查电脑服务连接。")}
                    }
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        previewSurface = CameraPreviewSurface(web)
        restoreChat()
        detector = if (BuildConfig.PC_GATEWAY_MODE) object : FrameDetector { override fun detect(jpeg: ByteArray, rotationDegrees: Int, threshold: Float) = emptyList<Detection>() } else YoloDetector(this)
        val database = AppDatabase.get(this)
        val repository = MemoryRepository(this, database.memoryDao(), database.objectMemoryDao())
        // Record authority is selected after constructing the PC connection.
        val credential = NativeGatewayCredentialClient(BuildConfig.GATEWAY_URL)
        qwen = AoqQwenRealtimeClient(this, credential::get)
        speech = SpeechCoordinator(this) { enabled ->
            qwen.setLocalSpeechActive(!enabled)
            qwen.setMicrophoneEnabled(enabled && foreground && controller.state.value.running && controller.state.value.voiceRequested)
        }
        speech.onVoiceUnavailable = { message -> notify(message) }
        qwen.setPlaybackEnabled(!prefs.getBoolean("reader", false))
        speech.setEnabled(!prefs.getBoolean("reader", false) && prefs.getBoolean("readLocal", true))
        backup = MemoryBackupCoordinator(this, database, lifecycleScope, { message ->
            appendChat("assistant", message)
            if(foreground) speech.announce(SpeechEvent("backup-${System.nanoTime()}", message, SpeechPriority.P1))
            if(showingMemories) refreshRecords()
        }, { stopSession() }, automatic = { !BuildConfig.PC_GATEWAY_MODE })
        pc = if (BuildConfig.PC_GATEWAY_MODE) com.spatialmemory.assistant.pc.PcAssistantSession(this,database,qwen,speech,lifecycleScope,backup::handle,conversationId=conversations::initialize) { if(showingMemories) refreshRecords() } else null
        records = NativeRecords(this, database, repository, pc)
        controller = AssistantController(AssistantOrchestrator(detector, TargetMatcher(this), PerceptionEngine(TargetMatcher(this), HistogramObjectEmbedder()), repository, qwen, VisionReviewRouter(this), speech, File(cacheDir, "active-search-candidate"), memoryCommand = backup::handle), pc)
        provisioner = Esp32Provisioner(this)
        prefs.edit().remove("esp32").apply() // Reacquire the stream token over BLE each session.
        lifecycleScope.launch { controller.state.collect { state ->
            val memoryChanged = state.rememberedObjectId != lastState.rememberedObjectId ||
                (state.rememberedObjectId!=null && state.searchState==SearchState.IDLE &&
                    (lastState.searchState!=SearchState.IDLE || state.lastSpeech!=lastState.lastSpeech))
            lastState = state
            renderState(state)
            state.lastSpeech?.takeIf { it.isNotBlank() && it != lastSpeech }?.let { lastSpeech = it; appendChat("assistant", it) }
            if (memoryChanged && showingMemories) refreshRecords()
        } }
        lifecycleScope.launch { qwen.state.collect { renderState(lastState) } }
        lifecycleScope.launch { qwen.events.collect { event ->
            if (event is QwenEvent.Transcript && controller.state.value.running && controller.state.value.voiceRequested) {
                if (event.role == "user" && !MemoryBackupCoordinator.sensitive(event.text) && !com.spatialmemory.assistant.pc.PcAssistantSession.sensitive(event.text)) appendChat(event.role, event.text)
                if (event.role == "user" && Regex("^(关闭摄像头|结束对话|停止观察)[。！!？?]*$").matches(event.text.trim())) {
                    action { stopSession() }
                }
            }
        } }
        lifecycleScope.launch {
            selector.latestFrame.filterNotNull().collect { frame ->
                if (!foreground || !previewWanted || System.currentTimeMillis()-frame.capturedAtMs !in 0..2800) return@collect
                val generation = viewGeneration
                if (displayedFrame == null) previewSurface.start(frame.source == CameraSource.PHONE)
                if (frame.source == CameraSource.ESP32) {
                    val bitmap = withContext(Dispatchers.Default) {
                        val decoded = BitmapFactory.decodeByteArray(frame.jpeg, 0, frame.jpeg.size) ?: return@withContext null
                        if (frame.rotationDegrees == 0) decoded else {
                            val rotated = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height,
                                Matrix().apply { postRotate(frame.rotationDegrees.toFloat()) }, true)
                            if (rotated !== decoded) decoded.recycle()
                            rotated
                        }
                    } ?: return@collect
                    if (!foreground || !previewWanted || generation != viewGeneration) { bitmap.recycle(); return@collect }
                    previewSurface.display(bitmap)
                }
                if (displayedFrame == null) sendWeb("nativePreview")
                displayedFrame = frame
            }
        }
        lifecycleScope.launch {
            while (isActive) {
                val frame = selector.latestFrame.value
                if (displayedFrame != null && (frame == null || System.currentTimeMillis()-frame.capturedAtMs > 2800)) {
                    displayedFrame = null
                    previewSurface.clear()
                    sendWeb("clear", "画面已中断，请重试或切换摄像头。")
                }
                delay(300)
            }
        }
        jevDiagnosticJob = JevDirectDiagnostics.handle(this, intent) { stopSession() }
        MemoryBackupDiagnostics.handle(this, intent) { stopSession() }?.let { jevDiagnosticJob = it }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        JevDirectDiagnostics.handle(this, intent) { stopSession() }?.let { job -> jevDiagnosticJob?.cancel();jevDiagnosticJob = job }
        MemoryBackupDiagnostics.handle(this, intent) { stopSession() }?.let { job -> jevDiagnosticJob?.cancel();jevDiagnosticJob = job }
    }

    private suspend fun requirePermissions(hardware: Boolean = false, enableVoice: Boolean = true): Boolean {
        val needed = buildList {
            if (hardware) {
                if (Build.VERSION.SDK_INT >= 31) { add(Manifest.permission.BLUETOOTH_SCAN); add(Manifest.permission.BLUETOOTH_CONNECT) }
                else add(Manifest.permission.ACCESS_FINE_LOCATION)
            } else { if (sourceKind == "phone") add(Manifest.permission.CAMERA); if (enableVoice) add(Manifest.permission.RECORD_AUDIO) }
        }.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isEmpty()) return true
        if (pendingPermission != null) return false
        val result = CompletableDeferred<Boolean>(); pendingPermission = result
        permission.launch(needed.toTypedArray()); return result.await()
    }

    private suspend fun startSession(enableVoice: Boolean = true) {
        check(requirePermissions(enableVoice = enableVoice)) { if (enableVoice) "请允许相机和麦克风后再开始。" else "请允许相机后再开始。" }
        check(foreground) { "请返回应用后再开始。" }
        sessionSerial++
        sendWeb("notice","正在启动语音找物…")
        if (!previewWanted || selector.latestFrame.value == null) startPreview()
        val shared = object : FrameSource {
            override val source = if (sourceKind == "esp32") CameraSource.ESP32 else CameraSource.PHONE
            override val frames = selector.latestFrame.filterNotNull()
            override val state = selector.state
            override suspend fun start() {}
            override suspend fun stop() {}
        }
        controller.start(shared, enableVoice)
    }

    private suspend fun stopSession() {
        sessionSerial++; viewGeneration++; previewWanted = false
        previewSurface.clear()
        try { controller.stop() } finally { selector.stop(); displayedFrame=null; sendWeb("clear","取景已停止") }
    }

    private fun renderState(state: AssistantState) {
        val headline = when {
            state.objectChoices.isNotEmpty() -> "请用语音回答，或补充物品的外观特征"
            !state.running -> if (state.error != null) "启动没有完成" else "点击语音找物开始"
            state.searchState == SearchState.LEARNING -> state.message.takeIf { it.startsWith("正在记住") } ?: "正在记住物品的样子和位置"
            state.message == "正在看眼前的画面" -> "正在观察眼前的画面"
            qwen.state.value == RealtimeState.CONNECTING && state.target.isNullOrBlank() -> "正在连接语音，请稍候"
            state.target.isNullOrBlank() -> state.notice ?: "说出你想找或记住的物品"
            state.searchState == SearchState.VERIFYING -> "发现疑似物品，正在确认"
            state.searchState == SearchState.SEARCHING -> "正在寻找：${state.target}"
            else -> state.message.takeUnless { it.startsWith("YOLO") || it.startsWith("已收到第") } ?: "说出你想找或记住的物品"
        }
        val detail = when {
            !state.running -> state.error ?: if(BuildConfig.PC_GATEWAY_MODE)state.message.takeIf { it.contains("电脑") } ?: "电脑处理模式 · 记录中可输入指令" else "记录中可输入指令，也可直接查询位置历史"
            state.qwenVerifying -> "正在复核图片 · 请保持画面稳定"
            state.searchState == SearchState.SEARCHING && Regex("未完成|变化|不能确定|未找到|缺失|重新扫描").containsMatchIn(state.message) -> state.message
            !state.voiceRequested -> "文字找物模式 · 麦克风未开启"
            state.error?.startsWith("千问") == true -> "语音未连接 · 可在记录中输入指令，图片复核仍可使用"
            state.error != null -> state.error
            state.searchState == SearchState.LEARNING -> "正在自动取景，请稍候"
            qwen.state.value == RealtimeState.FAILED || qwen.state.value == RealtimeState.DISCONNECTED -> "语音未连接 · 可在记录中输入指令，图片复核仍可使用"
            qwen.state.value != RealtimeState.CONNECTED -> "画面已开启 · 语音正在连接"
            else -> "语音已就绪 · 识别框显示当前检测结果"
        }
        val words = if (state.running) state.lastSpeech?.takeIf { it.isNotBlank() } ?: headline else detail
        val key = Pair(words, state.running && state.voiceRequested)
        if (key != rendered) { rendered = key; sendWeb("state",words,key.second.toString()) }
    }

    private fun action(block: suspend () -> Unit) {
        if (busy) return
        lifecycleScope.launch {
            actionMutex.lock()
            busy = true
            try { block() }
            catch (error: CancellationException) { throw error }
            catch (error: Throwable) { notify(error.message ?: "操作没有完成，请重试。") }
            finally { busy = false; actionMutex.unlock() }
        }
    }

    private fun showRecords() {
        val (dialog, body) = sheet("记录", scroll = false)
        recordDialog = dialog
        val tabs = LinearLayout(this)
        val conversation = button("当前对话") { recordsTab = RecordsTab.CURRENT;chatLimit=200;refreshRecords() }
        val history = button("历史") { recordsTab = RecordsTab.HISTORY;selectedHistory=null;chatLimit=200;refreshRecords() }
        val memories = button("物品记忆") { recordsTab = RecordsTab.MEMORIES; refreshRecords() }
        tabs.addView(conversation, LinearLayout.LayoutParams(0, dp(48), 1f))
        tabs.addView(history, LinearLayout.LayoutParams(0, dp(48), 1f).apply { marginStart = dp(8) })
        tabs.addView(memories, LinearLayout.LayoutParams(0, dp(48), 1f).apply { marginStart = dp(8) })
        recordTabs.clear()
        recordTabs.putAll(mapOf(RecordsTab.CURRENT to conversation, RecordsTab.HISTORY to history, RecordsTab.MEMORIES to memories))
        body.addView(tabs)
        body.addView(button("新会话") { action { newConversation() } }.apply {
            id=R.id.native_new_conversation
        }, spaced())
        conversationBody = column()
        conversationScroll = ScrollView(this).apply { id=R.id.native_records_scroller;isFillViewport = true;addView(conversationBody) }
        body.addView(conversationScroll, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin=dp(10) })
        // A text fallback remains in Records, keeping the camera and settings uncluttered.
        val typed = input("输入你想说的话").apply {
            id=R.id.native_records_input
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            imeOptions = imeOptions or android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        }
        body.addView(typed, spaced())
        body.addView(button("发送", true) {
            val text = typed.text.toString().trim()
            if (text.isBlank()) return@button
            action {
                if(text in setOf("新会话","开始新会话")) { newConversation();typed.text.clear();return@action }
                if (pc?.maintenance(text) == true || (pc == null && backup.handle(text))) { typed.text.clear();return@action }
                if (!controller.state.value.running && controller.requiresCamera(text)) startSession(enableVoice = false)
                recordsTab=RecordsTab.CURRENT
                appendChat("user", text); controller.submitText(text); typed.text.clear()
            }
        }.apply { id=R.id.native_records_send }, spaced())
        body.addView(button("回到首页") { dialog.dismiss() }, spaced())
        dialog.setOnDismissListener { recordDialog = null; conversationBody = null;conversationScroll=null;recordTabs.clear() }
        refreshRecords(); dialog.showSized(expand = true)
    }

    private fun refreshRecords() {
        val body = conversationBody ?: return
        recordTabs.forEach { (tab, button) ->
            button.isSelected = tab == recordsTab
            button.setTextColor(if (button.isSelected) Color.WHITE else RecordColors.ink)
        }
        body.removeAllViews()
        if(recordsTab == RecordsTab.HISTORY && selectedHistory == null) {
            body.addView(label("最近 30 天的会话，打开应用时自动清理过期记录。",14f))
            val current=conversations.initialize()
            val sessions=conversations.sessions().filter { it.id!=current }
            if(sessions.isEmpty())body.addView(label("还没有历史对话。",15f),spaced())
            for(session in sessions) {
                val title=if(session.legacy)"以前的对话（日期未记录）" else java.time.Instant.ofEpochMilli(session.createdAtMs)
                    .atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm"))
                body.addView(menuButton(title,"${session.messageCount} 条 · ${session.preview.take(28)}") {
                    selectedHistory=session.id;chatLimit=200;refreshRecords()
                },spaced())
            }
            return
        }
        if (!showingMemories) {
            val session=if(recordsTab == RecordsTab.HISTORY)selectedHistory else conversations.initialize()
            val chat=session?.let { conversations.messages(it,chatLimit) }.orEmpty()
            if(recordsTab == RecordsTab.HISTORY)body.addView(button("返回历史列表") {selectedHistory=null;refreshRecords()},spaced())
            if (chat.isEmpty()) body.addView(label(if(recordsTab == RecordsTab.HISTORY)"这段历史已过期或暂无消息。" else "这是一个新会话，可以开始提问。", 15f))
            if(chat.size >= chatLimit)body.addView(button("查看更早的消息") {chatLimit+=200;refreshRecords()},spaced())
            for (message in chat) {
                val role=message.role
                val text=message.text
                val user = role == "user"
                val bubble = column().apply {
                    background = rounded(if (user) Color.rgb(219, 234, 245) else RecordColors.pale)
                    setPadding(dp(12), dp(10), dp(12), dp(10))
                    addView(label(if (user) "我" else "I SEE YOU", 12f, true)); addView(label(text, 16f))
                }
                body.addView(bubble, LinearLayout.LayoutParams(-1, -2).apply {
                    marginStart=if(user)dp(18) else 0; marginEnd=if(user)0 else dp(18); topMargin=dp(10)
                })
            }
            if(recordsTab==RecordsTab.CURRENT)conversationScroll?.post { conversationScroll?.fullScroll(View.FOCUS_DOWN) }
        } else lifecycleScope.launch {
            val items = try { records.all() } catch(error: Exception) {
                if(error is CancellationException) throw error
                if(conversationBody === body) body.addView(label(error.message ?: "电脑记忆暂时不可用",15f))
                return@launch
            }
            if (conversationBody !== body || !showingMemories) return@launch
            if (items.length() == 0) body.addView(label("还没有物品记忆。开始后说“记住水杯”，自动保存当时画面。", 15f))
            repeat(items.length()) { index ->
                val item = items.getJSONObject(index)
                body.addView(column().apply {
                    background = rounded(RecordColors.pale); setPadding(dp(12), dp(10), dp(12), dp(10))
                    addView(label(item.getString("name"), 18f, true))
                    addView(label((if(item.optInt("sample_count")>0) "已保存目标参考照片" else if(item.optBoolean("appearance_observed"))"已保存外观描述和参考画面" else "尚无外观记录")+" · 上次位置记录：${item.optString("location")}", 14f))
                    item.optString("capture_status_label").takeIf(String::isNotBlank)?.let { addView(label(it,14f)) }
                    if(item.optString("suggested_location").isNotBlank()) addView(label("画面分析的待确认线索：${item.optString("suggested_location")}",13f))
                    item.optString("appearance").takeIf(String::isNotBlank)?.let { addView(label(it, 14f)) }
                    val rememberedAt = java.time.Instant.parse(item.getString("created_at")).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm:ss"))
                    addView(label("记住时间：$rememberedAt", 13f))
                    addView(button("找这件") {
                        recordDialog?.dismiss(); action { if (!controller.state.value.running) startSession(enableVoice = false); controller.search(item.getString("name"), item.getString("id")) }
                    }, spaced())
                    addView(button("位置历史") { showLocationHistory(item) }, spaced())
                    addView(button("更新这件的外观") {
                        recordDialog?.dismiss(); action { if (!controller.state.value.running) startSession(enableVoice = false); controller.remember(item.getString("name"), item.getString("id")) }
                    }, spaced())
                    addView(button("编辑记忆") { editMemory(item) }, spaced())
                    addView(button("删除记忆") {
                        val (confirmation, content) = sheet("删除这件物品？")
                        content.addView(label(item.getString("name"), 18f, true))
                        content.addView(button("取消") { confirmation.dismiss() }, spaced())
                        content.addView(button("删除", true) { action {
                            records.delete(item)
                            if (controller.state.value.rememberedObjectId == item.getString("id")) controller.cancelSearch()
                            confirmation.dismiss(); refreshRecords()
                        } }, spaced())
                        confirmation.showSized()
                    }, spaced())
                }, spaced())
            }
        }
    }

    private fun editMemory(item: JSONObject) {
        val (dialog, body) = sheet("编辑记忆")
        val name = input("物品名称").apply { setText(item.getString("name")) }
        val appearance = input("外观描述").apply { setText(item.optString("appearance")) }
        val location = input("你提供的位置（未经相机核实）").apply { setText(item.getString("location")) }
        body.addView(name); body.addView(appearance, spaced()); body.addView(location, spaced())
        body.addView(button("保存", true) { action {
            val update = JSONObject(item.toString()).put("name", name.text.toString()).put("appearance", appearance.text.toString()).put("location", location.text.toString())
            records.edit(update); if (controller.state.value.rememberedObjectId == item.getString("id")) controller.cancelSearch(); dialog.dismiss(); refreshRecords()
        } }, spaced())
        dialog.showSized()
    }

    private fun showLocationHistory(item: JSONObject) {
        action {
            val events = records.history(item.getString("id"))
            val (dialog, body) = sheet("${item.getString("name")}的位置历史")
            body.addView(label("这是过去的记录，不能证明物品现在仍在那里。", 15f))
            if (events.isEmpty()) body.addView(label("还没有位置记录。编辑记忆可添加你提供的位置；说“记住水杯的位置”会先进行图片复核。", 15f), spaced())
            val formatter = java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").withZone(java.time.ZoneId.systemDefault())
            events.forEach { event ->
                val observed = event.observedAtMs?.let { "\n观察时间：${formatter.format(java.time.Instant.ofEpochMilli(it))}" }.orEmpty()
                body.addView(label("${event.location}\n${locationSourceLabel(event.source)}\n记录时间：${formatter.format(java.time.Instant.ofEpochMilli(event.recordedAtMs))}$observed", 15f), spaced())
            }
            dialog.showSized()
        }
    }

    private fun appendChat(role: String, text: String) {
        if (text.isBlank() || resettingConversation) return
        if(conversations.append(role,text) && recordsTab == RecordsTab.CURRENT)refreshRecords()
    }

    private fun restoreChat() {
        conversations.initialize()
    }

    private suspend fun newConversation() {
        resettingConversation=true
        try {
            pcConnectionJob?.cancelAndJoin()
            sessionSerial++
            conversations.newSession()
            controller.resetConversation()
            lastSpeech=null
            recordsTab=RecordsTab.CURRENT
            selectedHistory=null
            chatLimit=200
        } finally {
            resettingConversation=false
            refreshRecords()
        }
    }

    private fun sheet(title: String, scroll: Boolean = true): Pair<Dialog, LinearLayout> {
        val dialog = Dialog(this)
        val panel = column().apply { background = rounded(RecordColors.paper).apply { cornerRadius = dp(28).toFloat() }; setPadding(dp(18), dp(18), dp(18), dp(18)) }
        val heading = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        heading.addView(label(title, 24f, true), LinearLayout.LayoutParams(0, -2, 1f))
        heading.addView(button("×") { dialog.dismiss() }.apply { contentDescription = "关闭$title" }, LinearLayout.LayoutParams(dp(44), dp(44)))
        panel.addView(heading)
        val body = column()
        if(scroll)panel.addView(ScrollView(this).apply { isFillViewport = false; addView(body) }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
        else panel.addView(body, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin=dp(12) })
        dialog.setContentView(panel); dialog.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        return dialog to body
    }

    private fun Dialog.showSized(expand: Boolean = false) {
        show()
        window?.setLayout(minOf(resources.displayMetrics.widthPixels - dp(24), dp(440)), if(expand)resources.displayMetrics.heightPixels-dp(100) else -2)
        window?.decorView?.post {
            val available = resources.displayMetrics.heightPixels - dp(100)
            if ((window?.decorView?.height ?: 0) > available) window?.setLayout(minOf(resources.displayMetrics.widthPixels - dp(24), dp(440)), available)
        }
    }

    private fun menuButton(title: String, subtitle: String, onClick: () -> Unit) = button("", onClick = onClick).apply {
        text = android.text.SpannableString("$title  ›\n$subtitle").apply {
            val start = indexOf('\n') + 1
            setSpan(android.text.style.RelativeSizeSpan(.78f), start, length, 0)
            setSpan(android.text.style.ForegroundColorSpan(RecordColors.muted), start, length, 0)
            setSpan(android.text.style.StyleSpan(Typeface.NORMAL), start, length, 0)
        }
        gravity = Gravity.START or Gravity.CENTER_VERTICAL; textSize = 17f; minHeight = dp(82)
    }
    private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    private fun label(value: String, size: Float, bold: Boolean = false) = TextView(this).apply {
        text = value; textSize = size; setLineSpacing(dp(3).toFloat(), 1.1f); setTextColor(RecordColors.ink); if (bold) setTypeface(typeface, Typeface.BOLD)
    }
    private fun button(value: String, primary: Boolean = false, onClick: () -> Unit) = Button(this).apply {
        text = value; textSize = 16f; isAllCaps = false; minHeight = dp(48); minimumHeight = dp(48)
        setTextColor(if (primary) Color.WHITE else RecordColors.ink); setTypeface(typeface, Typeface.BOLD)
        background = android.graphics.drawable.RippleDrawable(
            android.content.res.ColorStateList.valueOf(Color.argb(35, 80, 130, 165)),
            android.graphics.drawable.StateListDrawable().apply {
                addState(intArrayOf(android.R.attr.state_selected), primarySurface())
                addState(intArrayOf(), if (primary) primarySurface() else rounded(RecordColors.pale))
            }, null)
        stateListAnimator = null
        elevation = dp(2).toFloat()
        setPadding(dp(12), dp(8), dp(12), dp(8)); setOnClickListener { onClick() }
    }
    private fun input(hintText: String) = EditText(this).apply {
        hint = hintText; contentDescription = hintText; textSize = 16f; setTextColor(RecordColors.ink); setHintTextColor(RecordColors.muted)
        background = rounded(Color.rgb(248, 251, 255)); setPadding(dp(12), dp(8), dp(12), dp(8)); minHeight = dp(48); setSingleLine()
        filters = arrayOf(android.text.InputFilter.LengthFilter(600))
    }
    private fun rounded(fill: Int) = GradientDrawable().apply { setColor(fill); cornerRadius = dp(18).toFloat(); setStroke(dp(1), RecordColors.line) }
    private fun primarySurface() = GradientDrawable(GradientDrawable.Orientation.TL_BR,
        intArrayOf(RecordColors.blue, Color.rgb(23, 57, 80))).apply {
        cornerRadius = dp(18).toFloat()
        setStroke(dp(1), Color.rgb(93, 133, 158))
    }
    private fun spaced() = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10) }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun notify(message: String) { sendWeb("notice",message); Toast.makeText(this, message, Toast.LENGTH_LONG).show() }

    @Suppress("DEPRECATION", "MissingPermission")
    private fun currentSsid(): String = runCatching {
        val ssid = if (Build.VERSION.SDK_INT >= 29) {
            val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            (manager.getNetworkCapabilities(manager.activeNetwork)?.transportInfo as? WifiInfo)?.ssid
        } else (getSystemService(Context.WIFI_SERVICE) as WifiManager).connectionInfo.ssid
        ssid.orEmpty().removeSurrounding("\"").takeUnless { it == WifiManager.UNKNOWN_SSID }.orEmpty()
    }.getOrDefault("")

    override fun onStart() {
        if(::controller.isInitialized)conversations.initialize()
        super.onStart(); foreground = true;if(::backup.isInitialized) backup.schedule()
        pcConnectionJob?.cancel()
        pcConnectionJob=lifecycleScope.launch {
            try { if(pc?.consumePreparedConnection()!=true)pc?.connectIfConfigured() }
            catch(error: CancellationException) { throw error }
            catch(error: Exception) { notify(error.message ?: "电脑连接暂未完成") }
            finally { if(foreground)pc?.setConnectionForeground(true) }
        }
    }
    override fun onStop() {
        pcConnectionJob?.cancel();pcConnectionJob=null;pc?.setConnectionForeground(false)
        jevDiagnosticJob?.cancel()
        foreground = false; previewSurface.clear(); sessionSerial++; guideJob?.cancel(); provisioning.clear(); previewWanted=false; displayedFrame=null
        pendingPermission?.complete(false); pendingPermission = null
        lifecycleScope.launch { actionMutex.lock(); try { controller.stop(); selector.stop(); provisioner.cancel() } finally { actionMutex.unlock() } }
        super.onStop()
    }
    override fun onDestroy() {
        foreground = false; sessionSerial++
        if(::backup.isInitialized) backup.close()
        speech.close()
        // Finish native cleanup even though the activity lifecycle is being cancelled.
        CoroutineScope(Dispatchers.Main.immediate + SupervisorJob()).launch {
            actionMutex.lock()
            try { controller.stop(); provisioner.cancel(); (detector as? java.io.Closeable)?.close(); selector.stop() }
            finally { actionMutex.unlock(); cancel() }
        }
        super.onDestroy()
    }
}

