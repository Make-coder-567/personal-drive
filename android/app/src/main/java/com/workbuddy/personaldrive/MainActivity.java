package com.workbuddy.personaldrive;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * Capacitor 宿主 Activity。注册 NativeFsPlugin，使 Web 内核通过 Capacitor.Plugins.NativeFs
 * 获得 SAF/MediaStore 流式落盘能力。
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeFsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
