---
id: security.oauth-api.external-v1
title: External API v1
summary: 对外 API 路由、资源授权与存在性隐藏、消息披露分层、WebSocket 票据与外部会话 WebSocket、OAuth 叙述者/设备的运行时约束。
anchors:
  - server/routes/external-v1.ts
  - server/websocket/external-narrator-ws.ts
  - server/websocket/external-narrator-ws-types.ts
  - server/lib/validators/external-websocket.ts
  - server/lib/validators/external.ts
  - server/services/external-message-projection.ts
  - server/services/external-resource-service.ts
  - server/services/oauth-resource-access.ts
  - server/services/oauth-ws-ticket-service.ts
  - server/services/oauth-narrator-runtime-policy.ts
  - server/services/oauth-device-runtime-policy.ts
  - shared/external/
keywords:
  - /api/external/v1
  - /api/external/v1/ws-tickets
  - /ws/external/v1/narrators
  - /api/external/v1/devices/provisions/:provisionKey
  - /api/external/v1/narrators/provisions/:provisionKey
  - external-narrators
  - detail 参数
  - message.summary.read
  - INSUFFICIENT_SCOPE
  - OAUTH_POLICY_FORBIDDEN
  - OAUTH_PROJECT_FORBIDDEN
  - resolveExternalMessageDetail
  - requireExternalOperation
  - requireOwnedExternalNarrator
  - requireOwnedExternalDevice
  - EXTERNAL_OAUTH_MAX_PROJECTS
  - EXTERNAL_V1_MAX_MESSAGE_BYTES
  - EXTERNAL_NARRATOR_WS_MAX_FRAME_BYTES
  - resolveOAuthDeviceRuntimeAuthorization
  - skeleton
  - 外部叙述者
  - 一次性票据
status: draft
verified_at: 776dbf07e
---
# External API v1

第三方应用用 OAuth 访问令牌能调用的全部对外接口，以及外部会话 WebSocket。OAuth 的签发、同意与撤销在 [OAuth 服务端](oauth-server.md)；每一次操作的授权判定都落到 [集成授权层](integrations.md) 的内核上。

## 关键规则
- 认证边界：`/api/external/v1` 在本路由内强制 `requireOAuthAuth`，挂在会话门之前，不接受会话令牌；OAuth 主体过不了管理员检查，也过不了 `requireSessionAuth`。每次请求都按令牌重查用户行与授权。
- 路由（`routes/external-v1.ts`）：请求体上限 160 KiB；GET 与写操作分别限流（external-read / external-write，写操作按主体，桶参数见 [OAuth 服务端](oauth-server.md)）。接口含 `/projects`、`/devices`（含幂等 `PUT /devices/provisions/:provisionKey` 与凭据轮换）、`/narrators/provisions/:provisionKey`、叙述者读取、发消息、读消息、读工具调用、中断，以及 `POST /ws-tickets`（需 `narrator.read` 与 `event.subscribe`）。
- 资源授权（`services/oauth-resource-access.ts`）：解析实时授权与客户端上下文，有效 scope 取令牌 scope、授权已授予的能力、客户端 scope 三者的交集；授权关联的项目白名单有限（`EXTERNAL_OAUTH_MAX_PROJECTS` = 100），超出即拒。
- 每个操作经 `requireExternalOperation` 走统一授权内核：先检查 scope 与项目白名单，再以 `project:<id>` 或 `integration:<授权 id>` 为作用域调用 `integrationAuthorizationService.require`（运行时标识 `server:external-v1:<clientId>`，传输名 `external-v1`）。
- 资源归属：`requireOwnedExternalNarrator` / `requireOwnedExternalDevice` 要求资源有 active 的资源绑定，且来源是该 OAuth 客户端、权限主体是该授权；不满足一律按“不存在”处理，隐藏存在性。
- OAuth 创建的设备另由 `oauth-device-runtime-policy.ts:resolveOAuthDeviceRuntimeAuthorization` 在运行时重查所有者授权，普通设备不经这条边界。
- 消息披露分层：请求参数 `detail` 取 text/skeleton/summary/full；实际档位是请求值、scope 上限（`message.content.read` 为 full、`message.summary.read` 为 summary、都没有为 text）与客户端策略 `messageDetail` 上限三者中最严。
- 请求结构化档位但无任何消息 scope 报 403 `INSUFFICIENT_SCOPE`；策略为 none 报 403 `OAUTH_POLICY_FORBIDDEN`；仅请求更高档位只会被降级（`services/external-resource-service.ts:resolveExternalMessageDetail`，档位定义在 `shared/external/message-detail.ts`）。skeleton 档不得读取 `content_json`/`input_json`/`output_json`（`external-message-projection.ts` 文件头）。
- WebSocket 票据：一次性，TTL 30–60 秒、默认 45 秒，兑换时带回签发时的认证快照（`oauth-ws-ticket-service.ts`）；票据总量默认上限 1000，可配到 10000。
- 外部 WebSocket：入口 `/ws/external/v1/narrators?ticket=`（`http-dispatcher.ts` 与 `ws-handler.ts` 登记路径），先校验 Origin 白名单与容量，再一次性兑换票据并重验访问令牌仍有效且含 `narrator.read`、`event.subscribe`；频道为 `external-narrators`。
- 帧：由 `lib/validators/external-websocket.ts` 严格校验，类型 pong/subscribe/unsubscribe/sync_check/send_message/interrupt；单帧上限 160 KiB（超出 1009 关闭），连接与订阅上限各 100，连接数满关闭 1013；每个连接按帧消耗预算，超限回 `rate_limited` 帧。
- 订阅走统一事件分发器（`integrationEventDispatcher.register`），每个订阅的队列最多 `min(100, 订阅上限×4)` 条、每秒 100 条；令牌失效、授权变化、客户端变化经事件总线（`oauth:token_invalidated`、`oauth:grant_changed`、`oauth:client_changed`）使订阅失效并关闭连接（`oauth-connection-registry.ts` 的 `closeExternalNarratorConnectionsBy{Token,Family,Grant,Client}`，在 `external-narrator-ws.ts` 里注册）。
- OAuth 叙述者的运行时约束：每个叙述者最多 16 台设备；设备按访问组（host/global/selfRegistered）有各自的操作上限（`oauth-narrator-runtime-policy.ts`）。这些约束进入 `handlePermission` 的 `runtimeConstraint`，见 [工具调用审批](../tool-permissions/flow.md)。

## 从哪读起
- `server/routes/external-v1.ts`：对外接口全貌。
- `server/services/oauth-resource-access.ts`：上下文解析、`requireExternalOperation`、资源归属。
- `server/websocket/external-narrator-ws.ts`：连接、帧、订阅与失效。
- 测试：`routes/__tests__/external-v1.test.ts`、`oauth-boundary.integration.test.ts`、`services/__tests__/oauth-resource-access.test.ts`、`external-resource-service.test.ts`、`websocket/external-narrator-ws.test.ts`。

## 改它时
- 加一个 External v1 端点：在 `routes/external-v1.ts` 用 `requireOAuthAuth`，经 `oauth-resource-access.ts` 取上下文并走 `requireExternalOperation`（检查 scope 与项目），选读/写限流；资源不属于该授权要按“不存在”处理；`routes/__tests__/oauth-boundary.integration.test.ts` 守着会话令牌与 OAuth 的边界。
- 需要新能力时：先在 `shared/integrations/capabilities.ts` 加 canonical 描述符，再按 [OAuth 服务端](oauth-server.md) 的“加一个 scope”走。
- 改请求体、分页、消息大小上限：`lib/validators/external.ts`、`external-websocket.ts`，REST 与 WebSocket 共用 `EXTERNAL_V1_MAX_MESSAGE_*`，要同时看。
- 改披露档位：`shared/external/message-detail.ts`、`resolveExternalMessageDetail`、`external-message-projection.ts` 与客户端策略 `messageDetail` 一起看，skeleton 档不得读大字段。
- 改外部 WebSocket 的帧或预算：`external-narrator-ws-types.ts` 与校验器同步，注意背压（`EXTERNAL_NARRATOR_WS_MAX_BUFFERED_BYTES`）与 1009/1013 关闭码。
- 不变量：票据一次性、30–60 秒；不属于该授权的资源隐藏存在性；OAuth 主体永远不是管理员。

## 相关
- [OAuth 服务端](oauth-server.md)
- [集成授权层](integrations.md)
- [工具调用审批](../tool-permissions/flow.md)
