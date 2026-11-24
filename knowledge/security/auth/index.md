---
id: security.auth
title: 登录与会话令牌
summary: 第一方认证的整体：怎么登录、怎么换成会话令牌、每个请求怎么被认证，以及两个下级节点的分工。
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
  - frontend/components/AvatarCropModal.tsx
  - frontend/components/UserAvatar.tsx
  - frontend/components/settings/CreateUserModal.tsx
  - frontend/components/settings/ProfileSection.tsx
  - frontend/hooks/useAuth.ts
  - frontend/hooks/useAuthenticatedSession.ts
  - frontend/hooks/useAvatarBlobUrl.ts
  - frontend/hooks/useCurrentUser.ts
  - frontend/lib/api/auth.ts
  - frontend/lib/current-user-cache.ts
  - frontend/lib/random-password.ts
  - frontend/lib/session-store.ts
  - frontend/routes/admin/users.tsx
  - frontend/routes/login.tsx
  - frontend/routes/settings/authentication.tsx
  - frontend/routes/settings/profile.tsx
  - frontend/routes/settings/security.tsx
  - frontend/routes/settings/users.tsx
  - server/services/user-deletion.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 登录与会话令牌

认证回答「这个请求是谁发的」。它分两段：登录阶段用密码、Passkey、LDAP 或 SSO 证明身份，换到一个会话令牌；之后每个请求只带这个令牌，由中间件对着数据库认证。第三方走 OAuth 访问令牌（见 [OAuth 与开放 API](../oauth-api.md)），由同一个入口区分。

## 一个请求怎么被认证
1. 登录（[登录方式与第二因子](login-methods.md)）：`POST /api/auth/login` 先校验本地密码，不通过再试 LDAP；用户启用了 MFA 就只返回 `mfaToken`，再用 TOTP、备份码或 Passkey 换会话。Passkey 无用户名登录与 SSO 直接发会话。各种登录方式的出口都是 `lib/auth.ts:buildSessionResult`（注册走 `createToken`）。
2. 签发（[会话令牌](sessions.md)）：生成 `nfs_` 令牌，库里只存哈希。
3. 每个请求：`app.ts` 在 `/api/*` 上挂 `requireSessionAuth`，`middleware/auth.ts:authenticateRequest` 读 `Authorization: Bearer`（WebSocket 用 `?token=`）。`nfs_` 令牌按哈希查会话行，检查吊销、过期与用户的 `token_version`，角色取账号当前值；不是 `nfs_` 的令牌按 OAuth 访问令牌校验，得到 OAuth 主体。
4. 路由再选门：只收会话主体、只收 OAuth、两者都收、管理员；管理员判断永不接受 OAuth 主体。
5. 临近到期的会话在请求里顺带续期，续期失败不影响请求。

高风险操作（导出凭据）在以上之外还要 step-up 再验证，见登录方式一节。认证之后的资源授权与操作审批见 [访问控制](../acl.md)、[工具调用审批](../tool-permissions.md)。

## 从哪读起
- `server/middleware/auth.ts:authenticateRequest`：一次请求的认证入口。
- `server/lib/auth.ts`：令牌签发、校验、登录与注册。
- `server/routes/auth.ts`：所有 `/api/auth/*` 路由。

## 相关
- [OAuth 与开放 API](../oauth-api.md)
- [访问控制](../acl.md)

## 下面有什么

- [会话令牌](sessions.md)：nfs_ 令牌与哈希存储、滑动续期、两级吊销、中间件分层、WebSocket 复核。
- [登录方式与第二因子](login-methods.md)：密码与限流、MFA/TOTP、Passkey、LDAP、SSO、注册与邀请码、Step-up。
