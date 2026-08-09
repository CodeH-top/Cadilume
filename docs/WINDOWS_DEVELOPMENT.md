# Windows 开发与调试

Cadilume 的 Windows 首要目标是 `x86_64-pc-windows-msvc`。Windows 端与 macOS 共用 React/Plex 业务层，播放、缓存、解码、输出设备和系统媒体控制仍由 Rust 负责。当前仓库能在 macOS 上做静态检查和 `cargo-xwin` 交叉链接；WASAPI、SMTC、Credential Manager、通知区域和安装器必须在 Windows runner 或真实 Windows 机器上验收。

## 1. 开发机要求

建议使用 Windows 11 x64；Windows 10 1803 及以上通常已带 WebView2 Runtime。Tauri 官方前置说明：

- [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)

安装 Visual Studio Build Tools 时勾选“使用 C++ 的桌面开发”，并确认包含：

- MSVC x64/x86 build tools（v143 或更新版本）
- Windows 10/11 SDK（需要 `Windows.h`）
- C++ CMake tools for Windows

另外安装 Git、Node.js 20+、pnpm 10+ 和 Rust stable MSVC，并确认 `cmake` 可在开发 PowerShell 中直接执行。项目 TLS 依赖的原生构建会调用 CMake；只安装 MSVC 和 SDK 不足以完成首次 Cargo 构建。Rust 的默认 host 必须是 `x86_64-pc-windows-msvc`；不要选择 GNU toolchain。若使用 ARM Windows，先以 x64 目标完成验收，再单独增加 ARM64 门禁。

仓库路径建议短一些，例如 `C:\src\Cadilume`。依赖树较深时，如果仍遇到路径过长，可由管理员开启 Windows 长路径支持；doctor 会把未开启状态列为警告。

## 2. 首次准备

在仓库根目录打开 PowerShell：

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm windows:doctor
```

`pnpm windows:doctor` 是只读检查，不会修改 Visual Studio、注册表或 WebView2。缺失项会给出对应安装提示。执行策略限制脚本时，使用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-windows-env.ps1
```

## 3. 开发与调试

先启动唯一的 Tauri 开发链：

```powershell
$env:RUST_BACKTRACE = "1"
pnpm tauri dev
```

Windows debug 构建会显示主窗口，并在任务栏保留恢复入口；这样关闭窗口后可以从任务栏恢复，即使用户关闭了通知区域图标。关闭主窗口仍然是原生最小化，不会停止播放。发布构建在初始化完成后显示主窗口。

开发态账号 token 只写入：

```text
%USERPROFILE%\.cadilume-dev-token
```

这是为了避免调试时弹出系统凭据授权；debug 文件不应复制到仓库、提交或写入日志。Release 构建不读取该文件，只使用 Windows Credential Manager。可通过 `CADILUME_DEV_TOKEN_FILE` 临时指定调试文件路径。切换账号或退出账号时，应用会清理对应调试凭据和 Rust 内存中的服务器 token。

调试时优先看运行 `pnpm tauri dev` 的终端输出。播放日志只包含经过清理的状态，不包含 PMS 地址、媒体路径、票据或 token。需要更完整的 Rust 堆栈时，在同一个 PowerShell 会话设置 `RUST_BACKTRACE=1`；不要把 token 放进 `RUST_LOG`、命令行参数或 issue 文字中。

## 4. 自动验证

快速验证（不打包安装器）：

```powershell
pnpm verify:windows
```

完整验证并生成未签名 debug NSIS 包：

```powershell
pnpm verify:windows:bundle
```

验证脚本依次执行：

1. Windows 工具链和仓库表面检查
2. `pnpm install --frozen-lockfile`（除非传入 `-SkipInstall`）
3. TypeScript 检查、前端测试和构建
4. `cargo fmt --check`、Rust 测试与 release 检查（覆盖 Credential Manager 路径）
5. Tauri Windows debug 构建
6. 可选的 NSIS 生成和 `git diff --check`

GitHub Actions 的 `windows-latest` runner 会自动执行完整 NSIS 门禁并上传未签名 debug 安装包。它验证 MSVC/Windows SDK、Tauri 资源和 NSIS 配置，但不替代本地音频设备验收。

macOS 上可用已安装的 `cargo-xwin` 做交叉检查：

```bash
pnpm check:windows:cross
pnpm build:windows:cross
```

第一条快速覆盖 Windows `cfg` 和 WinRT API，第二条进一步完成 Tauri Windows PE 链接。两者都不能证明 WASAPI、SMTC UI、Credential Manager 或通知区域在真实 Windows 会话中工作。裸 `cargo check --target x86_64-pc-windows-msvc` 不够，它会在需要原生 C/Windows SDK 的依赖上失败；使用 `cargo-xwin` 或 Windows runner。

## 5. Windows 实机验收清单

### 窗口与通知区域

- [ ] 启动后使用原生 Windows 标题栏、最小化、最大化和关闭按钮，没有假标题栏。
- [ ] 关闭主窗口只最小化，播放继续；从任务栏点击可恢复并聚焦主窗口。
- [ ] 设置中关闭通知区域图标后，进程仍可从任务栏恢复，不产生不可见后台进程。
- [ ] 开启通知区域图标后，右键菜单能显示 Cadilume、播放/暂停和明确退出；左/右键行为符合 Windows 习惯。
- [ ] 显示/隐藏通知区域图标的偏好重启后保持，切换不会重复创建图标。

### Rust 播放与 WASAPI

- [ ] 默认输出设备可以打开并播放 MP3、FLAC、WAV、OGG/Vorbis、AAC/M4A 等仓库已启用格式。
- [ ] 设置中切换内置扬声器、USB DAC、蓝牙耳机和 HDMI 输出；切换期间不会双路出声。
- [ ] 拔出当前设备后自动回退系统默认，重新插入后不会把失效 ID 写回偏好。
- [ ] Windows 系统默认输出改变后，应用能在下一次枚举/恢复中识别新设备。
- [ ] 锁屏、睡眠/唤醒、快速用户切换后播放流可恢复；没有持续的静音或 CPU 占用异常。
- [ ] 前端独立音量和静音在设备切换、重启和恢复播放后保持，不能改变系统主音量。

### SMTC 与媒体键

- [ ] 播放/暂停、下一首、上一首硬件媒体键或系统媒体面板能控制当前队列。
- [ ] 标题、艺术家、专辑、播放状态、时长和位置与 Rust 实际媒体时间一致。
- [ ] 系统时间轴拖动产生 Seek，并在播放器与 PMS 时间轴中落到同一位置。
- [ ] 有封面和无封面曲目切换时不会残留上一首封面；清空队列后 SMTC 条目被清理。
- [ ] 应用隐藏或最小化后，媒体键仍能工作；退出后不残留旧条目。

### 账号、网络与缓存

- [ ] PIN 登录通过系统浏览器完成，WebView 和日志中没有账号 token。
- [ ] Release 构建的 token 只出现在当前 Windows 用户的 Credential Manager 中。
- [ ] 共享服务器请求使用该服务器专属 token；不能因 Windows 路径或编码变化丢失 ACL。
- [ ] 本地 loopback 音频/封面代理可工作，Windows Defender 不要求开放非 loopback 端口。
- [ ] `%LOCALAPPDATA%` 下缓存、配置和临时文件可创建；账号切换后票据和旧授权缓存被撤销。
- [ ] 设备名称包含中文、空格和常见标点时可保存；控制字符仍被拒绝。

### 安装器

- [ ] 在干净 Windows 10/11 虚拟机中运行 NSIS 包；没有 WebView2 时能按配置安装 bootstrapper。
- [ ] 默认使用当前用户安装，不要求管理员权限；安装目录、开始菜单项和卸载入口正确。
- [ ] 升级到新版本成功；低版本安装包不能覆盖高版本（当前配置禁止 downgrade）。
- [ ] 卸载后没有残留运行进程、快捷方式或安装器临时文件；用户配置/缓存是否保留符合产品决定。
- [ ] 未签名 debug 包只用于本地验收；正式发行前必须补 Windows 代码签名与时间戳。

## 6. 常见诊断

| 现象 | 先检查 |
| --- | --- |
| `link.exe`、`Windows.h` 或 `cl.exe` 找不到 | `pnpm windows:doctor`；确认 C++ 工作负载和 Windows SDK 已安装，并从新 PowerShell 重试 |
| `cmake` 找不到或 `aws-lc-sys` 构建失败 | 确认已安装 C++ CMake tools for Windows，且新 PowerShell 中 `cmake --version` 可执行 |
| `failed to run light.exe` | 仅 MSI 需要；启用 Windows 可选功能 `VBSCRIPT`。本项目默认 Windows 配置使用 NSIS |
| 窗口空白或启动失败 | 确认 WebView2 Runtime；运行 `pnpm tauri info`，再看 `pnpm tauri dev` 终端 |
| 播放无声 | 先运行应用内输出设备检查，切回“系统默认”，确认 Windows 音量混合器没有把 Cadilume 静音 |
| 设备切换后静音 | 拔插设备后重新枚举；删除失效的输出设备偏好并重启 debug 进程 |
| SMTC 没有条目 | 确认应用已开始播放，检查 Windows 媒体面板；SMTC 绑定需要主窗口 HWND，必须在 Tauri 窗口创建后初始化 |
| 调试登录状态异常 | 删除 `%USERPROFILE%\.cadilume-dev-token` 后重新登录；不要删除 Credential Manager 中的 release 条目来排查 debug |

## 7. 发行边界

Windows 运行时不依赖 Homebrew、FFmpeg、libmpv、BASS、sidecar 或独立后台服务。WASAPI、SMTC、WebView2 和 Credential Manager 是系统能力；Rust 播放及协议依赖编译进 Cadilume。正式包仍需要 Windows 代码签名，未签名 debug NSIS 只作为开发和上机验收制品。
