# NarraFork 插件系统：公共事件、查询、命令与权限

> 文档定位：定义插件看到的 Public Event、Query、Command、权限、过滤、快照/增量同步、分页、背压、节流、脱敏和审计边界。本文只定义公共宿主 API 与接入规则，不把原始 `eventBus`、Hono 路由、Drizzle row 或叙述者 WebSocket 暴露给插件。
>
> 与其他文档的关系：`02-host-architecture.md` 定义 Plugin Manager、Runtime Supervisor 和 Capability Broker 的总体架构；`04-server-rpc-and-provider.md` 定义 provider RPC；`05-ui-bridge-and-dockview.md` 定义 UI iframe/MessageChannel。本文的事件、查询和命令 DTO 既可由后端插件 RPC 使用，也可由 UI Bridge 的 host API 使用。

## 0. 标记约定

- **[当前事实]**：可由当前仓库代码或现有设计直接确认。
- **[设计建议]**：本轮建议采用的公共接口、规则或实现方式。
- **[假设]**：为形成可执行设计而暂时采用，尚未由实现或 ADR 最终确认。
- **[待决策]**：需要后续 ADR、产品策略或安全评审明确的事项。

## 1. 当前基线与问题边界

### 1.1 当前实现事实

- **[当前事实]** `server/lib/event-bus.ts` 定义了 `NarraForkEvent` 联合类型，事件覆盖章节、依赖、合并、叙述者、子代理、容器、浏览器、终端、MCP、快照、后台任务、设备和文件传输等领域。事件总线是进程内 `EventEmitter`，`emit()` 同步遍历监听器；异步监听器错误由总线捕获并记录。
- **[当前事实]** 当前事件总线允许按精确事件类型监听，也允许 `onAny()` 监听全部事件；它是核心内部解耦接口，不是持久化事件日志，也没有按用户或资源进行授权过滤。
- **[当前事实]** `server/websocket/narrator-ws.ts` 使用连接集合和 `subscribedNarrators` 做叙述者广播；订阅后会发送状态、运行时、流式快照或消息 catch-up。消息 catch-up 在查询期间缓冲实时帧，当前缓冲上限是 1000 条或 2,000,000 bytes，溢出时发送 `full_reload`。
- **[当前事实]** narrator WS 已有 `messageVersion`、cursor、`sync_ok`、`catch_up`、`full_reload` 等增量同步语义；它们只适用于核心叙述者 UI，不能作为插件公共协议原样转发。
- **[当前事实]** `server/websocket/narrator-ws-types.ts` 的 `NarratorServerMessage` 含 `contentJson`、tool input/output、文件路径、推理块和流式累计状态等内部/高敏感结构。插件不得直接订阅该类型，也不得把它当作 PublicEvent DTO。
- **[当前事实]** `server/app.ts` 在公共路由之后统一挂载 `requireAuth`，再静态挂载业务路由；`settingsRoutes`、`skills`、`routines` 等路由通过 Zod/`ValidationError` 做输入校验，管理操作通过 `requireAdmin` 或 `assertAdmin` 保护。
- **[当前事实]** `server/routes/settings.ts` 的 settings GET 会遮蔽 API key、TLS passphrase、VNet token、敏感 header 等字段；settings PATCH 使用 `AsyncMutex`、严格 Zod schema、深度合并和掩码值恢复，部分设置变更还会触发运行时更新或重启。
- **[当前事实]** `server/lib/settings/index.ts` 把 `~/.narrafork/settings.json` 读入内存缓存，保存时写临时文件后原子 rename，文件权限为 `0600`；它还负责兼容迁移和 provider prefix 引用清理。
- **[当前事实]** `server/db/schema.ts` 的核心数据在 SQLite/Drizzle 中，主键通常是 nanoid 文本；叙述者消息、消息引用、工具调用、API 请求、后台任务和知识库等表已存在。`narrator_message_refs.seq`、`narrators.messageVersion`、各类 `createdAt/updatedAt` 索引是现有分页和增量读取的基础。
- **[当前事实]** 代表性服务通常直接查询 DB、调用内部服务并 `eventBus.emit()`；例如章节边服务写入 `chapter_edges` 后发出 `dependency:created`，通知服务监听 `narrator:attention` 后自行查询叙述者和用户偏好。插件公共 API 不能照搬这种内部耦合方式。
- **[当前事实]** CLAUDE.md 明确要求：主线程 SQLite 只能做小、快、有索引、有上限的 CRUD；列表不读 `raw_dump_json`、`output_json`、`content_json` 等大字段；分页优先 cursor + `LIMIT n + 1`；WS 高频输出必须合并、节流、处理 backpressure；长任务、子进程输出、文件读取和大 JSON 必须有上限、超时、取消和慢操作诊断。

### 1.2 公共边界

- **[设计建议]** 原始 `eventBus`、`NarratorServerMessage`、Drizzle/SQLite、内部 service、JWT、完整 `ToolContext` 和 provider credential 都属于 Core Host 私有实现。
- **[设计建议]** 插件只通过 `Event Gateway`、`Query Gateway`、`Command Gateway`、`Storage/Config/Secret Broker` 调用公共能力；每个网关都由 Capability Broker 统一做身份、授权、作用域、限额、校验、脱敏和审计。
- **[设计建议]** 公共事件默认是在线、异步、at-most-once 投递；插件不能把事件当作可靠队列。需要恢复的数据必须使用 Query API 对账，或在未来启用明确的 durable event log 扩展。
- **[设计建议]** Query 是只读、有限字段、游标分页的资源视图；Command 是表达业务意图的有限动作，不是“按字符串调用任意内部 service”。
- **[设计建议]** 插件提交的 `pluginId`、用户身份、项目/章节归属、路径、设备目标、权限决定和 provider 身份都不可信；宿主从运行时绑定和核心 DB 重新解析。

## 2. 公共身份与调用上下文

### 2.1 两类主体

**[设计建议]** 每次公共 API 调用都绑定两个可能同时存在的主体：

```ts
interface PluginPrincipal {
  pluginId: string;
  packageVersion: string;
  runtimeId: string;
  runtimeGeneration: number;
  contributionId?: string;
  installationId: string;
}

interface InvocationPrincipal {
  kind: "user" | "plugin_background" | "system";
  userId?: string;
  userRole?: "admin" | "user";
  source: "ui" | "command" | "event" | "schedule" | "provider" | "internal";
}

interface InvocationScope {
  projectId?: string;
  chapterId?: string;
  narratorId?: string;
  workspaceId?: string;
  deviceId?: string;
  providerInstanceId?: string;
}

interface HostCallContext {
  requestId: string;
  correlationId: string;
  deadlineAt: string;
  plugin: PluginPrincipal;
  invocation: InvocationPrincipal;
  scope: InvocationScope;
}
```

- **[设计建议]** `PluginPrincipal` 由宿主根据已建立的 RPC/MessageChannel 连接绑定，插件不能在参数中改写。
- **[设计建议]** 用户发起的 UI/命令调用可以携带 `InvocationPrincipal.kind = "user"`；插件后台事件、定时任务和 provider 预取只能使用安装级后台授权，不得继承“最近一次用户”的权限。
- **[设计建议]** 传给插件的用户上下文只包含用途所需的最小展示字段；插件不会得到可复用的 JWT、Bearer token、refresh token 或内部 session 对象。
- **[设计建议]** `requestId` 绑定一次 Query/Command/订阅操作；`correlationId` 贯穿插件调用、核心服务、审计和异步 operation。迟到响应必须因 runtime generation 或 request 状态不匹配而被丢弃。

### 2.2 有效权限公式

**[设计建议]** 实际生效权限取交集，而不是只看 Manifest：

```text
effectiveCapabilities =
  manifestRequested
  ∩ installationGrants
  ∩ hostPolicy
  ∩ currentUserAuthority
  ∩ currentInvocationScope
  ∩ contributionPolicy
```

- **[设计建议]** 任一项无法解析、授权缓存过期、资源归属不明或插件状态不是 `enabled + compatible` 时，按 fail closed 处理。
- **[设计建议]** 权限在订阅建立时检查，也在每次事件交付、Query、Command 和 Secret 解析时再次检查，以处理授权撤销、用户切换、资源删除和插件禁用。

## 3. PublicEvent DTO

### 3.1 事件 envelope

**[设计建议]** 公共协议只允许 JSON value，避免把宿主对象、函数或 structured clone 特性带过边界：

```ts
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
```

**[设计建议]** 公共事件使用独立 envelope，内部冒号事件名转换成稳定的点号 topic；不要把 `NarraForkEvent` 联合类型直接序列化。

```ts
type PublicEvent = {
  schema: "narrafork.public-event";
  schemaVersion: 1;
  eventId: string;                 // 宿主生成的 opaque ID
  topic: string;                   // 例如 narrafork.narrator.status.changed
  eventClass: "state" | "lifecycle" | "progress" | "attention" | "audit";
  occurredAt: string;              // ISO-8601 UTC
  deliverySeq?: number;            // 仅本订阅/本连接单调递增
  resource?: {
    type: "project" | "chapter" | "narrator" | "review" | "terminal" |
      "container" | "background_task" | "provider" | "plugin";
    id: string;
    projectId?: string;
    chapterId?: string;
    narratorId?: string;
    resourceVersion?: number;
  };
  actor?: {
    kind: "user" | "system" | "plugin";
    id?: string;                   // 仅在当前权限允许时出现
    role?: "admin" | "user";
  };
  data: Record<string, JsonValue>;
  redaction: "public" | "user_scoped" | "admin_scoped";
  resyncHint?: {
    queryId: string;
    resourceVersion?: number;
  };
};
```

- **[设计建议]** `data` 必须是 JSON value；禁止 `undefined`、`BigInt`、循环对象、函数、Error 实例、DB row、文件句柄和宿主类实例。
- **[设计建议]** `deliverySeq` 是网关按订阅分配的在线序号，不代表全局事件序号；重连后不能单独拿它向核心请求历史。
- **[设计建议]** `resourceVersion` 只有在核心已有单调版本或可安全计算时才填入。例如叙述者消息可使用现有 `narrators.messageVersion`，章节状态可使用 `updatedAt` 对应的查询 fence；不能为不存在的版本伪造数字。
- **[设计建议]** `resyncHint` 只告诉插件“应调用哪个公共 Query 对账”，不把内部表名、SQL 或私有 cursor 暴露给插件。
- **[设计建议]** `eventId` 用于幂等去重和诊断，不承诺持久化或可重放；如果未来提供 durable log，必须另加 `eventLogCursor` 语义，不能重新解释现有字段。

### 3.2 公共 topic 白名单

**[设计建议]** v1 只允许以下主题族；最终 topic ID 应进入 Manifest/Host API 常量表，插件不能订阅任意字符串前缀。

| Public topic | 典型数据 | 对应内部来源/备注 | 默认级别 |
|---|---|---|---|
| `narrafork.project.changed` | `projectId`, `changeKind`, `updatedAt` | 项目 CRUD/归档 | user-scoped |
| `narrafork.chapter.created` | `chapterId`, `projectId`, `role`, `status` | `chapter:created` | user-scoped |
| `narrafork.chapter.lifecycle` | `chapterId`, `projectId`, `status`, `role` | fork/dormant/wake/abandoned/frozen/merged 的归一化 | user-scoped |
| `narrafork.chapter.edge.changed` | `edgeId`, `projectId`, `sourceId`, `targetId`, `type` | dependency/fork/merge/review/cherry-pick | user-scoped |
| `narrafork.chapter.commits.changed` | `chapterId`, `newCount`, `headCommitSha?` | 不含完整 diff | user-scoped |
| `narrafork.review.lifecycle` | `reviewChapterId`, `sourceChapterId`, `status`, `verdict?` | review created/concluded/converted/dismissed | user-scoped |
| `narrafork.narrator.lifecycle` | `narratorId`, `chapterId?`, `type`, `status`, `substatus`, `messageVersion?` | `narrator:status_changed` 等 | user-scoped |
| `narrafork.narrator.attention` | `narratorId`, `reason`, `detail?` | `narrator:attention`/resolved | user-scoped |
| `narrafork.narrator.message.changed` | `narratorId`, `messageId`, `role`, `createdAt`, `messageVersion` | 只给元数据，不给正文 | user-scoped |
| `narrafork.narrator.tool.changed` | `narratorId`, `toolUseId`, `toolName`, `status`, `durationMs`, `outputBytes?` | 不给 input/output JSON | user-scoped |
| `narrafork.narrator.permission.changed` | `narratorId`, `requestId`, `state`, `toolName?`, `decision?` | 不给完整请求参数 | user-scoped |
| `narrafork.background-task.changed` | `taskId`, `parentNarratorId`, `taskType`, `status`, `outputBytes` | 不给累计 output | user-scoped |
| `narrafork.terminal.changed` | `terminalId`, `narratorId?`, `chapterId?`, `status`, `exitCode?` | 不给 PTY 输出 | user-scoped |
| `narrafork.container.changed` | `chapterId`, `status`, `serviceCount?` | `container:log` 不直接公开 | user-scoped |
| `narrafork.device.changed` | `deviceId`, `status`, `platform?`, `agentVersion?` | token 轮换/撤销只给管理员摘要 | user-scoped/admin |
| `narrafork.transfer.progress` | `transferId`, `deviceId`, `direction`, `bytesTransferred`, `totalBytes` | 可节流 | user-scoped |
| `narrafork.provider.catalog.changed` | `providerInstanceId`, `providerTypeId`, `catalogVersion`, `stale` | 不给 secret/config | admin/user |
| `narrafork.provider.quota.changed` | 已脱敏 quota overview | 仅使用公开 quota DTO | user-scoped |
| `narrafork.plugin.lifecycle` | `pluginId`, `version`, `desiredState`, `runtimeState`, `reason` | 仅管理员或拥有 plugin 管理权限 | admin-scoped |
| `narrafork.plugin.audit.summary` | `pluginId`, `operation`, `outcome`, `durationMs` | 不给参数正文 | admin-scoped |

- **[设计建议]** `narrator:message_broadcast`、`narrator:ws_broadcast`、`container:log`、`background_task:output`、浏览器 `url`、完整 `NarratorServerMessage` 和 provider 原始流不映射到通用 PublicEvent。
- **[设计建议]** 流式文本、推理、tool input delta、终端输出和完整 diff 需要专门的、明确授权的分页/流接口；即使未来开放，也不应复用 `narrafork.narrator.message.changed`。
- **[设计建议]** 任何内部事件没有稳定的脱敏 DTO 时，先不加入白名单；不要为了“覆盖全部 eventBus 类型”而透传未知字段。
- **[待决策]** `narrafork.project.changed`、`narrafork.device.changed` 是否在 v1 全部提供，取决于资源归属查询和多用户共享项目策略。

### 3.3 事件映射原则

**[设计建议]** Event Gateway 以一个受 hot-reload 保护的内部监听器接收 `eventBus`，执行以下步骤：

```text
raw eventBus event
  → topic allowlist / event mapper
  → 从事件字段和最小 indexed lookup 构造 DTO
  → 绑定 resource scope
  → capability + user/resource authorization
  → 字段 allowlist redaction
  → per-subscription filter
  → coalesce/throttle
  → bounded delivery queue
  → async RPC/MessageChannel/controlled WS delivery
```

- **[设计建议]** 事件映射器不得等待插件完成，也不得在 `eventBus.emit()` 的同步调用栈执行网络、文件、完整消息 hydration 或大 JSON 序列化。
- **[设计建议]** 事件中缺少项目/章节上下文时，可做一次有索引、有限字段的异步补充查询；查询失败则丢弃该事件或降低为无资源摘要，不猜测归属。
- **[设计建议]** 事件 mapper 的异常只影响该事件和对应订阅，必须被捕获并写入有界诊断；不能让一个插件或 mapper 破坏核心事件总线。
- **[设计建议]** 类似 `narrator-ws.ts` 的 `hotOnce("narrafork.pluginEventGateway.listenersRegistered")` 保护事件监听器注册，避免 Bun --hot 重载导致重复订阅。

## 4. 过滤、快照、增量与分页

### 4.1 事件过滤

**[设计建议]** 过滤器是受限、可审计的结构化谓词，不执行 JavaScript、正则脚本或插件表达式。

```ts
type PublicEventFilter = {
  all?: Array<PublicEventFilter>;       // 最多深度 3
  any?: Array<PublicEventFilter>;
  topic?: string[];                     // 只能是已授权白名单 topic
  eventClass?: Array<PublicEvent["eventClass"]>;
  projectIds?: string[];
  chapterIds?: string[];
  narratorIds?: string[];
  resourceTypes?: string[];
  statuses?: string[];
  actorKinds?: Array<"user" | "system" | "plugin">;
};
```

- **[设计建议]** `topic`、project/chapter/narrator/device/provider ID 均先经过 grant scope 校验；插件不能用 filter 探测无权资源是否存在。
- **[设计建议]** v1 每次订阅最多 20 个 topic、20 个资源 ID、20 个谓词、3 层嵌套；字符串和数组元素均有 byte limit。
- **[设计建议]** 过滤顺序固定为授权资源范围 → topic allowlist → typed predicate → 脱敏 DTO → 节流/合并；不能先发送再由插件自己过滤。
- **[设计建议]** 未知字段、未知 topic、未知 operator、超深 filter 或过滤器解析失败直接返回 `INVALID_FILTER`，不采取“忽略未知字段”的宽松行为。
- **[设计建议]** 过滤器不能按 `data` 任意路径读取，因为这会把未来新增敏感字段意外变成可观察侧信道；可过滤字段必须登记在 topic schema 中。

### 4.2 订阅 API

**[设计建议]** 后端 RPC 和 UI Bridge 共用语义，传输层可分别使用 stdio notification 和 MessagePort notification。

```ts
interface SubscribeEventsInput {
  topics: string[];
  filter?: PublicEventFilter;
  scope?: InvocationScope;              // 只能收窄当前绑定范围
  mode?: "live" | "snapshot_live";
  snapshot?: {
    queryId: string;
    input: JsonValue;
  };
  delivery?: {
    maxRatePerSecond?: number;           // 只能低于宿主上限
    includeInitialState?: boolean;
  };
}

interface SubscribeEventsResult {
  subscriptionId: string;
  mode: "live" | "snapshot_live";
  snapshotFence?: {
    resources: Array<{ type: string; id: string; version?: number }>;
  };
  delivery: {
    maxFrameBytes: number;
    queueEvents: number;
    queueBytes: number;
  };
}
```

- **[设计建议]** 动态订阅只在当前 runtime/UI session 有效；后端 Manifest 订阅可持久化到 `plugin_event_subscriptions`，但每次 runtime 恢复仍重新做授权和 scope 绑定。
- **[设计建议]** `scope` 只能从当前 invocation scope 收窄，不能把 `projectId` 改成其他项目或把 user scope 升级成 global。
- **[设计建议]** 宿主把实际 rate/queue 上限返回给插件；插件声明更小值可以被接受，不能协商提高硬上限。
- **[设计建议]** 订阅返回后，事件交付使用 `PublicEvent` 或控制事件 `narrafork.events.overflow/resync_required`；不混入内部 narrator WS message type。

### 4.3 snapshot + live 的无缝交接

**[设计建议]** `snapshot_live` 遵循当前 narrator WS catch-up 的“先标记订阅、查询期间缓冲、发送快照后排空”思想，但使用 PublicEvent/Query DTO：

```text
1. 创建 subscription，先进入 catchingUp 状态
2. 读取资源版本 fence（已有 messageVersion/updatedAt 或查询返回的 asOf）
3. 从此刻起把匹配 live event 放入有界缓冲
4. 执行授权后的 snapshot Query，使用 cursor 分页
5. 返回 snapshot pages + snapshotFence
6. 只交付 fence 之后的事件，去重同一 resourceVersion/eventId
7. 缓冲溢出或 fence 无法确认 → 发送 resync_required，要求重新 snapshot
```

- **[设计建议]** 快照 Query 的授权条件、filter 和 scope 必须与 live 订阅完全一致；不能用更宽的后台权限查询再交给插件。
- **[设计建议]** 多资源快照使用 per-resource fence，不承诺跨 project/chapter/narrator 的全局时间顺序。
- **[设计建议]** 快照页本身不是 PublicEvent；如果插件需要知道页边界，使用 `snapshot.page` 控制消息，不能伪造 lifecycle event。
- **[当前事实]** 现有 narrator WS 在 catch-up buffer 超过 1000 条或 2MB 时发送 `full_reload`；公共 Event Gateway 建议采用同样的“有界后全量 resync”降级，而不是无界扩容。

### 4.4 增量、重连和游标

- **[设计建议]** 对状态型资源，事件携带 `resourceVersion` 或 `updatedAt` fence；插件收到跳号、旧版本或版本无法解释时调用对应 Query，而不是自行推断。
- **[设计建议]** 对 append-only 资源，Query 使用宿主生成的 opaque cursor；cursor 绑定 queryId、filter、scope、schemaVersion 和过期时间，插件不能修改内部 JSON 后重新提交。
- **[设计建议]** v1 的 `deliverySeq` 只用于本订阅内检测漏帧，不支持跨重启 replay；重连流程是重新订阅并请求 snapshot/resync。
- **[设计建议]** 若未来有 durable event log，cursor 必须同时绑定 tenant/resource authorization snapshot，权限撤销后旧 cursor 不能继续读取历史事件。
- **[设计建议]** 删除使用公开 tombstone（resource type/id、deletedAt、reason code），不发送被删除资源的最后正文或 secret；恢复/重建由 Query 查询当前状态。

### 4.5 Query page envelope

**[设计建议]** 公共 Query 返回统一 envelope：

```ts
interface QueryResult<T> {
  schema: "narrafork.query-result";
  schemaVersion: 1;
  queryId: string;
  requestId: string;
  data: T;
  page?: {
    hasMore: boolean;
    nextCursor?: string;
    limit: number;
  };
  asOf?: string;
  stale?: boolean;
  redaction: "public" | "user_scoped" | "admin_scoped";
}
```

- **[设计建议]** `hasMore` 使用 `LIMIT n + 1` 推导；不为普通列表先执行昂贵 `COUNT(*)`。
- **[设计建议]** cursor 不允许插件指定 SQL order、offset 或任意 sort expression；每个 queryId 固定有限排序，例如 `(updatedAt,id)` 或 `(seq,messageId)`。
- **[设计建议]** `stale=true` 只表示使用 last-known cache（例如 provider model catalog），不表示权限或数据完整性降低；调用前仍重新检查授权。
- **[设计建议]** 详情 Query 可没有 page，但仍要有 byte limit、字段 projection 和超时；大正文用受控流/附件接口，不用一次性 JSON response。

## 5. Query API 目录与 DTO 规则

### 5.1 v1 Query 目录

**[设计建议]** Query ID 使用 `narrafork.<resource>.<verb>`，完整目录由 Host API registry 固定；插件不能提交任意方法名。

| Query ID | 返回摘要 | 关键 scope/能力 |
|---|---|---|
| `narrafork.projects.list` | 项目 id/name/status/updatedAt | `query.read.projects` |
| `narrafork.projects.get` | 单项目基本信息和安全摘要 | project read |
| `narrafork.projects.graph` | 有界节点/边摘要、cursor/subgraph | project graph read |
| `narrafork.chapters.list` | chapter id/title/status/role/projectId/commitCount | project read |
| `narrafork.chapters.get` | 单章节摘要、parent/merge/review 引用 | chapter read |
| `narrafork.chapter-edges.list` | edge id/source/target/type/metadata 摘要 | project graph read |
| `narrafork.narrators.list` | narrator id/title/type/status/substatus/chapterId | user/narrator read |
| `narrafork.narrators.get` | narrator 状态、模型/permission mode 摘要、版本 | narrator read |
| `narrafork.narrator.messages.page` | message id/role/time/size/status/version 摘要 | narrator messages read |
| `narrafork.narrator.message.get` | 单消息有限正文/安全 block projection | `query.read.message_content`，独立 byte limit |
| `narrafork.narrator.permissions.pending` | requestId/toolName/risk/state 摘要 | narrator control/read |
| `narrafork.reviews.list` | review chapter/source/status/verdict | project/chapter read |
| `narrafork.background-tasks.list` | task id/type/status/outputBytes/time | narrator/task read |
| `narrafork.terminals.list` | terminal id/name/status/chapter/narrator | terminal read |
| `narrafork.devices.list` | device id/name/status/capability 摘要 | device read |
| `narrafork.providers.catalog.list` | provider instance/model descriptor page | provider read |
| `narrafork.settings.public.get` | 宿主明确公开的版本/feature/非 secret 设置 | `query.read.host_settings` |
| `narrafork.plugins.list` | plugin/package/contribution 状态摘要 | admin/plugin read |
| `narrafork.plugins.audit.page` | 审计摘要分页 | admin/audit read |

- **[设计建议]** `narrator.messages.page` 默认不读取 `contentJson`、tool input/output、sidecar 全文、raw dump、完整 reasoning continuation 和图片 base64；只返回 `hasContent/contentBytes/toolCallCount` 等摘要。
- **[设计建议]** `message.get` 仍不返回内部数据库 row；只允许 `projection = "text_summary" | "safe_blocks"` 等固定 profile，正文最大 64KiB，超过则返回 `truncated=true` 和 detail handle。
- **[设计建议]** `projects.graph`、`chapters.list`、`devices.list`、`providers.catalog.list` 都必须有 page/limit；不要因为插件是后台进程就放宽无上限读取。
- **[设计建议]** `plugins.audit.page` 对普通插件不可见；插件只能看到自身被允许的审计摘要，不能用审计 Query 读取其他插件、用户或 secret 轨迹。

### 5.2 Query 输入示例

```ts
interface ListChaptersInput {
  projectId: string;
  status?: Array<"active" | "dormant" | "merged" | "abandoned" | "frozen">;
  role?: Array<"trunk" | "branch" | "exploration" | "review">;
  cursor?: string;
  limit?: number;                  // 默认 50，最大 100
}

interface NarratorMessagesPageInput {
  narratorId: string;
  cursor?: string;
  limit?: number;
  projection?: "summary" | "safe_blocks";
  afterVersion?: number;
}
```

- **[设计建议]** query schema 使用 strict object；未知键、错误 enum、空 ID、超长数组、非法 cursor 和超限 limit 都返回 `INVALID_PARAMS`。
- **[设计建议]** `afterVersion` 只能作为资源版本优化提示，不能取代授权或 cursor；如果版本已不连续，返回 `stale/resyncRequired`。
- **[设计建议]** 资源 ID 先按宿主允许的格式校验，再查 DB；不把查询错误包装成“资源不存在”来掩盖权限边界，使用稳定的 `NOT_FOUND_OR_DENIED` 策略避免枚举侧信道。

## 6. Command API 与副作用语义

### 6.1 Command envelope

**[设计建议]** Command 使用统一输入/结果 envelope：

```ts
interface CommandRequest<T> {
  schema: "narrafork.command-request";
  schemaVersion: 1;
  commandId: string;
  requestId: string;
  correlationId: string;
  idempotencyKey?: string;
  expectedVersion?: number;
  deadlineAt: string;
  input: T;
}

type CommandResult<T> =
  | {
      schema: "narrafork.command-result";
      schemaVersion: 1;
      requestId: string;
      status: "succeeded";
      data: T;
      operationId?: string;
    }
  | {
      schema: "narrafork.command-result";
      schemaVersion: 1;
      requestId: string;
      status: "accepted" | "running" | "failed" | "cancelled" | "unknown";
      operationId?: string;
      error?: { code: string; message: string; retryable?: boolean };
    };
```

- **[设计建议]** `idempotencyKey` 1–128 bytes，宿主绑定 pluginId + commandId + invocation scope 并只存 hash；同 key 不得跨插件、用户或资源复用。
- **[设计建议]** 有副作用命令必须声明 `idempotent`、`retryable` 和 unknown-result 语义；宿主超时不能把“可能已经执行”改写为安全失败。
- **[设计建议]** 长操作（merge、review create、provider catalog refresh、文件/传输类动作）立即返回 `accepted + operationId`，进度/终态通过 Query 或 PublicEvent 获取。
- **[设计建议]** Command 返回值是业务 DTO，不是 service return row；敏感结果通过受控 handle，不能直接返回 secret/path/full output。

### 6.2 输入校验与核心服务映射

- **[设计建议]** HTTP/WS/stdio/UI Bridge 的入口都先做 frame/body size 检查，再做 JSON parse，再做 Zod/JSON Schema strict validation；不同传输不能有“HTTP 严格、RPC 宽松”的旁路。
- **[设计建议]** 宿主禁止 `__proto__`、`prototype`、`constructor` 等危险 key，拒绝 NaN/Infinity、循环对象、深度过大 JSON、未知字段、任意 URL scheme、绝对路径和 shell 字符串扩展。
- **[设计建议]** 文本、命令名、标题、说明、topic、filter、header、路径、modelId 和 URL 各自使用长度/字符/协议 allowlist；不要用一个全局 `z.string()` 代替领域校验。
- **[设计建议]** `narrafork.chapter.merge` 等命令调用现有服务的事务/回滚逻辑；插件不参与事务回调，不能在核心事务中执行 RPC。
- **[设计建议]** Command 执行后由核心服务发出语义事件；Event Gateway 不根据 Command response 猜测状态，避免“双重事实源”。

### 6.3 失败、取消和重试

- **[设计建议]** `PERMISSION_DENIED`、`INVALID_PARAMS`、`NOT_FOUND`、`CONFLICT`、`RATE_LIMITED`、`PLUGIN_DISABLED`、`TIMEOUT`、`CANCELLED`、`UNKNOWN_RESULT` 使用稳定 code。
- **[设计建议]** 取消沿 request tree 传播：UI/核心 AbortSignal → RPC cancel → 插件停止工作；宿主忽略迟到 response/event，并记录“cancel 未遵守”诊断。
- **[设计建议]** 只读 Query 可由调用方重试；幂等 Command 可使用相同 idempotency key 重试；未知副作用 Command 默认不自动重放。
- **[设计建议]** 插件崩溃后，未产生副作用的 accepted 前调用可失败重试；已经暴露 tool/提交/写入语义的调用进入 `unknown` 或由核心服务恢复，不由 Plugin Manager 猜测。

## 7. 权限模型

### 7.1 Capability 命名

**[设计建议]** capability 使用分层、可列举的 ID，至少包括：

```text
plugin.install
plugin.enable
plugin.disable
plugin.upgrade
plugin.uninstall
plugin.grant
query.read.projects
query.read.chapters
query.read.narrators
query.read.message_summary
query.read.message_content
query.read.audit_self
query.read.audit_all
event.subscribe.chapter
event.subscribe.narrator
 event.subscribe.permission
 event.subscribe.provider
 command.narrator.send_message
 command.narrator.interrupt
 command.permission.decide
 command.chapter.write
 command.chapter.merge
 command.review.write
 command.routine.write
 provider.register
 provider.use
 provider.refresh_catalog
 config.read_self
 config.write_self
 secret.use_self
 storage.read_self
 storage.write_self
 storage.purge_self
 device.read
 device.command
 ui.panel
```

- **[设计建议]** 实际实现应消除示例中的空格并使用稳定常量，例如 `event.subscribe.narrator`；capability 不允许由插件运行时自定义通配符。
- **[设计建议]** `query.read.message_content`、`command.permission.decide`、`command.chapter.merge`、`secret.use_self`、`device.command` 等高风险能力默认不授予，需要管理员显式 grant 和资源 scope。
- **[设计建议]** capability 只表达“能否调用某类 API”，资源范围、字段投影、topic、路径、provider instance、速率和模型等限制放在 `constraints`/scope 中。

### 7.2 角色、scope 与 grant

- **[设计建议]** 管理员负责安装、启用、升级、卸载、purge 和 grant；普通用户只能在自身 core authority 允许时调用公共 Query/Command。
- **[设计建议]** 用户调用同时受核心业务 ACL、项目/章节归属、叙述者控制权和 plugin grant 限制；插件 grant 不能把普通用户提升为 admin。
- **[设计建议]** 后台 `plugin_background` principal 没有 user authority，只能使用 installation grant 指定的 global/project/provider scope；不能读取最近一次 UI 用户的 private narrator/message。
- **[设计建议]** scope 只能向下收窄：global → user/project/workspace/chapter/narrator/provider/device；不能把 narrator scope 合并成“所有 narrator”。
- **[设计建议]** grant 可有 expiration、constrained topic/field/rate 和 revoke reason；过期按撤销处理，不依赖插件主动刷新。

### 7.3 权限决定流程

**[设计建议]** 高风险 Command/Tool/Secret 的决定链路如下：

```text
插件请求 command/capability
  → Capability Broker 判断 grant + 当前 user authority + resource scope
  → 低风险且已明确授权：继续核心 service
  → 需要用户确认：进入核心 permission/danger reflection
  → 通过现有 UI/受控代理等待 user/admin decision
  → 记录 permissionDecidedBy/At 和 audit
  → 继续或拒绝命令
```

- **[当前事实]** 当前 `narrator_tool_calls` 已保存 `permissionDecidedBy`、`permissionDecidedAt`、deny message/reason 等权限审批字段；插件命令接入应复用现有权限事实源，不另造一套可以互相矛盾的审批状态。
- **[设计建议]** 插件不能在输入中提交 `approved=true`、`decidedBy=user` 或任意 permission token；决定者由宿主从认证连接和核心审批服务产生。
- **[设计建议]** 用户撤销、管理员撤销、插件禁用、runtime generation 改变或 request deadline 到期时，挂起权限请求应被取消/拒绝；不能在旧连接恢复后继续执行。
- **[设计建议]** 权限拒绝对插件返回稳定 code 和有限 reason；不要泄露“另一个用户拥有该资源”或内部策略细节。

### 7.4 事件订阅权限

- **[设计建议]** 订阅权限按 topic family + resource scope + projection 授予；`event.subscribe.narrator` 不自动包含 message content、permission input、tool output 或 provider secret。
- **[设计建议]** PublicEvent 在投递前再次做 resource authorization；项目归档、章节删除、用户登出、grant revoke 都可能使已建立订阅变成空订阅。
- **[设计建议]** background event subscription 必须显式声明“无用户上下文”，不能从某次 UI 订阅复制 scope；对于 user-scoped topic，没有用户 principal 时默认拒绝。
- **[设计建议]** 插件只能发布 `plugin.<pluginId>.*` 私有事件；不能伪造 `narrafork.*` 核心事件来触发其他插件或 UI。

## 8. 脱敏与隐私规则

### 8.1 字段分类

**[设计建议]** 公共 DTO 字段分四类：

| 类别 | 例子 | 默认处理 |
|---|---|---|
| A：稳定公开标识 | resource ID、status、role、createdAt、版本摘要 | 在资源授权后可返回 |
| B：用户/项目元数据 | title、username、project name、branch、commit SHA | 需要对应 scope/field grant |
| C：操作摘要 | toolName、duration、outputBytes、error code | 返回有界摘要，去除正文 |
| D：秘密/大字段 | API key、JWT、cookie、cwd、绝对路径、contentJson、raw dump、tool input/output、终端输出 | 默认禁止；专门 capability + detail/handle |

- **[设计建议]** actor.id、username、branch、commit SHA、真实 cwd、文件路径和 provider request ID 都按用途最小化，不因为“不是 secret”就默认公开。
- **[设计建议]** 错误 message、诊断、响应 header 和 provider metadata 采用安全 allowlist；HTML/JSON body 只能有短 snippet，禁止完整上游响应。
- **[设计建议]** 对路径可返回 repo-relative path 或 opaque file handle；默认不返回 `worktreePath`、用户 home、远程设备真实路径。
- **[设计建议]** Secret mask 统一使用 `maskSecret` 类似语义，响应中只出现 `configured`、长度/指纹或最后 4 位等必要信息；插件不能根据 mask 结果反推原值。

### 8.2 大字段策略

- **[设计建议]** 公共事件只带 `hasContent/contentBytes/outputBytes` 等摘要；完整消息、工具输出、日志、diff、图片和 raw dump 使用 detail Query/附件 handle，并有单独 capability、字节上限、分页/流式、超时和取消。
- **[设计建议]** 即使插件拥有内容读取能力，详情 API 也只返回 projection profile；不能请求任意 JSON Pointer 读取未来新增敏感字段。
- **[设计建议]** 文件分享、HTML sanitize、压缩/解压、哈希和大 JSON 处理按 CLAUDE.md 放后台 worker/subprocess 或设置硬限制，不在 Event Gateway/Query handler 同步完成。

## 9. 背压、节流与交付可靠性

### 9.1 事件队列

- **[设计建议]** 每个 subscription 一个 bounded queue，同时有每插件总 queue；入队计算 event JSON UTF-8 bytes，不以对象数量替代 byte limit。
- **[设计建议]** normal event 使用 credit/window；`error`、`overflow`、`resync_required`、命令终态和取消确认使用 control reserve，避免普通事件耗尽队列后无法结束。
- **[设计建议]** 事件处理器不直接 await 插件 handler；插件 ACK/消费只影响其自身 credit，不阻塞核心 `eventBus.emit()`。
- **[设计建议]** 队列高水位时暂停普通事件 credit、合并 state、降低 progress 采样；硬上限触发 overflow/resync，持续违规的插件进入 degraded/quarantine。
- **[设计建议]** 严格按 subscription/resource/topic 保持单调顺序；不同 subscription、不同资源之间不承诺全局顺序。

### 9.2 节流与合并

- **[设计建议]** 状态事件按 `(subscriptionId, topic, resourceId)` 合并为最新状态；progress 默认 100–300ms 窗口或百分比变化阈值；transfer progress 不得每个文件/byte 广播。
- **[当前事实]** 当前 narrator WS 对 terminal/container/browser 计数使用约 100ms debounce，对 browser visual change 使用约 300ms debounce；插件 Event Gateway 可复用该数量级作为初始策略，但需按插件队列单独实现。
- **[设计建议]** `message.changed` 只发送 message metadata/version，不发送每个 token delta；模型流、终端输出和日志必须使用专门流或摘要。
- **[设计建议]** 节流窗口内发生权限请求、命令终态、错误、取消或资源删除时立即 flush terminal event，不能被普通 debounce 延迟到过期。

### 9.3 恢复语义

- **[设计建议]** PublicEvent v1 默认 at-most-once：丢失时发送 overflow/resync hint，插件主动 Query；不自动重放可能有副作用的 Command。
- **[设计建议]** 插件重启后先恢复静态 subscription，再按 `snapshot_live` 做对账；如果没有对应 Query 或权限已变化，订阅保持 paused 并报告诊断。
- **[设计建议]** UI panel 隐藏时暂停非关键事件并合并状态；后台 topic 需要单独 grant 和 resource budget，不能因为 iframe 仍在 DOM 中就无限运行。
- **[设计建议]** 事件 delivery audit 记录 overflow、drop/coalesce count、last delivery time 和原因，不记录每个高频 event 正文。

## 10. 审计与慢操作

**[设计建议]** 每次公共调用至少写以下审计摘要：

```ts
interface PluginAuditSummary {
  pluginId: string;
  contributionId?: string;
  runtimeId?: string;
  requestId?: string;
  correlationId: string;
  principalKind: "user" | "plugin_background" | "system";
  userId?: string;
  capability?: string;
  methodId: string;
  resourceType?: string;
  resourceId?: string;
  scopeType?: string;
  scopeId?: string;
  outcome: "allowed" | "denied" | "succeeded" | "failed" | "timeout" |
    "cancelled" | "unknown" | "overflow";
  durationMs?: number;
  requestBytes: number;
  responseBytes: number;
  redactedSummary?: Record<string, JsonValue>;
}
```

- **[设计建议]** Query/Command 慢于 1000ms 时沿用 `server/app.ts` 的 slow API 诊断思路记录结构化慢操作；插件 RPC 另记录 queue wait、activation time、handler time、serialization time。
- **[设计建议]** 记录拒绝原因、grant revision、scope resolution 和 schemaVersion，便于解释“为何权限看起来已授予但本次失败”。
- **[设计建议]** 审计 writer 不应在公共事件同步路径做大事务；可使用小批量/异步队列，队列满时保留权限拒绝、命令终态、secret 访问和 lifecycle 记录，丢弃可重建的高频 delivery 统计。
- **[设计建议]** 审计 Query 默认只返回摘要字段并分页；管理员下载完整诊断需独立授权、过期 handle、字节上限和流式输出。

## 11. 与现有核心文件的接入映射

| 当前内部位置 | 插件公共替代 | 接入规则 |
|---|---|---|
| `server/lib/event-bus.ts` | `PublicEventGateway` | 原始事件只在核心映射，插件无 `onAny` |
| `server/websocket/narrator-ws.ts` | Event/UI Bridge subscription | 不共享 connections、presence、catch-up buffers 或 raw socket |
| `server/websocket/narrator-ws-types.ts` | PublicEvent/Query/Command DTO | 不复用 `NarratorServerMessage` |
| `server/app.ts` | 静态 `/api/plugins` 路由 | 不允许运行期注册 Hono handler/middleware |
| `server/routes/settings.ts` | `PluginConfigService`/Secret Broker | 不把 `settingsRoutes.patch` 作为任意 plugin config API |
| `server/lib/settings/index.ts` | DB-backed plugin config | 不让插件读 singleton、settings 文件或 JWT secret |
| `server/db/schema.ts` | plugin_* 表 + service facade | 仅核心 service 访问，按 schema migration 规则添加 |
| `narratorService`/chapter/review service | Query/Command facade | DTO、scope、授权、审计后调用，不暴露 service method table |
| `narratorToolCalls` permission fields | permission/command decision | 复用核心审批事实源，插件不能伪造决定者 |

- **[设计建议]** 任何跨服务通信仍通过核心类型化 eventBus；插件只收到 Gateway 映射后的 DTO。插件若要触发副作用，调用 Command API，由核心 service 发布事件。
- **[设计建议]** `server/app.ts` 的全局 `requireAuth` 保持在插件业务路由之前；插件运行时自身身份通过宿主连接绑定，不把普通用户 Bearer token 复制到插件进程。
- **[设计建议]** 代表性服务中的全表扫描/大字段访问不能因为“插件 Query”而放宽；公共 API 是性能策略的执行边界，不是内部查询的别名。

## 12. 设计结论与待决策

### 12.1 结论

- **[设计建议]** PublicEvent 使用版本化、白名单、资源化、脱敏 envelope；原始 eventBus/narrator WS 永远留在核心。
- **[设计建议]** snapshot + live 使用资源版本 fence 和有界 catch-up；overflow 后 `resync_required + Query`，v1 不承诺可靠事件重放。
- **[设计建议]** Query 使用固定 DTO、projection、cursor + `LIMIT n + 1`、大小/超时限制；Command 使用业务意图、idempotency、operationId、unknown-result 和核心权限链路。
- **[设计建议]** 权限按 plugin grant、capability、当前用户 authority、scope、contribution policy 取交集；后台插件不继承用户身份，secret 不随普通配置/事件/日志传播。
- **[设计建议]** 事件/查询/命令均有输入校验、审计、脱敏、背压、节流、取消、慢操作和资源上限，保证不违反 Bun/SQLite 主线程性能规则。

### 12.2 待决策

- **[待决策]** v1 是否增加 durable PublicEvent log、cursor replay 和 at-least-once delivery；本文默认不增加。
- **[待决策]** UI Bridge 与后端 RPC 的事件 credit/ACK 是否完全统一，还是由各传输使用等价但不同的窗口参数。
- **[待决策]** message content、terminal output、diff、attachment handle 的后续专门 API 是否首版开放，以及各自 grant/保留策略。
- **[待决策]** provider quota、device 状态、project shared visibility 的默认多用户策略。
- **[待决策]** 最终 capability 常量、Manifest event filter schema、Query/Command ID 版本和兼容窗口。
