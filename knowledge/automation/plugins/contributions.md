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
  - server/services/integration-event-dispatcher.ts
  - server/services/plugin-event-gateway.ts
  - server/services/plugin-public-api.ts
  - server/services/plugin-search-source.ts
  - server/services/plugin-ui-assets.ts
  - server/services/plugin-ui-session.ts
  - server/services/user-plugin-theme-service.ts
keywords:
  - contributes
  - plugin__
  - tools.invoke
  - activationEvents
  - PUBLIC_EVENT_TOPICS
  - narrafork.narrator.lifecycle
  - /ui/sessions
  - /ui/themes
  - user_plugin_themes
  - plugin-ui
  - VIEW_SURFACES
  - searchProviders
  - PluginContributionCoordinator
  - 插件工具
  - 插件主题
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

- 事件网关（`plugin-event-gateway.ts`）：把宿主内部事件按显式白名单映射成公开事件（一条内部事件可映射为零条、一条或多条），交给共享的 `IntegrationEventDispatcher`（`integration-event-dispatcher.ts` 把它接到审计与授权失效监听）；每个订阅队列默认 100 条/256KiB，硬上限 1000 条/2MiB，订阅速率默认 100/s、硬上限 1000/s，最多 256 个订阅、每次订阅最多 20 个主题，单条事件 ≤256KiB；键名为 `contentJson/rawDump/toolInput/toolOutput/input/output/jwt/log/stderr/stdout/reasoning` 等的字段会被剔除，值里带 `jwt/bearer/token/secret/password/authorization` 赋值形式的会被过滤（`sanitizeJsonValue`、`SENSITIVE_VALUE`）。
- 公开 API 适配（`plugin-public-api.ts`）：插件命令/查询能触达的宿主操作（建叙述者、删叙述者、中断、读项目/叙述者摘要、大纲任务读取与块命令、更新叙述者画像等）；摘要是有界投影，不含 `systemPrompt`、`cwd` 与原始 JSON 列；默认查询 15s、命令 30s、请求 256KiB、响应 1MiB；宿主没有对应适配器时返回 `HOST_UNAVAILABLE`。
- 搜索源适配（`plugin-search-source.ts`）：把 `PluginSearchRegistry` 包成通用搜索层的渠道来源，`listChannels()` 必须是同步的注册表遍历，这样 `lib/search` 不依赖插件平台。
- 界面会话与资源：`plugin-ui-session.ts` 的会话令牌 32 字节、nonce 16 字节、默认 10 分钟过期、最多 1000 个会话；`plugin-ui-assets.ts` 提供界面资源（单资源默认 ≤10MiB，shell 页 ≤64KiB，拒绝符号链接逃逸）。
- 主题：主题包全局安装，但“启用哪些主题”按用户隔离，存表 `user_plugin_themes`（`user-plugin-theme-service.ts`，薄索引 CRUD）；`GET /ui/themes` 只下发当前用户已启用的主题 CSS，最多 200 项。

## 从哪读起
- `server/services/plugin-contribution-coordinator.ts`：目录刷新到各注册表的同步。
- `server/services/plugin-tool-registry.ts`、`plugin-agent-tool-bridge.ts`：工具从声明到 Agent。
- `server/routes/plugin-ui.ts`：界面会话、资源与主题路由。

## 改它时
- 加一种贡献类型：`lib/plugins/manifest.ts:contributesSchema`（zod `.strict()`，每类 ≤200 项）+ `plugin-contribution-registry.ts` 的激活事件索引 + 新注册表 + `PluginContributionCoordinator` 同步 + 生命周期撤销层（`plugin-lifecycle-revoke-coordinator.ts`）一起改，漏撤销层会让停用的插件继续被调用。
- 加一个公开事件主题：`PUBLIC_EVENT_TOPICS`、`plugin-event-gateway.ts` 的内部事件映射白名单和清洗规则；`plugin-event-gateway-scope.test.ts` 断言作用域。
- 改界面会话/资源限额：`plugin-ui-session.test.ts`、`plugin-ui-assets.test.ts`、`plugin-ui-host.test.ts`、`routes/__tests__/plugin-ui.test.ts` 会失败；iframe 的 CSP（`sandbox allow-scripts`、`connect-src 'none'`）是安全不变量。
- 工具暴露为 Agent 工具的命名 `plugin__<插件>__<贡献>`、首次调用才激活插件，改命名要同看 `plugin-agent-tool-bridge.ts` 与权限分类；`plugin-tool-activation-diagnostics.test.ts` 守着激活诊断。
- 前端宿主侧见 [插件宿主](../../frontend/plugin-host.md)。

## 相关
- [插件系统](index.md)
- [插件授权与密钥](permissions-secrets.md)
