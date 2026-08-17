# Cadilume 发布指南

## 三套独立信任

Cadilume 发布同时使用三套用途不同的凭据，不能相互替代：

1. 维护者使用 GitHub SSH key 推送已准备好的代码与版本文件；Actions 的 `GITHUB_TOKEN` 只负责创建发布标签和管理 Release 资产，不改写或推送源代码。
2. Tauri updater minisign 私钥负责给更新包生成 `.sig`；应用内置对应公钥，在下载安装前验证更新包。GitHub 只托管更新包、签名和 `latest.json`，不会参与这次密码学验证。
3. Apple Developer ID 或 Windows Authenticode 证书负责操作系统层面的开发者身份、下载信誉和安装信任。updater 签名不能替代平台代码签名或 macOS 公证。

## Updater 密钥

- 公钥提交在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`，进入每一个发行应用。
- 私钥只能保存在维护者的安全备份和 GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` 中。
- 私钥口令保存为 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，不能写入仓库、构建日志或 Release。
- CI 的 macOS 与 Windows job 使用同一私钥分别生成 `.sig`，发布 job 再从两个已验证制品生成唯一的 `latest.json`；已安装应用用内置公钥验证。公私钥能够完成签名/验证即为匹配，不需要在 GitHub 账号设置中再登记这把 updater 公钥。

这把私钥必须做离线加密备份。普通换机不能生成一把新密钥替代：旧版本只信任旧公钥，无法安装新密钥签出的更新。若计划轮换，必须先用旧私钥发布一个内置新信任策略的桥接版本，并为未经过桥接版本的用户保留明确迁移路径；私钥疑似泄露时应停止自动更新并要求用户从可信渠道手动安装，而不是无提示换钥。

## 双平台统一工作流

`.github/workflows/build-desktop.yml` 只接受手动触发，并行运行 macOS arm64 与 Windows x64，有两种模式：

- 默认不勾选发布：构建 macOS `.app` / DMG、macOS updater 归档与签名，以及兼作 Windows updater 载荷的 NSIS `.exe` 与 `.exe.sig`；只保存为 workflow artifacts，不创建公开 Release。
- 每次运行都填写稳定版本，例如 `0.2.2`；`v0.2.2` 与 `V0.2.2` 也会规范化为应用版本 `0.2.2` 和标签 `v0.2.2`。该输入只用于只读校验，必须与仓库中已提交的 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `src-tauri/Cargo.lock` 完全一致；工作流不修改任何版本文件。
- 明确勾选发布：只允许从 `main` 执行，而且 macOS 与 Windows 必须全部成功。工作流确认本次构建提交仍是远端最新 `main` 后，直接以该已验证的源提交创建草稿 Release，上传 DMG、macOS updater 归档与签名、Windows NSIS 与签名，并生成同时含 `darwin-aarch64` 与 `windows-x86_64-nsis` 的 `latest.json`。这五个二进制/签名文件与 `latest.json` 共六个 Release 资产全部校验后才公开；仓库启用不可变 Release，公开动作会同时冻结关联标签与资产。工作流不会创建 release commit，也不会推送 `main` 或 `dev`。

普通 push、分支合并和单独推送标签都不会触发 Release 构建。

当前 macOS release 配置使用 ad-hoc 签名，Windows NSIS 也没有 Authenticode 签名；它们适合验证构建和 Tauri updater 签名链，但不构成操作系统层面的发布信任。生产发布还需要在 CI 导入 Developer ID Application 证书并完成 hardened runtime、公证与 stapling，同时为 Windows 安装器配置 Authenticode 证书与可信时间戳。

## 发布步骤

1. 人工把目标稳定版本同步到 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `src-tauri/Cargo.lock` 中的 Cadilume 包条目，运行 `pnpm verify:release-version`，然后把四份版本修改与准备发布的功能一起提交、合并到 `main` 并推送 GitHub；无需提前创建标签。
2. 可先在 `main` 手动运行 `Build desktop`，填写已提交的版本但不勾选发布，下载并检查 macOS 与 Windows workflow artifacts；版本不一致时工作流直接失败，不会自动修正。
3. 正式发布时再次从 `main` 手动运行工作流，填写同一版本并勾选发布。工作流运行完整门禁，把已验证源提交的所有资产上传到草稿并校验，再公开规范标签和不可变 Release；不会产生额外版本提交。
4. 确认公开 Release 含 DMG、macOS updater 归档与签名、兼作 Windows updater 载荷的 NSIS 与签名、`latest.json`；分别从上一发行版实测检查、下载、安装和重启。

不要从未经统一工作流验证的构建手工拼装 `latest.json`，也不要把私钥、私钥口令或 Apple 证书导出文件加入 Release 资产。不可变 Release 一旦公开就不能补传、替换或删除单个资产；如果草稿阶段因临时上传或校验问题失败，可从该草稿对应的同一已验证源提交重新运行同一版本，工作流会复用草稿并替换同名资产。草稿指向不同提交时工作流会停止，不能混用制品，也不能先公开再补文件。
