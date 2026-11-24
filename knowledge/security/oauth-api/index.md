---
id: security.oauth-api
title: OAuth 与开放 API
summary: OAuth 2.0 应用与授权、External API v1，以及 OAuth 与插件共用的集成授权层。
anchors:
  - server/lib/oauth-provider.ts
  - server/routes/external-v1.ts
keywords:
  - 开放 API
  - 第三方应用
  - OAuth
  - 授权服务器
  - 会话令牌与 OAuth 令牌
  - external-narrators
status: draft
verified_at: 776dbf07e
---
# OAuth 与开放 API

NarraFork 自带一个 OAuth 2.0 授权服务器：管理员登记第三方应用，用户在同意页授权，应用换到访问令牌后，只能调用 `/api/external/v1` 这一组版本化接口（含一个外部会话 WebSocket）。它与第一方会话令牌是两条互不混用的认证路径：`/api/external/v1` 只收 OAuth 令牌，其余 `/api/*` 只收会话令牌，OAuth 主体永远不是管理员。

最近加上的“集成授权层”把 OAuth 授权与插件安装统一到同一套能力目录、授权内核和持久化模型里，所以这一块现在有三个部分。

## 由哪几部分组成
- **OAuth 服务端**：授权码 + PKCE（只支持 `S256` 公共客户端）、令牌签发与 TTL、固定的 scope 集合、应用（管理员）与授权（用户）的管理接口、客户端清单与策略、限流和安全事件、授权撤销时对运行中叙述者的硬停。
- **External API v1**：令牌换到的那一组接口；资源归属判定（不属于该授权的资源一律“不存在”）、消息披露分层、一次性 WebSocket 票据与外部会话 WebSocket、OAuth 叙述者/设备的运行时约束。
- **集成授权层**：规范能力目录、授权内核（主体、作用域、约束、阶段式判定与缓存）、authority/grants 的持久化与修订、资源绑定、事件订阅分发、审计，以及设置页“集成与扩展”的摘要。

## 怎么配合
1. 管理员登记应用，用户同意授权：`oauth_grants` 行与 authority（每个 scope × 作用域一条 grant）在同一事务里写入。
2. 应用用授权码 + PKCE 换令牌；之后每次请求都按令牌重查用户、授权与客户端。
3. External v1 的每个操作先过 scope 与项目白名单，再经授权内核判定；创建出来的设备和叙述者记入资源绑定，供后续归属判断。
4. 授权被撤销或收窄：authority 修订号变化 → 授权缓存与事件订阅失效 → 运行时硬停叙述者、断开设备与 WebSocket → 名下资源绑定标为 orphaned。
5. 插件走同一个授权层，只是 authority 的 kind 是 `plugin_installation`，能力经插件适配器映射到同一目录。

## 读哪一篇
- “授权码/令牌/TTL/scope 怎么定”“应用和授权的管理接口”“限流与安全事件”“怎么撤销”→ [OAuth 服务端](oauth-server.md)。
- “对外接口有哪些”“`detail` 披露档位”“WebSocket 票据与帧”“外部叙述者的权限约束”→ [External API v1](external-v1.md)。
- “能力目录与适配器”“授权为什么被拒（阶段与码）”“authority 修订与缓存”“资源绑定/orphaned”“事件订阅队列溢出”“审计表”“设置页摘要”→ [集成授权层](integrations.md)。

## 不变量
- OAuth 主体永远不是管理员；公共客户端只支持 S256 PKCE；WebSocket 票据一次性、30–60 秒。
- 授权撤销保留历史，不复用已撤销的行；撤销/收窄后必须硬停所属叙述者。
- 授权判定对未知关系一律拒绝；改 authority 必须带期望修订号并发出失效事件。

## 相关
- [登录与会话令牌](../auth/index.md)
- [工具调用审批](../tool-permissions/index.md)
- [插件授权与密钥](../../automation/plugins/permissions-secrets.md)

## 下面有什么

- [OAuth 服务端](oauth-server.md)：OAuth 2.0 授权服务器：授权码 + PKCE、令牌与 TTL、scope 集合、应用与授权管理、客户端清单与策略、限流与安全事件、撤销。
- [External API v1](external-v1.md)：对外 API 路由、资源授权与存在性隐藏、消息披露分层、WebSocket 票据与外部会话 WebSocket、OAuth 叙述者/设备的运行时约束。
- [集成授权层](integrations.md)：OAuth 与插件共用的授权层：能力目录与适配器、授权内核（主体/作用域/约束/判定）、authority 与 grants 存储、资源绑定、事件分发、审计与设置页摘要。
