---
id: security.auth
title: 登录与会话令牌
summary: nfs_ 会话令牌、滑动续期、MFA、Passkey、LDAP、SSO、首个用户为管理员。
anchors:
  - server/services/auth/
  - server/middleware/auth.ts
  - server/lib/auth.ts
  - server/lib/mfa.ts
  - server/routes/auth.ts
  - server/routes/sso.ts
  - server/services/ldap-auth-service.ts
  - server/lib/ldap/
  - server/services/step-up-service.ts
  - shared/session-auth.ts
status: stub
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 登录与会话令牌

第一方登录用不透明的会话令牌；每个请求都对着数据库里的会话行校验，所以吊销和角色变更立即生效。第三方走 OAuth 访问令牌（见 [OAuth 与开放 API](oauth-api.md)），由同一个中间件区分。

## 关键规则
- 令牌以 `nfs_` 开头，库里只存 SHA-256（`auth_sessions`）；令牌本身在会话期内不变（`shared/session-auth.ts`、`server/lib/auth.ts:createToken`）。旧 JWT 会话不被接受，`authenticateRequest` 把它当作无效令牌。
- 有效期 7 天，距到期不足 3 天时才续期（`shouldRenewSessionToken`），续期后到期点最多滑到会话起点 + 30 天的绝对上限（`lib/auth.ts:slidExpiry`）。续期失败只记 warn，不影响当前请求（`middleware/auth.ts:maybeExtendSession`）。
- 吊销有两级：登出只吊销当前会话（`revokeSessionToken`）；`users.token_version` 递增（`revokeUserSessions`）使该用户所有 `sessionTokenVersion` 更低的会话失效（`livePayload`）。
- 中间件分层（`middleware/auth.ts`）：`requireSessionAuth` 只收会话令牌；`requireAuth`/`requireExternalAuth` 两种都收；`requireOAuthAuth` 只收 OAuth；`requireExternalScope(scope)` 对会话令牌直接放行，只约束 OAuth scope。
- 管理员判断读实时角色，OAuth 主体永远不能通过 `assertAdmin`（`ADMIN_REQUIRES_SESSION`）。`requireAdminOrManagerToken` 另允许管理面板的本机令牌，但要求对端是回环 socket。
- 首个注册的账号为 admin（`lib/auth.ts` 注册流程 `isFirstUser`）；之后需要邀请码或 `settings.auth.registrationOpen`。首个账号不受注册全局间隔限制（`routes/auth.ts` `/register`）。
- 登录两步：密码通过且启用了第二因素时只返回 `mfaRequired` + `mfaToken`（5 分钟有效，`lib/mfa.ts`），再由 `/auth/mfa/verify` 用 TOTP 或备份码换会话。失败计数与锁定由 `lib/auth-attempt-limiter.ts` 统一管理。
- Passkey：`/auth/passkey/login/*` 为无用户名登录，`/auth/mfa/passkey/*` 作为第二因素（`services/passkey-service.ts`）。
- LDAP：`ldap-auth-service.ts:authenticate` 永不抛错，返回 invalid/unavailable；并发上限 8；客户端只以用户身份 bind，搜索结果上限 2 条（`lib/ldap/client.ts`）。目录认证通过但本地无账号且关闭注册时抛 `LDAP_ACCOUNT_REQUIRED`。LDAP 关联的身份不能被解绑（`routes/auth.ts` `/me/identities/:id`）。
- SSO（OIDC）：`/sso/:providerId/start` 重定向到 IdP，回调校验 `state`，再用 `/sso/exchange` 换会话；已登录用户可 `/:providerId/link/start` 绑定（`routes/sso.ts`）。
- Step-up：导出凭据等高风险操作要求再次验证密码加第二因素，得到 5 分钟、单次、绑定用户/会话/用途的内存授权（`services/step-up-service.ts`，用途 `credentials.export`、`storage.export.providers`）。
- 存储后端有 SQLite 与 PostgreSQL 两套实现，经 `services/auth/store.ts` 选择，契约测试在 `services/auth/__tests__/*-contract.test.ts`。

## 从哪读起
- `server/middleware/auth.ts:authenticateRequest`：一次请求的认证入口。
- `server/lib/auth.ts`：令牌签发、续期、吊销、注册与登录。
- `server/routes/auth.ts`：所有 `/api/auth/*` 路由。

## 相关
- [OAuth 与开放 API](oauth-api.md)
- [访问控制](acl.md)

## 下面有什么

- [会话令牌](sessions.md)：nfs_ 令牌、哈希存储、滑动续期、登出与全部吊销、首个用户为管理员。
- [登录方式与第二因子](login-methods.md)：密码与登录限流、MFA/TOTP、Passkey、LDAP、SSO、注册与邀请。
