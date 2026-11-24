---
id: frontend.plugin-host
title: 插件界面宿主
summary: 插件面板在沙箱 iframe 里运行、与宿主经 MessagePort RPC 通信；贡献快照存储、资产外壳与 CSP、共享 React/Mantine 运行时、浮层与主题。
anchors:
  - frontend/plugin-runtime/
  - frontend/components/plugins/
  - frontend/build/plugin-ui-runtime.ts
  - frontend/App.tsx
  - frontend/hooks/usePluginContributions.ts
  - frontend/hooks/usePluginOverlayVisibility.ts
keywords:
  - narrafork.ui/1
  - PluginDockPanel
  - PluginOverlayHost
  - pluginContributionStore
  - plugin_contributions_changed
  - /plugins/ui/sessions
  - /plugins/ui/contributions
  - host-react
  - __nfPluginRuntime
  - PLUGIN_UI_RUNTIME_VERSION
  - MessageChannel
  - asset-shell
  - createPluginAssetShell
  - PluginThemeInjector
  - usePluginOverlayVisibility
  - hidden_plugin_overlays
  - 插件面板
  - 插件浮层
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 插件界面宿主

插件贡献的视图由前端放进沙箱 iframe 里渲染：宿主持有“有哪些贡献”的权威快照，为每个面板建一条会话，用 MessageChannel 上的 JSON-RPC 与 iframe 通信。服务端的插件生命周期与权限见[插件运行时](../automation/plugins/runtime.md)。

## 关键规则
- 隔离：iframe 为 `sandbox="allow-scripts"`、无 `allow-same-origin`（`PluginDockPanel.tsx`），内容走 `srcDoc`。`asset-shell.ts:createPluginAssetShell` 生成的外壳带 CSP：`default-src 'none'`，脚本只许 nonce 与资产源，`connect-src 'none'`，禁嵌套 frame/worker；资产 URL 必须同源 http(s)（`isAllowedPluginAssetUrl`）。CSP 里的 `sandbox` 在 meta 中无效，隔离只靠 iframe 属性。
- 握手：`runtime.ts` 的会话控制器在 iframe `onLoad` 时建 `MessageChannel`，把 port2 连同 `{nonce, pluginId, contributionId, panelInstanceId}` 用 `postMessage` 交给 iframe；`handshake` 请求里 nonce 与三个标识必须与会话一致，否则回 `INCOMPATIBLE` 并置崩溃；握手超时默认 10s（`PLUGIN_UI_DEFAULT_TIMEOUT_MS`）。
- 协议 `narrafork.ui/1`（`protocol.ts`）：消息经 zod 严格校验；负载上限（`runtime.ts:assertPayload`）请求 5 MiB、响应 1 MiB，面板参数里的 `viewState` 上限 16 KiB；JSON 值深度 ≤32，禁 `__proto__/prototype/constructor` 键。方法分两类：宿主本地（`context.*`、`panel.*`、`notifications.show`、`ui.navigate`、`overlay.setBounds` 等，宿主直接处理）和后端转发（`queries/commands/events/storage/config/secrets/diagnostics`，经 `session-client.ts` 走 `/plugins/ui/sessions/<id>/request`）。不在两张表里的方法不被接受。
- 会话与资产：`session-client.ts` 向 `POST /plugins/ui/sessions` 取 `sessionId`、`connectNonce`、`sessionToken`、`assetToken`；资产 URL 形如 `/plugins/ui/<pluginId>/<version>/<hash>/asset/<sessionId>/<assetToken>/<path>`。
- 贡献快照：`PluginContributionStore.ts:pluginContributionStore` 是宿主自有的外部存储（上限 `PLUGIN_CONTRIBUTION_LIMIT` = 200），`registry.ts:syncPluginUiContributions` 从 `/plugins/ui/contributions` 整体替换；iframe 无法改它。`App.tsx:PluginRuntimeShell` 在收到 WS 事件 `plugin_contributions_changed`、以及 WS 重连时让快照失效重取；找不到贡献按“缺失”状态处理而不是通用错误。
- 共享运行时：只有声明 `runtime: "host-react"` 的视图才加载 `/plugin-runtime/vendor.js|css`（`runtime.ts` 里 `usesHostRuntime`）；`plugin-runtime/vendor.ts` 把 React、ReactDOM client、JSX runtime、`@mantine/core`、`@mantine/hooks` 挂到 `globalThis.__nfPluginRuntime`（冻结，带 `PLUGIN_UI_RUNTIME_VERSION`）；这两个文件名不带哈希，靠 `no-cache` 重验证（`paths.ts`）。`@mantine/notifications` 不暴露，通知走宿主。
- 主题与语言：`host-tokens.ts` 从实时 `<html>` 读计算后的颜色令牌（所以 OLED、插件主题自动传导）注入 iframe；`PluginThemeInjector.tsx` 是另一件事——把服务端编译的插件主题 CSS 注入宿主文档，用 `data-plugin-theme` 切换。
- 面板挂载点：`plugin-dockview-components.ts` 以组件键 `plugin` 注册 `PluginDockPanel`；绑定范围 `host-surface` 的取值是 focus、workspace、director、settings、provider-settings、overlay（`protocol.ts:HOST_SURFACE_VALUES`）。
- 浮层：`PluginOverlayHost.tsx` 把 `overlay` 视图放在全视口、`pointer-events: none` 的 iframe 里，视图用 `overlay.setBounds` 声明一块可交互矩形，宿主在该处放透明命中区转发指针；宿主始终提供“隐藏”按钮，是否显示是每用户偏好（`usePluginOverlayVisibility`）。

## 从哪读起
- `frontend/components/plugins/PluginDockPanel.tsx`：面板视图与 iframe。
- `frontend/components/plugins/runtime.ts`、`session-client.ts`、`protocol.ts`：会话、后端请求、协议。
- `frontend/components/plugins/PluginUiRuntimeProvider.tsx`：把宿主能力（导航、通知、上下文）接给会话。
- `frontend/components/plugins/asset-shell.ts`：外壳 HTML 与 CSP。

## 改它时
- 加一个宿主方法（iframe 可调）：在 `protocol.ts` 的方法表里登记并给 zod schema，宿主本地的在 `runtime.ts` 处理，后端转发的走 `session-client.ts`；不在两张表里的方法不被接受。`protocol.test.ts`、`runtime.test.ts`、`session-client.test.ts` 覆盖负载上限与握手。
- 改共享运行时暴露的模块（React、Mantine）：同时改 `plugin-runtime/contract.ts:PLUGIN_UI_SHARED_MODULES` 与 `vendor.ts`，不兼容变化要递增 `PLUGIN_UI_RUNTIME_VERSION`——`build/plugin-ui-bun.ts` 生成的插件产物在版本不符时直接抛错；`tests/frontend/build/plugin-ui-runtime.test.ts`、`plugin-ui-bun.test.ts` 覆盖构建。
- 改 iframe 外壳或 CSP：`asset-shell.test.ts`、`asset-shell-presentation.test.ts`；`sandbox` 不得加 `allow-same-origin`。
- 新增贡献槽位（`host-surface`）：改 `protocol.ts:HOST_SURFACE_VALUES`，`window/panel-window.ts` 也引用它，窗口描述符会随之接受或拒绝。

## 相关
- [插件运行时](../automation/plugins/runtime.md)、[插件贡献](../automation/plugins/contributions.md)：服务端一侧。
- [面板与布局](panels.md)：dockview 里的 `plugin` 面板。
- [PWA 与远程前端](pwa-remote.md)：远程构建不含插件宿主（用 `remote/plugin-boundary.tsx` 的空实现替换）。
- [通用组件与主题](components-theme.md)
