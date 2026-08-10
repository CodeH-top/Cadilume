# PROFILE

## Scope

- Child-project memory for `Cadilume`.
- Path: `/Users/hoganchou/Documents/Work/Project/AI/Cadilume`.

## Identity

- Product/application name: `Cadilume`.
- Bundle/application identifier: `top.codeh.cadilume`.
- Repository directory: `Cadilume`.
- Purpose: lightweight, desktop-first macOS/Windows music client that interoperates with authorized Plex Media Server libraries. macOS is the current development and on-device acceptance scope; Windows compatibility, automated MSVC/cargo-xwin gates, and installer paths remain available but require later real-device acceptance.
- Stack: Tauri 2, React 19, TypeScript, Rust, Vite.
- Repository: independent git repository on branch `dev` (the active development branch; `main` and `webview` remain historical baselines).
- UI direction: native system window, equally complete dark/light themes, Plex/Plexamp-like desktop information density through a clean-room Cadilume implementation, fixed bottom player, persistent independent volume, default/minimum size `1280×820`.

## User Priorities

- A visible, reliable way to close or quit the app.
- Closing the main window minimizes natively and continues playback; explicit quit remains available from the macOS menu bar / status icon path.
- The status icon visibility preference is independent of close behavior, and settings keeps a danger-colored account logout action without duplicating application quit.
- Basic music playback for authorized free/shared Plex accounts without a client-side Plex Pass gate.
- One internal Cadilume icon system across the UI, application bundle, tray/menu bar, and installers, with sharp Retina assets generated from the project SVG master.
- macOS release packages must never rely on a broken or incomplete resource signature; a normal Internet/download warning is acceptable.
