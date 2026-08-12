# Cadilume 发布指南

## 三套独立信任

Cadilume 发布同时使用三套用途不同的凭据，不能相互替代：

1. GitHub SSH key 或 Actions 的 `GITHUB_TOKEN` 负责向仓库推送代码、标签和 Release 资产。
2. Tauri updater minisign 私钥负责给更新包生成 `.sig`；应用内置对应公钥，在下载安装前验证更新包。GitHub 只托管更新包、签名和 `latest.json`，不会参与这次密码学验证。
3. Apple Developer ID 或 Windows Authenticode 证书负责操作系统层面的开发者身份、下载信誉和安装信任。updater 签名不能替代平台代码签名或 macOS 公证。

## Updater 密钥

- 公钥提交在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`，进入每一个发行应用。
- 私钥只能保存在维护者的安全备份和 GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` 中。
- 私钥口令保存为 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，不能写入仓库、构建日志或 Release。
- CI 构建时用私钥签出 `.sig`，`tauri-action` 将签名内容写入 `latest.json`；已安装应用用内置公钥验证。公私钥能够完成签名/验证即为匹配，不需要在 GitHub 账号设置中再登记这把 updater 公钥。

这把私钥必须做离线加密备份。普通换机不能生成一把新密钥替代：旧版本只信任旧公钥，无法安装新密钥签出的更新。若计划轮换，必须先用旧私钥发布一个内置新信任策略的桥接版本，并为未经过桥接版本的用户保留明确迁移路径；私钥疑似泄露时应停止自动更新并要求用户从可信渠道手动安装，而不是无提示换钥。

## macOS 工作流

`.github/workflows/release-macos.yml` 只接受手动触发，有两种模式：

- 默认不勾选发布：构建 macOS arm64 DMG 与 updater artifacts，只保存为 workflow artifacts，不创建公开 Release。
- 每次运行都填写稳定版本，例如 `0.2.0`；`v0.2.0` 与 `V0.2.0` 也会规范化为应用版本 `0.2.0` 和标签 `v0.2.0`。工作流在构建前同步 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 与 `src-tauri/Cargo.lock`。
- 明确勾选发布：只允许从 `main` 执行。验证通过后自动创建并推送 `release: vX.Y.Z` 提交；`dev` 仍与发布基线一致时一并快进。随后在该提交上创建草稿 Release，上传 DMG、`.app.tar.gz`、`.sig` 与 `latest.json`，确认四类资产齐全后才公开。仓库启用不可变 Release，公开动作会同时冻结关联标签与资产。

普通 push、分支合并和单独推送标签都不会触发 Release 构建。

当前 release 配置使用 ad-hoc 签名，适合验证构建和 Tauri updater 签名链，但不构成面向普通用户的 Gatekeeper 信任。生产发布还需要在 CI 导入 Developer ID Application 证书，并完成 hardened runtime、公证与 stapling。

## 发布步骤

1. 将准备发布的功能提交合并到 `main` 并推送 GitHub；无需手工修改应用版本，也无需提前创建标签。
2. 可先在 `main` 手动运行 `Release macOS`，填写目标版本但不勾选发布，下载并检查 workflow artifacts；此模式只在构建工作区临时应用版本，不创建 release 提交。
3. 正式发布时再次从 `main` 手动运行工作流，填写同一版本并勾选发布。工作流负责同步版本、运行完整门禁、创建 release 提交，把所有资产上传到草稿并校验，再公开规范标签和不可变 Release。
4. 确认公开 Release 含 DMG、updater archive、`.sig` 和 `latest.json`，并从上一发行版实测检查、下载、安装和重启。

不要从非标签构建手工拼装 `latest.json`，也不要把私钥、私钥口令或 Apple 证书导出文件加入 Release 资产。不可变 Release 一旦公开就不能补传、替换或删除单个资产；如果草稿阶段校验失败，应保留为草稿修复，不能先公开再补文件。
