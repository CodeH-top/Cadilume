# 架构与演进

本文描述 Cadilume（Bundle ID：`top.codeh.cadilume`）与第三方 Plex Media Server 的互操作架构；文中的 Plex、PMS 与 Plexamp 均指外部服务、协议或 clean-room 研究对象，不是 Cadilume 的产品名。

## v0.1 当前实现

```text
React / Tauri WebView
  ├─ Music 资料库、搜索、普通音频歌单写入、队列与设置
  ├─ DualAudioPool + Media Session + 独立音量
  ├─ 两种展开播放器、歌词进度同步与桌面歌词事件
  └─ macOS AirPlay / Windows Audio Output Devices 适配
          │ typed Tauri commands / events
Rust / Tauri
  ├─ Plex PIN、Keychain / Credential Manager 与 resources 发现
  ├─ per-server token、PMS 白名单请求、歌单写入与连接重试
  ├─ 歌词读取、授权隔离的封面磁盘缓存
  ├─ 127.0.0.1 高熵票据流代理、timeline 与 scrobble
  └─ 原生窗口、托盘/菜单栏、桌面歌词与明确退出
```

该阶段优先保证共享账号访问、仅暴露 Music 类资料库、普通音频歌单写入、桌面播放与窗口生命周期。浏览器开发模式使用演示数据，账号和 PMS 请求只在 Tauri 桌面运行时生效。

## Plex 数据与权限边界

- Plex PIN 原始响应只在 Rust 中解析。`poll_pin` 将 `authToken` 写入 macOS Keychain 或 Windows Credential Manager 后，IPC 只返回 `id`、`code`、`expiresIn` 和 `authenticated`；React / WebView 不接收账号 token。
- `/api/v2/resources` 返回的每台服务器专属 `accessToken` 仅保存在 Rust 状态中；`owned:false` 家庭/共享服务器使用它自己的 token，不错误复用账号 token。
- Section 列表只接受 `type=artist`，因此 UI 只暴露 Plex 的音乐类型资料库；电影、剧集和照片库不会进入导航或查询链路。
- PMS 数据请求只允许预定义的库、搜索、歌单和播放状态等路径，并尝试已发现的本地、远程直连或 Relay 连接。
- 客户端只列出非智能的普通音频歌单，并通过 `PUT /playlists/{playlistId}/items` 添加曲目。写入仍由 PMS 检查 ACL；共享账号权限不足时 UI 给出提示，不会伪装写入成功。
- 客户端不依据 `subscription.active` 阻止基础音乐访问，但仍服从服务器 ACL、HTTP 错误和功能级订阅限制。
- 本项目是非官方 Plex 互操作客户端；支持普通账号访问已经授权的 Music 库，不等于绕过 Plex Pass、服务器 ACL 或媒体所有权边界。

## 播放管线

### 双 Audio 下一首预缓冲

`DualAudioPool` 始终拥有两个 `HTMLAudioElement`：一个是当前 active，另一个是 standby。两个元素共享独立音量、静音、Windows sink 和 AirPlay 声明。

```text
当前曲目 active Audio ── 播放、进度、Media Session、timeline
                         │
队列预测 ── 获取下一首 URL ── standby Audio preload=auto
                         │
自然切歌 ────────────────┴─ 复用已准备的 Audio 或 URL
```

- 默认开启下一首预缓冲，可在设置关闭。
- 顺序队列预测下一项；列表循环末尾可预测队首；单曲循环无需取得另一首的 URL。
- 随机播放先从 shuffle bag 选出稳定的 pending 候选供 standby Audio 预缓冲，但不提前消费该候选；只有实际 Next 或自然切歌时才提交到随机历史，因此 Previous 后再 Next 仍可沿原历史前进。
- AirPlay 路由绑定具体媒体元素。检测到无线目标后，切歌保留 active Audio，仅复用预取 URL，避免交换元素导致路由丢失。
- 这是一项降低切歌等待的 WebView 优化，不是严格 gapless、crossfade 或音频磁盘缓存。

### 音频地址与安全边界

`stream_url` 不再返回 PMS 直连地址，而是在 Rust 状态中保留服务器、媒体路径、质量和短期会话，向 WebView 只发放本机 URL：

```text
HTMLAudioElement
  → http://127.0.0.1:<随机端口>/stream/<64 个十六进制字符的高熵票据>
  → Rust 校验 Host、票据、TTL、Range / If-Range
  → 用 X-Plex-Token Header 请求 PMS Part 或 universal transcode
  → 以流式响应返回 WebView
```

- 代理同时支持 GET 和 HEAD，转发单段 bytes Range / If-Range，并保留 `Content-Range`、`Accept-Ranges`、ETag 等媒体响应头。
- 每次上游请求按 Rust 缓存的连接顺序尝试本地、远程直连与 Relay；固定码率转码还会在现代 universal endpoint 之间回退。
- WebView URL 不包含 PMS 主机、库路径或 token；票据有数量、未使用时间、活跃空闲和绝对寿命限制，登出会立即撤销全部票据。
- 这一层是授权隔离和 WebView 流式播放边界，当前不是音频离线缓存或 Range 磁盘缓存。

### 当前队列、随机与会话

- `repeat=off` 时按队列顺序自然播放，到队尾停止；`repeat=all` 只回到当前队列队首；`repeat=one` 只在媒体自然结束时重播当前曲目。手动上一首/下一首仍可在当前队列中导航。
- 随机播放使用 shuffle bag，同一轮不重复；Previous 按已播放的随机历史回退。随机和循环都不会离开创建当前播放上下文时的队列，不会自动接续另一张专辑或歌单。
- 本地会话以版本化、最多 500 首的精简形式保存服务器、音质、队列、当前曲目/下标、进度、随机与循环模式；不保存 token、ticket 或已解析的音频 URL。会话 30 天后失效，恢复时不自动播放，登出时删除。

## 平台输出

### macOS AirPlay

- 两个 Audio 都设置 `x-webkit-airplay="allow"`。
- 播放设备浮层调用 active Audio 的 `webkitShowPlaybackTargetPicker()`，并监听 `webkitcurrentplaybacktargetiswirelesschanged` 更新状态。
- WKWebView 未暴露选择器、调用失败或用户希望系统统一管理时，UI 引导到 macOS“控制中心 → 声音”。
- AirPlay 选择与实际路由由 macOS 管理；同网段真实接收器、切歌、睡眠唤醒和路由恢复仍需 macOS 真机验收。

### Windows 输出设备

- 能力检测通过后使用 `enumerateDevices()` 列出音频输出，并用 `HTMLMediaElement.setSinkId()` 同时设置 active 和 standby Audio。
- “系统默认”使用空 sink ID；自定义选择持久化。`devicechange` 触发刷新，设备丢失或设置失败时自动回退系统默认。
- `selectAudioOutput()` 只在 WebView2 实际提供时显示为系统选择器增强，不作为基础依赖。
- 不支持 `setSinkId()` 时仍提供 `ms-settings:apps-volume`，让用户在 Windows 音量合成器中单独指定 Cadilume 输出。
- 这不是 Rust 原生 WASAPI 设备管理；USB、蓝牙、HDMI、默认设备切换、热插拔和不同 WebView2 版本必须在 Windows 真机验收。

## 歌词与桌面歌词

- Rust 从曲目 metadata 中寻找歌词流，使用每台服务器 token 拉取并解析 Plex JSON/XML 响应或返回原始歌词文本。
- React 继续解析 LRC、SRT、VTT 与纯文本并归一成时间轴；播放进度更新 active 行，歌词面板自动滚动，用户可点击有时间戳的行 Seek。
- 无时间轴的纯文本歌词可阅读，但不会伪造自动步进。
- 主窗口通过 Tauri 事件把当前行、下一行、播放状态和曲目信息同步到独立 always-on-top 桌面歌词窗口。
- 底部播放栏可向上展开完整播放器：“黑胶 + 专辑封面 + 滚动歌词”与“全屏专辑背景 + 歌词”两种模式可切换并记忆，歌词行可点击 Seek。
- 桌面歌词可从展开播放器或托盘/菜单栏显示、隐藏；它使用透明 always-on-top 窗口、卡拉 OK 扫色和本地插值，悬停时显示玻璃控制条，支持拖动与固定位置。“固定”只禁止拖动，不伪装系统 click-through；关闭只隐藏该窗口，不结束主程序。

## 封面缓存

```text
接近可视区域（rootMargin 320px）
  → 前端并发队列（最多 6 个请求）
  → Rust /photo/:/transcode + X-Plex-Token Header
  → 校验 MIME、内容长度和 12 MiB 上限
  → SHA-256(authorization token + serverId + path + width + height)
  → app_cache_dir/cadilume/artwork 原子写入
  → Data URL 返回 WebView
```

- 前端复用进行中的封面请求，并保留一个有界的进程内请求映射；浏览器自身仍使用图片 lazy loading。
- 授权 token 仅作为 SHA-256 输入，不会出现在文件名或文件内容；同一 PMS 在不同授权下使用不同缓存键，登录账号变更或登出时还会清理封面缓存。
- 磁盘条目包含版本标记、MIME 与内容，自校验失败时丢弃后重新拉取；缓存目录拒绝符号链接越界。
- 单图原始内容限制 12 MiB，缓存总量限制 512 MiB。命中会刷新文件修改时间，写入新条目前按该时间从旧到新近似 LRU 淘汰。
- 设置页通过 `cache_status` 显示文件数和大小，通过 `clear_cache` 清空封面缓存。
- 当前 React 封面渲染链路把图片 token 留在 Rust 请求 Header，不放入 `<img src>`；WebView 收到的是 Data URL。

## 窗口、托盘与主题

- 主窗口保留系统原生装饰。关闭行为持久化为 `tray` 或 `quit`；`tray` 模式拦截关闭并隐藏主窗口，`quit` 模式进入统一的原生退出流程。
- 从窗口关闭、托盘/菜单栏或设置退出时，Rust 先向主窗口发送 `app://before-exit`；React 立即刷新播放会话并回送确认，Rust 在收到确认或 750 ms 超时后结束进程。
- macOS 菜单栏 / Windows 通知区域菜单提供显示主窗口、播放/暂停、显示/隐藏桌面歌词和退出。
- 设置页始终有明确退出按钮，避免只能通过强制结束进程退出。
- 主题支持跟随系统、浅色和深色，并通过共享 CSS token 同步主窗口与桌面歌词窗口。

## v0.2 原生播放核心

WebView 音频已能提供实用的 AirPlay、Windows sink 选择和下一首预缓冲，但不应被描述为 Windows 正式版的最终播放引擎。窗口隐藏后的调度、严格 gapless、完整系统媒体面板、音频 Range 缓存和设备恢复需要由原生核心掌握。

```text
React UI
   │ Commands / Events
PlaybackCoordinator (Rust, state authority)
   ├─ Queue / repeat / shuffle / prefetch
   ├─ PlexGateway / decision / local ticket proxy / Range cache
   ├─ AudioEngine trait
   │    ├─ libmpv adapter (fast path)
   │    └─ pure Rust engine (future)
   ├─ MediaSessionPort
   │    ├─ macOS Now Playing + RemoteCommandCenter
   │    └─ Windows SMTC
   └─ CredentialStore / CacheManager
```

优先评估 `libmpv`：编解码、HTTP Range、独立软件音量、预取与 gapless 能力成熟；但公开分发前必须处理 GPL/LGPL 构建与动态库签名。纯 Rust 备选为 CPAL + Symphonia + ring buffer + resampler，许可和包体更清晰，但 AAC/M4A gapless 与网络管线实现成本更高。

系统媒体会话可用 `souvlaki` 起步，并在 `MediaSessionPort` 后隔离，避免依赖单一 crate。

## 后续 Plex 能力

- 正式 JWT PIN、设备密钥与 token 刷新。
- `/media/providers` Feature/Pivot 驱动浏览。
- PMS playQueues：重复项 ID、移动、增删、shuffle/unshuffle。
- universal decision 与客户端音频 Profile。
- 实验性 Managed User Home 切换。
- ReplayGain、严格 gapless、crossfade、音频 Range 缓存与原生输出设备恢复。

## 平台发布与验收

- macOS：arm64 + x86_64，Universal DMG，Developer ID 签名与 notarize；使用真实 AirPlay 接收器验证选择、连续切歌、暂停恢复和系统路由切换。
- Windows：Windows 10/11 x64 原生 CI 构建 NSIS，使用系统 WebView2 bootstrapper，Authenticode 签名；验证 `setSinkId`、音量合成器、USB/蓝牙/HDMI、热插拔、休眠恢复和系统媒体键。
- 两个平台都要验证本地直连、远程直连与 Relay，并使用 `owned:false` 的授权 Music 库进行共享账号回归。
