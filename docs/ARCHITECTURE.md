# 架构与演进

本文描述 Cadilume（Bundle ID：`top.codeh.cadilume`）与第三方 Plex Media Server 的互操作架构；文中的 Plex、PMS 与 Plexamp 均指外部服务、协议或 clean-room 研究对象，不是 Cadilume 的产品名。

## v0.1 当前实现

```text
React / Tauri WebView
  ├─ Music 资料库、搜索、普通/智能/只读音频歌单、队列与设置
  ├─ DualAudioPool + Media Session + 独立音量
  ├─ 两种展开播放器、主窗口中央歌词层与进度同步
  └─ Windows Audio Output Devices 适配；macOS 输出交给系统
          │ typed Tauri commands / events
Rust / Tauri
  ├─ Plex PIN、Keychain / Credential Manager 与 resources 发现
  ├─ per-server token、PMS 白名单请求、歌单读写与连接重试
  ├─ 歌词读取、授权隔离的封面磁盘缓存
  ├─ 127.0.0.1 高熵票据流代理、timeline 与 scrobble
  └─ 原生窗口、Dock/托盘恢复与原生菜单退出
```

该阶段优先保证共享账号访问、仅暴露 Music 类资料库、普通/智能/只读音频歌单读取与播放、普通可写歌单创建与写入、桌面播放与窗口生命周期。浏览器开发模式使用演示数据，账号和 PMS 请求只在 Tauri 桌面运行时生效。

## Plex 数据与权限边界

- Plex PIN 原始响应只在 Rust 中解析。`poll_pin` 将 `authToken` 写入 macOS Keychain 或 Windows Credential Manager 后，IPC 只返回 `id`、`code`、`expiresIn` 和 `authenticated`；React / WebView 不接收账号 token。
- `/api/v2/resources` 返回的每台服务器专属 `accessToken` 仅保存在 Rust 状态中；`owned:false` 家庭/共享服务器使用它自己的 token，不错误复用账号 token。
- Section 列表只接受 `type=artist`，因此 UI 只暴露 Plex 的音乐类型资料库；电影、剧集和照片库不会进入导航或查询链路。
- 歌手与专辑使用 PMS `sort=titleSort:asc`，以 500 项容器分页读取到 `MediaContainer.totalSize`；React 保留 `titleSort` 并只生成 A–Z/# 导航分组，组内不再进行 locale 排序。曲目页维持单页有界读取。
- 歌手详情的歌曲标签调用 `/library/metadata/{artist}/allLeaves`，请求排序固定为 `parentTitleSort:asc,parentIndex:asc,index:asc`，每页 50 首；前端保留 PMS 顺序并按 `ratingKey` 过滤页间及页内重复。后续页失败不清空已加载数据，也不推进起点，用户重试时只重新请求失败页。
- 服务器和 Music Section 只在设置页选择；侧栏不重复放置来源选择器，而是在主导航下方常驻当前账号可读的音频歌单，账号入口位于顶部工具区。
- PMS 数据请求只允许预定义的库、搜索、歌单和播放状态等路径，并尝试已发现的本地、远程直连或 Relay 连接。
- 客户端列出普通、智能和只读音频歌单，并通过固定的 `/playlists/{id}/items` 路径读取歌曲；智能歌单每次打开都重新读取 PMS 当前结果。侧栏创建入口调用专用 Tauri command，以当前服务器 token 向 PMS `POST /playlists` 创建空白普通音频歌单；只有普通且非只读歌单进入写入选择器，并通过 `PUT /playlists/{playlistId}/items` 添加歌曲。创建与写入仍由 PMS 检查 ACL；共享账号权限不足时 UI 给出提示，不会伪装成功。
- 客户端不依据 `subscription.active` 阻止基础音乐访问，但仍服从服务器 ACL、HTTP 错误和功能级订阅限制。
- 本项目是非官方 Plex 互操作客户端；支持普通账号访问已经授权的 Music 库，不等于绕过 Plex Pass、服务器 ACL 或媒体所有权边界。

## 播放管线

### 连接分类与选择

- 连接拓扑与媒体决策是两个独立维度：“本地直连 / 远程直连 / Relay”描述 Cadilume 如何到达 PMS；“原始直放 / PMS 转码”描述 PMS 返回何种媒体流。不能从本地直连推导出“需要客户端本地转码”，也不能从远程连接推导出“一定不能原始直放”。
- Plex `/api/v2/resources` 为每条连接提供 `local` 与 `relay` 标记。Cadilume 将 `local=true` 识别为本地直连，将 `relay=true` 识别为 Plex Relay，其余可达连接显示为远程直连。
- Rust 优先排列本地、安全直连，并降低 Relay 优先级，再通过 `/identity` 探测把实际可达的连接提到首位。上游请求失败时仍会在同一服务器的候选连接间回退。
- UI 顶部显示的是服务器发现阶段的当前首选连接类型。WebView 看到的媒体地址始终是 `127.0.0.1` loopback 票据地址，因此不能根据该 URL 判断 PMS 是本地还是远程。

### 双 Audio 下一首预缓冲

`DualAudioPool` 始终拥有两个 `HTMLAudioElement`：一个是当前 active，另一个是 standby。两个元素共享独立音量、静音和 Windows sink。

```text
当前曲目 active Audio ── 播放、进度、Media Session、timeline
                         │
队列预测 ── 获取下一首 URL ── standby Audio preload=auto
                         │
自然切歌 ────────────────┴─ 复用已准备的 Audio
```

- 默认开启下一首预缓冲，可在设置关闭。
- 顺序队列预测下一项；列表循环末尾可预测队首；单曲循环无需取得另一首的 URL。
- 随机播放先从 shuffle bag 选出稳定的 pending 候选供 standby Audio 预缓冲，但不提前消费该候选；只有实际 Next 或自然切歌时才提交到随机历史，因此 Previous 后再 Next 仍可沿原历史前进。
- 这是一项降低切歌等待的 WebView 优化，不是严格 gapless、crossfade 或音频磁盘缓存。

### 媒体决策与安全代理

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
- Cadilume 客户端在任何连接拓扑下都不做音频转码。loopback 只做 Host/票据校验、鉴权隔离、Range 转发和连接回退，不解码、不重新编码。原始质量读取 PMS Part；需要兼容转换或降码率时，由 PMS 的 universal transcode endpoint 生成 320/256/192 kbps MP3，Cadilume 只转发响应。即使 PMS 与 Cadilume 位于同一台 Mac，这仍然是 PMS 服务端转码，而不是客户端转码。
- 自动质量在本地连接使用原始流，远程直连请求 PMS 生成 320 kbps，Relay 请求 PMS 生成 192 kbps。遇到播放兼容失败时，客户端根据当前有效质量向下请求 320 → 256 → 192，不重复同一档位，也不会反向升档。
- 这一层是授权隔离和 WebView 流式播放边界，当前不是音频离线缓存或 Range 磁盘缓存。

### 当前队列、随机与会话

- `repeat=off` 时按队列顺序自然播放，到队尾停止；`repeat=all` 只回到当前队列队首；`repeat=one` 只在媒体自然结束时重播当前曲目。手动上一首/下一首仍可在当前队列中导航。
- 随机播放使用 shuffle bag，同一轮不重复；Previous 按已播放的随机历史回退。随机和循环都不会离开创建当前播放上下文时的队列，不会自动接续另一张专辑或歌单。
- 本地会话以版本化、最多 500 首的精简形式保存服务器、音质、队列、当前曲目/下标、进度、随机与循环模式；不保存 token、ticket 或已解析的音频 URL。会话 30 天后失效，恢复时不自动播放，登出时删除。

## 多平台播放与歌词边界

- `src/musicGateway.ts` 是播放器与歌词的唯一 provider 入口：`MusicProviderGateway` 固化 provider ID、能力声明、`MusicLibraryGateway`、`PlaybackGateway`、`LyricsGateway` 和统一错误映射。`usePlayer` / `useLyrics` 不直接调用 Plex API。
- 当前只有 `plexMusicGateway` 实现该契约。它在本机回环流、timeline、scrobble、歌词和“跨设备历史点击后重新读取歌曲”之间转译 PMS 数据；队列与歌词 UI 只消费可播放歌曲和通用歌词结构，不持有服务端 token、PMS URL 或协议分支。
- `MusicLyricsPayload` 是 provider 已翻译后的可移植歌词形状；LRC、SRT、VTT、纯文本和毫秒时间轴归一逻辑不依赖 Plex 名称。Plex 类型别名仅为当前兼容层，不是新 adapter 的约束。
- 后续其他平台 adapter 必须独立提供认证、资料库、可播放媒体、timeline/scrobble、歌词和错误映射；当前不添加 URL、token 存储、登录入口、网络请求或兼容性声明。琥珀金、雨林绿、澄海蓝仅是 Cadilume 视觉预设，永不选择或切换 provider。
- Plex Companion controller / receiver 不属于该边界的当前能力，`canControlCompanion=false` 只用于显式保留未来能力位，不代表已经实现发射或接收。

## 平台输出

### macOS 系统输出边界

- 按当前产品决定，Cadilume 不提供应用内无线输出入口，不调用 WebKit 播放目标选择器，也不维护无线目标状态。
- macOS 的输出选择与路由恢复完全由系统管理；Cadilume 的双 Audio 池在所有 macOS 输出场景下使用相同的预缓冲、切换、暂停与恢复逻辑。

### Windows 输出设备

- 能力检测通过后使用 `enumerateDevices()` 列出音频输出，并用 `HTMLMediaElement.setSinkId()` 同时设置 active 和 standby Audio。
- “系统默认”使用空 sink ID；自定义选择持久化。`devicechange` 触发刷新，设备丢失或设置失败时自动回退系统默认。
- `selectAudioOutput()` 只在 WebView2 实际提供时显示为系统选择器增强，不作为基础依赖。
- 不支持 `setSinkId()` 时仍提供 `ms-settings:apps-volume`，让用户在 Windows 音量合成器中单独指定 Cadilume 输出。
- 这不是 Rust 原生 WASAPI 设备管理；USB、蓝牙、HDMI、默认设备切换、热插拔和不同 WebView2 版本必须在 Windows 真机验收。

## 歌词界面

- Rust 按 PMS metadata 中 `Part.Stream` 的原始顺序寻找歌词流，使用每台服务器 token 拉取并解析 Plex JSON/XML 响应或返回原始歌词文本；首条失败时再按服务器顺序尝试下一条，不在客户端重排 provider。
- React 继续解析 LRC、SRT、VTT 与纯文本并归一成时间轴；PMS `startOffset/endOffset` 的毫秒边界不取整到秒。播放期间以活动 Audio 的 `currentTime` 约每 50ms 发布一次进度，并保留 `timeupdate` 兜底，不加入固定正负 delay。
- 无时间轴的纯文本歌词可阅读但不会伪造自动步进；确认没有非空歌词行时禁用底栏歌词按钮。切歌通过服务器与 rating key 隔离异步结果，不会短暂显示上一首歌词。
- 底栏歌词按钮直接切换主窗口中央歌词层；该层占据标题栏与固定播放器之间的完整可用高度，不重排资料库内容、没有遮罩或关闭按钮，切歌时独立滚动容器复位；切到无歌词曲目后自动收起。
- 底部播放栏可向上展开“黑胶”或“封面”完整播放器；歌词/播放队列使用播放器骨架内的互斥右侧内容分栏，与左侧播放视觉并列，不复用主窗口右栏、不呈现为浮动卡片，也不增加第二个关闭入口。时间轴歌词继续由活动 Audio 的真实进度驱动，纯文本歌词保持静态。
- 当前不创建独立桌面歌词窗口，也不在托盘/菜单栏保留桌面歌词入口。

## 封面缓存

```text
接近可视区域（rootMargin 320px）
  → 前端并发队列（最多 6 个请求）
  → Rust /photo/:/transcode + X-Plex-Token Header
  → 校验 MIME、内容长度和 12 MiB 上限
  → SHA-256(authorization token + serverId + path + width + height)
  → app_cache_dir/cadilume/artwork 原子写入
  → 签发独立的 /artwork/<64hex> 本机票据
  → Rust 代理从已校验磁盘条目返回图片
```

- 前端复用进行中的封面请求，并保留一个有界的进程内请求映射；浏览器自身仍使用图片 lazy loading。票据因过期或磁盘淘汰加载失败时，每张封面最多重新申请一次。
- 授权 token 仅作为 SHA-256 输入，不会出现在文件名或文件内容；同一 PMS 在不同授权下使用不同缓存键，登录账号变更或登出时还会清理封面缓存。
- 磁盘条目包含版本标记、MIME 与内容，自校验失败时丢弃后重新拉取；缓存目录拒绝符号链接越界。
- 单图原始内容限制 12 MiB，缓存总量限制 512 MiB。命中会刷新文件修改时间，写入新条目前按该时间从旧到新近似 LRU 淘汰。
- 音频和封面使用独立的有界票据注册表；大量专辑封面不会淘汰正在播放或预缓冲的音频地址。登录切换、登出会撤销全部票据，`clear_cache` 只撤销封面票据并清空封面缓存。
- 设置页通过 `cache_status` 显示文件数和大小，通过 `clear_cache` 清空封面缓存。
- 当前 React 封面渲染链路把图片 token、PMS 地址、图片路径和磁盘缓存键都留在 Rust 边界内；WebView 只收到本机端口和随机票据。

## 窗口、托盘与主题

- 主窗口默认尺寸和最小尺寸都固定为 `1280×800`，不允许继续缩小。macOS 保持 `decorations: true`、`titleBarStyle: Overlay`、`hiddenTitle: true` 与原生阴影，不启用透明窗口或私有 API；系统标题文字不可见，但原生交通灯、圆角、阴影、最小化、缩放和全屏行为都保留。
- React 只提供一层 52px 自定义顶部工具栏：`--app-titlebar-height` 是 CSS 唯一高度来源，macOS 左侧预留 88px；专用背景层使用 `data-tauri-drag-region`，搜索框、账号和按钮位于其上且保持可交互。`src-tauri/tauri.conf.json` 的 `trafficLightPosition` 是不可引用 CSS 变量的原生配置；当前 macOS/Tauri 2.11 实测使用 `x: 16, y: 28` 时 16px 原生可访问性控件框中心位于窗口顶部 26px，恰好与 52px 工具栏中线重合。
- 关闭行为持久化为 `tray` 或 `quit`；`tray` 模式拦截关闭并隐藏主窗口，`quit` 模式进入统一的原生退出流程。macOS 的 Dock Reopen 事件与托盘/菜单栏“显示 Cadilume”都会显示、取消最小化并聚焦主窗口。
- 从窗口关闭或托盘/菜单栏退出时，Rust 先向主窗口发送 `app://before-exit`；React 立即刷新播放会话并回送确认，Rust 在收到确认或 750 ms 超时后结束进程。
- macOS 菜单栏使用独立的透明单色 18pt@2x Template 图标，由系统适配浅/深外观；Windows 通知区域继续使用应用默认图标。两端菜单提供显示主窗口、播放/暂停和退出；设置页只配置关闭行为并提供危险色“退出账号”，不再重复提供退出应用按钮。
- 主侧栏按“品牌与主导航 → 独立滚动的歌单区”组织；歌单滚动不会移动主导航、顶部工具区或固定播放器。
- 主题仅保留浅色与深色：首次启动读取系统当前外观，随后由右上角的两态开关持久化；共享 CSS token 保持同一信息层级。

## v0.2 原生播放核心

WebView 音频已能提供 Windows sink 选择和下一首预缓冲，但不应被描述为正式版的最终播放引擎。窗口隐藏后的调度、严格 gapless、完整系统媒体面板、音频 Range 缓存和设备恢复需要由原生核心掌握。

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

- macOS：arm64 + x86_64，Universal DMG，Developer ID 签名与 notarize；验证连续切歌、暂停恢复以及系统输出变化后应用播放状态稳定。专用 DMG 脚本在成功、失败或可捕获中断后都清理 `bundle/macos/Cadilume.app`，避免构建中间包继续被系统检索，只保留 DMG。
- Windows：Windows 10/11 x64 原生 CI 构建 NSIS，使用系统 WebView2 bootstrapper，Authenticode 签名；验证 `setSinkId`、音量合成器、USB/蓝牙/HDMI、热插拔、休眠恢复和系统媒体键。
- 两个平台都要验证本地直连、远程直连与 Relay，并使用 `owned:false` 的授权 Music 库进行共享账号回归。
