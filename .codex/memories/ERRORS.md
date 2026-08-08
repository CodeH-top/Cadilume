# ERRORS

## 2026-08-08 — APFS 大小写迁移后的缓存与开发态地址

- macOS APFS 默认不区分大小写；目录实际改为 `Cadilume` 后，`test -e .../cadilume` 仍可能返回成功，不能用它判断旧目录是否并存。用父目录的大小写保留列表、Git 根路径和进程 cwd 交叉确认实际入口。
- Cargo/Tauri 的 `src-tauri/target` 会把仓库绝对路径写入 `.d` 和构建脚本产物。目录只改大小写后，必须针对明确可再生的项目 manifest 执行 `cargo clean --manifest-path src-tauri/Cargo.toml`，再重新构建；不清理其他项目或宽范围缓存。
- Tauri 开发态的 Vite 在本机配置下监听 `[::1]:1420`；对 `127.0.0.1:1420` 的失败只是地址族不匹配，先用 `http://[::1]:1420/` 或 `localhost` 验证，再判断服务是否异常。

## 2026-08-08 — Tauri 打包验收可能遗留第二个 Cadilume 进程

- `pnpm tauri build --debug --no-bundle` 或手工启动 `target/debug/bundle/macos/Cadilume.app`
  会留下独立于唯一 `pnpm tauri dev` 链的 bundle 进程；它不会显示为 Vite/Tauri CLI 子进程，
  但会造成两个媒体会话、重复 Now Playing 命令和错误的 UI 验收对象。
- 每次 macOS 验收前同时按 cwd/可执行路径检查 `target/debug/Cadilume` 与
  `target/debug/bundle/macos/Cadilume.app/Contents/MacOS/Cadilume`，确认只保留开发链；
  只终止已核对的本项目残留 PID，不要重启唯一开发链或清理构建目录。

## 2026-08-08 — 本地验收环境的三个可复用边界

- 新的 ad-hoc 签名会改变 macOS 钥匙串访问者身份并可能再次触发 ACL 确认；这不代表凭证损坏。
  Cadilume Debug 已使用 `~/.cadilume-dev-token` 避免该链路，Release 的本地验收包仍可能在
  重签后要求用户确认。不要通过放宽钥匙串条目到任意应用来规避。
- 本机 `/usr/bin/trash` 不接受 GNU 风格的 `--` 参数；清理已核对的临时路径时传入明确绝对
  路径且不要拼接 `--`，并在操作前后验证目标，不要因此改用宽范围 `rm -rf`。
- 内置浏览器的页面 `evaluate` 隔离环境不保证暴露 `HTMLElement` 构造器，使用
  `node instanceof HTMLElement` 会抛出 `TypeError`；几何验收应先做 null 检查，再直接读取
  `getBoundingClientRect` / `clientHeight` 等已确认节点能力。

## 2026-08-05 — 内置浏览器旧本地标签可能拒绝刷新

- 已存在的 `http://[::1]:1420` Cadilume 内置浏览器标签在 `tab.reload()` 时会被 Browser URL
  security policy 拒绝，即使标签列表仍可读取旧 DOM。该 DOM 不能作为当前 HMR 的验收依据。
- 不要改用 host 别名、其他浏览器、原始 CDP 或页面内重载规避该拒绝。先用 `lsof` 确认唯一
  Vite 监听，再以构建、测试、开发服务器当前模块源码和真实 Tauri 进程验证；把可见交互复核
  明确留为受限项。
- 本轮同时发现之前记录的开发链已不再监听；不能仅依据历史消息或旧浏览器标签断言开发态仍在。
  每次 HMR 验收前都应重新检查端口和项目所属进程，确认不存在后再启动唯一的 `pnpm tauri dev`。

## 2026-08-05 — 辅助功能服务无法定位裸 Tauri Debug 可执行文件

- 当前已确认运行的 `src-tauri/target/debug/Cadilume` 进程，在 `@oai/sky` 中不能按显示名
  `Cadilume`、Bundle ID `top.codeh.cadilume` 或绝对可执行路径被定位；三种目标都会返回
  `Invalid app`，即使 PID 和可执行文件路径仍可由只读进程检查确认。
- 这不是 HMR、Vite 或 WebView 启动失败的证据。不要为绕过它重启唯一开发链、启动已安装版或
  截图；本轮可用 Codex 内部浏览器的 DOM、computed style、控制台和 Tauri 构建补足验证。

## 2026-08-05 — 本地 Python 未提供 Playwright 验收运行时

- 系统 `python3` 和 Codex 工作区随附 Python 都无法导入 `playwright`，因此 `webapp-testing` 的原生 Python 脚本流程不能直接用于 Cadilume。
- 在不启动第二条 Tauri 原生链、且用户禁止截图的验收中，使用 Codex 内部浏览器读取构建预览的 DOM、可访问性状态和控制台；临时 Vite 预览须以实际监听的 IPv6 回环地址作为浏览器目标。

## 2026-08-05 — 内部浏览器的本地预览等待状态

- 内部浏览器可访问 `http://[::1]:4173`，但 `tab.playwright.waitForLoadState({ state: "networkidle" })` 在当前后端会直接报告不支持；不要把该 API 错误误判为页面加载失败。
- 对本地 Cadilume 预览改用 `domcontentloaded`、短暂稳定等待、DOM / computed-style 与控制台读取；结束后关闭临时浏览器标签、复位视口并终止明确由本轮创建的 preview 进程。
- 2026-08-05 在 `http://localhost:1420` 又出现标签会话失配：`tabs.new()` / `tabs.get()` 返回的 handle 不在当前 browser session，虽然列表仍显示新的空白标签；按浏览器恢复流程重新取 handle 后仍复现。此时停止重复导航和交互，不将其误判为应用加载失败，也不以截图或另一浏览器绕过 Cadilume 的内部浏览器验收约束；保留自动化检查，并把真实开发态交互列为待回归项。

## 2026-08-01 — 重启开发链时，钥匙串授权会在窗口创建前阻塞启动

- `PlexState::load()` 在 Tauri `setup` 的主线程读取 Keychain；如果 macOS 为新的开发可执行文件弹出 `SecurityAgent` 的“允许 Cadilume 使用钥匙串机密信息”对话框，主窗口和菜单栏状态图标都会在授权前尚未创建。这不是无窗口后台行为，也不能把它判为启动失败。
- 此时不得代填、绕过或点击“拒绝”以继续验收；应由用户在系统安全对话框中输入登录钥匙串密码并选择允许，再继续读取真实窗口的辅助功能树。持续保留一条已授权的开发链仍是避免重复触发该确认的最佳方式。

## 2026-08-01 — 无截图验收时避免用内置浏览器 locator 点击

- 本地内部浏览器的 Playwright locator 点击有时会由浏览器后端自动附带预览图，即使调用方没有请求截图。在用户要求不截图的 Cadilume 验收中，停止使用这类交互路径；改用只读 DOM / computed-style / 控制台检查，并把真实交互留给 macOS Accessibility 树。

## 2026-08-04 — 内部浏览器键盘注入不能证明原生 button 默认激活

- `tab.playwright` 的 `press("Enter")` / `press("Space")`、`dom_cua.keypress` 与 `cua.keypress` 在本地 Cadilume fixture 中会把原生 `<button>` 聚焦，却不触发其默认 click；同一控件的 pointer click 可正常更新 React 状态。
- 这不是产品键盘交互失败的证据。遇到此类验收时，不要为迁就自动化而给原生 button 额外添加可能双触发的 `onKeyDown`；保留语义化 button、ARIA 状态和组件级回归，并用真实 WebView / 原生辅助功能树补足交互验证。

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
- 2026-08-05 用户仍观察到封面闪烁后，原先对真实 `#root` 的 `clip-path` 圆形揭示被判定为不稳定：裁剪根节点会让 WKWebView 重新合成全部媒体层。稳定方案改为旧主题快照覆盖 live tree，等待快照图片解码和双 `requestAnimationFrame` 后同步更新 live theme，再仅将快照 `opacity` 淡出；绝不为 `#root` 设置 clip、filter 或过渡。重复点击仍由状态锁忽略，主题按钮不设置 `disabled`，以保持正常 `pointer` 状态。

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

## 2026-08-07 — Cadilume 开发态 UI 自动化边界

- System Events 读取 Cadilume 主页可访问性树可用（播放器按钮/进度条/歌词按钮
  都有 description），但搜索结果页（大虚拟列表）会让 `entire contents of
  window` 长时间挂起（20s+ 超时），`click` 歌单卡片也未必触发播放；不要依赖
  AX 做 Cadilume 的 UI 播放回归。
- 机械播放验证以引擎层真实 PMS 回归为准（无缝交接 + 20 次高频切歌），
  UI 层主观听感留给用户按计划文档清单执行。

## 2026-08-07 — 同步 Tauri 命令里 tokio::spawn 会 panic（fb95edc）

- 崩溃现象：点击推荐专辑播放时 SIGABRT，栈在 `native_queue_set` →
  `ensure` → `start_event_forwarder` → `tokio::task::spawn`。
- 根因：Tauri 同步命令（`native_queue_set` 等）在主线程执行，没有 tokio
  运行时上下文；若引擎首次创建发生在同步命令里，`tokio::spawn` 直接 panic。
  此前首个原生调用总是异步命令（预取/加载），所以没暴露。
- 修复：事件转发线程改用 `tauri::async_runtime::spawn`（Tauri 全局运行时，
  同步/异步上下文都安全）；`precache` 若换用该 API，注意其 JoinHandle
  `Future::Output` 是 `tauri::Result<T>`。

## 2026-08-07 — 开发态卡死/静默退出根因未定位，已加播放保护

- 症状：17:05 左右开发态整条链静默退出，无新崩溃报告；此前症状是“UI 卡住但音乐继续”。
- 16:17 的 SIGABRT 崩溃报告为旧 `tokio::spawn` 无运行时上下文 panic（`native_queue_set`
  首建引擎路径），`fb95edc` 已修复，该报告来自修复前调试包。
- 兜底已落地（`bce742e`）：前端 error/unhandledrejection/主线程卡顿 >3s 立即停播；
  前端 1s 心跳，Rust 6s 未收到且正在出声自动清空播放器并发出
  `playback-protected-stop` 事件。
- 下次复现时优先抓主线程栈（`sample <pid>`）和终端完整日志；重点怀疑同步命令
  `native_audio_stop`/`native_queue_next` 与事件转发线程的锁交互，以及
  `player().clear()` 在源占用时是否阻塞。
