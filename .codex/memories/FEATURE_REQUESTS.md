# FEATURE_REQUESTS

## 歌词与 Plexamp 实曲对时：待 Cadilume 原生听感验收

- 已修复可确认的前端时间问题：完整保留 PMS `startOffset/endOffset` 毫秒边界，歌词流按 PMS 原始顺序尝试；桌面播放期间约每 50ms 读取活动 `HTMLAudioElement.currentTime`，不再只依赖约 250ms 粒度的 `timeupdate`，且未加入猜测性的固定正负 delay。
- Plex Web 已用曾沛慈《我才没有那样呢》及李荣浩、周杰伦、S.H.E 等多曲自然播放采样；活动行通常在目标边界后约 20–80ms 更新，没有发现统一提前、延后半拍或累积漂移规则。自动测试已覆盖毫秒边界与无歌词状态。
- 尚未完成的验收是：在 Cadilume 原生 Release 中播放主样本及至少两首扩展样本，分别检查开头/中段/结尾、seek、暂停恢复和切歌后的实际人声听感。完成前只能称“已修已知代码原因”，不能宣称同步问题百分之百闭环；若仍有偏差，再按原始直放/PMS 转码/AirPlay 输出链路分别采样并决定是否需要原生播放时钟原型。

## 真实 PMS 播放验收与逐曲链路诊断

- 有界回退已覆盖原始流及 PMS 生成的 320/256/192 kbps 兼容流，但此前用户报告的真实失败曲目尚未在其 PMS 上端到端复播；完成该验收前不能把自动测试等同于“所有音乐均已解决”。
- 当前“本地直连 / 远程直连 / Plex Relay”只显示服务器发现阶段的首选连接。代理会在逐曲请求中尝试多个连接与转码 endpoint，因此该标签不是最终成功链路。
- 若需要向用户显示当前曲目的实际连接和直放/转码结果，应由 Rust 流代理在成功获得上游响应时发布脱敏运行态事件，只返回连接类型、媒体决策和有效码率，不暴露 PMS URI、媒体路径或 token。

## macOS release trust chain

- Add Developer ID Application signing and Apple notarization/stapling once the project has an Apple Developer team and release credentials. Until then, generated DMGs are local acceptance artifacts and cannot guarantee the exact Gatekeeper experience on another Mac.

## Native playback core

- Move queue authority, Range/cache, decoding, independent gain, gapless/prefetch and output device selection into Rust so Windows hidden-window playback does not depend on WebView timers.
- Add macOS Now Playing/Remote Command Center and Windows SMTC with metadata, progress, Seek and artwork.

## [FR-20260801-001] 页面标题与歌手资料层级

**Logged**: 2026-08-01T15:51:11+08:00
**Priority**: high
**Status**: pending
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

## [FR-20260801-002] 曲目级多歌手字段保真

**Logged**: 2026-08-01T15:51:11+08:00
**Priority**: high
**Status**: pending
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

## [FR-20260801-003] History Back 滚动连续性与路由缓存

**Logged**: 2026-08-01T15:57:40+08:00
**Priority**: high
**Status**: pending
**Area**: frontend

### Metadata

- Source: user_feedback
- Scope: project
- Pattern-Key: cadilume.routing.history-scroll-cache
- Recurrence-Count: 1
- First-Seen: 2026-08-01
- Last-Seen: 2026-08-01
- Related Files: /Users/hoganchou/Documents/Work/Project/AI/cadilume/src/App.tsx, /Users/hoganchou/Documents/Work/Project/AI/cadilume/src/App.css, /Users/hoganchou/Documents/Work/Project/AI/cadilume/src/libraryRoute.ts, /Users/hoganchou/Documents/Work/Project/AI/cadilume/docs/NEXT_DEVELOPMENT_PLAN_2026-07-29.md

### Requested Capability

歌手列表滚动后进入歌手详情，再通过返回回到列表时，必须像正常 History Back 一样立即停在原位置，不能先归零或再滚动一次；路由切换需要真实缓存，而非只保存一个 hash 对应的滚动数字。

### User Context

用户观察到返回歌手列表时滚动条会再次移动，质疑当前是否实际完成“路由切换加缓存”。源码确认现有实现只以 route hash 保存 `scrollTop`，详情切换重挂 `.route-content`，恢复过程还受 CSS 平滑滚动影响，且没有该时序的测试。

### Suggested Implementation

按 R15 以 History entry id + scroll state 管理每次导航，缓存列表数据与视图状态，进入 / 返回前同步保存，目标内容提交前无动画恢复；将平滑滚动仅限用户显式锚点操作，并覆盖应用 Back、浏览器 Back / Forward、缓存失效和真实 Tauri 验收。

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
