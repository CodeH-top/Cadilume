# Cadilume 与 Plexamp 缓存/连接机制对比（2026-08-07 收口）

> Clean-room 边界：本文只记录从公开行为和本机发布包观察到的机制，不复制 Plexamp
> 源码、资源、私有模块、标识或二进制。Plexamp 的 Treble/BASS 实现不进入 Cadilume。

## 观察到的 Plexamp 策略

### 缓存

| 层级 | 行为结论 |
| --- | --- |
| 数据缓存 | 渲染层版本化 LRU，内存与 JSON 落盘，损坏后重建 |
| 图片缓存 | 安全下载到磁盘，命中使用本地文件 |
| 音频缓存 | 私有原生引擎管理磁盘上限、LRU 与 Delete Caches |
| 离线下载 | 有界并发下载，优先使用已下载媒体 |

- 队列 ahead 按网络类型预取多首，以 source key 去重，单首失败不阻塞播放。
- 远 ahead 可限速，桌面观察值约 5 Mbps；当前播放和即时下一首优先。
- loudness、palette 等分析数据可与预取一起准备，但不属于 Cadilume 本轮播放必需项。

### PMS 连接

- 并行测试非 Relay 连接并校验服务器身份，第一个正确响应成为首选；Relay 最后兜底。
- 当前连接失效或请求出现服务器错误时重新测试，再按新的顺序重试。
- 连接拓扑和媒体转码是两条独立决策链。

## Cadilume 当前实现

| 维度 | 当前状态 |
| --- | --- |
| 数据缓存 | PMS 元数据按页面请求；暂未增加通用持久化 LRU |
| 封面缓存 | Rust 512 MiB 有界磁盘缓存、内容校验、账号隔离和独立 loopback 票据 |
| 音频缓存 | Rust 512 MiB mtime LRU、复合身份 SHA-256、`.part` 原子提交与损坏自愈 |
| ahead | 即时下一首完整预取并预解码；顺序队列额外暖第二首，远 ahead 5 Mbps |
| 下载并发 | 单条 PMS 音频流；同键调用共享任务，播放和即时下一首可抢占远 ahead |
| 渐进播放 | 256 KiB 头部开播；文件前沿等待只发生在 decoder worker，不进入音频回调 |
| 连接测试 | 并行探测、machineIdentifier 校验、非 Relay 优先、Relay 兜底 |
| 运行时恢复 | 500 重测、坏连接降级、503/429 退避、请求/数据无进展超时 |
| 转码 | 客户端不转码；只请求 PMS universal transcode |

## Cadilume 的安全与正确性增强

1. 缓存身份包含 server、曲目、质量、codec/container/bitrate 和 PMS Part
   key/size/duration；同 rating key 的不同服务器、账号媒体修订和质量不会误命中。
2. 原始身份只作为带 namespace 的 SHA-256 输入，不出现在文件名。WebView 持有的只是
   短期 loopback ticket，不含 PMS host、路径或 token。
3. LRU 只处理完整 `.audio`，不删除活动 `.part`；失败、取消、abort 由下载任务 guard
   清理，启动时只清理崩溃残留。
4. Content-Length 必须完全匹配；空 body 拒绝；无 Content-Length 仅在流正常结束后提交。
5. 清缓存、登出和换账号先阻止新任务，再取消并等待现有任务，最后停播和删除，避免
   Windows 文件占用与旧账号状态回写。
6. 音频回调只消费有界 PCM；网络读取、缓存文件访问、symphonia 解码和 seek 都在 worker。

## 没有照搬的部分

- 不采用 Plexamp 的私有 `treble.node + BASS`，也不分发任何 BASS 动态库。
- 不采用 libmpv、FFmpeg sidecar 或要求用户安装的 SDK/系统包。
- 不直接照搬 15/5 首 ahead：Cadilume 当前单流策略优先保证远程 PMS、Relay 与反代稳定，
  即时下一首用于 gapless，第二首只做机会性限速暖缓存。
- 暂不实现通用元数据 LRU、ReplayGain/loudness 分析和离线下载；这些是独立产品能力。

## 结论

Cadilume 已对齐“有界磁盘缓存、身份隔离、ahead 优先级、限速、连接重测和清缓存”的
行为目标，但使用可审计的纯 Rust/系统 API 实现。当前没有理由为追求 Plexamp 内核一致性
而引入闭源或外部运行依赖。
