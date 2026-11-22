# GitHub Pages 部署目录

本目录只含静态页面，可直接发布到 GitHub Pages。Windows 大安装包由 GitHub Releases 托管。

## 部署方式一：main 分支 /docs 目录

1. 将本目录内所有文件（包含 `.nojekyll`）复制到仓库 `docs/` 目录。
2. 提交并推送到 GitHub。
3. 仓库设置 → Pages → Source 选择 `main / docs` → Save。
4. 访问：https://make-coder-567.github.io/personal-drive/

## 部署方式二：gh-pages 分支根目录

1. 新建 `gh-pages` 分支。
2. 将本目录内所有文件复制到分支根目录。
3. 推送到 GitHub。
4. 仓库设置 → Pages → Source 选择 `gh-pages / root` → Save。
5. 访问：https://make-coder-567.github.io/personal-drive/

## 创建 GitHub Release

在仓库 Releases 页面创建 tag `v1.0.0`，并上传以下资产：

- `个人云盘-1.0.0-release.apk`
- `个人云盘-1.0.0-win-x64-setup-unsigned.exe`
- `个人云盘-1.0.0-win-x64-portable-unsigned.exe`

文件名必须与下载页中的链接完全一致。

## 自定义域名（可选）

在仓库根目录添加 `CNAME` 文件，内容为你自己的域名，例如：

```text
download.example.com
```

再到 DNS 服务商添加 CNAME 记录指向 `make-coder-567.github.io`，并在 Pages 设置中启用 HTTPS。
