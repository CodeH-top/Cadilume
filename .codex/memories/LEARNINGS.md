# LEARNINGS

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
