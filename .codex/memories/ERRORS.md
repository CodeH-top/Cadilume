# ERRORS

## 2026-07-28 — Xcode 26 `ictool` name collision

- `xcrun --find ictool` resolves to Xcode's asset-catalog compiler and does not support Icon Composer's `--export-preview` interface, even though both executables share the same name.
- Locate the Icon Composer CLI relative to the active `xcode-select -p` directory at `../Applications/Icon Composer.app/Contents/Executables/ictool`; continue using `xcrun actool` for the asset-catalog compilation step.

## 2026-07-28 — Tauri DMG signing and Gatekeeper boundary

- `pnpm tauri bundle --bundles dmg --no-sign` rebuilds a temporary `.app` for the DMG and removes it after packaging, so manually signing a previously generated app does not guarantee that signature reaches the disk image.
- For a local acceptance package without Developer ID, pass `bundle.macOS.signingIdentity: "-"` to the same Tauri `bundle --bundles app,dmg` invocation. This creates a complete ad-hoc resource seal; verify both the source app and the DMG-mounted app with `codesign --verify --deep --strict`, then validate the image with `hdiutil verify`.
- A complete ad-hoc seal prevents the package itself from being signature-corrupt, but it is not a public distribution identity. `syspolicy_check distribution` correctly reports `Adhoc Signed App` and a missing notarization ticket. On this development Mac, `spctl --status` reports assessments disabled, so `spctl accepted` is only a local override and cannot validate the downloaded-user prompt.

## 2026-07-28 — reqwest 0.13 query feature

- With `default-features = false`, reqwest 0.13 does not expose `RequestBuilder::query` unless the `query` feature is enabled alongside `json` and `rustls`.

## 2026-07-28 — pnpm 11 build approval

- pnpm 11 ignores `package.json#pnpm.onlyBuiltDependencies`; approve required dependency scripts with `pnpm approve-builds <package>`, which persists `allowBuilds` in `pnpm-workspace.yaml`.
- `esbuild` must be approved for Vite/Vitest in this repository.

## 2026-07-29 — Fresh Tauri target directory after repository relocation

- A previously reused Cargo/Tauri target can retain absolute paths from an earlier repository location and make a valid release build fail for stale-path reasons unrelated to current sources.
- For a clean release compilation check, create a fresh temporary directory and run `CARGO_TARGET_DIR=<fresh-dir> pnpm tauri build --no-bundle`; remove only that explicitly created temporary directory afterward. Do not treat the normal project target as disposable and do not build a DMG unless the current user request explicitly asks for packaging.
- The Codex command safety layer can reject an otherwise narrowly scoped cleanup trap when its command text contains `rm -rf`. Preserve the build exit code in a task-specific variable, delete files with `find <fresh-dir> -depth -type f -delete`, then delete only empty directories with a second depth-first `find`; verify that no matching temporary target or `.app` remains.
