# 个人云盘 · 生产化改造独立验证报告（QA-REPORT）

> 验证人：QA 工程师 严过关（Yan） ｜ 初版：2026-11-21 ｜ 最终验收更新：2026-11-21 ｜ 语言：中文
> 验证对象：`commit 4c8522d`（含 428b9d0 / 47fbf50 / 0c5a232 / 4c8522d）生产化改造全量成果
> 目标：**证明可用**（运行/构建/接口/安全/产物真实性），而非仅核对文件存在
> 验证方式：本地实机执行（PowerShell / Node / Bash + grep + node --check + unzip -t + 进程冒烟）
> 轮次：第 1 轮初验 → 工程师修复 P1 + 产出 Android APK → 第 2 轮最终验收（本报告为最终版）

---

## 一、总判定

# PASS_WITH_ISSUES

**核心结论**：Web / Android / Electron 三端产物均**真实存在且结构有效**，构建可复现、语法零错误、安全配置到位、接口 7 方法全部接线一致、无硬编码泄露。上一版的唯一缺陷 **P1（Electron `readFileSlice` 未接线）已修复并经回归验证通过**；Android 已通过项目内 `.toolchain/` 自举环境**真实产出 debug 签名 APK**（结构校验通过）。剩余问题均为**环境/签名类已知限制**，无代码缺陷、无阻断项，可进入交付/联调阶段。

## 1.1 配置注入后回归补充（2026-11-21 18:xx）

用户填入生产配置后，发现并修复了两个真实缺陷：

| 缺陷 | 根因 | 修复 | 复验 |
| --- | --- | --- | --- |
| 浏览器白屏 | `platform-runtime.js` 依赖 `RuntimeConfig`，但 `index.html` 未加载 `src/config/runtime-config.js` | 在 `__config__.js` 后、`platform-runtime.js` 前补入脚本 | 本地登录页正常显示 |
| `npm run build:win` EPERM | 重命名被资源管理器/运行中 EXE 锁定的 `win-unpacked` | 改为每次输出到独立 `.stage-<timestamp>` 目录，再由 `collect-artifacts` 复制最终 EXE | `npm run build:win` exit 0 |
| `.env.production` 重复键与错误 `VITE_SW_URL` | 手工粘贴造成重复 | 清理为单一正确配置组 | `dist/__config__.js` CSP/SW 地址正确 |
| CSP 关键字引号丢失 | env 解析剥离整值引号 | `gen-config.mjs` 对 `self`/`unsafe-inline` 等恢复单引号 | 生成 `'self'`、`'unsafe-inline'` |

本轮重新构建后的最终产物哈希（以本节为准）：

| 产物 | 大小 | SHA-256 |
| --- | --- | --- |
| `build/android/个人云盘-1.0.0-release-unsigned.apk` | 3,266,510 B | `54e42ad72b9f8b5d06de105a572137817ad053e42dab34a15c54b0dae4195984` |
| `build/windows/个人云盘-1.0.0-win-x64-setup-unsigned.exe` | 121,513,353 B | `6c99308c515eb8e25d9f890ea0a92475e9ecf6353e16a1c0835494cd72241f0a` |
| `build/windows/个人云盘-1.0.0-win-x64-portable-unsigned.exe` | 110,575,322 B | `7df6548c8954f236be6a43015b7d15e8ded442098689aa08bc5669a30fec5099` |

`python zipfile.testzip()` 对 APK 返回 `None`，且 `assets/public/index.html` 已包含 `runtime-config.js` 引用；`npm run check` 退出码 0。

## 1.2 移动端白屏诊断加固（2026-11-21 18:xx）

PC 端正常登录、Android WebView 白屏，说明配置正确但原生 WebView 初始化阶段存在等待或脚本异常。本轮新增：

- `src/compat.js`：`crypto.randomUUID` 兼容垫片，覆盖旧版 WebView。
- `src/boot-error.js`：全局 error / unhandledrejection 可视化浮层，异常直接显示在页面顶部。
- `index.html`：`boot-screen` 启动提示，避免初始化期间纯白。
- `app.js`：Capacitor 原生端先显示登录页，再后台检查会话；`getSession` 增加 15 秒超时与失败提示，绝不再停留在全部 hidden 的白屏状态。
- `scripts/collect-artifacts.mjs`：目标 EXE 被占用时写入 `-next.exe` 替代文件，不再让构建整体失败。

最新产物哈希（本节为最终值）：

| 产物 | 大小 | SHA-256 |
| --- | --- | --- |
| `build/android/个人云盘-1.0.0-release-unsigned.apk` | 3,269,128 B | `eb39f70c62a3baa1a8e8a2cb896051a8839e37f3695a3c9678b9fbdc030605f8` |
| `build/windows/个人云盘-1.0.0-win-x64-setup-unsigned.exe` | 121,514,758 B | `fb6a7abeded74d585d2cd48659469e987f3a46e70e095e4e8228186975cc235b` |
| `build/windows/个人云盘-1.0.0-win-x64-portable-unsigned.exe` | 110,574,092 B | `4a1566e2cddfd5d9d5c3ac00e1ef6b2bd55c21aa98de685ebc7286cd5005829b` |

APK 内已核验包含 `boot-error.js`、`compat.js`、`runtime-config.js`、`boot-screen` 与生产配置；ZIP 结构校验通过。若新 APK 仍异常，页面顶部会显示红色错误浮层，用户截图即可定位具体 WebView 错误。

## 1.3 adb 实机排查结论（2026-11-21 19:36）

- 设备 `HEW4YTYTWGVC7LHU`（PJG110）已授权，应用包 `com.workbuddy.personaldrive` 已安装。
- 排查发现手机此前停留旧包：`lastUpdateTime=2026-11-21 19:09:10`，而修复版通过 adb 安装后变为 `19:20:18`，随后再次安装最终版。
- 通过 adb 安装最终 APK 并启动后，实机截图 `docs/phone-final.png` 显示：登录页完整呈现，输入框、登录按钮、忘记密码入口均正常，红色错误浮层已消失。
- 根因结论：先前移动端白屏不是配置错误，也不是 WebView 必然不兼容，而是**手机仍运行修复前的旧 APK**；新 Web 内核需要覆盖安装/卸载重装才会进入 WebView。当前最终包已通过 adb 实机验证。
- logcat 抓取期间未发现应用自身的 `Uncaught` / `TypeError` / `ReferenceError` / `net::ERR_*` 错误；出现的 `JsConsole` 日志来自系统桌面 launcher，与本应用无关。
- 修复后 `boot-error.js` 的错误浮层改为仅在实际发生错误时创建，避免正常页面顶部出现空红色边框。

最终产物哈希（覆盖本节之前的哈希，以本表为准）：

| 产物 | 大小 | SHA-256 |
| --- | --- | --- |
| `build/android/个人云盘-1.0.0-release-unsigned.apk` | 3,269,208 B | `ffb7b825667d8f0eadb4549c8ce948755e0194ec2d10d76e13358eb132f7864d` |
| `build/windows/个人云盘-1.0.0-win-x64-setup-unsigned.exe` | 121,514,871 B | `3c1383a69c067e477e7e65a2087504c025a2b16ba4b0890c1544e91d4afc9d67` |
| `build/windows/个人云盘-1.0.0-win-x64-portable-unsigned.exe` | 110,567,404 B | `6ab819959d2f62ee3ab881bca0c9984ec91fec0edae9a2397a815d76ca9de107` |

| 等级 | 数量 | 说明 |
| --- | --- | --- |
| 阻断（Blocker） | 0 | 无 |
| 中等（Major） | 0 | 无 |
| 低（Minor） | 0 | 上一版 P1 已修复关闭 |
| 已知问题（Known） | 3 | 签名缺失、系统级 Android 构建路径不可用、无头 GUI 未验证 |

> **与上一版判定差异**：上一版 P1（低）已关闭；Android 由「未出包」升级为「unsigned APK 已产出」。故问题总数由 4 降为 3，且全部为 Known 级。

---

## 二、最终验收逐项验证表

| # | 验证项目 | 方法 | 结果 | 关键证据 |
| --- | --- | --- | --- | --- |
| 1.1 | EXE 存在/非空/大小 | PowerShell `Test-Path` + `Get-Item.Length` | ✅ PASS | setup=121,513,184 B；portable=110,565,960 B（**与工程师声称逐字节一致**） |
| 1.2 | EXE 为真实 PE | 读取文件头 8 字节 | ✅ PASS | 两者均 `4D 5A 90 00 03 00 00 00`（MZ + PE 偏移） |
| 1.3 | EXE SHA-256 | `Get-FileHash -Algorithm SHA256` | ✅ PASS | setup=`022c2cce…98c4`；portable=`cda5c551…af2c2`，**与声称值完全一致**（见第四节） |
| 1.4 | EXE 签名状态 | `Get-AuthenticodeSignature` | ✅ PASS（符合预期） | 两者 `Status=NotSigned`，与 `-unsigned` 命名一致 |
| 1.5 | APK 存在/非空/大小 | PowerShell `Get-Item` | ✅ PASS | `build/android/个人云盘-1.0.0-release-unsigned.apk` = 3,266,354 B（**与声称一致**） |
| 1.6 | APK 真实 ZIP 结构 | `unzip -t` + Python `zipfile.testzip()` | ✅ PASS | `No errors detected…`；`testzip()=None`；455 条目 |
| 1.7 | APK 关键条目 | `unzip -l` | ✅ PASS | 含 `classes.dex`(7,113,400 B)、`AndroidManifest.xml`、`resources.arsc`、`assets/public/index.html`(21,213 B) |
| 1.8 | APK 签名状态 | 查找 `APK Sig Block 42` magic | ✅ PASS（符合预期） | magic 命中于 offset 3,237,412 → **V2/V3 签名块存在（debug 签名）**；无 V1 `META-INF/*.RSA`（符合现代签名方案） |
| 1.9 | APK SHA-256 | `Get-FileHash -Algorithm SHA256` | ✅ PASS（实测） | `3ef6c16ff489c3a0d1357ca222877d10e27c333c0b0236542fdc19ff1502ae97` |
| 1.10 | ICO 真实帧 | Node 解析 ICONDIR + 帧头 | ✅ PASS | `type=1, count=5`，5 帧均 PNG (`89504e47`)，16/32/48/64/256px |
| 1.11 | dist 产物非空 | `find dist -type f` + 大小 | ✅ PASS | 18 个文件全部 >0；4 个强制校验项齐备 |
| 1.12 | Web 构建可复现 | 构建前后 SHA-256 对比 | ✅ PASS | `build:web` 重跑后 4 项哈希与构建前完全一致 |
| 2.1 | 自检脚本（最终回归） | `npm run check` | ✅ PASS | `[check] 自检通过。` 退出码 0；4/4 产物 OK，无硬编码命中——**确认修复未破坏 Web 产物** |
| 2.2 | Web 构建 | `npm run build:web` | ✅ PASS | 退出码 0，`vite v5.4.21 built in 4.23s` |
| 2.3 | 全量语法（最终回归） | `node --check` 逐文件 | ✅ PASS | 全部 JS/MJS（含 4 处修复文件）`SYNTAX_FAILED=0` |
| 3.1 | 硬编码密钥/域名/站点码 | 全项目 grep | ✅ PASS | 敏感词仅出现在 docs 历史描述，业务源码零命中 |
| 3.2 | .env.example 占位 | 逐行阅读 | ✅ PASS | 全为 `REPLACE_WITH_*` / `*.example.com`，无真实密钥 |
| 3.3 | __config__.js 字段齐全 | 对比架构 §3.1 | ✅ PASS | public 与 dist 一致；12 顶层字段 + 5 组 cspSources 齐全；version=1.0.0 |
| 4.1 | NativeFs 7 方法 | 门面 `METHODS` 数组 | ✅ PASS | 7 方法齐全，三端适配器均导出 |
| 4.2 | progress 字段 | 三端交叉核对 | ✅ PASS | 主进程 `{taskId,written,total}` → preload → 适配器消费，字段一致 |
| 4.3 | cancel(taskId) 参数类型 | 全链路类型追踪 | ✅ PASS | Electron 全程 `String(taskId)`；Capacitor 经 Java `getString`，调用方均传 string |
| 4.4 | **IPC channel 对齐（P1 复验）** | preload vs file-ipc vs 架构 §3.3 | ✅ **PASS（已修复）** | `nativefs:read-file-slice` 三处齐备：preload 暴露 + IPC handler 注册 + 架构表项；详见第三节 |
| 5.1 | Electron 安全开关 | 阅读 `electron/main.js` | ✅ PASS | contextIsolation:true / nodeIntegration:false / sandbox:true / webSecurity:true / allowRunningInsecureContent:false |
| 5.2 | preload 白名单 | 阅读 `electron/preload.js` | ✅ PASS | 8 项白名单 API（含新增 readFileSlice），**未暴露 `ipcRenderer` 本体** |
| 5.3 | download-writer 写盘 | 阅读源码 | ✅ PASS | 串行分片、`flags:'a'` 追加写、`AbortController`、`waitForDrain` 背压齐备 |
| 5.4 | path-guard 防护 | 阅读源码 | ✅ PASS | HTTPS 强制、路径逃逸双重校验、**新增 `validateReadPath()` 读取白名单** |
| 6.1 | Android 源码完整性 | 文件 + 方法 grep | ✅ PASS | 3 Java + build.gradle + Manifest 齐全；7 个 `@PluginMethod` 完整 |
| 6.2 | Android SDK 版本 | 读取 gradle 配置 | ✅ PASS | minSdk 26 / compileSdk 36 / targetSdk 36 / applicationId `com.workbuddy.personaldrive` |
| 6.3 | **Android 真实出包（复验）** | 产物 + `.toolchain/` | ✅ **PASS（已修复）** | unsigned APK 真实产出 3,266,354 B，结构/签名校验通过；系统级路径仍失败但工具链路径可用 |
| 7.1 | portable 启动冒烟 | Start-Process + 12s 轮询 | ⚠️ PARTIAL | 主进程持续存活 12s，进程名正确；窗口标题为空（无头会话，GUI 未验证） |
| 7.2 | 不静默安装 NSIS | 仅执行 portable | ✅ PASS | 未运行 setup EXE，未触发安装 |
| 8.1 | README 产物路径一致性 | grep README vs 真实文件 | ✅ PASS | README 记录的 `-setup-unsigned.exe` / `-portable-unsigned.exe` 与真实文件逐一对应 |
| 8.2 | 版本/应用名一致 | 多文件交叉核对 | ✅ PASS | 三端均为 `1.0.0` / `个人云盘` |

---

## 三、已修复问题与验证证据

### ✅ P1（原 Minor）· Electron 端 `readFileSlice` 未接线 —— 已修复关闭

**原问题**：Electron 适配器声明 `readFileSlice()` 但 preload / IPC / 架构表缺对应通道，调用会返回 `E_NATIVEFS_UNSUPPORTED`。

**修复内容（工程师 commit `4c8522d`，四处均实测确认）**：

1. **`electron/preload.js:11-19`** 暴露该方法，参数做类型归一化，返回可结构化克隆的 `Uint8Array`：
   ```js
   readFileSlice: (request) => {
     const req = request || {};
     return ipcRenderer.invoke('nativefs:read-file-slice', {
       path: String(req.path || ''),
       offset: Number(req.offset) || 0,
       length: Number(req.length) || 0,
     });
   },
   ```
2. **`electron/ipc/file-ipc.js`**：`validateReadPath` 引入（:6）、handler 注册（:59-75）、`disposeIpc` 列表追加（:105）；handler 按 offset/length 用 `fsp.open`+`handle.read` 读取，返回 `new Uint8Array(...)`。
3. **`electron/file/path-guard.js:74-89`** 新增 `validateReadPath()`：非空 + 无 NUL 字符 + `path.resolve` 归一化 + 可选 `ELECTRON_ALLOWED_READ_ROOTS` 白名单防逃逸；`module.exports` 已导出（:91）。
4. **`docs/ARCHITECTURE.md:300`** §3.3 补表项：`nativefs:read-file-slice` / invoke / `{path,offset,length}` / `Uint8Array`（主进程按 path-guard 校验）。

**验证证据**：
- 四处 grep 全部命中，代码质量良好（边界检查 `1B~256MB`、路径白名单、错误码规范）。
- `node --check` 对 `preload.js` / `file-ipc.js` / `path-guard.js` / `main.js` / `download-writer.js` / `nativefs.electron.js` 全部 OK。
- `npm run check` 最终回归退出码 0，Web 产物未破坏。
- **结论：P1 关闭，接口 7 方法全链路一致。**

### ✅ K1（原 Known）· Android APK 未生成 —— 已升级为 unsigned APK 已产出

**修复内容（工程师 commit `0c5a232`）**：项目内 `.toolchain/` 自举 JDK 21 + SDK 36 + Gradle 8.14.3，绕过系统级 JBR 25 / gradlew PKIX 问题，真实产出 debug 签名 APK；`docs/BUILD-BLOCKERS.md` 已更新说明两条构建路径。

**验证证据**：
- 产物存在：3,266,354 B，ZIP 头 `50 4B 03 04`。
- `unzip -t`：`No errors detected in compressed data`；`zipfile.testzip()=None`，455 条目。
- 关键条目齐全：`classes.dex` / `AndroidManifest.xml` / `resources.arsc` / `assets/public/index.html`。
- 签名：`APK Sig Block 42` magic 命中 offset 3,237,412 → V2/V3 debug 签名块存在。
- SHA-256（实测）：`3ef6c16ff489c3a0d1357ca222877d10e27c333c0b0236542fdc19ff1502ae97`。
- **结论：状态由「未出包」改为「unsigned/debug APK 已产出，正式 release 签名仍缺失」。**

---

## 四、剩余已知问题（均为环境/签名类，非代码缺陷）

### K2 · 三端安装包均未正式签名（已知 / 签名材料缺失）

- **证据**：双 EXE `Authenticode Status=NotSigned`；APK 为 debug 签名（V2/V3 block，非 release keystore）。
- **影响**：Windows 触发 SmartScreen 警告；Android APK 仅内部测试、不可上架。
- **下一步**：补齐 Windows EV/OV 证书 + Android release keystore 后重签，产出不带 `-unsigned` 的正式包。

### K3 · 系统级 Android 构建路径不可用（已知 / 环境限制）

- **证据**：`npm run build:android` 仍因系统 `JAVA_HOME=JBR 25`（`Unsupported class file major version 69`）与 gradlew 下载 PKIX 证书链失败而退出码 1；成功路径为项目内 `.toolchain/` 临时环境。
- **影响**：开发者直接用系统 npm 脚本无法出包，需按 BUILD-BLOCKERS.md 使用 `.toolchain/`。
- **下一步**：CI 固化 JDK 21 + SDK 36 环境，或将 `.toolchain/` 自举纳入 `build:android` 默认流程。

### K4 · GUI 渲染未在冒烟中验证（已知 / 验证环境限制）

- **证据**：启动 portable 后主进程存活但 `MainWindowTitle` 为空，当前无头/服务会话无法读取 GUI 窗口。
- **影响**：进程级启动通过，但首屏渲染/登录/上传下载等交互需在有桌面会话环境补充验证。
- **下一步**：带 GUI 桌面会话重复冒烟，并核对大文件下载内存平稳性。

---

## 五、产物清单与 SHA-256（全部为 QA 实测值）

| 产物 | 大小（字节） | SHA-256（实测） | 与声称值 |
| --- | --- | --- | --- |
| `build/android/个人云盘-1.0.0-release-unsigned.apk` | 3,266,354 | `3ef6c16ff489c3a0d1357ca222877d10e27c333c0b0236542fdc19ff1502ae97` | ✅ 大小一致（APK 声称值未给哈希，此处为实测） |
| `build/windows/个人云盘-1.0.0-win-x64-setup-unsigned.exe` | 121,513,184 | `022c2cce6fbd65e843d14d73be1fa356605f91fc16355515d7371a99c3cb98c4` | ✅ 大小/哈希均一致 |
| `build/windows/个人云盘-1.0.0-win-x64-portable-unsigned.exe` | 110,565,960 | `cda5c5514b9dc7a602711f7b631e79dbaaf13a9536e42fdadd2f236d483af2c2` | ✅ 大小/哈希均一致 |
| `dist/index.html` | 21,213 | `683F26E5DD156E7D6E26328DA4C1BAC3A0C93FE41824B1837E97C58C713F4DAE` | ✅ 构建可复现 |
| `dist/__config__.js` | 689 | `9194C7171F1559956EB668CE7E2BEF19C68FCAF4F34B738BE5AF99F359722C59` | ✅ |
| `dist/vendor/workbuddy-cloud-sdk.js` | 71,891 | `FD82877F6C3AC9836E604AD400AC5D84B26A39E98D1D871536781046A7AC3D27` | ✅ |
| `dist/vendor/client-zip.global.js` | 6,866 | `97D1B674B631ADAE4CAA6A163D2DE85968383767ADAFE688D1ED9C3472C69CC9` | ✅ |
| `electron/assets/icon.ico` | 3,233 | `705F67626D5A69DD8FF0DDE08F597FE77F7F6A1F7323F46552E8D2E435D54C01` | ✅ |

> EXE 哈希与工程师/team-lead 声称值**逐字符吻合**，无差异。
> `build/windows/` 下另有 electron-builder 原始产物（无 `-unsigned` 后缀），交付以 README 指向的 `-unsigned` 版本为准。
> `build/android/` 现含 1 个文件（unsigned APK），已无「空目录」情况。

---

## 六、阻塞项与下一步

1. **无阻断项，无代码缺陷**：三端可交付，进入联调阶段。
2. **正式签名**：补 Windows EV/OV 证书 + Android release keystore 后重签（K2）。
3. **Android 构建路径**：CI 固化 JDK21/SDK36 或将 `.toolchain/` 自举纳入默认脚本（K3）。
4. **GUI 联调**：带桌面会话补做三端首屏 + 登录/上传/下载/分享全链路冒烟与内存观测（K4）。
5. **生产配置注入**：`__config__.js` 的 `endpoint`/`publishableKey` 为空（构建告警，符合安全设计），生产部署须由 CI 注入并配置后端来源白名单。

---

## 附：最终验收命令清单（可复现）

```bash
npm run check                       # 自检：产物齐备 + 无硬编码（退出码 0）
npm run build:web                   # Web 构建（退出码 0）
node --check <每个 JS/MJS 文件>      # 全量语法（SYNTAX_FAILED=0）
unzip -t build/android/个人云盘-1.0.0-release-unsigned.apk   # APK 结构（No errors）
```

```powershell
Get-Item <artifact>                                          # 大小
[System.IO.File]::OpenRead(<artifact>).Read($b,0,8)          # PE/ZIP 头
Get-AuthenticodeSignature <exe>                              # 签名状态
Get-FileHash <artifact> -Algorithm SHA256                    # 哈希
```

---

## 七、移动端数据回归（BugFix 快捷路径，2026-11-22）

### 缺陷

Android 端登录旧账号后看不到 PC 端已有文件，且上传文件/文件夹失败；PC Electron 端正常。

### 根因

WorkBuddy Cloud SDK `storage-js/2.112.3` 在所有 storage 请求上携带 `X-Client-Info`，
上传（POST）额外携带 `x-upsert`；云端 CORS `Access-Control-Allow-Headers` 白名单不含这两项。
Electron 不做 CORS 校验所以 PC 正常；Android WebView（`https://localhost`）预检失败，
`fetch()` 抛 `TypeError: Failed to fetch`，导致：

- `list`/`download` 返回 `{error}` → `loadMeta()` 候选=0 → 文件列表空；
- `saveMeta()` 第三步上传抛出 → 上传任务失败。

用户 id 实测 `2111816543045169152`，与 PC 一致，**排除账号/租户串号**。

### 修复与回归

- 修复：`src/compat.js` 增加 fetch 兼容层，剥离 `x-client-info` 与 `x-upsert`；
  `app.js` 增加 `[list-err]` / `[saveMeta-err]` 诊断日志。
- Web：`npm run build:web` / `npm run check` 通过。
- Android：修复版 APK 已 `adb install -r` 安装到 HEW4YTYTWGVC7LHU；重启后
  `[meta] 候选=2 ver=56 文件=7 文件夹=4`，UI 显示 4 个文件夹；
  实机上传 1 个文件 → 「成功 1，失败 0」，任务「完成」，文件立即在列表中可见；
  logcat 无 `REJECTION Failed to fetch`。
- Windows：共享源码变更，`npm run build:win` 已重建（setup + portable）。

详细证据与预检实测见 `docs/MOBILE-DATA-DIAG.md`。

---

## 八、移动端数据与上传修复回归（QA 独立复验，2026-11-22 10:35–10:50）

> 验证人：QA 工程师 严过关（Yan） ｜ 独立回归，非复述工程师结论
> 目标：证明功能真实恢复（旧文件可见 + 上传成功 + 无回归），而非仅确认文件存在
> 验证对象：`commit 4f81b8feaa7074973e59cf3552527d8388252160`
> 设备：`HEW4YTYTWGVC7LHU`（OPPO PJG110，adb 已授权） ｜ 包：`com.workbuddy.personaldrive`
> 方式：源码审查 + 构建产物哈希/解包 + adb 实机功能回归 + 桌面构建复核

### 8.0 总判定

# PASS

本次 BugFix 无效路径已彻底修复并经 QA **独立实机证明**：Android 旧账号 `2111816543045169152` 登录后文件列表恢复正常（修复前候选=0/文件=0/文件夹=0 → 修复后候选=3/文件=8/文件夹=4），4 个旧文件夹全部可见可进入；**QA 自主完成一次真实文件上传端到端验证**（成功 1、失败 0），并在 force-stop 冷重启后确认文件已持久化到云端（文件计数 8→9、元数据版本 58→60、文件在新列表中可见）。全链路无 `Failed to fetch` / `list-err` / `saveMeta-err` / `Uncaught` / `TypeError`。桌面端 `npm run build:web`、`npm run check` 均通过，无平台兼容回退。无新增代码缺陷，无阻断项，**可交付**。

遗留项均为既有环境/签名类 Known（见第四节 K2/K3/K4 与 8.6），非本次引入。

### 8.1 逐项验证表

| # | 验证项目 | 方法 | 结果 | 关键证据（QA 独立实测） |
| --- | --- | --- | --- | --- |
| 8.1.1 | fetch 包装早于 SDK | 阅读 index.html 脚本顺序 | ✅ PASS | `src/compat.js` 在 line 11，`vendor/workbuddy-cloud-sdk.js` 在 line 22，`src/sdk-loader.js` 在 line 346；兼容层先于 SDK 执行 |
| 8.1.2 | 正确剥离两种 header | 阅读 src/compat.js + SDK bundle | ✅ PASS | `STRIP_HEADERS=['x-client-info','x-upsert']`；SDK `dist/vendor/workbuddy-cloud-sdk.js` 实测含 `X-Client-Info: storage-js/2.112.3` 与上传 POST 的 `x-upsert`，剥离目标准确 |
| 8.1.3 | 保留 init 字段 | 阅读 fetch 包装实现 | ✅ PASS | `for (var k in init) if(hasOwnProperty) nextInit[k]=init[k]` 全量复制 method/body/signal/duplex，仅覆盖 headers；Headers 构造失败回退原始调用；`__driveCorsFetchPatched` 幂等 |
| 8.1.4 | 包装进入 SDK 调用链 | 追踪 SDK 运行时 | ✅ PASS | app.js `createWorkBuddyCloud(publicConfig)` 未传 `fetch` → SDK `resolveRuntimeConfig` 用 `globalThis.fetch.bind(globalThis)`；app.js 经 sdk-loader 在 compat.js 之后加载，故绑定的是已包装的 fetch，剥离逻辑生效 |
| 8.1.5 | 无硬编码回潮 | `npm run check` | ✅ PASS | 4/4 产物 OK，`[check] 自检通过。`，退出码 0 |
| 8.1.6 | 诊断日志就位 | grep app.js | ✅ PASS | `[list-err]`(:152)、`[saveMeta-err]`(:573)、`[auth] id=`(:357)、`[meta] uid=`(:551)、`[upload] 选中=`(:1000) 全部存在 |
| 8.1.7 | 构建产物存在/非空 | find + 大小 | ✅ PASS | dist 18 文件全非空；APK 3,271,044 B；两个 EXE 均 >110 MB |
| 8.1.8 | APK 结构有效 | python `zipfile.testzip()` | ✅ PASS | `testzip()=None`，457 条目 |
| 8.1.9 | APK 内含修复版 Web 资源 | 解包 grep | ✅ PASS | `assets/public/src/compat.js` 含 `x-client-info`/`x-upsert`/`__driveCorsFetchPatched`；`assets/public/app.js` 含 `list-err`/`saveMeta-err`/`[meta] uid=`；内嵌 index.html 脚本顺序 compat 早于 SDK |
| 8.1.10 | EXE 为真实 PE | 读 MZ + PE 偏移 | ✅ PASS | setup/portable 均 `MZ=True`、PE 偏移 0xD8 |
| 8.1.11 | 设备/安装版本 | adb devices + pm path + dumpsys | ✅ PASS | 在线 `HEW4YTYTWGVC7LHU device`；`versionName=1.0.0`；`lastUpdateTime=2026-11-22 10:21:19`（修复后）；拉取安装 APK 哈希与构建产物逐字节一致 |
| 8.1.12 | 实机：认证 id 与 PC 一致 | force-stop→清 logcat→monkey 启动→抓日志 | ✅ PASS | `D DriveWeb: [auth] id=2111816543045169152 email=(none) v=v1.0.0` |
| 8.1.13 | 实机：旧文件/文件夹可见 | `[meta]` 日志 + UI 截图 | ✅ PASS | `[meta] uid=… 候选=3 ver=58 文件=8 文件夹=4`（修复前 0/0/0）；截图 `qa-mobile-regression.png` 根目录显示"离线ai项目"与 JPG 文件，无"此目录为空" |
| 8.1.14 | 实机：4 个旧文件夹齐全 | 进入文件夹截图 | ✅ PASS | 截图 `qa-folder-open.png`：`离线ai项目 → offline_chatAI / 全量包 / 轻量包`，与 PRD 要求的 4 个文件夹完全一致 |
| 8.1.15 | **实机：普通文件上传端到端** | adb 推 1×1 PNG→选文件→上传→查日志/弹窗 | ✅ **PASS** | `[upload] 选中=1`；弹窗 `上传到「根目录」：共 1 个文件，成功 1，跳过 0，取消 0，失败 0。`；任务状态"完成"；截图 `qa-up-result.png` |
| 8.1.16 | **实机：上传持久化（冷重启复核）** | force-stop→清 logcat→重启→查 meta + UI | ✅ **PASS** | 重启后 `[meta] … 候选=3 ver=60 文件=9 文件夹=4`（较上传前 8→9、ver 58→60）；截图 `qa-up-persist.png` 新列表底部可见 `qa_regression_1x1.png` |
| 8.1.17 | 无异常日志 | 全 buffer grep | ✅ PASS | 无 `Failed to fetch` / `list-err` / `saveMeta-err` / `REJECTION Failed to fetch` / `Uncaught` / `TypeError` / `ReferenceError`（系统 launcher/JsConsole 噪声已排除） |
| 8.1.18 | 桌面端构建无回归 | `npm run build:web` + `npm run check` | ✅ PASS | build:web `✓ built in 4.25s` exit 0；check exit 0；compat 为三端共享纯前端垫片，Electron 源码未引入平台回退；`dist/index.html` 重建后仍 21,636 B、脚本顺序不变 |

### 8.2 源码审查详情

- **`src/compat.js`**（核心修复）：在 IIFE 中先判 `nativeFetch` 为函数且 `!__driveCorsFetchPatched`，再包装 `global.fetch`。对 `init.headers` 用 `new Headers()` 归一化后删除两个头；任一命中则浅拷贝 `init` 全部自有属性并替换 `headers` 调用原生 fetch，未命中或构造异常均原样调用——不改动 method/body/signal/duplex，具备幂等与失败安全。
- **脚本顺序**：`index.html` line 11 加载 compat，line 22 加载 SDK，line 346 由 sdk-loader 动态加载 app.js → accel.js。兼容层确定先于一切 SDK 请求。
- **`app.js`**（诊断加固）：新增统一 `diagLog()` 通道，仅在 Capacitor 端经 `window.__driveBootError.log` 写 logcat，Web/Electron 为无害空操作；`[list-err]`、`[saveMeta-err]`、`[list] 失败`、`[auth] id`、`[meta] uid`、`[upload] 选中` 六处埋点齐备。
- **调用链确认**：SDK 未收到自定义 `fetch`（publicConfig 仅 endpoint/relay/key），`resolveRuntimeConfig()` 绑定 `globalThis.fetch`；因 compat 先加载，绑定对象即包装后 fetch，剥离逻辑真实生效——非"看起来修了但没走到"。

### 8.3 构建产物哈希（QA 实测，SHA-256）

| 产物 | 大小（字节） | SHA-256（实测） | 说明 |
| --- | --- | --- | --- |
| `build/android/个人云盘-1.0.0-release-unsigned.apk` | 3,271,044 | `3c34a4e5a388396a5e3f89f267df239c34519f6c9e2c91f25cb53e58cc9e5823` | 与设备上 `pm path` 拉取的 `base.apk` 哈希**逐字节一致** |
| `build/windows/个人云盘-1.0.0-win-x64-setup-unsigned.exe` | 121,515,648 | `92c191a7cb42bcb5cfa116f9a26754e8b4ae4eb31b2f12b515cbc05917b1e48d` | 本轮重建版 |
| `build/windows/个人云盘-1.0.0-win-x64-portable-unsigned.exe` | 110,571,747 | `7d491d98175d3638ee037e7e46a2add0944eb0c6dd602d59b9a765c2c82087f6` | 本轮重建版 |
| `dist/index.html` | 21,636 | `6c73c8f7d6053c4fc0b35912eb68547e5dfae715db02d5173a72a486599342e6` | 重建后与重建前一致（可复现） |
| `dist/app.js` | 105,329 | `8f239841e851bd9917b7ae96e43a34336b3718a3efb9aea5c009434d6952bebd` | 含诊断日志 |
| `dist/src/compat.js` | 2,778 | `c7246caee76310ba9bc53fda021be603ca3fc327c869c531fc02510aec371dc3` | 含 CORS 兼容层 |

> 说明：APK/EXE 哈希与第四节旧版不同，系本次 BugFix 重建所致（源码变更 → 产物必然变化），非异常；版本仍为 1.0.0。Vite 构建日志显示的 `dist/index.html 15.70 kB` 为其转换内容统计，实际落盘文件仍为 21,636 B。

### 8.4 实机回归时间线（可复现）

1. `adb devices -l` → 设备在线；`pm path` → base.apk 路径；拉取 base.apk 与构建产物哈希一致。
2. `am force-stop` → `logcat -c` → `monkey -p … 1` 启动（全程未要求用户重新登录，session 在 localStorage 持久）。
3. 抓 `-s DriveWeb:* DriveWebError:*` → `[auth] id=2111816543045169152`、`[meta] 候选=3 ver=58 文件=8 文件夹=4`。
4. 截图根目录 → "离线ai项目" + JPG 文件可见；点击文件夹进入 → `offline_chatAI / 全量包 / 轻量包` 三个子文件夹可见。
5. 推入 1×1 PNG（`qa_regression_1x1.png`）→ 上传文件 → 选"根目录" → 选文件 → `[upload] 选中=1`，弹窗"成功 1，失败 0"，任务"完成"。
6. `am force-stop` → `logcat -c` → 重启 → `[meta] … ver=60 文件=9`，新列表底部可见 `qa_regression_1x1.png` → **持久化确认**。
7. 全 buffer 错误串扫描 → 0 命中。

**证据截图**（存于 docs/）：`qa-mobile-regression.png`（旧文件恢复）、`qa-folder-open.png`（4 个旧文件夹）、`qa-up-result.png`（上传成功弹窗）、`qa-up-persist.png`（冷重启后文件仍在）。

### 8.5 路由决策

**NoOne** —— 全部验证项通过，未发现源码缺陷，无需回退工程师；测试断言均基于 PRD/诊断预期，无 QA 自身误判。

### 8.6 已知问题（非本次引入，不影响交付）

- **K5 · 测试文件残留云端**：QA 上传的 `qa_regression_1x1.png`（70 B）留在根目录以证明持久化；设备本地同名文件已 `rm` 清理。如需纯净演示，可在 UI 手动删除该 70 B 文件——不影响功能判定。
- 既有 K2（三端未正式签名）、K3（系统级 Android 构建路径不可用，需 `.toolchain/`）、K4（无头会话 GUI 未做交互冒烟）保持原状；其中 K4 的 GUI 交互部分已由本次 adb 实机操作**大幅补强**（登录态恢复、文件浏览、上传、重启持久化均已实测），仅桌面 Electron GUI 仍未在带界面会话验证。

### 8.7 交付结论

**可交付（PASS）**。Android 数据不可见与上传失败两个原始症状均已独立修复验证；桌面端无回归；产物真实、哈希明确、可复现。建议后续按 K2 补齐正式签名、按 K3 在 CI 固化 Android 构建环境。
