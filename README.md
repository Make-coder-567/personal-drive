# 个人云盘（Personal Drive）

一套 Web 内核（原生 HTML/CSS/JavaScript，classic script / IIFE）输出到 **Web / Android（Capacitor）/ Windows（Electron）** 三端的个人网盘。支持账号登录、文件管理、分片并发上传、在线预览、分享链接下载与流式落盘。

> 本项目由个人学习与使用需求驱动，代码仅供学习和二次开发参考。生产环境部署前请完成环境变量注入与签名材料配置。

## 功能特性

- **账号体系**：邮箱登录、注册（验证码）、退出、忘记密码与密码重置。
- **文件管理**：文件夹创建/删除、文件重命名、移动、删除，元数据版本化存储。
- **上传**：大文件自动分片、自适应并发池、断点续传、进度与速度显示。
- **下载**：浏览器 File System Access API 边下边写；原生端走 `NativeFs` 流式落盘；Web 回退 Service Worker + `ReadableStream`（`/__dl__/<token>`）。
- **公开分享**：生成分享链接；接收端无需登录即可查看和下载文件。
- **加速器**：直连签名 URL、分片并发、失败重试与统一任务面板。
- **诊断工具**：内置存储链路诊断与公开链接探测。

## 技术栈与构建

- Web 内核：原生 HTML / CSS / JavaScript（**有构建步骤**，Vite 5 + esbuild 预处理 vendor）
- 云服务：[WorkBuddy Cloud SDK](https://www.npmjs.com/package/@tencent-ai/workbuddy-cloud-sdk)（固定版本 `0.1.4`，本地 vendor + CDN 回退）
- 打包：Capacitor 8（Android）、Electron 31 + electron-builder（Windows x64）
- 依赖本地化：`public/vendor/workbuddy-cloud-sdk.js`、`public/vendor/client-zip.global.js`（后者暴露 `window.clientZip.downloadZip`）

## 快速开始

```bash
npm install
cp .env.example .env.development   # 按需填写，仅开发使用
npm run dev                        # gen-config → vendor → vite dev server
```

浏览器打开 `http://localhost:5173`。Service Worker 需要安全上下文，`localhost` 可用。

## 环境变量

`.env.[mode]` 由 `scripts/gen-config.mjs` 读取并生成 `public/__config__.js`（`window.__DRIVE_CONFIG__`）。运行时还可用 `window.__DRIVE_CONFIG_RUNTIME__` 覆盖（原生宿主注入）。

| 变量 | 说明 |
| --- | --- |
| `VITE_ENDPOINT` | 后端 API 地址 |
| `VITE_OAUTH_RELAY_BASE_URL` | OAuth 中继地址 |
| `VITE_PUBLISHABLE_KEY` | 云服务 publishableKey（生产由 CI 注入） |
| `VITE_DEFAULT_SITE_CODE` | 默认站点访问码（分享链接 `sharecode`） |
| `VITE_SHARE_BASE_URL` | 公开分享落地页基址，缺省 `location.origin` |
| `VITE_SW_URL` | Service Worker 地址，默认 `./sw.js` |
| `VITE_DL_PREFIX` | SW 下载拦截前缀，默认 `/__dl__/` |
| `VITE_PLATFORM` | `web` / `electron` / `android` |
| `VITE_CHUNK_MB` / `VITE_UPLOAD_CONC` | 上传分片大小与并发 |
| `VITE_CSP_*` | CSP 白名单来源 |

`package.json` 的 `version` 是三端唯一版本源（当前 `1.0.0`）。`.env.example` 只有占位值，真实密钥不得入库。

## 构建命令与产物

| 命令 | 产物 |
| --- | --- |
| `npm run gen:config` | `public/__config__.js` |
| `npm run vendor` | `public/vendor/*` |
| `npm run build:web` | `dist/`（含 `index.html`、`__config__.js`、`vendor/`） |
| `npm run build:android` | `build/android/*.apk`（需本机 Android SDK/JDK 与 `cap add android` 生成的工程） |
| `npm run build:win` | `build/windows/*.exe`（NSIS x64 + portable，需 Electron 二进制） |
| `npm run build:all` | Web + Android + Windows 全量构建 |
| `npm run check` | 校验 Web 产物齐备与源码无硬编码密钥/域名/站点码 |

Android 与 Windows 构建依赖本机工具链；缺失时脚本会明确报错，不会生成伪造的 APK/EXE。无 release keystore / 代码签名证书时只能产出内部测试包（Android debug 签名、Windows 未签名），正式分发前必须补齐签名材料。

## 目录结构

```
.
├── index.html                    # DOM 与脚本加载顺序（无内联业务脚本）
├── app.js / accel.js             # 业务内核与加速器（IIFE / classic script）
├── sw.js / style.css             # 流式下载 SW 与响应式样式
├── src/
│   ├── asset-code.js             # 访问码透传（原 index.html 内联提取）
│   ├── share-receive.js          # 公开接收页逻辑（原 index.html 内联提取）
│   ├── config/runtime-config.js  # 配置合并门面
│   └── platform/                 # NativeFs 端口与三端适配器
├── scripts/                      # gen-config / vendor / build-all / check
├── docs/                         # PRD 与架构设计
└── public/                       # 构建期生成的配置与 vendor（gitignore）
```

## 安全提示

- 分享链接包含签名下载 URL，请谨慎转发；过期前任何拿到链接的人都可下载。
- 站点访问码（`sharecode`）由部署环境提供；生产环境的 `publishableKey` 必须由 CI 注入，禁止提交到仓库。
- 正式发布前确认后端来源白名单包含 Web 域名、`capacitor://localhost` / `http://localhost` 与 Electron 的 `file://` 来源。
- 正式分发需要 Android release keystore 与 Windows 代码签名证书；未签名安装包会触发系统安全警告。

## 许可证

MIT License
