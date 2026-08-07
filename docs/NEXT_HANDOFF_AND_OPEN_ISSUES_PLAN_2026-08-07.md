# Cadilume 开发计划与问题记录（2026-08-07）

本文是 2026-08-07 收尾后的唯一后续执行入口。下次继续时先读本文，再按第 4 节顺序执行；
更早的计划（`NEXT_HANDOFF_AND_OPEN_ISSUES_PLAN_2026-08-05.md`、
`NATIVE_AUDIO_ENGINE_UPGRADE_PLAN_2026-08-07.md`）作为历史上下文保留。

## 1. 工作区与开发态事实

- 仓库：`/Users/hoganchou/Documents/Work/Project/AI/cadilume`，分支 `dev`。
- 收尾 HEAD：`bce742e`（播放保护：前端异常/卡顿立即停播 + Rust 心跳看门狗）。
- 今日开发态按用户要求已关闭；下次启动仍用同一条链：
  `cd cadilume && pnpm tauri dev`（静默隐藏窗口、凭证只读 `~/.cadilume-dev-token`、
  不抢焦点、不重复开第二条链）。
- 今日完整验证基线：`pnpm check` 通过；`pnpm test` 28 个文件 163 项通过；
  `cargo test` 65 项通过。

## 2. 今日已完成（按提交顺序）

| 提交 | 内容 |
| --- | --- |
| `a82f72b` | 下载串行化：同一时刻单条真实流；播放抢占并中止旧下载/预取，解决远程 PMS/反代多流截断“打架”。 |
| `cfefeaa` | 代理禁用连接复用（`pool_max_idle_per_host(0)`）；真实曲目封面走票据；播放加载转圈无条件生效。 |
| `961100c` | 自动源/原始源先试原始直连，失败再降级转码（新增单测）。 |
| `fb95edc` | 引擎事件线程改用 Tauri 全局运行时 spawn，修复同步命令首建引擎时 `tokio::spawn` panic/SIGABRT。 |
| `d95f9a1` | Now Playing 更新增加脱敏诊断日志。 |
| `1e53e5a` | 底部 mini 黑胶去掉主题色 focus 边框。 |
| `38d04a1` | 切歌立即停旧歌且进度归 0；单曲/首尾按循环边界禁用上下切歌。 |
| `88acd36` | 切歌瞬间（点击同一帧）就停旧歌并归零进度，不等 Rust 队列 IPC 返回；上一首失败回落当前曲目开头。 |
| `bce742e` | 播放安全保护：前端 `error`/`unhandledrejection`/主线程卡顿（>3s）立即 `nativeAudioStop`；前端 1s 心跳，Rust 6s 未收到且正在出声自动清空播放器。 |

另提交项目记忆约定：`c6758ec`（切歌瞬间停歌+归零的实现约定）。

## 3. 未解决问题与风险（下次优先）

### P0-1 开发态卡死/静默退出根因（尚未最终定位）

- 已确认 16:17 崩溃报告（SIGABRT）是旧 `tokio::spawn` 无运行时上下文 panic，`fb95edc`
  已修复；该报告来自修复前的调试包。
- 17:05 左右开发态整条链静默退出，无新崩溃报告；当时症状为“UI 卡住但音乐继续”，
  符合“主线程被同步命令/锁卡住，rodio 播放线程独立出声”的假设。
- 本轮已加双层兜底（见 `bce742e`），但**根因尚未抓到**。下次复现时必须采集：
  1. 开发态终端完整日志（session 输出）；
  2. 卡住瞬间的 `sample <pid>` / `spindump` 主线程栈；
  3. 是否出现 `[原生] 前端心跳丢失，自动停止播放（保护）`。
- 重点怀疑方向：高频切歌时同步命令（`native_audio_stop`/`native_queue_next`）与事件
  转发线程的锁交互；`native_audio_stop` 中 `player().clear()` 是否会在源被占用时阻塞。

### P0-2 macOS Now Playing 控制中心仍看不到歌曲信息

- 日志已确认 `NowPlaying 更新` 含 title/artist/album，但 `artwork_bytes=0`（真实曲目
  封面票据路径已改，但票据尚未生效或取图失败）。
- 关键未做项：macOS 还必须在 `MPNowPlayingInfoCenter` 显式设置
  `playbackState = .playing/.paused`，否则控制中心不渲染卡片；当前代码没有设置。
- 下一步：查 `objc2-media-player 0.3.2` 是否有 `setPlaybackState` API，没有则用 objc2
  runtime 消息调用；播放开始/暂停/结束都同步状态；再验证封面票据日志 `artwork_bytes>0`。
- Windows SMTC 仍未实机验证。

### P1-1 高频切歌/下载“打架”需真实回归

- 已做串行化 + 播放抢占，但需要用户实测高频切歌：同时只能有 1 条下载请求；切歌瞬间
  旧歌立即停、进度立即归 0；不再出现 `IncompleteBody`/`error decoding response body`。
- 若切到新歌加载卡顿，旧歌必须已停（`38d04a1`/`88acd36` 已实现，待验收）。

### P1-2 歌词同步（留存点）

- 用户当前测试认为歌词已对上；标记为留存点：后续生产环境可能复现，保留现有歌词日志与
  边界逻辑，出现问题时优先对比 LRC 时间轴与真实播放进度事件。

### P1-3 统一真实验收清单（等用户）

- 上一首/下一首边界（单曲禁用、首尾禁用、循环/随机可切）。
- 历史进度恢复：播放前进度条渲染、从历史进度续播。
- 音量默认 50、前端缓存音量同步引擎、引擎无默认音量。
- 自动源播放、推荐专辑/歌手详情播放不再闪退。
- 下载失败/无法播放场景的提示与重试。
- 播放按钮 loading 转圈（不是黑胶转圈）。

## 4. 下次执行顺序

1. 只读确认无残留开发态进程，再启动唯一一条 `pnpm tauri dev`。
2. 先观察心跳保护是否误触发或正确触发（终端关键字：`心跳丢失`、`播放保护`）。
3. 复现高频切歌并采集日志；卡住时立即 `sample <pid>` 抓主线程栈，定位 P0-1 根因。
4. 完成 P0-2：Now Playing `playbackState` + 封面验证。
5. 按 P1-3 清单做统一真实验收，全绿后提交（本地提交，不 push）。

## 5. 纪律提醒

- 默认中文；本地提交不 push；不主动截图。
- 开发态只保一条链，静默启动；凭证只读 `~/.cadilume-dev-token`，Release 用 Keychain。
- 日志/文档不得泄露真实 PMS URI、token、路径；提交纪律见项目 `.codex/memories/ACTIVE.md`。
- 每轮结束做记忆检查（`.codex/memories`），并同步到本文第 3 节问题状态。
