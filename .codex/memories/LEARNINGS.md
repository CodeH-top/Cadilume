# LEARNINGS

## 2026-08-07 — 原生播放引擎替换完成（dev 分支，Phase 0-6）

- 播放链路：PMS 票据 → Rust 流代理 → 渐进下载缓存（ProgressiveFile 等待式
  Read+Seek，头部 256KB 就绪即播）→ rodio（cpal+symphonia）出声；进度/结束/
  远程命令事件经 native-audio://event 回传前端。
- 队列权威已迁入 Rust：tracks/currentIndex/repeat/shuffle 决策在
  NativeAudioEngine.queue，自然结束由事件线程决策并 emit queue-item；前端每次
  加载前 nativeQueueSet 同步快照，next/previous 走 Rust 命令。
- WebView 播放退役完成：usePlayer native-only，删除 DualAudioPool/预缓冲/
  MediaError 回退约 1400 行及对应单测（163 项全绿）。开发态不再创建 HTMLAudio。
- 缓存：512MB LRU（mtime 淘汰、.part 优先清理）；ahead 预取下一首（预缓冲开关
  开启时 native_audio_precache 后台下载，切歌命中本地缓存减少间隙）。
- 系统集成：macOS MPNowPlayingInfoCenter + MPRemoteCommandCenter；Windows
  SystemMediaTransportControls（windows crate 0.58，已跨 target 类型检查，
  完整构建待 Windows 环境）。前端处理 remote 命令事件（play/pause/toggle/next/
  previous/seek）。
- 凭证隔离：debug 构建只读写 ~/.cadilume-dev-token（600），release 只用
  Keychain；.gitignore 忽略密钥文件；开发态窗口启动隐藏（visible:false +
  不 reveal），用户点 Dock/托盘显示，避免热重载抢焦点。
- 遗留验证项：严格 gapless（当前为预取减间隙 MVP）、Windows 实机 SMTC、
  真实 PMS 高频切歌 20+ 次/歌词对时/seek/后台播放验收。

## 2026-08-07 — UI/业务修复要点（dev 44e1b9d）

- 歌单内删除歌曲报“请至少选择一首歌曲”根因：PMS `/playlists/{id}/items` 返回的
  `playlistItemID` 是**数字**，`normalizePlexItems` 未转字符串，删除命令的
  `isCleanPlexIdentifier`（依赖 `value.length`）把数字过滤成空数组。修复：
  `optionalString` 支持数字转字符串，`removeTracksFromPlaylist` 先 `String()` 再校验。
- `SourceSyncOverlay` 是全屏黑透遮罩（`inset:0` + 68% 背景 + blur），与右上角通知
  同时出现时会被误认为“消息提醒自带 mask”；已改为无遮罩顶部小卡片。
- 新建歌单插入左侧列表时三处 `setPlaylists` 都用了头部插入，用户要求追加到底部；
  新增歌曲到歌单后需 `loadPlaylistList()` 刷新数量。
- 搜索页：PMS `/hubs/search` 的 hub 标题是英文，前端按 `hub.type` 映射
  artist→歌手 / album→专辑 / track→歌曲；空 items 的 hub 需过滤；搜索 loading
  之前被 `view !== "search"` 条件排除；返回按钮用 `navigate(-1)`。

## 2026-08-07 — 原生播放 spike：kithara 失败、rodio 验证通过（决策更新）

- kithara-play/firewheel 在 Tauri 进程里播放**本地文件或真实 PMS 流都会卡死**：
  解码器只产出固定 11×4096 帧（约 1.02 秒）或 1×4096 帧后停止，播放中=false，
  无 PrerollCompleted/错误事件；扬声器只有约 1 秒“滋啦”噪声。cargo test 进程
  播放同样文件却正常推进——问题在 kithara 的 firewheel/cpal 管线与 Tauri 进程
  的兼容性，不是解码/HTTP 层。已放弃 kithara 作为当前路线（保留待上游稳定后
  复评），spike 引擎改用 rodio。
- rodio 0.22 在 Tauri 进程验证通过：cpal 输出 + symphonia 解码，真实 PMS 流经
  “代理下载落盘 → 播放本地文件”链路连续播放正常、无卡顿；设备自检确认
  cpal 能打开默认输出（Shokz OpenDots，44100Hz F32）。rodio 0.22 依赖
  symphonia 0.5.5（不是 0.6）。
- rodio 0.22 API 备忘：`DeviceSinkBuilder::from_default_device()?.open_stream()`
  → `MixerDeviceSink`，`Player::connect_new(sink.mixer())`；
  `append/play/pause/clear/try_seek/get_pos/set_volume/empty/is_paused/len`；
  `Decoder::new(File)` 后取 `total_duration()` 需 `use rodio::Source`。
- 磁盘缓存方案验证通过：Rust 侧用 reqwest 下载 loopback 票据 URL 全量落盘到
  `app_cache/native-audio/downloads/{ratingKey}.{ext}`（按 Content-Type 推断
  扩展名），重复播放同曲目直接命中；这正是后续 Plexamp 式 ahead 缓存的基础。
- 原生引擎默认音量按用户要求设为 20%（比 WebView 播放明显更响的问题）。
- BASS（Un4seen）许可结论：闭源，非商业个人免费，商业产品约 $120 起且插件另算；
  Plexamp 由 Plex 公司商业使用（付费许可）。Cadilume 是 MIT 开源并要分发，
  不采用 BASS；rodio/cpal/symphonia（MIT/Apache + MPL）无此负担。
- 2026-08-07 分支策略：`main`（稳定基线）与 `webview`（WebView 播放基线）都指向
  `d77f732`；后续开发全部在 `dev` 分支。用户要求先修基础 bug/UI，完成后再按
  `docs/NATIVE_AUDIO_ENGINE_UPGRADE_PLAN_2026-08-07.md` 的 Phase 1→6 落盘内核。
  spike 测试按钮与 DevTools 钩子已删除（Rust AudioEngine 命令骨架保留待用）。

## 2026-08-06 — 原生播放引擎选型：许可与体积事实（用户要求独立可用，禁系统依赖）

- libmpv 不是 MIT：mpv 本体是 GPLv2+ / LGPLv2.1+ 双许可（只有 `-Dgpl=false`
  LGPL 构建才适用 LGPL），Rust `libmpv` crate 是 LGPL-2.1，
  `tauri-plugin-libmpv` 是 MPL-2.0 且 macOS “Not tested”，其 setup 脚本在 macOS
  明确要求 `brew install mpv`——违反用户“禁止系统安装依赖”的约束。
- 体积实测（2026-08-06）：zhongfly Windows `mpv-dev-lgpl-x86_64` 压缩包
  26.6MB，解压 `libmpv-2.dll` 95MB（单架构，静态内含 FFmpeg）；aarch64 与 x86_64
  需分别打包。macOS 没有官方 LGPL 预编译 dylib，Homebrew 是 GPL 且属系统安装。
- 纯 Rust 实测：`rodio 0.22.2`（默认 playback+flac+mp3+mp4/vorbis/wav）+ cpal +
  symphonia 的 release 探测二进制仅 2.5MB（arm64），全部静态链接，无外部 dylib/dll。
  rodio 0.22 API 已从 `OutputStream` 改为
  `DeviceSinkBuilder::from_default_device() → open_stream() → mixer()` +
  `Player::append/play/pause/try_seek/set_volume`；`Decoder::new` 走 symphonia。
- 许可：rodio/cpal 为 MIT OR Apache-2.0；symphonia 0.6.0 为 MPL-2.0（文件级弱
  copyleft，兼容 MIT 应用，修改其源文件才需保持 MPL，发行需附许可文本）；
  miniaudio 为 Unlicense/MIT-0 双许可。symphonia 0.6.0 解码范围：AAC-LC、ALAC、
  FLAC、MP1/2/3、PCM、Vorbis、ADPCM；不含 Opus/WMA/APE/DSD/HE-AAC。
- 外部动态库（即使打进安装包）的额外成本：macOS 每个 dylib 需签名/公证、@rpath、
  双架构需 lipo 后重签；Windows DLL 需按 x86_64/aarch64 分别发布、处理运行时依赖，
  均显著大于纯静态方案的“零外部文件”。本约束下原生内核默认走纯 Rust 静态方案。
- JS 端现成方案分级（2026-08-06 补充）：
  - howler.js / SoundJS 等只是 Web Audio/HTMLAudio 封装（MIT），不改变 WebView
    播放边界，解决不了 MediaError code 4、后台播放、SMTC、磁盘缓存。
  - `@wasm-audio-decoders`（eshaz，MIT）是真解码：mpg123/aac/flac/opus 等 WASM
    解码器，mpg123 压缩后约 76.6 KiB，浏览器/Web Worker 可用，可绕过 WebKit 对
    格式的原生支持限制（可消除 codec 级 error4），mpg123 已支持 gapless；但仍跑在
    WebView 内，后台/隐藏窗口/Now Playing/磁盘缓存边界未变。
  - Tauri 桌面端没有成熟的“一键音频插件”；现成的是底层 Rust 引擎：
    rodio 0.22（MIT OR Apache-2.0，稳定）+ kithara（zvuk，MIT OR Apache-2.0，
    AVPlayer 级完整引擎：progressive HTTP + 磁盘 LRU 缓存 + gapless +
    crossfade + HE-AAC/Opus + macOS AudioToolbox 硬解；当前 0.0.1-alpha4、
    MSRV 1.89，未到生产成熟度）。所谓“自研内核”实际只需写 Tauri 集成胶水
    （命令/事件/缓存策略/SMTC），解码与输出引擎都是现成库。
- 2026-08-06 kithara 实地检查（clone 到 /tmp/kithara-check 实测）：
  - 仓库创建 2026-02-11，几乎每日提交（2026-08-06 仍在推），有 nightly 发布与
    v0.0.1-alpha1..alpha4；最新提交 63ad1e5 是大型 CI 修复（MSRV 提到 1.92、
    修通 Windows lane、macOS CI 改用 tart VM）；stars 仅 5，仍属 alpha。
  - 工作区 28 个 crate，可按需裁剪；核心 API 是门面 `Resource`/`ResourceConfig`
    （builder 必填 store/byte_pool/pcm_pool）+ `kithara-play::PlayerImpl`
    （多槽位、交叉淡化、EQ、自动前进、prefetch）。
  - 实测最小可用组合（file+symphonia+backend-cpal+client-reqwest+tls-rustls）
    release 二进制 13MB（arm64）；依赖 firewheel 0.10（MIT OR Apache-2.0）+
    cpal + symphonia 0.6 + reqwest 0.13.4 + rustls 0.23.40 + aws-lc-sys 0.41
    （Cadilume 现有 aws-lc-sys 0.43，接入时可能同时编译两个版本）。
  - 当前 feature 组合有坑：`client-reqwest` 必须同时开 `tls-rustls`（kithara-net
    无条件调用 `danger_accept_invalid_certs`）；纯 file 后端不带任何 HTTP 后端时
    kithara-net 编译失败（15 errors）。接入时只能按“完整 HTTP 组合”先跑通。
  - 许可确认：仓库 LICENSE-MIT + LICENSE-APACHE（MIT OR Apache-2.0）；
    fdk-aac（LGPL+专利）只在 kithara-decode 默认启用，门面 `kithara` 默认关闭，
    裁剪后不引入；ffmpeg 只在 kithara-encode，播放链路不依赖。
  - 平台：macOS/Windows/iOS/Android/WASM 均有 CI lane；Windows ARM64 需排除
    libfdk（CI 已处理）。接入风险主要是 alpha 稳定性与 feature 组合维护，需
    pin 版本并先做真实 PMS 流 spike。
  - 2026-08-06 alpha4 vs main 实测对比：crates.io `0.0.1-alpha4`（2026-07-01）
    落后 main 46 个提交；门面 feature 集合没有 `backend-cpal`（直接编译冲突），
    而 main 已加入；main 还包含与我们直接相关的修复：MP3 Xing tag 时长/seek
    （#127）、切码率连续性（#119）、Windows lane 编译修复。结论：spike 必须用
    main 源码并 pin 具体 commit（当前 63ad1e5），不要用 alpha4；后续生产采用
    等上游 alpha5/beta 或继续 pin main commit，Tauri 集成层应封装为薄
    `AudioEngine` 边界以便升级或回退 rodio。

## 2026-08-06 — Plexamp 缓存与高频切歌参考（clean-room 结论）

- Plexamp（Electron + React Native Web + 私有 BASS 原生音频引擎）有明确的多级缓存策略：
  - 播放队列 ahead 预缓存：Wi-Fi 默认预缓存接下来 15 首、蜂窝 5 首，按 `source-key`
    去重，逐首 `PrecacheTrack`，失败只记录不阻塞播放；预缓存同时加载 loudness/palette
    元数据。
  - 磁盘缓存上限（Node 默认 256MB）与预缓存限速（Node 默认 5 Mbps），设置页可调并可
    “Delete Caches”；还有 `preferDownloadedMedia`（优先已下载媒体）。
  - 音频实际由原生引擎（electron-media-service）输出并落盘，因此“切到已缓存歌曲”不依赖
    网络往返；`Journey.load(track,next)` 是 Sonic 跨曲预加载，不是通用 next 缓存。
- Cadilume 的 WebView/HTMLAudio 架构无法直接复刻该磁盘缓存（音频由 WebKit 拉取、不经
  Rust 代理落盘）；当前等价物是双 `HTMLAudioElement` 预缓冲下一首 + streamUrl 在途去重。
  完整复刻应落在既有“原生播放内核”路线（Rust AudioEngine + Range/磁盘缓存）上，不作为
  本轮 WebView 修补范围。
- Plexamp 连接层可借鉴且已落地：并行测试全部连接（非 relay 优先、relay 最后兜底），
  用 `/identity` 的 machineIdentifier 校验连接归属（防错连；期望值必须是 PMS 服务器
  标识 `resource.clientIdentifier`，不是客户端自身标识，否则所有连接都会被判不可达）；
  读请求遇 HTTP 500 时重新测试连接并重试一轮。对应 Cadilume 改动：
  `prioritize_reachable_connections`（并行 + 身份校验 + relay 兜底）与
  `server_request_response`（500 重测一轮）。
  对比分析文档：`docs/PLEXAMP_CACHE_CONNECTION_COMPARISON_2026-08-06.md`。

## 2026-08-06 — 高频切歌容错与日志证据

- 开发态日志证实：PMS 在快速切歌时会对 `Range: bytes=0-1` 探测返回
  `HTTP 503 text/html`（完整 range 请求随后成功），同一首歌会成对发行流票据，且 local
  连接每次先失败再切 remote。这些都是切歌 error4/卡住的候选根因，已做三层容错：
  - 前端 `setPlaybackLoading` 保证切歌 loading 至少可见 250ms（播放按钮转圈不再一闪而过）；
  - `requestStreamUrl` 对同一 server/track/quality 的 streamUrl 在途 promise 去重缓存
    5 秒，失败即删除，避免 prebuffer 与 loadAt 重复发行票据；
  - 代理对 503/429 退避 300ms 再尝试下一连接/端点；连接失败时 `demote_connection` 把
    该连接移到末尾，后续请求优先可达连接。
- 待真实复测：高频随机切歌连续 20+ 次不再出现 error4/卡住，且切歌时按钮有转圈反馈。

## 2026-08-06 — “歌单可删除”指删除歌单内的歌曲；用 Popconfirm 二次确认

- 用户澄清：普通歌单“可以删除”指的是从歌单中移除歌曲，不是删除整个歌单；右侧栏不应出现
  删除歌单入口。误解产物（`delete_playlist` 命令、右侧删除按钮、删除确认对话框）已整套移除。
- Plex 删除歌单项用 `DELETE /playlists/{playlistId}/items/{playlistItemID}`，
  `playlistItemID` 只出现在 `/playlists/{id}/items` 行上；批量删除必须串行并返回
  成功/失败列表，与批量添加同一 Rust/Tauri 边界。
- 歌单详情歌曲行的删除按钮复用播放按钮的交互语义：默认时长列显示时长，整行 hover 时在
  时长列位置替换为删除图标；点击后弹出类似 Ant Design Popconfirm 的 portal 气泡
  （触发按钮上方优先、空间不足转下方），带确认/取消、busy 态、Escape/外部点击/滚动关闭。

## 2026-08-06 — 播放链路调试日志通道

- Cadilume 之前没有播放日志：Rust 流代理只有启动日志，WKWebView console 不会进入 Tauri
  开发终端。排查切歌 `MediaError code 4` 时先建立两条日志：
  - Rust 代理在发行票据、每次上游尝试、成功转发、全部失败时 `eprintln!`（脱敏：只输出
    server 前 8 位、质量、连接类型、端点类型、HTTP 状态、Content-Type，不输出路径/token/
    票据/曲目标识）。
  - 前端 `playbackLog()` 通过 `emit("playback://log", ...)` 上报，Rust
    `app.listen("playback://log", ...)` 转发到终端；Tauri 2 中 `AppHandle::listen` 需要
    `use tauri::Listener`，且 `app` 是 `&mut App` 时闭包事件类型需显式标注。
- 覆盖的关键事件：加载请求、预缓冲命中、流地址取得、加载异常、播放失败决策、兼容串流
  成功/失败、当前/过期 source 媒体错误、播放启动超时、自然结束、切歌、队列结束。

## 2026-08-06 — 歌词列表首句顶格与全局滚动条统一

- 歌词容器之前用 `padding: 40%`（弹出层）和 `34%`（展开播放器）制造“当前行居中”，副作用是
  第一句不在顶部、打开时首行不可见，用户会误以为歌名/首句被过滤。改为固定小顶部 padding
  后首句顶格，滚动定位仍由 `getPlexLyricsScrollTop` 控制。
- 用户要求全局滚动条统一：用 `* { scrollbar-width: thin; scrollbar-color: ... }` 加
  `*::-webkit-scrollbar` 一套 muted 灰色规则，删除歌词/队列/通知/路由页等各自 accent 色
  规则；仅功能性隐藏（如字母索引 `scrollbar-width: none`）保留。

## 2026-08-06 — MediaError code 4 的代理根因与 Plex 音乐转码参数

- WKWebView 的 `MediaError code 4` 不一定是原文件不支持：PMS 在转码/直放失败时可能返回
  “HTTP 200 + 非音频 Content-Type”（典型 `text/html` 错误页），本机流代理若只按状态码
  成功就把响应原样转发，WebView 会以 code 4 拒绝。代理必须校验上游 `Content-Type`
  为 `audio/*` 才转发，否则记录该次尝试并继续尝试下一个端点/连接；全失败时返回脱敏诊断
  （已尝试端点数、请求/实际质量、连接类型、端点类型、HTTP 状态、Content-Type），
  不输出 PMS URI、路径、token、票据或曲目标识。
- Plex Web 自己的音乐 HTTP 转码使用 `/music/:/transcode/universal/start`（`protocol=http`
  不追加扩展名），`start.mp3` 只是兼容形态；musicProfile 的
  `add-transcode-target(type=musicProfile&context=streaming&protocol=http&container=mp3&audioCodec=mp3)`
  不带 `replace=true`（`replace=true` 只出现在视频 `add-limitation`）。补充
  `fastSeek=1&container=mp3&audioCodec=mp3&audioChannels=2` 与既有
  `directPlay=0&directStream=0&directStreamAudio=1&copyts=1&X-Plex-Chunked=1` 组合可覆盖
  常见服务端版本。
- WebKit 对无 Content-Length 的 chunked 转码流常报 `audio.duration = Infinity`。播放器 UI
  必须用“有限媒体时长 > 曲目元数据时长”的归一函数（`usableDurationSeconds`）显示进度与总
  时长，否则底栏出现 `Infinity:NaN`、进度条停在 0、展开播放器时间轴失效，并破坏歌词末行
  边界。
- `useLyrics` 等按“播放时长”参与归一化的 hook，不要把会随媒体元数据变化的 `durationSeconds`
  放进 effect 依赖；应通过 ref 读取最新值，只以歌曲/歌词源变化触发重新获取，否则每次
  时长稳定都会重取歌词并把活动行短暂重置。

## 2026-08-05 — 局部 flex 操作区必须清除通用按钮外边距

- 播放失败提示中的主按钮继承了通用 `.primary-button { margin-top: 16px; }`，使 flex 行的交叉轴
  尺寸增大；同排的次按钮又按默认 `align-items: stretch` 被拉到整行高度，因此只有右侧按钮
  看起来异常巨大。
- 在弹窗、提示条等紧凑操作区复用通用按钮时，应同时局部重置 margin、明确统一高度，并为
  容器设置 `align-items: center`；只改次按钮尺寸无法消除由兄弟元素撑高产生的拉伸。

## 2026-08-05 — 纯图标控制必须有应用内 tooltip，不能只依赖 `title`

- 用户连续指出多个纯图标按钮缺少可见提示。`aria-label` 只解决读屏，浏览器原生 `title` 既不
  稳定也无法保证与控件中心对齐；两者都不能代替应用内 tooltip。
- Cadilume 的通用图标按钮应输出 `data-tooltip`，由共享 CSS 在 hover 和 `:focus-visible` 时显示
  居中提示；普通控件默认向上，标题栏向下。已有“暂无歌词”这类禁用态专用 tooltip 继续由
  外层状态组件负责，避免生成两层重复气泡。

## 2026-08-05 — 歌词浮层与歌词文字层级必须分开验收

- 用户纠正：“普通歌词弹窗”描述的是底部播放器控制的浮层位置、尺寸和进出方式，不等于
  要缩小歌词正文。以后遇到歌词 UI 反馈，先分别确认目标是容器几何、内容字号、滚动行为
  还是时间轴，再改代码。
- 本轮正确验收拆为两组：主/次歌词的 computed typography（`17px / 700 / 1.42` 与
  `13px / 550`），以及面板与队列的 outer geometry、动效和互斥状态。侧栏化不能自动导致
  正文降级为队列条目的字号。

## 2026-08-05 — 主题圆形揭示应裁剪旧快照而非活页面

- 为恢复从主题按钮扩散的可见动画，可以先用完整旧主题 snapshot 覆盖 live tree，应用新主题
  后让 snapshot 从覆盖全窗的圆形裁切收缩到触发点。这样新主题从触发点向外显现。
- 不要重新向 `#root` 添加 `clip-path`、mask 或 filter；WebKit 会重新合成活页面的图片层，
  导致封面、头像和旋转黑胶闪烁。实际验证应同时检查 snapshot 的 origin 和 live root 的
  `clip-path: none`。

## 2026-08-05 — 首次播放的原生 error 必须绑定当前 source

- `HTMLAudioElement` 的 `error` 事件不带加载请求身份；WebKit 在首次分配/清空 `src` 的边界可晚到一个空 source 或已替换 source 的 error。只因事件到达就触发兼容串流回退，会把正常的第一首歌误报为播放失败。
- 播放器应同时保存活动 `audio`、递增的加载 request id 和实际分配的 source；仅当三者仍对应、且归一化后的事件 source 精确匹配时才进入回退。空 source 或旧 ticket 直接忽略，真实当前 source 的网络、授权和解码错误仍按既有诊断路径处理。

## 2026-08-05 — 首播成功不能只以 `play()` Promise 为准

- WKWebView 中 `HTMLAudioElement.play()` 可能 resolve，而实际既没有 `playing` 事件也没有时钟推进；把该 Promise 当作启动完成会让首首歌永久处于假播放状态。
- 播放器应在调用 `play()` 后等待 `playing` 或可观察的 `currentTime` 推进，并设置有限超时；拒绝或超时继续复用已有的兼容串流回退，而不是静默吞掉。真实开发态可用无障碍树的“播放进度”控件验证时钟是否连续推进，且不需要记录媒体名称、服务器信息或截图。

## 2026-08-05 — 批量歌手操作的取消所有权

- 歌手级“播放 / 添加到队列 / 播放下一个 / 添加到歌单”会用共享 `AbortController` 和忙碌状态串行化整批分页读取。快速连续触发时，新动作会取消旧动作；旧动作的 `finally` 只能在它仍是 controller ref 的拥有者时清理忙碌状态，否则会把新动作的按钮错误地重新启用。
- 批量歌单写入继续保持在 Rust/Tauri 命令中按顺序执行，前端只保留失败的 rating key 供同一歌单重试；不能以 WebView 并发逐首请求替代该边界。

## 2026-08-01 — keepalive-for-react 可作为 R15 缓存底座，但不是完整路由方案

- `keepalive-for-react@5.0.11` 的 `KeepAlive` 会通过 Portal 保留 React 子树和 DOM，`activeCacheKey` 可使用 Cadilume 自己生成的 History entry id；设置 `max={Infinity}`、`maxAliveTime={0}` 可满足当前上下文不做 LRU/时间淘汰，登出或切换服务器/资料库时再用 `aliveRef.destroyAll()`。
- 该库不负责 `pushState`/`popstate`、同 URL 不同 History entry、可序列化快照、每页滚动视口、焦点恢复或 `inert`/`aria-hidden`；这些必须由 Cadilume 的 HistoryEntryCache 适配层和 RoutePage 自己完成。仅包住现有共享 `ContentView` 不能满足 R15。
- 当前锁定 React/ReactDOM 为 19.2.8，可评估 v5；用户已确认 R15 迁移到 `react-router-dom@^7` 的 `createHashRouter` + `RouterProvider`，以 `location.key` 作为运行时 entry 缓存键，并保留 `location.state` 中的 Cadilume 快照。采用前仍需移除开发态 `React.StrictMode`（上游明确警告）并做 React 19.2 + Tauri WebView 的 DOM 身份、Back/Forward、组件内 `scrollTop` 和无障碍 POC；内部滚动必须随被保留的页面 DOM 一起缓存，不再以共享 scroll Map 冒充。

## 2026-08-01 — 多歌手数据须贯穿持久化队列与开发夹具

- 播放队列快照除了传统的曲目、专辑和主歌手字段，还必须以同样的路径净化规则保存结构化 `contributors`（姓名和可选 `ratingKey`）。否则重启后 `trackArtist()` 会退化为单一 `grandparentTitle`，破坏 R12 的完整多歌手显示与可点击成员边界。
- 演示元数据的查找必须复用带 query fixture 的 `demoLibraryArtists()` / `demoLibraryTracks()`，而不是静态基础数组；否则密度或多歌手 fixture 可以在列表页显示，却不能进入详情或被元数据恢复路径解析。

## 2026-08-01 — 真实曲目歌手字段不能由专辑层级或演示夹具代替

- 用户实测纠正：即使 `Role` / `Contributor` 夹具、链接解析和恢复快照测试通过，真实多歌手曲目仍可能因未读取曲目自身的“歌曲歌手”字段而退化成单歌手。不要将这些局部回归当作真实 PMS 字段映射已闭环的证据。
- 后续先用“曲目歌手与专辑歌手不同”的已授权只读 raw PMS 元数据建立字段契约；曲目级歌手必须优先、无损贯穿所有显示与持久化路径，专辑歌手不能覆盖它。`grandparentTitle` 等层级字段的实际语义须以该契约验证，不能按字段名或演示数据猜测。
- 2026-08-04 的真实只读核对已确认该契约：`originalTitle` 是所验样本的曲目歌手，`grandparentTitle` 是不同的专辑歌手。该服务器对完整扫描结果及样本详情均未给出 `Role` / `Contributor`，因此新鲜详情与版本化队列快照必须无损保留完整 `originalTitle`，且不能回退专辑歌手。2026-08-05 用户明确覆盖此前“原文一律不拆”的显示规则：Cadilume 的 UI 解析独立于 PMS 结构化字段，必须先按精确 `" / "` 拆成成员再本地匹配；仅 `AC/DC`、`A/B`、`A /B`、`A/ B` 等非精确形式保持一个成员。该覆盖只改变显示/链接成员表示，不改变原始曲目歌手文本的持久化。

## [LRN-20260801-001] History Back 需要完整路由页缓存，不能退化为滚动恢复

**Logged**: 2026-08-01T15:57:40+08:00
**Priority**: high
**Status**: resolved
**Area**: frontend

### Metadata

- Source: user_feedback
- Scope: project
- Pattern-Key: cadilume.routing.history-scroll-cache
- Recurrence-Count: 2
- First-Seen: 2026-08-01
- Last-Seen: 2026-08-01
- Related Files: /Users/hoganchou/Documents/Work/Project/AI/cadilume/src/App.tsx, /Users/hoganchou/Documents/Work/Project/AI/cadilume/src/App.css
- See Also: FR-20260801-003

### Summary

按 route hash 保存嵌套滚动位置或缓存数据都不等于 History Back KeepAlive；每个 History entry 的完整页面实例、条目身份和无动画激活必须一起闭环。

### Details

`routeContent` 在详情切换时会重挂，reactive route key 又可能让旧 DOM 的 scroll event 写入新路由；`scrollTo({ behavior: "auto" })` 在声明 `scroll-behavior: smooth` 的元素上还会产生可见动画。因此旧实现即使有 `Map<hash, scrollTop>`，仍可能先归零后再滑回。用户进一步确认目标是保留整个页面实例：数据、分页、筛选、标签、展开、焦点、sticky 与 DOM 生命周期都不能因为进入详情而丢失；React Router 的 `<Outlet>` 也只负责渲染出口，不会自动提供这层缓存。

### Suggested Action

以 History entry id 建立页面级 KeepAlive 缓存，离开前冻结活动页面、返回时重新激活同一 React/DOM 实例；History state 只保存可序列化身份和重启水合快照。页面各自拥有视口，滚动监听绑定 DOM 实例的固定 entry id，平滑滚动只用于用户主动锚点操作，并以 app Back / browser Back / Forward 的状态与时序回归证明行为。

### Resolution

2026-08-04 已由 R15 实现并完成真实开发态验收：`createHashRouter`、History entry key、页面级 `KeepAlive` 与每页滚动容器共同保留 React / DOM 实例；只在登出或服务器 / 资料库上下文切换时销毁。实现提交为 `bd557fa`。

## 2026-08-01 — 全局通知队列的 presence、暂停计时与可访问性堆叠

- 通知不能再由一个可覆盖的字符串状态承载：每项需有稳定 ID、创建顺序、剩余时长及 `entering / visible / leaving` phase；自动关闭计时器和退出卸载计时器独立管理，暂停时按 deadline 计算剩余时长，恢复后只继续未耗尽部分。
- 3 条以上折叠时，隐藏的背景预览不能仅靠视觉遮挡：同时给其 `aria-hidden`、`inert` 和关闭按钮 `tabIndex=-1`，再让最前层的 `ul[tabIndex=0]` 成为键盘进入点；hover 或 focus 展开后再恢复全部卡片的可操作性。
- reduced-motion 的 CSS 淡出时长必须与 JS 延迟卸载一致；通用的 `1ms` 动画覆盖会使退出节点看起来立即消失，通知层应单独保留无位移的短淡入淡出。

## 2026-07-31 — Tauri 开发态与已安装版会形成两个独立 Dock 进程

- `/Applications/Cadilume.app` 与 `target/debug/Cadilume` 是两个不同的 macOS 应用进程；即使它们共享产品名或 Bundle ID，Dock 也会显示两个图标。Vite / `pnpm dev` 本身不会产生 Dock 图标。
- 用户要求真实开发态验收且只保留一个应用时，先只读确认已安装版与开发态 PID；经用户明确授权后退出已安装版，再启动唯一的 `pnpm tauri dev -c '{"build":{"beforeDevCommand":"true"}}' --no-dev-server-wait`。验收后保持用户指定的那一条，不要并行重启另一版。
- 原生 UI 验收以 macOS Accessibility 树和可访问控件状态为准，不截图。自定义 Web Portal 的选项在 AX 中可被发现，但 AXPress 不一定等同 WKWebView 中的真实 pointer click；不要仅因该自动化局限判定业务回调失效，需结合浏览器交互、Rust 命令测试与已验证的真实路径判断。

## 2026-07-31 — Provider 边界与中央歌词层的收口方式

- `musicGateway.ts` 是跨平台预留的合适外部边界：让当前 Plex adapter 同时负责按需歌曲解析、loopback stream、timeline、scrobble、歌词和协议错误分类；`usePlayer` / `useLyrics` 只调用该层。歌词归一输入应使用 `MusicLyricsPayload` 等通用形状，Plex 类型仅作为兼容别名，避免将未来 provider 的条件分支散入播放状态机或歌词 UI。
- 视觉配色和媒体 provider 必须严格分离：琥珀金、雨林绿、澄海蓝只是 Cadilume 的 CSS preset，不能据此更改网络 adapter、凭据、登录或 capability；Companion 仅保留显式 capability 位，不能被表述为已实现。
- 设置卡片的 `overflow: hidden` 会裁切任何非 Portal 菜单，单纯增加 z-index 无法解决。Radix Select 可继续使用其 Portal；视觉风格固定为卡片内三个紧凑单选按钮，不再实现为菜单。若未来确有其他自定义菜单，仍应通过 `createPortal(document.body)` 固定定位，并在窗口 resize 与捕获阶段 scroll 时依据触发器重新定位，保留 outside-click、Escape 和焦点回退。
- 主窗体中央歌词不应通过新增 grid 列实现：把它绝对定位在标题栏与固定播放器之间、在中央内容区域全高展示，外围 `pointer-events:none`、面板本身恢复 pointer events。这样不挤压资料库，也可满足无 scrim、无 Escape、无关闭按钮、只由底栏歌词按钮切换；歌词滚动区单独配置使用 accent token 的窄滚动条与 keyboard focus 样式。

## 2026-07-30 — 播放列表创建、顶部身份与连接提示

- Plex `POST /playlists` 可创建空白普通播放列表；Cadilume 通过专用 Rust/Tauri command 传入 `type=audio`、清理后的 `title` 和 `smart=0`，由当前服务器专属 token 服从 PMS ACL。浏览器演示只维护内存中的演示列表，不能把该路径改成 WebView 直连。
- 侧栏标题区应把折叠箭头作为标题文字后的紧邻控件，把 `+` 作为最右侧独立按钮；账号入口用头像与两行信息横排、无常驻外框。连接拓扑图标需要可聚焦的 `aria-describedby` + `role="tooltip"`，原生 `title` 不能替代 hover/focus 的明确状态说明。
- React StrictMode 下，模态框初始焦点 effect 的 cleanup 里延迟恢复焦点可能在第二次 effect setup 后抢回触发器；用 ref 保存原始触发器并取消待执行的 `requestAnimationFrame`，再在真正卸载时恢复焦点。

## 2026-07-29 — 歌词 UI 验证不等于 Plexamp 对时

- 歌词独立滚动、播放器布局稳定、右侧歌词栏和行切换渐变只验证界面行为，不能作为歌词时间轴已与 Plexamp 对齐的证据。
- 对时结论必须来自同一真实曲目、同一歌词源在开头/中段/结尾的多点采样，并同时记录原始唱词时间戳、活动 `HTMLAudioElement.currentTime`、实际听感唱词起点和 Plexamp 对照；演示歌词与内部 Web UI 只能验证显示逻辑。
- 在真实采样尚未区分恒定偏差、持续漂移、歌词源差异或切源/输出链路延迟前，不加入固定 delay，也不得宣称“歌词偏快已修复”。

## 2026-07-29 — 连接拓扑与媒体转码边界

- `local=true`、远程直连和 `relay=true` 只表示 Cadilume 到 PMS 的连接拓扑，不表示媒体是否转码。
- 原始直放由 PMS Part endpoint 返回，Cadilume 的 `127.0.0.1` 高熵 URL 只是票据/鉴权隔离与 Range 转发；客户端没有 FFmpeg 或其他音频转码链路。
- WebView 解码是播放所必需的本地解码，不等于转码。需要格式兼容或降码率时，统一请求 PMS universal transcode；即使 PMS 与 Cadilume 在同一台 Mac 上，执行转换的也仍是 PMS 服务端进程。
- UI 的连接标签只能说明发现阶段的首选链路；若要显示某一首曲目回退后真正成功的链路，需要额外的 Rust 运行态事件，不能从 WebView 的 loopback URL 推断。

## 2026-07-28 — Artwork loopback tickets

- Validate and atomically persist an authorized Plex image before issuing its URL. Store only the private disk cache key behind a 64-hex loopback ticket, then read and revalidate the cache entry when `/artwork/{ticket}` is requested; this removes long-lived base64 IPC payloads without exposing the PMS host, image path, cache key, or token.
- Keep artwork and audio in independent bounded ticket registries so a large album grid cannot evict active playback URLs. Account change/logout revokes both; explicit artwork-cache clearing revokes artwork tickets before deleting disk entries.
- Disk LRU eviction or ticket expiry can race a lazy `<img>` load. Delete the frontend promise cache and request one replacement ticket on the first image error, then fall back after the second failure; allow only strict loopback artwork tickets or explicit `data:image` values in explicitly supported in-window payloads.

## 2026-07-28 — Expanded-player modal and nested-dialog focus

- Mount the expanded player as a viewport-sized in-window modal (`position: fixed; inset: 0`) above the application shell and default bottom player, but below nested dialogs such as “添加到歌单”. The expanded surface needs its own queue/playback/progress/volume controls because the original player is intentionally covered.
- While expanded, make the underlying shell inert and hidden from assistive technology. When a nested playlist dialog opens, temporarily make the expanded layer inert too; handle Escape and Tab only in the topmost active layer, then restore focus to the opening control on close.

## 2026-07-28 — Sharp macOS icon pipeline

- Tauri's default icon conversion can leave the `.icns` 1024px slot derived from a lower-resolution raster. Cadilume instead renders `app-icon.svg` directly to a true 1024×1024 master, downsamples each standard Retina slot, and rebuilds `icon.icns` with `iconutil` via `pnpm icons:macos`.
- macOS 26's layered icon is an additional `Cadilume.icon` → `Assets.car` path, not a replacement for the legacy ICNS. `actool` also emits a reduced ICNS without 512/1024 slots, so copy only its `Assets.car` and retain the independently generated full fallback ICNS.
- Release verification must extract the app's `icon.icns` and the DMG `.VolumeIcon.icns`; both `icon_512x512@2x.png` files should be 1024×1024 and hash-identical to the SVG-rendered master. This also detects an old icon accidentally retained in the DMG staging volume.

## 2026-07-28 — Playback-session restore and queue boundaries

- Persist only a versioned, sanitized queue snapshot (relative Plex metadata/part paths, never resolved stream URLs or tokens), cap it at 500 tracks, expire it after 30 days, and treat localStorage failures as a non-fatal degradation.
- Restoring a track should restore queue/index/progress without autoplay; resolve the media source only on the user's first Play and seek after `loadedmetadata`, because early `currentTime` writes can be ignored by WebKit/Chromium.
- Keep natural `ended` separate from manual navigation: repeat-one replays only on natural completion, while manual Next/Previous continues inside the current queue; shuffle consumes a per-round bag and uses history for Previous.

## 2026-07-28 — Plex shared-music access

- Free independent accounts with a directly shared music library can perform basic local/remote music playback; the critical implementation detail is using the PMS-specific `accessToken` from `/api/v2/resources`, not reusing the plex.tv account token.
- Preserve `owned:false` and `home:true` resources. Stream media Parts without `download=1`, because download authorization is separate and can return 403.
- Managed Users cannot PIN-login independently; `/api/home/users/{id}/switch` is an experimental compatibility API outside current PMS OpenAPI and must be isolated if implemented.

## 2026-07-28 — Plexamp desktop diagnosis

- Plexamp 4.12.4 is an Electron/React Native Web app around 206 MB. Its default 270×515 window hides the independent volume slider because the narrow layout requires roughly 675px height.
- Windows uses a null media-service implementation and only global media shortcuts, so it lacks complete SMTC metadata/progress/Seek.
- The private Treble/BASS engine is not reusable; build a clean native playback engine behind an `AudioEngine` boundary.

## 2026-08-01 — Plex Companion 可行性边界：控制端可落地，接收端需实验性拆分

- 2026-08-03 用户决定暂不考虑 L1；后续默认不启动 Companion 协议 POC、设备发现、Receiver 入站服务、控制端 UI、依赖引入或真实互操作验收，只有用户重新明确开启后才恢复评估。
- Plex 官方当前支持矩阵将 Plexamp（包含移动端实例）列为同时具备 Controller 与 Receiver 角色的 Companion app。因此 L1a 的首个真实互操作目标可以是“Cadilume 控制同一账号下、正在前台/可发现的 iOS 或 Android Plexamp”；它不要求 Cadilume 先实现 Receiver。
- 手机端作为 Receiver 并不等于所有远端交接都可靠：官方人员说明简单的播放控制可经云端中介，但完整连接/“play here”通常要求控制端能连到播放器端，实践中应把同一 Wi-Fi / 同网段作为首轮验收前提，并覆盖 iOS、Android、前后台切换和断网恢复。
- 当前 Tauri/Rust 框架已经具备控制端可复用的基础：Rust `reqwest`、Keychain/资源级 PMS token、per-server 连接回退、Plex identity headers、Tauri command/event 桥和 React 播放状态；但 `canControlCompanion` 仍为显式 `false`，没有播放器发现、订阅、commandID、timeline 回调或远端目标状态。
- 当前 `axum` 仅绑定 `127.0.0.1` 并服务音频/封面票据；它不是可被局域网 Plex 客户端发现的 Companion receiver。接收端还需要独立的 LAN HTTP listener、GDM/`/resources` 广告、`/player/*` 命令、订阅者管理和从 WebView 播放状态向 Rust 的稳定时间线发布。
- Plex 官方支持矩阵把 macOS/Windows 桌面应用列为 controller-only；官方 `plex-media-player` 仓库的 Remote control API wiki 已归档，且页面最后编辑于 2015 年。协议字段可作为 clean-room 实现参考，但不能据此宣称现代 Plex 客户端一定支持第三方桌面 receiver。
- 后续应把 L1 拆为：L1a 控制端（优先用 `/clients`/已授权资源和 `timeline/poll`，避免首版开放入站端口），L1b 远端播放交接与 server playQueue，L1c 可选、默认关闭的实验性 receiver。所有网络与 token 处理留在 Rust；接收 `playMedia` 只允许已发现且用户确认的服务器/设备，不能信任局域网请求携带的任意地址或 token。
- R14、R15、R13 及其验收完成前不开始 L1 UI；实施时 Companion 应作为独立 `CompanionManager/Gateway`，不要把远端播放器协议直接塞进现有 `MusicProviderGateway` 或 `usePlayer` 的本地 HTMLAudio 状态机。
