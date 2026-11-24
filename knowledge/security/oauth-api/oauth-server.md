---
id: security.oauth-api.oauth-server
title: OAuth 服务端
summary: OAuth 2.0 授权服务器：授权码 + PKCE、令牌与 TTL、scope 集合、应用与授权管理、客户端清单与策略、限流与安全事件、撤销。
anchors:
  - server/lib/oauth-provider.ts
  - server/routes/oauth.ts
  - server/routes/oauth-apps.ts
  - server/routes/oauth-grants.ts
  - server/lib/oauth-client-policy.ts
  - server/lib/oauth-client-manifest.ts
  - server/lib/oauth-rate-limit.ts
  - server/lib/oauth-security-observability.ts
  - server/services/oauth-grant-service.ts
  - server/services/oauth-runtime-revocation.ts
  - server/middleware/auth.ts
  - frontend/lib/api/oauth-apps.ts
  - frontend/lib/api/oauth-grants.ts
  - frontend/routes/admin/oauth-apps.tsx
  - frontend/routes/oauth/authorize.tsx
  - frontend/routes/settings/connected-apps.tsx
  - frontend/routes/settings/oauth-apps.tsx
keywords:
  - /api/oauth/authorize
  - /api/oauth/token
  - /api/oauth/revoke
  - /.well-known/oauth-authorization-server
  - /api/oauth-apps
  - /api/oauth/grants
  - /api/oauth/grants/revoke-batch
  - /api/oauth/grants/revoke-all
  - oauth_clients
  - oauth_grants
  - oauth_security_events
  - OAUTH_EXTERNAL_V1_SCOPES
  - OAUTH_APP_AVAILABLE_SCOPES
  - AUTHORIZATION_CODE_TTL_MS
  - REFRESH_TOKEN_TTL_MS
  - refresh_reuse_detected
  - token_issued
  - refresh_rotated
  - runtime_authorization_lost
  - rate_limited
  - narrafork.oauth-client
  - authenticateRequest
  - requireOAuthAuth
  - requireSessionAuth
  - SESSION_REQUIRED
  - backfillOAuthGrantAuthoritiesOnStartup
  - 连接的应用
  - OAuth 应用
  - 授权同意
status: draft
verified_at: 776dbf07e
---
# OAuth 服务端

NarraFork 自带一个 OAuth 2.0 授权服务器：管理员登记第三方应用，用户在同意页授权，应用换到访问令牌后只能调用 `/api/external/v1`（见 [External API v1](external-v1.md)）。它与第一方会话令牌是两条互不混用的认证路径。同意落库时，scope 和项目范围同时编译成统一授权层的 authority 与 grants（见 [集成授权层](integrations.md)）。

## 关键规则
- 授权码 + PKCE，只支持 `S256`；`token_endpoint_auth_methods_supported` 为 `none`（公共客户端）。授权码 10 分钟，访问令牌 1 小时，刷新令牌 30 天（`lib/oauth-provider.ts` 的 `AUTHORIZATION_CODE_TTL_MS`、`ACCESS_TOKEN_TTL_SECONDS`、`REFRESH_TOKEN_TTL_MS`）。授权码先消费再校验 PKCE，失败的兑换不能被反复试探。
- 路由（`routes/oauth.ts`，挂在 `/api/oauth`，在会话门之前，请求体上限 64 KiB，带限流）：`/.well-known/oauth-authorization-server`、`GET /authorize`（给同意页返回信息，无会话回 401）、`POST /authorize`（同意/拒绝）、`/token`、`/revoke`。
- scope 固定集合（`OAUTH_EXTERNAL_V1_SCOPES`）：`project.read`、`device.read/provision/rotate`、`narrator.read/provision/send_message/interrupt`、`event.subscribe`、`message.summary.read`、`message.content.read`；未知 scope 被拒。这些 scope id 同时就是统一能力目录里的 canonical capability id。
- 应用（client）由管理员管理：`/api/oauth-apps` 全部 `requireAdmin`，含导入导出。用户的授权记录由 `/api/oauth/grants`（注意挂在 `/api/oauth/grants`，不是 `/api/oauth-grants`）管理：列表、详情、`DELETE /:id`、`POST /revoke-batch`、`POST /revoke-all`，都以当前会话用户为准。
- 授权撤销历史保留：撤销的授权不复用，重新同意会新建一行（`oauth-grant-service.ts` 文件头）；单个授权最多关联 100 个项目。
- 同意落库（`oauth-grant-service.ts`）：同一事务里写 `oauth_grants` 与 authority。每个 scope 编译成两类 grant：一条作用域为 `integration:<授权 id>`，再对每个选中的项目各一条 `project:<id>`；`event.subscribe` 的 grant 带固定的事件 topic 约束。重新同意是对已有 authority 的修订更新，新授权要求 `expectedRevision: 0`。
- 旧数据迁移：`oauth_grants` 上的 `scopes` / `policyJson` 是只给迁移用的影子列，不得用于授权判断；启动时 `main.ts` 先跑 `backfillOAuthGrantAuthoritiesOnStartup` 再回填资源绑定。PostgreSQL 后端下这条路径被显式关闭；失败只记日志，没有 authority 的旧授权会被拒（`invalid_grant`），下次启动重试。
- 认证边界：`/api/external/v1` 在本路由内强制 `requireOAuthAuth`，不接受会话令牌；其余 `/api/*` 全部过 `requireSessionAuth`，OAuth 令牌落不到内部接口上；OAuth 主体永远过不了管理员检查（`middleware/auth.ts`）。每次请求都按令牌重查用户行与授权。
- 授权被撤销或收窄时，`oauth-runtime-revocation.ts` 会硬停所属叙述者的活动、清空排队消息并断开设备，使授权层缓存和事件订阅失效，并把该授权名下的资源绑定标为 orphaned。
- 客户端策略（`lib/oauth-client-policy.ts`）：授权上的策略与客户端上的策略取交集（`intersectOAuthClientPolicies`），交集为空即拒；策略含 `messageDetail` 上限、`allowRobotDiagnosticPreset` 等。外部权限模式只有 readOnly / dontAsk / bypassPermissions；headless 的 `bypassPermissions` 退回危险反思而不是无检查，灾难性命令仍被拒。
- 客户端清单（`lib/oauth-client-manifest.ts`）：管理员导入导出的可移植注册描述，kind `narrafork.oauth-client` 版本 1，只含公共客户端、`authorization_code`+`refresh_token`、重定向 URI 1–20 个，不含密钥与数据库元数据。
- 限流（`lib/oauth-rate-limit.ts`，进程内令牌桶）：authorize 容量 60/每秒补 1，token 与 revoke 30/0.5，external-read 240/4，external-write 60/1；每个命名空间最多 4096 个键，超出并入同一溢出桶。键默认只含客户端 IP；`POST /authorize` 与 External v1 写操作另含 client、grant、user。触发限流记 `rate_limited` 安全事件。
- 安全事件（`lib/oauth-security-observability.ts`）：`token_issued`、`refresh_rotated`、`refresh_reuse_detected`、`token_revoked`、`rate_limited`、`runtime_authorization_lost`，计数并写 `oauth_security_events`。

## 前端
- `routes/oauth/authorize.tsx`：授权同意页（调 `GET/POST /api/oauth/authorize`）。
- `routes/settings/oauth-apps.tsx` + `lib/api/oauth-apps.ts`：管理员管理应用（scope 勾选、策略、导入导出）。`OAUTH_APP_AVAILABLE_SCOPES` 在前端另有一份。`routes/admin/oauth-apps.tsx` 只是跳转到 `/settings/oauth-apps`。
- `routes/settings/connected-apps.tsx` + `lib/api/oauth-grants.ts`：用户查看并撤销自己的授权。

## 从哪读起
- `server/lib/oauth-provider.ts`：授权码、令牌签发与校验。
- `server/middleware/auth.ts:authenticateRequest` 的 OAuth 分支。
- `server/services/oauth-grant-service.ts`：同意、撤销、列表。

## 改它时
- 加一个 scope：`lib/oauth-provider.ts:OAUTH_EXTERNAL_V1_SCOPES` 是唯一服务端来源（`OAUTH_SUPPORTED_SCOPES`、清单校验都派生自它）；它的 id 必须是 `shared/integrations/capabilities.ts` 里的 canonical capability id，并在 `lib/integrations/capability-adapters.ts:OAUTH_SCOPE_CAPABILITY_ADAPTER` 登记；前端 `lib/api/oauth-apps.ts:OAUTH_APP_AVAILABLE_SCOPES` 要手工同步；测试 `lib/__tests__/oauth-provider.test.ts`、`routes/__tests__/oauth*.test.ts`、`tests/server/lib/integrations/capability-adapters.test.ts`。
- 新增 `oauth_*` 表或列：走 schema 迁移（并核对数据导入/导出兼容）。授权撤销保留历史，不要复用已撤销的行；撤销/收窄后必须经 `oauth-runtime-revocation.ts` 硬停叙述者。
- 改限流：`lib/oauth-rate-limit.ts` 的桶参数与键构成，测试 `lib/__tests__/oauth-rate-limit.test.ts`。
- 改客户端策略字段：`oauth-client-policy.ts` 的归一化与交集、清单校验、前端应用编辑页一起改，测试 `lib/__tests__/oauth-client-policy.test.ts`、`routes/__tests__/oauth-apps.test.ts`。
- 不变量：OAuth 主体永远不是管理员；公共客户端只支持 S256 PKCE；撤销的授权行不复用。

## 相关
- [External API v1](external-v1.md)
- [集成授权层](integrations.md)
- [登录与会话令牌](../auth/index.md)
- [工具调用审批](../tool-permissions/index.md)
