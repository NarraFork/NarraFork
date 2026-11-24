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
  - frontend/routes/admin/users.tsx
  - frontend/routes/login.tsx
  - frontend/routes/settings/authentication.tsx
  - frontend/routes/settings/profile.tsx
  - frontend/routes/settings/security.tsx
  - frontend/routes/settings/users.tsx
  - server/services/user-deletion.ts
keywords:
  - /api/auth/me
  - /api/auth/status
  - /api/admin/users
  - /api/auth/me/avatar
  - auth:me
  - 登录页
  - 用户管理
  - 头像
  - 个人资料
  - 安全设置
  - 认证设置
  - narrafork_current_user_v1
  - useAuthenticatedSession
  - releaseUserForeignKeys
  - 删除用户
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 登录与会话令牌

认证回答「这个请求是谁发的」。它分两段：登录阶段用密码、Passkey、LDAP 或 SSO 证明身份，换到一个会话令牌；之后每个请求只带这个令牌，由中间件对着数据库认证。第三方走 OAuth 访问令牌（见 [OAuth 与开放 API](../oauth-api/index.md)），由同一个入口区分。

## 一个请求怎么被认证
1. 登录（[登录方式与第二因子](login-methods.md)）：`POST /api/auth/login` 先校验本地密码，不通过再试 LDAP；用户启用了 MFA 就只返回 `mfaToken`，再用 TOTP、备份码或 Passkey 换会话。Passkey 无用户名登录与 SSO 直接发会话。各种登录方式的出口都是 `lib/auth.ts:buildSessionResult`（注册走 `createToken`）。
2. 签发（[会话令牌](sessions.md)）：生成 `nfs_` 令牌，库里只存哈希。
3. 每个请求：`app.ts` 在 `/api/*` 上挂 `requireSessionAuth`，`middleware/auth.ts:authenticateRequest` 读 `Authorization: Bearer`（WebSocket 用 `?token=`）。`nfs_` 令牌按哈希查会话行，检查吊销、过期与用户的 `token_version`，角色取账号当前值；不是 `nfs_` 的令牌按 OAuth 访问令牌校验，得到 OAuth 主体。
4. 路由再选门：只收会话主体、只收 OAuth、两者都收、管理员；管理员判断永不接受 OAuth 主体。
5. 临近到期的会话在请求里顺带续期，续期失败不影响请求。

高风险操作（导出凭据）在以上之外还要 step-up 再验证，见登录方式一节。认证之后的资源授权与操作审批见 [访问控制](../acl.md)、[工具调用审批](../tool-permissions/index.md)。

## 前端与用户管理
- 登录成功后 `hooks/useAuth.ts:applySession` 存令牌、清掉上一个账号的偏好缓存、把用户写进查询 `["auth","me"]` 与本地缓存、再切换界面语言；远程构建（`REMOTE_BUILD`）改走 `remote/session` 建立会话。
- `hooks/useCurrentUser.ts` 用 `lib/current-user-cache.ts`（localStorage 键 `narrafork_current_user_v1`，上限 16384 字符）做初值避免闪屏；`/auth/me` 返回 401 时清缓存，401/404 不重试。`hooks/useAuthenticatedSession.ts` 在令牌被清除时触发重定向，供主应用与独立窗口共用。
- 页面：`routes/login.tsx`、`routes/settings/profile.tsx`（头像经 `AvatarCropModal`、`UserAvatar`、`useAvatarBlobUrl`，后端 `PATCH/DELETE /api/auth/me/avatar`）、`routes/settings/security.tsx`、`routes/settings/authentication.tsx`（细节见 [登录方式](login-methods.md)）。
- 管理员的用户管理在 `routes/settings/users.tsx`（`/admin/users` 只是跳转到它）与 `components/settings/CreateUserModal.tsx`，新建账号的初始密码可用 `lib/random-password.ts` 生成（`crypto.getRandomValues`、去歧义字符集）。
- 删除用户前 `services/user-deletion.ts:releaseUserForeignKeys` 在同一事务里处理没有级联的外键：消息的 `createdBy`/`editedBy`、`projects.ownerUserId`、网关映射的 `appUserId` 置空，`user_plugin_themes` 连带删除；由 `routes/admin.ts` 的删除用户调用。

## 从哪读起
- `server/middleware/auth.ts:authenticateRequest`：一次请求的认证入口。
- `server/lib/auth.ts`：令牌签发、校验、登录与注册。
- `server/routes/auth.ts`：所有 `/api/auth/*` 路由。

## 改它时
- 加一个 `/api/auth/*` 路由：选好门（见 [会话令牌](sessions.md)），失败路径接入 `auth-attempt-limiter`；前端对应加到 `lib/api/auth.ts`。
- 给 `users` 加指向用户的外键：要么在 schema 里声明 `onDelete`，要么在 `releaseUserForeignKeys` 里补处理（注释说明线上库无法靠改 schema 重建旧表）；测试 `services/__tests__/user-deletion.test.ts`、`routes/__tests__/auth-avatar-rollback.test.ts`。
- 改 `LoginSession` 形状：`server/lib/auth.ts:buildSessionResult` 与前端 `lib/api/auth.ts`、`applySession`、缓存 `current-user-cache.ts` 要一起改。
- 改登录后行为不得绕过 `buildSessionResult`；会话相关守卫见 `middleware/__tests__/session-gate.integration.test.ts`。

## 相关
- [OAuth 与开放 API](../oauth-api/index.md)
- [访问控制](../acl.md)

## 下面有什么

- [会话令牌](sessions.md)：nfs_ 令牌与哈希存储、滑动续期、两级吊销、中间件分层、WebSocket 复核。
- [登录方式与第二因子](login-methods.md)：密码与限流、MFA/TOTP、Passkey、LDAP、SSO、注册与邀请码、Step-up。
