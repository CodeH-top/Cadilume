# FEATURE_REQUESTS

## 歌词与 Plexamp 实曲对时：待 Cadilume 原生听感验收

- 已修复可确认的前端时间问题：完整保留 PMS `startOffset/endOffset` 毫秒边界，歌词流按 PMS 原始顺序尝试；桌面播放期间约每 50ms 读取活动 `HTMLAudioElement.currentTime`，不再只依赖约 250ms 粒度的 `timeupdate`，且未加入猜测性的固定正负 delay。
- Plex Web 已用曾沛慈《我才没有那样呢》及李荣浩、周杰伦、S.H.E 等多曲自然播放采样；活动行通常在目标边界后约 20–80ms 更新，没有发现统一提前、延后半拍或累积漂移规则。自动测试已覆盖毫秒边界与无歌词状态。
- 尚未完成的验收是：在 Cadilume 原生 Release 中播放主样本及至少两首扩展样本，分别检查开头/中段/结尾、seek、暂停恢复和切歌后的实际人声听感。完成前只能称“已修已知代码原因”，不能宣称同步问题百分之百闭环；若仍有偏差，再按原始直放/PMS 转码/AirPlay 输出链路分别采样并决定是否需要原生播放时钟原型。

## 真实 PMS 播放验收与逐曲链路诊断

- 有界回退已覆盖原始流及 PMS 生成的 320/256/192 kbps 兼容流，但此前用户报告的真实失败曲目尚未在其 PMS 上端到端复播；完成该验收前不能把自动测试等同于“所有音乐均已解决”。
- 当前“本地直连 / 远程直连 / Plex Relay”只显示服务器发现阶段的首选连接。代理会在逐曲请求中尝试多个连接与转码 endpoint，因此该标签不是最终成功链路。
- 若需要向用户显示当前曲目的实际连接和直放/转码结果，应由 Rust 流代理在成功获得上游响应时发布脱敏运行态事件，只返回连接类型、媒体决策和有效码率，不暴露 PMS URI、媒体路径或 token。

## macOS release trust chain

- Add Developer ID Application signing and Apple notarization/stapling once the project has an Apple Developer team and release credentials. Until then, generated DMGs are local acceptance artifacts and cannot guarantee the exact Gatekeeper experience on another Mac.

## Native playback core

- Move queue authority, Range/cache, decoding, independent gain, gapless/prefetch and output device selection into Rust so Windows hidden-window playback does not depend on WebView timers.
- Add macOS Now Playing/Remote Command Center and Windows SMTC with metadata, progress, Seek and artwork.

## 全局通知队列与三层堆叠（R8，L1/L2 前）

- 以现有右上角 `GlobalToast` 为基础改成独立通知队列：所有消息追加而非互相覆盖；活跃消息达到 3 条即折叠为最新前台卡片和两层背景预览，hover / focus 时展开全部活跃消息。
- 需要为入场、重排、收起、手动关闭与自动关闭保留 presence 节点和 reduced-motion 降级；现有 4.2 秒自动关闭、单条关闭按钮、浅 / 深及三种 Cadilume 配色必须继续适用，阈值不用于丢弃消息。
- 先完成受控浏览器 fixture 与针对性的队列 / 计时器测试，最后只保留一条真实 Tauri 开发态做同场景验证；不以截图代替验收。

## 暗色开关可见性、主题封面稳定与页面标题统一（R9，R8 后、L1/L2 前）

- 修复暗色关闭态开关的轨道、边框和滑块对比，浅 / 深 × 琥珀金、雨林绿、澄海蓝均需清晰可辨；保留开关可访问性与交互状态，不以竖线或无意义小字补救。
- 主题双层揭示只能切换颜色，封面、头像和其他图片不得发生几何、`transform`、`object-position`、filter 或异步重排抖动；不得重新引入 `document.startViewTransition()`、路由 revision 或路由入场。
- 推荐、歌曲、设置页要采用专辑 / 歌手页同一套 sticky 标题、半透明背景和内容内分割线；标题在滚动、刷新、主题切换与同页重复点击时稳定。
- R8、R9 均先内部浏览器验证，随后只保留一条真实 Tauri 开发态统一复测；不截图、不启动第二条开发态。

## Plex protocol hardening

- Add Ed25519 JWK/JWT device auth and refresh.
- Drive browsing and capabilities from `/media/providers` instead of fixed legacy paths.
- Add server-backed playQueues and universal playback decision.
- Add an isolated experimental Managed User home-switch adapter.

## 2026-07-31 — 已完成归档与剩余平台功能

- 跨设备历史（默认关闭、脱敏、非 Plexamp 私有云协议）、两态主题、固定琥珀金 / 雨林绿 / 澄海蓝预设、纯唱片 Logo、macOS Dock 图标逻辑，以及 provider adapter 边界均已进入已完成计划记录，不再作为待开发 Feature。
- 下一个实施项为 R8 全局通知队列与三层堆叠，随后是 R9 暗色可见性、主题封面稳定与页面标题统一；两项完成后才是必须单独立项的 Plex Companion controller / receiver（L1）和 Emby / Jellyfin 实际认证、浏览、播放与歌词接入（L2）。现有配色、Logo 或 adapter 接口均不代表这些服务已支持。
