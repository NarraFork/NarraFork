---
id: platform.event-bus
title: 事件总线
summary: 服务之间的类型化事件，服务到 WebSocket 广播的解耦。
anchors:
  - server/lib/event-bus.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 事件总线

进程内的类型化事件总线，让服务之间、以及服务到 WebSocket 广播之间互不直接依赖。

## 关键规则
- 事件是 `NarraForkEvent` 判别联合（以 `type` 区分，如 `narrator:status_changed`、`narrator:deleted`、`auth:changed`、`chat:message_created`、`project:access_changed`），`eventBus` 是模块单例（`server/lib/event-bus.ts`）。
- 接口：`emit`、`on(type, handler)`、`off`、`onAny`/`offAny`；底层是 `EventEmitter`，最大监听数 100（`event-bus.ts:NarraForkEventBus`）。
- `emit` 是同步分发：先该类型的监听者，再 `"*"` 监听者；每个监听者单独 try/catch，同步抛错或异步 Promise 拒绝都只记日志，不影响其他监听者，也不改变 `emit` 的同步语义。
- `narrator:message_broadcast` 与 `narrator:ws_broadcast` 不写 debug 日志（`SILENT_EVENTS`），其他事件每次 emit 都记 debug 日志。
- 事件载荷约定为只带标识和标量，不带正文或凭据：文件内注释对 `chat:*`、通知中心、OAuth 失效事件都这样要求（如 `chat:message_created` 只有 id/seq）；订阅方要内容需自行走授权接口读取。此为注释所述约定，未逐个核对所有事件。
- 典型消费方：`websocket/editor-file-ws.ts`（`onAny`）、`websocket/narrator-ws.ts`（偏好、待人决策等）、`websocket/external-narrator-ws.ts`（OAuth 令牌/授权失效）、`services/teams/*`、`services/git-workspace-watch.ts`、`gateway/gateway.ts`。
- 总线只在本进程内有效，不跨进程、不持久化；没有重放。

## 从哪读起
- `server/lib/event-bus.ts`：事件联合类型与总线实现，新增事件加到 `NarraForkEvent`。
- `server/middleware/auth.ts:notifyAuthChanged`：发出 `auth:changed` 的例子。

## 相关
- [HTTP 路由与 WebSocket](http-ws.md)
