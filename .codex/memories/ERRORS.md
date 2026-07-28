# ERRORS

## 2026-07-28 — Tauri DMG signing and Gatekeeper boundary

- `pnpm tauri bundle --bundles dmg --no-sign` rebuilds a temporary `.app` for the DMG and removes it after packaging, so manually signing a previously generated app does not guarantee that signature reaches the disk image.
- For a local acceptance package without Developer ID, pass `bundle.macOS.signingIdentity: "-"` to the same Tauri `bundle --bundles app,dmg` invocation. This creates a complete ad-hoc resource seal; verify both the source app and the DMG-mounted app with `codesign --verify --deep --strict`, then validate the image with `hdiutil verify`.
- A complete ad-hoc seal prevents the package itself from being signature-corrupt, but it is not a public distribution identity. `syspolicy_check distribution` correctly reports `Adhoc Signed App` and a missing notarization ticket. On this development Mac, `spctl --status` reports assessments disabled, so `spctl accepted` is only a local override and cannot validate the downloaded-user prompt.

## 2026-07-28 — reqwest 0.13 query feature

- With `default-features = false`, reqwest 0.13 does not expose `RequestBuilder::query` unless the `query` feature is enabled alongside `json` and `rustls`.

## 2026-07-28 — pnpm 11 build approval

- pnpm 11 ignores `package.json#pnpm.onlyBuiltDependencies`; approve required dependency scripts with `pnpm approve-builds <package>`, which persists `allowBuilds` in `pnpm-workspace.yaml`.
- `esbuild` must be approved for Vite/Vitest in this repository.

## 2026-07-28 — Tauri transparent-window feature alignment

- Setting `app.macOSPrivateApi: true` in `tauri.conf.json` also requires the `macos-private-api` feature on the `tauri` dependency in `src-tauri/Cargo.toml`; otherwise Tauri's build script rejects `cargo test/check` with a feature allowlist mismatch.
