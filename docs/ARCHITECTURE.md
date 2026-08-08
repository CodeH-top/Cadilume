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
  ├─ DownloadManager：单流优先级、渐进下载、ahead 与磁盘 LRU
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

## 账号、权限与连接

- Plex PIN token 仅在 Rust 中解析并写入 macOS Keychain 或 Windows Credential Manager；
  WebView 不接收账号 token。
- 每台服务器使用 `/api/v2/resources` 返回的专属 `accessToken`，包括 `owned:false`
  的共享服务器；不会错误复用 plex.tv 账号 token。
- Music Section、搜索、歌单和播放状态请求均限制在预定义路径，并服从 PMS ACL 与
  功能级订阅限制；客户端不以 `subscription.active` 阻断已授权的基础音乐播放。
- 本地直连、远程直连和 Relay 是连接拓扑；原始直放和 PMS 转码是媒体决策。两组概念
  独立，不能从连接标签推断是否转码。
- 非 Relay 连接并行探测并校验 `machineIdentifier`，Relay 最后兜底；运行中 500 或连接
  失败会触发重测、降级和有界重试。

## 音频来源与下载

前端先请求一个短期 loopback 票据，再把该本机 URL 交给 Rust 引擎。票据不包含 PMS
主机、媒体路径或 token；Rust 校验票据后通过 Header 向选定 PMS 连接取流。

```text
PMS Part / universal transcode
  -> 单条 HTTP body（播放 > 即时下一首 > 远 ahead）
  -> <sha256>.audio.part
  -> 256 KiB 头部就绪后允许渐进解码
  -> Content-Length/空响应/超时校验
  -> 原子 rename 为 <sha256>.audio
```

- 同时只允许一条真实 PMS 音频下载，避免远程连接、反代或转码会话互相争抢。
- 同一缓存身份的并发预取共享一个任务；即时下一首可取消并升级同键的 5 Mbps 限速任务。
- 首包和连续 body chunk 均有 30 秒无进展上限。Content-Length 响应必须字节数完全一致；
  无 Content-Length 的 chunked 响应完整结束后也可提交；空响应永不进入缓存。
- 无论响应是否声明 Content-Length，单个音频下载超过 512 MiB 都会在继续写盘前拒绝；
  引擎 HTTP 客户端禁止重定向，避免 loopback ticket 被带到其他 origin。
- `.part` 由任务 RAII guard 管理，失败、取消和 abort 都会清理；启动时只删除上次崩溃
  遗留的 `.audio.part`，LRU 不触碰活动部分文件。

## 实时解码与缓冲

`rodio::Player` 会从 CoreAudio/WASAPI 回调路径拉取 `Source::next()`。因此文件读取、
网络等待和 codec 解码绝不能出现在 `Source::next()` 中。

- 当前曲目和已预排曲目各有一个独立解码 worker；worker 执行 symphonia 解码并写入
  固定 1024 frame、按声道对齐的 PCM chunk。
- 队列按采样率计算但硬限制为最多约 4 秒、最多 512 个 chunk；实时 Source 只执行
  `try_recv`，不会等待磁盘、网络、锁或 codec。
- 欠载时 Source 补完整静音 frame 保持声道对齐，状态机随即暂停 Player；累计达到约
  250 ms PCM，或 worker 已到 EOF，才按 `desired_playing` 恢复，避免弱网下一块一恢复的
  pause/play 抖动。
- seek 递增解码 epoch、丢弃旧 PCM 并交给 worker 定位。渐进 Reader 的条件变量可被
  seek epoch 唤醒，因此向后定位到已下载区域不会继续卡在尚未下载的文件前沿。
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
- 即时下一首完整下载后创建自己的 decoder worker，并直接 append 到同一 rodio 队列。
  `HandoffMarker` 在下一首第一个真实 sample 被拉取时提交曲目、来源、时长、缓存身份和
  Now Playing 元数据，不通过轮询猜测交接。
- 这是 sample-contiguous 的队列交接。FLAC 与测试覆盖的 MP3 可连续衔接；codec 自身的
  delay/padding 修剪仍由 symphonia/PMS 输出决定，不宣称 crossfade。
- 前端每次追加、插入、删除、repeat 或 shuffle 变化都经过串行 queue barrier 同步 Rust。
  已附加曲目若仍是同一个 `ratingKey` 下一首，只更新索引并保留 gapless；若已失效，按
  当前媒体时间重建 Player，保证 rodio 尾部不会播放已从 UI 队列删除的旧 PCM。
- 预排请求还校验复合缓存身份。音质变化产生新身份时会替换旧 pending；相同身份的重复
  请求保持幂等，不重复创建 decoder worker。

## 音频缓存

- 默认上限 512 MiB，目录位于应用 cache 下的 `native-audio/downloads`。
- 前端生成版本化复合身份：server、rating key/key、quality、codec/container/bitrate、
  PMS Part key/size/duration；Rust 再以带 namespace 的 SHA-256 生成文件名，原始标识
  不落盘。
- 完整文件按 mtime 近似 LRU；命中刷新时间。解码首块失败会删除损坏文件并重新下载。
- 下载重试原位截断同一个 `.part`，不会先 unlink 一个已被渐进 Reader 打开的 inode；
  终态失败或取消再由任务 guard 统一清理。
- 清缓存、登出或换账号按“序列化前台操作 -> 阻止新预取 -> 取消并等待任务 -> 停播 ->
  删除”执行，并清空队列、来源、元数据、封面字节和系统媒体面板。
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
  在新 CoreAudio/WASAPI sink 上从完整缓存优先恢复；失败时尝试恢复旧设备。Windows
  桌面端每 5 秒低频复核设备列表，已选设备断开时回退系统默认。
- Web MediaSession 在桌面端禁用，避免覆盖原生 Now Playing/SMTC；`setSinkId` 仅是浏览器
  能力探测残留，不参与桌面播放。

## 窗口与发布

- 主窗口默认/最小尺寸为 `1280x820`，保留原生标题栏、macOS 交通灯、阴影和全屏行为。
- 初始化状态使用全窗、无卡片的单一可视化区域；内容只避开顶部 52px 拖拽/交通灯安全区，
  不生成居中的卡片边框、圆角或阴影。
- 关闭主窗口统一最小化并继续播放；菜单栏/通知区域图标是独立持久化偏好。Dock、任务栏
  或状态图标可恢复窗口，状态图标菜单提供播放/暂停与显式退出。
- macOS 发布需 Developer ID、hardened runtime、notarization 和 stapling；Windows 发布
  需原生 CI、Authenticode 与 Windows 10/11 实机验证。
- 每个发布构建必须审计 Mach-O/PE 导入，确认没有项目外动态库或 sidecar。

## 仍待扩展

- Windows 10/11 SMTC、WASAPI 热插拔、休眠恢复和缓存删除语义的实机验收。
- ReplayGain、响度扫描、crossfade、离线下载和 PMS playQueues 增删移动。
- macOS 连续专辑听感、弱网缓冲提示、系统媒体键与输出设备切换的人工验收。
