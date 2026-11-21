package com.workbuddy.personaldrive;

import android.content.Context;
import android.net.Uri;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * SAF / MediaStore 流式写盘器。
 *
 * <p>分片 URL 由 JS 层传入，下载与写盘全部在本类（后台线程）完成，
 * Java 侧只保留一个 64KB 缓冲区；渲染层/WebView 不接触文件字节，避免大文件 OOM。</p>
 */
public class NativeFsWriter implements Runnable {

    /** 单个分片来源。 */
    public static final class Part {
        final String url;
        final Map<String, String> headers;
        final long size;

        public Part(String url, Map<String, String> headers, long size) {
            this.url = url;
            this.headers = headers == null ? new LinkedHashMap<String, String>() : headers;
            this.size = size;
        }
    }

    /** 进度回调（written 为累计写入字节数）。 */
    public interface ProgressListener {
        void onProgress(long written, long total);
    }

    private static final int BUFFER_SIZE = 64 * 1024;
    private static final int CONNECT_TIMEOUT_MS = 30_000;
    private static final int READ_TIMEOUT_MS = 60_000;

    private final Context context;
    private final Uri targetUri;
    private final List<Part> parts;
    private final long totalSize;
    private final String taskId;
    private final ProgressListener listener;

    private volatile boolean canceled = false;
    private volatile HttpURLConnection currentConnection = null;
    private volatile Exception lastError = null;
    private long bytesWritten = 0;

    public NativeFsWriter(Context context, Uri targetUri, List<Part> parts, long totalSize,
                          String taskId, ProgressListener listener) {
        this.context = context;
        this.targetUri = targetUri;
        this.parts = parts == null ? new ArrayList<Part>() : parts;
        this.totalSize = totalSize;
        this.taskId = taskId;
        this.listener = listener;
    }

    public String getTaskId() {
        return taskId;
    }

    public long getBytesWritten() {
        return bytesWritten;
    }

    public Exception getLastError() {
        return lastError;
    }

    public boolean isCanceled() {
        return canceled;
    }

    /** 请求取消：断开当前连接；写循环在下一个缓冲区边界停止。 */
    public void cancel() {
        canceled = true;
        HttpURLConnection connection = currentConnection;
        if (connection != null) {
            try {
                connection.disconnect();
            } catch (Exception ignored) {
                // 取消路径不抛异常
            }
        }
    }

    @Override
    public void run() {
        try {
            OutputStream output = context.getContentResolver().openOutputStream(targetUri, "wa");
            if (output == null) {
                throw new IOException("无法打开目标文件输出流（SAF 授权可能已失效）");
            }
            try {
                for (Part part : parts) {
                    if (canceled) return;
                    downloadOne(part, output);
                }
                output.flush();
            } finally {
                try {
                    output.close();
                } catch (IOException ignored) {
                    // 关闭失败不影响已完成写入的结果判定
                }
            }
        } catch (Exception error) {
            if (!canceled) {
                lastError = error;
            }
        } finally {
            currentConnection = null;
        }
    }

    private void downloadOne(Part part, OutputStream output) throws IOException {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(part.url).openConnection();
            currentConnection = connection;
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestMethod("GET");
            for (Map.Entry<String, String> header : part.headers.entrySet()) {
                connection.setRequestProperty(header.getKey(), header.getValue());
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new IOException("分片下载失败（HTTP " + status + "）：" + part.url);
            }
            byte[] buffer = new byte[BUFFER_SIZE];
            try (InputStream input = connection.getInputStream()) {
                int read;
                while (!canceled && (read = input.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                    bytesWritten += read;
                    if (listener != null) {
                        listener.onProgress(bytesWritten, totalSize);
                    }
                }
            }
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
            if (currentConnection == connection) {
                currentConnection = null;
            }
        }
    }
}
