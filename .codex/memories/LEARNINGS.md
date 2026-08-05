# LEARNINGS

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
