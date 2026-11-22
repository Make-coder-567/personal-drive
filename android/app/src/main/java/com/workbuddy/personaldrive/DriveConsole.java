package com.workbuddy.personaldrive;

import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 诊断桥：把前端日志写入 logcat，便于 adb 排查 WebView 内实际状态。 */
@CapacitorPlugin(name = "DriveConsole")
public class DriveConsole extends Plugin {
    @PluginMethod
    public void log(PluginCall call) {
        String tag = call.getString("tag", "DriveWeb");
        String message = call.getString("message", "");
        Log.d(tag, message);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }
}
