# Cadilume 下一轮增量修改计划（2026-07-29）

> 本文是下一次新上下文的唯一增量执行入口。`docs/DEVELOPMENT_PLAN.md` 保留历史需求、研究结论和已完成记录，不得按旧文档从头重做。

## 1. 本次归档边界

- 2026-07-29 本轮只归档计划，不再修改代码、不构建、不测试、不提交。
- 当前基线提交：`d723311 feat: 完善歌词同步与资料库导航`。
- 当前工作树包含上一轮尚未完成、尚未验证的代码；必须保留并接着完成，禁止恢复、覆盖或重写已有成果。
- 下一轮开始时先阅读 `git diff`，把每项分成“已经实现，只需验证”“已有初稿，需要补全”“尚未实现”三类，只处理后两类和未通过的验收项。
- 已完成的研究、旧版 UI 调整和历史构建不得重复执行；发现实现已满足验收时，直接记录验证结果。

## 2. 最新决定优先级

以下决定覆盖此前冲突需求：

1. **macOS AirPlay 完整删除**：公开 API 无法稳定复刻 Apple Music 的系统级体验，不再继续优化 `Show More`、设备发现动画或系统选择器；Windows 普通音频输出设备选择保留。
2. **暂时取消应用业务快捷键**：删除搜索聚焦、空格播放等全局快捷键及界面快捷键提示。搜索只保留可见输入框、点击和正常表单提交。
3. **播放列表不显示刷新按钮**：早先“播放列表标题右侧加刷新”已被后续要求取消；同步资料统一使用顶部刷新资料按钮，播放列表失败态可保留“重试”。
4. **展开播放器恢复歌词**：早先“弹窗播放器不显示右侧歌词”的结论已被后续要求覆盖；展开播放器内部必须有歌词，并使用当前真实播放进度。
5. **最小/默认窗口固定为 `1280×820`**，不再恢复 `960×640`。
6. **字母索引顺序为 `#`、A–Z**；主页名称为“推荐”；“歌单”统一改为“播放列表”。
7. **今天不实施代码**：本文新增后的所有实现均留到下一上下文。

## 3. 当前未提交改动地图

下列内容在当前工作树已有初稿，但尚未完成整轮类型检查、测试、构建和 Chrome 验收，不得当作已完成，也不得从头重写：

- 推荐页与 PMS Hub：最近播放的播放列表、最近播放的音乐、其他推荐、最近加入兜底。
- 左侧播放列表：普通/智能/只读播放列表、封面缩略图、折叠、轻浅滚动区域。
- 顶部工具区：连接状态图标、Plex 用户、设置、刷新资料。
- 艺术家详情：“专辑 / 歌曲”标签页、50 首分页懒加载、歌曲表格及 PMS 排序参数。
- 首字母索引：`#` 已调整到 A–Z 前面。
- 播放反馈：初次加载/缓冲状态、播放键 loading、全局 Toast。
- 音量：底栏及展开播放器纵向音量初稿。
- macOS AirPlay：应用界面入口已在未提交 diff 中删除，但 `usePlayer`、`useOutputDevices`、测试和文档仍保留 AirPlay 逻辑。
- 展开播放器：`App.tsx` 已开始传入歌词状态，但 `NowPlayingView` 尚未完整接收和渲染歌词；当前代码很可能不能通过 TypeScript 检查。

当前修改文件包括 `package.json`、`pnpm-lock.yaml`、`src/App.*`、`src/NowPlayingView.tsx`、播放器/API/索引相关源码与测试；另有未跟踪的 `src/recommendations.ts` 和 `src/recommendations.test.ts`。下一轮不得丢弃这些文件。

## 4. 增量任务清单

### P0：接管当前工作树，不重复实现

- 只读检查 `git status`、`git diff` 和本计划，确认现有初稿的实际完成度。
- 先运行一次 `pnpm check` 获取真实编译缺口；只修复与本计划及现有初稿直接相关的问题。
- 不执行 `git restore`、`git checkout --`、`git reset`，不做全项目自动格式化。

### P1：完整删除 macOS AirPlay

目标：Cadilume 的 macOS UI、播放器状态和播放链路中不再存在 AirPlay 功能或伪装成 Apple Music 的输出面板。

- `src/App.tsx`：确认 macOS 底栏、展开播放器和设备面板均无 AirPlay 入口；Windows 的“播放设备”入口继续存在。
- `src/usePlayer.ts`：删除 `webkitShowPlaybackTargetPicker`、无线播放目标状态、相关事件、`x-webkit-airplay` 属性和 AirPlay 专用切歌分支；切歌统一回到双 Audio 预缓冲/切换逻辑。
- 删除仅为“保留 AirPlay 路由”存在的 URL 消费或 Audio 保留分支；若 helper 仍有其他调用方才保留。
- `src/useOutputDevices.ts`：删除 `activateOutputControl` 中的 AirPlay 结果和回调，收口为 Windows 输出设备能力；平台检测可以保留，但 macOS 不提供应用内设备按钮。
- 同步删除或改写 `usePlayer.test.ts`、`useOutputDevices.test.ts` 中所有 AirPlay 用例。
- 更新 `README.md`、`docs/ARCHITECTURE.md` 和旧计划的当前状态说明：AirPlay 已按产品决定删除，Windows 输出设备选择仍保留。旧研究记录可作为历史保留，但不能再描述为当前功能。
- 全局残留检查：`AirPlay`、`airPlay`、`airplay`、`webkitShowPlaybackTargetPicker`、`webkitcurrentplaybacktargetiswirelesschanged`、`x-webkit-airplay` 在运行时代码中均为 0；历史文档仅允许保留明确标注的决策背景。

验收：macOS 最小窗口内完全没有 AirPlay 图标、设备按钮、提示或状态；连续切歌、暂停、恢复和预缓冲不依赖无线状态；Windows 输出设备选择不回归。

### P2：取消应用业务快捷键

目标：界面不再宣传或监听 Cadilume 自定义快捷键，搜索就是普通搜索框。

- 删除全局 `⌘/Ctrl + K` 聚焦搜索、空格播放/暂停以及普通侧栏 Escape 收起等业务快捷键监听。
- 删除搜索框里的 `<kbd>`、`⌘ K`、`Ctrl K` 及对应 CSS；删除按钮 `title` 中面向用户展示的快捷键后缀，例如“（Esc）”。
- 不新增其他全局快捷键、菜单快捷键或设置开关。
- 保留输入框原生复制、粘贴、全选、光标操作和 Enter 提交表单。
- 保留标准控件与模态框所需的无障碍键盘行为，例如 Tab 焦点约束和标签页方向键；这些属于控件可访问性，不作为产品快捷键展示。
- 更新相关单元测试和文档，确保不再声称支持应用快捷键。

验收：搜索框无快捷键徽标；`⌘/Ctrl + K` 和页面空格不会触发应用操作；点击输入、输入关键字、点击或 Enter 搜索仍正常；输入框系统编辑能力不受影响。

### P3：播放器 loading、歌词和视觉收口

#### P3.1 初次播放与缓冲

- 复核已有 `loading` / `buffering` 初稿，不重复搭建状态。
- 初次加载、网络卡顿和切源等待时，底栏及展开播放器的主播放键显示稳定 loading；加载完成后恢复播放/暂停图标。
- loading 期间避免重复触发播放，不得用播放器角落小字代替主反馈；失败继续走全局 Toast。

#### P3.2 展开播放器歌词

- `NowPlayingView` 正式接收歌词文档、加载/错误/无歌词状态、当前行索引和点击跳转回调。
- 恢复弹窗内部歌词区域；布局由弹窗自身填充，不复用外部右侧抽屉，也不出现第二个关闭按钮。
- 歌词与队列的显示/隐藏由底部按钮切换；外部正常播放器侧栏也不放多余关闭按钮。
- 使用现有 `getPlexLyricsScrollTop()`、当前 Audio 的真实 `currentTime` 和当前行渐变；不显示歌词行数、provider、footer 或无意义底部说明。
- 无歌词时显示简洁空态，歌词按钮禁用；纯文本歌词可读但不可伪装成定时歌词。

#### P3.3 歌词同步重新验收

- `d723311` 后用户仍反馈歌词“慢半拍”，所以 LYR-002 重新打开，不能声称已经解决。
- 以曾沛慈《我才没有那样呢》为必测曲，并增加多首有定时歌词、无歌词、纯文本歌词歌曲。
- 对照授权 PMS 返回时间戳、Cadilume Audio `currentTime` 和 Plex Web/Plexamp 的可见换行时刻，先定位数据偏移还是播放时钟偏移；不得直接叠加拍脑袋的全局固定补偿。
- 沿用旧计划已有的公开方案研究，不重复搜索 Plexamp 私有实现；只有证据证明 WebView 播放时钟无法修正时，才另开原生播放内核 RFC。不要为了歌词同步直接迁移 Electron。

#### P3.4 展开播放器布局与主题

- 弹窗内容填满可用区域，四周只保留约 24–32px 的原生桌面间距，消除左右大块空白。
- 封面模式改为清晰、无模糊的全屏背景图观感，使用 `contain` 完整显示封面；降低蒙版强度，浅色模式使用浅色层级，不套深色模式遮罩。
- 深色黑胶模式背景改为灰黑层次，让唱片和唱臂可辨识；浅色模式继续保证唱臂对比度。
- 删除曲名旁状态圆点和唱臂顶部无意义圆形基座，只保留真正表达播放状态的控件。
- 随机/循环已选中时，hover 只使用透明度、亮度或图标颜色变化，不再增加外圈背景、阴影或第二层边框。
- 底栏曲目信息 hover 只覆盖文字/封面内容宽度并保留小幅 padding，不得铺满整列。

### P4：推荐、播放列表与顶部工具区

- 复核已有推荐 Hub 初稿：顺序固定为“最近播放的播放列表”→“最近播放的音乐”→其他服务器推荐→“最近加入”最后；缺少某类 Hub 时自然跳过，不展示空壳。
- 主页文案统一为“推荐”，歌单统一为“播放列表”。
- 播放列表常驻左侧、可折叠，列表内部有轻浅滚动条，优先显示播放列表图片；普通、智能、只读播放列表均可打开和播放。
- 播放列表标题右侧不显示刷新按钮；顶部“刷新资料”负责全局同步，失败态“重试”只重试失败请求。
- 顶部空白区显示连接图标、Plex 用户、设置和刷新资料；连接图标覆盖本地直连、远程直连、Plex Relay 和断开四态，tooltip/辅助标签说明状态。
- 清理旧 `.connection-pill`、`.status-dot` 和侧栏底部账号/设置残留样式，避免两套 UI 共存。
- 首字母索引使用 Plex 排序因子，顺序固定为 `#`、A–Z；深浅主题和 1280×820 都不能遮挡内容。

### P5：设置与资料来源

- 左侧不显示“共享资料库”或服务器/资料库来源项。
- 服务器与音乐资料库放到设置内部，使用项目现有 Web Select 组件，不使用原生 `<select>`；候选只有一个时直接禁用并保持可读。
- 设置分组标题的行高与右侧单行内容一致，保证垂直居中。
- 删除无意义描述、重复说明和页内顶部提示；成功、失败、同步结果统一使用全局 Toast。
- 退出账号保持危险红色；设置内不重复提供“退出 Cadilume”。

### P6：艺术家详情

- 复核现有“专辑 / 歌曲”标签页初稿，不重新实现数据层。
- 返回按钮需要更明显；歌手头像、名称区与下方专辑/歌曲内容增加合理间距。
- “歌曲”表格列为序号、专辑小图、标题、歌手、专辑、时长；一页 50 首并懒加载下一页。
- PMS 请求排序为专辑排序因子，再按专辑内碟号/曲号排序；分页追加必须去重，失败只重试当前后续页。
- 行 hover、键盘焦点和点击播放队列均需验证；标签页标准方向键行为作为无障碍交互保留，不属于应用快捷键。

## 5. 明确不做

- 不再尝试仿制 Apple Music AirPlay 面板，不使用私有 API、模拟系统点击或自绘假设备列表。
- 不在本轮迁移 Electron，不因歌词问题直接替换整个前端壳层。
- 不重复执行旧计划已经完成的 Plexamp 私有包研究、Vite 8 调研或历史 DMG 构建。
- 未收到新的明确打包指令时不构建 DMG；未来构建 DMG 后必须清理中间 `.app`，只保留交付 DMG，避免 Spotlight 检索出应用副本。
- 不主动截图；Web UI 验收使用 DOM、computed style、交互结果和控制台信息。

## 6. 下一轮执行与记录顺序

1. 接管并分类当前 diff，运行首次 `pnpm check`，只修真实缺口。
2. 完成 P1 AirPlay 删除，记录残留搜索和相关单元测试。
3. 完成 P2 快捷键删除，验证搜索与输入框原生编辑。
4. 完成 P3 展开播放器、歌词、loading 和 hover。
5. 完成 P4–P6 的现有初稿补全，不重写已实现数据链路。
6. 每完成一个阶段，就在本文末尾追加“实现文件 / 验证结果 / 未决项”，并立即用 Chrome 插件在 `1280×820` 做该阶段 Web UI 实测；不使用内部浏览器，不主动截图。
7. 最终统一运行 `git diff --check`、`pnpm check`、`pnpm test`、`pnpm build`、`cargo fmt --check`、`cargo test --manifest-path src-tauri/Cargo.toml` 和不打包的 Tauri 构建。
8. 深色、浅色均验证推荐页、播放列表折叠/滚动、设置 Select、艺术家分页、展开播放器两种模式、歌词/无歌词、loading、Toast、连接四态、无 AirPlay、无应用快捷键。
9. 全绿后更新相关文档和项目记忆，立即创建一次本地提交；不 push。

## 7. 下一轮记录区

### P0 — 2026-07-30 接管结果

- 实现文件：本阶段只读接管，没有修改业务代码；保留 `d723311` 之后的全部已跟踪修改，以及未跟踪的 `src/recommendations.ts`、`src/recommendations.test.ts` 和本文。
- 完成度分类：推荐 Hub、常驻播放列表、顶部工具区、艺术家“专辑 / 歌曲”与 50 首分页、`#`→A–Z 索引、播放 loading/Toast、纵向音量已有初稿，只进入验证；macOS AirPlay 运行态/测试/文档、应用业务快捷键、展开播放器歌词与视觉细节仍需补全。
- 验证结果：`git status --short --branch` 确认基线为 `main@d723311`；`git diff --check` 通过。首次 `pnpm check` 仅报 `App.tsx` 已传入 `lyrics`、但 `NowPlayingViewProps` 尚未接收这一处缺口，与本计划记录一致。
- 未决项：进入 P1 删除 AirPlay 残留；歌词类型缺口留在 P3 按现有数据链路补全，不在 P0 重写。

### P1 — 2026-07-30 macOS AirPlay 删除

- 实现文件：`src/usePlayer.ts` 删除 WebKit picker/无线状态/属性、URL-only 预缓冲消费和专用切歌分支，双 Audio 统一走已准备元素切换；`src/useOutputDevices.ts` 删除 macOS 激活 helper；同步收口相关测试。`README.md`、`docs/ARCHITECTURE.md`、`design-system/MASTER.md` 更新为 macOS 输出交给系统、仅 Windows 保留应用内设备选择；旧 `docs/DEVELOPMENT_PLAN.md` 顶部明确标为历史且已被当前决定覆盖。
- 自动验证：运行时代码残留搜索 `AirPlay|airPlay|webkitShowPlaybackTargetPicker|webkitcurrentplaybacktargetiswirelesschanged|x-webkit-airplay` 为 0；播放器/输出设备相关测试执行后全套 12 个测试文件、87 项测试通过；`git diff --check` 通过。再次 `pnpm check` 仍只保留 P0 已知的 `NowPlayingViewProps.lyrics` 缺口，没有新增 P1 类型错误。
- Chrome 1280×820：仅使用 Chrome 插件，无截图。深色与浅色均确认实际视口 `1280×820`、根主题正确、页面和播放器中的 AirPlay 文本/输出按钮计数均为 0、横纵溢出均为 0；固定播放器矩形为 `(0,728)–(1280,820)`。
- 未决项：Windows 输出设备的 `enumerateDevices` / `setSinkId` / 热插拔与回退测试保持全绿；真实 Windows 设备仍属于跨平台发布验收，不阻塞本轮。进入 P2 删除业务快捷键。

### P2 — 2026-07-30 取消应用业务快捷键

- 实现文件：`src/App.tsx` 删除全局 `⌘/Ctrl+K`、页面空格播放和普通侧栏 Escape 监听，同时移除搜索输入 ref 与 `<kbd>`；`src/App.css` 删除专用 `kbd` 样式；`src/NowPlayingView.tsx` 去掉关闭按钮的“（Esc）”提示后缀；`design-system/MASTER.md` 改为只保留输入编辑、标签页与模态框的标准键盘行为。
- 静态验证：运行时代码中 `<kbd>`、`⌘ K`、`Ctrl K`、`metaKey/ctrlKey`、Space 监听、快捷键 title 后缀与菜单 accelerator 残留均为 0；剩余 `keydown` 仅为展开播放器/播放列表对话框的 Escape+Tab 焦点管理和艺术家标签页方向键。
- Chrome 1280×820：仅使用 Chrome 插件，无截图。浅色与深色下 `kbd` 和快捷键徽标计数均为 0；在 `main` 上发送 `Meta+K` 后焦点仍留在 `MAIN`，发送 Space 后主播放按钮仍为“播放”。搜索框点击/输入后 `Meta+A` 均得到完整选择范围，Enter 分别完成 `Open Window`（3 项）与 `Mira`（5 项）搜索；两主题横纵溢出为 0，控制台 warning/error 为 0。
- 未决项：无。模态框 Escape/Tab 与标签页方向键按无障碍标准保留，进入 P3。

### P3 — 2026-07-30 播放器 loading、歌词和视觉收口

- 实现文件：`src/NowPlayingView.tsx` 正式接入歌词、队列、当前队列索引和选曲回调，展开层新增互斥歌词/队列内容；定时歌词复用 `getPlexLyricsScrollTop()`、活动 Audio 进度与毫秒级行渐变，纯文本保持静态，无歌词时内外按钮禁用。根据用户截图纠正布局后，歌词/队列改为播放器骨架内与左侧播放视觉并列的完整右栏，删除窄卡片式标题、边框、圆角、阴影、玻璃背景。底栏与展开层 loading 主按钮均禁用重复触发并保持 spinner 清晰。`src/NowPlayingView.css` 另收口封面 `contain` 背景、深浅独立遮罩、灰黑黑胶层级、状态圆点/唱臂基座、选中态 hover、曲目信息 hover 和纵向音量浮层；`src/App.tsx` 增加仅开发环境使用的歌词/长列表预览入口。同步更新 README、架构与设计系统的展开层歌词描述。
- 自动验证：`pnpm check` 通过；12 个测试文件共 89 项通过，新增歌词毫秒进度回归；`git diff --check` 通过。运行时代码没有恢复 AirPlay 或业务快捷键。
- Chrome 1280×820：仅使用 Chrome 插件，无截图。深浅主题均验证展开层精确覆盖 `1280×820`、内容四周为 `24–28px`、横纵溢出为 0；歌词/队列右栏矩形为 `562×611`，占内容宽度约 `45.9%`，从 `x=690` 延伸到内容右边界，surface 为透明、`border=0`、`border-radius=0`、`box-shadow=none`，不再呈现独立弹窗。封面层无 blur、使用 `contain` 规则且浅色不套深色遮罩，黑胶模式唱片/唱臂可辨，状态圆点和唱臂 `::before` 基座为 0。loading 主按钮为 disabled、`aria-busy=true`、spinner 不透明；循环选中态 hover 前后边框/背景不增加且 `box-shadow=none`；纵向音量浮层为 `50×138`、滑杆 `18×92`，完整落在视口内。
- 歌词与队列实测：40 行定时歌词只滚动完整右栏的独立列表，活动行自动落入可视区；点击第 10 行把进度准确跳到 `18s`。歌词/队列右栏互斥且只有一个模态关闭按钮，3 项队列当前索引正确，点击首项后曲名与索引同步。纯文本预览 12 行全部静态、无活动行且不可点击；无歌词时内外按钮均 disabled；loading 显示“正在读取歌词…”，error 显示“歌词加载失败”。控制台 warning/error 为 0。
- 未决项：LYR-002 继续保持打开。当前只证明 UI 使用现有 PMS 毫秒边界和真实 `currentTime`，尚未在授权 PMS 真机对照曾沛慈《我才没有那样呢》及多首歌曲的实际听感；本轮没有添加固定 delay，也不宣称“慢半拍”已解决。进入 P4，只验证和收口现有推荐、播放列表与顶部工具区。

### P4 — 2026-07-30 推荐、播放列表与顶部工具区

- 实现文件：保留 `src/recommendations.ts` 的既有排序与最近播放计算，只验证不重写。`src/App.tsx` 将可见“歌单”统一为“播放列表”，为连接图标增加仅开发环境可用的 `connection-preview=local|remote|relay|disconnected` 验收入口；`src/App.css` 删除 `.connection-pill`、`.status-dot`、`.sidebar-footer`、`.sidebar-settings-button` 旧样式并补齐 32px 连接图标四态。播放列表标题折叠时发现 author CSS 的 `display:grid` 覆盖了 HTML `hidden`，补充 `.sidebar-playlist-list[hidden]{display:none}` 和折叠高度/箭头规则。README、架构与设计系统同步为当前顶部工具区、侧栏结构和“播放列表”术语。
- 自动验证：`pnpm check` 通过；12 个测试文件、89 项测试通过；`git diff --check` 通过。推荐排序测试继续覆盖“最近播放优先、PMS 其他 Hub 保序、最近加入最后”和最近播放播放列表排序；当前运行时代码及三份当前文档中的“歌单”残留为 0。
- Chrome 1280×820 推荐与侧栏：仅使用 Chrome 插件，无截图。深浅主题推荐顺序均为“最近播放的播放列表”→“最近播放的音乐”→“常听专辑”→“最近加入的音乐”，空壳 section 为 0。15 个普通/智能/只读播放列表的内部滚动区为 `419/735px`、`overflow-y:auto`、thin scrollbar；滚到最后一项时侧栏 `scrollTop=316.5`、主内容仍为 0。折叠后列表 `display:none`、导航高度 28px，展开后恢复约 `446.5px`，两主题横纵溢出为 0；标题内刷新按钮为 0。
- Chrome 1280×820 播放与工具区：普通“晨间慢醒”、智能“最近加入”和只读“旧日存档”均可打开并点击“播放全部”，实际队列分别恢复为 6、6、4 项且当前项正确。顶部只有连接状态、Plex 用户、设置、刷新资料；点击顶部刷新后出现“已重新发现可访问的服务器，音乐资料库正在同步。”全局 Toast。深浅主题均逐一验证本地直连、远程直连、Plex Relay、连接已断开四态的 `data-connection`、图标颜色和可访问标签，尺寸恒为 `32×32`、横纵溢出为 0。`#`、A–Z 共 27 个索引按钮在两主题均完整位于视口内，顺序固定且仅有内容的桶可用。控制台 warning/error 为 0。
- 用户追加收口：`src/App.tsx` / `src/App.css` 将折叠箭头移到“播放列表”文字后 3px，原标题最右位置改为独立 `+`；新增带空名称禁用、busy、Escape、Tab 焦点闭环和触发器焦点恢复的创建对话框。`src/api.ts` 与 Rust `create_playlist` command 通过当前服务器专属 token 调用 PMS `POST /playlists` 创建空白普通音频播放列表，WebView 不直连 PMS；演示模式同步支持创建和刷新。顶部账号改为无常驻外框的头像+两行信息横排，只保留独立 hover/focus；连接四态改用可聚焦状态图标、`aria-describedby` 和真实 `role="tooltip"`，不再只依赖原生 `title`。同步补充 TS/Rust 测试与 README、架构、设计系统说明。
- 追加 Chrome 1280×820：浅色与深色下箭头紧跟文字且间距 3px，`+` 距侧栏内容右边 4px；折叠后播放列表 `display:none`、区域高 28px，展开后恢复 446.5px，均无溢出。创建弹窗为 `430×283.5px`，初始焦点落在名称输入框，空名称时创建 disabled；Shift+Tab 闭环、Escape 关闭并把焦点还给 `+`。演示创建“P4 新建验收”后列表由 15 项变为 16 项、首项名称正确并出现成功 Toast。账号头像与两行信息水平排列、四边 border 均为 0，双主题 hover 仅增加独立轻量背景。四态 tooltip 均从 hidden 变为 visible，文字分别明确局域网直连、公网直连、Plex 中继带宽提示和断开，hover/focus 均通过且完整位于视口内。
- 未决项：真实 PMS 的连接切换、创建/写入 ACL 和网络失败重试仍属于原生跨账号验收；浏览器演示、Tauri 命令边界和单元测试已覆盖本轮新增创建流程。进入 P5，删除设置页重复同步入口并验证来源 Select。

### P5 — 2026-07-30 设置与资料来源

- 实现文件：保留现有 Radix `SettingsSelect` 与来源切换链路，只删除 `SettingsView` 中重复的 `.source-sync-row`、“家庭 / 共享访问 · 连接方式”说明和“同步资料”按钮，同时删除不再需要的 `sourcesSyncing` / `onSyncSources` 内容页 props 与 CSS。顶部“刷新资料”继续作为唯一全局同步入口；设计系统同步移除设置页同步配置描述。
- 自动验证：`pnpm check` 通过；12 个测试文件、89 项测试通过；`git diff --check` 通过。`source-sync-row|onSyncSources|sourcesSyncing=` 和当前 UI/文档中的“同步资料”残留为 0。
- Chrome 1280×820：仅使用 Chrome 插件，无截图。浅色与深色设置页均确认服务器、音乐资料库各只有一个 `BUTTON.settings-select-trigger[role=combobox]`，没有来源原生 `<select>`；演示数据各只有一个候选，因此两者均 disabled 且文字保持可读。侧栏文本中服务器、音乐资料库、共享资料库为 0；来源重复同步行和设置页“同步资料”为 0，顶部“刷新资料”恰好一个。
- 布局与退出：关闭行为、外观、播放、封面缓存、音乐来源、Plex 账号六个分组的左右 header/body 高度相同，垂直中心差均为 0；移除重复说明后整个设置页在 `1280×820` 内容区内完整可见且横纵溢出为 0。浅色退出账号为 `rgb(185,72,65)`、深色为 `rgb(238,123,115)` 并保留危险色背景/边框；设置页“退出 Cadilume”或“退出应用”按钮为 0，关闭行为中的“退出程序”仍仅表示主窗口关闭策略。
- 未决项：真实账号多服务器/多 Music Section 时的 Radix 下拉选项切换留在原生 PMS 验收；单候选禁用与当前 Web 组件结构已通过。进入 P6，只复核艺术家详情初稿和分页链路。

### P6 — 2026-07-30 艺术家详情

- 实现文件：保留现有“专辑 / 歌曲”标签、PMS 排序请求和 50 首分页数据层。Chrome 实测发现首批数据在同一轮状态提交后才挂载 sentinel 时，观察器 effect 依赖不含 `tracks.length`，可能完全没有绑定；`src/App.tsx` 仅补充该依赖。新增 `src/artistTracks.ts`，在不改变 PMS 顺序的前提下按 `ratingKey` 同时过滤跨页和同页重复；新增单元测试。`src/api.ts` 增加仅开发环境使用的 `artist-track-fail-once=N` 一次性失败入口，用于验证后续页原地重试。README 与架构文档同步当前分页边界。
- 自动验证：`pnpm check` 通过；13 个测试文件、90 项测试通过；`git diff --check` 通过。API 测试确认请求参数为 `parentTitleSort:asc,parentIndex:asc,index:asc`、容器起点/大小为 50；新测试确认已有 `[1,2]` 追加 `[2,3,3,4]` 后保持 PMS 顺序且结果为 `[1,2,3,4]`。
- Chrome 1280×820 详情与表格：仅使用 Chrome 插件，无截图。深浅主题下“返回艺术家列表”为 `141×34` 的有边界按钮，头像为 `190×190`，头像/名称区到底部标签间距为 32px；返回后艺术家列表 6 张卡片恢复、详情节点为 0、主滚动归零。专辑/歌曲两个标准 tab 可点击，深色下从“专辑”按 ArrowRight 后“歌曲”获得选中与焦点；首批准确显示 50 行、`aria-rowcount=121`，表头六列为序号、专辑封面、标题、歌手、专辑、时长，991px 表格横向溢出为 0。
- Chrome 1280×820 交互与分页：歌曲行键盘 Enter 后保持 `:focus-visible` 与 2px 主题色 outline；真实鼠标 hover 显示播放图标并隐藏序号；点击第 2 行后底栏切到对应歌曲，队列为当前已加载的 50 首。使用 `artist-track-preview=120&artist-track-fail-once=50`，滚到首批末尾后准确保留 50 行并显示“后续歌曲加载失败 / 重试”；点击重试后为 100 行，再滚到末尾完成最后 20 行。最终 120 行、唯一行 120、`aria-rowindex=2…121`、专辑顺序 `Night Drive 01…12`、sentinel 消失，横纵溢出为 0。两主题控制台 warning/error 为 0。
- 未决项：真实 PMS 的 120+ 首艺术家、真实重复 metadata 和网络中断仍需原生账号回归；本轮 Web 与单元测试已闭合观察器挂载、同页/跨页去重和失败页重试。P0–P6 完成，进入统一验证、记忆 checkpoint 与本地提交。

### 统一验证 — 2026-07-30

- 自动验证：`git diff --check`、`pnpm check`、`pnpm build`、`cargo fmt --manifest-path src-tauri/Cargo.toml --check` 全部通过；`pnpm test` 为 13 个测试文件 / 93 项通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 38 项通过；全新临时 `CARGO_TARGET_DIR` 的 `pnpm tauri build --no-bundle` 成功，临时目录已清理，项目内无 `.app` / `.dmg` 产物。
- Chrome 收口：复用 Chrome 插件在 `1280×820` 下完成新增 P4 深浅主题、创建对话框、折叠/展开、账号 hover/focus、连接四态 tooltip 及控制台检查；warning/error 均为 0。未构建 DMG，未 push。
- 记忆 checkpoint：已评估项目五份 memory；新增项目 `ACTIVE` 的 Plex 写入边界、`LEARNINGS` 的创建/Tooltip/StrictMode 焦点经验和 `ERRORS` 的安全清理记录；`PROFILE`、`FEATURE_REQUESTS` 无需变更。父级 `AI/.codex/memories` 与全局 `~/.codex/memories` 均评估为无需更新。
- 状态：P0–P6（含 P4 追加）与统一验证完成，下一步仅本地 Conventional Commit；不构建 DMG、不 push。
