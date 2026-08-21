# Windows x64 发布与更新状态

## 范围与当前状态

- 目标架构固定为 `x86_64-pc-windows-msvc`。
- 安装版目标为中英文 NSIS `*-setup.exe`，安装模式保持 `currentUser`。
- 安装版已接入统一 `.github/workflows/build-desktop.yml`：Windows job 与 macOS job 独立并行构建，汇总 job 只在两端成功后生成跨平台 `latest.json` 并发布。
- NSIS 已启用 `English` / `SimpChinese` 与语言选择器；NSIS `.exe` 本身就是 Tauri updater 载荷，并通过同名 `.exe.sig` 使用与 macOS 相同的 minisign 信任链。
- 便携版目标仍为包含 `Cadilume.exe`、便携标记和说明文件的 ZIP，目前未接入发布。
- GitHub Actions、`cargo-xwin` 与 PE 链接只能证明构建路径成立；WASAPI、SMTC、通知区域、WebView2、安装器和便携更新仍必须在真实 Windows 10 / 11 x64 会话验收。
- NSIS 工作流与更新元数据已实现，但完成 Authenticode 和真实 Windows 验收之前，不能把 CI 成功等同于面向普通用户的 Windows 发布就绪。

## 安装版

1. 已完成：Windows-only Tauri 配置、无边框窗口、NSIS 中英文语言选择、`currentUser` 安装与禁止降级。
2. 已完成：`windows-latest` 先执行完整门禁，再构建兼作 updater 载荷的 release NSIS `.exe` 及同名 `.exe.sig`。
3. 已完成：发布汇总 job 生成同时覆盖 `darwin-aarch64`、`darwin-aarch64-app`、`windows-x86_64` 与 `windows-x86_64-nsis` 的唯一 `latest.json`。
4. 待完成：配置 Windows Authenticode 证书与时间戳；updater minisign 只保护更新包来源，不能替代安装器下载信誉和系统开发者身份。
5. 待完成：真机覆盖自定义标题栏 / DPI / Snap、中文和英文系统语言、语言选择器、全新安装、覆盖升级、卸载、播放中更新、安装完成后的恢复与 SQLite 登录态保留行为。

## 便携版

Tauri 不正式支持 portable mode，而且官方 updater 在 Windows 上面向 NSIS / MSI。不能让便携版直接消费 NSIS updater 条目，否则“自动更新”会把便携程序变成安装版。

后续便携更新采用独立通道：

1. CI 对未打包的 release 可执行文件和必要资源生成 `Cadilume_<version>_windows_x64_portable.zip`，ZIP 内放置明确的便携标记。
2. 为 ZIP 生成独立签名和 manifest；应用先验证 manifest 与 ZIP 签名，再下载到同目录的临时位置。
3. 新版本 `Cadilume.exe` 以受限的替换模式启动，等待旧进程退出，原子替换便携目录并重新启动。替换程序使用新版本应用自身，不引入需要用户安装的 sidecar 或外部运行依赖。
4. 替换失败必须保留旧版本和下载包，不能留下半更新目录；跨卷、只读目录、受保护目录、杀毒软件占用和磁盘不足均需明确回退。
5. 在真实 Windows 上验证带空格 / 中文路径、U 盘或移动盘、非管理员账号、运行中播放、失败恢复与连续跨版本更新后，才开放便携版自动安装。此前便携版最多提供已签名新 ZIP 的检测和手动替换提示。

## 发布门禁

- 发布输入会规范化为 `vX.Y.Z`，并且必须与已提交的 `package.json`、`tauri.conf.json`、`Cargo.toml` 和 `Cargo.lock` 四处版本一致；CI 只校验，不自动修改版本或创建版本提交。
- 当前统一 GitHub Release 包含 DMG、macOS updater 归档与签名、兼作 Windows updater 载荷的 NSIS EXE 与签名，以及唯一的跨平台 `latest.json`。
- 后续增加便携 ZIP 时必须同时增加独立签名和独立 manifest；不能覆盖或复用安装版的 `windows-x86_64-nsis` 条目。
- Windows 与 macOS build job 保持独立，任一失败都不会生成或公开不完整的跨平台 Release。
- 任何“已支持 Windows”的 README 表述都以真实 Windows 验收记录为前提。
