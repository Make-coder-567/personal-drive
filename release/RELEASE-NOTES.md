# 个人云盘 1.0.0 发布说明

## 版本信息

- 版本号：1.0.0
- Android versionCode：1
- Windows 包版本：1.0.0.0（AppX）
- 构建时间：2026-11-22

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
c72c837c76cef133dd4d1fc2c7f976de5346a37578fca9c5cd154beacca029bd  release/android/个人云盘-1.0.0-release.apk
bf3591af2f0fdccf1e8de46503e6ff41182cfdfce39a0819b133ee9e837f2cb0  release/android/personal-drive-1.0.0-release.aab
b6880a0d304020df31c4d375df12548d8b35e21134acc17c1399c22aa6421921  release/windows/个人云盘-1.0.0-win-x64-setup-unsigned.exe
92e8202045123fe8cf32cbaf90f0d30141615af35b93190e066e46a0cee134f5  release/windows/个人云盘-1.0.0-win-x64-portable-unsigned.exe
9808da221a897ab4b419bfea71999ba259ea7cb10418869868c2e5d081dd432e  release/windows/store/个人云盘-1.0.0-store-candidate.appx
```
