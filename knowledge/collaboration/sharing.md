---
id: collaboration.sharing
title: 分享
summary: 公开会话分享（令牌链接 + 访客讨论）、文件分享（内存登记的临时链接）。
anchors:
  - server/services/public-narrator-share-service.ts
  - server/services/public-narrator-share-limits.ts
  - server/services/public-narrator-share-connections.ts
  - server/routes/public-narrator-shares.ts
  - server/routes/shares.ts
  - server/lib/shares.ts
  - frontend/components/public-share/
  - frontend/hooks/useNarratorPublicShares.ts
  - frontend/hooks/usePublicSharedNarrator.ts
  - frontend/lib/public-share-api.ts
  - frontend/lib/public-share-session.ts
  - frontend/routes/shared.narrators.$shareId.tsx
  - server/lib/share-preview-html.ts
  - server/lib/share-preview-worker.ts
  - server/lib/validators/public-narrator-shares.ts
  - server/services/public-narrator-share-gen-ui.ts
  - server/services/public-narrator-share-rate-limit.ts
  - shared/public-narrator-share.ts
  - shared/share-preview.ts
keywords:
  - /api/narrators/:id/public-shares
  - /api/public/narrator-shares
  - /api/shares
  - /shared/narrators/$shareId
  - narrator_public_shares
  - Authorization: Share
  - tokenHash
  - PUBLIC_SHARE_LIMITS
  - shares.defaultExpiryHours
  - share-file
  - 公开分享
  - 访客讨论
  - 文件分享
  - 分享链接
  - preview-info
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 分享

两套互不相干的机制：把一个叙述者会话以只读方式公开给无账号访客（公开会话分享），以及给文件生成临时下载/预览链接（文件分享）。

## 关键规则
公开会话分享：
- 表 `narrator_public_shares`：只存令牌的 SHA-256（`tokenHash`，唯一索引），令牌本身是 32 字节随机数的 base64url，只在创建时返回；有 `guestName`、`label`、`revokedAt`；叙述者删除时级联删除（`public-narrator-share-service.ts:createPublicShare`）。
- 管理端点挂在 `/api/narrators/:id/public-shares`（列表/创建/撤销），仅 primary 叙述者且调用者能管理其 ACL（`canManageNarratorAcl`），否则一律返回统一的 404 "unavailable"。创建时会确保该叙述者的讨论房间存在。
- 访客端点在 `/api/public/narrator-shares/:shareId/...`，不走会话鉴权：请求头必须严格为 `Authorization: Share <43 位令牌>`，shareId 为 21 位；不符、已撤销、叙述者不存在一律同一个 404（`verifyPublicShare`、`revalidatePublicShare`）。响应带 `no-store`、`noindex`、`no-referrer`。
- 访客能读的端点（`routes/public-narrator-shares.ts`）：`/:shareId`（会话卡）、`/session`、`/pretext-document`、`/tool-calls/:toolUseId`、`/tool-calls/:toolUseId/input-document`、`/text-documents/:refId`、`/message-location/:messageId`，以及读写讨论 `/discussion`（复用 chat-service 的 `listPublicDiscussion`/`postPublicDiscussion`）；其余路径 404。
- 实时更新不走独立通道：访客页在 `/ws/narrator` 上以分享凭据模式连接（前端 `setNarratorWSShareAuth`），服务端经 `public-narrator-share-connections.ts` 的预算预留连接、经 `public-narrator-share-gen-ui.ts` 把叙述者事件投影成可公开的形态：Gen UI 工具的来源一律判为 private、不对访客放行（只给摘要，`isPublicToolSourceAllowed`），未知来源也不放行；匿名连接不会进入大纲实时会话。
- 限流（`public-narrator-share-rate-limit.ts`）：令牌桶，按 IP 与按链接分开计数，互不重置——ip 容量 120/补充 2 每秒、read 240/4、post 20/0.2、connect 30/0.5；超限抛 `RateLimitError`。
- 全部预算集中在 `PUBLIC_SHARE_LIMITS`：请求体 64KB、响应 1MB、单条消息文本 8000 字符、分页默认 50/最大 100、每分享 20 连接/每 IP 20/总 200、连接最长 30 分钟等。撤销通过同步监听 `onPublicShareRevoked` 立即通知并断开连接。

文件分享：
- `server/lib/shares.ts` 的分享登记在进程内存中，带过期定时器，不跨重启保留；服务启动时 `cleanupStaleShares` 清空整个分享目录（该文件内的注释与这一行为一致）。默认过期取 `settings.shares.defaultExpiryHours`，缺省 24 小时；截图预览分享用 7 天。
- 创建时拒绝私有请求录制路径（`isPrivateRequestRecordingPath`）。创建方有 `share-file`、浏览器与 WebFetch 等工具。
- `/api/shares/:shareId`（下载）、`/preview-info`、`/preview` 公开挂载，"分享 ID 本身就是密钥"；预览响应带 sandbox CSP、`nosniff`、`no-store`；文本预览源头限流（512KB）、HTML 预览有 1MB 输入上限与超时，渲染在 worker 中（`share-preview-html.ts`）。

## 前端
- `frontend/routes/shared.narrators.$shareId.tsx` → `components/public-share/PublicSharedNarratorPage.tsx`：访客页，不用全局查询缓存、不存 localStorage、不续 JWT；凭据生命周期在 `lib/public-share-session.ts`，REST 客户端在 `lib/public-share-api.ts`（`Authorization: Share <令牌>`）。
- 管理端：`hooks/useNarratorPublicShares.ts`（叙述者上创建/撤销链接）；访客侧读取叙述者内容用 `usePublicSharedNarrator.ts`。
- 共享类型：`shared/public-narrator-share.ts`（访客会话形态）、`shared/share-preview.ts`（文件分享的预览类型与上限常量：文本 512KB/120000 字符、HTML 输入 1MB 输出 2MB、内容超时 15s、HTML 渲染超时 5s）。

## 从哪读起
- `server/services/public-narrator-share-service.ts`：创建、校验、撤销。
- `server/routes/public-narrator-shares.ts`：管理与访客两组路由。
- `server/lib/shares.ts`、`server/routes/shares.ts`：文件分享。
- 测试：`server/services/__tests__/public-narrator-share-*.test.ts`、`server/lib/__tests__/public-share-spa-headers.test.ts`、`server/lib/__tests__/screenshot-share-expiry.test.ts`（路径以仓库为准）。

## 改它时
- 给访客加一个只读端点：在 `routes/public-narrator-shares.ts` 内每次请求都走 `verifyPublicShare`/`revalidatePublicShare`（不符、撤销、叙述者不存在同一个 404），响应头保持 `no-store`/`noindex`/`no-referrer`；预算常量只加在 `PUBLIC_SHARE_LIMITS`，不要散落魔数；`server/lib/__tests__/public-share-spa-headers.test.ts` 守响应头。
- 改访客可见的事件/工具来源：`public-narrator-share-gen-ui.ts` 的白名单与 `public-narrator-share-gen-ui.test.ts`；`narrator-ws-public-share.test.ts` 覆盖 WS 面；`public-narrator-share-readthrough.test.ts` 覆盖读穿透。
- 改令牌格式：`createPublicShare` 只存 SHA-256；`Authorization: Share` 的长度校验（令牌 43 位、shareId 21 位）与前端 `public-share-api.ts` 要一起改。
- 改 `narrator_public_shares`：SQLite 与 PG schema 两边；叙述者删除级联。
- 文件分享：新增预览类型要同时改 `shared/share-preview.ts`（类型/上限）与 `server/routes/shares.ts`、`share-preview-html.ts`/`share-preview-worker.ts`（HTML 在 worker 渲染，失败不得回退主线程；`server/lib/compiled-worker.guard.test.ts` 登记了 `share-preview-worker.ts`）；分享登记在内存，截图分享有效期见 `screenshot-share-expiry.test.ts`。

## 相关
- [聊天与站内消息](chat.md)
