---
id: security.auth.login-methods
title: 登录方式与第二因子
summary: 密码与登录限流、MFA/TOTP/备份码、Passkey、LDAP、SSO、注册与邀请码、Step-up。
anchors:
  - server/lib/auth.ts
  - server/routes/auth.ts
  - server/routes/sso.ts
  - server/lib/mfa.ts
  - server/lib/totp.ts
  - server/lib/auth-attempt-limiter.ts
  - server/services/mfa-service.ts
  - server/services/passkey-service.ts
  - server/services/ldap-auth-service.ts
  - server/services/sso-service.ts
  - server/services/step-up-service.ts
  - server/services/registration-code-service.ts
  - server/lib/ldap/
  - server/services/registration/
  - frontend/components/settings/RegistrationCodesSection.tsx
  - frontend/components/settings/StepUpFields.tsx
  - server/lib/auth-settings.ts
  - server/lib/oidc.ts
  - server/lib/validators/auth.ts
  - server/lib/webauthn-rp.ts
  - server/lib/webauthn.ts
  - shared/identity-providers.ts
keywords:
  - /api/auth/login
  - /api/auth/register
  - /api/auth/mfa/verify
  - /api/auth/step-up
  - /api/auth/passkey/login/options
  - /api/admin/auth-config
  - /api/admin/registration-codes
  - mfaToken
  - mfaRequired
  - LDAP_UNAVAILABLE
  - LDAP_ADMIN_LINK_REFUSED
  - LDAP_ACCOUNT_REQUIRED
  - CODE_INVALID
  - WEBAUTHN_NO_RP
  - auth.registrationOpen
  - auth.webauthn
  - sso_code
  - 邀请码
  - 通行密钥
  - 备份码
  - 两步验证
  - webauthn_challenges
  - user_identities
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 登录方式与第二因子

怎么证明「你是谁」并换到一个会话令牌（令牌之后的事见 [会话令牌](sessions.md)）。所有方式最终都调 `lib/auth.ts:buildSessionResult` 签发会话。

## 关键规则
- 密码登录 `loginUser`：先本地 bcrypt 校验，不通过且配置了目录才交给 LDAP；未知用户也对固定哈希做一次校验以拉平耗时。通过后 `completeLogin`：只有 `users.mfaEnabled` 为真才要第二因子，已启用但没有任何可用因子时直接发会话，避免锁死。
- 登录限流（`lib/auth-attempt-limiter.ts`，纯内存）：按账号、账号+IP、IP 三组桶计失败（账号+IP 5 次/5 分钟，账号 10 次/15 分钟，IP 30 次/5 分钟），每达到失败上限锁定一次、时长按等级翻倍（封顶 15 分钟），24 小时无失败或一次成功登录（仅账号与账号+IP 桶）后清零；bcrypt 同时只允许 4 个。账号标识用 `jwtSecret` 做 HMAC 后再记日志与分桶。目录不可达时本地已失败的这次猜测仍计失败，不退还。
- MFA 两步：密码通过且需第二因子时只返回 `mfaRequired` + `mfaToken` + `methods`；令牌是 `jwtSecret` 签名的 HS256 JWT，5 分钟有效、单次使用，失败额度耗尽即作废（`lib/mfa.ts`，已用 jti 存内存）。`/auth/mfa/verify` 用 TOTP 或备份码换会话，另有按用户与来源 IP 的 MFA 桶（用户 5 次/10 分钟、IP 15 次/5 分钟）。
- TOTP：SHA1、6 位、30 秒、前后各容一步（`lib/totp.ts`）；备份码 10 个，bcrypt 哈希存储，只在激活或重新生成时明文出现一次（`services/mfa-service.ts`）。开启「登录需第二因子」要求至少有一个因子（`PATCH /me/mfa`）；删光因子时自动关闭该开关（`syncMfaEnabledAfterFactorChange`）。
- Passkey（`services/passkey-service.ts`）：`/auth/passkey/login/*` 为无用户名登录，`/auth/mfa/passkey/*` 为第二因子；挑战存 `webauthn_challenges`，5 分钟有效，一次性消费（`lib/webauthn.ts`）；校验不强制用户验证，成功后更新签名计数器。无用户名 Passkey 登录和 SSO 登录都不再经过 MFA 步骤，直接发会话。
- LDAP 不是独立登录入口，而是密码登录的后备校验（`ldap-auth-service.ts`）。`authenticate` 永不抛错，返回 ok/invalid/unavailable；并发上限 8，超出即 `unavailable`；空密码不发网络请求。`search` 模式用服务账号（或匿名）按过滤器找 DN，结果上限 2 条，两条即 `AMBIGUOUS_SEARCH_RESULT`；`direct` 模式按模板渲染 DN；最后都以用户 DN 加提交的密码 bind 验证（`lib/ldap/client.ts`）。不可达返回 503 `LDAP_UNAVAILABLE`。
- LDAP 账号归属（`resolveLocalUser`）：已绑定身份直接登录；否则同名本地普通账号会被绑定，同名管理员拒绝（`LDAP_ADMIN_LINK_REFUSED`）；无同名账号时只有 `registrationOpen` 开着才新建普通用户，否则 `LDAP_ACCOUNT_REQUIRED`。LDAP 绑定身份不能解绑（`routes/auth.ts` `/me/identities/:id`）。
- SSO（OIDC，`routes/sso.ts`）：`/sso/:providerId/start` 带 state、nonce、PKCE 跳 IdP，回调校验后重定向前端带 2 分钟单次 `sso_code`，前端 `/sso/exchange` 换会话；state（10 分钟）与 code 只存本进程内存。已登录用户经 `/:providerId/link/start` 绑定身份。新主体不按邮箱自动关联本地账号；是否新建由 provider 的 `allowSignup` 与邮箱域白名单决定，新账号恒为普通用户，且不受 `registrationOpen` 约束（`sso-service.ts:resolveLogin`）。
- 注册（`lib/auth.ts:registerUser`）：首个账号恒为 admin，且注册完成后自动把 `auth.registrationOpen` 置 false；之后需邀请码或 `registrationOpen`。首个账号不受注册全局 3 秒间隔限制（`routes/auth.ts` `/register`）。账号、邀请码核销在一个原子段内完成（`registration/account-store.ts` 契约，SQLite 与 PG 各一实现）。
- 邀请码（`registration-code-service.ts`、`registration/invitation-rules.ts`）：`nfrc_` 加 24 位随机，库里存 SHA-256；默认 7 天过期，可绑定用户名与角色，由管理员接口创建/吊销；校验失败顺序为已吊销、已使用、已过期、用户名不符，查无此码与格式错误同为 `CODE_INVALID`。
- Step-up（`step-up-service.ts`）：导出凭据与含提供商的数据导出前，需再次验证密码（先试本地，不通过再试 LDAP 绑定身份）加第二因子，得到 5 分钟、单次、绑定用户/会话/用途的内存授权 `nfsu_…`，用途 `credentials.export`、`storage.export.providers`；失败共用 MFA 限流桶，无任何因子的账号不能 step up。

- WebAuthn 的 RP 由请求的 `Origin` 头推出（`lib/webauthn-rp.ts:resolveRp`）：`settings.auth.webauthn` 的 `rpID`/`origins` 优先，验证时接受配置的源加当前请求源；既无 Origin 又无配置源报 `WEBAUTHN_NO_ORIGIN`，无法定 rpID 报 `WEBAUTHN_NO_RP`（均 400）。
- OIDC 发现文档与 JWKS 按 issuer 缓存（`lib/oidc.ts:discover`），授权 URL 带 state、nonce、PKCE，id_token 经 JWKS 验签（`exchangeAndVerify`）。
- 身份来源标识：LDAP 绑定的 `user_identities.provider` 以 `ldap:` 开头（`shared/identity-providers.ts`），前端据此不给解绑按钮，服务端也拒绝解绑，错误码 `LDAP_IDENTITY_MANAGED`（两处必须一致）。
- 管理员配置：`GET/PATCH /api/admin/auth-config` 返回前经 `lib/auth-settings.ts:maskAuthSettings` 去掉 `jwtSecret`、遮蔽 OIDC `clientSecret` 与 LDAP `bindPassword`；写入时以 `*` 开头或为空的值视为「保持原值」（`isMaskedSecret`），所以不能把真实以 `*` 开头的密钥存进去。
- 前端：`frontend/lib/api/auth.ts` 封装全部登录/MFA/Passkey/SSO/step-up 调用（含 `@simplewebauthn/browser`）；`routes/login.tsx` 登录页；`routes/settings/security.tsx` 个人 TOTP、Passkey、绑定身份；`routes/settings/authentication.tsx` 管理员配 LDAP/OIDC/WebAuthn；`components/settings/RegistrationCodesSection.tsx` 邀请码管理；`StepUpFields.tsx` 导出凭据时的密码加第二因子表单。

## 从哪读起
- `server/lib/auth.ts:loginUser`、`registerUser`；`server/routes/auth.ts`：全部 `/api/auth/*`。
- 测试：`lib/__tests__/auth-attempt-limiter.test.ts`、`register-with-code.test.ts`，`services/__tests__/ldap-auth-service.test.ts`、`step-up-service.test.ts`

## 改它时
- 加一种登录方式：出口必须走 `buildSessionResult`，并决定是否经过 MFA 步骤（Passkey 无用户名登录与 SSO 直接发会话）；新增的失败路径要计入 `auth-attempt-limiter` 的桶，否则暴力尝试不受限。
- 改限流额度：`lib/auth-attempt-limiter.ts`，测试 `lib/__tests__/auth-attempt-limiter.test.ts`、`registration-attempt-limiter.test.ts`；改注册行为看 `register-with-code.test.ts`、`register-closes-registration.test.ts`。
- 改 LDAP：`services/__tests__/ldap-auth-service.test.ts`、`routes/__tests__/auth-ldap-login.test.ts`、`admin-ldap-auth-config.test.ts`；账号归属规则不要放宽到「同名管理员自动绑定」。
- 改 step-up 用途：用途字符串在后端 `step-up-service.ts` 与前端 `lib/api/auth.ts:StepUpPurpose` 各有一份，要一起改；测试 `step-up-service.test.ts`。
- 改认证设置的字段：同步 `maskAuthSettings`（新增的密钥字段要遮蔽），测试 `lib/__tests__/auth-settings.test.ts`、`admin-auth-config-schema.test.ts`。
- 新增面向用户的文案同时改 `frontend/locales/{en,zh-CN}/` 的 `common`/`settings` 命名空间。

## 相关
- [会话令牌](sessions.md)
- [OAuth 与开放 API](../oauth-api/index.md)
