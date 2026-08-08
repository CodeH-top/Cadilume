# FEATURE_REQUESTS

## macOS Now Playing 可见验收

- 代码链路已闭环：禁用 WebKit MediaSession；Rust 在主线程用 MediaPlayer 框架导出的真实
  NSString key 发布标题、歌手、专辑、时长、进度、速率、媒体类型和封面，并同步
  `playbackState`。系统字典契约测试逐项读回成功，真实播放日志也确认元数据和封面进入发布
  线程。
- 唯一未完成项是用户在 macOS 控制中心可见卡片上人工确认曲名/歌手/专辑/封面，以及媒体键
  和 seek。现有自动化无法读取系统控制中心的最终可见内容，且项目禁止主动截图；完成该次
  可见验收前不要宣称系统 UI 百分之百闭环，但也不要重复改写已经通过契约测试的 key。

## 歌词与 Plexamp 实曲对时：待 Cadilume 原生听感验收

- 已修复可确认的前端时间问题：完整保留 PMS `startOffset/endOffset` 毫秒边界，歌词流按 PMS 原始顺序尝试；桌面播放期间约每 50ms 读取活动 `HTMLAudioElement.currentTime`，不再只依赖约 250ms 粒度的 `timeupdate`，且未加入猜测性的固定正负 delay。
- Plex Web 已用曾沛慈《我才没有那样呢》及李荣浩、周杰伦、S.H.E 等多曲自然播放采样；活动行通常在目标边界后约 20–80ms 更新，没有发现统一提前、延后半拍或累积漂移规则。自动测试已覆盖毫秒边界与无歌词状态。
- 2026-08-05 用户真实回归确认周杰伦《完美主义》仍存在歌词不同步，必须作为后续 Cadilume 原生专项样本复测；先核对同一歌词源的原始时间戳、活动音频时钟与实际人声起点，不能根据单曲现象直接加入固定偏移。
- 2026-08-06 代码级修复：歌词文档不再因媒体时长稳定（含非 seekable 流的 `Infinity`）
  重新获取或重置活动行；播放器统一用有限媒体时长/曲目元数据时长归一进度与歌词末行边界。
- 尚未完成的验收是：在 Cadilume 原生 Release 中播放主样本及至少两首扩展样本，分别检查开头/中段/结尾、seek、暂停恢复和切歌后的实际人声听感。完成前只能称“已修已知代码原因”，不能宣称同步问题百分之百闭环；若仍有偏差，再按原始直放/PMS 转码/AirPlay 输出链路分别采样并决定是否需要原生播放时钟原型。

## 真实 PMS 播放验收与逐曲链路诊断

- 有界回退已覆盖原始流及 PMS 生成的 320/256/192 kbps 兼容流，但此前用户报告的真实失败曲目尚未在其 PMS 上端到端复播；完成该验收前不能把自动测试等同于“所有音乐均已解决”。
- 2026-08-05 新增明确样本：周杰伦《天地一斗》在自动源、320、256、192 kbps 均返回 `MediaError code 4`，WKWebView 未提供 message。按用户决定先预留，不在当前视觉修正轮修改播放链路；后续复测须让本机代理提供脱敏的上游 HTTP 状态、Content-Type、连接类型和转码端点结果，区分原文件不受支持、PMS 转码响应异常与代理响应头问题。
- 2026-08-06 代理代码级修复：只转发 `audio/*` 的 2xx/416 响应，杜绝“PMS 错误页 200 +
  text/html”被当作音频交给 WebView 触发 code 4；转码参数按 Plex Web musicProfile 收口，
  失败响应带脱敏逐次尝试诊断。仍需在真实 PMS 上复播《天地一斗》并覆盖原始直放/三档码率/
  seek/暂停恢复后才能关闭该项。
- 2026-08-06 新增播放链路调试日志：Rust 代理逐次尝试 eprintln + 前端 `playback://log`
  事件转发到 Tauri 开发终端（脱敏）。用户报告切歌过程仍出现 `MediaError code 4` 且可能
  卡住，正在用该日志通道定位“切歌时序/旧会话/转码槽”还是代理/PMS 响应问题；确认前不
  擅自加固定延迟或按歌名规则。
- 当前“本地直连 / 远程直连 / Plex Relay”只显示服务器发现阶段的首选连接。代理会在逐曲请求中尝试多个连接与转码 endpoint，因此该标签不是最终成功链路。
- 若需要向用户显示当前曲目的实际连接和直放/转码结果，应由 Rust 流代理在成功获得上游响应时发布脱敏运行态事件，只返回连接类型、媒体决策和有效码率，不暴露 PMS URI、媒体路径或 token。

## macOS release trust chain

- Add Developer ID Application signing and Apple notarization/stapling once the project has an Apple Developer team and release credentials. Until then, generated DMGs are local acceptance artifacts and cannot guarantee the exact Gatekeeper experience on another Mac.

## Native playback core

- Move queue authority, Range/cache, decoding, independent gain, gapless/prefetch and output device selection into Rust so Windows hidden-window playback does not depend on WebView timers.
- Add macOS Now Playing/Remote Command Center and Windows SMTC with metadata, progress, Seek and artwork.
- 2026-08-06 用户新增硬约束：程序必须完全独立可用，禁止系统安装依赖（如
  `brew install mpv`），一切依赖必须集成进程序内部。该约束直接排除 libmpv 的
  Homebrew/系统库路线，也排除 tauri-plugin-libmpv（其 setup 在 macOS 明确要求
  `brew install mpv`，且 macOS 标为未测试）。
- 2026-08-06 选型结论（待用户确认后启动 POC）：首选纯 Rust 静态方案
  `rodio 0.22 + cpal + symphonia 0.6`，全部编译进现有二进制，macOS/Windows 单一
  代码路径。实测：含 rodio+cpal+symphonia（MP3/AAC/FLAC/ALAC/Vorbis/WAV）的
  release 二进制仅 2.5MB；对比 Windows LGPL 版 `libmpv-2.dll` 解压 95MB（单架构、
  压缩包 27MB）。许可全部兼容 MIT 应用（rodio/cpal MIT OR Apache-2.0，
  symphonia MPL-2.0，miniaudio Unlicense/MIT-0）；libmpv 本体是 GPLv2+/LGPLv2.1+
  双许可、Rust 绑定 crate 是 LGPL-2.1，不是 MIT。
- 已知边界：symphonia 0.6.0 无 Opus/WMA/APE/DSD/HE-AAC；MP3 gapless 能力有限；
  Now Playing/SMTC 仍需 Rust 侧单独接入。PMS 转码回退（container=mp3）可兜住
  不支持格式；磁盘缓存与“先落盘再解码”设计可同时解决 seek 与 Plexamp 式 ahead 预缓存。
- 2026-08-06 用户追问“JS 端是否有现成开源引擎”后补充两条可选路线：
  （1）JS WASM 解码（`@wasm-audio-decoders`，MIT）：可消除 codec 级 MediaError 4、
  支持 gapless，完全打进前端产物，无系统依赖；但仍在 WebView 内，后台播放/SMTC/
  磁盘缓存问题不解决，需自己写 PCM 缓冲/seek/队列层。
  （2）Rust 现成引擎替代自研：rodio 稳定优先；kithara（MIT OR Apache-2.0）具备
  Plexamp 式 progressive HTTP + 磁盘 LRU 缓存 + gapless + HE-AAC/Opus，但仍是
  alpha，须 pin 版本并先做 spike 验证 macOS/Windows 可用性再定。
- 2026-08-07 spike 结论：kithara 在 Tauri 进程播放卡死（firewheel 管线约 1 秒
  后停止、只出噪声），暂缓；**rodio 0.22 + 本地缓存落盘方案已在真实 PMS 流验证
  通过**（连续播放正常，默认音量 20%）。正式原生内核按此路线实施：AudioEngine
  边界 + 队列/进度事件 + seek + Now Playing/SMTC + 缓存上限/LRU + ahead 预取；
  kithara 保留为上游稳定后的备选。
- 2026-08-07 完成状态：Phase 0-6 主体完成（rodio 内核、队列权威 Rust、磁盘缓存
  LRU、边下边播、ahead 预取、macOS/Windows SMTC、WebView 播放退役）。剩余：
  严格 gapless（MVP 预取减间隙）、Windows 实机 SMTC/后台播放验收、真实 PMS 听感
  回归（高频切歌 20+ 次、歌词对时、seek/暂停恢复）。
- 2026-08-08 更新：严格 gapless、PCM 解码/实时线程隔离、缓存身份与并发清理、设备恢复、
  macOS Now Playing 字典契约均已实现并通过自动化/负载验证。Windows 已按用户要求移出本轮；
  当前只保留 macOS 控制中心可见人工确认、长期真实听感/弱网/睡眠恢复、ReplayGain、
  crossfade、响度扫描和离线下载等明确后续项。

## [FR-20260801-001] 页面标题与歌手资料层级

**Logged**: 2026-08-01T15:51:11+08:00
**Priority**: high
**Status**: resolved
**Area**: frontend

### Metadata

- Source: user_feedback
- Scope: project
- Pattern-Key: cadilume.artist.detail-hierarchy
- Recurrence-Count: 1
- First-Seen: 2026-08-01
- Last-Seen: 2026-08-01
- Related Files: /Users/hoganchou/Documents/Work/Project/AI/cadilume/src/App.tsx, /Users/hoganchou/Documents/Work/Project/AI/cadilume/src/App.css, /Users/hoganchou/Documents/Work/Project/AI/cadilume/docs/NEXT_DEVELOPMENT_PLAN_2026-07-29.md

### Requested Capability

推荐和歌曲页的标题字体需与专辑、歌手列表一致；歌手列表不显示介绍；歌手详情在右侧显示个人介绍，长介绍默认折叠并允许展开。

### User Context

用户在实际界面验收中确认标题字号尚未对齐，且歌手介绍被错误显示在歌手列表，而不是歌手详情中。详情需要采用干净实现的 Plex 式右侧资料层级，不复制第三方资产或代码。

### Suggested Implementation

按 R13 将四个资料库页的标题收敛到同一实际排版来源；列表卡只保留头像和名称；详情增加右侧真实介绍区、长文折叠和可访问展开控件，并覆盖长 / 短 / 无介绍及主题、最小窗口回归。

### Resolution

2026-08-04 已完成 R13：推荐、专辑、歌手、歌曲复用同一标题组件和实际计算样式；歌手网格仅保留圆形封面与名称。歌手详情的右侧“个人资料”直接显示服务端 `summary`，使用真实渲染行高判断是否超过 5 行，只有溢出时才显示“展开全部 / 收起”；状态通过 `aria-expanded` 与 `aria-controls` 关联内容区域，介绍换行保留。

内部浏览器在 `1280×820` 复验了短、长、空、换行夹具和三种配色的浅/深主题；唯一 Tauri 开发窗口通过无截图辅助功能树确认真实歌手介绍和展开/收起控件。`pnpm check`、`pnpm test`（25 files / 155 tests）、`pnpm build` 与差异检查通过；代码提交为 `0471de8`。

## [FR-20260801-002] 曲目级多歌手字段保真

**Logged**: 2026-08-01T15:51:11+08:00
**Priority**: high
**Status**: resolved
**Area**: frontend

### Metadata

- Source: user_feedback
- Scope: project
- Pattern-Key: cadilume.track.artist-field-contract
- Recurrence-Count: 1
- First-Seen: 2026-08-01
- Last-Seen: 2026-08-01
- Related Files: /Users/hoganchou/Documents/Work/Project/AI/cadilume/src/api.ts, /Users/hoganchou/Documents/Work/Project/AI/cadilume/src/types.ts, /Users/hoganchou/Documents/Work/Project/AI/cadilume/src/trackArtists.ts, /Users/hoganchou/Documents/Work/Project/AI/cadilume/src/usePlayer.ts, /Users/hoganchou/Documents/Work/Project/AI/cadilume/docs/NEXT_DEVELOPMENT_PLAN_2026-07-29.md

### Requested Capability

真实多歌手曲目必须读取曲目自身的歌曲歌手字段并保留完整成员，不能读取或回退成专辑歌手字段。

### User Context

用户确认当前实现仍把原本多歌手的歌曲显示成单歌手。现有 `Role` / `Contributor` 夹具和队列恢复测试通过，不能证明真实 PMS 的曲目级字段映射正确。

### Suggested Implementation

按 R14 先以曲目歌手与专辑歌手不同的真实只读 PMS 元数据定义字段契约，再将曲目级歌手无损贯穿归一、显示、队列、播放器、Media Session 与恢复快照；专辑歌手永不覆盖曲目歌手，链接解析只决定可点击性。

### Resolution

2026-08-04 已在唯一、已授权的 Tauri 开发态通过现有 Rust `server_get` 做完只读真实验收：在所选音乐资料库的 607 首曲目中，找到一首 `originalTitle`（曲目歌手）与 `grandparentTitle`（专辑歌手）不同、且曲目歌手原文具有复合署名形态的样本。该 PMS 没有返回 `Role` / `Contributor` 结构化成员（扫描结果为零，详情重取也为零），因此 Cadilume 按契约将完整 `originalTitle` 保留为一个不可拆分的 `trackArtists` 文本成员，而不是回退为专辑歌手或猜测拆分。

该样本的列表归一、详情重新读取、歌曲表显示解析和队列快照序列化/恢复均保持相同的完整曲目歌手文本；因没有可安全定位的结构化成员，结果为一个不可链接文本项，符合链接只作用于已定位成员的边界。播放器、展开播放器、队列、推荐与 Media Session 统一复用同一 `trackArtist` / `trackArtistContributors` 路径。验收未输出曲名、歌手、服务器、路径或凭据，未播放歌曲，也未向 PMS 写入。

## [FR-20260801-003] History Back 连续性与路由页全量 KeepAlive 缓存

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
- Related Files: /Users/hoganchou/Documents/Work/Project/AI/cadilume/src/App.tsx, /Users/hoganchou/Documents/Work/Project/AI/cadilume/src/App.css, /Users/hoganchou/Documents/Work/Project/AI/cadilume/src/libraryRoute.ts, /Users/hoganchou/Documents/Work/Project/AI/cadilume/docs/NEXT_DEVELOPMENT_PLAN_2026-07-29.md

### Requested Capability

每个已访问的 History 路由页必须作为完整页面实例缓存，而非只保存一个 hash 对应的滚动数字或列表数据。歌手列表滚动后进入歌手详情再返回时，原列表的 React/DOM 实例、数据、分页、筛选、标签、展开、焦点、sticky 状态和滚动位置都必须原样存在；同一要求覆盖专辑、歌单、歌曲和详情页。

### User Context

用户进一步明确，滚动问题只是页面被销毁 / 重建的表象：要求的是页面级“全部缓存”，不是页面级滚动缓存。源码确认现有实现只以 route hash 保存 `scrollTop`，详情切换会重挂共享 `.route-content`；即使增加数据缓存或换用 `<Outlet>`，也不能等同于保留页面实例。

### Suggested Implementation

按 R15 建立以 History entry id 为键的页面级 RouteCache / KeepAlive host：活动页之外的页面保留完整 React 子树与 DOM，但从布局、交互和无障碍树移出；返回时重新激活同一实例。History state 只保存可序列化 entry 身份与重启水合快照；当前进程内不允许按 LRU、数据刷新或 source revision 悄悄销毁页面。页面各自拥有视口，平滑滚动只用于用户主动锚点操作，并覆盖应用 Back、浏览器 Back / Forward、显式刷新、上下文销毁和唯一 Tauri 开发态验收。

### Resolution

2026-08-04 已完成 R15，并提交为 `bd557fa`：React Router 的 Hash 路由与按 History entry 身份的 `KeepAlive` 已接管页面导航；路由页各自持有稳定滚动容器，离开与返回复用同一 DOM / 本地状态，登出或切换服务器 / 资料库才销毁缓存。内部浏览器、唯一 Tauri 开发态、类型检查、测试与构建均已完成验收。

## 暗色开关可见性、主题封面稳定与页面标题统一（R9，R8 后、L1/L2 前）

- 修复暗色关闭态开关的轨道、边框和滑块对比，浅 / 深 × 琥珀金、雨林绿、澄海蓝均需清晰可辨；保留开关可访问性与交互状态，不以竖线或无意义小字补救。
- 主题双层揭示只能切换颜色，封面、头像和其他图片不得发生几何、`transform`、`object-position`、filter 或异步重排抖动；不得重新引入 `document.startViewTransition()`、路由 revision 或路由入场。
- 推荐、歌曲、设置页要采用专辑 / 歌手页同一套 sticky 标题、半透明背景和内容内分割线；标题在滚动、刷新、主题切换与同页重复点击时稳定。
- R8、R9 均先内部浏览器验证，随后只保留一条真实 Tauri 开发态统一复测；不截图、不启动第二条开发态。

## 展开播放器机械唱臂、统一浮层与音量收口（R10，R9 后、L1/L2 前）

- 黑胶轴座、摆臂与唱头要共用同一机械坐标系和旋转锚点，不能在封面比例、窗口尺寸或主题变化时断开、漂浮或穿出唱片。
- 正常与展开播放器的队列按钮、状态、列表和浮层必须唯一化；歌词也只能有一套根部浮层且无 scrim、无关闭按钮，只由主窗体底栏歌词按钮控制。展开播放器不得保留并行队列 / 歌词状态。
- 主窗体与展开播放器音量要收敛到同一个有效音量、显示、range 和 popover 逻辑，覆盖静音、0%、1%、50%、100%、键盘与三种配色矩阵。
- 先内部浏览器完成受控 UI / DOM 验收；R8–R12 全部完成后才复用唯一 Tauri 开发链做真实统一验收，不截图、不启动第二条链。

## 原生状态图标与统一最小化（R11，R10 后、L1/L2 前）

- 删除“关闭主窗口时”的 tray / quit 选择，窗口关闭始终原生最小化且不中断播放；状态图标显示改为独立的持久化开关，macOS 显示“菜单栏图标”、Windows 显示“任务栏图标”（指通知区域状态图标）。
- 升级配置时移除旧 `closeBehavior`、默认保留状态图标；开关须即时生效、不可产生第二个图标实例，也不能在关闭图标后让应用无入口。此项需用唯一 Tauri 开发链在实际平台验证，Windows 不能由 macOS / 浏览器代测。

## 资料库密度、时长列与多歌手保真（R12，R11 后、L1/L2 前）

- 所有歌曲表的时长表头与排序图标必须保留不可压缩宽度；歌手列表使用独立的更小圆形头像网格，`1280×820` 一屏展示人数必须多于同宽专辑网格，不影响专辑卡片。
- 多歌手优先读取 PMS 结构化贡献者 / `Role` 数据并保留所有姓名顺序；只让可定位到资料库实体的成员可点击，未匹配成员仍显示为不可点击文本。斜杠名称、部分匹配、全未匹配和旧单歌手字段都需要回归。

## Plex protocol hardening

- Add Ed25519 JWK/JWT device auth and refresh.
- Drive browsing and capabilities from `/media/providers` instead of fixed legacy paths.
- Add server-backed playQueues and universal playback decision.
- Add an isolated experimental Managed User home-switch adapter.

## 2026-08-01 — 已完成归档、用户验收重开项与剩余平台功能

- 跨设备播放历史已按用户决定从产品、UI、IPC、PMS 请求和持久化中移除；它既不是已完成能力，也不再作为待开发 Feature。两态主题、固定琥珀金 / 雨林绿 / 澄海蓝预设、纯唱片 Logo、macOS Dock 图标逻辑，以及 provider adapter 边界均已进入已完成计划记录。
- R8–R12 已有工程实现和此前验证记录，但用户于 2026-08-01 实测重开了三项：推荐 / 歌曲标题字号与歌手介绍层级（R13）、曲目级多歌手字段映射（R14），以及 History Back 的滚动连续性与路由缓存（R15）。尤其 R12 的多歌手不能因旧 `Role` / `Contributor` 夹具通过而标为完成，R1 的 hash-map 滚动尝试也不能视为路由缓存；下一轮依序执行 R14、R15、R13，并在唯一真实开发态复验。之后才是必须单独立项的 Plex Companion controller / receiver（L1）和 Emby / Jellyfin 实际认证、浏览、播放与歌词接入（L2）。现有配色、Logo 或 adapter 接口均不代表这些服务已支持。

## [FR-20260805-001] 播放器、主题、歌手与表格的用户验收修正

**Logged**: 2026-08-05
**Priority**: high
**Status**: resolved
**Area**: frontend

### Summary

用户新增十项专项修改，完整执行顺序、实现边界和验收条件见 `docs/NEXT_UI_PLAYBACK_AND_ARTIST_FIX_PLAN_2026-08-05.md`。范围包括：主题切换媒体几何稳定、无歌词 tooltip、小黑胶边框/暗色对比、两种播放器音量轨道、主/展开播放器底部结构与添加到歌单、独立于 PMS 的精确多歌手、歌手详情重排与操作菜单、歌曲表时长列居中、页面回到顶部，以及歌手歌曲总数和全量歌曲操作。

### Latest Decisions

- 多歌手是 Cadilume 独立于 PMS 结构化字段的客户端规则：以要显示的原始歌手文本为输入，先按精确分隔符 `" / "` 拆分，再逐个匹配本地歌手库。`S.H.E / 飞轮海` 必须拆分；`AC/DC`、`A/B`、`A /B`、`A/ B` 必须保持一个成员。PMS 是否返回 `trackArtists` / `contributors` / rating key 均不能改变拆分；可否定位只决定成员是否可点击，不得决定是否显示。
- 展开播放器新增歌词入口，但它只能切换根部唯一的歌词浮层；不创建第二份歌词数据、滚动容器或队列状态。主/展开播放器均在右侧提供“添加到歌单”，继续复用根部 `PlaylistPicker`。
- 歌手详情采用固定左侧头像、右侧名称/播放/More/“歌手资料”的紧凑层级；More 菜单位于资料上方，仅提供“添加到队列”“播放下一个”“添加到歌单”。简介展开不得移动头像；歌曲表的时长表头和数据统一在同一列内居中。
- 大滚动页回顶入口只作用于当前 `.route-page-scroll`，不影响歌词、队列等嵌套滚动区。歌手“歌曲”标签仅在服务端确认总数后显示 `歌曲 (N)`；播放、追加、插入下一首和添加到歌单均须先完整分页、去重、排序歌手歌曲集合。歌单批量写入必须留在 Rust/Tauri 边界，并如实报告部分失败。

### Resolution

2026-08-05 已完成专项计划全部十项：第 1–6 项修复主题、播放器与多歌手边界；第 7–10 项完成歌手详情重排、时长列居中、路由局部回顶、首页总数与全量分页操作、受控批量队列，以及经 Rust/Tauri 的串行批量歌单写入。快速连续触发批量操作时，旧请求不会再提前清除新请求的忙碌状态。

`pnpm check`、`pnpm test`（28 files / 170 tests）、`pnpm build`、`cargo test`（45 tests）、`pnpm tauri build --no-bundle` 和差异检查均通过。`1280×820` 无截图预览确认歌手层级 / 菜单键盘行为、歌曲数、时长几何对齐及回顶交互；真实 PMS 多页、队列播放和歌单写入仍按授权边界留给最终原生回归，不能由浏览器演示替代。
