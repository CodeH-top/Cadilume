# LEARNINGS

## 2026-07-28 — Expanded-player modal and nested-dialog focus

- Mount the expanded player as a viewport-sized in-window modal (`position: fixed; inset: 0`) above the application shell and default bottom player, but below nested dialogs such as “添加到歌单”. The expanded surface needs its own queue/playback/progress/volume controls because the original player is intentionally covered.
- While expanded, make the underlying shell inert and hidden from assistive technology. When a nested playlist dialog opens, temporarily make the expanded layer inert too; handle Escape and Tab only in the topmost active layer, then restore focus to the opening control on close.

## 2026-07-28 — Sharp macOS icon pipeline

- Tauri's default icon conversion can leave the `.icns` 1024px slot derived from a lower-resolution raster. Cadilume instead renders `app-icon.svg` directly to a true 1024×1024 master, downsamples each standard Retina slot, and rebuilds `icon.icns` with `iconutil` via `pnpm icons:macos`.
- Release verification must extract the app's `icon.icns` and the DMG `.VolumeIcon.icns`; both `icon_512x512@2x.png` files should be 1024×1024 and hash-identical to the SVG-rendered master. This also detects an old icon accidentally retained in the DMG staging volume.

## 2026-07-28 — Playback-session restore and queue boundaries

- Persist only a versioned, sanitized queue snapshot (relative Plex metadata/part paths, never resolved stream URLs or tokens), cap it at 500 tracks, expire it after 30 days, and treat localStorage failures as a non-fatal degradation.
- Restoring a track should restore queue/index/progress without autoplay; resolve the media source only on the user's first Play and seek after `loadedmetadata`, because early `currentTime` writes can be ignored by WebKit/Chromium.
- Keep natural `ended` separate from manual navigation: repeat-one replays only on natural completion, while manual Next/Previous continues inside the current queue; shuffle consumes a per-round bag and uses history for Previous.

## 2026-07-28 — Transparent desktop karaoke overlay

- Tauri transparent lyrics windows need both `transparent: true`/an alpha-zero background and `app.macOSPrivateApi: true` on macOS; the latter enables Tauri's private transparent-window API and is unsuitable for App Store distribution.
- Keep lock semantics cross-platform as position-fixed/no-drag rather than OS click-through: click-through prevents hover controls and makes unlock impossible. Persist only the non-sensitive lock preference in localStorage.
- A smooth karaoke sweep can interpolate `positionMs` between coarse player events when payloads include active-line start/end (or an explicit 0..1 progress), while the Rust/native layer remains authoritative for playback.

## 2026-07-28 — Plex shared-music access

- Free independent accounts with a directly shared music library can perform basic local/remote music playback; the critical implementation detail is using the PMS-specific `accessToken` from `/api/v2/resources`, not reusing the plex.tv account token.
- Preserve `owned:false` and `home:true` resources. Stream media Parts without `download=1`, because download authorization is separate and can return 403.
- Managed Users cannot PIN-login independently; `/api/home/users/{id}/switch` is an experimental compatibility API outside current PMS OpenAPI and must be isolated if implemented.

## 2026-07-28 — Plexamp desktop diagnosis

- Plexamp 4.12.4 is an Electron/React Native Web app around 206 MB. Its default 270×515 window hides the independent volume slider because the narrow layout requires roughly 675px height.
- Windows uses a null media-service implementation and only global media shortcuts, so it lacks complete SMTC metadata/progress/Seek.
- The private Treble/BASS engine is not reusable; build a clean native playback engine behind an `AudioEngine` boundary.
