---
id: security.auth.sessions
title: 会话令牌
summary: nfs_ 令牌与哈希存储、滑动续期与绝对上限、两级吊销、中间件分层与管理员判断、WebSocket 复核。
anchors:
  - server/lib/auth.ts
  - server/lib/session-token-hash.ts
  - shared/session-auth.ts
  - server/services/auth/
  - server/middleware/auth.ts
  - server/lib/manager-token.ts
  - server/websocket/ws-handler.ts
  - server/http-dispatcher.ts
  - server/lib/auth-read-admission.ts
  - server/lib/client-ip.ts
  - server/lib/public-origin.ts
keywords:
  - auth_sessions
  - token_version
  - nfs_
  - SESSION_REQUIRED
  - TOKEN_EXPIRED
  - TOKEN_INVALID
  - ADMIN_REQUIRES_SESSION
  - requireSessionAuth
  - requireAdmin
  - Authorization Bearer
  - auth:changed
  - 滑动续期
  - 登出
  - 吊销会话
  - /api/auth/logout
  - manager-token
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 会话令牌

第一方登录得到的是不透明会话令牌；每个请求都对着数据库里的会话行校验，所以吊销和角色变更立即生效。

## 关键规则
- 令牌是 `nfs_` 加 32 字节随机数，库里 `auth_sessions` 只存其 SHA-256，无盐无 KDF；令牌本身在会话期内不变（`session-token-hash.ts`、`lib/auth.ts:createToken`）。
- 验证 `lib/auth.ts:verifyToken` 按哈希查会话行，角色取自账号当前值而不是令牌里的快照。非 `nfs_` 前缀或查无此行抛 401；已吊销抛 `SessionTokenRevoked`，已过期抛 `SessionTokenExpired`。旧 HS256 会话 JWT 不再被接受：`authenticateRequest` 把非 `nfs_` 令牌交给 OAuth 校验，失败即 `TOKEN_INVALID`。
- 有效期 7 天；距到期不足 3 天时才续期（`shared/session-auth.ts:shouldRenewSessionToken`），续期到期点取「当前 + 7 天」与「会话起点 + 30 天」的较小者（`lib/auth.ts:slidExpiry`），所以绝对寿命 30 天。续期失败只记 warn，不影响当前请求（`middleware/auth.ts:maybeExtendSession`）。
- 吊销两级：登出 `POST /api/auth/logout` 只吊销当前会话（`revokeSessionToken`）；`users.token_version` 递增（`revokeUserSessions`）使该用户所有 `sessionTokenVersion` 更低的会话失效（`livePayload`）。调用 `revokeUserSessions` 的只有管理员路由：重置密码与 `/users/:id/revoke-sessions`（`routes/admin.ts`）。
- 已过期或已吊销的行再保留 24 小时，使迟到的请求仍读到「过期」；启动时与此后每小时按批（500 条、最多 20 批）清理（`pruneStaleSessions`、`startSessionCleanupTimer`）。
- 中间件分层（`middleware/auth.ts`）：`authenticateRequest` 每请求只认证一次并缓存主体；`requireSessionAuth` 只收会话令牌，OAuth 令牌得 `SESSION_REQUIRED`，`app.ts` 用它守住 `/api/*`；`requireAuth`/`requireExternalAuth` 两种都收；`requireOAuthAuth` 只收 OAuth；`requireExternalScope(scope)` 对会话令牌直接放行，只约束 OAuth scope。
- 管理员判断读实时角色，OAuth 主体永远过不了 `assertAdmin`（`ADMIN_REQUIRES_SESSION`）。`requireAdminOrManagerToken` 另收管理面板的本机令牌：对端必须是回环 socket、Bearer 与环境变量里捕获的令牌常量时间相等（`lib/manager-token.ts`），目前用在 `routes/update.ts`。
- WebSocket 升级用 `?token=` 查询参数，同样走 `verifyToken`（`http-dispatcher.ts`）；连接建立后，收到 `auth:changed` 事件（登出、吊销、角色变更都会发出）时，`ws-handler.ts` 的 `SessionRevalidation` 经 `resolveLiveSession` 重查该用户的 narrator 与终端连接：会话失效即关闭，角色随之刷新；心跳另外关闭超过到期时间的连接（未核实心跳的完整条件）。
- 前端只在响应码属于 `TOKEN_EXPIRED`/`UNAUTHORIZED`/`SESSION_REQUIRED`（或无码的 401）时丢弃本地令牌，第二因子失败等 401 不会登出（`shared/session-auth.ts:isSessionInvalidResponse`）。
- 会话与 MFA 存储有 SQLite 与 PostgreSQL 两套实现，经 `services/auth/store.ts` 一起选择：只有 `NF_WRITE_BACKEND=postgres` 且注入了 PG 适配器才用 PG，读写后端不一致启动即报错。契约测试在 `services/auth/__tests__/*-contract.test.ts`。

- 认证读走 SQLite 短读池前的有界 FIFO 准入（`lib/auth-read-admission.ts`）：并发 2、排队最多 64、默认 30 秒总期限，超出排队上限抛 `DbReadTaskOverloadedError`；每个准入的调用方仍各自读库，不缓存、不共享结果。会话存储与认证读（`services/auth/sqlite-session-store.ts`、`sqlite-auth-read.ts`）经它读；WebSocket 复核（`websocket/session-revalidation.ts`）沿用同一组读选项（signal、deadline）。
- 客户端 IP（`lib/client-ip.ts:resolveClientIp`）：只有直接对端在受信代理 CIDR 内才采信 `X-Forwarded-For`/`X-Real-IP`；转发链超过 20 跳、头超 2048 字符或含非法 IP 时回退为对端 IP；登录限流的 IP 桶用它。`lib/public-origin.ts` 同理，只在对端受信时采信转发头来还原浏览器实际访问的源（被设备、OAuth、MCP 等路由用来生成自引用 URL）。

## 从哪读起
- `server/middleware/auth.ts:authenticateRequest`：一次请求的认证入口。
- `server/lib/auth.ts`：令牌签发、校验、续期、吊销。
- 测试：`middleware/__tests__/session-gate.integration.test.ts`、`auth-oauth-boundary.test.ts`

## 改它时
- 新增路由要选门：全局已有 `requireSessionAuth`（`app.ts` 挂在 `/api/*`）；要让 OAuth 令牌进入必须显式用 `requireAuth`/`requireExternalAuth`/`requireOAuthAuth`，管理员接口用 `requireAdmin`。守卫测试：`middleware/__tests__/session-gate.integration.test.ts`、`auth-oauth-boundary.test.ts`。
- 改会话有效期或续期阈值：`shared/session-auth.ts` 与 `lib/auth.ts:slidExpiry` 要一起看；前端靠 `isSessionInvalidResponse` 判断何时清令牌，新增 401 错误码要想清楚是否该登出。
- 改会话存储：SQLite、PostgreSQL 两个实现与 `services/auth/store.ts` 同步，契约测试 `services/auth/__tests__/session-store-contract.test.ts`、`mfa-store-contract.test.ts` 会拦。
- 任何会改角色、吊销会话的操作要发 `auth:changed`，否则已建立的 WebSocket 不会复核。
- 不变量：令牌库里只存哈希；角色取实时值；OAuth 主体过不了管理员判断。

## 相关
- [登录方式与第二因子](login-methods.md)
- [OAuth 与开放 API](../oauth-api/index.md)
