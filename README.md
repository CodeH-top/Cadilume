# Cadilume

一个以桌面体验为先的轻量 Plex 音乐客户端，目标平台为 macOS 与 Windows。界面采用原生桌面应用的信息密度与清晰层级，同时保留 Cadilume 自己的深浅色主题、品牌标记、图标和视觉语言。

项目、应用与安装包统一使用名称 `Cadilume`，Bundle ID 为 `top.codeh.cadilume`，仓库目录为 `Cadilume`。Plex 仅表示 Cadilume 所连接的第三方媒体服务与互操作 API，不属于应用名称。

这是一个独立 git 仓库；项目级工作规则和持续记忆位于根目录的 `AGENTS.md` 与 `.codex/memories/`，不依赖父工作区的入口文件。

当前版本已经打通 Plex PIN 登录、服务器发现、家庭/共享资源 token、Music 资料库浏览、本地与远程串流、普通/智能/只读音频歌单读取与播放、普通歌单创建与写入、歌词、下一首预缓冲、独立软件音量、Windows 播放设备入口、系统媒体会话、原生窗口和托盘退出入口。

> Cadilume 是面向 Plex Media Server 的非官方第三方互操作客户端，与 Plex, Inc. 无隶属关系。项目不包含 Plexamp 源码、品牌素材、私有 Treble 音频模块或 BASS 二进制，也不会绕过 Plex 服务器权限或订阅能力。

## 为什么做这个项目

本机 Plexamp 4.13.2 是 Electron + React Native Web 桌面壳，播放层随应用携带私有 `treble.node` 与 BASS 动态库。Cadilume 只把它作为行为与缓存策略的 clean-room 参考，不复制私有代码、素材、标识或二进制。

Cadilume 的首要原则：

- 保留系统原生窗口装饰与按钮；macOS 使用 Overlay 标题栏隐藏系统标题，把原生交通灯整合进 52px 自定义顶部工具栏，不绘制假按钮。
- 默认窗口与最小窗口均为 `1280×820`，界面不允许继续缩小。
- 音量固定显示在播放器底栏，不随窗口高度隐藏，也不改变系统主音量。
- 关闭主窗口统一最小化并继续播放；菜单栏/通知区域状态图标是独立、持久化偏好。
- 状态图标开启时提供明确的“退出 Cadilume”；关闭时仍可从 Dock/任务栏恢复主窗口，不形成不可见后台进程。
- 只读取 Plex 的 Music 类型资料库，不混入电影、剧集、照片等 Section。
- 免费独立 Plex 账号只要获得音乐库共享权限，就不在客户端侧做 Plex Pass 拦截。
- 所有 PMS 请求使用 `/api/v2/resources` 返回的服务器专属 `accessToken`，包括 `owned:false` 的家庭或共享服务器。

## 当前功能

### 账号、资料库与连接

- Plex PIN 系统浏览器登录。
- macOS Keychain / Windows Credential Manager 保存账号 token；PIN IPC 只向 WebView 返回 `authenticated` 状态，不返回 token。
- Plex 服务器发现，并在本地直连、远程直连和 Relay 连接之间排序、重试。
- 顶部状态按 Plex 资源连接的 `local` / `relay` 标记显示当前首选连接为“本地直连”“远程直连”或“Plex Relay”，断开时也有独立状态；图标 hover 或键盘聚焦会显示明确说明。WebView 中始终出现的 `127.0.0.1` 是 Cadilume 安全代理，不能用来判断 PMS 是否位于本地。
- 仅列出 `type=artist` 的 Music Section；支持歌手、专辑、歌曲、最近加入和全库搜索。
- 歌手与专辑按 PMS `titleSort` 完整分页读取，并提供右侧 A–Z/# 索引；组内顺序不由浏览器重新排列。
- 专辑/歌手层级浏览、桌面歌曲表格和家庭/共享服务器。
- 歌手详情提供“专辑 / 歌曲”标签；歌曲按 PMS 专辑排序因子、碟号和曲号排序，每页 50 首懒加载，跨页及同页重复项都会过滤，后续页失败可从原页起点重试。
- 服务器与音乐资料库只在设置页选择，主侧栏不再显示来源选择器。
- 主侧栏常驻当前账号可读的普通、智能和只读音频歌单，并使用独立的轻浅滚动区；主导航、顶部账号工具和播放器位置不会随歌单滚动。
- 普通、智能和只读歌单都可打开并播放全部、随机播放或单曲起播；智能歌单每次打开都读取 PMS 的最新结果。侧栏 `+` 通过 PMS 创建空白普通音乐歌单；只有普通且非只读的歌单会作为“添加到歌单”目标，创建与写入权限继续服从 PMS ACL。
- 浏览器演示数据模式，便于不登录账号时做 UI 验收；真实 Plex API 只在 Tauri 中调用。

### 播放与歌词

- “本地直连 / 远程直连 / Relay”只描述 Cadilume 到 PMS 的连接拓扑；“原始直放 / PMS 转码”描述媒体处理决策，两者不是同一件事。Cadilume 客户端在任何连接拓扑下都不做音频转码。
- 自动模式下，本地连接优先原始质量直放，远程直连请求 320 kbps，Relay 请求 192 kbps；所有 320/256/192 kbps 转码均由 PMS 的 universal transcode 完成。
- 播放不兼容时按当前有效质量向下尝试 320 → 256 → 192 kbps，不重复同一档位；全部失败后显示全局播放失败提醒。
- `127.0.0.1` loopback 只负责票据校验、鉴权隔离、Range 转发和连接回退，不解码、不重新编码。即使 PMS 与 Cadilume 位于同一台 Mac，兼容转换或降码率仍由 PMS 服务端完成。
- 播放队列、上一首/下一首和进度跳转；顺序播放自然到队尾停止、当前列表循环、单曲循环与随机袋播放始终限定在当前队列，绝不自动跳到其他歌单。
- Rust 原生播放核心使用 `rodio 0.22.2 + cpal 0.17.3 + symphonia 0.5.5`。文件/网络读取和解码运行在独立 worker；CoreAudio/WASAPI 回调只从约 4 秒的有界 PCM 队列非阻塞取样，不执行 I/O 或 codec 工作。
- 当前曲目渐进下载到应用缓存，完整文件以 `.part -> .audio` 原子提交；下一首完整缓存会直接附加到 rodio 队列并按样本级标记完成 gapless 交接。
- PCM 欠载会冻结媒体时间并进入缓冲状态，达到 250ms 恢复水位后继续；歌词、scrobble、UI 与系统媒体时间都不会把欠载静音算作播放进度。
- 独立音量、静音和持久化由前端状态统一同步到原生 Player，不修改系统主音量。
- Plex 授权返回的时间轴歌词与纯文本歌词；保留 PMS 毫秒边界，播放时以 Rust 上报的真实媒体时间驱动高亮和自动滚动，有时间戳的行可点击跳转，不添加猜测性的固定延迟。歌词 payload 会先被 provider adapter 归一，歌词 UI 不直接依赖 Plex 协议。
- 从底部播放栏展开的完整播放器提供“黑胶”和“封面”两种可记忆模式；歌词或播放队列打开后占用播放器骨架的完整右栏，与左侧播放视觉并列，不呈现为浮动卡片。时间轴歌词跟随活动 Audio、可点击跳转，纯文本歌词保持静态可读；进度、随机、上一首/下一首、播放/暂停、列表循环、静音和独立音量继续固定在底部。
- 底栏歌词按钮直接打开主窗口中央、全可用高度的歌词层；它不挤压资料库内容、没有遮罩或关闭按钮，只由该按钮切换。歌词区可独立滚动和点击跳转，不再创建独立桌面歌词窗口；纯文本歌词保持静态可读，服务器确认无可显示歌词时按钮禁用。
- macOS `MPNowPlayingInfoCenter` / `MPRemoteCommandCenter` 与 Windows SMTC 提供播放状态、元数据、封面、时间轴、播放/暂停、上一首/下一首和 Seek；桌面端不再让 WebKit MediaSession 争抢系统媒体会话。PMS `/:/timeline` 与 `/:/scrobble` 继续按真实媒体时间回报。
- 本地保存最近队列、当前曲目、播放进度、音质、随机和循环模式；重启后恢复现场但不自动播放，登出时清除播放会话。

### 播放设备

- Windows 由 `cpal` 枚举并打开原生输出设备，不依赖 WebView `setSinkId()`；macOS 的输出路由继续交给系统控制中心。
- 切换设备时会捕获当前来源、真实媒体进度、音量、暂停状态以及完整随机袋/历史游标；旧下载和解码任务退出后才在新设备恢复，避免双路出声或共享 `.part` 冲突。
- macOS 的系统无线输出仍交给系统控制中心管理；Cadilume 不实现私有 AirPlay 控制协议。

### 桌面体验与缓存

- 原生窗口装饰，默认与最小尺寸均为 `1280×820`。macOS 使用 `decorations: true`、Overlay 标题栏、隐藏系统标题和原生阴影，保留原生交通灯、圆角、最小化、缩放与全屏行为；52px 自定义顶部工具栏提供专用背景拖动层。初始化状态直接铺满整个窗口，不再显示居中突出卡片，仅为顶部拖拽区和交通灯留出安全空间。macOS 菜单栏使用透明单色 Template 图标并自动适配浅/深菜单栏，Windows 通知区域沿用应用图标；状态图标开启时提供恢复主窗口、播放/暂停和退出，macOS 点击 Dock 图标也会重新显示主窗口。
- 关闭主窗口统一最小化；设置页只控制状态图标显示并提供危险色“退出账号”，应用级退出保留在原生状态菜单中。
- 首次启动按系统当前外观初始化；之后从右上角在浅色与深色之间直接切换。
- 播放器底栏固定提供歌词、队列和独立音量；Windows 额外提供播放设备入口，macOS 不显示应用内输出设备按钮。
- 封面在接近可视区域时预取；前端限制并发并复用请求，Rust 使用服务器 token Header 拉取图片，而不是把 token 放进图片 URL。
- Rust 将封面写入应用缓存目录下的 `cadilume/artwork` 磁盘缓存。缓存键同时包含当前授权 token 的哈希输入、服务器、图片路径和尺寸，账号之间不会复用旧授权缓存且不会把 token 本身写入磁盘；单张图片限制 12 MiB，总量限制 512 MiB，并按最近命中时间近似 LRU 淘汰。命中后只向 WebView 返回独立的本机高熵封面票据 URL，设置页可查看大小并清理缓存。

## 开发

开发构建要求 Node.js 20+、pnpm 10+、Rust stable 和对应平台 SDK；Windows 还需要 Git、CMake、MSVC C++ Build Tools、Windows SDK 和 WebView2 Runtime，macOS 分层图标需要 Xcode 26 或更高版本及其中的 Icon Composer。这些都是编译工具或系统能力，不是发行应用的额外播放依赖。Windows 的安装器会按 `tauri.windows.conf.json` 处理 WebView2；最终应用不要求用户安装 Homebrew、FFmpeg、libmpv、BASS、sidecar 或后台服务；Rust crates 静态编入程序，运行时只使用系统自带的 CoreAudio/MediaPlayer 或 WASAPI/SMTC 等 API。

```bash
pnpm install
pnpm tauri dev
```

Windows 首次开发与验证请先阅读 [Windows 开发与调试](docs/WINDOWS_DEVELOPMENT.md)，并运行 `pnpm windows:doctor`。完整 Windows 门禁使用 `pnpm verify:windows`；生成未签名 debug NSIS 包使用 `pnpm verify:windows:bundle`。

验证：

```bash
pnpm check
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build
pnpm tauri build --no-bundle
```

macOS 图标统一从项目内的 `src-tauri/icons/app-icon.svg` 与 `src-tauri/icons/Cadilume.icon` 生成。`icons:macos` 会先更新各平台图标，再用真实 1024px 矢量直出重建 `.icns` 的全部 Retina 槽位，同时编译 macOS 26 分层图标所需的 `Assets.car`；旧系统、应用包和 DMG 卷图标都保留清晰的兼容回退：

```bash
pnpm icons:macos
```

没有 Developer ID 的本机验收包可使用一次性 ad-hoc identity 构建；它会完整密封 `Info.plist` 与资源，可用于排除封装后资源被改动或签名残缺，但不会取得 Gatekeeper 的公开分发信任。换到另一台 Mac 后仍可能被“无法验证开发者”拦截，并需要在“隐私与安全性”中手动允许，不能保证只出现普通的“来自互联网，是否打开”确认。统一通过专用脚本构建 DMG；脚本在成功、失败或可捕获中断后都会清理固定的 `bundle/macos/Cadilume.app`，避免临时应用包继续被系统检索，只保留 DMG。若遭遇 SIGKILL 或断电，下一次运行也会先清理旧包：

```bash
pnpm bundle:macos:dmg
hdiutil verify src-tauri/target/release/bundle/dmg/Cadilume_0.1.1_aarch64.dmg
```

需要复核包内应用签名时，以只读、不可浏览方式临时挂载 DMG，验证后立即卸载；不要依赖已经清理的源 `.app`：

```bash
dmg_path="src-tauri/target/release/bundle/dmg/Cadilume_0.1.2_aarch64.dmg"
mount_dir=$(mktemp -d "${TMPDIR:-/tmp}/cadilume-dmg.XXXXXX")
hdiutil attach "$dmg_path" -readonly -nobrowse -mountpoint "$mount_dir"
codesign --verify --deep --strict --verbose=4 "$mount_dir/Cadilume.app"
hdiutil detach "$mount_dir"
rmdir "$mount_dir"
```

面向 GitHub 用户、且希望稳定得到普通首次打开确认的正式发布，必须使用 Developer ID Application、Hardened Runtime 与安全时间戳完成签名，再通过 Apple notarization 并 staple 公证票据；ad-hoc 或本地自签证书都不能替代这条信任链。

只预览 UI 时运行 `pnpm dev`，普通浏览器会自动使用演示资料库；真实 Plex API 仅在 Tauri 运行时调用。

## 目录

```text
src/                  React 桌面 UI、歌词、队列镜像和原生播放器 IPC
src-tauri/src/audio_engine.rs
                      Rust 解码 worker、PCM 缓冲、缓存、gapless、队列与输出设备
src-tauri/src/now_playing.rs
                      macOS Now Playing / Remote Commands 与 Windows SMTC
src-tauri/src/plex.rs Plex 认证、资源发现、PMS、歌词、歌单读写和封面缓存
src-tauri/src/stream_proxy.rs
                      127.0.0.1 音频票据代理、Range / HEAD 与连接回退
src-tauri/src/window.rs
                      原生关闭行为、Dock/托盘恢复和明确退出入口
design-system/        UI 设计规则
docs/                 Plex 互操作研究与演进架构
.codex/memories/      项目级持续记忆
```

## 重要边界

- 当前播放、缓存、gapless 预排、输出设备和系统媒体状态均由 Rust 原生核心负责；WebView 只保留 UI、队列镜像和 PMS 业务编排。
- macOS 不实现应用内私有无线输出控制；USB/蓝牙/HDMI 声卡热插拔、休眠恢复和 Windows WASAPI/SMTC 仍需对应平台实机长期验收。
- ReplayGain、crossfade、响度扫描和离线下载是后续产品能力，不应通过引入闭源或外置播放内核绕过当前边界。
- 账号 token 保存在系统凭据存储，服务器专属 token 只保留在 Rust 状态中；PIN IPC 仅返回 `authenticated`。PMS 数据、封面和音频上游请求都由 Rust 用 Header 鉴权。WebView 的音频与封面地址都是 `127.0.0.1` 随机端口上的短期高熵 ticket URL，其中不含 PMS 地址、媒体路径、缓存键或 `X-Plex-Token`；音频代理支持 GET/HEAD、单段 HTTP Range，并在已发现的本地、远程与 Relay 连接间回退，封面代理只读取已经校验的本地磁盘缓存。loopback 只是安全传输边界：原始媒体来自 PMS Part endpoint，固定码率转换来自 PMS universal transcode，客户端都只转发字节流。
- 原生退出入口会先发送退出前事件，让播放器立即保存队列与进度，再在收到确认或短超时后结束进程；关闭主窗口只最小化并继续播放，不会误结束播放。
- 客户端只播放服务器已经授权给当前账号的内容。支持免费账号访问已共享的 Music 库，不代表绕过 Plex ACL、服务端限制或特定功能的订阅要求。

进一步的播放核心和安全演进见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 许可

项目代码采用 MIT。Plex、Plexamp 及其商标属于各自权利人。用户需要自行拥有或获授权访问相应 Plex Media Server 内容。
