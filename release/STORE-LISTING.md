# 商店文案与素材清单

## 应用基础信息

| 项 | 内容 |
|---|---|
| 应用名称 | 个人云盘 |
| 版本 | 1.0.0 |
| 包名 | com.workbuddy.personaldrive |
| 分类 | 工具 / 效率 |
| 一句话简介 | 上传、管理、下载与分享文件的个人云盘 |
| 关键词 | 网盘, 文件管理, 文件备份, 分享, 上传下载 |

## 简短描述（80 字内）

个人云盘帮助你上传、备份、管理、下载和分享文件，支持文件夹、断点续传、在线预览与移动端原生保存。

## 完整描述

个人云盘是一款跨平台文件管理工具，支持：

- 邮箱登录、注册与密码找回；
- 文件夹创建、重命名、移动、删除；
- 文件与文件夹上传，分片传输与断点续传；
- 多分片下载、文件夹打包下载；
- 在线预览图片、PDF 与文本；
- 生成带有效期的公开分享链接；
- Android 原生文件保存能力；
- Windows 原生窗口与流式落盘。

你的文件按账号隔离存储，传输使用 HTTPS，分享链接带有效期。请谨慎转发分享链接，并不要上传违法违规内容。

## 新版本说明

1.0.0 首次发布：

- 完成 Web / Android / Windows 三端统一内核；
- 修复 Android WebView 文件不可见与上传失败问题；
- 增加移动端错误诊断与启动保护；
- 完成三端构建、签名与发布工程。

## 所需素材

```text
release/assets/icon-192.png                  Android / 网页图标
release/assets/icon-512.png                  Android / 官网图标
release/assets/StoreLogo.png                 Microsoft Store 50x50
release/assets/Square44x44Logo.png           Microsoft Store 44x44
release/assets/Square150x150Logo.png         Microsoft Store 150x150
release/assets/Wide310x150Logo.png           Microsoft Store 310x150
release/assets/SplashScreen.png              Microsoft Store 620x300
docs/qa-mobile-regression.png                Android 实机截图
docs/qa-folder-open.png                      Android 文件夹截图
docs/qa-up-result.png                        上传结果截图
```

需补充：

- Windows 桌面端实际截图 1280×720 或更高；
- Android 手机截图若干；
- 应用宣传图；
- 用户协议与隐私政策公网 URL；
- 支持邮箱。

## 审核说明模板

本应用为文件管理工具。登录后可上传、下载、管理与分享用户自己的文件。分享功能由用户主动触发，链接带有效期。应用不主动抓取通讯录、短信、位置或相册，不进行用户画像或广告推送。

审核测试账号：

```text
邮箱：____
密码：____
```

请审核人员重点测试：登录、上传文件、下载文件、文件夹浏览、生成分享链接。
