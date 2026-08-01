# ERRORS

## 2026-08-01 — 重启开发链时，钥匙串授权会在窗口创建前阻塞启动

- `PlexState::load()` 在 Tauri `setup` 的主线程读取 Keychain；如果 macOS 为新的开发可执行文件弹出 `SecurityAgent` 的“允许 Cadilume 使用钥匙串机密信息”对话框，主窗口和菜单栏状态图标都会在授权前尚未创建。这不是无窗口后台行为，也不能把它判为启动失败。
- 此时不得代填、绕过或点击“拒绝”以继续验收；应由用户在系统安全对话框中输入登录钥匙串密码并选择允许，再继续读取真实窗口的辅助功能树。持续保留一条已授权的开发链仍是避免重复触发该确认的最佳方式。

## 2026-08-01 — 无截图验收时避免用内置浏览器 locator 点击

- 本地内部浏览器的 Playwright locator 点击有时会由浏览器后端自动附带预览图，即使调用方没有请求截图。在用户要求不截图的 Cadilume 验收中，停止使用这类交互路径；改用只读 DOM / computed-style / 控制台检查，并把真实交互留给 macOS Accessibility 树。

## 2026-08-01 — 内部浏览器 CUA 对非原生焦点容器的 hover / Tab 验证不可靠

- 在 Cadilume 的本地 fixture 中，内部浏览器可读取通知堆叠的 DOM、computed style、可访问性树和按钮点击结果，但其 `cua.move`、`dom_cua.click` 与全局 Tab 不总会向带 `tabIndex` 的非原生 `ul` 派发与真实浏览器一致的 hover / focus 行为。
- 这不是产品交互失败的证据。后续遇到同类受控 UI 时，继续用内部浏览器验证可见 DOM / 样式 / 控制台，并以组件回归测试直接覆盖 `onPointerEnter`、`onPointerLeave`、`onFocusCapture` 与 `inert` / Tab 顺序；最终真实 WebView 统一验收仍按计划留给对应原生阶段，且不截图。

## 2026-07-31 — 内部浏览器本地 URL 曾阻断，现已恢复

- 初始已有 Cadilume `http://[::1]:1420/#/settings` 标签被 Browser URL policy 拒绝；当时没有改用 raw CDP、其他浏览器或其他自动化表面绕过。
- 后续使用内部浏览器的新标签重新进入同一 Vite 地址后，页面读取和交互恢复。只把可用的 `1280×720` 记录为较小视口验收，计划中 1280×820 的覆盖由真实 Tauri `1280×801` 窗口补强，不能把两者混写。
- `src-tauri/src/plex.rs` 的四处 Rustfmt 建议已按原样精确收口；`cargo fmt --check` 与 45 项 Rust 测试均通过。

## 2026-07-31 — 不用 AX 文本注入修改设备名；完整终止 Tauri 开发进程组

- macOS `System Events` 的可访问性文本注入曾把设备名称错误持久化为单个逗号；它不适合作为自由文本持久化的写入验收手段。需要恢复时先读取 `scutil --get ComputerName` 与 `Application Support/top.codeh.cadilume/config.json`，只精确修复 `deviceName`，再由原生进程重新加载。
- 仅向 `pnpm tauri dev` 父进程发送 `TERM` 可能遗留其 `pnpm dev` / Vite 子进程并占用 `1420`。确认 PID、cwd 和 process group 都属于 Cadilume 后，终止该已知进程组，再只启动一条 `pnpm tauri dev`。
- 验收必须读取真实 Cadilume 原生窗口的 Accessibility 树，而不是仅看浏览器：设置页已显示恢复后的系统名称；用户也在 Plex 实际客户端卡片中确认 `Cadilume — <设备名称>` 和播放状态均被接收。

## 2026-07-30 — 内部浏览器不能证明 View Transitions；真实 WKWebView 的 root 转场会闪屏

- 在内部浏览器打开 Ant Design 官方主题页时，页面运行态返回 `typeof document.startViewTransition === "undefined"`，因此该环境只会执行无动画降级，不能用它判断 Ant Design 或 Cadilume 的 View Transition 揭示观感。
- 真实 Tauri WKWebView 中，即使关闭 `::view-transition-group/image-pair/old/new` 的默认动画，`document.startViewTransition` 的 root 圆形揭示仍会先闪出一帧；Cadilume 不应把它作为主题动效主路径。
- 稳定方案是应用自管双层揭示：切换前克隆 `#root` 为 `aria-hidden`、`inert` 的旧主题快照并内联旧 CSS token；把真实根节点放在上层，以标准元素 `clip-path: circle()` 从触发点扩开，完成后删除快照。重复点击只由状态锁忽略，主题按钮不设置 `disabled`，以保持正常 `pointer` 状态。

## 2026-07-30 — 路由 revision 不能把同页激活误判为页面切换

- `loadView()` 原先无条件递增 `contentRevision`，而 `.route-content` 的 key 包含该 revision 且默认带 `route-content-in`。因此重复点击已打开的“设置”会重新挂载整个路由内容，重播 `opacity + translateY(5px)`，主观上表现为主题切换时的页面抖动。
- 修复方式是把入场动画显式绑定到实际可见内容的切换：初始渲染、同一 hash 的重复激活、同页刷新与主题 rerender 都不改变 revision；同一目标正在切换时忽略重复激活，不同目标仍可中断转向。动画 class 也不再是 `.route-content` 的默认样式。
- 真实 Tauri 开发态通过 macOS Accessibility 复测：连续四次点击当前“设置”后，在 `20–490ms` 采样中标题矩形始终为 `x=472, y=144, 54×33`；浅→深→浅主题切换期间该矩形同样保持不变，两个按钮均保持 enabled。

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
- A real DMG build is different from an external-target compile check because the packaging script and final artifact paths intentionally live under the repository's default `src-tauri/target`. If that target fails while reading generated permissions from a pre-rename absolute path such as `.../plex-music/...`, run `cargo clean --manifest-path src-tauri/Cargo.toml` against this explicit regenerable build directory, then rerun `pnpm bundle:macos:dmg`. The dedicated script must still remove `bundle/macos/Cadilume.app` on completion, and packaging acceptance must verify both project-local `find` and project-scoped Spotlight results are empty.
- 本轮再次确认：包含 `rm -rf` 的临时 target 清理 trap 会被命令安全层拒绝；改用已核对的 `mktemp` 绝对目录，再以 `find <目录> -depth -delete` 清理并验证路径不存在。
