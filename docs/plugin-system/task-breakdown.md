# NarraFork 插件系统设计任务分解

> 状态：**历史设计协作记录**。插件系统已实现，本文件不再作为工作分配依据。
>
> 本文件用于协调多个设计代理。每个代理只修改自己负责的文档；最终由主叙述者统一术语、协议版本和交叉引用。

## 协作规则

- 所有设计文档使用简体中文。
- 文档中区分：当前代码事实、设计建议、假设、待决策项。
- 协议示例使用 TypeScript 或 JSON。
- 本轮只新增设计文档，不修改 `server/`、`frontend/`、`drizzle/`。
- 不直接暴露数据库、原始 `eventBus`、内部服务对象或 JWT 给插件。
- 后端插件、前端 UI 插件、模型供应商插件应能独立启用和禁用。

## 代理任务

### 1. plugin-architecture

负责：
- `01-requirements-and-boundaries.md`
- `02-host-architecture.md`

重点：
- 阅读当前 Bun/Hono/Agent/MCP 启动和动态加载代码。
- 明确插件能力、非目标、可信插件与第三方插件边界。
- 设计核心宿主、插件管理器、生命周期、故障恢复和版本兼容。

### 2. plugin-provider-rpc

负责：
- `04-server-rpc-and-provider.md`

重点：
- 阅读 `ProviderAdapter`、Agent Loop、settings provider resolution、MCP transport。
- 设计 JSON-RPC over stdio、流式事件、取消、超时、错误、usage、tool calls。
- 设计 `RemoteProviderAdapter` 与现有 Agent Loop 的映射。

### 3. plugin-ui-dockview

负责：
- `05-ui-bridge-and-dockview.md`

重点：
- 阅读 DockviewSurface、NarratorDock、workspace Dockview、Vite、TanStack Router。
- 设计 iframe、MessageChannel、UI API、Dockview 插件面板、布局持久化和缺失插件恢复。
- 明确 UI contribution points 与不允许的任意 DOM/React 注入。

### 4. plugin-events-api

负责：
- `06-events-query-and-permissions.md`
- `08-data-model-and-core-integration.md`

重点：
- 阅读 event-bus、narrator WebSocket、路由/服务边界和主线程性能约束。
- 设计公共事件、查询 API、命令 API、过滤、分页、背压、脱敏和权限。
- 设计插件安装记录、授权、配置、namespaced storage 与 Provider Registry 的核心接入。

### 5. plugin-security-packaging

负责：
- `03-manifest-and-packaging.md`
- `07-security-and-sandbox.md`

重点：
- 设计 Manifest、激活事件、版本兼容、安装包、目录布局、升级/回滚。
- 设计权限、密钥、网络、文件系统、进程隔离、iframe sandbox、Podman 隔离和审计。

### 6. plugin-roadmap-review

负责：
- `09-roadmap-and-task-breakdown.md`
- `10-open-questions-and-decisions.md`

重点：
- 基于已有技术选型和其他设计边界，制定阶段路线、验收标准、工程任务依赖。
- 记录 ADR 风格决策、风险、未决问题和文档之间可能的冲突。

## 主叙述者整合

代理完成后，主叙述者负责：

1. 读取全部设计文档。
2. 编写 `00-overview.md`。
3. 修正协议命名、Manifest 字段、Plugin ID、Provider ID、权限名、生命周期状态不一致。
4. 检查后端 RPC 是否可映射现有 `ProviderAdapter` 和 Agent Loop。
5. 检查 UI API 是否绕开原始 DB/EventBus/JWT。
6. 检查 Dockview 布局在插件卸载、禁用、升级和异常时是否可恢复。
7. 检查高风险能力是否具备权限、审计、取消、超时、输出上限和背压设计。
8. 输出最终文档索引和下一步实现顺序。
