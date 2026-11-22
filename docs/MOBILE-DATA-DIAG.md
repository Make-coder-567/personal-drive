# Android 移动端「看不到旧文件 + 上传失败」诊断与修复

## 1. 症状

- Android（Capacitor WebView，`https://localhost`）登录旧账号后文件列表为空；上传文件/文件夹失败。
- PC Electron 端同一账号完全正常，能看到 PC 端已上传的文件。

## 2. 取证过程与证据

### 2.1 logcat 实测（设备 HEW4YTYTWGVC7LHU，包名 com.workbuddy.personaldrive）

诊断版 APK 首次抓日志时 main buffer 已被系统日志冲掉，仅剩：

```
D DriveWeb: [upload] 选中=1 首路径=(无)
D DriveWebError: REJECTION Failed to fetch
```

清空 logcat、`am force-stop` 后重启（**不要求用户重新登录**，session 在 localStorage 中持久）重新取证：

```
D DriveWeb: [auth] id=2111816543045169152 email=(none) v=v1.0.0
D DriveWeb: [meta] uid=2111816543045169152 候选=0 ver=0 文件=0 文件夹=0
```

**结论 A：用户 id 与 PC 完全一致（`2111816543045169152`），不是账号/租户/环境串号。**
**结论 B：`loadMeta()` 的三个数据源（本地记录键、`meta/` 列表、旧 `index.json`）全部拿不到数据，候选数=0。**
**结论 C：`uploadFiles()` 在 `await saveMeta()`（上传任何分片之前）即抛出 `Failed to fetch`。**

截图也显示顶栏用户 id 为 `2111816543045169152`，与日志一致。

### 2.2 排除项

- 设备 DNS/网络正常：`ping personal-drive-52476.app.workbuddy.host` 与 `ping www.workbuddy.cn` 均 0% 丢包。
- 服务端 CORS 对 `Origin: https://localhost` 正常放行：预检返回 `204`，`Access-Control-Allow-Origin: https://localhost`。
- Service Worker 只拦截 `/__dl__/`，不会碰 `.cloud/*` 请求。
- 原生宿主未注入 `__DRIVE_CONFIG_RUNTIME__` 覆盖配置；Web/Android 使用同一 `endpoint` 与 `publishableKey`。
- `X-Client-Info` 与 `x-upsert` 之外，其余 SDK 请求头均在白名单内。

### 2.3 根因（实测确认）

WorkBuddy Cloud SDK `storage-js/2.112.3` 会给**所有 storage 请求**加：

```
X-Client-Info: storage-js/2.112.3
```

并在上传（POST）时额外加：

```
x-upsert: false
```

服务端 CORS 白名单实测为：

```
Authorization, X-Wb-Webapp-Access-Key, Content-Type, Accept, Prefer, Range,
Content-Range, If-Match, If-None-Match, X-Request-Id, X-Device-Id, X-Wb-Webapp-Language
```

用 curl 模拟 WebView 预检：

```
OPTIONS /... -H 'Origin: https://localhost' \
  -H 'Access-Control-Request-Headers: authorization,content-type,x-wb-webapp-access-key,x-client-info,x-upsert'
```

响应 204，但 `Access-Control-Allow-Headers` **不含 `x-client-info` 与 `x-upsert`**。

Chromium 严格校验 CORS：预检不通过 → 实际请求不发 → `fetch()` 抛 `TypeError: Failed to fetch`。
Electron 桌面端不做 CORS 同源校验，所以 PC 端不受影响。这同时解释了两个症状：

| 症状 | 失败点 |
| --- | --- |
| 文件列表空 | `cloud.storage.list()` / `download()` 预检失败 → SDK 返回 `{error}` → `loadMeta()` 候选=0（异常被业务 try/catch 吞掉，所以没有 `[list] 失败` 日志） |
| 上传失败 | `uploadFiles()` → `saveMeta()` → `cloud.storage.update/upload()` 预检失败 → 前两步被 catch，第三步抛出 → `REJECTION Failed to fetch` |
| 目录上传也失败 | 同样卡在 `saveMeta()`，尚未进入 `NativeFs` / `webkitdirectory` 相关逻辑 |

## 3. 修复

在 `src/compat.js`（index.html 中最早加载的 classic script，早于 SDK 与 app.js）增加 CORS 兼容层：

- 包装 `window.fetch`，在请求发出前剥离 `x-client-info` 与 `x-upsert` 两个头；
- 仅处理 `init.headers` 场景（SDK 的实际调用形态），复制其余 `init` 字段（`method`/`body`/`signal`/`duplex` 全部保留）；
- 构造 `Headers` 失败时回退原始调用，不阻断业务；
- 幂等标记 `window.__driveCorsFetchPatched`，避免重复包装。

语义安全性：

- `X-Client-Info` 仅 SDK 遥测，无业务语义；
- `x-upsert` 剥离后为默认 false。本项目 `saveMeta()` 优先用 PUT `update()` 覆盖固定键，失败才写带时间戳的唯一版本键；文件分片键由内容确定且「已存在」被视为成功，因此不受影响。

同时在 `app.js` 增加两处诊断日志（`[list-err]`、`[saveMeta-err]`），便于后续在 WebView 中直接看到 SDK 返回的 error，避免再次靠猜。

## 4. 验证结果（全部为实机/实测）

### Web

- `npm run build:web` 通过（作为 Android/Windows 构建的前置步骤）。
- `npm run check` 通过：4 个产物 OK，无硬编码回潮。

### Android（设备 HEW4YTYTWGVC7LHU）

- 安装 `android/app/build/outputs/apk/release/app-release.apk`（`adb install -r` → Success），
  并归集到 `build/android/个人云盘-1.0.0-release-unsigned.apk`（3,271,044 bytes）。
- 清空 logcat → `am force-stop` → 重启（**全程未要求用户重新登录**）：

```
D DriveWeb: [auth] id=2111816543045169152 email=(none) v=v1.0.0
D DriveWeb: [meta] uid=2111816543045169152 候选=2 ver=56 文件=7 文件夹=4
```

- 修复前 `[meta] 候选=0 … 文件=0`，UI 显示「此目录为空」；修复后 UI 显示「离线ai项目」
  等 4 个文件夹，与 PC 端数据一致。
- 上传端到端验证：`上传文件` → 选择上传位置「根目录」→ 选择 1 张约 35KB 截图 →
  弹窗 `上传到「根目录」：共 1 个文件，成功 1，跳过 0（已存在），取消 0，失败 0。`，
  任务状态「完成」，文件立即出现在根目录列表。
- 日志中不再出现 `REJECTION Failed to fetch`，也没有新增 `[list-err]` / `[saveMeta-err]`。

### Windows

- 因 `src/compat.js` 为三端共享源码，`npm run build:win` 已重建：
  setup 121,515,648 bytes、portable 110,571,747 bytes。

### 构建注意

- `npm run build:android` 在本工作区的 `cap sync android` 阶段会命中沙箱批量删除保护
  （`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，目标 `android/capacitor-cordova-android-plugins`，
  1322 个文件）。本次未改动任何原生插件，改用 `cap copy android` + `gradle assembleRelease`
  完成同等方式构建；详见 `docs/BUILD-BLOCKERS.md`。

## 5. 相关文件

- `src/compat.js` — CORS 兼容层（本次修复）
- `app.js` — `[list-err]` / `[saveMeta-err]` 诊断日志（本次）
- `src/boot-error.js` — 未捕获错误/拒绝写入 logcat（前序诊断准备）
- `android/app/src/main/java/com/workbuddy/personaldrive/DriveConsole.java` — Capacitor 日志插件（前序诊断准备）
