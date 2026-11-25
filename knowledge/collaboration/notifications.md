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
  - frontend/components/AppNotifications.tsx
  - frontend/components/notifications/
  - frontend/components/settings/NotificationSection.tsx
  - frontend/hooks/useHumanAttention.ts
  - frontend/lib/api/notifications.ts
  - frontend/lib/notification-sound.ts
  - frontend/lib/notification.ts
  - frontend/routes/settings/notifications.tsx
  - server/lib/validators/notifications.ts
  - server/routes/notification-sounds.ts
  - server/services/human-attention-events.ts
  - server/services/notification-center-maintenance.ts
  - shared/human-attention.ts
keywords:
  - /api/notifications
  - /api/notification-sounds
  - /api/narrators/human-attention
  - notifications
  - notification_center_changed
  - human_attention_changed
  - human_attention:changed
  - notifyOnDone
  - notifyOnWaiting
  - notifyDingtalkEnabled
  - 钉钉
  - 飞书
  - 通知中心
  - 收件箱
  - 提示音
  - Notification 工具
  - test-dingtalk
status: draft
verified_at: 878917e97
---
# 通知与注意力

三条相对独立的通路：应用内通知中心（持久历史）、"人类注意力"收件箱（需要人处理的实时待办的投影）、以及给钉钉/飞书 webhook 的外部提醒（收件人来自[最近标签页](recent-tabs.md)）。

## 关键规则
- 通知中心（`notifications` 表）只有两种 kind：`chat_message` 与 `permission_request`（`shared/notification-center.ts:NotificationKind`）；`(user_id, kind, source_key)` 唯一用于去重；历史有界，保留最多 500 行、30 天（`NOTIFICATION_RETENTION_*`，清理见 `notification-center-maintenance.ts`）。
- 扇出：`notification-fanout.ts:initNotificationFanout` 监听事件总线：`chat:message_created` 为符合条件的成员写行（成员、非发送者、未静音、未读、仍可读房间；已软删除消息跳过；只对 dm/bot 会话，narrator 讨论室不进通知中心），收件人上限 200；`narrator:permission_request` 同理；`chat:room_read` 同步已读。扇出独立于 WebSocket，失败只记日志、不回滚源写入。
- 与角标不同，通知中心不排除正在查看的人，它是事件历史而不是实时角标。
- 路由 `/api/notifications`：列表（游标分页）、unread-count、read、`:id/delete`，均按当前用户限定；另有 `test-dingtalk`/`test-feishu`。
- 人类注意力（`human-attention-service.ts`）：把待处理的决策投影成一个收件箱，来源分别是：进行中的工具审批闸门（按工具名分 `permission` / `blocking_question`（`AskUserQuestion`）/ `plan_approval`（`ExitPlanMode`））、等待用户的危险操作反思与任务反思（`reflection`）、被等待与未被等待的异步问题（`async_question`）、大纲里要你决定的问题和待确认变更（`outline_decision`）与大纲汇报（`outline_digest`，来自 `outline/inbox.ts`）；`plan_approval` 的权限详情带 `planReflectionAvailable`（`isPendingPlanReflectionAvailable`，收件箱里才有「计划反思」按钮）；按调用者的叙述者 ACL 过滤；单次最多检查 400 个候选、2 秒协作式时间预算，因此一页可能很短或为空却仍带 `nextCursor`；游标不是快照。它只是投影，决策仍走各自原有的受保护端点；暴露在 `GET /api/narrators/human-attention[/:id]`。变更通过 `human_attention:changed` 事件（不带数据，观察者按自己的 ACL 重取）通知。
- 外部提醒（`notification-service.ts:handleAttention`）：叙述者 `done` 或 `waiting_permission` 时触发（`error` 不发）。收件人按会话类型分两支，之后按用户偏好（`notifyOnDone/Waiting`、钉钉/飞书开关与 webhook）分别投递：
  - 非团队会话：[最近标签页](recent-tabs.md)里有该叙述者的用户（`getRecentTabUserIdsForNarrator`），再去掉已无读权限的人（撤权后不得继续送达）。
  - 团队会话：只发"等待成员"一种提醒（`done` 等其他提醒不发）；候选 = 团队成员（`readTeamMemberIds`，上限 `TEAM_ATTENTION_MEMBERS` = 50）加最近标签页持有者（`TEAM_ATTENTION_TAB_HOLDERS`，最多 200 人，按最近度取）；先过读权限，再过写权限（`filterUsersWhoCanRead` 后 `filterUsersWhoCanWrite`），只读旁观者不通知（`notification-service.ts:326-339`）。
- 显式发送：`server/lib/agent/tools/notification.ts` 的 `Notification` 工具经 `notification-service.ts:sendUserNotification` 发给指定用户，不看 `notifyOnDone/Waiting` 也不看最近标签页；标题 1–120 字符、正文 1–4000 字符、渠道 1–2 个（dingtalk/feishu）；只读权限模式和未开放宽松计划的计划模式叙述者被拒（`NotificationSendForbiddenError`）。
- 投递（`notification-delivery.ts`）：超时 10s、响应体上限 8KB、排队上限 32，渠道为 dingtalk / feishu。

- 通知中心维护：后台每 60s 一轮，每轮最多处理 8 个用户、每用户删 100 行、每轮共 400 行，单轮时间预算 25ms（`notification-center-maintenance.ts`）。
- 通知铃铛里除了 `notifications` 表的行，还有知识库评审提示（`frontend/components/notifications/KnowledgeReviewNotices.tsx`）：它们不是 `notifications` 行，由知识库的评审收件箱/结果接口驱动，避免把带密级的标题写进通知表。
- 声音与前端分发：`/api/notification-sounds` 管自定义提示音上传/列表（`routes/notification-sounds.ts`）；浏览器侧 `frontend/lib/notification.ts` 按偏好触发 PWA 通知和声音（`notification-sound.ts`，Web Audio），钉钉/飞书只在服务端发。
- 注意：`frontend/lib/api/integrations.ts` 是"集成"汇总页的客户端，与通知无关。

## 从哪读起
- `server/services/notification-fanout.ts`：事件到通知行。
- `server/services/notification-center-service.ts`：记录、列表、未读数、已读。
- `server/services/human-attention-service.ts`：注意力收件箱。
- `server/services/notification-service.ts`：外部 IM 提醒。
- 测试：`server/services/__tests__/notification-*.test.ts`、`human-attention-*.test.ts`。

## 改它时
- 加一种通知 kind：`shared/notification-center.ts:NotificationKind`、`notification-fanout.ts`（监听事件与收件人判定）、`notification-center-service.ts`、前端 `components/notifications/types.ts`（筛选到 kind 的映射）与 `NotificationListItem.tsx`；`notification-fanout.test.ts`、`notification-center-service.test.ts`、`notification-source-events.test.ts` 会拦。
- 新增注意力来源：`human-attention-service.ts` 要有对应的 `kind`（`shared/human-attention.ts`），状态变化处调用 `notifyHumanAttentionChanged()`（`human-attention-events.ts`），否则客户端不会重取；决策仍必须走原有受保护端点，不要在这里加决策入口。
- 新增外部渠道：`notification-delivery.ts`、`notification-service.ts` 的 `CHANNELS`、用户偏好字段（`notify*` 列）、`NotificationSection.tsx`、`/api/notifications/test-*`。
- 改通知行的保留策略：`NOTIFICATION_RETENTION_*` 常量与 `notification-center-maintenance.ts` 一起看；所有通知读写都按当前用户限定，不能放宽。
- 团队会话的外部提醒与 IM 网关是同一规则的两侧：改 `handleAttention` 的团队分支要对照 [IM 网关](gateway.md) 的 `isTeamSession`。

## 相关
- [钩子](../automation/hooks.md)：`Attention` / `AttentionResolved` 钩子经 `attention-hook-bridge.ts` 消费同一组 `narrator:attention` 事件。
- [聊天与站内消息](chat.md)
- [最近标签页](recent-tabs.md)
- [团队](teams/index.md)
- [IM 网关](gateway.md)
