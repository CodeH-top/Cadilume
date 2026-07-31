# ACTIVE

## Always Apply

- [ACT-001] Keep native window decorations enabled; never replace the macOS/Windows title bar with a fake mobile frame.
- [ACT-002] Keep the independent volume and mute controls visible in the fixed player bar at the minimum desktop window size.
- [ACT-003] Persist `tray` vs `quit` close behavior. The Windows tray/macOS menu bar must expose an explicit application quit action; settings configures close behavior and exposes only danger-colored account logout, not a duplicate application quit action.
- [ACT-004] Plex account token stays in Keychain/Credential Manager. PMS calls use each resource's per-server `accessToken`, especially for `owned:false` shared servers.
- [ACT-005] Do not client-gate basic authorized music by `subscription.active`; respect server ACL failures and feature-specific Plex Pass gates.
- [ACT-006] v0.1 WebView audio is an MVP boundary. Do not claim strict gapless, background queue authority, output-device control, or complete Windows SMTC until the Rust native playback core exists.
- [ACT-007] Use the browser demo dataset only outside Tauri. Real Plex traffic must run through Rust commands.
- [ACT-008] Keep the product/application name `Cadilume`, Bundle/application identifier `top.codeh.cadilume`, and repository directory `cadilume` aligned. Use Plex/Plexamp/PMS names only for third-party service, API/protocol, interoperability, or clean-room research semantics.
- [ACT-009] The expanded now-playing view is an in-window modal that covers the entire viewport, including the fixed bottom bar, and must carry its own complete playback controls; it may never render outside the application window.
- [ACT-010] Generate the macOS 26 layered `Assets.car` from `src-tauri/icons/Cadilume.icon` and the legacy `.icns` from `app-icon.svg` with a true 1024px Retina slot via `pnpm icons:macos`; verify both the app icon and DMG volume icon before release packaging.
- [ACT-011] Treat ad-hoc signing only as a local acceptance package. Public macOS distribution that should pass Gatekeeper normally requires a Developer ID Application identity, hardened runtime, secure timestamp, notarization, and a stapled ticket.
- [ACT-012] Serve audio and artwork through separate bounded loopback ticket registries. Never expose PMS hosts, media paths, artwork cache keys, or tokens to the WebView; revoke both registries on account change/logout and only artwork tickets when clearing artwork cache.
- [ACT-013] Cadilume never performs client-side audio transcoding. A loopback media URL is only a credential-isolating stream proxy: original quality reads the PMS Part, while compatibility conversion or bitrate reduction is requested from PMS universal transcode, including when PMS runs on the same Mac.
- [ACT-014] Treat connection topology and media handling as independent dimensions: `local=true` is local direct, `relay=true` is Plex Relay, and the remaining reachable connection is remote direct; none of these labels alone means that client-side transcoding occurs.
- [ACT-015] Any Plex playlist creation or mutation must cross a dedicated Rust/Tauri command and use the selected server's scoped token; browser/demo mode may emulate the result, but WebView code must never call PMS directly.
- [ACT-016] Cadilume 的 localhost、演示页面与本地 UI 预览/验收默认使用 Codex 内部浏览器；只有确实需要读取 Plex 网页、复用 Plex 登录态或对照 Plex Web 可见行为时才使用 Chrome。此项目级规则覆盖全局的默认 Chrome 偏好。
  Source: user correction on 2026-07-30.

## Validation

- Run TypeScript check, frontend tests/build, Rust tests, and a practical Tauri build before committing an implementation round.
