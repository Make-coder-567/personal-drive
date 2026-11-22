# 正式上线执行清单

## 由我可以完成

- [x] Android release keystore 生成与本地安全保存
- [x] 官网直发正式签名 APK 构建脚本
- [x] Windows 官网直发 EXE 构建与签名脚本
- [x] Microsoft Store MSIX 候选包配置
- [x] 商店图标与下载页素材生成
- [x] 隐私政策 / 用户协议 / 商店文案模板
- [x] SHA-256 校验清单生成
- [x] 上线前功能回归测试
- [x] 发布目录与文档结构

## 必须由你完成

- [ ] 确认是否使用 `.env.production` 当前云服务配置作为正式配置；如不是，提供正式 endpoint / publishableKey / siteCode / shareBaseUrl
- [ ] 以个人开发者注册 Microsoft Partner Center，并预留应用名称与 Identity
- [ ] 准备 Windows Authenticode 代码签名证书（官网 EXE 正式签名必需）
- [ ] 准备个人主体信息与联系方式，补全隐私政策、用户协议
- [ ] 部署隐私政策与用户协议到公网 HTTPS URL
- [ ] 准备官网下载页域名与 HTTPS
- [ ] 如在中国大陆分发 Android 应用，完成 APP 备案与域名 ICP 备案
- [ ] 准备软件著作权或版权证明（按渠道要求）
- [ ] 准备审核测试账号
- [ ] 你自己登录各开发者后台完成最终提交与发布

## 发布前最后检查

- [ ] `.env.production` 已填正式值并重建三端
- [ ] Android APK 使用正式 keystore 签名
- [ ] Windows EXE 使用代码签名证书签名
- [ ] MSIX Identity / Publisher 与 Partner Center 完全一致
- [ ] 隐私政策和用户协议链接可访问
- [ ] 下载页显示版本号、大小、SHA-256
- [ ] 测试账号可登录并看到测试数据
- [ ] 上传、下载、分享、移动、删除全部通过
- [ ] 清理云端测试文件
- [ ] 备份 Android keystore 与所有签名证书

## 发布后维护

- [ ] 记录每个渠道发布的版本号、commit、SHA-256
- [ ] 监控登录失败、上传失败、下载失败、分享 401/403
- [ ] 证书到期前续期
- [ ] 每次更新递增 Android versionCode 和 Windows 版本
- [ ] 后端 CORS、域名、证书变更时同步回归三端
