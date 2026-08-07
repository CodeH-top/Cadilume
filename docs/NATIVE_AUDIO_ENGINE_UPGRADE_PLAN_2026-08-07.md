# Cadilume：从 WebView 播放替换到 Rust 底层播放引擎的升级计划（2026-08-07）

## 1. 背景与目标

- 现状：v0.1 采用 WebView `HTMLAudioElement` 播放（双元素预缓冲），受 WebKit/Chromium
  解码边界影响，存在 `MediaError code 4`、高频切歌卡顿、后台/隐藏窗口播放与
  Now Playing/SMTC 缺失等硬边界。
- 2026-08-07 spike 结论：`rodio 0.22`（cpal 输出 + symphonia 解码）在 Tauri 进程中
  播放真实 PMS 流（代理下载落盘后播放本地文件）连续正常、无卡顿；`kithara` 的
  firewheel/cpal 管线在 Tauri 进程约 1 秒后卡死且输出噪声，暂缓待上游稳定。
- 目标：把播放权威从 WebView 迁移到 Rust `AudioEngine`，覆盖队列、进度、seek、磁盘
  缓存、后台播放、输出设备选择、macOS Now Playing 与 Windows SMTC。
- 硬约束：完全集成（禁止系统安装依赖）；许可与 MIT 应用兼容（不使用 BASS、GPL 组件、
  libmpv）；macOS + Windows 双端；不进行客户端转码（PMS universal transcode 兜底）；
  日志/事件脱敏。

## 1.5 执行进度（2026-08-07 更新）

- Phase 0 ✅ 完成：spike 清理、基础 bug/UI 修复、开发/生产凭证隔离、开发态静默启动。
- Phase 1 ✅ 完成：rodio AudioEngine 正式化；进度/结束事件；队列权威迁入 Rust
  （曲目列表/当前索引/repeat/shuffle 决策在 Rust，前端负责票据加载与 UI 镜像）。
- Phase 2 ✅ 完成：磁盘缓存 512MB LRU（按 mtime 淘汰、`.part` 优先清理、命中刷新），
  设置页展示并清理封面+音频缓存。
- Phase 3 ✅ 完成：边下边播（渐进 Reader + 后台下载，头部 256KB 就绪即开播）。
- Phase 4 ✅ 完成：ahead 预取下一首到缓存；严格 gapless 已实现——预取完成后把
  下一首解码器直接挂入 rodio 顺序队列（`HandoffMarker` 在样本级交接时翻转），
  当前曲目结束即无间隙 PCM 衔接；MP3 编码延迟由 rodio 队列的帧对齐处理，
  FLAC 天然无缝。重复一首/队列不一致时自动降级为普通顺序播放。
- 真实 PMS 自动化回归 ✅（`cargo test -- --ignored real_pms_engine_regression`）：
  用开发态明文 token 从真实资料库取两首 FLAC，串行下载 → 磁盘缓存 → 渐进播放 →
  预排下一首 → 自然结束无缝交接 → seek → 暂停/恢复，已在本机通过。
  同时给 `download_progressive` 增加 Content-Length 完整性校验：静默截断的下载
  不再被当作完整缓存提交（修复缓存命中半截文件的风险）。
- 真实 PMS 高频切歌回归 ✅（`cargo test -- --ignored
  real_pms_engine_rapid_switch_regression`）：串行预缓存最多 10 首真实曲目后
  连续快速加载/切换两轮共 20 次，第二轮穿插 seek/暂停/恢复，全部无失败，
  覆盖历史上 WebView 高频切歌 error4/卡顿场景。
- Phase 5 ✅ 完成：macOS Now Playing/Remote Command Center + Windows SMTC
  （Windows 目标已用 `cargo xwin build --target x86_64-pc-windows-msvc`
  真实编译并链接出 `Cadilume.exe`，期间修复 block2 未按 macOS 目标隔离、
  windows 0.58 PascalCase API 等编译问题；运行时交互验收待 Windows 实机）；
  输出设备选择已补完——cpal 枚举设备、`native_audio_set_output_device` 重建
  播放器并从原进度恢复（缓存命中优先，否则重新渐进下载），前端
  `setOutputSinkId` 与设备列表走原生通道，旧事件线程干净退出。
- Phase 6 ✅ 完成：WebView/HTMLAudio 播放路径全部移除（usePlayer native-only，
  删除 DualAudioPool/预缓冲/媒体错误回退等约 1400 行及对应单测）。

剩余事项：真实 PMS 听感回归（用户实听：主观无间隙、歌词对时与 UI 层高频操作）、
Windows 实机运行时验收（SMTC 交互、隐藏窗口后台播放；编译与链接已通过）。

### Windows 实机验收清单（待 Windows 环境执行）

1. `pnpm tauri build` 完整构建（macOS 上 MSVC 交叉构建被 `aws-lc-sys` 的 C
   工具链挡住，需在 Windows 机器上构建）。
2. 播放一首真实 PMS 曲目，确认任务栏 SMTC 显示标题/歌手/专辑/封面与进度；
   按媒体键 play/pause/next/previous/seek 均生效且不泄露 PMS 信息。
3. 最小化窗口后继续播放不中断（引擎在 Rust 进程，不依赖 WebView 定时器）。
4. 隐藏窗口（任务栏隐藏/关闭到托盘）播放保持；通过托盘恢复窗口不打断播放。
5. 设置页输出设备列表可枚举并切换，切设备后从原进度恢复。

## 2. 现状盘点（dev 分支起点）

| 层 | 现状 |
| --- | --- |
| 前端播放 | `usePlayer` 状态机 + `HTMLAudioElement`（双元素预缓冲、票据在途去重、回退 320/256/192） |
| Rust 票据 | `StreamProxy`：loopback 票据、连接并行测试/降级、503/429 退避、`audio/*` 白名单、脱敏诊断 |
| Rust 引擎 | `audio_engine.rs` 骨架：rodio 命令（load/play/pause/seek/volume/status/device_check）、下载落盘缓存、默认音量 20% |
| 磁盘缓存 | 雏形：`native-audio/downloads/{ratingKey}.{ext}` 全量下载 + `.part` 原子提交 + 重复命中 |

## 3. 总体架构

```text
前端 usePlayer（统一状态机与 UI）
  └─ 播放后端抽象：WebViewBackend（现状） | NativeBackend（目标，可开关切换）
        └─ Rust AudioEngine（命令 + 事件，脱敏）
              ├─ 播放控制：load/play/pause/seek/volume/stop
              ├─ 进度与状态事件：50ms 轮询 → native-audio://event
              ├─ DiskCache：LRU、上限、原子写入、命中校验、Delete Caches
              ├─ 边下边播与 ahead 预取（Phase 3）
              └─ 系统集成：macOS Now Playing / Windows SMTC（Phase 5）
```

- 前端保留统一 UI/歌词/队列展示；内核迁移后队列权威在 Rust，前端只做视图与命令。
- 双后端并行期通过配置/开关切换，WebView 作为回退保留到 Phase 6 结束。

## 4. 阶段计划

### Phase 0：当前清理与基础修复（用户当前优先）

- 已完成：删除 spike 测试按钮（原生试播/设备自检）与 DevTools 钩子；保留 Rust
  `AudioEngine` 命令骨架供后续落盘。
- 用户先行修复既有基础 bug 与 UI 问题（不依赖内核替换）。
- 验收：dev 分支 WebView 播放无回归；清理改动提交。

### Phase 1：AudioEngine 正式化（队列 / 进度 / 事件）

- 队列权威迁移到 Rust：曲目列表、当前索引、repeat/shuffle、自然结束与失败事件。
- 播放控制完整：play/pause/seek/volume/stop；seek 需验证 MP3 粒度并回退转码源。
- 进度发布：每 50ms 轮询引擎位置 → `native-audio://event`（只含位置/时长/状态，
  不含来源）；歌词对时沿用现有 `usableDurationSeconds` 语义。
- 前端 `NativeBackend` 实现与开关（设置页“原生播放内核”实验项或环境变量）。
- 验收：真实 PMS 流连续/随机切歌 20+ 次无 error4/卡顿；进度与歌词对时；seek、
  暂停恢复正确；Windows 隐藏窗口后台播放不中断（Phase 1 即验证）。

### Phase 2：磁盘缓存正式化

- 借鉴 kithara `kithara-storage` 设计（MIT/Apache，源码可参考/引用并保留声明）与
  Plexamp 策略（clean-room）：
  - LRU 容量上限（默认 512MB，可配置）、容量统计、淘汰策略；
  - 元数据索引落盘（JSON/二进制）、损坏自愈；
  - 原子写入（`.part` + rename）、命中校验（大小/etag）；
  - 设置页现有“清理缓存”入口扩展到音频缓存（Delete Caches 语义）。
- 验收：重复播放命中缓存；超限正确淘汰；重启后缓存可用；清缓存后正确失效且不影响
  封面缓存。

### Phase 3：边下边播与 ahead 预取

- 借鉴 kithara `kithara-stream` 的 pull-driven range fetch：先下载头部可播放的
  1–2MB 开播，后台继续补齐同一文件（可 seek 文件天然支持）。
- 借鉴 Plexamp：队列 ahead 预取（桌面建议 2–3 首）、预取限速（默认 5 Mbps）、
  逐首失败不阻塞播放。
- 验收：长曲目秒开；切歌预取可见；带宽受限下播放不卡；缓存仍满足 Phase 2 约束。

### Phase 4：无缝衔接 / gapless

- rodio 顺序播放间隙优化：预解码下一首开头并做衔接（借鉴 kithara prefetch 思路）。
- MP3 编码延迟（padding/delay）处理；FLAC 天然 gapless。
- 验收：连续专辑/现场专辑无明显间隙；歌词跨曲对时；失败时降级为普通顺序播放。

### Phase 5：系统集成

- macOS Now Playing / Remote Command Center：`MPNowPlayingInfoCenter`（objc2 已有依赖）。
- Windows SMTC：`Windows.Media.Playback` / SMTC（windows crate 接入）。
- 输出设备选择：cpal 枚举/切换，接入现有 `outputSinkId` 前端逻辑。
- 验收：双端系统媒体控制（播放/暂停/seek/封面/进度）可用且不泄露 PMS 信息。

### Phase 6：WebView 播放退役

- `NativeBackend` 默认启用；WebView 保留为异常回退（可配置关闭）。
- 删除双 `HTMLAudioElement` 预缓冲等 WebView 专用逻辑；清理 `usePlayer` 中死分支。
- 发布验证：macOS/Windows 打包、真实 PMS 全功能回归（歌词/黑胶/队列/切歌/设置）。

## 5. 借鉴来源与合规边界

- kithara（MIT OR Apache-2.0）：`storage`/`stream` 设计与源码可参考或按许可引用
  （引用时保留版权声明）；不引入 `kithara-play`（firewheel 与 Tauri 兼容问题未解）。
- Plexamp（闭源）：仅 clean-room 策略借鉴（缓存上限、ahead 预取、限速、Delete
  Caches、preferDownloadedMedia），不复制代码与私有实现。
- 使用栈：rodio（MIT/Apache）、cpal（MIT/Apache）、symphonia（MPL-2.0）、
  reqwest（MIT/Apache）——均与 MIT 应用兼容，全部静态集成。
- 不使用：BASS（闭源商业）、GPL 组件、libmpv（LGPL/系统依赖）、ffmpeg 二进制。

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| rodio/symphonia 对部分格式（HE-AAC/Opus/WMA）不支持 | 走 PMS 转码回退（现有 mp3 链路），原始格式白名单之外一律转码 |
| MP3 seek/gapless 粒度有限 | Phase 1/4 单独验收；MVP 允许“减少间隙”而非严格 gapless |
| Windows 后台/隐藏窗口播放 | 引擎在 Rust 进程，不依赖 WebView 定时器；Phase 1 重点回归 |
| 缓存索引损坏/版本迁移 | 索引落盘 + 自愈重建；清理入口兜底 |
| 双后端切换期间状态漂移 | 前端统一状态机 + 明确切换时机（无活动播放时） |

## 7. 分支策略与执行顺序

- `main`：稳定基线（当前 `d77f732`）。
- `webview`：WebView 播放版本基线（当前 `d77f732`，与 main 相同，供回退/对比）。
- `dev`：后续开发分支——先修基础 bug/UI（Phase 0），完成后再按 Phase 1→6 落盘
  内核播放；每个 Phase 独立验证与本地提交。
- 提交/推送纪律：本地提交不强制 push；用户明确要求时 push（当前要求推 webview/dev
  到远端，等待远端地址配置）。
