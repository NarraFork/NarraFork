---
id: security.oauth-api
title: OAuth 与开放 API
summary: OAuth 2.0 应用与授权、External API v1。
anchors:
  - frontend/lib/api/integrations.ts
  - frontend/routes/settings/integrations.tsx
  - server/services/integration-authority-invalidation.ts
  - server/services/integration-summary-service.ts
  - server/services/integration-resource-service.ts
  - server/services/integration-resource-binding-service.ts
  - server/services/integration-authorization-service.ts
  - server/services/integration-authority-service.ts
  - server/services/integration-audit-service.ts
  - server/websocket/external-narrator-ws.ts
  - server/websocket/external-narrator-ws-types.ts
  - server/routes/oauth.ts
  - server/routes/oauth-apps.ts
  - server/routes/oauth-grants.ts
  - server/routes/external-v1.ts
  - server/lib/oauth-provider.ts
  - server/lib/oauth-client-policy.ts
  - server/services/oauth-grant-service.ts
  - server/services/oauth-ws-ticket-service.ts
  - server/services/oauth-narrator-runtime-policy.ts
  - server/services/oauth-runtime-revocation.ts
  - server/middleware/auth.ts
  - frontend/lib/api/oauth-apps.ts
  - frontend/lib/api/oauth-grants.ts
  - frontend/routes/admin/oauth-apps.tsx
  - frontend/routes/oauth/authorize.tsx
  - frontend/routes/settings/connected-apps.tsx
  - frontend/routes/settings/oauth-apps.tsx
  - server/lib/integrations/
  - server/lib/oauth-client-manifest.ts
  - server/lib/oauth-rate-limit.ts
  - server/lib/oauth-security-observability.ts
  - server/lib/validators/external-websocket.ts
  - server/lib/validators/external.ts
  - server/lib/validators/integrations.ts
  - server/routes/integrations.ts
  - server/services/external-message-projection.ts
  - server/services/external-resource-service.ts
  - server/services/oauth-device-runtime-policy.ts
  - server/services/oauth-resource-access.ts
  - shared/external/
  - shared/integrations/
keywords:
  - /api/oauth/authorize
  - /api/oauth/token
  - /api/oauth/revoke
  - /api/oauth-apps
  - /api/oauth-grants
  - /api/external/v1
  - /ws/external/v1/narrators
  - /api/external/v1/ws-tickets
  - oauth_clients
  - oauth_grants
  - oauth_security_events
  - INSUFFICIENT_SCOPE
  - OAUTH_POLICY_FORBIDDEN
  - SESSION_REQUIRED
  - refresh_reuse_detected
  - 连接的应用
  - OAuth 应用
  - 授权同意
  - detail 参数
  - message.summary.read
  - external-narrators
status: stub
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# OAuth 与开放 API

NarraFork 自带一个 OAuth 2.0 授权服务器，第三方应用拿到访问令牌后，只能调用 `/api/external/v1` 这一组版本化接口。它与第一方会话令牌是两条互不混用的认证路径。

## 关键规则
- 授权码 + PKCE，只支持 `S256`；`token_endpoint_auth_methods_supported` 为 `none`（公共客户端）。授权码 10 分钟，访问令牌 1 小时，刷新令牌 30 天（`lib/oauth-provider.ts` 的 `AUTHORIZATION_CODE_TTL_MS`、`ACCESS_TOKEN_TTL_SECONDS`、`REFRESH_TOKEN_TTL_MS`）。授权码先消费再校验 PKCE，失败的兑换不能被反复试探。
- 路由（`routes/oauth.ts`，挂在 `/api/oauth`，请求体上限 64 KiB，带限流）：`/.well-known/oauth-authorization-server`、`GET /authorize`（给同意页返回信息，无会话回 401）、`POST /authorize`（同意/拒绝）、`/token`、`/revoke`。
- scope 固定集合（`OAUTH_EXTERNAL_V1_SCOPES`）：`project.read`、`device.read/provision/rotate`、`narrator.read/provision/send_message/interrupt`、`event.subscribe`、`message.summary.read`、`message.content.read`；未知 scope 被拒。
- 应用（client）由管理员管理：`/api/oauth-apps` 全部 `requireAdmin`，含导入导出；用户的授权记录由 `/api/oauth-grants`（列表、撤销、批量撤销、全部撤销）管理。授权撤销历史保留：撤销的授权不复用，重新同意会新建一行（`oauth-grant-service.ts` 文件头）；单个授权最多关联 100 个项目。
- 认证边界：`/api/external/v1` 在本路由内强制 `requireOAuthAuth`，不接受会话令牌；OAuth 主体永远过不了管理员检查，也过不了 `requireSessionAuth`（`middleware/auth.ts`）。每次请求都按令牌重查用户行与授权。
- External API v1（`routes/external-v1.ts`）：请求体上限 160 KiB；GET 和写操作分别限流（写操作按主体）；接口含 `/projects`、`/devices`（含幂等 `PUT /devices/provisions/:provisionKey` 与凭据轮换）、`/narrators/provisions/:provisionKey`、叙述者读取、发消息、读消息、读工具调用、中断，以及 `POST /ws-tickets`（需 `narrator.read` 与 `event.subscribe`）。
- WebSocket 用一次性票据订阅：票据 TTL 30–60 秒、默认 45 秒，兑换时带回签发时的认证快照（`oauth-ws-ticket-service.ts`），频道为 `external-narrators`。
- 限流（`lib/oauth-rate-limit.ts`，进程内令牌桶）：authorize 容量 60/每秒补 1，token 与 revoke 30/0.5，external-read 240/4，external-write 60/1；每个命名空间最多 4096 个键，超出并入同一溢出桶。键默认只含客户端 IP；`POST /authorize` 与 External v1 写操作另含 client、grant、user。触发限流记 `rate_limited` 安全事件。
- 安全事件计数与落库（`lib/oauth-security-observability.ts`）：`token_issued`、`refresh_rotated`、`refresh_reuse_detected`、`token_revoked`、`rate_limited`、`runtime_authorization_lost`，写 `oauth_security_events`。
- 消息披露分层：请求参数 `detail` 取 text/skeleton/summary/full；实际档位是请求值、scope 上限（`message.content.read` 为 full、`message.summary.read` 为 summary、都没有为 text）与客户端策略 `messageDetail` 上限三者中最严的；请求结构化档位但无任何消息 scope 报 403 `INSUFFICIENT_SCOPE`，策略为 none 报 403 `OAUTH_POLICY_FORBIDDEN`，仅请求更高档位只会被降级（`services/external-resource-service.ts:resolveExternalMessageDetail`，档位定义在 `shared/external/message-detail.ts`）。skeleton 档不得读取 `content_json`/`input_json`/`output_json`（`external-message-projection.ts` 文件头）。
- 资源授权（`services/oauth-resource-access.ts`）：解析实时授权与客户端上下文，授权关联的项目白名单有限（`EXTERNAL_OAUTH_MAX_PROJECTS`=100）；`requireOwnedExternalNarrator`/`requireOwnedExternalDevice` 对不属于该授权的资源隐藏存在性。OAuth 创建的设备另由 `oauth-device-runtime-policy.ts:resolveOAuthDeviceRuntimeAuthorization` 在运行时重查所有者授权，普通设备不经这条边界。
- 客户端清单（`lib/oauth-client-manifest.ts`）：管理员导入导出的可移植注册描述，kind `narrafork.oauth-client` 版本 1，只含公共客户端、`authorization_code`+`refresh_token`、重定向 URI 1–20 个，不含密钥与数据库元数据。
- 外部 WebSocket：入口 `/ws/external/v1/narrators?ticket=`（`http-dispatcher.ts`），先校验 Origin 白名单与容量，再一次性兑换票据并重验访问令牌仍有效且含 `narrator.read`、`event.subscribe`；帧由 `lib/validators/external-websocket.ts` 严格校验，类型 pong/subscribe/unsubscribe/sync_check/send_message/interrupt；单帧上限 160 KiB（超出 1009 关闭），连接与订阅上限各 100，连接数满关闭 1013。每个连接按帧消耗预算，超限回 `rate_limited` 帧。
- OAuth 叙述者的运行时约束：外部权限模式只有 readOnly / dontAsk / bypassPermissions；headless 的 bypassPermissions 退回危险反思而不是无检查，灾难性命令仍被拒（`lib/oauth-client-policy.ts`）；每个叙述者最多 16 台设备；设备按访问组（host/global/selfRegistered）有各自的操作上限（`oauth-narrator-runtime-policy.ts`）。这些约束进入 `handlePermission` 的 `runtimeConstraint`，见 [工具调用审批](../tool-permissions/index.md)。
- 授权被撤销或收窄时，`oauth-runtime-revocation.ts` 会硬停所属叙述者的活动、清空排队消息并断开设备。

## 前端
- `routes/oauth/authorize.tsx`：授权同意页（调 `GET/POST /api/oauth/authorize`）。
- `routes/settings/oauth-apps.tsx` + `lib/api/oauth-apps.ts`：管理员管理应用（scope 勾选、策略、导入导出）。`OAUTH_APP_AVAILABLE_SCOPES` 在前端另有一份。
- `routes/settings/connected-apps.tsx` + `lib/api/oauth-grants.ts`：用户查看并撤销自己的授权。

## 从哪读起
- `server/lib/oauth-provider.ts`：授权码、令牌签发与校验。
- `server/routes/external-v1.ts`：对外接口全貌。
- `server/middleware/auth.ts:authenticateRequest` 的 OAuth 分支。

## 改它时
- 加一个 scope：`lib/oauth-provider.ts:OAUTH_EXTERNAL_V1_SCOPES` 是唯一服务端来源（`OAUTH_SUPPORTED_SCOPES`、清单校验都派生自它）；前端 `lib/api/oauth-apps.ts:OAUTH_APP_AVAILABLE_SCOPES` 要手工同步；OAuth scope 到统一能力的映射在 `lib/integrations/capability-adapters.ts`；测试 `lib/__tests__/oauth-provider.test.ts`、`routes/__tests__/oauth*.test.ts`、`external-v1.test.ts`。
- 加一个 External v1 端点：在 `routes/external-v1.ts` 用 `requireOAuthAuth`，经 `oauth-resource-access.ts` 取上下文并检查 scope 与项目，选读/写限流；资源不属于该授权要按「不存在」处理；`routes/__tests__/oauth-boundary.integration.test.ts` 守着会话令牌与 OAuth 的边界。
- 改请求体、分页、消息大小上限：`lib/validators/external.ts`、`external-websocket.ts`，REST 与 WebSocket 共用 `EXTERNAL_V1_MAX_MESSAGE_*`，要同时看。
- 新增 `oauth_*` 表或列：走 schema 迁移。授权撤销保留历史，不要复用已撤销的行；撤销/收窄后必须经 `oauth-runtime-revocation.ts` 硬停叙述者；外部 WebSocket 连接由 `websocket/oauth-connection-registry.ts` 的 `closeExternalNarratorConnectionsBy{Token,Family,Grant,Client}` 关闭（调用点未逐一核实）。
- 不变量：OAuth 主体永远不是管理员；公共客户端只支持 S256 PKCE；票据一次性、30–60 秒。

## 相关
- [登录与会话令牌](../auth/index.md)
- [工具调用审批](../tool-permissions/index.md)

## 下面有什么

- [OAuth 服务端](oauth-server.md)：OAuth 应用与授权、令牌与 PKCE、作用域、WebSocket 票据。
- [External API v1](external-v1.md)：对外 API 路由、外部会话 WebSocket、限额与限流。
- [集成授权层](integrations.md)：统一的授权层：集成主体、能力内核、授权与资源绑定、审计与摘要；OAuth 与插件共用。
