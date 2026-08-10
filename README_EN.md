<div align="center">

  <img src="Branding/Cadilume-readme-icon.png" width="256" height="256" alt="Cadilume icon" />

# Cadilume

**An open-source desktop music alternative to Plex Web and Plexamp**

[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?style=flat&logo=tauri&logoColor=white)](https://tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat&logo=react&logoColor=111111)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-stable-000000?style=flat&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![macOS](https://img.shields.io/badge/macOS-supported-000000?style=flat&logo=apple&logoColor=white)](https://www.apple.com/macos/)
[![Windows](https://img.shields.io/badge/Windows-10%20%2F%2011-0078D4?style=flat&logo=windows11&logoColor=white)](https://www.microsoft.com/windows/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[中文](README.md) | English

</div>

Cadilume is a Plex music client for macOS and Windows. Its goal is to bring the music-library experience of Plex Web and the everyday playback experience of Plexamp into one focused, complete desktop application.

After connecting to a Plex Media Server that you own or are authorized to share, you can browse your music library, search for tracks, manage playlists, view lyrics, and keep playback available through the operating system's media controls. Cadilume focuses exclusively on music and does not mix movie, TV, or photo libraries into the experience.

> Cadilume is an unofficial third-party client for Plex Media Server. It is not affiliated with or endorsed by Plex, Inc. Plex, Plexamp, and related trademarks belong to their respective owners.

## Features

### Music library

- Sign in with Plex PIN authentication in the system browser.
- Discover owned, home, and shared servers available to the current account.
- Select a server and Music library in Settings, with local direct, remote direct, or Plex Relay connection status.
- Browse recommendations, recently added albums, artists, albums, and tracks.
- Explore the complete artist catalog with an A-Z/# index, artist and album details, and library-wide search.
- Start playback from an album, artist, search result, playlist, or individual track.

### Playback and lyrics

- Native desktop audio playback for common formats including MP3, AAC/MP4, FLAC, Vorbis, and WAV.
- Original, automatic, and fixed-bitrate quality modes; Plex Media Server handles compatibility transcoding when needed.
- A playback queue with Play Next, remove, clear, move-to-top, drag reordering, and keyboard reordering.
- Sequential, shuffle, playlist repeat, and repeat-one playback modes.
- Independent application volume and mute without changing the system master volume.
- Timed and plain-text lyrics; timed lyrics follow playback and support click-to-seek.
- An expanded player with Vinyl and Cover presentation modes, complete controls, and a lyrics view.
- Restores the recent queue, current track, playback position, quality, and repeat state after relaunch without autoplaying.

### Playlists

- Read and play regular, smart, and read-only playlists.
- Create, rename, edit the description of, and delete writable regular music playlists.
- Add one or many tracks to a playlist and remove tracks in batches.
- Reorder tracks within regular playlists with drag or keyboard controls; smart playlists always reload their latest server result.

### Desktop experience

- Native desktop windows on macOS and Windows with a fixed bottom player.
- Keep playing after the main window closes, then restore it from the Dock, taskbar, or status icon.
- macOS menu-bar and Windows notification-area actions for restoring the window, play/pause, and quitting.
- macOS Now Playing / Remote Commands and Windows system media control integration.
- Light and dark themes with Amber Gold, Rainforest Green, and Ocean Blue visual styles.
- In-app output-device selection on Windows; macOS output routing remains in Control Center.
- Artwork caching, a fixed 1 GiB audio cache, and next-track prebuffering, with separate cache status and clear actions in Settings.

### Account and privacy

- Release builds store account credentials in macOS Keychain or Windows Credential Manager.
- Server tokens, upstream media addresses, and artwork addresses are not exposed directly to the interface layer or written to logs.
- Every request continues to follow Plex Media Server access controls and subscription boundaries.
- Playback, decoding, and caching ship with the application. Users do not need FFmpeg, libmpv, BASS, Homebrew, or a separate background service.

## Requirements

### To use the application

- A Plex account that can sign in normally.
- At least one Plex Media Server Music library available to that account.
- macOS, or Windows 10 / 11 x64.
- Microsoft Edge WebView2 Runtime on Windows; it is already present on most Windows 10 / 11 systems.

macOS is currently the primary development and on-device acceptance platform. The Windows build, installer, and system-integration paths remain available.

### To build from source

- Node.js 20 or later
- pnpm 10 or later
- Rust stable
- The SDK for the target platform
- macOS: Xcode Command Line Tools; Xcode 26 or later is required only when regenerating the macOS 26 layered icon
- Windows: Git, CMake, MSVC C++ Build Tools, Windows 10/11 SDK, and WebView2 Runtime

## Deploy and run

```bash
git clone <repository-url>
cd Cadilume

pnpm install
pnpm tauri dev
```

`pnpm tauri dev` starts the complete desktop application. Run `pnpm dev` when you only need a UI preview; browser previews use the built-in demo library, while real Plex authentication and media requests are available only in the Tauri desktop process.

## Build

Run the full validation set before producing a package:

```bash
pnpm check
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build --debug --no-bundle
```

### macOS DMG

```bash
pnpm bundle:macos:dmg
```

### Windows

```powershell
pnpm windows:doctor
pnpm verify:windows
pnpm verify:windows:bundle
```

`verify:windows:bundle` produces an unsigned debug NSIS installer for local acceptance. Public distribution should use Apple Developer ID signing, notarization, and stapling on macOS, or code signing on Windows.

## Main dependencies

| Dependency | Version | Purpose |
| --- | --- | --- |
| Tauri | 2 | Desktop shell, windows, and system integration |
| React | 19 | Desktop UI and state orchestration |
| React Router | 7 | In-app navigation |
| TypeScript | 5.8 | Frontend type system |
| Vite | 7 | Development server and frontend builds |
| Vitest | 4 | Frontend tests |
| Rust | stable | Native services, playback, and platform features |
| rodio | 0.22.2 | Playback queue and audio output |
| cpal | 0.17.3 | CoreAudio / WASAPI device access |
| symphonia | 0.5.5 | Audio format probing and decoding |
| reqwest / axum | 0.13 / 0.8 | Plex requests and the secure local media proxy |
| keyring | 3.6.3 | Operating-system credential storage |

See [`package.json`](package.json), [`pnpm-lock.yaml`](pnpm-lock.yaml), [`src-tauri/Cargo.toml`](src-tauri/Cargo.toml), and [`src-tauri/Cargo.lock`](src-tauri/Cargo.lock) for the complete dependency list and locked versions.

## Project layout

```text
src/                    React desktop UI and application orchestration
src-tauri/src/          Plex connectivity, native playback, cache, and system integration
src-tauri/icons/        Application, status, and installer icons
Branding/               README branding assets
scripts/                macOS / Windows build and validation scripts
docs/                   Architecture, interoperability, and platform documentation
```

## Usage notice

- Access only Plex Media Servers and media that you own or are authorized to use.
- Cadilume does not bypass Plex ACLs, server restrictions, or subscription requirements for specific features.
- This project is provided as-is, without express or implied warranties.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

[Back to top](#cadilume)
