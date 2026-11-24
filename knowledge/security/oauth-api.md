---
id: security.oauth-api
title: OAuth 与开放 API
summary: OAuth 2.0 应用与授权、External API v1。
anchors:
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
status: draft
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
- OAuth 叙述者的运行时约束：外部权限模式只有 readOnly / dontAsk / bypassPermissions；headless 的 bypassPermissions 退回危险反思而不是无检查，灾难性命令仍被拒（`lib/oauth-client-policy.ts`）；每个叙述者最多 16 台设备；设备按访问组（host/global/selfRegistered）有各自的操作上限（`oauth-narrator-runtime-policy.ts`）。这些约束进入 `handlePermission` 的 `runtimeConstraint`，见 [工具调用审批](tool-permissions.md)。
- 授权被撤销或收窄时，`oauth-runtime-revocation.ts` 会硬停所属叙述者的活动、清空排队消息并断开设备。

## 从哪读起
- `server/lib/oauth-provider.ts`：授权码、令牌签发与校验。
- `server/routes/external-v1.ts`：对外接口全貌。
- `server/middleware/auth.ts:authenticateRequest` 的 OAuth 分支。

## 相关
- [登录与会话令牌](auth.md)
- [工具调用审批](tool-permissions.md)
