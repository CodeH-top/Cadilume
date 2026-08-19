# Cadilume 架构

本文描述 Cadilume（Bundle ID：`top.codeh.cadilume`）与 Plex Media Server（PMS）的
互操作架构。Plex、PMS 与 Plexamp 仅表示第三方服务、协议或 clean-room 行为参考，
不是 Cadilume 的产品身份。

## 当前系统

```text
React / Tauri WebView
  ├─ 资料库、搜索、歌单、歌词、队列镜像与设置
  ├─ 播放意图、前端持久化音量和会话快照
  └─ native-audio://event：进度、曲目交接、缓冲和远程命令
                  │ typed Tauri commands / events
Rust / Tauri      │
  ├─ 凭证库、PMS 资源发现、per-server token 与连接回退
  ├─ 授权隔离的 loopback 音频/封面票据
  ├─ PlaybackCoordinator：队列、repeat、shuffle、播放代际
  ├─ SegmentCache v2：当前/下一首 read head、Range 缺口调度、稀疏文件与磁盘 LRU
  ├─ Decoder workers：symphonia -> 有界 PCM chunk 队列
  ├─ rodio -> cpal -> CoreAudio / WASAPI
  └─ macOS Now Playing / Remote Command Center、Windows SMTC
```

桌面端没有 `HTMLAudioElement` 播放后端。WebView 不解码音频、不持有 PMS token，
也不决定自然切歌；Rust 是播放、缓存、队列推进、输出设备和系统媒体会话的权威。
浏览器演示模式仍使用本地演示数据，不访问真实账号或 PMS。

## 运行依赖边界

- 播放栈固定为 `rodio 0.22 + cpal 0.17 + symphonia 0.5`，Rust crates 编入应用。
- 运行时只使用操作系统自带的 CoreAudio、WASAPI、MediaPlayer、AppKit 等框架。
- 不加载 BASS、libmpv、FFmpeg、Homebrew 动态库、sidecar、SDK 或后台服务；用户不需要
  安装任何附加组件。Xcode/macOS SDK 只属于构建环境，不是发布包运行依赖。
- Plexamp 的 `treble.node + BASS` 只能用于行为对照，不复制源码、资源、私有模块或二进制。
- 客户端不转码。原始质量读取 PMS Part；格式兼容或码率降低交给 PMS universal
  transcode，Cadilume 只接收结果并本地解码播放。
- 新安装默认使用原始质量。“自动兼容”也始终先为原始 Part 建立稳定票据，只有原始流加载
  失败时才为 `320 → 256 → 192 kbps` 分别申请独立转码票据；连接被标记为本地、远程或
  Relay 都不会改变这一顺序。显式选择原始质量或某一 MP3 码率时严格保持该表示，不静默
  降级到其他码率；PMS 请求的 `musicBitrate` 与界面所选档位完全一致。

## 账号、权限与连接

- Plex PIN token 仅在 Rust 中解析并写入应用配置目录的用户专属 `credentials.json`；Unix
  使用 `0600` 权限，Windows 使用当前用户专属 ACL。WebView 不接收账号 token，服务器
  `accessToken` 只保存在 Rust 运行时缓存中，不长期落盘。
- 每台服务器使用 `/api/v2/resources` 返回的专属 `accessToken`，包括 `owned:false`
  的共享服务器；不会错误复用 plex.tv 账号 token。
- Music Section、搜索、歌单和播放状态请求均限制在预定义路径，并服从 PMS ACL 与
  功能级订阅限制；客户端不以 `subscription.active` 阻断已授权的基础音乐播放。
- 本地直连、远程直连和 Relay 是连接拓扑；原始直放和 PMS 转码是媒体决策。两组概念
  独立，不能从连接标签推断是否转码。
- 非 Relay 连接并行探测并校验 `machineIdentifier`，Relay 最后兜底；运行中 500 或连接
  失败会触发重测、降级和有界重试。

## 音频来源与分段缓存

前端先请求一个短期 loopback 票据，再把该本机 URL 交给 Rust 引擎。票据不包含 PMS
主机、媒体路径或 token；Rust 校验票据后通过 Header 向选定 PMS 连接取流。

```text
PMS Part / universal transcode
  -> Range: bytes=0-262143（首个 read head）
  -> native-audio/segments-v2/<sha256>/media.sparse
  -> index.json 记录逻辑长度、校验值和已提交区间
  -> Symphonia Read+Seek 遇缺口时请求对应的对齐 2 MiB Range
  -> 只把真实写入的磁盘块计入固定 1 GiB 预算
```

- 同时只允许一条真实 PMS 媒体请求；等待队列中当前曲目的请求优先于下一首 read head，
  避免远程连接、反代或转码会话互相争抢。
- 当前曲目先取 256 KiB 头部，后续只在解码或 seek 遇到缺口时请求目标所在的对齐 2 MiB
  区间。启用“预缓冲下一首”时，只为 Rust 队列确认的真实下一首建立第二 read head，并在
  约 4 秒有界 PCM 就绪后挂入 rodio；不会完整预取下一首、下载下下首、遍历队列或扫描曲库。
- `206` 必须带完全匹配的 `Content-Range`，响应体长度也必须与声明区间一致；ETag、
  Last-Modified 或总长度变化会废弃旧区间，`416` 只在返回有效总长度时作为 EOF。Range
  客户端禁止重定向并有 30 秒总超时，避免 loopback ticket 被带到其他 origin。
- PMS 忽略 Range 并返回 `200` 时，下一首直接放弃预缓冲，绝不升级为完整下载；只有当前
  曲目为了兼容不支持 Range 的源才启动连续读取。该回退只设连接超时，不以 30 秒总时长
  杀死合法大文件；失败、取消或崩溃后的不完整连续缓存不会续传。
- v1 `native-audio/downloads` 在 v2 初始化或清缓存时移除，不会与新预算重复占盘。

## 实时解码与缓冲

`rodio::Player` 会从 CoreAudio/WASAPI 回调路径拉取 `Source::next()`。因此文件读取、
网络等待和 codec 解码绝不能出现在 `Source::next()` 中。

- 当前曲目和已预排曲目各有一个独立解码 worker；worker 执行 symphonia 解码并写入
  固定 1024 frame、按声道对齐的 PCM chunk。
- 每首曲目的解码源在 append 到共享 `rodio::Player` 队列前，分别连续转换为当前设备
  mixer 的固定声道数与采样率；媒体进度仍按曲目自身采样率统计。这样 48 kHz 与 44.1 kHz
  相邻时不会让首曲时钟泄漏到下一首并造成整曲变速、变调。
- 队列按采样率计算但硬限制为最多约 4 秒、最多 512 个 chunk；实时 Source 只执行
  `try_recv`，不会等待磁盘、网络、锁或 codec。
- 欠载时 Source 补完整静音 frame 保持声道对齐，状态机随即暂停 Player；累计达到约
  250 ms PCM，或 worker 已到 EOF，才按 `desired_playing` 恢复，避免弱网下一块一恢复的
  pause/play 抖动。
- seek 递增解码 epoch、丢弃旧 PCM 并交给 worker 定位。`SegmentReader` 的中断 epoch 可
  终止旧缺口等待；新定位优先读取已缓存区间，否则只请求 seek 目标所在分段。
- PCM chunk 使用有界复用池；seek 代际抢占时，worker 保留正在填充的 `Vec<f32>` 作为
  spare buffer，再在后续循环复用，避免连续定位造成堆分配随次数增长。
- stop、切歌和设备切换先取消 Reader，再递增播放代际并替换 Player。旧下载、旧 worker、
  封面任务和旧事件不得回写新曲目状态；不调用可能同步等待音频线程的 `Player::clear()`。

## 队列与 gapless

- `repeat=off` 自然播放到队尾停止；`repeat=all` 开启新一轮；`repeat=one` 只在自然结束
  重播当前曲目。手动 Next 不受 repeat-one 限制。
- Rust shuffle 使用随机化的剩余 bag，同一轮完整访问且不重复；历史带 cursor，
  `Previous -> Next` 可沿原路径返回。前端通过 `native_queue_peek_next` 取得同一个预排候选，
  不再自行随机后与 Rust 决策冲突。
- 即时下一首使用第二个分段 read head 创建自己的 decoder worker；有界 PCM 缓冲就绪后
  直接 append 到同一 rodio 队列，不等待整首文件落盘。`HandoffMarker` 在下一首第一个
  真实 sample 被拉取时提交曲目、来源、时长、缓存身份和 Now Playing 元数据，不通过轮询
  猜测交接。
- 这是 sample-contiguous 的队列交接。FLAC 与测试覆盖的 MP3 可连续衔接；codec 自身的
  delay/padding 修剪仍由 symphonia/PMS 输出决定，不宣称 crossfade。
- 前端每次追加、插入、删除、repeat 或 shuffle 变化都经过串行 queue barrier 同步 Rust。
  已附加曲目若仍是同一个 `ratingKey` 下一首，只更新索引并保留 gapless；若已失效，按
  当前媒体时间重建 Player，保证 rodio 尾部不会播放已从 UI 队列删除的旧 PCM。
- 预排请求还校验复合缓存身份。音质变化产生新身份时会替换旧 pending；相同身份的重复
  请求保持幂等，不重复创建 decoder worker。

## 音频缓存

- 上限固定为 1 GiB，不再提供容量设置；目录位于应用 cache 下的
  `native-audio/segments-v2/<sha256>/`。设置页把封面缓存和音频缓存分成两行，音频显示
  实际占盘 / 1 GiB，以及完整或部分缓存的曲目数。
- 前端生成版本化复合身份：server、rating key/key、quality、codec/container/bitrate、
  PMS Part key/size/duration；Rust 再以 v2 namespace 的 SHA-256 生成目录名，原始标识
  不落盘。
- `media.sparse` 的逻辑长度可以等于整首，但预算与设置统计使用文件系统实际分配块；macOS
  在预分配逻辑长度或崩溃恢复时显式调用 `F_PUNCHHOLE`，未提交区间不会被当作占盘或音频
  数据。索引文件同样计入预算。
- LRU 以 `index.json` 的 mtime 近似最近使用时间；当前与下一首的活动条目受保护，其他最旧
  条目先整目录淘汰。每次写入还要求磁盘写后至少保留 1 GiB 可用空间；无法同时满足固定预算
  与低磁盘保留时拒绝新块，不突破上限。
- 启动恢复只保留索引、逻辑长度和稀疏文件一致的 Range 条目，以及已完整提交的无 Range
  条目；临时索引、截断数据和不可续传的连续半成品直接删除。并发打开同一身份共享同一
  条目锁与区间状态。
- 清缓存、登出或换账号按“序列化前台操作 -> 阻止新 read head -> 取消并等待任务 ->
  停播 -> 删除”执行，并清空队列、来源、元数据、封面字节和系统媒体面板。
- 封面缓存与音频缓存、票据注册表彼此独立；单张封面限制 12 MiB。

## 进度、歌词与会话

- Rust 每 200 ms 发布播放器位置与时长；歌词由该原生播放时钟驱动，不再读取
  `HTMLAudioElement.currentTime`。
- LRC、SRT、VTT、PMS 毫秒时间轴和纯文本在 React 中归一；无时间轴歌词不伪造滚动。
- 本地播放会话最多保存 500 首的精简队列、索引、质量、进度、repeat/shuffle；不保存
  token、ticket 或解析后的音频 URL，30 天后失效，恢复时不自动播放。
- 可见 WebView 连续两个 6 秒窗口没有心跳时才触发保护停播；隐藏窗口不依赖 WebView
  timer，系统睡眠恢复也有完整确认窗口，避免后台播放误停。

## 系统媒体与输出设备

- macOS 使用 `MPNowPlayingInfoCenter` 发布标题、歌手、专辑、时长、进度、速率、封面和
  显式 `playbackState`；`NSImage`/`MPMediaItemArtwork` 在主线程创建。Remote Command
  Center 支持播放、暂停、切歌和 seek。Now Playing 字典 key 直接使用 MediaPlayer 框架
  导出的 NSString 常量；Objective-C 符号名字符串不是有效 key，会被系统静默忽略。
- Windows 使用 SMTC 发布标题、歌手、专辑、时间线与 Playing/Paused/Stopped，并处理
  Play/Pause/Next/Previous；封面和运行时交互仍需 Windows 实机收口。
- cpal 以稳定 `DeviceId` 枚举输出设备，并保留旧名称偏好的迁移兼容；空 ID 始终表示真正
  跟随系统默认。切换设备会捕获当前来源、位置、音量和完整 shuffle bag/history cursor，
  在新 CoreAudio/WASAPI sink 上从已缓存区间优先恢复并按需补缺口；失败时尝试恢复旧设备。Windows
  桌面端每 5 秒低频复核设备列表，已选设备断开时回退系统默认。
- Web MediaSession 在桌面端禁用，避免覆盖原生 Now Playing/SMTC；`setSinkId` 仅是浏览器
  能力探测残留，不参与桌面播放。

## 窗口与发布

- 主窗口默认/最小尺寸为 `1280x820`，保留原生标题栏、macOS 交通灯、阴影和全屏行为。
- 启动与未登录状态都使用全窗、无独立标题栏的单一可视化区域；macOS 只保留顶部 52px
  拖拽/交通灯安全区，Windows 只保留顶部 60px 拖拽区与右上角悬浮窗口控制，不为品牌图标
  或窗口控制额外占一整行。
- 关闭主窗口统一最小化并继续播放；菜单栏/通知区域图标是独立持久化偏好。Dock、任务栏
  或状态图标可恢复窗口，状态图标菜单提供播放/暂停与显式退出。
- macOS 发布需 Developer ID、hardened runtime、notarization 和 stapling；Windows 发布
  需原生 CI、Authenticode 与 Windows 10/11 实机验证。
- 每个发布构建必须审计 Mach-O/PE 导入，确认没有项目外动态库或 sidecar。

## 仍待扩展

- Windows 10/11 SMTC、WASAPI 热插拔、休眠恢复和缓存删除语义的实机验收。
- ReplayGain、响度扫描、crossfade、离线下载和 PMS playQueues 增删移动。
- macOS 连续专辑听感、弱网缓冲提示、系统媒体键与输出设备切换的人工验收。
