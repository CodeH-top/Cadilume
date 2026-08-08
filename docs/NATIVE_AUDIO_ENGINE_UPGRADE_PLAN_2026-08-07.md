# Cadilume Rust 原生播放引擎升级记录（2026-08-07）

本文由实施计划收口为完成记录。当前架构以 `ARCHITECTURE.md` 为准，后续问题与验收入口
以 `NEXT_HANDOFF_AND_OPEN_ISSUES_PLAN_2026-08-07.md` 为准。

## 目标与硬边界

- 把播放权威从 WebView 迁入 Rust，覆盖下载、缓存、解码、队列、gapless、seek、后台
  播放、输出设备、macOS Now Playing 与 Windows SMTC。
- 应用必须独立运行：不要求用户安装 SDK、Homebrew 包、动态库、播放器或后台服务。
- 不使用 BASS、`treble.node`、libmpv、FFmpeg 二进制或 GPL 播放组件；不复制 Plexamp
  私有实现。Plexamp 只提供 clean-room 行为基线。
- 客户端不转码；兼容转换和降码率由 PMS universal transcode 完成。
- token、PMS URI、媒体路径和 cache identity 不进入日志或 WebView 持久化。

## 最终选型

保留 `rodio 0.22 + cpal 0.17 + symphonia 0.5.5`：

- rodio 提供 Player、队列、格式/声道转换和 cpal mixer 接入；
- cpal 直接使用 CoreAudio/WASAPI；
- symphonia 负责 FLAC、MP3、MP4/AAC、Vorbis 与 WAV 解码；
- crates 静态编入应用，运行时只链接操作系统框架；
- PMS 转码为本地不支持的媒体格式提供服务端兼容兜底。

本机 Plexamp 的 `treble.node + BASS` 具有闭源授权、私有模块和 bundle 动态库边界，
不满足 Cadilume 的开源与独立发行要求。libmpv/FFmpeg 会引入额外动态库、签名、许可和
分发复杂度。完全自写 CPAL 队列/混音层会重复 rodio 已验证能力并扩大实时音频风险。

只有出现无法由 PMS 转码兜底的主流格式缺口、rodio/cpal 无法修复的跨平台设备故障，
或有界 PCM 模型在真实负载下持续欠载，才重新打开换核评估。

## 已完成阶段

### Phase 1：播放与队列权威

- `native_audio_load/play/pause/stop/seek/volume/status` 和原生事件闭环。
- Rust 管理队列索引、repeat、shuffle、自然结束和系统远程命令；前端只镜像状态。
- shuffle 使用随机化 remaining bag，同一轮不重复，带历史 cursor；Rust 预览接口保证
  gapless 预排和自然推进使用同一候选。

### Phase 2：磁盘缓存

- 512 MiB mtime LRU、命中刷新、原子 `.part -> .audio`、损坏首块自愈。
- 缓存身份按 server/track/quality/codec/Part revision 隔离，再由 SHA-256 生成文件名。
- LRU 不删除活动 `.part`；下载 guard 清理取消/失败/abort；启动清理崩溃残留。
- 清缓存、登出、换账号会先取消并等待活动任务，再停播和删除，兼容 Windows 文件占用。

### Phase 3：渐进播放与预取

- 下载 256 KiB 头部后开始解码，后台继续同一文件；无 Content-Length 流可完整提交。
- 单条 PMS 下载 permit，播放优先于即时下一首，即时下一首优先于远 ahead。
- 同键并发预取共享任务；远 ahead 限速 5 Mbps，变成即时下一首时取消后全速升级。
- 首包/body chunk 30 秒无进展超时，空响应拒绝，Content-Length 截断最多重试三次。

### Phase 4：实时解码隔离与 gapless

- 每首曲目一个 symphonia worker；CoreAudio/WASAPI 回调只从有界 PCM channel
  `try_recv`，不执行网络、文件 I/O 或 codec 工作。
- PCM 以 1024 frame、声道对齐 chunk 传递，最多约 4 秒/512 chunk；欠载时先保持 frame
  对齐，再暂停 Player，恢复约 250 ms PCM 后继续。
- seek epoch 清空旧 PCM，并可中断渐进 Reader 在下载前沿的条件变量等待；短曲到 EOF 后
  worker 保留 decoder，后续向前/向后 seek 仍有效。
- worker 在 seek 抢占时保留当前已分配 chunk 作为 spare buffer，再归还复用池；连续
  代际切换不会为每次 seek 重新分配一批 `Vec<f32>`。
- 下一首完成下载和预解码后直接 append 到 rodio 队列，`HandoffMarker` 在第一个 sample
  被拉取时提交来源、时长、缓存身份和元数据。
- stop/切歌/设备切换使用取消 Reader、播放代际与替换 Player，不再调用可能同步等待
  渐进 Source 的 `Player::clear()`。

### Phase 3.1：渐进容器探测保护（2026-08-08）

- `Decoder::builder().build()`、时长探测和首批 PCM 准备移入 `spawn_blocking`，每个质量档
  设置有界准备超时，避免合法但需要更深容器探测的格式把 Tauri async worker 卡在下载前沿。
- 取消时同时设置下载取消位、递增 Reader interrupt epoch、唤醒条件变量，并有界等待下载/探测
  任务；失败与超时清理 `.audio.part`，前端可继续尝试 PMS 兼容质量。
- 活动下载槽通过进度对象做代际匹配，任务完成后自动释放；`.part` 原子改名与探测并发时
  优先读取已提交的完整缓存。
- 限速下载的 pacing 与最终提交均响应取消位，避免取消竞态把最后一个 chunk 提交成完整缓存。

### Phase 5：系统媒体与输出

- macOS `MPNowPlayingInfoCenter`：标题、歌手、专辑、时长、进度、速率、封面和显式
  `playbackState`；AppKit 媒体对象只在主线程创建，字典 key 必须使用 MediaPlayer 导出的
  `MPMediaItemProperty*` / `MPNowPlayingInfoProperty*` NSString 常量。
- macOS Remote Command Center：play/pause/toggle/next/previous/seek。
- Windows SMTC：标题、歌手、专辑、时间线、播放状态和基本媒体键；封面仍待实机实现/验收。
- cpal 原生输出设备枚举和切换；从缓存/来源、位置、音量和队列快照恢复。
- 桌面端禁用 WebKit MediaSession，避免覆盖原生系统会话。

### Phase 6：WebView 播放退役

- 删除 `DualAudioPool`、HTMLAudio 预缓冲、WebView media error 回退和桌面 MediaSession。
- `usePlayer` 的桌面路径只调用 Rust；浏览器演示状态不接触真实 PMS。
- 可见 WebView 连续两阶段心跳失联才保护停播；隐藏窗口不受 timer 节流影响，系统睡眠
  恢复有确认窗口。

## 关键故障及根因

### UI 卡住但音乐继续

rodio 的 `Player::clear()` 会等待音频线程。旧架构让渐进 Reader/decoder 直接被音频回调
拉取；当 Reader 等网络时，同步 stop/切歌调用会等待回调，继而卡住 Tauri IPC 和 WebView。

修复后，实时回调不再等待 I/O，stop 先取消 Reader 再替换 Player；旧播放代际无法回写。

### 弱网欠载和 seek

只把阻塞解码移到 worker 仍不够：若一个 chunk 到达就恢复，会在弱网下反复 pause/play；
若 worker 正卡在渐进文件前沿，向后 seek 也可能等到网络重新前进。

修复后使用 250 ms 恢复水位，并让 seek interrupt epoch 进入 Reader 条件变量谓词，向后
定位可立即回到已下载区域。

### shuffle 只在少数曲目间跳转

旧 Rust `next_index` 每次从排序后的候选中取第一个，`bag` 却记录已选项而非剩余项，
多曲队列会在前两个索引间往返；前端随机预览又常与 Rust 验证不一致，导致 shuffle
无法预排 gapless。

修复后 bag 表示当前轮剩余随机顺序，历史 cursor 支持可逆导航，前端直接请求 Rust 的
稳定预览候选。

### macOS 控制中心只有应用名

旧实现把 `MPMediaItemPropertyTitle` 等 Objective-C 符号名重新构造成 NSString，并用同一
错误字符串做单测回读。`playbackState` 和远程命令仍会生效，因此控制中心能显示应用名和
暂停/切歌按钮，但 MediaPlayer 会静默忽略全部错误 key，曲名、歌手、专辑、时间轴和封面
都不出现。

修复后直接使用 `objc2-media-player` 暴露的系统 NSString 常量，并用这些真实常量逐项
回读字典；测试同时断言旧符号名字符串不存在，避免再次出现自证通过的假阳性。

## 自动化覆盖

- 实时 Source 在 decoder 停顿 300 ms 时连续 4096 次拉取不阻塞。
- PCM 队列填满后背压且不超过硬上限；欠载恢复水位不退化为单 chunk。
- 渐进 decoder 卡在文件前沿时，向后 seek 在 1 秒内受理并重新产生 PCM。
- 48 轮 seek storm 中 PCM chunk 分配数不超过复用池容量加 1。
- 160 次本地真实 decoder 加载/seek/stop，所有 worker 在有界时间退出。
- 128 次播放代际切换，旧代不能回写。
- shuffle 稳定 peek、整轮无重复、repeat 边界与 Previous/Next 可逆。
- 64 路同键预取只发出一次 HTTP；远 ahead 升级、取消清理和账号 reset。
- 空响应、截断重试、chunked、缓存损坏自愈、LRU 与活动 `.part` 隔离。
- 本机真实 PMS 两首 FLAC 完整链路，以及最多 10 首、两轮共 20 次快速切换。
- Rust 全量 `99` 项：`97 passed / 0 failed / 2 ignored`；严格 Clippy 零警告。

## 待实机验收

1. macOS 连续专辑听感、弱网缓冲、隐藏窗口、睡眠恢复和设备切换的长期验收；控制中心
   曲目元数据/封面与媒体键的可见验收已于 2026-08-08 完成。
2. ReplayGain、crossfade、离线下载属于后续能力，不是本轮缺陷。

Windows 不属于本轮验收范围，也不作为本轮完成门禁；重新开启该平台工作时另立任务。
