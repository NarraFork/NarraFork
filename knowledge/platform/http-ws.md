---
id: platform.http-ws
title: HTTP 路由与 WebSocket
summary: Hono 路由注册、鉴权中间件、请求分发、WebSocket 订阅模型。
anchors:
  - server/websocket/
  - server/http-dispatcher.ts
  - server/middleware/
  - server/app.ts
  - server/websocket/ws-handler.ts
  - server/services/narrator-persistence.ts#updateStatus
  - server/services/narrator-status-version.ts
  - server/services/narrator-message-count.ts#readNarratorMessageRefCountSnapshot
  - server/services/__tests__/narrator-persistence-background-attention.test.ts
  - server/services/narrator-archive.ts#transitionAdmittedGroup
  - server/services/narrator-messages.ts#dismissErrorMessage
  - server/services/agent-runtime/finalization-reads.ts#clearTransientStatusPatch
  - server/http-request-lifecycle.ts
  - server/lib/validators/websocket.ts
  - server/middleware/__tests__/auth-oauth-boundary.test.ts
  - server/middleware/__tests__/session-gate.integration.test.ts
  - server/websocket/__tests__/session-revalidation.test.ts
  - server/websocket/__tests__/session-socket-revalidation.test.ts
keywords:
  - requireAuth
  - requireAdmin
  - requireSessionAuth
  - requireScope
  - Authorization Bearer
  - /ws/narrator
  - /ws/terminal
  - /ws/vnet
  - /ws/device
  - /ws/external/v1/narrators
  - subscribe_denied
  - 4001
  - 1012
  - GIT_NOT_INSTALLED
  - trustedProxyCidrs
  - /api/health
  - 503 Retry-After
status: draft
verified_at: 4d69bf50aa11b8bfaf6cc4a12a71f118ace320d2
---
# HTTP 路由与 WebSocket

`Bun.serve` 的 `fetch` 由 `http-dispatcher.ts` 创建：`/ws*` 路径在 Hono 之外完成鉴权和升级，其余请求交给 `app.ts` 的 Hono 应用。

## 关键规则
- 分发入口 `server/http-dispatcher.ts` 的闭包在 `lifecycle.run(...)` 中执行每个请求（`http-request-lifecycle.ts` 负责关闭时的请求计数与排空）；`/ws` 路径上的已知读库故障被转成 503 + `Retry-After`，不让 Bun 抛未处理拒绝。
- 普通请求体上限：`limitOrdinaryRequestBody` 对非 GET/HEAD/OPTIONS 请求，声明长度超过 `MAX_ORDINARY_BODY_BYTES`（128 MiB，`shared/storage-transfer.ts`）直接 413，未声明则流式计数；存储导入上传和流式附件上传例外（`http-dispatcher.ts`）。
- 客户端 IP 在 Bun 边界解析：只有对端在 `settings.auth.trustedProxyCidrs`（缺省回环地址）内才信任转发头（`resolveClientIp`）。
- 路由注册在 `server/app.ts`：一个资源组一个 `new Hono()` 文件，经 `app.route("/api/xxx", ...)` 挂载（`server/routes/`，约一百多个文件）。顺序有意义：公开路由（`/api/auth`、`/api/oauth`、`/api/external/v1`、`/api/public/narrator-shares` 等）在前；之后 `app.use("/api/*", requireSessionAuth)`，其后的所有普通路由只接受第一方会话令牌，OAuth 访问令牌只能走显式挂载的外部路由。
- CORS：`/api/*` 每个响应追加 `Vary: Origin`；`text/html` 响应追加 `frame-ancestors`（含 `settings.server.allowedOrigins`）。鉴权是 `Authorization: Bearer`，无 cookie 路径（`app.ts` 注释）。
- 未装 git 时仅拦截少数需要 git 的路由（目前规则为 `POST /api/projects`），返回 `GIT_NOT_INSTALLED`（`app.ts:GIT_REQUIRED_RULES`）。
- 鉴权中间件（`server/middleware/auth.ts`）：`requireSessionAuth`、`requireAuth`、`requireAdmin`、`requireOAuthAuth`/`requireExternalAuth`、`requireScope`、`requireExternalScope`；每个请求只认证一次，主体存入 `c.get("auth")`（`session` 或 `oauth`）；会话在续期窗口内才写库延长（`maybeExtendSession`）。
- WebSocket：通道由路径决定 `/ws/narrator`、`/ws/terminal`、`/ws/vnet`、`/ws/device`（`ws-handler.ts:resolveWSData`），另有外部 OAuth 叙述者通道。会话令牌经 `?token=` 在升级时校验，用户角色实时读库；公开分享用 `Share <token>` 单独校验并有连接预算（429）。
- 分发入口还有三道门：关闭中返回 503（`Retry-After: 1`）；需要数据库读池的路径（`requiresDatabaseReaders`）在读池不可用时 503，详见 [Worker 隔离](workers.md)；同一批路径在读池就绪后还要等 `startupReadiness.barrier`（叙述者续接恢复到达终态，失败也放行，让修复路由可达）。`/api/health` 例外：永远直接答，并把恢复状态和读池状态并入负载（`http-dispatcher.ts`）。
- 其他 WebSocket 能力复用叙述者通道：`narrator-ws.ts` 里分派 `editor-file-ws`、`git-workspace-ws`、`outline-page-ws`、`outline-live-ws` 的消息和订阅释放，不是各自独立的路径；外部 OAuth 叙述者通道 `/ws/external/v1/narrators` 用一次性 ticket 升级，并复核令牌的 `narrator.read`、`event.subscribe` 范围与来源 Origin（`http-dispatcher.ts`）。
- 升级后 `wsHandlers` 按 `channel` 分派到 `narrator-ws.ts`、`terminal-ws.ts` 等；叙述者通道是订阅模型（`subscribe`/`unsubscribe`，拒绝时回 `subscribe_denied`）。
- 状态投影：`narrator-status-version.ts` 定义固定小列（状态/子状态、回合开始/更新时间、错误与可重试标记、联动归档 id），不广播完整叙述者。SQLite `updateStatus/compareAndSetStatus/writeSubstatus` 在同步 `UPDATE RETURNING` 成功点分配版本，保留其已提交投影再广播；`substatus_change` 同样带完整主状态，避免新子状态压掉旧主状态后丢失最终主状态。归档、错误通知 dismiss、循环终态清理也复用该小列投影，不在异步副作用结束后回读最新状态冒充原事务。
- `updateStatus` 的 `keepIdleError`（需同时给 `substatus`，调用方在 `narrator-session.ts`）：读到会话已是 `idle` 且子状态含 `error` 时，只在事务里复核观测行（`assertNarratorRead`）后返回 `false`，不写库、不分配版本、不广播；并发变化让复核冲突而不是被覆盖（`narrator-persistence.ts:updateStatus`）。
- 状态版本：一个进程级、热重载保留的 `statusEpoch` + 单调 `statusRevision`，无按会话增长的后端版本缓存；事务回滚留下 revision 空隙允许。panel 与 list 快照在同步读状态之前分配版本，不能等占用索引等异步读取完成后才编号，否则旧快照会冒充新状态；panel 取详情小列，list 仍只取轻量列。
- 完整状态帧与 panel 快照经 `committedNarratorStatusPatch` 异步附可选精确 `messageCount`：用提交时内部 `messageVersion` 与 worker 单 SQL 计数快照版本对齐，同会话/同版本在途共享，错配或失败省略计数，不回退主线程或上界列。list 快照不加此计数；错误提示另行落库导致消息版本变化时，为该后续提交重新分配状态版本，不能提升原旧状态补丁。
- 公开分享的 `status_change/substatus_change`（含快照）只保留 `type/narratorId/status/substatus/turnStartedAt/updatedAt/messageCount/statusEpoch/statusRevision/backgroundWorkActive`；精确计数与状态版本可见，但内部 `messageVersion`、错误详情和联动归档信息不可见（`narrator-ws.ts:projectPublicNarratorEvent`）。
- 执行设备提示：`execution-device-events.ts` 将设备元数据/在线状态/撤销，以及 OAuth grant/client、项目/会话访问、执行主体变化合并为 100ms 一帧的 `execution_devices_changed`，全局发送但仅带 `type`，不携带设备或授权数据；`broadcastToAll` 排除匿名公开分享。提示只使客户端重读会话设备 HTTP 接口，不作为设备授权来源。
- 心跳：30 秒 ping，90 秒无 pong 视为超时；会话过期用关闭码 4001；关闭中用 1012 拒绝新连接和消息（`ws-handler.ts`）。会话变化由 `session-revalidation.ts` 复核。

## 从哪读起
- `server/http-dispatcher.ts`：请求入口与 WS 升级。
- `server/app.ts`：中间件顺序与路由表。
- `server/middleware/auth.ts`：鉴权主体与守卫。
- `server/websocket/ws-handler.ts`：通道分派、心跳。
- `server/websocket/narrator-ws.ts`：叙述者订阅与广播。

## 改它时
- 新增路由组：新文件 `new Hono()`，在 `app.ts` 里用 `app.route("/api/xxx", …)` 挂载；挂在 `app.use("/api/*", requireSessionAuth)` 之前的就是公开/特殊鉴权路由，只有确有需要才放前面（顺序即规则）。`auth-oauth-boundary.test.ts`、`session-gate.integration.test.ts` 钉着 OAuth 令牌不能走普通会话路由。
- 新增 WS 通道：`ws-handler.ts` 的 `WSData` 联合、`resolveWSData`、`wsHandlers` 的 open/message/close 分派，以及 `validators/websocket.ts` 的消息校验；会话变化要接入 `session-revalidation.ts`（`session-revalidation.test.ts`、`session-socket-revalidation.test.ts`）。
- 新增需要 git 的路由：加进 `app.ts:GIT_REQUIRED_RULES`。
- 新增叙述者通道的服务端消息：改 `narrator-ws-types.ts` 的联合；高频输出要合并节流并处理背压，见 [主线程性能规则](main-thread.md)。

## 相关
- [事件总线](event-bus.md)
- [错误与校验](errors-validation.md)
- [启动与进程](boot.md)
