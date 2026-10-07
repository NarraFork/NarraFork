# NarraFork 插件系统设计总览

> 状态：**已实现（阶段 0–4）**。本目录为设计基线与实现对照；09-roadmap / task-breakdown 反映设计期任务拆分，完成状态见 `验收记录.md` 与代码（`server/services/plugin-*.ts`、`server/routes/plugins.ts`、`frontend/components/plugins*`）。
>
> 本目录由多个独立设计任务协作产出，本文是主叙述者整合后的入口。

## 1. 一句话结论

NarraFork 插件系统采用 **VS Code 风格的 Manifest / Contribution / Activation 模型**，但不复用 VS Code 运行时：

- 后端第三方代码默认以“一插件一进程”的方式运行，通过 **Content-Length framed JSON-RPC over stdio** 与核心通信。
- 模型供应商由核心侧 `ProviderRegistry` 和 `RemoteProviderAdapter` 接入现有 Agent Loop；插件不直接进入 Agent Loop，也不读取核心 settings、数据库或完整工具上下文。
- 前端第三方 UI 默认运行在 **sandbox iframe** 中，通过每个 panel instance 独立的 `MessageChannel` 与宿主通信。
- Dockview 只新增一个稳定的宿主组件 `PluginDockPanel`；插件通过声明式 contribution 和可序列化 panel params 创建面板。
- 内部信息通过版本化的 **Public Event / Query / Command / Storage / Config / Secret API** 暴露；原始 `eventBus`、SQLite、Drizzle、Hono、JWT 和内部 service 永远留在核心边界内。
- MCP 与插件系统共存：MCP 继续承担工具协议，插件系统承担生命周期、provider、UI 和 NarraFork 公共宿主 API。

核心原则：

> 插件只能请求宿主公开的能力，不能导入宿主实现；安装、签名、信任、授权和运行隔离是不同概念。

## 2. 本轮设计基于的当前事实

当前代码已经提供了重要基础，但还没有通用插件宿主：

- `server/main.ts` 是后端组合根，负责 HTTP/WS、MCP、恢复、调度、Gateway、容器代理和优雅退出。
- `server/lib/agent/provider.ts` 定义了较宽的进程内 `ProviderAdapter`；provider 解析仍集中在核心设置和 `createProviderByName()`。
- `server/lib/event-bus.ts` 提供了丰富但内部化的类型事件；它不是带授权和持久化能力的公共事件日志。
- `server/lib/mcp/manager.ts` 已经提供外部进程/远程连接、工具发现、取消、重连和 shutdown 的实现经验。
- `frontend/components/dockview/DockviewSurface.tsx`、`NarratorDock` 和 `DockviewWorkspace` 已经形成统一 Dockview 容器，且使用 `defaultRenderer="always"` 保持聊天、终端和其他面板实例状态。
- TanStack Router 路由树和 Vite 前端构建是构建期静态产物，不能通过安装插件动态写入新的文件路由。
- NarraFork 的性能约束要求主线程 SQLite CRUD 有界、列表不读大字段、WS 高频输出节流并处理 backpressure、子进程输出具备大小上限和超时。

## 3. 统一术语与协议版本

### 3.1 身份

| 名称 | 规范 | 用途 |
|---|---|---|
| `pluginId` | 反向域名风格，如 `com.example.review` | 插件、权限、存储、日志和审计的根身份 |
| `contributionId` | 插件内局部 ID | provider/tool/command/view/event 等贡献 |
| 完整 contribution ID | `${pluginId}/${contributionId}` | 跨插件唯一引用 |
| `providerTypeId` | `${pluginId}/${localProviderId}` | 插件提供的 provider 类型 |
| `providerInstanceId` | 宿主生成的稳定 ID | 配置、状态、审计和 prefix 迁移 |
| `providerPrefix` | 用户可修改、宿主校验 | 兼容现有 `provider:model` 模型值 |
| `modelId` | provider 内裸模型 ID | 由插件模型目录返回 |
| 完整模型值 | `${providerPrefix}:${modelId}` | 进入现有 Agent Loop/settings |

`pluginId`、`contributionId`、`providerTypeId` 和 `providerInstanceId` 不得混用。插件不能返回已经拼接用户 prefix 的模型值。

### 3.2 版本层

插件系统有四个相互独立的协议层：

| 层 | 当前设计值 | 负责内容 |
|---|---|---|
| Manifest schema | `1` | 包清单静态解析、入口和贡献声明 |
| Host API | `1.x` | Query、Command、Event、Storage、Config、Secret 等 DTO |
| 后端 RPC transport | `narrafork.rpc/1` | Content-Length framing、JSON-RPC envelope、握手、取消和流控 |
| UI bridge | `narrafork.ui/1` | iframe bootstrap、MessageChannel、UI RPC 和通知 |

Provider 业务协议在 `narrafork.rpc/1` transport 之上单独协商 `protocolVersion: "1.0"`，不与 framing 版本混为一个字段。

同一 major 内只增加可选字段或能力；改变必需语义、错误语义或删除字段必须升级 major。未知必需字段直接拒绝，未知可选字段可以忽略。

### 3.3 信任等级统一

持久化和审计使用 T0–T3 作为规范等级：

| 等级 | 含义 | 是否执行 |
|---|---|---:|
| T0 | 随 NarraFork 核心编译的代码 | 是，核心进程 |
| T1 | 官方/组织可信的已安装插件 | 是，独立进程 |
| T2 | 管理员批准的第三方插件 | 是，独立进程；高风险建议 Podman |
| T3 | 未批准、未知或仅待检查的包 | 否 |

安全文档中的运行 profile 是实施标签，不替代规范等级：

- `trusted`：通常对应 T1；仍必须经过 capability Grant。
- `restricted`：通常对应 T2 的 LocalProcessRunner 弱隔离模式。
- `sandboxed`：通常对应 T2 的 Podman/更强 OS 隔离模式。
- T3 只能读取包元数据、签名和静态 Manifest，不得激活。

无论 T1 还是 T2，用户安装包都不能通过配置切换为进程内插件；只有 T0 核心代码允许直接访问内部实现。

## 4. 总体架构

```text
┌──────────────────────────── NarraFork Core ────────────────────────────┐
│                                                                        │
│  Plugin Manager                                                       │
│   ├─ Catalog / Package Store / Lifecycle Journal                      │
│   ├─ Compatibility Checker / Activation Index                        │
│   ├─ Contribution Registries                                          │
│   ├─ Runtime Supervisor                                               │
│   └─ Capability Broker                                                │
│          ├─ Public Query / Command / Event                            │
│          ├─ Config / Secret / Storage                                 │
│          └─ Provider Registry / RemoteProviderAdapter                 │
└───────────────┬────────────────────────┬──────────────────────────────┘
                │ RPC/stdio              │ MessageChannel
       ┌────────▼─────────┐      ┌───────▼────────┐
       │ plugin backend   │      │ sandbox iframe │
       │ one plugin/proc  │      │ PluginDockPanel│
       └──────────────────┘      └────────────────┘
```

### 控制面

负责：安装、静态校验、签名/来源、授权、启停、激活、升级、回滚、卸载、quarantine、诊断和资源状态。

### 数据面

负责：provider 流、工具/命令调用、Query、Public Event、Storage、Secret 和 UI bridge 请求。

数据面所有调用都必须经过 Capability Broker；数据面拥塞不能阻塞控制面的取消、停止、健康检查和升级操作。

## 5. Provider 设计结论

### 5.1 两类供应商

1. **兼容 API provider**：OpenAI、Anthropic、Gemini 等已有协议继续走 NarraFork 内置适配器和 Custom API Provider，不需要安装可执行插件。
2. **可执行 provider plugin**：用于专有 SDK、OAuth、私有流协议、本地推理桥或特殊模型目录；插件在独立进程中实现 provider RPC。

### 5.2 Provider RPC

核心方法：

```text
provider.describe
provider.validateConfig
provider.listModels
provider.chat
provider.generate
provider.cancel
```

provider 流事件至少包括：

```text
text.delta
reasoning.delta
tool.start / tool.delta / tool.end
usage
error
done
```

web search、image generation、quota、queue 等属于可选 feature，不得通过未知字段改变 Agent Loop 语义。

核心侧负责：

- canonical history、tools 和 tool results 构造；
- ProviderAdapter 兼容映射；
- Agent Loop 轮次、工具执行、权限、重试、compact、持久化和最终结束判断；
- AbortSignal、deadline、seq、credit/backpressure、错误分类和不重放语义。

插件只负责：

- 供应商认证和请求组装；
- 专有协议转换；
- 模型目录；
- 规范化流事件和 provider metadata。

## 6. UI 与 Dockview 设计结论

### 6.1 UI 安全边界

第三方 UI 使用宿主生成的：

```html
<iframe sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
```

默认不允许 `allow-same-origin`、forms、popups、downloads、top navigation、clipboard、camera、microphone 和直接网络请求。插件 UI 不接收 JWT、Cookie、API token、provider secret 或宿主 localStorage。

每个 `panelInstanceId` 独立拥有：

- iframe；
- MessageChannel；
- connect nonce；
- session binding；
- 权限快照；
- 取消域；
- 有界事件队列。

### 6.2 Dockview 接入

focus dock 和 workspace dock 都只注册一个静态 component key：

```text
component: "plugin"
```

对应宿主 `PluginDockPanel`。插件面板参数由宿主生成并校验，至少包含：

```ts
interface PluginDockPanelParams {
  schemaVersion: 1;
  panelType: "plugin";
  pluginId: string;
  contributionId: string;
  panelInstanceId: string;
  binding: {
    narratorId?: string;
    chapterId?: string;
    projectId?: string;
    workspaceId?: string;
  };
  viewState?: Record<string, unknown>;
}
```

`pluginId`、`contributionId`、`panelInstanceId` 和 binding 是 host-owned immutable fields。插件只能更新受限的 `viewState`、标题、徽章和 dirty 状态。

Dockview 布局在插件缺失、禁用、权限撤销、不兼容或崩溃时保留 panel params，显示可诊断占位页，不静默删除用户布局。

### 6.3 UI contribution

v1 只支持声明式 contribution：

- narrator Dockview panel；
- narrator toolbar/action；
- command palette command；
- settings section；
- navigation/sidebar item；
- context menu；
- notification；
- dashboard card；
- 受控 theme token。

不支持第三方运行期注入 React component、hook、Provider、Router route、全局 CSS、宿主 DOM 或任意 JavaScript callback。

TanStack Router 保持静态 route tree；插件页面使用宿主预置的通用 route 或 Dockview panel，不动态写入 `frontend/routes`。

## 7. Public Event / Query / Command

### 7.1 Public Event

公共事件是经过白名单映射、脱敏、资源授权、过滤、节流和有界队列后的 DTO，不能直接复用 `NarraForkEvent` 或 `NarratorServerMessage`。

推荐 envelope：

```ts
interface PublicEvent {
  schema: "narrafork.public-event";
  schemaVersion: 1;
  eventId: string;
  topic: string;
  eventClass: "state" | "lifecycle" | "progress" | "attention" | "audit";
  occurredAt: string;
  deliverySeq?: number;
  resource?: Record<string, unknown>;
  data: Record<string, unknown>;
  redaction: "public" | "user_scoped" | "admin_scoped";
  resyncHint?: { queryId: string; resourceVersion?: number };
}
```

v1 默认 at-most-once。事件丢失时发送 overflow/resync hint，由插件通过 Query 对账；不自动重放可能有副作用的 Command。

### 7.2 Query 与 Command

- Query 只读、有限字段、cursor 分页、`LIMIT n + 1` 判断 `hasMore`。
- Command 表达业务意图，不暴露任意 service method、SQL 或 Hono handler。
- 长操作返回 `operationId`，通过 Query/Event 获取进度和最终状态。
- 所有输入由 Zod/JSON Schema 校验；所有调用有 requestId、correlationId、deadline、scope、配额和审计记录。
- 插件不能指定自己的 `pluginId`、userId、projectId、narratorId、deviceId、secretId 或 provider identity；这些由宿主绑定和重新解析。

### 7.3 权限公式

```text
manifestRequested
∩ installationGrants
∩ hostPolicy
∩ currentUserAuthority
∩ currentInvocationScope
∩ contributionPolicy
∩ runnerEnforcement
```

授权缺失、上下文失效、资源归属不明、插件未启用、版本不兼容或 runner 不满足要求时 fail closed。

## 8. 数据模型方向

插件相关元数据不加入现有 `NarraForkSettings`，建议独立表/服务管理：

- `plugin_packages`：不可变包版本、hash、Manifest、签名和兼容状态；
- `plugin_installations`：期望状态、当前包、运行状态和 quarantine；
- `plugin_lifecycle_operations`：安装/升级/卸载 journal；
- `plugin_runtime_records`：runtime generation、runner、PID、队列和退出诊断；
- `plugin_contributions`：静态贡献注册表；
- `plugin_grants`：权限和资源 scope；
- `plugin_event_subscriptions`：后端公共事件订阅；
- `plugin_configs` / `plugin_secrets`：配置与 secret 分离；
- `plugin_storage_entries` / migration：namespaced 小型 JSON storage；
- `plugin_provider_instances` / models：Provider Registry 配置和模型目录；
- `plugin_operations` / `plugin_audit_log`：跨边界操作和审计。

真正实现时必须遵守项目数据库规则：先修改 `server/db/schema.ts`，再运行 `bun run db:generate`，禁止手写或直接修改 `drizzle/`。

## 9. 实施路线

| 阶段 | 目标 | 可开放能力 |
|---|---|---|
| 0 | 契约冻结、威胁模型、fixture 和性能基线 | 不执行第三方代码 |
| 1 | Catalog、Package Store、State Store、LocalProcessRunner、RPC、Runtime Supervisor | 安装、静态检查、启停、诊断 |
| 2 | Capability Broker、Public Query/Command/Event、Storage、Secret、Tool、MCP adapter | 受授权后端插件 |
| 3 | Provider Registry、模型目录、RemoteProviderAdapter、流式 provider RPC | 受授权 provider 插件 |
| 4 | Asset shell、iframe、MessageChannel、PluginDockPanel、focus/workspace/director、发布硬化 | 完整 UI 插件体验 |

阶段 0 必须先冻结：

- Manifest v1；
- plugin/contribution/provider ID；
- T0–T3 信任政策；
- capability/permission taxonomy；
- Host API、RPC、UI protocol；
- 错误码、取消、deadline、credit/backpressure；
- 参考插件和恶意插件 fixture。

## 10. 高优先级待决策

详细清单见 `10-open-questions-and-decisions.md`，当前最关键的是：

1. Host API/RPC 的 0.x/1.x 兼容窗口。
2. T2 高风险插件是否强制 Podman；无 Podman 时是否拒绝激活。
3. Secret Broker 的主密钥来源、轮换和备份恢复。
4. 首版 UI 是否只允许 IIFE bundle，还是同时允许 ESM/dynamic chunks。
5. v1 是否需要 durable Public Event log；当前推荐 at-most-once + Query resync。
6. plugin storage 是否先落 SQLite，还是首版使用文件型 namespaced storage。
7. providerPrefix 的用户迁移、冲突处理和可见模型目录缓存策略。
8. 是否开放 workspace read/write、外部网络、MCP server 和 Scheduler 等高风险 capability。

## 11. 文档导航

| 文件 | 内容 |
|---|---|
| `01-requirements-and-boundaries.md` | 能力需求、非目标、信任模型和不可跨越边界 |
| `02-host-architecture.md` | Core Host、Plugin Manager、Runtime Supervisor、生命周期和激活 |
| `03-manifest-and-packaging.md` | Manifest、版本、入口、安装、升级、回滚和卸载 |
| `04-server-rpc-and-provider.md` | Provider RPC、流式协议、RemoteProviderAdapter 和 Agent Loop 映射 |
| `05-ui-bridge-and-dockview.md` | iframe、MessageChannel、UI API、Dockview 和布局恢复 |
| `06-events-query-and-permissions.md` | Public Event、Query、Command、过滤、权限、背压和审计 |
| `07-security-and-sandbox.md` | 信任级别、LocalProcessRunner、Podman、CSP、Secret 和安全失败语义 |
| `08-data-model-and-core-integration.md` | 逻辑表、配置/存储、Provider Registry、核心接入和迁移 |
| `09-roadmap-and-task-breakdown.md` | 阶段 0–4、P0–P12 工程任务、验收和发布回滚 |
| `10-open-questions-and-decisions.md` | ADR-001–021 和 OQ-001–030 |
| `contracts/manifest-v1.schema.json` | Manifest v1 的机器可读 JSON Schema companion |
| `contracts/permission-taxonomy.md` | 阶段 0 冻结的 capability、scope、trust 和 fail-closed 契约 |
| `task-breakdown.md` | 多代理设计任务分工和整合规则 |

推荐阅读顺序：

```text
00 → 01 → 02 → 03 → 06 → 04 → 05 → 07 → 08 → 09 → 10
```

## 12. 当前整合结论

本目录的设计已经形成一条闭合主线：

```text
Manifest / Catalog
  → Plugin Manager / Runtime Supervisor
  → Capability Broker / Public Host API
  → Provider Registry / Tool / Command / Event / Storage
  → RemoteProviderAdapter 或 UI Host Bridge
  → PluginDockPanel / iframe / Dockview
  → 诊断、审计、升级、回滚和缺失恢复
```

实现时应先完成阶段 0 契约冻结和恶意 fixture，再实现阶段 1 控制面；不要先从 UI 注入或 ProviderAdapter 直接改造开始。