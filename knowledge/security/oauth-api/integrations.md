---
id: security.oauth-api.integrations
title: 集成授权层
summary: OAuth 与插件共用的授权层：能力目录与适配器、授权内核（主体/作用域/约束/判定）、authority 与 grants 存储、资源绑定、事件分发、审计与设置页摘要。
anchors:
  - server/lib/integrations/
  - shared/integrations/
  - server/services/integration-authority-service.ts
  - server/services/integration-authorization-service.ts
  - server/services/integration-authority-invalidation.ts
  - server/services/integration-event-dispatcher.ts
  - server/services/integration-resource-binding-service.ts
  - server/services/integration-resource-service.ts
  - server/services/integration-audit-service.ts
  - server/services/integration-summary-service.ts
  - server/routes/integrations.ts
  - server/lib/validators/integrations.ts
  - frontend/lib/api/integrations.ts
  - frontend/routes/settings/integrations.tsx
keywords:
  - /api/integrations/summary
  - /settings/integrations
  - integration_authorities
  - integration_capability_grants
  - integration_resource_bindings
  - integration_audit_events
  - 集成授权层
  - 集成与扩展
  - 能力目录
  - CANONICAL_CAPABILITY_DESCRIPTORS
  - OAUTH_SCOPE_CAPABILITY_ADAPTER
  - PLUGIN_CAPABILITY_ADAPTER
  - evaluateAuthorization
  - AuthorizationEvaluator
  - AuthorizationDecisionCache
  - authorityRevision
  - INTEGRATION_AUTHORIZATION_DENIED
  - INTEGRATION_AUTHORITY_CONFLICT
  - INTEGRATION_GRANT_LIMIT_EXCEEDED
  - integrationAuthorityService
  - integrationAuthorizationService
  - integrationResourceBindingService
  - integrationEventDispatcher
  - IntegrationEventDispatcher
  - narrafork.events.overflow
  - narrafork.events.resync_required
  - authority_revision_mismatch
  - scope_relation_unknown
  - constraints_not_satisfied
  - provisionKey
  - orphaned
  - attentionLimit
  - orphaned_resources
status: draft
verified_at: 776dbf07e
---
# 集成授权层

OAuth 授权和插件安装共用的一层授权基础：一份规范的能力目录、一个纯函数式的授权内核、一组把授权持久化并带修订号的服务，加上资源归属、事件订阅分发、审计和设置页摘要。OAuth 协议本身（授权码、令牌）在 [OAuth 服务端](oauth-server.md)，对外接口在 [External API v1](external-v1.md)；插件侧的授权存储与能力代理见 [插件授权与密钥](../../automation/plugins/permissions-secrets.md)。

## 分层
- **能力目录与主体/资源类型**（`shared/integrations/`）：`capabilities.ts` 的 `CANONICAL_CAPABILITY_DESCRIPTORS` 是唯一的规范目录，每项有资源类型、动作（read/write/execute/manage）、风险级别、是否持久资源、是否远程执行、允许的主体类型、默认脱敏与限速类别、`i18nKey`（`integrations.capabilities.<id>`，前端 locales 里暂无对应键）。`remoteExecution` 只允许 execute/manage 动作。`principals.ts` 定义主体类型（user、oauth_client、oauth_grant、plugin、plugin_installation、plugin_runtime、device、system）和凭据类型（session、oauth_token、plugin_credential、runtime_credential、device_credential、system），凭据只认证主体、不是主体。`resources.ts` 定义资源引用与作用域（`global` 或某类型+id）、包含关系的三态结果 `contains / not_contains / unknown`；`events.ts` 定义事件 topic 与订阅形状。
- **适配器**（`server/lib/integrations/capability-adapters.ts`）：OAuth scope 与插件协议字符串都映射到规范描述符。OAuth 侧是恒等映射；插件侧是显式表（如 `plugin.install` → `integration.install`、`query.read.projects` → `project.read`、`search.provide` → `provider.search`），每项标 `integration` 或 `internal-only`，后者不得暴露到公共集成面。未知字符串返回 `undefined`（失败即关闭）。适配必须一一可逆：两个协议串不能共享同一个描述符。
- **内核**（`server/lib/integrations/kernel/`）：`AuthorizationEvaluator`（`authorization.ts`）对内存里的快照做确定性判定，无副作用；`catalog.ts` 是冻结的描述符注册表（最多 512 项、重复即抛错）；`limits.ts` 是约束（topics/methods/paths/fields/providerIds/resourceIds 数组各最多 100 项且唯一，`maxBytes` ≤ 64 MiB，`maxRatePerSecond` ≤ 10000）；`scope.ts` 是作用域匹配；`cache.ts` 是判定缓存；`event-dispatcher.ts` 是订阅分发器。
- **服务层**：authority/授权/失效/事件分发/资源绑定/审计/摘要七个服务，见下。

## 判定顺序（`AuthorizationEvaluator.evaluate`）
严格按阶段，先到先拒，拒绝带阶段与码（`types.ts` 的 `AUTHORIZATION_DENIAL_CODES`）：
1. deadline：`now > deadlineAt` → `deadline_exceeded`。
2. state：authority 不是 `active` → `authority_inactive`。
3. revision：上下文与快照的 authority id/修订、主体、凭据必须一致，所有 grant 也必须属于同一修订，否则 `authority_revision_mismatch` / `authority_subject_mismatch` / `authority_credential_mismatch` / `grant_revision_mismatch`。
4. capability：目录里没有 → `unknown_capability`；主体类型不在 `allowedSubjects` → `subject_not_allowed`；没有该能力的 grant → `capability_not_granted`。
5. scope：请求作用域必须被绑定作用域之一包含（否则 `scope_not_bound`），并被某条 grant 的作用域包含（否则 `scope_not_granted`）。
6. resource：描述符资源类型必须等于请求资源类型（`resource_type_mismatch`），资源必须同时在请求作用域、绑定作用域、grant 作用域里（`resource_not_in_scope`）。
7. constraints：任一 grant 的约束被满足即放行；有约束的 grant 要求操作声明每个受限维度并落在范围内，否则 `constraints_not_satisfied` 并带 `failedConstraint`。
- 关系为 `unknown`（跨类型归属没有可信解析器证明）一律拒绝，码为 `scope_relation_unknown` / `resource_relation_unknown`。同类型只按 id 精确相等判断包含；`global` 包含一切。
- 内核本身不查数据库：跨类型包含（如叙述者属于项目）由调用方通过 `relationResolver` 提供。

## authority 与 grants（`integration-authority-service.ts`）
- 表 `integration_authorities`：持久的授权根，id 就是 OAuth 授权 id / 插件安装 id；`kind` 为 `oauth_grant` 或 `plugin_installation`，状态 `active/suspended/revoked/expired`，带递增的 `revision`、`policyJson`、`metadataJson`、`expiresAt`。表 `integration_capability_grants`：能力 + 作用域 + 可选约束，同一 authority 内（能力, scopeKey）在未撤销行上唯一。
- 所有修改以 `expectedRevision` 做乐观并发，不符抛 409 `INTEGRATION_AUTHORITY_CONFLICT`；每次修改修订号 +1。接口：`applyInTransaction`（调用方在自己的事务里创建/更新，OAuth 同意用它）、`create`、`replaceGrants`、`revokeGrants`、`setState`（不能设为 revoked，已撤销的不可改）、`revoke`（撤销全部 grant 并置 revoked）、`listForIntegration`、`repairOAuthSourceGrantId`。非 active 的 authority 不能改 grants。
- 界限：每个 authority 最多 2000 个 grant（超出 500 `INTEGRATION_GRANT_LIMIT_EXCEEDED`）；policy 8 KiB、metadata 8 KiB、约束 4 KiB；JSON 深度 ≤ 6、键 ≤ 128、数组 ≤ 100、字符串 ≤ 4 KiB，禁用 `__proto__`/`prototype`/`constructor`；grant 必须是规范能力 id。
- 读取：`getSnapshot` 走 worker 读（`worker-required`），SQLite 下用领域任务 `platformIntegrationAuthoritySnapshot`；`active` 但已过 `expiresAt` 的 authority 读出时当 `expired`；已过期/撤销的 grant 默认不读。库里引用了已从目录移除的能力或资源类型的老 grant 会被过滤掉（`isDescribableGrant`），不会让整个 authority 加载失败，下次替换 grants 时才会真正撤销。`getCommittedDisplaySnapshot` 给详情页用，要求已提交的文件库，一次查询带回策略与 grant 列表。
- 修改后经 `integration-authority-invalidation.ts` 发出失效事件（带 `reason`，监听器各自 try/catch，不能回滚已提交的修改），并 fire-and-forget 写一条审计。监听器有两个：授权缓存（清该 authority 的缓存）和事件分发器（active 时重新校验，否则撤销订阅）。

## 授权服务（`integration-authorization-service.ts`）
- `authorize` 取 authority 快照，构造绑定的执行上下文，调用内核；`require` 在拒绝时抛 403 `INTEGRATION_AUTHORIZATION_DENIED`（带决定）。默认截止时间为现在 + 5 秒。
- 缓存：4096 项、30 秒 TTL，只缓存放行结果，且仅当快照修订等于请求修订且状态 active 才读缓存；键由 authority、修订、主体、凭据、运行时（含 generation）、操作、能力、资源、作用域、绑定作用域与约束摘要组成。按 authority / 凭据 / 运行时分区失效。
- authority 不存在 → `authority_inactive`，以 system 主体审计。除 `event.deliver` 的放行外，每次判定（放行或拒绝）都写审计。
- 主体映射：`oauth_grant` authority 的主体是 `oauth_client:<客户端 id>`、凭据 `oauth_token:<授权 id>`；`plugin_installation` 的主体是 `plugin_installation:<id>`、凭据 `plugin_credential:<id>`。
- 注意 `server/lib/integrations/principals.ts` 是插件调用作用域那条线用的另一份主体 schema（含 `plugin_background`，由 `resource-scope.ts` 引用，给插件服务用），与内核使用的 `shared/integrations/principals.ts` 不同；`resource-scope.ts` 的 `RESOURCE_SCOPE_FIELD_BY_TYPE` 是资源类型到绑定上下文字段的唯一映射。

## 事件分发（`kernel/event-dispatcher.ts` + `integration-event-dispatcher.ts`）
- 全进程共享一个 `integrationEventDispatcher`：OAuth 外部 WebSocket 与插件事件网关都向它注册订阅。每次订阅与（超过校验 TTL 的）投递都会重新授权：对每个 topic 以 `event.subscribe` 能力、`event:<topic>` 资源、`topics` 约束调用授权服务；拒绝则撤销订阅。授权校验 TTL 默认 1 秒（上限 30 秒）。
- 队列（每订阅）：默认 100 条 / 256 KiB / 每秒 100 条，上限 1000 条 / 2 MiB；单事件不得超过 256 KiB；全局最多 2048 个订阅、并发投递 64、每秒 2000 次分发；topic 最多 32 个。
- 合并：`eventClass` 为 `state` 或 `progress` 的事件按 topic+资源合并，只保留最新一条。
- 溢出：队列装不下或序列化失败时订阅进入 `overflowed`，丢队列、记审计，并向控制队列（最多 4 条）放 `narrafork.events.overflow` 与 `narrafork.events.resync_required` 两个控制事件，通知消费者重新同步；之后的事件只计入 `dropped`。投递回调抛错会撤销订阅（`delivery-failed`）。
- 失效入口：`revokeAuthority`、`invalidateAuthority`（重校验）、`invalidateCredential`、`invalidateSession`、`invalidateSubject`、`invalidateConnection`、`invalidateRuntime`；订阅按 topic、authority、运行时、连接、凭据、会话、主体建索引。

## 资源绑定（`integration-resource-binding-service.ts`）
- 表 `integration_resource_bindings`：为“集成创建的资源”（目前仅 `device`、`narrator`）记录稳定归属：来源类型（`oauth_client` / `plugin` / `first_party`）、权限主体类型（`oauth_grant` / `plugin_installation` / `user` / `system`）、状态 `active/revoked/orphaned/deleted`、`provisionKey`、修订。来源与 authority id 故意不设外键，授权、用户、插件删除后审计身份仍在。
- 唯一性：每个资源至多一条绑定；`(authorityId, resourceType, provisionKey)` 唯一，用来让 provision 接口幂等。
- 状态迁移：`markOrphaned(authorityType, authorityId)`（授权被撤销时调用，按 100 条一批、批间让出事件循环）、`markRevoked`（设备撤销）、`markDeleted`（资源删除；叙述者删除时在调用方事务里用 `markDeletedInTransaction`）。每次迁移写审计，聚合迁移写一条汇总审计。创建用 `createInTransaction`，要求目标资源存在。
- 回填：`backfill` 从 `remote_devices.oauthOwnerGrantId` 与 `narrators.oauthOwnerGrantId` 这两个迁移期影子列分页（游标 + `limit+1`）补绑定；启动时 `backfillIntegrationResourceBindingsOnStartup` 按 100 条一批、最多 10000 行（硬上限 100000）、批间 `setTimeout(0)` 让出，PostgreSQL 后端下整条路径被关闭。
- 读取方：OAuth 资源归属判定、设备/叙述者运行时策略、git 工作区访问、文件引用、设备服务、权限判定里对设备的目标解析，都经 `integrationResourceBindingService.get` 判断“这个资源是否由哪个授权创建”。
- `integration-resource-service.ts` 是对外的项目/设备摘要投影与分页查询（`listIntegrationProjects`，游标 + 上限 101，`name_asc` 或 `updated_desc`），OAuth 与插件共用，不含大字段。

## 审计（`integration-audit-service.ts`）
- 表 `integration_audit_events`：主体 × 凭据 × 能力 × 资源 × 作用域 × 结果（`allowed/denied/succeeded/failed/revoked/overflow`）、原因码、耗时、请求/响应字节、元数据（≤ 4 KiB，不得含密钥）。高频的投递成功不入库，只记控制、拒绝、失败与有界的操作摘要。
- 读取：`listByAuthority` 游标分页，每页最多 100 条，读走 worker。当前没有路由直接暴露它。

## 设置页摘要
- `GET /api/integrations/summary?attentionLimit=`（`routes/integrations.ts`，会话门之后；`attentionLimit` 1–20，默认 8，严格校验）→ `integration-summary-service.ts:getIntegrationSummary`。
- 所有登录用户：自己的已连接应用数（active/revoked）与能力目录计数（OAuth、插件、两者共有的规范能力数，只数 `integration` 可见的适配项）。管理员另得插件、OAuth 应用、设备（在线/离线/OAuth 创建/孤儿）、外部资源（按绑定状态与类型）的计数。非管理员的 `admin` 字段为 `null`。
- 注意项（`attention`，按顺序）：`orphaned_resources`（critical，→ `/settings/connected-apps`）、`plugin_attention`（warning，→ `/settings/plugins`）、`offline_devices`（info，→ `/settings/devices`），再按 `attentionLimit` 截断。插件摘要读取失败时记日志并返回零值。所有计数都走 worker 读。
- 前端：`routes/settings/integrations.tsx`（`/settings/integrations`）+ `lib/api/integrations.ts:getIntegrationSummary`；文案键在 `settings` 命名空间的 `integrations*`，注意项文案键是 `integrationsAttention_<id>`。

## 从哪读起
- `shared/integrations/capabilities.ts`：目录；`server/lib/integrations/kernel/authorization.ts`：判定。
- `server/services/integration-authorization-service.ts`：把快照喂给内核。
- `server/services/integration-authority-service.ts`：修订、grants、失效。
- 测试：`tests/server/lib/integrations/`（内核、缓存、事件分发、适配器、作用域）、`tests/shared/integrations/`、`server/services/__tests__/integration-*.test.ts`。

## 改它时
- 加一个规范能力：在 `shared/integrations/capabilities.ts` 用 `capability(...)` 登记（id 须匹配 `capabilityIdSchema`，i18nKey 自动生成），再在 `capability-adapters.ts` 的 OAuth 或插件表登记；测试 `tests/shared/integrations/capabilities.test.ts`（描述符严格、唯一、自洽）与 `tests/server/lib/integrations/capability-adapters.test.ts`（每个 OAuth scope 恒等映射、每个插件能力都被覆盖、未知串失败即关闭）。
- 加一种资源类型：`CAPABILITY_RESOURCE_TYPES` 与 `resource-scope.ts:RESOURCE_SCOPE_FIELD_BY_TYPE` 一起改，两者必须一一对应（反向表构造时遇重复字段会抛错）。
- 加一种约束维度：`kernel/limits.ts` 的 schema、`constraintsAllow`、摘要计算，以及 `integration-authority-service.ts:integrationGrantConstraintsSchema` 要同步。
- 改判定阶段或拒绝码：`kernel/types.ts`、`authorization.ts`，测试 `tests/server/lib/integrations/kernel/authorization.test.ts`；缓存键字段变了要改 `kernel/cache.ts`，测试 `cache.test.ts`。
- 任何改 authority/grants 的路径都必须 `expectedRevision` + 经 `emitIntegrationAuthorityInvalidation`，否则缓存与订阅不会失效；测试 `server/services/__tests__/integration-authority-service.test.ts`、`integration-authorization-service.test.ts`。
- 新增集成创建的资源类型：`integrationResourceBindings` 的 `resourceType` 枚举、`requireResource`、回填与迁移期影子列一起处理；测试 `integration-resource-binding-service.test.ts`。
- 新增表或列：走 schema 迁移，并核对数据导入/导出兼容。
- 改摘要字段：后端 `IntegrationSummary` 与前端 `lib/api/integrations.ts` 的同名类型是手工两份，要同步；新增 `attention` 项还要补 `integrationsAttention_<id>` 的 en/zh-CN 文案键；测试 `integration-summary-service.test.ts`。
- 不变量：未知关系一律拒绝；授权判定先查 authority 修订；审计元数据有界；资源绑定与授权不设外键，保留审计身份。

## 相关
- [OAuth 服务端](oauth-server.md)
- [External API v1](external-v1.md)
- [插件授权与密钥](../../automation/plugins/permissions-secrets.md)
- [工具调用审批](../tool-permissions/index.md)
