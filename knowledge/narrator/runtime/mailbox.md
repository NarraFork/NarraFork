---
id: narrator.runtime.mailbox
title: 收件箱与唤醒
summary: mailbox、inbox、pending-wake、async-work：消息怎么排队、会话怎么被唤醒。
anchors:
  - server/services/narrator-buffer.ts
  - server/services/buffer-edit-request.ts
  - server/services/buffer-edit-hold.ts
  - server/services/agent-runtime/mailbox.ts
  - server/services/agent-runtime/inbox.ts
  - server/services/agent-runtime/pending-wake.ts
  - server/services/agent-runtime/async-work.ts
  - server/services/agent-runtime/limits.ts
  - server/services/agent-runtime/mailbox-shared.ts
  - server/services/agent-runtime/mailbox-types.ts
  - server/services/agent-runtime/runtime-queue-port.ts
  - server/services/agent-runtime/postgres-runtime-queue.ts
  - server/services/agent-runtime/read-options.ts
  - server/services/agent-message-delivery.ts
  - server/services/agent-message-origin.ts
  - server/services/parent-inbound-queue.ts
  - server/services/parent-injection-queue.ts
  - server/services/send-delivery-resolution.ts
  - shared/agent-inbox.ts
  - shared/buffer-queue-mode.ts
keywords:
  - narrator_buffered_messages
  - MAILBOX_LIMITS
  - wakeInboxIfEligible
  - enqueueInboxAgent
  - user_input
  - agent_message
  - task_notice
  - Target message queue is full
  - Stale mailbox claim
  - NF_WRITE_BACKEND
  - 收件箱
  - 排队消息
status: draft
verified_at: 2e6441ad0
---
# 收件箱与唤醒

会话的待处理输入存在 `narrator_buffered_messages`（代码里叫 mailbox / inbox）。`mailbox.ts` 是 SQLite 同步存储，`inbox.ts` 是上层门面与唤醒，`postgres-runtime-queue.ts` 是 PostgreSQL 异步对应实现。共享件归属：`limits.ts`（`MAILBOX_LIMITS`，outbox 也用）、`read-options.ts`、`async-work.ts` 锚在这里；`input.ts` 归[调度与执行](orchestrator.md)。

## 关键规则
- 三种 kind，各自待处理上限（状态 queued/claimed/failed 计入）：`user_input` 50、`agent_message` 50、`task_notice` 按 `noticeKind`（agent/bash）各 100；满了返回 `full`（`mailbox.ts:mailboxHasCapacity`）。
- 入队结果：
  - `accepted`：新行；`duplicate`：同 `(narrator_id, dedupe_key)` 已有行，返回原回执。
  - `full`：容量满；`publication_pending`：同接收方同类 outbox 仍有 pending 的通知。
  - `inbox.ts:enqueueInboxAgent` 把 `full` 与 `publication_pending` 统一抛成 `Target message queue is full`。
- 去重键：Send 用 `["send", 源叙述者, 源工具调用, 尝试号, sourceKey, 接收方]`，尝试号须为正整数；通知用 `sourceKey`；用户输入用 `requestKey`（缺省随机），去重 7 天后过期（`mailbox-shared.ts:mailboxDedupeKey`）。
- 体积：正文内联上限 256KB；agent 消息正文 256KB、投影后 512KB；元数据 16KB；task_notice 正文加元数据不得超 4KB；超限抛错，不截断（`mailbox.ts:validate`）。
- 取队首顺序：`priority` 降序；用户输入按 `seq`，其余按 `arrivalSeq`；同值再按 `arrivalSeq`。只有 `arrivalSeq` 小于该接收方最早 pending outbox 的行才可取，outbox 因此是屏障（`eligibleHeads`）。
- 认领：`claimInboxHead` 要求已持有执行 owner，token 带进程前缀，epoch 取 owner 的 epoch；谓词只检查全局队首，不跳过队首。
- 缓冲编辑保持期间（`isBufferConsumptionHeld`）用户输入不可见、不可认领。
- 唤醒（`wakeInboxIfEligible`）：每个叙述者合并成一次探测，30 秒截止；先冲刷发布屏障。依次判定：
  - 有停靠的运行 → `wakeHeldRun`；已有执行 owner、运行忙、compact 中或撤销准入被拦 → 不唤醒。
  - 叙述者已归档或不存在 → 否。
  - 上次以 `error` 或 `user_interrupt` 结束且队里没有用户输入 → 不唤醒，除非 `resumeStopped` 明确放行。
  - 队首带 `questionAnswer` → 用其执行主体续跑，无主体则不唤醒。
  - 无可唤醒输入时，只有 `eventKind` 不是 started/cancelled 的任务通知才唤醒。
  - 队里有用户输入走 `resumeBufferedMessagesIfIdle`，否则走父级入站续跑。
- 冷启动：`recoverInboxClaimsOnColdStartup` 把其他进程遗留的 claimed 行放回 queued；无进程标识的旧 token 须该叙述者当前无 owner 才恢复。
- 冷启动补唤醒：`wakeQueuedTaskNoticeRecipientsOnStartup` 按 id 分页（默认每页 100）找 `state=queued`、`kind=task_notice` 且 `eventKind` 不是 started/cancelled 的行，对每个接收方各探测一次 `wakeInboxIfEligible`（已停止、归档、忙、被占的照常不唤醒）；单个失败只记警告。原因：通知已入收件箱但提交后的唤醒随上个进程丢了。
  - PostgreSQL：走 `port.mailbox.listQueuedTaskNoticeRecipients`（`postgres-runtime-queue.ts`，只返回接收方 id）。
  - SQLite（无队列端口）：直接查 mailbox 表。
  - 仅 `main.ts` 在 `automaticResumeEnabled()` 为真、恢复句柄挂好之后后台调用；关闭自动续接则不跑。
- `pending-wake.ts:hasPendingWork`：运行中的 bash/agent 后台任务或未答的异步问题；`hasQueuedWake` 看 user_input/agent_message/task_notice。
- `async-work.ts`：分离的通信尾部任务集合，失败只置标志与计数；`drainCommunicationWork` 默认 4 秒内排空，否则抛错。
- 后端选择：`runtime-queue-port.ts` 无绑定即 SQLite；显式 PostgreSQL 而未绑定队列时抛错，绝不回退 SQLite。

## 从哪读起
- `inbox.ts:wakeInboxIfEligible`、`claimInboxHead`、`deliverInboxInjection`、`persistClaimedUserInput`。
- `mailbox.ts:createMailboxStore`；测试 `mailbox-shared.test.ts`、`runtime-queue-port.test.ts`、`postgres-runtime-queue.test.ts`。

## 改它时
- `mailbox-shared.ts` 必须保持无数据库导入：PostgreSQL 路径靠它避免加载 SQLite 的 `mailbox.ts`。
- 加一个队列操作（如 `listQueuedTaskNoticeRecipients`）要在 `mailbox.ts` 与 `postgres-runtime-queue.ts` 两处同名实现，并更新 `RuntimeQueuePort` 形状；两种行类型都须满足 `RuntimeMailboxRow`（`runtime-queue-port.test.ts` 编译期断言）。
- `inbox.ts` 登记在 `server/db/sqlite-dialect-inventory.guard.test.ts`（json1），新增 SQLite 方言用法要同步登记。

## 相关
- [输出发布](publication.md)
- [调度与执行](orchestrator.md)
- [消息存储](../messages/index.md)
