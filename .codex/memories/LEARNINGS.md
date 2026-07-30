# LEARNINGS

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
