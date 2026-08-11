# Windows x64 发布与更新计划

## 范围与当前状态

- 目标架构固定为 `x86_64-pc-windows-msvc`。
- 安装版目标为中英文 NSIS `*-setup.exe`，安装模式保持 `currentUser`。
- 便携版目标为包含 `Cadilume.exe`、便携标记和说明文件的 ZIP。
- 现有 Windows GitHub Actions、`cargo-xwin` 与 PE 链接只能证明构建路径成立；WASAPI、SMTC、Credential Manager、通知区域、WebView2、安装器和便携更新都必须在真实 Windows 10 / 11 x64 会话验收。
- 本文是后续实施计划。本轮未创建 Windows 发布工作流，也未宣称 Windows 制品可发布。

## 安装版

1. 在 `tauri.windows.conf.json` 的 NSIS 配置中加入 `languages: ["English", "SimpChinese"]` 与 `displayLanguageSelector: true`。
2. 新建仅使用 `windows-latest` 的发布工作流，显式安装 `x86_64-pc-windows-msvc`，先执行现有完整 Windows 门禁，再构建 release NSIS。
3. 使用与 macOS 相同的 Tauri updater 私钥生成安装包签名和 `latest.json`，并给 `tauri-action` 设置 `updaterJsonPreferNsis: true`。
4. 公开发行前配置 Windows 代码签名证书；updater 的 minisign 签名只保护更新包来源，不能替代 Authenticode 对下载和安装器信誉的签名。
5. 真机覆盖中文和英文系统语言、语言选择器、全新安装、覆盖升级、卸载、播放中更新、安装完成后的恢复与 Credential Manager 保留行为。

## 便携版

Tauri 不正式支持 portable mode，而且官方 updater 在 Windows 上面向 NSIS/MSI。不能让便携版直接消费 NSIS updater 条目，否则“自动更新”会把便携程序变成安装版。

后续便携更新采用独立通道：

1. CI 对未打包的 release 可执行文件和必要资源生成 `Cadilume_<version>_windows_x64_portable.zip`，ZIP 内放置明确的便携标记。
2. 为 ZIP 生成独立签名和 manifest；应用先验证 manifest 与 ZIP 签名，再下载到同目录的临时位置。
3. 新版本 `Cadilume.exe` 以受限的替换模式启动，等待旧进程退出，原子替换便携目录并重新启动。替换程序使用新版本应用自身，不引入需要用户安装的 sidecar 或外部运行依赖。
4. 替换失败必须保留旧版本和下载包，不能留下半更新目录；跨卷、只读目录、受保护目录、杀毒软件占用和磁盘不足均需明确回退。
5. 在真实 Windows 上验证带空格/中文路径、U 盘或移动盘、非管理员账号、运行中播放、失败恢复与连续跨版本更新后，才开放便携版自动安装。此前便携版最多提供已签名新 ZIP 的检测和手动替换提示。

## 发布门禁

- 标签必须是 `vX.Y.Z`，并与 `package.json`、`tauri.conf.json`、`Cargo.toml` 三处版本一致。
- 同一 GitHub Release 最终包含 NSIS EXE、便携 ZIP、两类签名与覆盖 `windows-x86_64-nsis` 的 `latest.json`；便携 manifest 使用独立文件名，不能覆盖 Tauri 安装版 manifest。
- Windows release job 与 macOS job 分开，避免单平台失败生成不完整的跨平台 `latest.json`。两平台都稳定后，再增加一个汇总 job 合并各平台 manifest 并发布 release。
- 任何“已支持 Windows”的 README 表述都以真实 Windows 验收记录为前提。
