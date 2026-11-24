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
- 访客能读会话、工具调用/文本文档详情、消息定位，以及读写讨论（`/discussion`，复用 chat-service 的 `listPublicDiscussion`/`postPublicDiscussion`）；其余路径 404。
- 全部预算集中在 `PUBLIC_SHARE_LIMITS`：请求体 64KB、响应 1MB、单条消息文本 8000 字符、分页默认 50/最大 100、每分享 20 连接/每 IP 20/总 200、连接最长 30 分钟等。撤销通过同步监听 `onPublicShareRevoked` 立即通知并断开连接。

文件分享：
- `server/lib/shares.ts` 的分享登记在进程内存中，带过期定时器，不跨重启保留；服务启动时 `cleanupStaleShares` 清空整个分享目录（该文件内的注释与这一行为一致）。默认过期取 `settings.shares.defaultExpiryHours`，缺省 24 小时；截图预览分享用 7 天。
- 创建时拒绝私有请求录制路径（`isPrivateRequestRecordingPath`）。创建方有 `share-file`、浏览器与 WebFetch 等工具。
- `/api/shares/:shareId`（下载）、`/preview-info`、`/preview` 公开挂载，"分享 ID 本身就是密钥"；预览响应带 sandbox CSP、`nosniff`、`no-store`；文本预览源头限流（512KB）、HTML 预览有 1MB 输入上限与超时，渲染在 worker 中（`share-preview-html.ts`）。

## 从哪读起
- `server/services/public-narrator-share-service.ts`：创建、校验、撤销。
- `server/routes/public-narrator-shares.ts`：管理与访客两组路由。
- `server/lib/shares.ts`、`server/routes/shares.ts`：文件分享。
- 测试：`server/services/__tests__/public-narrator-share-*.test.ts`、`server/lib/__tests__/public-share-spa-headers.test.ts`、`server/lib/__tests__/screenshot-share-expiry.test.ts`（路径以仓库为准）。

## 相关
- [聊天与站内消息](chat.md)
