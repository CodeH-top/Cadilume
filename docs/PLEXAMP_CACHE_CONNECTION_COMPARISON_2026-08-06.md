# Cadilume × Plexamp 缓存与 PMS 连接机制对比（2026-08-06）

> Clean-room 参考：本文只记录从 Plexamp.app 打包产物中观察到的机制结论，不复制其源码、
> 私有原生模块、标识或遥测。Plexamp 的音频输出与磁盘缓存由私有 BASS/原生引擎承担，
> Cadilume 只借鉴其**策略与边界**，不沿用其实现。

## 1. Plexamp 缓存机制（观察结论）

### 1.1 多级缓存

| 层级 | 实现 | 关键参数 |
| --- | --- | --- |
| 数据缓存 | 渲染进程 LRU，内存 + JSON 落盘（`lru.write/read/has`，版本化持久化） | 版本号校验，损坏自动重建 |
| 图片缓存 | `downloadFileSafely` 下载到缓存目录，命中直接 `file://` | 与离线下载共用目录 |
| 音频缓存 | 原生引擎（electron-media-service / BASS）磁盘缓存 | `cacheSize` 上限、LRU 淘汰、可“Delete Caches” |
| 离线下载 | 队列串行下载（1–2 并发），`downloadsRoot` 可配置 | `preferDownloadedMedia` 优先本地文件 |

### 1.2 播放队列 ahead 预缓存

- 播放开始后对队列“接下来的 N 首”逐首预缓存：Wi-Fi 默认 15 首、蜂窝默认 5 首
  （`cachingWiFi` / `cachingCellular`，可配置）。
- 用 `source-key` 去重集合防止重复预取；逐首失败只记日志、不阻塞播放。
- 预缓存同时取 loudness / palette 等元数据，切换曲目时可立即显示分析数据。
- 预缓存限速（`precacheNetworkSpeed`，桌面默认 5 Mbps），避免抢占播放带宽。

## 2. Plexamp PMS 连接机制（观察结论）

### 2.1 连接选择

- 设备发现后 `findBestConnection`：**并行**测试所有非 relay 连接（默认 10s 超时），
  第一个成功即 `updateBestConnection`；当前连接是 relay 时并行测试全部连接尝试恢复。
- 每个连接测试请求服务器根路径 `/`，并校验
  `MediaContainer.machineIdentifier === clientIdentifier`，防止连到错误设备。
- relay 只在最后兜底（25s 超时），蜂窝网络跳过本地 HTTP 探测。
- 远程控制场景可配置“向远程接收端发送远程连接”（强制非 local 连接）。

### 2.2 运行时失效恢复

- 请求收到 HTTP 500 会触发重新 `runConnectionTesting`，再重试。
- 请求层带超时与响应/超时错误分类；连接失败会回退/重测，不把坏连接当首选。

## 3. Cadilume 现状与差距

| 维度 | Plexamp | Cadilume 现状（2026-08-06） |
| --- | --- | --- |
| 封面缓存 | 磁盘文件缓存 | Rust 磁盘 LRU（512MB 上限 + 票据隔离），能力已对齐且更安全 |
| 数据缓存 | 渲染进程 LRU 落盘 | 无（直接请求 PMS；仅路由 KeepAlive 缓存页面） |
| 音频缓存 | 原生引擎磁盘缓存 + 上限 + 限速 | 无磁盘缓存；双 `HTMLAudioElement` 预缓冲 1 首 |
| ahead 预取 | 队列后续 N 首（15/5） | 仅顺序/随机下一首，streamUrl 在途去重 5s |
| 连接测试 | 并行测试 + machineIdentifier 校验 + relay 兜底 | 启动时逐串行测试 + 成功连接提升（本轮已改为并行 + 身份校验 + relay 兜底） |
| 500 恢复 | 自动重测并重试 | 本轮新增：读取 500 后重测连接并重试一轮 |
| 坏连接降级 | 失败回退 + 重测 | 本轮新增：流代理连接失败 demote 到末尾 |
| 限流退避 | 原生引擎内部处理 | 本轮新增：代理对 PMS 503/429 退避 300ms |
| 转码会话 | 原生引擎管理（session/ping/stop） | 无显式会话管理（transcode ticket 随连接生命周期） |

## 4. 已落地借鉴（本轮）

1. `prioritize_reachable_connections`：并行测试所有连接（5s 超时），校验
   `/identity` 的 machineIdentifier 与客户端标识一致；可达非 relay > 可达 relay >
   不可达，relay 仅兜底。
2. `server_request_response`：读请求全部失败且含 HTTP 500 时，先重新测试连接顺序再
   重试一轮，避免瞬时服务端抖动卡在坏连接上。
3. 流代理：连接失败 `demote_connection`（移到末尾）；PMS 503/429 退避 300ms 再尝试
   下一端点/连接；只转发 `audio/*` 响应并输出脱敏逐次诊断。
4. 前端：切歌 loading 至少可见 250ms；同一 server/track/quality 的 streamUrl 在途
   去重缓存 5s，避免快速切歌重复发行票据；随机切歌与自然结束均有日志。

## 5. 后续建议（不在本轮 WebView 修补范围）

- **音频磁盘缓存**依赖音频数据经过 Rust 代理落盘 + 支持 Range 的本地回放；这属于
  “原生播放内核”（Rust AudioEngine）路线，实现时可参考 Plexamp 的 cacheSize 上限、
  LRU 淘汰、ahead N 首、预取限速和 Delete Caches 交互。
- **数据 LRU**：若 PMS 元数据请求成为性能瓶颈，可评估在 Rust 侧做版本化 LRU
  （类似 Plexamp 的 JSON 持久化），并沿用封面缓存的票据隔离边界。
- **转码会话管理**：接入原生内核后，为 transcode ticket 增加 session ping/stop，
  避免快速切歌在 PMS 侧堆积转码会话。
