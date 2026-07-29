# FEATURE_REQUESTS

## 歌词与 Plexamp 实曲对时

- 当前歌词时间计算自首次实现后未被校准：活动行以 `audio.currentTime * 1000` 对照歌词时间戳，已有 `delayMs` 参数未接入产品，实际恒为 0；此前完成的是歌词 UI、独立滚动和布局稳定，不是对时修复。
- 需要在用户真实 PMS 上使用同一曲目和同一歌词源，对开头、中段、结尾分别采样，确认问题属于恒定领先、随播放累积漂移、歌词源选择差异，还是切换直放/转码、AirPlay 等输出链路后的延迟。
- 验收前需核对 Plex `startOffset/endOffset` 原始响应单位与歌词流选择，并覆盖直放/转码及本机输出；没有这些证据前不得添加猜测性的固定补偿或把演示数据测试视作已解决。

## 真实 PMS 播放验收与逐曲链路诊断

- 有界回退已覆盖原始流及 PMS 生成的 320/256/192 kbps 兼容流，但此前用户报告的真实失败曲目尚未在其 PMS 上端到端复播；完成该验收前不能把自动测试等同于“所有音乐均已解决”。
- 当前“本地直连 / 远程直连 / Plex Relay”只显示服务器发现阶段的首选连接。代理会在逐曲请求中尝试多个连接与转码 endpoint，因此该标签不是最终成功链路。
- 若需要向用户显示当前曲目的实际连接和直放/转码结果，应由 Rust 流代理在成功获得上游响应时发布脱敏运行态事件，只返回连接类型、媒体决策和有效码率，不暴露 PMS URI、媒体路径或 token。

## macOS release trust chain

- Add Developer ID Application signing and Apple notarization/stapling once the project has an Apple Developer team and release credentials. Until then, generated DMGs are local acceptance artifacts and cannot guarantee the exact Gatekeeper experience on another Mac.

## Native playback core

- Move queue authority, Range/cache, decoding, independent gain, gapless/prefetch and output device selection into Rust so Windows hidden-window playback does not depend on WebView timers.
- Add macOS Now Playing/Remote Command Center and Windows SMTC with metadata, progress, Seek and artwork.

## Plex protocol hardening

- Add Ed25519 JWK/JWT device auth and refresh.
- Drive browsing and capabilities from `/media/providers` instead of fixed legacy paths.
- Add server-backed playQueues and universal playback decision.
- Add an isolated experimental Managed User home-switch adapter.
