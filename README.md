# Cadilume

一个以桌面体验为先的轻量 Plex 音乐客户端，目标平台为 macOS 与 Windows。界面参考 Apple Music 与 Spotify 的清晰信息层级，但使用项目自己的品牌标记、图标和视觉语言。

项目、应用与安装包统一使用名称 `Cadilume`，Bundle ID 为 `top.codeh.cadilume`，仓库目录为 `cadilume`。Plex 仅表示 Cadilume 所连接的第三方媒体服务与互操作 API，不属于应用名称。

当前版本已经打通 Plex PIN 登录、服务器发现、家庭/共享资源 token、Music 资料库浏览、本地与远程串流、普通音乐歌单写入、歌词、下一首预缓冲、独立软件音量、平台播放设备入口、系统媒体会话、原生窗口和托盘退出入口。

> Cadilume 是面向 Plex Media Server 的非官方第三方互操作客户端，与 Plex, Inc. 无隶属关系。项目不包含 Plexamp 源码、品牌素材、私有 Treble 音频模块或 BASS 二进制，也不会绕过 Plex 服务器权限或订阅能力。

## 为什么做这个项目

本机 Plexamp 4.12.4 是 Electron + React Native Web 桌面壳，应用约 206 MB，默认窗口只有 270×515。其独立音量功能实际上存在，但窄屏布局要到约 675px 高才显示音量滑块，默认窗口因此看不到；Windows 端依赖的媒体服务也没有实现完整 SMTC。

Cadilume 的首要原则：

- 使用系统原生标题栏和窗口按钮。
- 音量固定显示在播放器底栏，不随窗口高度隐藏，也不改变系统主音量。
- 关闭主窗口可选择“最小化到托盘/菜单栏”或“退出程序”。
- Windows 通知区域、macOS 菜单栏和设置页都有明确的“退出 Cadilume”。
- 只读取 Plex 的 Music 类型资料库，不混入电影、剧集、照片等 Section。
- 免费独立 Plex 账号只要获得音乐库共享权限，就不在客户端侧做 Plex Pass 拦截。
- 所有 PMS 请求使用 `/api/v2/resources` 返回的服务器专属 `accessToken`，包括 `owned:false` 的家庭或共享服务器。

## 当前功能

### 账号、资料库与连接

- Plex PIN 系统浏览器登录。
- macOS Keychain / Windows Credential Manager 保存账号 token；PIN IPC 只向 WebView 返回 `authenticated` 状态，不返回 token。
- Plex 服务器发现，并在本地直连、远程直连和 Relay 连接之间排序、重试。
- 仅列出 `type=artist` 的 Music Section；支持艺术家、专辑、曲目、最近加入和全库搜索。
- 专辑/艺术家层级浏览、桌面曲目表格和家庭/共享服务器。
- 可把歌曲添加到服务器上的普通音频歌单；智能歌单不作为写入目标，共享服务器没有写权限时会明确提示并服从 PMS ACL。
- 浏览器演示数据模式，便于不登录账号时做 UI 验收；真实 Plex API 只在 Tauri 中调用。

### 播放与歌词

- 原始质量直放，以及 320/256/192 kbps 服务端转码选项。
- 播放队列、上一首/下一首和进度跳转；顺序播放自然到队尾停止、当前列表循环、单曲循环与随机袋播放始终限定在当前队列，绝不自动跳到其他播放列表。
- 两个 `HTMLAudioElement` 组成的播放池：默认预解析并缓冲下一首，切歌时复用待命 Audio；列表循环可预缓冲队首，随机播放会稳定保留一个 pending 候选并在实际切歌时才从 shuffle bag 消费，单曲循环无需错误预测。
- 独立音量、静音和持久化，并同步应用到当前与预缓冲 Audio。
- Plex 授权返回的时间轴歌词与纯文本歌词；时间轴歌词随播放进度高亮、自动滚动，并可点击跳转。
- 从底部播放栏展开的完整播放器提供“黑胶 + 专辑封面 + 滚动歌词”和“全屏专辑背景 + 歌词”两种可记忆模式；展开层完全覆盖应用内容与默认底栏，并自带进度、随机、上一首/下一首、播放/暂停、列表循环、静音和独立音量。
- 独立置顶桌面歌词窗口显示当前行和下一行，提供卡拉 OK 扫色、透明背景、悬停玻璃控制条、拖动、位置固定与关闭，可从播放器或托盘/菜单栏打开或隐藏。
- Media Session 播放/暂停/上一首/下一首/Seek 元数据，以及 `/:/timeline` 与 `/:/scrobble` 回报。
- 本地保存最近队列、当前曲目、播放进度、音质、随机和循环模式；重启后恢复现场但不自动播放，登出时清除播放会话。

### 播放设备

- macOS：两个 Audio 均声明 `x-webkit-airplay="allow"`，播放设备入口调用 WKWebView 提供的 `webkitShowPlaybackTargetPicker()`，并跟踪无线播放目标状态。AirPlay 激活后切歌会保留当前 Audio 元素，避免替换元素时丢失系统路由。
- macOS 降级：若当前 WKWebView 未提供 AirPlay 选择器，界面会引导到“控制中心 → 声音”选择 AirPlay 设备。
- Windows：在 WebView2 支持时，通过 `enumerateDevices()` 与 `setSinkId()` 为 Cadilume 选择“系统默认”或指定输出设备，不修改 Windows 全局默认设备。
- Windows 会监听设备变化；已选设备断开或不可用时回退系统默认，并把相同设备应用到当前与预缓冲 Audio。
- 若 WebView2 不支持应用内切换，或需要系统侧管理，可直接打开 Windows 音量合成器；`selectAudioOutput()` 仅作为运行环境支持时的增强入口。

### 桌面体验与缓存

- 原生窗口装饰、macOS 菜单栏 / Windows 通知区域托盘、恢复主窗口、播放/暂停、桌面歌词和退出菜单。
- 设置中可选择关闭到托盘/菜单栏或直接退出，也始终提供“退出 Cadilume”。
- 跟随系统、浅色、深色三种主题模式。
- 播放器底栏固定提供歌词、队列、播放设备和独立音量入口。
- 封面在接近可视区域时预取；前端限制并发并复用请求，Rust 使用服务器 token Header 拉取图片，而不是把 token 放进图片 URL。
- Rust 将封面写入应用缓存目录下的 `cadilume/artwork` 磁盘缓存。缓存键同时包含当前授权 token 的哈希输入、服务器、图片路径和尺寸，账号之间不会复用旧授权缓存且不会把 token 本身写入磁盘；单张图片限制 12 MiB，总量限制 512 MiB，并按最近命中时间近似 LRU 淘汰。命中后返回 Data URL 给 WebView，设置页可查看大小并清理缓存。

## 开发

要求：Node.js 20+、pnpm 10+、Rust stable，以及 [Tauri 2 平台依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
pnpm install
pnpm tauri dev
```

验证：

```bash
pnpm check
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build
pnpm tauri build
```

macOS 图标统一从项目内的 `src-tauri/icons/app-icon.svg` 生成。`icons:macos` 会先更新各平台图标，再用真实 1024px 矢量直出重建 `.icns` 的全部 Retina 槽位，避免把 512px 图放大后导致 DMG/Finder 图标发虚：

```bash
pnpm icons:macos
```

没有 Developer ID 的本机验收包可在 release 二进制构建完成后使用一次性 ad-hoc identity 封装；它会完整密封 `Info.plist` 与资源，可用于排除封装后资源被改动或签名残缺，但不会取得 Gatekeeper 的公开分发信任。换到另一台 Mac 后仍可能被“无法验证开发者”拦截，并需要在“隐私与安全性”中手动允许，不能保证只出现普通的“来自互联网，是否打开”确认：

```bash
pnpm tauri bundle --bundles app,dmg -c '{"bundle":{"macOS":{"signingIdentity":"-"}}}'
codesign --verify --deep --strict --verbose=4 src-tauri/target/release/bundle/macos/Cadilume.app
hdiutil verify src-tauri/target/release/bundle/dmg/Cadilume_0.1.0_aarch64.dmg
```

面向 GitHub 用户、且希望稳定得到普通首次打开确认的正式发布，必须使用 Developer ID Application、Hardened Runtime 与安全时间戳完成签名，再通过 Apple notarization 并 staple 公证票据；ad-hoc 或本地自签证书都不能替代这条信任链。

只预览 UI 时运行 `pnpm dev`，普通浏览器会自动使用演示资料库；真实 Plex API 仅在 Tauri 运行时调用。

## 目录

```text
src/                  React 桌面 UI、歌词、双 Audio 播放器和平台输出适配
src-tauri/src/plex.rs Plex 认证、资源发现、PMS、歌词、歌单写入和封面缓存
src-tauri/src/stream_proxy.rs
                      127.0.0.1 音频票据代理、Range / HEAD 与连接回退
src-tauri/src/window.rs
                      原生关闭行为、托盘菜单、桌面歌词和明确退出入口
design-system/        UI 设计规则
docs/                 Plex 互操作研究与演进架构
.codex/memories/      项目级持续记忆
```

## 重要边界

- v0.1 仍使用 WebView 音频元素。双 Audio 能减少确定性切歌前的等待，但不等于严格 gapless、crossfade、完整后台队列权威或音频离线缓存。
- AirPlay 依赖 macOS WKWebView 暴露的 WebKit 播放目标能力；Windows 输出设备依赖 WebView2 的 Audio Output Devices API。真实 AirPlay 接收器、USB/蓝牙/HDMI 声卡、设备热插拔和休眠恢复仍需对应平台真机验收。
- Windows 当前提供 Web Media Session 能力，但不宣称完整原生 SMTC；更稳定的后台播放、严格 gapless 和平台媒体集成仍需要 Rust 原生播放核心。
- 账号 token 保存在系统凭据存储，服务器专属 token 只保留在 Rust 状态中；PIN IPC 仅返回 `authenticated`。PMS 数据、封面和音频上游请求都由 Rust 用 Header 鉴权。WebView 播放的是 `127.0.0.1` 随机端口上的短期高熵 ticket URL，其中不含 PMS 地址、媒体路径或 `X-Plex-Token`；本地代理支持 GET/HEAD、单段 HTTP Range，并在已发现的本地、远程与 Relay 连接间回退。
- 原生退出入口会先发送退出前事件，让播放器立即保存队列与进度，再在收到确认或短超时后结束进程；关闭到托盘只隐藏窗口，不会误结束播放。
- 客户端只播放服务器已经授权给当前账号的内容。支持免费账号访问已共享的 Music 库，不代表绕过 Plex ACL、服务端限制或特定功能的订阅要求。

进一步的播放核心和安全演进见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 许可

项目代码采用 MIT。Plex、Plexamp 及其商标属于各自权利人。用户需要自行拥有或获授权访问相应 Plex Media Server 内容。
