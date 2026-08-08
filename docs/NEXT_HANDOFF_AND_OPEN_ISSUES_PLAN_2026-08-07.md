# Cadilume 开发计划与问题记录（2026-08-07）

本文是 2026-08-07 原生播放内核收尾后的后续执行入口。更早的计划作为历史上下文保留；
播放器现状以本文和 `ARCHITECTURE.md` 为准。

## 1. 当前基线

- 仓库：`/Users/hoganchou/Documents/Work/Project/AI/Cadilume`，分支 `dev`。
- 播放内核：Rust `rodio 0.22 + cpal + symphonia`，全部静态集成；不需要 BASS、
  FFmpeg/libmpv、Homebrew 动态库、sidecar、SDK 或后台服务。
- Plexamp 只作为 clean-room 行为参考。本机 Plexamp 使用私有 `treble.node + BASS`，
  该实现闭源且带授权/动态库边界，Cadilume 不复制也不采用。
- 前端只负责 UI、音量偏好和队列镜像；播放、下载、解码、队列自然推进、gapless、
  输出设备、Now Playing/SMTC 的权威均在 Rust。
- 开发态仍只允许一条 `pnpm tauri dev` 链；凭证只读
  `~/.cadilume-dev-token`，Release 只用系统凭证库。

## 2. 本轮已解决

### 播放生命周期与卡死

- `Player::clear()` 会等待音频线程；渐进 Reader 等待网络时可把同步 Tauri 命令和
  WebView 一起卡住。停止、切歌和设备切换现改为：取消 Reader、递增播放代际、替换
  Player，旧代任务不得回写新播放状态。
- 文件/网络读取和 symphonia 解码不再由 CoreAudio/WASAPI 回调直接执行。每首曲目使用
  独立解码线程和有界、帧对齐 PCM 缓冲；实时回调只做非阻塞 `try_recv`。
- PCM 欠载时最多先补一帧静音保持声道对齐，随后状态机暂停 Player；缓冲恢复后按
  `desired_playing` 恢复，避免网络停顿造成音频回调冻结或进度长期假走。
- 媒体时间改由已实际输出的 PCM frame 计算，欠载静音不推进歌词、scrobble、UI 或系统
  Now Playing；队列/设备重建会恢复任何大于 0 的进度，不再让开头 0.5 秒内的操作回零。
- 满 PCM 队列与 EOF worker 使用 Condvar/epoch 唤醒，消费、seek 和 drop 都会通知；不再
  每 5ms 空转轮询。
- seek 通过解码线程代际清空旧 PCM；解码到 EOF 的短曲仍保留 worker，允许向前/向后
  seek。worker 在 seek 代际切换时保留已分配的 spare `Vec<f32>`，不会把旧代正在填充的
  chunk 丢出复用池；48 轮 seek storm 中分配量不超过池容量加 1。160 次本地
  加载/seek/停止压力测试通过。

### 下载、缓存与账号隔离

- 缓存身份从裸 `ratingKey` 改为版本化复合身份：服务器、曲目、质量、codec/container、
  Part key/size/duration；Rust 以带 namespace 的 SHA-256 生成文件名，原始标识不落盘。
- LRU 只淘汰完整 `.audio`，绝不扫描删除活动 `.part`；下载任务用 RAII 清理失败、取消
  和 abort 残留，应用启动只清理上次崩溃遗留的 `.audio.part`。
- 同键 64 路并发预取共享一次 HTTP 下载；当远 ahead 的同一首变成即时下一首时，取消
  限速任务并全速重启。不同 ahead 仍不得抢占当前播放/即时下一首的单流 permit。
- 请求首包和连续 body chunk 都有 30 秒无进展上限；空响应拒绝，Content-Length 截断
  重试，无 Content-Length 的完整 chunked 响应允许原子提交。
- 单文件超过 512 MiB 时，无论有无 Content-Length 都拒绝并清理 `.part`；重试保持同一
  临时 inode，避免已打开的渐进 Reader 与新下载文件分叉。
- 原生播放、预取、gapless 与封面 IPC 只接受当前进程随机端口签发的 64 位十六进制
  loopback ticket URL；引擎 HTTP client 禁止重定向，不能读取任意 URL 或本地文件。
- 清缓存、登出和换账号会按“前台 load/device lock -> precache gate -> 取消并等待任务 ->
  停播 -> 删除”执行；Windows 文件占用使用有界重试。账号切换后完整/部分音频缓存、
  队列、元数据、封面字节和系统 Now Playing 均清空。

### gapless、设备与系统媒体控制

- 下一首完整来源、复合缓存身份、元数据、时长和封面票据一并进入 Rust；样本级
  `HandoffMarker` 交接后更新当前来源，设备切换可从同一来源/缓存/进度恢复。
- 追加、插入、删除、repeat/shuffle 都通过前端串行 barrier 同步 Rust。有效 pending 按
  `ratingKey` 重定位并保留 gapless，失效 pending 会重建 Player 清除 rodio 旧尾部 PCM；
  音质改变造成缓存身份变化时也会替换旧 pending。
- 输出设备使用 cpal 稳定 `DeviceId`，显式空 ID 表示跟随系统默认；设备重建保留完整
  shuffle bag/history/cursor。Windows 原生设备列表不再受 WebView `setSinkId` 能力开关
  限制，并低频复核热插拔。
- 桌面端禁用 WebKit MediaSession，避免覆盖原生系统媒体会话。
- macOS 显式同步 `MPNowPlayingInfoCenter.playbackState`，并在主线程发布字典和
  `MPMediaItemArtwork`；所有 key 使用 MediaPlayer 框架导出的 NSString 常量，不能把
  `MPMediaItemPropertyTitle` 等 Objective-C 符号名直接当字符串。后者会让控制中心只显示
  应用名/应用图标而静默丢弃曲名、歌手、专辑、时间轴和封面。`artworkUrl` 的 camelCase
  反序列化已覆盖测试。
- Windows SMTC 同步 Playing/Paused/Stopped；清账号/缓存时清除 DisplayUpdater。

### macOS 初始化窗口

- 初始化可视化直接占满整个原生窗口，不再放进居中的突出卡片；没有卡片边框、圆角、
  阴影或背景渐变。顶部仅保留 52px 原生拖拽层和交通灯安全区，内容区仍是同一张完整
  初始化画面。
- `1280x820` 内部浏览器计算样式验证：`AppFrame`、内容层和初始化层均覆盖完整视口，
  `.splash-card` 与自定义标题栏数量为 0，水平/垂直溢出均为 0。

### 主题过渡与歌词滚动

- 主题切换快照不再保留克隆的 `<img>`。创建快照时会把已完成解码的图片同步栅格化为
  `<canvas>`；只为视口内图片分配 Retina backing store，离屏图片使用 1x1 透明画布，
  避免 `no-store` 封面被克隆后重新请求/解码，也避免大型资料库切换主题时瞬时占用大量
  内存。媒体尺寸取不含 transform 的 computed layout width/height，保留 border-box 和
  亚像素几何；旧的 120ms 图片 decode 等待已删除。
- 主窗口歌词栏和展开播放器统一使用中心定位：活动歌词行中心对齐歌词视口中心，只有
  顶部或底部滚动范围不足时才钳制到合法边界。即使活动行原本已经可见也会继续居中，
  并遵循 `prefers-reduced-motion`。切歌时先归零旧滚动位置，但不再清空本次渲染刚挂载的
  行引用或提前返回，因此新曲首个活动行可以在同一轮布局中完成定位。
- 用户滚轮、触摸、滚动条指针或滚动键会临时把控制权交给手动浏览；下一条可见歌词出现
  时通过直接写入 `scrollTop` 瞬时夺回，避免 WebKit 的平滑滚动被打断后不再回到开头。
  空白歌词帧不会消费手动标记，主歌词和展开播放器共用同一实现。

### 渐进容器探测与质量回退（2026-08-08 补充）

- 某些合法容器在只落盘 256 KiB 头部时仍会继续读取下载前沿；旧实现把
  `Decoder::builder().build()` 放在 Tauri async worker 内同步执行，导致探测一直等网络，
  前端无法进入下一质量。
- 文件打开、容器探测、时长读取和首批 PCM 准备现全部在 `spawn_blocking` 中执行；每个质量档
  有 6 秒准备上限，首 PCM 以 50ms 可取消轮询等待。超时/错误会唤醒 `ProgressiveFile`、
  取消并有界等待下载、清理 `.audio.part`，再把错误交给前端质量回退。
- 活动下载将进度、`.part` 路径和任务句柄绑定，并在完成/取消后释放槽位；探测恰逢
  `.part -> .audio` 原子改名时会读取完整缓存，不会误触发下一质量。
- 限速下载在每个 pacing slice 和最终提交前都检查取消位；切歌/账号清理若发生在最后
  一个 chunk 的等待期间，不会把已取消的 `.part` 原子提交为完整缓存。
- 新增确定性回归覆盖“512 KiB 后永久停流 → 300ms 探测超时 → `.part` 清理 → 下一质量
  立即播放”，同时断言完整回退下载完成后活动槽自动释放。

## 3. 验证结果

- `pnpm check`、`pnpm test`、`pnpm build` 通过；前端为 `30` 个测试文件、`183` 项测试。
- Rust 全量测试 `99` 项：`97 passed / 0 failed / 2 ignored`；两项真实 PMS 测试默认忽略，
  已在本机显式串行运行为 `2 passed / 0 failed`：
  - 两首真实 FLAC：下载、缓存、渐进播放、预排、样本级交接、seek、暂停/恢复；
  - 最多 10 首预缓存后两轮共 20 次快速切换，第二轮穿插 seek、暂停/恢复。
- 新增故障/负载覆盖：活动 `.part` 与 LRU、启动残留清理、缓存身份隔离、64 路同键
  预取、限速任务升级、账号清理中止、空响应、截断、chunked、128 次播放代际、160 次
  实际解码 worker 加载/停止、解码线程 300ms 停顿时实时 Source 非阻塞，以及队列编辑
  保留/撤销真实 rodio pending、音质替换与媒体进度恢复；48 轮 seek storm 验证 PCM
  chunk 池不会随代际切换持续分配。
- macOS `MPNowPlayingInfoCenter` 字典通过框架真实常量逐项读回标题、歌手、专辑、时长、
  进度、速率和媒体类型；测试还明确拒绝旧的符号名字符串假 key。真实播放日志确认
  metadata 非空且封面已下载后进入发布线程。
- macOS `.app` 使用显式 ad-hoc identity 构建，`codesign --verify --deep --strict` 通过；
  bundle 只链接 `/System/Library` 和 `/usr/lib`，没有额外 dylib、framework、`.node`、
  BASS、FFmpeg、mpv 或 sidecar。
- `1280x820` 下连续切换主题 12 轮：每轮快照 `<img>` 数量均为 0，canvas 数量与当时
  真实图片数一致，可见媒体最大几何误差约 `0.0078 CSS px`；每轮结束快照/canvas 残留
  均为 0，最终 43 张实时图片全部完成，页面无横纵溢出，干净页面控制台无警告或错误。
- `1280x300` 歌词滚动压力视口实测：主歌词中段中心误差约 `0.04px`，展开播放器约
  `0.23px`；首行正确钳制到 0，主歌词末行正确钳制到 `scrollTop=max=107`。单元测试
  同时覆盖已可见行、离屏行、上下边界、切歌归零后的首次居中、内容不足一屏，以及手动
  滚动后的开头切句、同句重渲染和空白歌词帧。开发态真实滚轮测试中，主歌词从 `2200`
  回到 `0`，展开播放器从 `2600` 回到 `0`。

## 4. 引擎选型结论

当前不更换底层引擎。

| 方案 | 结论 |
| --- | --- |
| `rodio + cpal + symphonia` | 保留。纯 Rust、静态集成、许可证清晰；实时线程隔离后满足当前播放边界。 |
| Plexamp BASS/`treble.node` | 禁用。闭源授权、私有模块和 bundle 动态库均不符合开源与零外部依赖。 |
| libmpv/FFmpeg | 禁用。动态库分发、签名、许可和用户安装边界不符合当前产品约束。 |
| 自写 CPAL 解码/混音全栈 | 暂不采用。会重复 rodio 已验证的队列、格式转换和设备层，风险高于收益。 |

只有出现无法由 PMS 转码兜底的主流格式缺口、rodio 无法修复的跨平台设备故障，或 PCM
缓冲模型在真实负载下持续欠载，才重新开启引擎替换评估。

## 5. 2026-08-08 补充验收

- macOS 控制中心已在唯一 Tauri 开发链和真实 PMS 播放中完成可见验收：真实曲名、歌手、
  专辑、封面、时间轴与播放状态均显示，上一首、暂停/播放、下一首控制可用。
- 控制中心暂停/恢复能同步 Cadilume；干净重启后单击一次下一首只触发一次系统命令和一次
  曲目加载。由此关闭原“代码已闭环但仍缺一次可见验收”的问题。
- UI 交互、性能和播放器周边的后续整改及量化结果见
  `NEXT_UI_INTERACTION_AND_PERFORMANCE_PLAN_2026-08-08.md`。

## 6. 仍需后续长期验收

1. macOS 开发态长期听感：连续专辑 gapless、弱网缓冲提示、耳机/扬声器切换、隐藏窗口
   后持续播放和睡眠恢复。
2. 长期记录 PCM underflow 次数；正常网络应为 0。若频繁出现，先调预载/PCM 容量和
   PMS 连接策略，不要直接换闭源内核。
3. ReplayGain、crossfade、响度扫描和离线下载仍是产品能力扩展，不属于本轮缺陷修复。

Windows 验收明确不属于本轮范围，不作为本轮完成门禁；后续重新开启 Windows 工作时再
单独验证 SMTC、WASAPI 热插拔、休眠恢复和文件删除语义。

## 7. 纪律

- 默认中文；本地提交、不 push；不主动截图。
- 日志和文档不得记录 PMS URI、token、loopback ticket 或真实媒体路径。
- 公开发行继续执行零外部运行依赖审计、签名与 notarization；开发态 ad-hoc `.app`
  不能冒充正式发行包。
- 每轮结束检查父项目与 `cadilume/.codex/memories`，只记录可复用结论。
