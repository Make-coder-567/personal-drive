# 签名材料与环境变量

## Android（官网直发 APK）

本项目已生成 Android release keystore：

```text
release/secrets/personal-drive-release.jks
release/secrets/android-release.env
```

`android-release.env` 包含：

```text
ANDROID_KEYSTORE
ANDROID_KEYSTORE_PASSWORD
ANDROID_KEY_ALIAS
ANDROID_KEY_PASSWORD
```

正式构建：

```bash
npm run release:android
```

输出：

```text
release/android/个人云盘-1.0.0-release.apk
```

务必离线备份 keystore 与口令；不要只依赖当前电脑。

## Windows 官网直发

官网 EXE 需要 Authenticode 代码签名证书（`.pfx/.p12`）。构建前设置：

PowerShell：

```powershell
$env:CSC_LINK = "C:\path\to\personal-drive.pfx"
$env:CSC_KEY_PASSWORD = "证书密码"
npm run release:windows
```

设置证书后输出不带 `-unsigned`：

```text
release/windows/个人云盘-1.0.0-win-x64-setup.exe
release/windows/个人云盘-1.0.0-win-x64-portable.exe
```

未设置证书时输出：

```text
release/windows/个人云盘-1.0.0-win-x64-setup-unsigned.exe
release/windows/个人云盘-1.0.0-win-x64-portable-unsigned.exe
```

## Microsoft Store / AppX 候选

当前锁定的 electron-builder 26.18.0 尚未提供 `msix` 配置键；本项目使用 Microsoft Store 同样接受的 AppX/同清单格式作为候选包。

Microsoft Store 会在认证时重新签名；你仍然必须让 AppX manifest 的 Identity 与 Partner Center 预留信息一致。

在 `electron-builder.appx.yml` 中替换：

```yaml
appx:
  identityName: <Partner Center Identity Name>
  publisher: <Partner Center Publisher>
  publisherDisplayName: <Partner Center Publisher display name>
```

然后构建：

```bash
npm run gen:store-assets
npx electron-builder --win appx -c electron-builder.appx.yml
```

输出候选：

```text
release/windows/store/
```
