---
id: frontend.components-theme
title: 通用组件与主题
summary: 全局 Provider、Mantine 主题、设计令牌与样式加载顺序、OLED/调色板/插件主题、令牌检查。
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
  - frontend/components/settings/BrandingSection.tsx
  - frontend/components/settings/ThemeColorCard.tsx
  - frontend/hooks/useAppearanceSync.ts
  - frontend/hooks/usePaletteChoice.ts
  - frontend/hooks/usePluginThemes.ts
  - frontend/hooks/useSharedComputedColorScheme.ts
  - frontend/lib/appearance-preference-store.ts
  - frontend/lib/favicon.ts
  - frontend/lib/palette-presets.ts
  - frontend/lib/plugin-theme-pref-store.ts
  - frontend/lib/theme-color-sync.ts
  - frontend/lib/typography-css-vars.ts
  - frontend/routes/settings/appearance.tsx
  - server/lib/plugins/theme-compiler.ts
  - shared/appearance-preferences.ts
  - shared/identicon.ts
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

## 从哪读起
- `frontend/components/common/`：`DirectoryPicker`/`PathInput`（目录选择）、`ConfirmDialogProvider`、`ImageViewer`、`TruncatedText`、`CopyButton`、`error-toast.tsx`。
- `frontend/styles/`：令牌、OLED、滚动条、安全区、窗口控件覆盖层（`wco.css`）、流式卡片 shimmer 等。
- `frontend/lib/palette-presets.ts`、`frontend/hooks/usePaletteChoice.ts`。

## 相关
- [应用框架与路由](shell-routing.md)
- [会话界面](narrator-ui/index.md)
