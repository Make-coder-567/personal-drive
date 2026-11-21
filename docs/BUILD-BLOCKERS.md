# 原生构建阻塞记录（Android）

> 记录时间：2026-11-21 ｜ 执行人：工程师 寇豆码（Kou）
> **更新（同日）：已通过项目内 `.toolchain/` 自举 JDK 21 + Android SDK 36 + Gradle 8.14.3，成功产出 debug 签名 APK：**
> `build/android/个人云盘-1.0.0-release-unsigned.apk`（3,266,354 bytes）。
> 下方原始阻塞记录保留作为环境诊断依据；若 `.toolchain/` 被清理，需按第三节命令重新自举。

## 〇、自举结果（后续追加）

| 步骤 | 结果 | 落地路径 |
| --- | --- | --- |
| Temurin JDK 21 ZIP（Adoptium API，PowerShell 系统证书下载） | 成功 | `.toolchain/jdk21`（java/javac 21.0.13.1 LTS） |
| Android commandline-tools Windows ZIP | 成功 | `.toolchain/android-cmdline-tools/cmdline-tools/latest/bin/sdkmanager.bat` |
| SDK licenses + `platform-tools`、`platforms;android-36`、`build-tools;36.0.0` | 成功（sdkmanager exit 0） | `.toolchain/android-sdk` |
| Gradle 8.14.3 binary-only ZIP | 成功 | `.toolchain/gradle-8.14.3` |
| 临时 JAVA_HOME/ANDROID_HOME/GRADLE_USER_HOME 后执行 `assembleRelease` | **BUILD SUCCESSFUL（4m1s，124 tasks，exit 0）** | `android/app/build/outputs/apk/release/app-release.apk` |
| 产物收集 | 成功 | `build/android/个人云盘-1.0.0-release-unsigned.apk` |

自举期间额外遇到并已解决：
1. `sdkmanager --licenses` 通过 PowerShell 管道输入 `y` 会卡在交互提示（等待超过 10 分钟）；改为在 `.toolchain/android-sdk/licenses/` 写入已接受许可的标准 hash 文件（android-sdk-license / android-sdk-preview-license）后，`sdkmanager install` 正常完成（exit 0）。
2. AGP 拒绝含中文的项目路径：`Your project path contains non-ASCII characters ... This warning can be disabled by adding the line 'android.overridePathCheck=true' to gradle.properties`。已在 `android/gradle.properties` 添加 `android.overridePathCheck=true`（AGP 官方覆盖项，构建时提示 experimental 但可正常出包）。
3. Gradle 构建自动补齐了 `build-tools;35.0.0`（Capacitor 子项目需要），许可文件已覆盖该包。
4. 无 `ANDROID_KEYSTORE`，`android/app/build.gradle` 按既定逻辑降级 debug 签名，因此文件名标注 `-unsigned`，仅可用于内部测试，不可上架。

原 `npm run build:android` 仍会失败，因为脚本走系统 JBR + Gradle Wrapper（PKIX 与 Java 25 不兼容）；本次成功路径是**项目内临时环境自举**，未修改系统全局配置。

## 一、已完成的验证（历史记录）

1. `npx cap add android` 成功（Capacitor CLI 8.6.2），生成了完整 Android 工程：
   - `android/app/src/main/java/com/workbuddy/personaldrive/{MainActivity,NativeFsPlugin,NativeFsWriter}.java`
   - `android/app/build.gradle`（minSdk 26 / targetSdk 36 / compileSdk 36 / versionName 1.0.0 / 环境签名）
   - `android/variables.gradle`（minSdkVersion 26）、`android/build.gradle`（AGP 8.13.0）
   - `android/app/src/main/AndroidManifest.xml`（INTERNET / ACCESS_NETWORK_STATE / usesCleartextTraffic=false / 显式 exported）
   - Gradle wrapper 8.14.3、资源与 `dist/` 同步后的 Web 内核
2. `npm run build:android` 实际执行到 Gradle 阶段后失败，退出码 1（见下方日志要点）。
3. `android/app/build/outputs/apk/release/` 不存在，故 `scripts/collect-artifacts.mjs` 未复制任何 APK；`build/android/` 下没有产物。

## 二、阻塞项（按出现顺序）

### 阻塞 1：Gradle Wrapper 发行版下载失败（SSL 证书链）

`npm run build:android` 原始日志要点：

```
[build-all] android assembleRelease
Downloading https://services.gradle.org/distributions/gradle-8.14.3-all.zip

Exception in thread "main" javax.net.ssl.SSLHandshakeException: (certificate_unknown)
 PKIX path building failed: sun.security.provider.certpath.SunCertPathBuilderException:
 unable to find valid certification path to requested target
    at org.gradle.wrapper.Install.forceFetch(...)
    at org.gradle.wrapper.GradleWrapperMain.main(...)
[build-all] 构建失败：android assembleRelease 失败（exit 1）
```

原因：当前 `JAVA_HOME=D:\Dev\DevEco Studio\jbr`（JBR 25）的信任库缺少代理/网关 CA，Gradle Wrapper 无法通过 HTTPS 拉取 8.14.3 发行版。

### 阻塞 2：本机 JDK 版本与 Gradle/AGP 不兼容

改用本机已缓存的 Gradle 8.13（`~/.gradle/wrapper/dists/gradle-8.13-bin/...`）直接执行 `assembleRelease`，绕过下载后得到：

```
WARNING: A restricted method in java.lang.System has been called ...
FAILURE: Build failed with an exception.
* What went wrong:
BUG! exception in phase 'semantic analysis' in source unit '_BuildScript_'
Unsupported class file major version 69
BUILD FAILED in 12s
```

class file major version 69 = Java 25。Gradle 8.13/8.14 与 AGP 8.13 不支持 Java 25 编译构建脚本。需要 JDK 17 或 JDK 21。

### 阻塞 3：Android SDK 完全缺失

- `ANDROID_HOME` / `ANDROID_SDK_ROOT` 均为空；
- `C:\Users\mrhua\AppData\Local\Android\Sdk`、`C:\Program Files\Android\Android Studio\sdk`、`C:\Android\Sdk`、`D:\Android\Sdk` 均不存在；
- `adb`、`sdkmanager`、`gradle` 均不在 PATH；
- 因此即使修复 JDK 与 Gradle 下载，仍会因缺少 `android.jar`（platform 36）、build-tools 36、platform-tools 而失败。

## 三、可执行的修复建议（在有网络的开发/CI 机器上）

1. 安装 JDK 21（或 17），设置 `JAVA_HOME` 指向该 JDK，并把 `%JAVA_HOME%\bin` 加入 PATH。
2. 安装 Android SDK Platform 36 与 Build Tools 36：

   ```bash
   # 用 Android Studio SDK Manager，或命令行：
   sdkmanager --install "platforms;android-36" "build-tools;36.0.0" "platform-tools"
   ```

   设置 `ANDROID_HOME=<sdk 根目录>`，并接受 licenses：

   ```bash
   sdkmanager --licenses
   ```

3. 修复 Gradle 发行版下载：在可联网环境预置 `~/.gradle/wrapper/dists/gradle-8.14.3-all`，或让 JDK 信任企业代理 CA（把 CA 导入 JRE cacerts）；也可临时在 `android/gradle/wrapper/gradle-wrapper.properties` 中改用本地已缓存的 `gradle-8.13-bin` 发行版（需与 AGP 兼容）。
4. 配置 release 签名环境变量后重新构建：

   ```bash
   export ANDROID_KEYSTORE=/path/to/release.jks
   export ANDROID_KEYSTORE_PASSWORD=...
   export ANDROID_KEY_ALIAS=...
   export ANDROID_KEY_PASSWORD=...
   npm run build:android
   ```

   有 keystore → `build/android/个人云盘-1.0.0-release.apk`；
   无 keystore → debug 签名降级 → `build/android/个人云盘-1.0.0-release-unsigned.apk`（仅内部测试，不可上架）。

## 四、产物状态

| 预期产物 | 实际状态 |
| --- | --- |
| `build/android/个人云盘-1.0.0-release.apk` | **未生成**（无 release keystore，无法正式签名上架） |
| `build/android/个人云盘-1.0.0-release-unsigned.apk` | **已生成**，3,266,354 bytes（debug 签名，仅内部测试） |

原阻塞已通过项目内自举解决；未实际生成的正式签名 APK 不以“成功”表述。
