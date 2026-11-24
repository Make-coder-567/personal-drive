# 个人云盘 1.0.0 发布说明

## 版本信息

- 版本号：1.0.0
- Android versionCode：1
- Windows 包版本：1.0.0.0（AppX）
- 构建时间：2026-11-24

## 功能

- 邮箱登录、注册、找回密码；
- 文件与文件夹管理；
- 文件上传、分片续传、文件夹上传；
- 文件下载、文件夹 ZIP 下载；
- 在线预览图片、PDF、文本；
- 公开分享链接；
- Android 原生文件保存；
- Windows 原生窗口与流式写盘。

## 本次修复

- 修复 Android WebView CORS 预检导致的旧文件不可见与上传失败；
- 修复 Android 启动白屏与空错误浮层；
- 修复 Windows 构建目录占用导致的 EPERM；
- 恢复三端「反馈」功能（提交、收件箱、邮件直发、Webhook 通知）；
- Android 返回键改为目录逐级回退，根目录弹确认框；
- 下载站新增「使用网页版」入口、安装包链接内容指纹与 SHA-256 自动注入；
- 完成三端统一配置注入与发布工程。

## 当前产物状态

| 产物 | 签名状态 | 用途 |
|---|---|---|
| `release/android/个人云盘-1.0.0-release.apk` | 正式 release keystore 签名 | 官网直发可用 |
| `release/android/personal-drive-1.0.0-release.aab` | 正式 release keystore 签名 | 备用，可后续转 Google Play |
| `release/windows/个人云盘-1.0.0-win-x64-setup-unsigned.exe` | 未签名 | 内部测试；官网正式分发需重签 |
| `release/windows/个人云盘-1.0.0-win-x64-portable-unsigned.exe` | 未签名 | 内部测试；官网正式分发需重签 |
| `release/windows/store/个人云盘-1.0.0-store-candidate.appx` | 未签名、Identity 占位 | Microsoft Store 候选；需替换身份后重建 |

## 校验值

```text
abeca16798f3ea1974c83fdf54e26a7ce497e5a52d118fc0dd5f0a298b05a2e4  release/android/个人云盘-1.0.0-release.apk
62c25337343d00c3b470a39c6a37a735e51d48e475ab3053ae59a0e15145b09e  release/android/personal-drive-1.0.0-release.aab
f91dd650a51ce60d1b1e8a0c2f49c4577e960760f4c98e2dd360c2cc4b66767c  release/windows/个人云盘-1.0.0-win-x64-setup-unsigned.exe
9e863ce35ceaf115ce8f3a9a9c95e658825b909c6b7a835e4d71de3e9842a224  release/windows/个人云盘-1.0.0-win-x64-portable-unsigned.exe
9808da221a897ab4b419bfea71999ba259ea7cb10418869868c2e5d081dd432e  release/windows/store/个人云盘-1.0.0-store-candidate.appx
```
