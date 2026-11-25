---
id: collaboration.chat
title: 聊天与站内消息
summary: 聊天房间种类、成员间消息。
anchors:
  - server/services/chat-service.ts
  - server/services/chat-notify.ts
  - server/services/bot-chat.ts
  - server/routes/chat.ts
  - shared/chat-room-kinds.ts
  - frontend/components/chat/
  - frontend/hooks/useChat.ts
  - frontend/lib/api/chat.ts
  - frontend/routes/messages.tsx
  - server/lib/validators/chat.ts
  - server/lib/chat-attachments.ts
keywords:
  - /api/chat
  - chat_rooms
  - chat_messages
  - chat_room_members
  - chat_attachments
  - chat:message
  - chat:unread_changed
  - chat:message_created
  - sendAsBot
  - 站内消息
  - 私信
  - 讨论室
  - /messages
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 聊天与站内消息

聊天房间与消息存放在独立的表（`chat_rooms`、`chat_messages`、`chat_room_members`、`chat_attachments`），与叙述者上下文互不相干；成员间的站内会话就是 dm 房间。chat-service 本身不调用模型。

## 关键规则
- 三种房间（`shared/chat-room-kinds.ts:ChatRoomKind`）：
  - `dm`：1:1 封闭，`chat_room_members` 就是 ACL；房间键为排序后的两个用户 id 用 ":" 连接（`buildDmKey`）。
  - `narrator`：挂在某个叙述者旁的讨论室，读权限跟随叙述者可见性而非成员关系，成员行只存已读水位。
  - `bot`：某人与 bot 叙述者的对话，像 DM 一样封闭；发帖还要求有驱动该 bot 的权限；房间键 `bot:<narratorId>:<userId>`（`buildBotRoomKey`）。
- dm 与 bot 是"会话"（`isConversationRoomKind`）：进消息页、其未读计入导航角标与通知中心；narrator 房间的角标属于叙述者工具栏。服务端列表与客户端缓存必须一致使用这个分组。
- 消息上限：人 8000 字符、bot 32000 字符；一条消息的附件数有上限；空文本且无附件被拒（`chat-service.ts:postMessage`、`CHAT_MESSAGE_MAX_CHARS`、`CHAT_BOT_MESSAGE_MAX_CHARS`）。
- seq 在写事务内从 `chat_rooms.next_seq` 领取，不用 `MAX(seq)`；分页读 `LIMIT n+1` 不做 COUNT；房间列表读 `last_message_preview`（120 字符）而非正文；未读用带硬上限的探测（`CHAT_UNREAD_PROBE_LIMIT`）。
- bot 房间的发帖就是 bot 的下一次输入：先由 `bot-chat.ts:admitBotPost` 交给 bot，成功后才落库；bot 队列满则立即答复发帖人、消息留在其输入框；同一 bot 的发帖串行化以保证顺序。bot 回话唯一途径是 `sendAsBot`（对应 bot 内的 `Send({ user })`）。
- 转发讨论室内容给叙述者是客户端的显式动作，走叙述者正常输入路径。
- 推送：`chat-notify.ts` 把 `chat:*` 事件分两路：房间订阅者收完整消息行（`chat:message`），未在查看的成员只收 id + 未读数（`chat:unread_changed`）；失败只记日志，不影响已提交的写入。
- 附件：每条消息最多 10 个（`CHAT_ATTACHMENTS_PER_MESSAGE_MAX`），草稿最多 30 个，一条消息附件总大小 64MB（`server/lib/chat-attachments.ts`）；路由里另有 `materialize-attachments`。
- 路由 `/api/chat`：directory、rooms、unread、rooms/dm、rooms/narrator/:id、rooms/bot/:id、消息列表/发送/删除、附件上传/下载/删除、read（已读）、summarize（带限频令牌桶，上限 200 条/40000 字符）。

## 从哪读起
- `server/services/chat-service.ts`：房间解析、发帖、分页、未读。
- `server/services/bot-chat.ts`：bot 与房间的桥。
- `server/routes/chat.ts`：HTTP 面。
- 测试：`server/services/__tests__/chat-service.test.ts`、`bot-chat.test.ts`、`chat-notify.test.ts`、`chat-public-discussion.test.ts`。

## 前端
- `frontend/routes/messages.tsx`：`/messages` 页（`?room=` 记录当前房间），只列 dm 与 bot 会话；narrator 讨论室从叙述者工具栏进入（`NarratorUserChatPanel.tsx`），不在此页。
- `frontend/hooks/useChat.ts`：订阅 `chat:message` / `chat:message_deleted` / `chat:read`（房间内），全局订阅 `chat:unread_changed` 更新角标；重连后补取。
- `frontend/components/chat/`：`ChatRoomView`、`ChatMessageList`（虚拟列表适配 `chat-vlist-adapter.ts`）、`BotChatPage`、输入草稿 `chat-composer-draft.ts`、附件 `chat-limits.ts`（与服务端上限镜像）。

## 改它时
- 改房间种类：`shared/chat-room-kinds.ts` 是分组的唯一来源（`isConversationRoomKind`），服务端列表、角标、通知扇出与客户端缓存都要跟着看；`chat-service.test.ts`、`bot-chat.test.ts` 覆盖。
- 改消息/附件上限：服务端常量（`chat-service.ts`、`lib/chat-attachments.ts`、`validators/chat.ts` 里另有一份 `CHAT_ATTACHMENTS_PER_MESSAGE_MAX`）与前端 `chat-limits.ts` 三处要一致。
- 新增 `chat:*` 事件：事件总线类型（`server/lib/event-bus.ts`）、`chat-notify.ts` 的分发（完整行只给房间订阅者，其余只给 id + 未读数）、`notification-fanout.ts`（若要进通知中心）、前端 `useChat.ts`；事件里只放 id 与标量，不放正文。
- 动 `chat_*` 表：不在数据导出清单里（`server/db/snapshot-protocol.ts` 无 chat 表）；SQLite 与 PG schema 两份都要改。
- 公开分享讨论复用 chat-service：改 `listPublicDiscussion`/`postPublicDiscussion` 要跑 `chat-public-discussion.test.ts` 与 `narrator-ws-public-share.test.ts`。

## 相关
- [通知与注意力](notifications.md)
- [分享](sharing.md)：公开分享的讨论（`listPublicDiscussion`/`postPublicDiscussion`）也走 chat-service。
