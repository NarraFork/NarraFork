---
id: collaboration.notifications
title: 通知与注意力
summary: 通知中心、注意力列表、外部 IM 提醒、扇出。
anchors:
  - server/services/notification-center-service.ts
  - server/services/notification-fanout.ts
  - server/services/notification-service.ts
  - server/services/notification-delivery.ts
  - server/services/human-attention-service.ts
  - server/routes/notifications.ts
  - shared/notification-center.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 通知与注意力

三条相对独立的通路：应用内通知中心（持久历史）、"人类注意力"收件箱（需要人处理的实时待办的投影）、以及给钉钉/飞书 webhook 的外部提醒（收件人来自[最近标签页](recent-tabs.md)）。

## 关键规则
- 通知中心（`notifications` 表）只有两种 kind：`chat_message` 与 `permission_request`（`shared/notification-center.ts:NotificationKind`）；`(user_id, kind, source_key)` 唯一用于去重；历史有界，保留最多 500 行、30 天（`NOTIFICATION_RETENTION_*`，清理见 `notification-center-maintenance.ts`）。
- 扇出：`notification-fanout.ts:initNotificationFanout` 监听事件总线：`chat:message_created` 为符合条件的成员写行（成员、非发送者、未静音、未读、仍可读房间；已软删除消息跳过；只对 dm/bot 会话，narrator 讨论室不进通知中心），收件人上限 200；`narrator:permission_request` 同理；`chat:room_read` 同步已读。扇出独立于 WebSocket，失败只记日志、不回滚源写入。
- 与角标不同，通知中心不排除正在查看的人，它是事件历史而不是实时角标。
- 路由 `/api/notifications`：列表（游标分页）、unread-count、read、`:id/delete`，均按当前用户限定；另有 `test-dingtalk`/`test-feishu`。
- 人类注意力（`human-attention-service.ts`）：把待处理的权限请求、危险操作反思、被等待的异步问题投影成一个收件箱，按调用者的叙述者 ACL 过滤；单次最多检查 400 个候选、2 秒协作式时间预算，因此一页可能很短或为空却仍带 `nextCursor`；游标不是快照。它只是投影，决策仍走各自原有的受保护端点；暴露在 `GET /api/narrators/human-attention[/:id]`。变更通过 `human_attention:changed` 事件（不带数据，观察者按自己的 ACL 重取）通知。
- 外部提醒（`notification-service.ts:handleAttention`）：叙述者 `done` 或 `waiting_permission` 时触发（`error` 不发）。收件人按会话类型分两支，之后按用户偏好（`notifyOnDone/Waiting`、钉钉/飞书开关与 webhook）分别投递：
  - 非团队会话：[最近标签页](recent-tabs.md)里有该叙述者的用户（`getRecentTabUserIdsForNarrator`），再去掉已无读权限的人（撤权后不得继续送达）。
  - 团队会话：只发"等待成员"一种提醒（`done` 等其他提醒不发）；候选 = 团队成员（`readTeamMemberIds`，上限 `TEAM_ATTENTION_MEMBERS`）加最近标签页持有者（`TEAM_ATTENTION_TAB_HOLDERS`，最多 200 人，按最近度取）；先过读权限，再过写权限（`filterUsersWhoCanRead` 后 `filterUsersWhoCanWrite`），只读旁观者不通知（`notification-service.ts:326-339`）。
- 投递（`notification-delivery.ts`）：超时 10s、响应体上限 8KB、排队上限 32，渠道为 dingtalk / feishu。

## 从哪读起
- `server/services/notification-fanout.ts`：事件到通知行。
- `server/services/notification-center-service.ts`：记录、列表、未读数、已读。
- `server/services/human-attention-service.ts`：注意力收件箱。
- `server/services/notification-service.ts`：外部 IM 提醒。
- 测试：`server/services/__tests__/notification-*.test.ts`、`human-attention-*.test.ts`。

## 相关
- [钩子](../automation/hooks.md)：`Attention` / `AttentionResolved` 钩子经 `attention-hook-bridge.ts` 消费同一组 `narrator:attention` 事件。
- [聊天与站内消息](chat.md)
- [最近标签页](recent-tabs.md)
- [团队](teams.md)
- [IM 网关](gateway.md)
