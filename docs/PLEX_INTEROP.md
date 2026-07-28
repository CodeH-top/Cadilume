# Cadilume 与 Plex 互操作研究

更新日期：2026-07-28。

## 可公开依赖的主链路

Plex 已发布 PMS OpenAPI。Cadilume 当前使用下列公开/可观察互操作接口：

1. `POST https://plex.tv/api/v2/pins?strong=true`
2. 在系统浏览器打开 `https://app.plex.tv/auth#?...`
3. `GET /api/v2/pins/{id}` 轮询 token
4. `GET /api/v2/user`
5. `GET /api/v2/resources?includeHttps=1&includeRelay=1`
6. 从资源对象中取目标 PMS 的 `accessToken` 和 `connections[]`
7. 用该服务器 token 请求 `/library/sections`、元数据、搜索、图片和媒体 Part

当前 strong PIN 是 Plexamp 4.12.4 仍在使用的兼容路径。正式长期版本应增加 Plex 新版 Ed25519 JWK/JWT 设备认证与刷新逻辑，参考 [PMS 官方认证说明](https://developer.plex.tv/pms/#section/API-Info/Authenticating-with-Plex)。

## 免费账号与家庭共享

免费独立 Plex 账号可以播放直接共享给自己的音乐库；音乐不受 2026 视频远程播放付费限制。实现的关键不是伪装 Plexamp 或绕过 Plex Pass，而是：

- 不在客户端侧用 `subscription.active` 阻止基础音乐库。
- 资源发现必须保留 `owned:false`、`home:true` 的 PMS。
- PMS 请求必须使用资源对象的服务器专属 `accessToken`。
- 媒体 Part 采用 streaming，不附加 `download=1`；下载权限与播放权限不同。
- 服务器拒绝访问时尊重其 ACL，不模拟官方客户端身份。

参考：[Plex 免费与付费能力](https://support.plex.tv/articles/202526943-plex-free-vs-paid/)、[远程播放要求](https://support.plex.tv/articles/requirements-for-remote-playback-of-personal-media/)、[管理资料库共享](https://support.plex.tv/articles/201105738-creating-and-managing-server-shares/)。

Managed User 无法独立登录。Plex 官方 Kodi 客户端使用 `/api/home/users` 与 `/{id}/switch` 取得 `authenticationToken`，但该接口未进入当前公开 OpenAPI；后续只应作为标明实验性的兼容层实现，并在切换后重新发现 resources。

## 音乐资料库

首版兼容经典 PMS 路径：

- `type=8`：Artist
- `type=9`：Album
- `type=10`：Track
- `/library/metadata/{ratingKey}/children`
- `/hubs/search?query=...`

更稳健的后续版本应先读取 `/media/providers`，按响应里的 Provider Feature、Pivot、key、hubKey 和 playQueue key 进行导航，不长期硬编码路径。

## 播放

首版：

- 原始质量直接播放 `Media[].Part[].key`。
- 不兼容格式可调用 `/music/:/transcode/universal/start.mp3`。
- 每 10 秒或状态变化发送 `/:/timeline`。
- 播放达到 90% 时发送 `/:/scrobble`。

后续应增加 universal decision、Client Profile、PMS playQueue ID/item ID/version，以及 Range/缓存代理。

## 本机 Plexamp clean-room 观察

只读检查 `/Applications/Plexamp.app` 得到：

- 版本 4.12.4，Electron 28.3.0 + React Native Web，应用约 206 MB。
- 默认窗口 270×515，并额外使用 0.8 zoom。
- 独立音量链路存在，但窄屏布局只有 `screenHeight >= 675` 才显示滑块，因此默认窗口隐藏了控件。
- 原生 Treble/BASS 提供 gapless、crossfade、ReplayGain、设备切换等；属于专有/另行授权实现，不复制。
- Windows 媒体服务返回 NullService，只剩全局媒体键，没有完整 SMTC 元数据/进度/Seek。
- 客户端允许 free users，家庭切换后会重新请求 user 与 resources，并使用 per-server token。

Cadilume 仅记录接口契约与行为，由独立代码实现，不复制 ASAR 代码、文案、字体、图标、内部密钥或私有二进制。Plex、Plexamp 与 PMS 在本文中仅作为第三方服务、API 和 clean-room 观察对象出现。
