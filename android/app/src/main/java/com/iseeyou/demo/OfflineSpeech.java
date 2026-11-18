package com.iseeyou.demo;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** All model and recorder operations run on one worker; only UI callbacks use the main thread. */
final class OfflineSpeech {
    interface Listener {
        void ready();
        void result(String text, boolean complete);
        void error(String code, String message);
    }
    private static final int RATE = 16000;
    private static final String ARCHIVE_ROOT = "vosk-model-small-cn-0.22/";
    private static final class Job { volatile boolean cancelled, stop; }

    private final Context context;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private Job active;
    private Model model;

    OfflineSpeech(Context context) { this.context = context.getApplicationContext(); }

    void start(String grammar, Listener listener) {
        cancel();
        Job job = new Job();
        active = job;
        worker.execute(() -> run(job, grammar, listener));
    }
    void stop() { if (active != null) active.stop = true; }
    void cancel() { if (active != null) active.cancelled = true; active = null; }
    void close() {
        cancel();
        worker.execute(() -> { if (model != null) { model.close(); model = null; } });
        worker.shutdown();
    }
    private void post(Job job, Runnable notification) {
        main.post(() -> { if (active == job && !job.cancelled) notification.run(); });
    }

    // Only publish the model directory after the entire APK asset has been verified by ZipInputStream.
    private static synchronized File install(Context context, Job job) throws IOException {
        File root = context.getNoBackupFilesDir();
        File target = new File(root, "speech-zh-0.22");
        if (target.isDirectory()) return target;
        File staging = new File(root, "speech-zh-0.22.partial");
        if (!staging.isDirectory() && !staging.mkdirs()) throw new IOException("model storage");
        String prefix = staging.getCanonicalPath() + File.separator;
        byte[] block = new byte[65536];
        try (ZipInputStream zip = new ZipInputStream(context.getAssets().open("speech/zh-0.22.zip"))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (job.cancelled) throw new IOException("cancelled");
                if (entry.isDirectory()) continue;
                if (!entry.getName().startsWith(ARCHIVE_ROOT)) throw new IOException("model layout");
                File file = new File(staging, entry.getName().substring(ARCHIVE_ROOT.length()));
                if (!file.getCanonicalPath().startsWith(prefix)) throw new IOException("model path");
                File parent = file.getParentFile();
                if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("model storage");
                try (FileOutputStream out = new FileOutputStream(file)) {
                    int n;
                    while ((n = zip.read(block)) != -1) {
                        if (job.cancelled) throw new IOException("cancelled");
                        out.write(block, 0, n);
                    }
                }
            }
        }
        if (!new File(staging,"am/final.mdl").isFile() || !staging.renameTo(target)) throw new IOException("model incomplete");
        return target;
    }

    private AudioRecord openRecorder() throws IOException {
        int minimum = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minimum <= 0) throw new IOException("audio format unavailable");
        for (int source : new int[]{MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC}) {
            AudioRecord recorder = null;
            boolean usable = false;
            try {
                recorder = new AudioRecord(source, RATE, AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum * 2, 8192));
                if (recorder.getState() == AudioRecord.STATE_INITIALIZED) {
                    recorder.startRecording();
                    usable = recorder.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING;
                    if (usable) return recorder;
                }
            } catch (IllegalArgumentException | IllegalStateException ignored) {
                // Some devices only support the generic microphone source.
            } finally {
                if (recorder != null && !usable) recorder.release();
            }
        }
        throw new IOException("microphone unavailable");
    }

    private void run(Job job, String grammar, Listener listener) {
        if (job.cancelled) return;
        try {
            if (model == null) model = new Model(install(context, job).getAbsolutePath());
        } catch (IOException | RuntimeException | LinkageError e) {
            post(job, () -> listener.error("offline-model","本机中文识别未能加载，请检查手机可用空间后重试"));
            return;
        }
        if (job.cancelled || job.stop) {
            post(job, () -> listener.error("aborted","语音输入已取消"));
            return;
        }
        AudioRecord recorder = null;
        try (Recognizer decoder = grammar == null ? new Recognizer(model, RATE) : new Recognizer(model, RATE, grammar)) {
            if (job.cancelled) return;
            recorder = openRecorder();
            short[] pcm = new short[1600];
            boolean received = false;
            long start = SystemClock.elapsedRealtime(), lastAudio = start, lastPreview = start;
            String previous = "";
            while (!job.cancelled && !job.stop && SystemClock.elapsedRealtime() - start < 22000) {
                int count = recorder.read(pcm, 0, pcm.length, AudioRecord.READ_NON_BLOCKING);
                long now = SystemClock.elapsedRealtime();
                if (count < 0 || now - lastAudio > 3500) throw new IOException("no audio frames");
                if (count == 0) { SystemClock.sleep(15); continue; }
                lastAudio = now;
                if (!received) { received = true; post(job, listener::ready); }
                if (decoder.acceptWaveForm(pcm, count)) {
                    String text = new JSONObject(decoder.getResult()).optString("text").trim();
                    if (deliver(job, listener, text)) return;
                } else if (grammar == null && now - lastPreview > 300) {
                    lastPreview = now;
                    String partial = new JSONObject(decoder.getPartialResult()).optString("partial").trim();
                    if (!partial.isEmpty() && !previous.equals(partial)) {
                        previous = partial;
                        post(job, () -> listener.result(partial, false));
                    }
                }
            }
            if (!job.cancelled && !deliver(job, listener, new JSONObject(decoder.getFinalResult()).optString("text").trim()))
                post(job, () -> listener.error("no-speech","没有听清，请再说一次"));
        } catch (SecurityException denied) {
            post(job, () -> listener.error("not-allowed","系统未允许录音，请检查麦克风权限与系统麦克风开关"));
        } catch (Exception | LinkageError failure) {
            post(job, () -> listener.error("audio-capture","未能读取麦克风声音，请检查系统麦克风开关或其他应用占用后重试"));
        } finally {
            if (recorder != null) {
                try { recorder.stop(); } catch (RuntimeException ignored) { }
                recorder.release();
            }
        }
    }
    private boolean deliver(Job job, Listener listener, String text) {
        if (text.isEmpty() || text.contains("[unk]")) return false;
        post(job, () -> listener.result(text, true));
        return true;
    }
}
