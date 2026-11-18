package com.iseeyou.demo;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Locale;

/** Development shell: local UI + Android camera permission + native ASR/TTS. */
public abstract class DevKitScreen extends androidx.activity.ComponentActivity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String PAGE = "https://" + HOST + "/assets/www/index.html";
    private static final int CAMERA_REQUEST = 101, MIC_REQUEST = 102;
    protected WebView web;
    protected abstract Object applicationBridge();
    private PermissionRequest pendingCamera;
    private SpeechRecognizer recognizer;
    private OfflineSpeech offline;
    private boolean offlineActive, preferOffline, inputReady;
    private Runnable speechDeadline;
    private String guideStep;
    private int recognitionId, pendingRecognitionId;
    private String pendingRecognitionLanguage = "zh-CN";
    private TextToSpeech tts;
    private boolean ttsReady, ttsInitFinished, destroyed;
    private boolean foreground, micPermissionPending;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private int pendingSpeechId;
    private String pendingSpeechText, pendingSpeechLanguage;
    private float pendingSpeechRate;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        offline = new OfflineSpeech(this);
        final int surface = Color.rgb(237,243,249);
        getWindow().setStatusBarColor(surface);
        getWindow().setNavigationBarColor(surface);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(surface);
        web = new WebView(this);
        web.setBackgroundColor(surface);
        web.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        web.setHorizontalScrollBarEnabled(false);
        root.addView(web, new FrameLayout.LayoutParams(-1,-1));
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view,insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                view.setPadding(bars.left,bars.top,bars.right,bars.bottom);
                return insets;
            });
            root.requestApplyInsets();
        }
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // The guide can finish entirely by voice; the muted local camera preview must then play.
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(Math.round(getResources().getConfiguration().fontScale * 100));
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        WebView.setWebContentsDebuggingEnabled(false);
        web.addJavascriptInterface(applicationBridge(), "DeviceApp");
        web.addJavascriptInterface(new NativeBridge(), "ISeeYouNative");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !trusted(request.getUrl());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // A single allowlisted local document. No file:// permissions or remote pages.
                if (trusted(request.getUrl()) && "/assets/www/index.html".equals(request.getUrl().getPath())) {
                    try {
                        HashMap<String,String> headers = new HashMap<>();
                        headers.put("Cache-Control","no-store");
                        headers.put("Content-Security-Policy", "default-src 'none'; img-src data: blob:; media-src 'self' blob: mediastream:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; base-uri 'none'");
                        return new WebResourceResponse("text/html","UTF-8",200,"OK",headers,getAssets().open("www/index.html"));
                    } catch (Exception ignored) { return blocked(404,"UI assets missing"); }
                }
                return blocked(403,"Resource not allowed");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (destroyed || !foreground || !trusted(request.getOrigin())) { request.deny(); return; }
                    for (String resource : request.getResources()) {
                        if (!PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) { request.deny(); return; }
                    }
                    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                    } else {
                        // Do not show overlapping OS permission prompts.
                        if (pendingCamera != null) { request.deny(); return; }
                        pendingCamera = request;
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_REQUEST);
                    }
                });
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                runOnUiThread(() -> { if (pendingCamera == request) pendingCamera = null; });
            }
        });
        // Always post: a fast engine must not call speak before tts is assigned.
        tts = new TextToSpeech(this, status -> mainHandler.post(() -> {
            if (destroyed) return;
            ttsInitFinished = true;
            ttsReady = status == TextToSpeech.SUCCESS;
            if (pendingSpeechId != 0) {
                int id = pendingSpeechId; String text = pendingSpeechText, language = pendingSpeechLanguage;
                float rate = pendingSpeechRate; pendingSpeechId = 0;
                speakNative(id,text,language,rate);
            }
        }));
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) { emit("tts-start",speechId(id),null,false,null,null); }
            @Override public void onDone(String id) { emit("tts-end",speechId(id),null,false,null,null); }
            @Override public void onError(String id) { emit("tts-error",speechId(id),null,false,null,"语音播报暂不可用"); }
        });
        web.loadUrl(PAGE);
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
    }

    private boolean trusted(Uri uri) {
        return "https".equals(uri.getScheme()) && HOST.equals(uri.getHost()) && (uri.getPort() == -1 || uri.getPort() == 443);
    }
    private WebResourceResponse blocked(int code,String message) {
        return new WebResourceResponse("text/plain","UTF-8",code,code == 404 ? "Not Found" : "Forbidden",new HashMap<>(),new ByteArrayInputStream(message.getBytes(StandardCharsets.UTF_8)));
    }
    private int speechId(String id) { try { return Integer.parseInt(id); } catch(Exception ignored) { return 0; } }
    private void emit(String type,int id,String text,boolean fin,String error,String message) {
        if (destroyed) return;
        try {
            JSONObject event = new JSONObject();
            event.put("type",type); event.put("id",id); event.put("final",fin);
            if (text != null) event.put("text",text);
            if (error != null) event.put("error",error);
            if (message != null) event.put("message",message);
            String script = "window.__ISeeYouNativeEvent && window.__ISeeYouNativeEvent(" + event + ");";
            runOnUiThread(() -> { if (!destroyed) web.evaluateJavascript(script,null); });
        } catch(Exception ignored) { /* Never log user transcripts. */ }
    }
    private void failRecognition(int id,String error,String message) {
        emit("recognition-error",id,null,false,error,message);
        emit("recognition-end",id,null,false,null,null);
    }
    private void clearSpeechDeadline() {
        if (speechDeadline != null) mainHandler.removeCallbacks(speechDeadline);
        speechDeadline = null;
    }
    private void deadline(long ms, Runnable action) {
        clearSpeechDeadline();
        speechDeadline = action;
        mainHandler.postDelayed(action, ms);
    }
    private void readyForInput(int id) {
        if (id != recognitionId || inputReady) return;
        inputReady = true;
        clearSpeechDeadline();
        emit("recognition-start",id,null,false,null,null);
    }
    private void startOffline(int id) {
        releaseRecognizer();
        recognitionId = id;
        offlineActive = true;
        preferOffline = true;
        emit("recognition-state",id,null,false,"offline","正在准备本机中文识别…");
        deadline(35000, () -> {
            if (recognitionId != id || !offlineActive || inputReady) return;
            releaseRecognizer();
            failRecognition(id,"offline-timeout","本机中文识别启动超时，轻触图标重试");
        });
        // Chinese phrases are not vocabulary tokens; use the bundled full Chinese model.
        offline.start(null, new OfflineSpeech.Listener() {
            public void ready() { readyForInput(id); }
            public void result(String text, boolean complete) {
                if (recognitionId != id || !offlineActive) return;
                readyForInput(id);
                if (complete) releaseRecognizer();
                emit("recognition-result",id,text,complete,null,null);
                if (complete) emit("recognition-end",id,null,false,null,null);
            }
            public void error(String code,String message) {
                if (recognitionId != id || !offlineActive) return;
                releaseRecognizer();
                failRecognition(id,code,message);
            }
        });
    }
    private void releaseRecognizer() {
        clearSpeechDeadline();
        inputReady = offlineActive = false;
        if (offline != null) offline.cancel();
        recognitionId = 0;
        SpeechRecognizer previous = recognizer; recognizer = null;
        if (previous != null) {
            try { previous.cancel(); } catch (RuntimeException ignored) { }
            try { previous.destroy(); } catch (RuntimeException ignored) { }
        }
    }
    private String firstResult(Bundle results) {
        ArrayList<String> matches = results == null ? null : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return matches == null || matches.isEmpty() ? "" : matches.get(0);
    }
    private void beginRecognition(int id,String language) {
        if (destroyed || !foreground) { failRecognition(id,"aborted",null); return; }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            if (pendingRecognitionId != 0 && pendingRecognitionId != id) failRecognition(pendingRecognitionId,"aborted",null);
            pendingRecognitionId = id; pendingRecognitionLanguage = language;
            emit("recognition-state",id,null,false,"permission","等待麦克风授权…");
            if (!micPermissionPending) {
                micPermissionPending = true;
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},MIC_REQUEST);
            }
            return;
        }
        if (guideStep != null || preferOffline) { startOffline(id); return; }
        try {
            if (!SpeechRecognizer.isRecognitionAvailable(this)) { startOffline(id); return; }
        } catch (RuntimeException unavailable) { startOffline(id); return; }
        releaseRecognizer(); recognitionId = id;
        emit("recognition-state",id,null,false,"system","正在连接系统语音服务…");
        deadline(5000, () -> { if (recognitionId == id && !inputReady && !offlineActive) startOffline(id); });
        try { recognizer = SpeechRecognizer.createSpeechRecognizer(this); }
        catch (RuntimeException unavailable) { startOffline(id); return; }
        try {
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) { if (!offlineActive) readyForInput(id); }
            @Override public void onBeginningOfSpeech() { if (!offlineActive) readyForInput(id); }
            @Override public void onRmsChanged(float value) { }
            @Override public void onBufferReceived(byte[] bytes) { if (!offlineActive && bytes != null && bytes.length > 0) readyForInput(id); }
            @Override public void onEndOfSpeech() { }
            @Override public void onEvent(int type,Bundle params) { }
            @Override public void onPartialResults(Bundle results) { if (recognitionId != id || offlineActive) return;
                String partial = firstResult(results);
                if (!partial.isEmpty()) { readyForInput(id); emit("recognition-result",id,partial,false,null,null); } }
            @Override public void onResults(Bundle results) {
                if (recognitionId != id || offlineActive) return;
                String result = firstResult(results); releaseRecognizer();
                if (result.isEmpty()) failRecognition(id,"no-speech",null);
                else { emit("recognition-result",id,result,true,null,null); emit("recognition-end",id,null,false,null,null); }
            }
            @Override public void onError(int code) {
                if (recognitionId != id || offlineActive) return;
                if (code != SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS &&
                    (!inputReady || (code != SpeechRecognizer.ERROR_NO_MATCH && code != SpeechRecognizer.ERROR_SPEECH_TIMEOUT))) {
                    startOffline(id); return;
                }
                releaseRecognizer();
                if (code == SpeechRecognizer.ERROR_NO_MATCH || code == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) failRecognition(id,"no-speech",null);
                else if (code == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) failRecognition(id,"not-allowed","麦克风未获授权，请授权后轻触图标重试");
                else if (code == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) failRecognition(id,"busy","语音服务正忙，请稍后轻触图标重试");
                else if (code == SpeechRecognizer.ERROR_AUDIO) failRecognition(id,"audio-capture","麦克风暂不可用，请检查是否被其他应用占用");
                else failRecognition(id,"network","系统语音服务暂不可用，请检查网络后重试");
            }
        });
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE,language == null ? "zh-CN" : language);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS,true);
        recognizer.startListening(intent);
        } catch (RuntimeException unavailable) { startOffline(id); }
    }
    private void speakNative(int id,String text,String language,float rate) {
        if (destroyed || !foreground) { emit("tts-error",id,null,false,null,"应用已切到后台，已停止播报"); return; }
        if (!ttsInitFinished) { pendingSpeechId=id; pendingSpeechText=text; pendingSpeechLanguage=language; pendingSpeechRate=rate; return; }
        if (!ttsReady) { emit("tts-error",id,null,false,null,"系统语音播报不可用"); return; }
        try {
        int available = tts.setLanguage(Locale.forLanguageTag(language == null ? "zh-CN" : language));
        if (available == TextToSpeech.LANG_MISSING_DATA || available == TextToSpeech.LANG_NOT_SUPPORTED) {
            emit("tts-error",id,null,false,null,"请在系统中安装中文语音包"); return;
        }
        tts.setSpeechRate(Math.max(.5f,Math.min(2f,rate)));
        if (tts.speak(text,TextToSpeech.QUEUE_FLUSH,null,String.valueOf(id)) == TextToSpeech.ERROR) emit("tts-error",id,null,false,null,"语音播报暂不可用");
        } catch (RuntimeException ignored) { emit("tts-error",id,null,false,null,"语音播报暂不可用"); }
    }
    public final class NativeBridge {
        @JavascriptInterface public boolean hasCameraPermission() {
            return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        }
        @JavascriptInterface public void startRecognition(int id,String language) { runOnUiThread(() -> { guideStep=null; beginRecognition(id,language); }); }
        @JavascriptInterface public void startGuideRecognition(int id,String language,String step) { runOnUiThread(() -> { guideStep=step; beginRecognition(id,language); }); }
        @JavascriptInterface public void stopRecognition(int id) { runOnUiThread(() -> {
            if (pendingRecognitionId == id) { pendingRecognitionId=0; emit("recognition-end",id,null,false,null,null); }
            else if (recognitionId == id && offlineActive) offline.stop();
            else if (recognitionId == id && recognizer != null) try { clearSpeechDeadline(); recognizer.stopListening(); } catch(Exception ignored) { releaseRecognizer(); failRecognition(id,"network","语音输入已停止"); }
        }); }
        @JavascriptInterface public void cancelRecognition(int id) { runOnUiThread(() -> { if (pendingRecognitionId == id) pendingRecognitionId=0; if (recognitionId == id) releaseRecognizer(); }); }
        @JavascriptInterface public void speak(int id,String text,String language,float rate) { runOnUiThread(() -> speakNative(id,text,language,rate)); }
        @JavascriptInterface public void cancelSpeech() { runOnUiThread(() -> { pendingSpeechId=0; if (tts != null) tts.stop(); }); }
    }
    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results) {
        super.onRequestPermissionsResult(code,permissions,results);
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (code == MIC_REQUEST) micPermissionPending=false;
        if (code == CAMERA_REQUEST && pendingCamera != null) {
            PermissionRequest request=pendingCamera; pendingCamera=null;
            if (granted && foreground && !destroyed) request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE}); else request.deny();
        } else if (code == MIC_REQUEST && pendingRecognitionId != 0) {
            int id=pendingRecognitionId; pendingRecognitionId=0;
            if (granted && foreground && !destroyed) beginRecognition(id,pendingRecognitionLanguage);
            else failRecognition(id,"not-allowed","麦克风未获授权，请授权后轻触图标重试");
        }
    }
    @Override protected void onStart() {
        super.onStart(); foreground=true;
        if (web != null) {
            web.onResume();
            web.evaluateJavascript("window.dispatchEvent(new Event('pageshow'));",null);
        }
    }
    @Override protected void onStop() {
        foreground=false;
        super.onStop();
        web.evaluateJavascript("window.dispatchEvent(new Event('pagehide'));",null);
        web.onPause();
        pendingRecognitionId=0; pendingSpeechId=0; releaseRecognizer();
        if (tts != null) tts.stop();
        if (pendingCamera != null) { pendingCamera.deny(); pendingCamera=null; }
    }
    @Override public void onBackPressed() {
        handleBack();
    }
    private void handleBack() {
        if (destroyed || web == null) return;
        web.evaluateJavascript("window.ISeeYouAppBack ? window.ISeeYouAppBack() : false",result -> { if (!"true".equals(result)) finish(); });
    }
    @Override protected void onDestroy() {
        destroyed=true; releaseRecognizer(); if (offline != null) offline.close(); if (tts != null) { tts.stop(); tts.shutdown(); }
        if (web != null) { web.removeJavascriptInterface("DeviceApp"); web.removeJavascriptInterface("ISeeYouNative"); web.destroy(); }
        super.onDestroy();
    }
}
