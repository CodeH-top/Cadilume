<div align="center">

  <img src="Branding/Cadilume-readme-icon.png" width="256" height="256" alt="Cadilume 图标" />

# Cadilume

**Plex Web 与 Plexamp 的开源桌面音乐替代方案**

[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?style=flat&labelColor=18110B&logo=tauri&logoColor=FFC131)](https://tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat&labelColor=18110B&logo=react&logoColor=61DAFB)](https://react.dev/)
[![Rust 1.88+](https://img.shields.io/badge/Rust-1.88%2B-B7410E?style=flat&labelColor=18110B&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![macOS 11+](https://img.shields.io/badge/macOS-11%2B-6E6E73?style=flat&labelColor=18110B&logo=apple&logoColor=white)](https://www.apple.com/macos/)
[![Windows](https://img.shields.io/badge/Windows-10%20%2F%2011-0078D4?style=flat&labelColor=18110B&logo=windows11&logoColor=white)](https://www.microsoft.com/windows/)
[![License: MIT](https://img.shields.io/badge/License-MIT-D4A72C?style=flat&labelColor=18110B)](LICENSE)

[English](README.md) | 中文

</div>

Cadilume 是一个面向 macOS 与 Windows 的 Plex 音乐桌面客户端，目标是在一个专注、完整的桌面应用中承接 Plex Web 的音乐资料库浏览与 Plexamp 的日常播放场景。

连接自己拥有或获授权共享的 Plex Media Server 后，可以浏览音乐资料库、搜索歌曲、管理歌单、查看歌词，并通过桌面系统媒体控制持续播放。Cadilume 专注音乐体验，不混入电影、剧集和照片资料库。

> Cadilume 是面向 Plex Media Server 的非官方第三方客户端，与 Plex, Inc. 无隶属或背书关系。Plex、Plexamp 及相关商标归其各自权利人所有。

## 功能

### 音乐资料库

- 通过 Plex PIN 在系统浏览器中登录。
- 发现当前账号可访问的自有、家庭与共享服务器。
- 在设置中选择服务器和 Music 资料库，并显示本地直连、远程直连或 Plex Relay 状态。
- 浏览首页推荐、最近加入、歌手、专辑和歌曲。
- 支持完整歌手目录、A-Z/# 索引、专辑与歌手详情以及全库搜索。
- 可从专辑、歌手、搜索结果、歌单或任意歌曲开始播放。

### 播放与歌词

- 原生桌面音频播放，支持 MP3、AAC/MP4、FLAC、Vorbis 和 WAV 等常见格式。
- 支持原始音质、自动音质与固定码率；需要兼容转换时由 Plex Media Server 完成转码。
- 播放队列支持下一首、移除、清空、置顶、拖拽排序和键盘排序。
- 支持顺序播放、随机播放、列表循环和单曲循环。
- 独立软件音量与静音，不改变系统主音量。
- 支持时间轴歌词与纯文本歌词；时间轴歌词可自动跟随，也可点击跳转播放位置。
- 展开播放器提供黑胶与封面两种显示模式，并保留完整播放控制和歌词视图。
- 自动保存最近队列、当前歌曲、播放位置、音质和循环状态，重新启动后恢复现场但不会自动播放。

### 歌单

- 读取并播放普通歌单、智能歌单和只读歌单。
- 创建、重命名、编辑描述和删除可写的普通音乐歌单。
- 将单首或多首歌曲添加到歌单，也可批量移除歌曲。
- 普通歌单内的歌曲支持拖拽与键盘排序，智能歌单始终读取服务器的最新结果。

### 桌面体验

- 原生 macOS / Windows 窗口与固定底部播放器。
- 关闭主窗口后继续播放，并可从 Dock、任务栏或状态图标恢复。
- macOS 菜单栏与 Windows 通知区域提供恢复窗口、播放/暂停和退出入口。
- 集成 macOS Now Playing / Remote Commands 与 Windows 系统媒体控制。
- 浅色、深色主题以及琥珀金、雨林绿、澄海蓝三种视觉风格。
- Windows 提供应用内输出设备选择；macOS 继续使用系统控制中心管理输出路由。
- 封面缓存、固定 1 GiB 音频缓存和下一首预缓冲，设置页可分别查看与清理缓存。
- 发行构建可在设置中检查 GitHub Release、下载签名更新，并重启进入新版本；自动检查开关可配置，开发构建强制禁用更新能力。

### 账号与隐私

- 发行构建将账号凭据保存在 macOS Keychain 或 Windows Credential Manager。
- 服务器令牌、媒体地址与封面地址不会直接暴露给界面层或写入日志。
- 所有请求继续遵守 Plex Media Server 的访问权限与订阅能力边界。
- 播放、解码与缓存能力随应用一同提供，不要求用户额外安装 FFmpeg、libmpv、BASS、Homebrew 或后台服务。

## 系统要求

### 使用应用

- 一个可正常登录的 Plex 账号。
- 至少一个当前账号有权访问的 Plex Media Server Music 资料库。
- macOS 11 或更高版本，或 Windows 10 / 11 x64。
- Windows 需要系统提供 Microsoft Edge WebView2 Runtime；常见的 Windows 10 / 11 环境通常已包含。

> **平台验证状态：** 发行元数据与二进制最低面向 macOS 11，但目前只有 macOS 26 完成实机验收。Windows 代码路径已在 macOS 上针对 `x86_64-pc-windows-msvc` 通过 `cargo-xwin` 编译、测试二进制构建与 PE 链接门禁，但 Windows 运行时行为和 NSIS 安装器尚未在真实 Windows 系统中验收。

### 从源码构建

- Node.js 20 或更高版本
- pnpm 10 或更高版本
- Rust 1.88 或更高版本
- 对应平台的系统 SDK
- macOS：Xcode Command Line Tools；重新生成 macOS 26 分层图标时需要 Xcode 26 或更高版本
- Windows：Git、CMake、MSVC C++ Build Tools、Windows 10/11 SDK 与 WebView2 Runtime

## 下载与更新

`Release macOS` GitHub Actions 工作流只允许手动触发，并且只构建 macOS arm64。默认模式仅把 DMG 与 updater 文件保存为 workflow artifacts；维护者必须主动勾选发布并填写 `v0.1.2` 这类匹配版本的标签，才会创建公开 [GitHub Release](https://github.com/CodeH-top/Cadilume/releases) 和签名更新清单。普通 push、合并与创建标签都不会自动运行该工作流。

发行构建通过 **设置 → 应用更新** 检查该清单。自动检查默认开启，也可以关闭；下载安装仍须由用户明确点击，因为安装完成后 Cadilume 会重启。Debug 与浏览器预览构建无法调用 updater，也无法修改该偏好。

> 当前 macOS CI 使用 ad-hoc 签名且未公证，macOS 可能要求用户在“隐私与安全性”中手动放行。面向普通用户的正式公开分发仍需 Apple Developer ID Application 证书、hardened runtime、公证和票据装订。

Windows x64 NSIS 安装包和便携 ZIP 仍处于计划阶段，尚未发布。安装版与便携版需要不同的更新替换语义，实施步骤和真机验收门禁见 [`docs/WINDOWS_RELEASE_PLAN.md`](docs/WINDOWS_RELEASE_PLAN.md)。维护者密钥用途、GitHub Secrets 和发布步骤见 [`docs/RELEASING.md`](docs/RELEASING.md)。

## 部署与运行

```bash
git clone <repository-url>
cd Cadilume

pnpm install
pnpm tauri dev
```

`pnpm tauri dev` 会启动完整桌面应用。只需要预览界面时，可以运行 `pnpm dev`；浏览器预览使用内置演示资料，真实 Plex 登录与媒体请求仅在 Tauri 桌面进程中可用。

## 构建

提交构建前建议执行完整验证：

```bash
pnpm check
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build --debug --no-bundle
```

创建发布标签前，先确认三处应用版本一致：

```bash
pnpm verify:release-version
```

### macOS DMG

```bash
pnpm bundle:macos:dmg
```

### Windows

在 Windows 开发机上：

```powershell
pnpm windows:doctor
pnpm verify:windows
pnpm verify:windows:bundle
```

在已安装 `cargo-xwin` 的 macOS 上：

```bash
pnpm verify:windows:cross
```

交叉门禁会编译 Windows 代码路径和测试二进制，并链接 debug Windows PE 可执行文件；它不会运行这些二进制，也不能验收 Windows 运行时集成与安装器。`verify:windows:bundle` 会在 Windows 上生成用于本地验收的未签名 debug NSIS 安装包。正式公开分发时，请分别配置 Apple Developer ID、公证与票据装订，或 Windows 代码签名。

GitHub macOS 发布工作流位于 [`.github/workflows/release-macos.yml`](.github/workflows/release-macos.yml)；公开发布必须从 `main` 手动执行，且 `vX.Y.Z` 标签与应用版本不一致时会直接拒绝。

## 主要依赖

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Tauri | 2 | 桌面应用外壳、窗口与系统集成 |
| React | 19 | 桌面界面与状态编排 |
| React Router | 7 | 应用内导航 |
| TypeScript | 5.8 | 前端类型系统 |
| Vite | 7 | 开发服务器与前端构建 |
| Vitest | 4 | 前端测试 |
| Rust | 1.88+ | 原生服务、播放与平台能力 |
| rodio | 0.22.2 | 播放队列与音频输出 |
| cpal | 0.17.3 | CoreAudio / WASAPI 设备访问 |
| symphonia | 0.5.5 | 音频格式探测与解码 |
| reqwest / axum | 0.13 / 0.8 | Plex 请求与本机安全媒体代理 |
| keyring | 3.6.3 | 系统凭据存储 |

完整依赖及锁定版本请参阅 [`package.json`](package.json)、[`pnpm-lock.yaml`](pnpm-lock.yaml)、[`src-tauri/Cargo.toml`](src-tauri/Cargo.toml) 与 [`src-tauri/Cargo.lock`](src-tauri/Cargo.lock)。

## 项目结构

```text
src/                    React 桌面界面与业务编排
src-tauri/src/          Plex 连接、原生播放、缓存与系统集成
src-tauri/icons/        应用、菜单栏与安装包图标
Branding/               README 品牌资源
scripts/                macOS / Windows 构建与验证脚本
docs/                   架构、互操作与平台开发文档
```

## 使用说明

- 只访问自己拥有或已获授权的 Plex Media Server 与媒体内容。
- Cadilume 不绕过 Plex ACL、服务器限制或特定功能的订阅要求。
- 本项目按现状提供，不附带任何明示或默示担保。

## 许可证

本项目根据 MIT 许可证授权，详情请参阅 [LICENSE](LICENSE) 文件。

[返回顶部](#cadilume)
