# FEATURE_REQUESTS

## macOS release trust chain

- Add Developer ID Application signing and Apple notarization/stapling once the project has an Apple Developer team and release credentials. Until then, generated DMGs are local acceptance artifacts and cannot guarantee the exact Gatekeeper experience on another Mac.

## Native playback core

- Move queue authority, Range/cache, decoding, independent gain, gapless/prefetch and output device selection into Rust so Windows hidden-window playback does not depend on WebView timers.
- Add macOS Now Playing/Remote Command Center and Windows SMTC with metadata, progress, Seek and artwork.

## Plex protocol hardening

- Add Ed25519 JWK/JWT device auth and refresh.
- Drive browsing and capabilities from `/media/providers` instead of fixed legacy paths.
- Add server-backed playQueues and universal playback decision.
- Add an isolated experimental Managed User home-switch adapter.
