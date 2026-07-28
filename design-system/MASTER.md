# Cadilume Design System

## Direction

- 桌面资料库优先，参考 Apple Music 与 Spotify 的清晰信息层级，不复制其品牌资产或界面细节。
- 采用 Swiss/Editorial 式理性网格、低干扰表面和暖橙强调色；深色与浅色是同一套语义 token 的两种表现，不锁死单一主题。
- 保留系统原生标题栏，不自绘 macOS 红黄绿或 Windows 窗口按钮。
- 固定三段式播放栏：当前曲目、播放控制、歌词/队列/设备与独立音量。
- 界面图标统一使用项目内 Lucide 线性图标；品牌标记与应用图标使用项目自己的暖橙箭头语言，保留 Plex 式前进感，但不引入外部 Plex/Plexamp 图标资产。

## Semantic Tokens

| 语义 | 深色 | 浅色 |
| --- | --- | --- |
| Background | `#101112` | `#F7F5F2` |
| Sidebar | `#141516` | `#EEECE8` |
| Panel | `#191B1C` | `#FFFFFF` |
| Raised panel | `#202223` | `#E8E5E0` |
| Text | `#F4F4F1` | `#202120` |
| Muted | `#9B9E9F` | `#696C6B` |
| Accent | `#F0A15D` | `#B95D19` |
| Error | `#EE7B73` | `#B94841` |

- Spacing base: 8px。
- Corner radius: 6/8/12px，设备浮层使用 14px。
- Font: system UI（`SF Pro`、`Segoe UI`、`Noto Sans SC` fallback）。
- 主题选择支持跟随系统、浅色、深色；桌面歌词与主窗口共用主题状态。

## Interaction

- 所有功能图标来自 Lucide，不使用 emoji 或混入其他图标集充当 UI 图标。
- hover 只改变颜色、背景或透明度，不使用会引发布局抖动的缩放。
- 转场 160–200ms；遵守 `prefers-reduced-motion`。
- 键盘焦点使用 2px 暖橙轮廓。
- `⌘/Ctrl + K` 聚焦搜索，Space 播放/暂停；系统媒体键由 Media Session 处理。
- 音量滑块在最小桌面宽度下仍固定显示，永不依赖窗口高度断点。
- 播放器右侧入口保持 `歌词 → 队列 → 播放设备 → 音量`，歌词、队列与设备浮层互斥，避免多层内容相互遮挡。
- 关闭主窗口遵循设置中的“最小化到托盘/菜单栏”或“退出程序”；设置页与托盘/菜单栏始终有明确退出入口。

## Layout

- 默认窗口 1280×820，最小 960×640。
- Sidebar 218px（窄桌面 194px）。
- Player 92px 固定底栏。
- Queue / Lyrics 为 350px 右栏；窄桌面改为 330–350px 覆盖层。
- 播放设备使用靠近播放器右侧、宽 330px 的浮层，最大高度受窗口限制，不挤压资料库主内容，也不遮挡固定播放器。
- 专辑卡片使用自适应网格，歌曲使用可扫读表格；设置内容限制最大宽度，保持桌面阅读行长。
- 桌面歌词为独立、置顶、无边框小窗口：当前行使用强调色，下一行使用弱化文字，并提供项目内关闭图标。

## Media Presentation

- 封面进入可视区域前约 320px 开始预取，使用固定尺寸请求，避免原图浪费和滚动时闪烁。
- 封面加载失败使用统一的项目内 Music 图标占位，不显示破图或外部占位图。
- 封面由 Rust 鉴权、缓存后作为 Data URL 注入；组件不得拼接或持久化带 Plex token 的图片 URL。
- 时间轴歌词按播放进度自动高亮和滚动；可点击有时间戳的歌词 Seek。纯文本歌词保持可读，但不得伪造时间轴步进。
- AirPlay 与 Windows 输出设备都使用同一“播放设备”浮层语言：平台图标、当前状态、主要动作、明确的系统降级说明。

## Platform Output Copy

- macOS 主动作使用“选择 AirPlay 设备”；WKWebView picker 不可用时明确引导“控制中心 → 声音”，不暗示应用已掌控系统路由。
- Windows 设备项区分“系统默认”和“Cadilume 专用输出”；设备断开时明确提示已回退系统默认。
- WebView2 不支持 `setSinkId` 时提供“打开 Windows 音量合成器”，不展示不可执行的设备按钮。
- 设备能力属于 best-effort 平台集成；文案不得宣称严格 gapless、完整 SMTC 或已经覆盖所有 USB/蓝牙/HDMI 设备。

## Accessibility

- 所有图片有替代文字，纯装饰图标隐藏。
- 所有图标按钮有 `aria-label` 与 `title`。
- 资料库导航、主要内容、队列、歌词和播放器具备语义区域。
- 提供“跳到主要内容”链接。
- 动态错误和设备状态使用 `role=status/alert`。
- 设备列表使用 list/radiogroup 语义，当前输出用 `aria-checked` 表达。
