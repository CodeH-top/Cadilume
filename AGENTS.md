# Cadilume 项目入口

本文件是 Cadilume 独立仓库的项目级工作规则。项目知识、开发记录和持续记忆都保存在本仓库内；开始工作时不需要依赖父目录的项目说明或父目录中的 Cadilume 记忆。

## 启动检查

每次在本仓库开始任务前：

1. 读取 `.codex/memories/PROFILE.md`，确认项目身份、范围和用户偏好。
2. 读取 `.codex/memories/ACTIVE.md`，应用当前有效的工程约束。
3. 按任务需要查阅 `docs/` 中的架构、交接和验证记录。

父工作区的通用安全规则仍然适用，但 Cadilume 的项目事实以本文件和本仓库 `.codex/memories/` 为准。

## 项目身份

- 产品与应用名称：`Cadilume`。
- macOS Bundle ID：`top.codeh.cadilume`。
- 独立仓库路径：`/Users/hoganchou/Documents/Work/Project/AI/Cadilume`。
- 当前开发分支：`dev`；本地提交即可，除非用户明确要求，否则不 push。
- 技术栈：Tauri 2、React 19、TypeScript、Vite、Rust。
- 当前开发与实机验收范围：macOS。Windows 代码路径保留兼容性，但不作为本轮实现或验收门禁。

## 工程边界

- 播放、缓存、解码、队列、设备输出和系统媒体控制的权威实现位于 Rust；桌面 WebView 只负责 UI、状态镜像和业务编排。
- 使用已验证的静态 Rust 播放链：`rodio 0.22.2`、`cpal 0.17.3`、`symphonia 0.5.5`。
- 发行应用不得要求用户安装任何外部运行依赖。禁止依赖 Homebrew、FFmpeg、libmpv、BASS、sidecar、独立后台服务或动态库安装包；系统自带 CoreAudio/MediaPlayer API 与编译进二进制的 crate 不属于外部运行依赖。
- Plex/Plexamp/PMS 只用于第三方服务、协议互操作或 clean-room 参考语义；不得复制 Plexamp 源码、私有模块、素材、标识、遥测键或授权二进制。
- 所有请求遵守 PMS ACL 和订阅能力边界；账号凭据留在 Rust 的系统凭据存储，不写入 WebView `localStorage` 或日志。
- 保留原生 macOS 窗口装饰、交通灯、最小化/恢复入口、独立软件音量和明确退出入口。初始化界面铺满内容区，不使用居中突出卡片。
- 开发期间只保留一条属于本仓库的 `pnpm tauri dev` 链；修改 Rust 或原生配置前先确认并复用这条链。

## 常用命令

开发工具（仅编译时需要）：Node.js 20+、pnpm 10+、Rust stable，以及 macOS 对应 SDK。应用运行时不需要额外安装任何第三方软件。

```bash
pnpm install
pnpm tauri dev
```

实现完成后的 macOS 验证顺序：

```bash
pnpm check
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build --debug --no-bundle
git diff --check
```

除非用户明确要求发布包，不要默认构建 DMG；需要发布时使用仓库脚本 `pnpm bundle:macos:dmg`，并验证签名、制品和残留 `.app`。浏览器 UI 预览使用 `pnpm dev`，真实 Plex API 只在 Tauri 进程内调用。

## Git 与记忆

- 每个实现轮次在目标验证全绿后立即创建本地 Conventional Commit，提交信息默认使用中文描述；不主动 push。
- 不使用 `git reset --hard`、`git checkout --` 或 `git restore` 丢弃用户改动；清理构建产物时只操作已明确确认可再生的项目路径。
- 每轮结束前检查本仓库 `.codex/memories/` 的 `PROFILE.md`、`ACTIVE.md`、`LEARNINGS.md`、`ERRORS.md`、`FEATURE_REQUESTS.md`；仅记录非显然、可复用的结论。父工作区记忆只记录跨项目规则，不写入 Cadilume 专属事实。
- 本入口文件被全局 gitignore 忽略；为保证独立仓库克隆后仍有完整入口，修改后使用 `git add -f AGENTS.md` 纳入提交。
