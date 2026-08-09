# ACTIVE

## Always Apply

- [ACT-001] Keep native window decorations enabled; never replace the macOS/Windows title bar with a fake mobile frame.
- [ACT-002] Keep the independent volume and mute controls visible in the fixed player bar at the minimum desktop window size.
- [ACT-003] 主窗口关闭统一执行原生最小化并继续播放，不再提供 `tray` / `quit` 状态选择；macOS 菜单栏 / Windows 通知区域状态图标显示与否是独立、持久化偏好。状态图标开启时保留唯一的原生显式退出入口，关闭时窗口仍须能从 Dock / 任务栏恢复，不能形成不可见后台进程。
- [ACT-004] Plex account token stays in Keychain/Credential Manager. PMS calls use each resource's per-server `accessToken`, especially for `owned:false` shared servers.
- [ACT-005] Do not client-gate basic authorized music by `subscription.active`; respect server ACL failures and feature-specific Plex Pass gates.
- [ACT-006] Rust `rodio + cpal + symphonia` is the authoritative desktop playback path. Keep WebView audio limited to browser/demo mode; do not reintroduce HTMLAudio as a desktop fallback or claim a second queue authority.
- [ACT-007] Use the browser demo dataset only outside Tauri. Real Plex traffic must run through Rust commands.
- [ACT-008] Keep the product/application name `Cadilume`, Bundle/application identifier `top.codeh.cadilume`, and repository directory `Cadilume` aligned. Use Plex/Plexamp/PMS names only for third-party service, API/protocol, interoperability, or clean-room research semantics.
- [ACT-009] The expanded now-playing view is an in-window modal that covers the entire viewport, including the fixed bottom bar, and must carry its own complete playback controls; it may never render outside the application window.
- [ACT-010] Generate the macOS 26 layered `Assets.car` from `src-tauri/icons/Cadilume.icon` and the legacy `.icns` from `app-icon.svg` with a true 1024px Retina slot via `pnpm icons:macos`; verify both the app icon and DMG volume icon before release packaging.
- [ACT-011] Treat ad-hoc signing only as a local acceptance package. Public macOS distribution that should pass Gatekeeper normally requires a Developer ID Application identity, hardened runtime, secure timestamp, notarization, and a stapled ticket.
- [ACT-012] Serve audio and artwork through separate bounded loopback ticket registries. Never expose PMS hosts, media paths, artwork cache keys, or tokens to the WebView; revoke both registries on account change/logout and only artwork tickets when clearing artwork cache.
- [ACT-013] Cadilume never performs client-side audio transcoding. A loopback media URL is only a credential-isolating stream proxy: original quality reads the PMS Part, while compatibility conversion or bitrate reduction is requested from PMS universal transcode, including when PMS runs on the same Mac.
- [ACT-014] Treat connection topology and media handling as independent dimensions: `local=true` is local direct, `relay=true` is Plex Relay, and the remaining reachable connection is remote direct; none of these labels alone means that client-side transcoding occurs.
- [ACT-015] Any Plex playlist creation or mutation must cross a dedicated Rust/Tauri command and use the selected server's scoped token; browser/demo mode may emulate the result, but WebView code must never call PMS directly.
- [ACT-016] Cadilume 的 localhost、演示页面与本地 UI 预览/验收默认使用 Codex 内部浏览器；只有确实需要读取 Plex 网页、复用 Plex 登录态或对照 Plex Web 可见行为时才使用 Chrome。此项目级规则覆盖全局的默认 Chrome 偏好。
  Source: user correction on 2026-07-30.
- [ACT-017] 默认不要为设置项、状态或普通操作自动生成小号补充说明；仅在风险、不可逆操作、必要前置条件或用户明确要求时使用。现有说明先保留，只有用户逐项指定时才删除或改写。
  Source: user correction on 2026-07-31.
- [ACT-018] 用户可见的视觉风格只能称为“琥珀金 / 雨林绿 / 澄海蓝”，不得以第三方产品或其配色命名；它是设置页内固定、紧凑、右对齐的三项单选，不是下拉菜单，切换成功须给出短提示。关闭主窗口的两项选择沿用同一紧凑单选布局。
  Source: explicit user correction on 2026-07-31.
- [ACT-019] Cadilume 持续开发期间保留且只保留一条已确认归属本项目的 `pnpm tauri dev` 开发链；前端改动优先依赖该链的 HMR，非必要不得重启原生进程或另起开发态，以维持 Keychain 权限与登录会话连续性。只有 Rust/原生配置变动或最终真实验收确有需要时，才在明确说明后重启这同一条链。
  Source: user request on 2026-07-31.
- [ACT-020] Cadilume 必须完全独立可用：播放内核及一切运行依赖都必须集成到程序内部，禁止要求用户在系统上安装任何独立依赖（如 `brew install mpv`、`libmpv-dev` 等）。系统自带 API（CoreAudio/WASAPI 等）与静态链接进二进制的 Rust 依赖符合此边界；外部动态库若无法静态集成且需要系统安装，默认不采用。
  Source: user constraint on 2026-08-06（原生播放内核选型轮）。
- [ACT-021] 开发态（debug）凭证只读写 `~/.cadilume-dev-token`（600 权限，git 忽略），
  永不访问 Keychain/Credential Manager；Release 构建只用当前平台的系统凭据存储。
  macOS 开发态启动窗口保持隐藏（用户点 Dock/菜单栏图标才显示），热重载不抢焦点；
  Windows 开发态必须显示主窗口并保留任务栏恢复入口，即使通知区域图标被关闭。
  Source: user requirement on 2026-08-07（凭证隔离与静默启动）。
- [ACT-022] 音量权威在前端：前端 localStorage 缓存音量并在每次加载/恢复时同步给
  引擎；引擎不设自身默认音量（rodio 原生 1.0 仅作瞬时值），无缓存时前端默认 50%。
  不得在 Rust 引擎里再写死默认音量。
  Source: user requirement on 2026-08-07（引擎默认音量与前端缓存关系）。
- [ACT-023] macOS 初始化界面必须直接覆盖整个原生内容区，不使用居中卡片、自定义标题栏、
  卡片边框/阴影或独立背景层；顶部只保留原生交通灯安全区与约 52px 拖拽区域。
  Source: user requirement and full-window validation on 2026-08-08.
- [ACT-024] 主窗口与展开播放器的定时歌词统一保持活动行垂直居中；只有滚动范围不足时才在
  顶部/底部钳制。切歌可归零旧滚动位置，但不得清空本次渲染已挂载的行 ref 后提前返回。
  用户手动滚动后，下一条可见歌词必须瞬时夺回定位；空白歌词帧保留手动标记，普通切句
  继续平滑跟随。
  Source: user requirement and dual-view DOM/wheel validation on 2026-08-08.
- [ACT-025] 音频缓存固定 1 GiB，采用 `segments-v2` 稀疏分段：首段 256 KiB，后续缺口为
  对齐 2 MiB Range，并以文件系统实际分配块计费；写入后还须保留至少 1 GiB 系统可用空间。
  当前曲目优先，预缓冲只为 Rust 确认的真实下一首建立第二 read head；不得扫描资料库、下载
  整条队列、恢复下下首或在下一首无 Range 时完整 fallback；样本级交接后必须把该 reader
  晋升为当前曲目优先级。LRU 保护活动条目，超额拒绝新块；离线下载保持独立能力。
  Source: user-confirmed fixed 1 GiB + sparse segment cache v2 and review hardening on 2026-08-09.

- [ACT-026] Windows 目标固定先验收 `x86_64-pc-windows-msvc`；macOS 交叉检查使用
  `cargo-xwin`，且共享缓存的 `cargo xwin` 命令必须串行运行。交叉编译、GitHub
  Windows runner 和本机脚本只能证明构建/配置门禁；WASAPI、SMTC UI、通知区域、
  Credential Manager 与 NSIS 安装器仍须在真实 Windows 会话验收。
  Source: Windows development scope expansion on 2026-08-09.

- [ACT-027] 全局通知卡片使用不透明主题面板背景和清晰边框，不使用 `backdrop-filter` 或会在
  卡片间形成灰色遮罩带的大范围阴影。通知队列位于标题栏下方 `14px`，自动关闭时间为
  `2s`；超过 5 条时原子淘汰最旧项，溢出批次不播放入场或退出闪烁。设置页缓存组沿用
  “播放”的双行 `settings-stack` 排版，每行只显示对应缓存大小；封面缓存与音频缓存必须拥有
  独立按钮、忙碌状态和清理流程。
  Source: user UI correction on 2026-08-09.

- [ACT-028] 黑胶模式的轴座与唱臂采用参考图式的简洁俯视图形：简单圆形轴座、单根浅色弯臂
  和小型唱头，三者保持连续连接；不要添加配重、万向节、螺丝、多层机械结构或写实材质细节，
  也避免厚重外壳、重阴影和漫画化装饰。轴座固定在唱片正上方居中，唱臂只从轴心向唱头方向
  伸出，轴心后方不画配重、尾杆或任何超出结构；轴座须与唱片底座留出间隙，唱臂只做连续的
  轻微缓弯。播放时整个唱头落在黑色沟槽区域，不能只有连接点在黑胶上而让唱头前端跨出外缘；
  暂停或未播放时须在轴座右侧近似水平摆放，并明显离开整块唱片底座，不能只越过黑胶外缘。
  轴座保持小巧，阴影必须沿最外层圆形生成，不能对整个唱臂 SVG 添加形成异形轮廓的全局阴影。
  唱头与臂杆保持固定角度并随整根唱臂连贯转动，不在播放状态切换时单独甩动；轴座绘制层必须位于
  臂杆之下，不能遮挡轴心处的连接段。
  唱片底座只保留黑胶外的一圈，不叠加第二层扩散圆环；展开播放器和底部小黑胶统一使用 `30s`
  一圈的旋转速度。
  Source: explicit user correction on 2026-08-09.

- [ACT-029] 展开播放器的黑胶与封面模式必须共用当前专辑封面采样出的全局四色主题背景，主题覆盖
  整个弹窗的标题区、视觉区、右侧歌词区和底部完整播放器控制区，不得退化成单色、模糊封面，
  也不得用横向深色遮罩或独立灰黑底把任一区域割裂成另一块底色。真实封面按四象限提取彼此有
  区分度的颜色并平滑插值；BlurHash 只用于封面未加载或 Canvas 读取失败时的回退，切歌期间先
  保留上一组有效颜色，确保主题稳定且文字对比度可靠。可以参考公开依赖的 API 与算法语义，
  但不得复制 Plexamp 私有模块或压缩源码。
  封面模式只在左侧显示一张独立方形专辑图：无外边距式衬层和描边，使用小圆角与克制阴影；
  歌词列保持透明，不在文字下增加不透明卡片。
  Source: explicit user correction on 2026-08-09.

## Validation

- Run TypeScript check, frontend tests/build, Rust tests, and a practical Tauri build before committing an implementation round.
