package com.workbuddy.personaldrive;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Capacitor NativeFs 插件：SAF 选择保存位置/目录，后台线程按 URL 顺序流式下载并追加写。
 *
 * <p>JS 侧只传分片 URL 描述，插件自行完成网络与文件 IO，渲染层不持有整文件字节。
 * 进度通过 notifyListeners("progress", {taskId, written, total}) 推送。</p>
 */
@CapacitorPlugin(name = "NativeFs")
public class NativeFsPlugin extends Plugin {

    private static final String ERR_CANCEL = "E_NATIVEFS_CANCEL";
    private static final String ERR_PERM = "E_NATIVEFS_PERM";
    private static final String ERR_IO = "E_NATIVEFS_IO";
    private static final String ERR_UNSUPPORTED = "E_NATIVEFS_UNSUPPORTED";
    private static final String ERR_INVALID_PATH = "E_NATIVEFS_INVALID_PATH";

    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final ConcurrentHashMap<String, NativeFsWriter> writers = new ConcurrentHashMap<>();

    /** 选择保存文件（SAF ACTION_CREATE_DOCUMENT）。 */
    @PluginMethod
    public void pickSavePath(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("suggestedName", "download"));
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        startActivityForResult(call, intent, "onPickSavePathResult");
    }

    @ActivityCallback
    private void onPickSavePathResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK
                || result.getData() == null || result.getData().getData() == null) {
            call.reject(ERR_CANCEL, "已取消保存位置选择");
            return;
        }
        Uri uri = result.getData().getData();
        persistPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        JSObject out = new JSObject();
        out.put("canceled", false);
        out.put("uri", uri.toString());
        out.put("path", uri.toString());
        String name = getDisplayName(uri);
        if (name == null || name.isEmpty()) name = call.getString("suggestedName", "download");
        out.put("name", name);
        call.resolve(out);
    }

    /** 选择保存目录（SAF ACTION_OPEN_DOCUMENT_TREE）。 */
    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        startActivityForResult(call, intent, "onPickFolderResult");
    }

    @ActivityCallback
    private void onPickFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK
                || result.getData() == null || result.getData().getData() == null) {
            call.reject(ERR_CANCEL, "已取消目录选择");
            return;
        }
        Uri uri = result.getData().getData();
        persistPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        JSObject out = new JSObject();
        out.put("canceled", false);
        out.put("uri", uri.toString());
        out.put("path", uri.toString());
        String name = getDisplayName(uri);
        out.put("name", name == null ? "folder" : name);
        call.resolve(out);
    }

    /** 流式保存分片。 */
    @PluginMethod
    public void saveParts(final PluginCall call) {
        JSObject target = call.getObject("target");
        if (target == null) {
            call.reject(ERR_INVALID_PATH, "缺少保存目标");
            return;
        }
        String uriString = target.optString("uri", null);
        if (uriString == null || uriString.isEmpty()) uriString = target.optString("filePath", null);
        if (uriString == null || uriString.isEmpty()) {
            call.reject(ERR_INVALID_PATH, "保存目标缺少 uri / filePath");
            return;
        }
        final Uri targetUri = Uri.parse(uriString);
        final String relativePath = target.optString("relativePath", "");

        JSArray partsJson = call.getArray("parts");
        if (partsJson == null || partsJson.length() == 0) {
            call.reject(ERR_IO, "没有可下载的分片");
            return;
        }
        final List<NativeFsWriter.Part> parts = new ArrayList<>();
        try {
            for (int i = 0; i < partsJson.length(); i++) {
                Object item = partsJson.opt(i);
                if (item instanceof String) {
                    parts.add(new NativeFsWriter.Part((String) item, null, 0L));
                } else if (item instanceof JSONObject) {
                    JSONObject partObject = (JSONObject) item;
                    String url = partObject.optString("url", null);
                    if (url == null || url.isEmpty()) throw new IllegalArgumentException("分片 " + i + " 缺少 url");
                    Map<String, String> headers = new LinkedHashMap<>();
                    JSONObject headerObject = partObject.optJSONObject("headers");
                    if (headerObject != null) {
                        Iterator<String> keys = headerObject.keys();
                        while (keys.hasNext()) {
                            String key = keys.next();
                            headers.put(key, headerObject.optString(key, ""));
                        }
                    }
                    parts.add(new NativeFsWriter.Part(url, headers, partObject.optLong("size", 0L)));
                } else {
                    throw new IllegalArgumentException("分片 " + i + " 格式非法");
                }
            }
        } catch (Exception error) {
            call.reject(ERR_INVALID_PATH, error.getMessage() == null ? "分片参数非法" : error.getMessage());
            return;
        }

        final Long total = call.getLong("totalSize", 0L);
        final long totalSize = total == null ? 0L : total;
        final String taskId = call.getString("taskId", UUID.randomUUID().toString());

        executor.execute(new Runnable() {
            @Override
            public void run() {
                final NativeFsWriter writer = new NativeFsWriter(
                        getBridge().getContext(), targetUri, parts, totalSize, taskId,
                        new NativeFsWriter.ProgressListener() {
                            @Override
                            public void onProgress(long written, long totalBytes) {
                                JSObject progress = new JSObject();
                                progress.put("taskId", taskId);
                                progress.put("written", written);
                                progress.put("total", totalBytes);
                                notifyListeners("progress", progress);
                            }
                        });
                writers.put(taskId, writer);
                try {
                    writer.run();
                } finally {
                    writers.remove(taskId);
                }
                if (writer.isCanceled()) {
                    call.reject(ERR_CANCEL, "已取消（已保留部分文件）");
                } else if (writer.getLastError() != null) {
                    call.reject(ERR_IO, "写盘失败：" + writer.getLastError().getMessage(), writer.getLastError());
                } else {
                    JSObject out = new JSObject();
                    out.put("path", relativePath == null || relativePath.isEmpty()
                            ? targetUri.toString() : targetUri + "/" + relativePath);
                    out.put("uri", targetUri.toString());
                    out.put("bytesWritten", writer.getBytesWritten());
                    out.put("canceled", false);
                    call.resolve(out);
                }
            }
        });
    }

    /** 取消进行中的下载任务。 */
    @PluginMethod
    public void cancel(PluginCall call) {
        String taskId = call.getString("taskId");
        NativeFsWriter writer = taskId == null ? null : writers.get(taskId);
        if (writer != null) writer.cancel();
        JSObject out = new JSObject();
        out.put("ok", writer != null);
        call.resolve(out);
    }

    /** 读取文件片段（备用能力，返回 base64）。 */
    @PluginMethod
    public void readFileSlice(PluginCall call) {
        JSObject target = call.getObject("target");
        String uriString = target != null ? target.optString("uri", null) : call.getString("uri", null);
        if (uriString == null || uriString.isEmpty()) {
            call.reject(ERR_INVALID_PATH, "缺少文件路径");
            return;
        }
        Integer lengthValue = call.getInt("length", 0);
        int length = lengthValue == null ? 0 : lengthValue;
        Long offsetValue = call.getLong("offset", 0L);
        long offset = offsetValue == null ? 0L : offsetValue;
        try {
            InputStream input = getBridge().getContext().getContentResolver().openInputStream(Uri.parse(uriString));
            if (input == null) {
                call.reject(ERR_IO, "无法打开文件");
                return;
            }
            try {
                long skipped = 0;
                while (skipped < offset) {
                    long moved = input.skip(offset - skipped);
                    if (moved <= 0) break;
                    skipped += moved;
                }
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] chunk = new byte[8192];
                int remaining = length;
                int read;
                while (remaining > 0 && (read = input.read(chunk, 0, Math.min(chunk.length, remaining))) != -1) {
                    buffer.write(chunk, 0, read);
                    remaining -= read;
                }
                JSObject out = new JSObject();
                out.put("base64", Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP));
                call.resolve(out);
            } finally {
                input.close();
            }
        } catch (Exception error) {
            call.reject(ERR_IO, "读取失败：" + error.getMessage(), error);
        }
    }

    /** 用系统应用打开外部 HTTPS 链接。 */
    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        try {
            URL parsed = new URL(url);
            if (!"https".equalsIgnoreCase(parsed.getProtocol())) {
                call.reject(ERR_INVALID_PATH, "仅允许 HTTPS 外链");
                return;
            }
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getBridge().getContext().startActivity(intent);
            JSObject out = new JSObject();
            out.put("ok", true);
            call.resolve(out);
        } catch (Exception error) {
            call.reject(ERR_INVALID_PATH, "外链非法：" + error.getMessage(), error);
        }
    }

    /** 应用信息。 */
    @PluginMethod
    public void getAppInfo(PluginCall call) {
        JSObject out = new JSObject();
        out.put("platform", "android");
        out.put("version", "1.0.0");
        out.put("appName", "个人云盘");
        out.put("osVersion", "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")");
        try {
            out.put("packageVersion", getBridge().getContext().getPackageManager()
                    .getPackageInfo(getBridge().getContext().getPackageName(), 0).versionName);
        } catch (Exception ignored) {
            // 包信息不可用时保留默认版本
        }
        call.resolve(out);
    }

    private void persistPermission(Uri uri, int flags) {
        try {
            getBridge().getContext().getContentResolver().takePersistableUriPermission(uri, flags);
        } catch (Exception error) {
            // 某些厂商 ROM 不支持持久化授权，本次会话内仍可写
        }
    }

    private String getDisplayName(Uri uri) {
        try {
            String documentId = DocumentsContract.isDocumentUri(getBridge().getContext(), uri)
                    ? DocumentsContract.getDocumentId(uri) : DocumentsContract.getTreeDocumentId(uri);
            if (documentId != null && documentId.contains(":")) {
                return documentId.substring(documentId.indexOf(':') + 1);
            }
            return documentId;
        } catch (Exception error) {
            return null;
        }
    }
}
