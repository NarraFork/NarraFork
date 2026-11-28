---
id: automation.plugins
title: 插件系统
summary: 插件包、运行时、能力代理、提供商插件、UI 插件。
anchors:
  - server/services/plugin-manager.ts
  - server/services/plugin-catalog.ts
  - server/services/plugin-scheduler.ts
  - server/lib/plugins/manifest.ts
  - server/builtin-plugins/
  - server/routes/plugins.ts
  - server/routes/plugin-ui.ts
  - server/services/plugin-platform-services.ts
  - frontend/components/plugins-admin/
  - frontend/components/settings/PluginOverlaySettings.tsx
  - frontend/hooks/usePluginEventRefresh.ts
  - frontend/hooks/usePlugins.ts
  - frontend/lib/api/plugins.ts
  - frontend/routes/settings/plugins.$pluginId.tsx
  - frontend/routes/settings/plugins.index.tsx
  - frontend/routes/settings/plugins.tsx
keywords:
  - manifest.json
  - PluginManager
  - plugins.enabled
  - NF_PLUGINS_ENABLED
  - PLUGINS_DISABLED
  - /api/plugins
  - apikey-quota
  - 插件管理
  - com.narrafork.apikey-quota
  - 插件覆盖层
  - plugin-event
status: draft
verified_at: 776dbf07e
---
# 插件系统

插件是带 `manifest.json` 的包，作为独立子进程与宿主用 stdio RPC（`narrafork.rpc/1`）通信，通过“贡献点”扩展宿主，每次对宿主的调用都要经能力代理授权。一个插件从落盘到发挥作用分四段，下面各有一个子节点。

## 各部分怎么配合
- 管理入口：`PluginManager`（`plugin-manager.ts`）是总状态机：安装、启停、激活、卸载、重试、授权变更都在它里面按插件 ID 串行；`plugin-platform-services.ts` 把状态库、授权库、运行时监督、各注册表、调度器组装成一张服务图；`PluginCatalog` 扫描已安装与内置包并校验清单；组装时还用 `registerModelListReader("plugin", …)` 登记模型列表读取器，读提供商注册表里该实例的全部缓存模型（含已禁用，不同于 agent 的可用性过滤列表），供 `/providers/:id/models` 这类管理读取使用（`sourcing/model-list-readers.ts`）。
- 清单（`lib/plugins/manifest.ts`，zod `.strict()`）是各部分共同的契约：`engine` 决定怎么运行，`permissions.host` 决定初始授权，`contributes` 决定提供什么。
- 开关：设置 `plugins.enabled`（环境变量 `NF_PLUGINS_ENABLED`/`NARRAFORK_PLUGINS_ENABLED` 优先，默认开）；关闭时安装与生命周期等变更接口返回 503 `PLUGINS_DISABLED`。安装、启停、卸载、授权、提供商配置均要求管理员，列表与详情只要登录（`routes/plugins.ts`）。
- 内置插件：仓库里只有一个，`server/builtin-plugins/apikey-quota`（`com.narrafork.apikey-quota`），只贡献一个 `query-balance` 命令；它走同一套清单与生命周期，只是随应用分发、首次默认启用。
- 数据位置：包与状态在 `<narrafork-home>/plugins`（`packages/`、`current.json`、`state.json`、`permissions.json`、`secrets.json`）。
- 界面插件由 `routes/plugin-ui.ts` 的会话与资源路由承载，细节在贡献点一节；插件自己的调度器（`plugin-scheduler.ts`）与宿主定时任务无关，见[定时任务](../scheduled.md)。

- 前端：`frontend/lib/api/plugins.ts` + `hooks/usePlugins.ts` 调 `/api/plugins` 并缓存；`usePluginEventRefresh.ts` 监听宿主广播的插件生命周期事件（`narrafork:plugin-event`）使查询失效，轮询只作漏事件的兜底；管理页在 `frontend/routes/settings/plugins*.tsx`，组件在 `frontend/components/plugins-admin/`（安装弹窗、授权请求队列与弹窗、配置表单、提供商配置、诊断面板、状态徽标）；`settings/PluginOverlaySettings.tsx` 是普通用户的“插件覆盖层”开关（管理页只有管理员能进，覆盖层是否启用是个人选择）。`plugin-catalog.ts` 扫描内置与已装包、限清单 ≤1MiB、每包 ≤1 万文件、读超时 10s。

## 改它时
- 加一个插件管理接口：`routes/plugins.ts`（安装/启停/授权类要求管理员、插件系统关闭时 503 `PLUGINS_DISABLED`）、`plugin-manager.ts` 状态机（同一插件 ID 串行）、前端 `lib/api/plugins.ts` 与 `usePlugins.ts` 一起改。
- 加内置插件：`server/builtin-plugins/registry.ts` 登记；编译版要能把内置包写回磁盘（`materialize`）；首次默认启用，之后显式停用保持有效。
- 改数据落点（`plugins/` 下的 `packages/`、`current.json`、`state.json`、`permissions.json`、`secrets.json`）：同看数据导入导出与备份是否覆盖这些文件（未核实）。

## 下面有什么

- [插件运行时](runtime.md)：插件包、进程与 Podman 运行、握手与超时、生命周期与升级。
- [插件授权与密钥](permissions-secrets.md)：能力代理、授权存储、密钥保管、签名与加固。
- [提供商插件](providers.md)：以插件形式接入的模型提供商：清单、注册、凭证、就绪检查。
- [插件贡献点](contributions.md)：插件提供的工具、命令、搜索源、事件、界面与 MCP 适配。

## 相关
- [基准测试与容器](../benchmarks-containers.md)
