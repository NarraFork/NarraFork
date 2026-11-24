---
id: frontend.components-theme
title: 通用组件与主题
summary: 全局 Provider、Mantine 主题、设计令牌与样式加载顺序、OLED/调色板/壁纸/插件主题、外观偏好同步、令牌检查。
anchors:
  - frontend/components/CoreProviders.tsx
  - frontend/components/common/
  - frontend/styles/
  - frontend/lib/mantine-theme.ts
  - frontend/lib/palette-apply.ts
  - frontend/hooks/useAuthenticatedAppearance.ts
  - scripts/check-style-tokens.ts
  - frontend/components/ThemeSwitcher.tsx
  - frontend/components/settings/AppearanceSection.tsx
  - frontend/components/settings/AppearanceSyncControl.tsx
  - frontend/components/settings/BackgroundCard.tsx
  - frontend/components/settings/ThemeColorCard.tsx
  - frontend/hooks/useAppearanceSync.ts
  - frontend/hooks/usePaletteChoice.ts
  - frontend/hooks/usePluginThemes.ts
  - frontend/hooks/useSharedComputedColorScheme.ts
  - frontend/lib/appearance-preference-store.ts
  - frontend/lib/palette-presets.ts
  - frontend/lib/plugin-theme-pref-store.ts
  - frontend/lib/theme-color-sync.ts
  - frontend/routes/settings/appearance.tsx
  - server/lib/plugins/theme-compiler.ts
  - shared/appearance-preferences.ts
  - frontend/lib/app-background.ts
  - frontend/lib/wallpaper-layer.ts
  - frontend/lib/wallpaper-store.ts
  - frontend/hooks/useAppBackground.ts
keywords:
  - MantineProvider
  - mantineTheme
  - 设计令牌
  - tokens.css
  - oled.css
  - narrafork_oled
  - data-oled
  - data-plugin-theme
  - 外观
  - 调色板
  - 强调色
  - 壁纸
  - narrafork_background
  - useLocalPref
  - appearancePreferences
  - check:tokens
  - ThemeSwitcher
  - colorScheme
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 通用组件与主题

UI 基于 Mantine v9，颜色统一从设计令牌派生。`components/common/` 放跨领域的小组件，`styles/` 放全局 CSS。

## 关键规则
- `CoreProviders.tsx` 依次包裹 `MantineProvider`（`defaultColorScheme="auto"`，主题 `lib/mantine-theme.ts:mantineTheme`，主色 indigo，默认圆角 sm，并带自定义 `slate` 色板）、`DatesProvider`（周一为一周起点）、`ConfirmDialogProvider`、`ImageViewerProvider`、`AppNotifications`、`QueryClientProvider`。用户选的强调色经 `usePaletteChoice` 覆盖 indigo 色阶。
- 令牌方向固定：调色板十六进制 → `--mantine-*` → 语义令牌 `--nf-*` → 组件（`styles/tokens.css` 文件头）。语义令牌读 `--mantine-*` 而不是直指调色板，这样 OLED、调色板预设、插件主题改写 `--mantine-*` 时能传导到所有界面。
- CSS 导入顺序在 `main.tsx` 里有意义：Mantine 样式 → `tokens.css` → `oled.css` 等；`tokens.css` 必须在 `oled.css` 之前，否则会盖掉它对 `--mantine-color-body` 的覆盖。
- OLED：`useAuthenticatedAppearance` 经 `useLocalPref("narrafork_oled")` 读取，在 `<html>` 上设 `data-oled="true"`，`styles/oled.css` 仅在暗色且该属性存在时把暗色阶改成纯黑。取值走 `lib/appearance-preference-store.ts:AppearancePreferenceStore`（`appearanceStore`），不是直接读 `localStorage`：
  - 登录后的值保存在带命名空间和用户 ID 的存储键下（`narrafork_appearance_sync_v1:<命名空间>:<userId>`，命名空间来自 `getAppBase`）。
  - 默认只存本机（`shared/appearance-preferences.ts` 里 `local(false, "narrafork_oled")`，`defaultSync: false`）；该项启用同步后，值随账号偏好的 `appearancePreferences` 读写，并能从服务端拉到别的设备。
  - 旧的裸键 `narrafork_oled` 仍被镜像写入，匿名（未识别用户）与旧数据迁移时读它。
- 调色板：`lib/palette-apply.ts` 通过注入样式表（不是行内样式）写暗色阶，限定在非 OLED 暗色下，以免行内变量压过 OLED 和插件主题；选择了插件主题（`data-plugin-theme`）时调色板覆盖停用。
- 字面颜色受 CI 检查：`bun run check:tokens`（`scripts/check-style-tokens.ts`）在 `frontend/` 里发现不在允许清单内的十六进制/颜色字面量就失败；允许项（终端配色、Monaco 主题、品牌色选择、PWA manifest 等）逐条写明理由。`var(--x, #fallback)` 形式放行；`fontSize` 数字目前只警告。
- 错误边界与载入占位：`common/RouteChunkErrorBoundary.tsx`（路由 chunk 加载失败）、`common/LazyOverlayBoundary.tsx`、`common/I18nNamespaceGate.tsx`。

- 壁纸：`lib/app-background.ts` 把图片放在 `<body>` 上并叠一层 scrim，外壳两个表面变量改成 `color-mix()` 让面板半透明。仅接受 `http:`/`https:` 的 URL（长度 ≤ `MAX_URL_LENGTH`=2048，含引号、反斜杠、换行即判畸形）；窗格不透明度下限 `MIN_OPACITY`=55，scrim 夹在 0–90，模糊夹在 0–24px。选择存本机 `localStorage["narrafork_background"]`；上传文件走 `wallpaper-store.ts` 存 IndexedDB（库 `narrafork-wallpaper`，只留一张，取不到存储时当作没有文件），`wallpaper-layer.ts` 负责 `#nf-wallpaper` 图层（`<img referrerPolicy="no-referrer">`，绕开防盗链）。`CoreProviders` 里调用 `useAppBackground()` 订阅，`main.tsx` 首帧前 `applyInitialBackground`。
- 插件主题：服务端 `server/lib/plugins/theme-compiler.ts:compileThemeContribution` 把白名单令牌编译成 `[data-plugin-theme="<pluginId>__<themeId>"]` 下的 CSS，单个主题超过 `MAX_COMPILED_THEME_CSS_LENGTH`（196608）整个丢弃而不是截断；前端 `usePluginThemes` 管可用列表与启用，所选键存在 `lib/plugin-theme-pref-store.ts`（独立小模块，让 `main.tsx` 首帧读取时不拖入整个 `lib/api`）。
- `useSharedComputedColorScheme` 让所有订阅者共用一个 `prefers-color-scheme` 的 `matchMedia`；`lib/theme-color-sync.ts` 让 `<meta name="theme-color">` 跟随外壳头部的实际背景色（WCO 窗口按钮、移动端状态栏用它着色）。
- 外观设置页 `routes/settings/appearance.tsx` + `AppearanceSection`：每个偏好行由 `AppearanceSyncControl.tsx:AppearancePreferenceRow` 包装，决定该项只存本机还是随账号同步；偏好清单、默认值与范围见 `shared/appearance-preferences.ts:APPEARANCE_PREFERENCES`（`local(...)` 项 `defaultSync:false`，`account(...)` 项 `defaultSync:true`，`customizable:false` 的项同步策略固定为各自的 `defaultSync`，`appearanceStore.setSynced` 对它直接返回，如全屏、屏幕常亮）。排版滑块的取值范围来自排版引擎，见[前端排版引擎](layout-engine.md)。

## 从哪读起
- `frontend/components/common/`：`DirectoryPicker`/`PathInput`（目录选择）、`ConfirmDialogProvider`、`ImageViewer`、`TruncatedText`、`CopyButton`、`error-toast.tsx`。
- `frontend/styles/`：令牌、OLED、滚动条、安全区、窗口控件覆盖层（`wco.css`）、流式卡片 shimmer 等。
- `frontend/lib/palette-presets.ts`、`frontend/hooks/usePaletteChoice.ts`。

## 改它时
- 加一个外观偏好：在 `shared/appearance-preferences.ts:APPEARANCE_PREFERENCES` 登记（选 `local` 或 `account`；`account` 项的 `field` 要与用户偏好字段同名，`splitPatch` 按它把写入分流到账号），再在 `AppearanceSection`/`routes/settings/appearance.tsx` 里用 `AppearancePreferenceRow` 包装；读取走 `useLocalPref`/`appearanceStore`，不要直接读 `localStorage`。`lib/appearance-preference-store.test.ts` 覆盖作用域、同步与多标签竞态。
- 加颜色：写成 `--nf-*`/`--mantine-*` 令牌，不要在 `frontend/` 里写十六进制字面量，否则 `bun run check:tokens` 失败；确属例外要进 `scripts/check-style-tokens.ts` 的允许清单并写理由。
- 改 CSS 导入顺序（`main.tsx`）前先确认 `tokens.css` 仍在 `oled.css` 之前。`lib/mantine-theme.test.tsx` 断言 Modal 根与 Menu 下拉带 `nf-overlay-layer`。
- 改插件主题编译：它是安全边界，值要在 `theme-compiler.ts` 里重新校验；前端侧的 `data-plugin-theme` 选择器与服务端 `buildThemeKey` 必须一致。

## 相关
- [前端通用工具](utils.md)：格式化、剪贴板、安全区、品牌等无业务归属的小工具。
- [前端排版引擎](layout-engine.md)：排版（字号、字距、行高）如何同时驱动测量与绘制。
- [应用框架与路由](shell-routing.md)
- [会话界面](narrator-ui/index.md)
