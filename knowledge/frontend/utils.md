---
id: frontend.utils
title: 前端通用工具
summary: 没有业务归属的前端小工具：日期数字格式化、剪贴板、文件下载、安全区与视口、窗口控件覆盖、z-index 层级、品牌（实例名与图标色）。
anchors:
  - frontend/lib/session-store.ts
  - frontend/hooks/useBranding.ts
  - frontend/hooks/useClipboard.ts
  - frontend/hooks/useLocalPref.ts
  - frontend/hooks/useMobileDrawerHistory.ts
  - frontend/hooks/useMobileViewport.ts
  - frontend/hooks/usePersistedState.ts
  - frontend/hooks/useSwipeMenu.ts
  - frontend/hooks/useWakeLock.ts
  - frontend/lib/bounded-blob.ts
  - frontend/lib/branding.ts
  - frontend/lib/favicon.ts
  - frontend/components/settings/BrandingSection.tsx
  - shared/branding.ts
  - server/routes/branding.ts
  - frontend/lib/clipboard.ts
  - frontend/lib/compact-number.ts
  - frontend/lib/dnd-modifiers.ts
  - frontend/lib/dom-text.ts
  - frontend/lib/file-download.ts
  - frontend/lib/format.ts
  - frontend/lib/intl-format.ts
  - frontend/lib/local-origin.ts
  - frontend/lib/pixi-hmr.ts
  - frontend/lib/relative-time.ts
  - frontend/lib/responsive.ts
  - frontend/lib/safe-area.ts
  - frontend/lib/shared-context.ts
  - frontend/lib/shared-inflight.ts
  - frontend/lib/status-registry.ts
  - frontend/lib/toast.ts
  - frontend/lib/url.ts
  - frontend/lib/use-match-media.ts
  - frontend/lib/wco-mobile-titlebar.browser-fixture.tsx
  - frontend/lib/wco-overlay.browser-fixture.tsx
  - frontend/lib/wco-titlebar.ts
  - frontend/lib/wco.ts
  - frontend/lib/z-index.ts
keywords:
  - copyTextToClipboard
  - useClipboard
  - formatSmartTime
  - formatLocaleNumber
  - resolveIntlLocale
  - formatCompactNumber
  - safe-area
  - env(safe-area-inset-bottom)
  - --app-viewport-bottom
  - installAppViewportTracking
  - Window Controls Overlay
  - data-nf-wco
  - WCO
  - Z 层级
  - z-index
  - useLocalPref
  - usePersistedState
  - useMobileViewport
  - useMobileDrawerHistory
  - useSwipeMenu
  - useWakeLock
  - readBoundedBlob
  - RESOURCE_TOO_LARGE
  - saveBlobAsFile
  - 下载票据
  - /api/branding
  - narrafork_brand_name
  - 实例名
  - 图标颜色
  - favicon 提醒
  - status-registry
  - createSharedContext
  - createSharedInflight
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 前端通用工具

`frontend/lib/` 与 `frontend/hooks/` 里不属于某个业务功能的小模块。按用途分组如下；主题、令牌、样式、Provider 在[通用组件与主题](components-theme.md)，不在这里。

## 关键规则
- 剪贴板：文本复制只能走 `lib/clipboard.ts:copyTextToClipboard`（有 Clipboard API 且处于安全上下文才用它，失败或明文 HTTP 时退回临时 `input/textarea` + `execCommand("copy")`，并尽力恢复原焦点与选区）。`hooks/useClipboard.ts` 是它的 React 包装（默认 2000ms 复位 `copied`）。`lib/clipboard-usage.guard.test.ts` 扫整个 `frontend/`：裸 `navigator.clipboard.writeText`、`@mantine/core` 的 `CopyButton`、`@mantine/hooks` 的 `useClipboard` 都会失败；仅 `lib/clipboard.ts`、`narrator/content/document-clipboard.ts`、`narrator/composer/image-clipboard.ts`、`VListHarness.tsx` 在允许清单里。
- 格式化：日期、数字一律经 `lib/intl-format.ts`（`resolveIntlLocale` 依次取显式参数、`<html lang>`、`navigator.language`，最后回退 `DEFAULT_LOCALE`）；`lib/format.ts` 与 `compact-number.ts`、`relative-time.ts` 建在它上面。不带 locale 的 `toLocaleString()` 等会被 `bun run i18n:check` 拒绝（见[国际化](i18n.md)）。`formatRelativeTime` 输出 `<1m/5m/3h/2d`；`formatSmartTime` 24 小时内相对、更早用 `YYYY-MM-DD HH:mm`。`relativeTime`（相对时间，带 `ago`/`in`）与 `formatCountdown`（到未来时刻的倒计时，过去或无效返回 `undefined`）在 `relative-time.ts`，与 `format.ts` 的同名风格函数并存，输出不同。
- 文件下载（`lib/file-download.ts`）：已有 Blob 用 `saveBlobAsFile`/`triggerBlobDownload`（合成 `<a download>`，页面不跳转）；需要凭据的大文件走“票据”：在点击回合内、任何 `await` 之前 `openDownloadTab`，拿到票据后 `navigateDownloadTab` 指向 `fsDownloadTicketUrl`，由服务端 `Content-Disposition: attachment` 触发保存，失败的票据停留为 HTML 而不是被存成同名文件。`lib/bounded-blob.ts:readBoundedBlob` 按字节流式读取，超过 `maxBytes`（默认 8 MiB，先看 `content-length`）抛 `RESOURCE_TOO_LARGE`，不先读完再判大小。
- 安全区与视口（`lib/safe-area.ts`，约 700 行）：导出 `env(safe-area-inset-*)` 表达式、外壳高度/内边距常量和抽屉头体样式；`installAppViewportTracking` 把可见底边写到 `--app-viewport-bottom`（以 `100dvh` 为无 JS 回退），`installAuthenticatedAppShellRootLock` 按挂载计数在 `<html>` 上标 `data-nf-authenticated-app-shell` 并装 iOS 滚到顶部桥（`lib/ios-scroll-to-top.ts`）。键盘遮挡量变量 `--app-keyboard-occlusion` 只在 `styles/safe-area.css` 里被使用，没有 JS 消费者。
- 响应式：`lib/responsive.ts` 把 Mantine `sm` 断点（48em）固化为 `MOBILE_VIEWPORT_MEDIA_QUERY`，`hooks/useMobileViewport.ts` 对每个 window 只建一个 `matchMedia` 监听并读实时值；`lib/use-match-media.ts` 是通用版，`TOUCH_POINTER_MEDIA_QUERY` 判触屏。`hooks/useMobileDrawerHistory.ts` 给手机抽屉压一条同 URL 历史记录，让系统返回键先关抽屉；`hooks/useSwipeMenu.ts` 是滑出菜单与多选手势（体量 640 行，有 `useSwipeMenu.*.test.ts` 三个守卫）。
- Window Controls Overlay：`lib/wco.ts` 在 `<html>` 上维护 `data-nf-wco` 并判断窗口按钮在左或右（`getTitlebarAreaRect().x > 0` 为左），`visible !== true` 时不加属性；`lib/wco-titlebar.ts:useWcoTitlebarRows` 让页面自己的顶行当标题栏，给触及根节点上沿的头部打 `data-nf-titlebar-row/-end/-start` 标记，每帧至多重算一次。样式在 `styles/wco.css`。
- 层级：全局浮层的 z-index 只能取 `lib/z-index.ts:Z` 的语义档位（`dropdown` 1000 … `modal` 5000、`toast` 6000、`imageViewer` 7000、`dragGhost` 8000、`criticalOverlay` 9000，后两档 `criticalModal` 9001 当前没有消费者）；组件内部用 `isolation: isolate` + 小数值，不使用这些档位。
- 本机偏好：`hooks/useLocalPref.ts` 是布尔/数字偏好的统一入口（键集合在文件头 `Key`/`NumberKey` 联合里，取值经 `appearanceStore`，见[通用组件与主题](components-theme.md)）；`hooks/usePersistedState.ts` 是只存 `"true"/"false"` 的 `useState`，读写 `localStorage` 失败时静默用默认值；`hooks/useWakeLock.ts` 在 `enabled` 时申请屏幕常亮，页面重新可见时再申请，不支持则空操作。
- 并发与上下文：`lib/shared-inflight.ts:createSharedInflight` 只合并仍在进行的读（`fresh: true` 不加入已有的读；所有读者都取消后才中止底层请求并移出表），不缓存已完成结果。`lib/shared-context.ts:createSharedContext` 按字符串键在全局 `Symbol.for("narrafork.shared-react-contexts")` 登记表里取 React Context，避免 Vite 热更新或 chunk 复制造成 Provider 与消费者拿到不同对象。
- 品牌（实例名与图标色）：服务端 `server/routes/branding.ts` 挂在 `/api/branding`，**公开**（登录页和标签标题需要），`GET /` 只返回 `name/iconColor/customized`，`/favicon.svg`、`/icon-192.png`、`/icon-512.png`、`/apple-touch-icon.png` 按图标色重绘并带 `ETag`，取不到时 404 让前端退回静态默认图。归一化与默认值在 `shared/branding.ts`（名称最长 `BRAND_NAME_MAX_LENGTH`=40、控制字符替换为空格；颜色只收 `#rgb`/`#rrggbb` 并展开为 6 位小写，默认 `#4c6ef5`）。前端 `lib/branding.ts:applyBranding` 更新 `document.title`、favicon 与 apple-touch-icon 链接，并把非默认值镜像到 `localStorage["narrafork_brand_name"|"narrafork_brand_icon_color"]` 给 `index.html` 的内联启动脚本在首帧使用；默认值是移除键而不是写入。远程访问构建（`REMOTE_BUILD`）一律用默认品牌。图标 URL 刻意是相对路径，以便跟随反向代理子路径。`lib/favicon.ts` 在标签页失焦时按最高严重度（error > waiting > unread > reflecting）把 favicon 换成带状态色圆点的版本，Logo 色跟品牌，圆点色固定。
- `lib/status-registry.ts` 是叙述者状态/子状态到颜色、图标形状的单一登记表（`getEffectiveNarratorDisplay`），git 面板、导航、叙述者列表都引用它；`lib/constants.ts` 主要放模型选项与聚合模型值的辅助（`FOLLOW_DEFAULT_MODEL="__default__"`、`FOLLOW_SUMMARY_MODEL`、`AGG_MODEL_PREFIX="__agg__:"`、`mergeModels`），按内容更接近模型选择而非通用工具（未核实归属）。
- `lib/pixi-hmr.ts:installPixiCanvasPoolHmrGuard` 修补 PixiJS 画布池在热更新时丢桶的问题；在 `frontend/` 里除它自己的测试外没有找到调用者，`pixi.js` 也没有被 `frontend/` 的组件 import（未核实是否仍有用）。

## 从哪读起
- `frontend/lib/clipboard.ts`、`format.ts`、`intl-format.ts`：最常被引用。
- `frontend/lib/safe-area.ts`、`wco.ts`、`wco-titlebar.ts`、`z-index.ts`：外壳排版相关的全局约定。
- `frontend/lib/branding.ts`、`shared/branding.ts`、`server/routes/branding.ts`：品牌纵线；服务端图标与 manifest 见 [PWA 与远程前端](pwa-remote.md)。
- `frontend/lib/url.ts`（补全协议、取主域名标签）、`local-origin.ts`（浏览器是否与服务端同机，用于“在文件管理器中显示”等只能在服务端机器执行的动作；只认回环主机名，局域网地址不算）、`dom-text.ts`（从 DOM 选区/元素取截断文本预览）、`dnd-modifiers.ts`（dnd-kit 的轴限制）、`toast.ts`（通知可选中文本的 class 常量）。

## 改它时
- 复制文本：用 `copyTextToClipboard`/`useClipboard`，否则 `clipboard-usage.guard.test.ts` 失败；确需绕开（二进制、`ClipboardItem`）要把文件加入该测试的允许清单。
- 改品牌的键名或图标 URL：`index.html` 内联脚本里写了同样的字面量，`tests/frontend/branding-boot.test.ts` 读 `frontend/index.html` 断言两边的 localStorage 键与相对图标路径一致；服务端新增品牌资源要同步 `server/routes/branding.ts` 的 `ASSET_ROUTES` 与 `frontend/src-sw.ts` 的 `BRAND_ASSET_PATHS`。`/api/branding` 是公开接口，响应字段是显式构造的，别改成展开 `settings.branding`。
- 新增可本机存储的开关：在 `useLocalPref.ts` 的 `Key` 联合里加键，同时在 `shared/appearance-preferences.ts` 登记；日期数字新增格式化函数必须带 locale 参数。
- 加可排序列表：用 `dnd-modifiers.ts` 的 `restrictToVerticalAxis`/`restrictToHorizontalAxis`，`lib/dnd-modifiers.guard.test.ts` 扫 `frontend/` 里每个 `<DndContext`，排序策略与轴限制修饰器不配对就失败。
- 动 `safe-area.ts`、`wco*.ts`：有 `safe-area.test.ts`、`wco.test.ts`、`wco-titlebar*.test.ts`、`notifications-safe-area.test.tsx` 与两个 `wco-*.browser.test.ts`（真实浏览器）；加全局浮层先在 `Z` 里选档位。

## 相关
- [通用组件与主题](components-theme.md)
- [国际化](i18n.md)
- [PWA 与远程前端](pwa-remote.md)
