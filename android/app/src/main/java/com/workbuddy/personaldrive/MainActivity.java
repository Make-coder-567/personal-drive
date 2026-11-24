package com.workbuddy.personaldrive;

import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

/**
 * Capacitor 宿主 Activity。注册 NativeFsPlugin，使 Web 内核通过 Capacitor.Plugins.NativeFs
 * 获得 SAF/MediaStore 流式落盘能力。
 *
 * 返回键：不再直接 finish。由 JS 判断当前目录层级——非根目录回退一级，根目录弹确认框；
 * 用户确认后通过 DriveBackBridge.exitApp() 退出。
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeFsPlugin.class);
        registerPlugin(DriveConsole.class);
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        webView.addJavascriptInterface(new BackBridge(), "DriveBackBridge");

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                webView.evaluateJavascript(
                    "(function(){try{return window.DriveBack ? window.DriveBack.onBack() : 'none'}catch(e){return 'error'}})()",
                    value -> {
                        // JS 尚未就绪或异常时保持系统默认行为：退出
                        if (value != null && (value.contains("none") || value.contains("error"))) {
                            runOnUiThread(MainActivity.this::finish);
                        }
                    });
            }
        });
    }

    /** 供 Web 层在用户确认退出后调用。 */
    private class BackBridge {
        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(MainActivity.this::finish);
        }
    }
}
