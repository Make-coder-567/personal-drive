# 个人云盘（Personal Drive）

一个基于浏览器与云存储的纯前端个人网盘。支持账号登录、文件管理、分片并发上传、在线预览、分享链接下载等能力，可直接作为静态站点部署。

> 本项目由个人学习与使用需求驱动，代码仅供学习和二次开发参考。

## 功能特性

- **账号体系**：邮箱登录、注册（验证码）、退出、忘记密码与密码重置。
- **文件管理**：文件夹创建/删除、文件重命名、移动、删除，元数据版本化存储。
- **上传**：大文件自动分片、自适应并发池、断点续传、进度与速度显示。
- **下载**：普通下载与多分片合并下载；移动端自动降低并发阈值。
- **公开分享**：生成分享链接；接收端无需登录即可查看和下载文件。
- **大文件流式下载**：通过 Service Worker 拦截 `/__dl__/<token>`，使用 `ReadableStream` 直连浏览器原生下载管理器，避免大文件占用 JS 内存。
- **兼容性**：CDN 多源回退加载云 SDK；支持微信内置浏览器等丢失 Cookie 的场景（访问码透传）。
- **诊断工具**：内置存储链路诊断与公开链接探测，便于排查鉴权/签名问题。

## 技术栈

- 原生 HTML / CSS / JavaScript（无构建步骤）
- [WorkBuddy Cloud SDK](https://www.npmjs.com/package/@tencent-ai/workbuddy-cloud-sdk)：认证与对象存储
- Service Worker + ReadableStream：分片流式下载
- client-zip：浏览器端打包

## 目录结构

```
.
├── index.html                     # 页面结构、分享接收页、SDK 加载与回退
├── style.css                      # 样式
├── app.js                         # 登录、文件管理、上传下载、分享、诊断等主逻辑
├── accel.js                       # 下载加速与 Service Worker 桥接
├── sw.js                          # 流式下载 Service Worker
├── 小程序双形态上线计划与兼容性评估.md  # 小程序形态迁移评估文档
└── README.md
```

## 本地运行

1. 准备一个可用的 WorkBuddy 云服务应用，并在 `index.html` 中接入对应 SDK 与配置。
2. 使用任意静态服务器托管本目录（Service Worker 需要安全上下文，`localhost` 可用）：

   ```bash
   python -m http.server 8080
   ```

3. 浏览器打开 `http://localhost:8080`。

> 说明：项目使用 `@tencent-ai/workbuddy-cloud-sdk@dev` 提供认证与存储能力。使用前请按你自己的云服务配置替换相关参数；本项目不包含任何账号、令牌或访问码。

## 安全提示

- 分享链接中包含签名下载 URL，请谨慎转发，过期前任何拿到链接的人都可以下载。
- 站点访问码（`sharecode`）由部署环境提供，源码中默认为空，请自行配置。
- 不要将云服务密钥、访问码或个人令牌提交到仓库。

## 许可证

MIT License
