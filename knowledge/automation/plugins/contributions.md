---
id: automation.plugins.contributions
title: 插件贡献点
summary: 插件提供的工具、命令、搜索源、事件、界面与 MCP 适配。
anchors:
  - server/services/plugin-tool-registry.ts
  - server/services/plugin-command-registry.ts
  - server/services/plugin-search-registry.ts
  - server/services/plugin-contribution-registry.ts
  - server/services/plugin-contribution-coordinator.ts
  - server/services/plugin-agent-tool-bridge.ts
  - server/services/plugin-ui-host.ts
  - server/services/plugin-mcp-adapter.ts
  - server/routes/plugin-ui.ts
  - server/lib/plugins/manifest.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 插件贡献点

清单的 `contributes` 声明插件向宿主提供什么；`PluginContributionCoordinator` 在目录刷新时按插件的生命周期状态，把各类贡献同步进对应的注册表。每类至多 200 项，主题至多 50 项（`manifest.ts:contributesSchema`）。

## 关键规则
- 种类：`providers、searchProviders、tools、commands、events、views、themes、configuration`。提供商见 [提供商插件](providers.md)。`activationEvents` 支持 `onStartup/onCommand/onView/onProvider/onTool/onEvent/onSchedule`，由 `ActivationIndex` 建立“事件 → 目标”索引（`plugin-contribution-registry.ts`）。
- 工具（`PluginToolRegistry`）：清单里 `execution` 为 `server` 或 `ui`；只有 `server` 工具会被 `PluginAgentToolBridge` 作为名为 `plugin__<插件>__<贡献>` 的 Agent 工具暴露（点号折叠），首次调用才激活插件。调用走 RPC `tools.invoke`，默认 30s、最长 5 分钟，工具 schema 校验有 256KiB/深度 24/5000 节点的上限，调用经能力代理授权（`DEFAULT_AUTHORIZATION_CAPABILITY`）。`allowBackground` 默认 false。
- 命令（`PluginCommandRegistry`）：`handler: "server"` 的命令才派发给插件后端，默认 30s、最长 120s，输入 ≤256KiB、输出 ≤2MiB；`handler: "ui"` 由插件界面自己处理。创建界面会话本身不启动进程，视图要懒启动后端须声明对应的 `onView:<视图>` 激活事件，否则 iframe 能加载但后端调用面对的是未激活运行时（`routes/plugin-ui.ts:activationEventForView`）。
- 搜索源（`PluginSearchRegistry`）：必须挂在某个提供商贡献下（`providerId`），配置与凭证来自该提供商；`isUsable()` 只读已加载状态（生命周期、配置必填项 `requiresConfig`），不激活插件、不发 RPC，所以“可用”不代表凭证有效，失败后搜索路由会落到下一个渠道；`execute()` 不经能力代理。
- 事件：`events[].topic` 必须是宿主公开主题（`PUBLIC_EVENT_TOPICS`，如 `narrafork.narrator.lifecycle`、`narrafork.project.changed`），`allowBackground` 与 `maxRatePerSecond`（1–10000）可选。
- 界面：`views` 可挂的位置为 `workspace、director、focus、settings、provider-settings、overlay`（`VIEW_SURFACES`），作用域 `workspace/narrator/project/global`，`overlay` 只能 global。视图在 iframe 里渲染，页面响应头 CSP 含 `sandbox allow-scripts`、`connect-src 'none'`、`default-src 'none'`（`routes/plugin-ui.ts` 的 shell 路由）；界面经会话化 RPC（`/ui/sessions/...`）调宿主，请求 ≤5MiB、响应 ≤1MiB、超时 10s（`plugin-ui-host.ts`）。主题通过 `/ui/themes` 下发。
- MCP 适配器（`PluginMcpAdapter`）：在平台服务里构造，宿主只在插件生命周期事件里调用它的 `markUnavailable/markAvailable/toolListChanged`；除此之外没有找到调用方，它是否已向 Agent 暴露 MCP 工具：未核实。
- 插件自己的定时调度（`plugin-scheduler.ts`：cron/interval/once，最短间隔 60s）与宿主[定时任务](../scheduled.md)无关。

## 从哪读起
- `server/services/plugin-contribution-coordinator.ts`：目录刷新到各注册表的同步。
- `server/services/plugin-tool-registry.ts`、`plugin-agent-tool-bridge.ts`：工具从声明到 Agent。
- `server/routes/plugin-ui.ts`：界面会话、资源与主题路由。

## 相关
- [插件系统](index.md)
- [插件授权与密钥](permissions-secrets.md)
