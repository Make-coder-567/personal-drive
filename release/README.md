# 个人云盘发布包

本目录用于官网直发与 Microsoft Store 提交的发布候选物。版本号由 `package.json` 的 `version` 派生，当前为 `1.0.0`。

## 目录

```text
release/
├── android/                 # 官网直发 APK（正式签名）/ AAB（备用）
├── windows/                 # 官网直发 NSIS / portable；store/ 放 MSIX 候选
├── assets/                  # 商店图标与下载页素材
├── download/                # 可直接部署的官网下载页
├── secrets/                 # 本地签名凭据，已被 .gitignore 排除
├── PRIVACY-POLICY.md        # 隐私政策模板（需填写主体信息）
├── TERMS-OF-USE.md          # 用户协议模板（需填写主体信息）
├── STORE-LISTING.md         # 商店文案与素材清单
├── SIGNING.md               # 签名材料与环境变量说明
└── CHECKLIST.md             # 上线前执行清单
```

## 构建命令

```bash
npm run release:android     # 生成 release/android/个人云盘-1.0.0-release.apk
npm run release:windows     # 生成 release/windows/ 官网候选包与 MSIX 候选
```

## 重要说明

- `release/secrets/` 中的 keystore 和口令文件**不得提交到 Git**。
- Android release keystore 一旦丢失，将无法为同一包名发布更新，请离线备份。
- Windows 未配置代码签名证书时会生成 `-unsigned` 包，仅适合内部测试；官网正式分发必须重新以证书构建。
- MSIX 候选包中的 Publisher / Identity 是占位值，提交 Microsoft Store 前必须替换为你 Partner Center 的实际身份。
- `.env.production` 当前仍为演示云服务配置；正式发布前需替换为你的生产配置。
