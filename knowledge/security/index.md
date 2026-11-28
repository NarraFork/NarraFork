---
id: security
title: 权限与安全
summary: 谁能做什么：工具调用审批、访问控制、登录、开放接口、外部进程加固。
anchors: []
keywords:
  - 权限
  - 安全
  - 鉴权
  - 认证
  - 授权
  - requireAuth
  - requireAdmin
  - requireSessionAuth
  - bypassPermissions
  - readOnly
  - dontAsk
  - 会话令牌
  - OAuth
  - ACL
  - safeSpawn
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 权限与安全

这一块回答「谁能对什么做什么」，分四层，从外到内依次拦截：

1. 认证（[登录与会话令牌](auth/index.md)、[OAuth 与开放 API](oauth-api/index.md)）：`middleware/auth.ts` 的 `authenticateRequest` 把 Bearer 令牌解析成两种主体之一。`nfs_` 开头的不透明会话令牌是第一方用户；其他令牌按 OAuth 访问令牌校验，属于第三方。两种主体能到达的路由不同：管理员接口和授权同意只收会话主体，`/api/external/v1` 只收 OAuth 主体。
2. 资源授权（[访问控制](acl.md)）：认证后，对项目、叙述者、知识库按 owner、可见范围、授权记录判读写。项目是外层的门，必要而不充分，叙述者再用自己的规则判断。
3. 操作审批（[工具调用审批](tool-permissions/index.md)）：Agent 的每次工具调用再按权限模式、执行策略规则和危险反思判定；需要人决定时，审批接口要求审批者对该叙述者有写权限。OAuth 叙述者的运行时约束作为硬上限叠加在这一层。
4. 进程层加固（[外部进程加固](hardening.md)）：服务端自己跑 git 时禁掉仓库配置里的钩子和过滤器，子进程统一经 `safeSpawn` 加超时与输出上限。终端访问控制归在资源授权一层（[访问控制](acl.md)），复用叙述者 ACL。

这些都是应用层护栏，不是操作系统沙箱。

## 下面有什么

- [工具调用审批](tool-permissions/index.md)：权限请求流程、模式（readOnly/dontAsk/plan…）、危险反思、执行策略、规则申请。
- [访问控制](acl.md)：叙述者与项目的读写授权、可见范围与受众、共享，以及终端访问控制。
- [登录与会话令牌](auth/index.md)：第一方登录换会话令牌、每个请求如何认证；下分会话令牌，以及登录方式与第二因子（MFA、Passkey、LDAP、SSO、注册）。
- [OAuth 与开放 API](oauth-api/index.md)：OAuth 2.0 应用与授权、External API v1。
- [外部进程加固](hardening.md)：git 执行加固、子进程统一封装（safeSpawn）。
