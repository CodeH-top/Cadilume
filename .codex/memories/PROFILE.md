# PROFILE

## Scope

- Child-project memory for `cadilume`.
- Path: `/Users/hoganchou/Documents/Work/Project/AI/cadilume`.

## Identity

- Product/application name: `Cadilume`.
- Bundle/application identifier: `top.codeh.cadilume`.
- Repository directory: `cadilume`.
- Purpose: lightweight, desktop-first music client for macOS and Windows that interoperates with authorized Plex Media Server libraries.
- Stack: Tauri 2, React 19, TypeScript, Rust, Vite.
- Repository: independent git repository on branch `main`.
- UI direction: native system window, equally complete dark/light themes, Plex/Plexamp-like desktop information density through a clean-room Cadilume implementation, fixed bottom player, persistent independent volume, default/minimum size `1280×820`.

## User Priorities

- A visible, reliable way to close or quit the app.
- User-selectable close-to-tray vs direct quit behavior.
- Explicit application quit actions in the Windows notification area and macOS menu bar; settings keeps close behavior and a danger-colored account logout action without duplicating application quit.
- Basic music playback for authorized free/shared Plex accounts without a client-side Plex Pass gate.
- One internal Cadilume icon system across the UI, application bundle, tray/menu bar, and installers, with sharp Retina assets generated from the project SVG master.
- macOS release packages must never rely on a broken or incomplete resource signature; a normal Internet/download warning is acceptable.
