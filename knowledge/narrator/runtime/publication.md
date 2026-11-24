---
id: narrator.runtime.publication
title: 输出发布
summary: publication、outbox、runtime-write：运行结果怎么持久化并对外发布。
anchors:
  - server/services/agent-runtime/publication.ts
  - server/services/agent-runtime/publication-outbox.ts
  - server/services/agent-runtime/publication-key.ts
  - server/services/agent-runtime/publication-result.ts
  - server/services/agent-runtime/publication-reader.ts
  - server/services/agent-runtime/runtime-write.ts
  - server/services/agent-runtime/postgres-runtime-publication.ts
  - server/services/agent-runtime/read-conflict.ts
keywords:
  - runtime_publication_outbox
  - runtimePublication
  - getRuntimePublicationService
  - runAtomicWrite
  - WriteConflictError
  - RUNTIME_READ_CONFLICT
  - publication-result
  - Await 消费
  - 终态通知
  - 发布槽位
  - source_after
status: draft
verified_at: 2e6441ad0
---
# 输出发布

一个有投递目标的运行（后台 agent、bash 任务）结束时，终态不直接塞进接收方，而是先落进 outbox（`runtime_publication_outbox`），再按序转成接收方收件箱里的 `task_notice`。共享件归属：`runtime-write.ts`（原子写缝）与 `read-conflict.ts` 锚在这里，mailbox 与 outbox 都经 `runAtomicWrite`。

## 关键规则
- 身份：`PublicationRun = {producerKind(agent|bash), taskId, logicalRunId, recipientId}`；去重键为 `["publication", 种类, taskId, logicalRunId, 事件, 接收方]`（`publication-key.ts`）。事件为 started/completed/failed/timed_out/cancelled。
- 槽位：启动时 `reserveRunSlots` 预留 `terminal`（有 started 通知则再加 `started`）；终态提交时占用预留槽并删掉 started 槽。没有可用的预留槽时：接收方仍存在则抛 `Publication requires a startup reservation`；接收方已删除（非 started 事件）则按 `duplicate` 处理。
- 槽位上限：每接收方 1000、全局 10000；超出返回 `full`，`reserve` 抛 `Task publication capacity is full`。
- 提交结果：`committed`；`duplicate`（收件箱已有同键、槽位已不是 reserved、终态已被 Await 消费，或接收方已删除）。
- 已被 Await 消费的终态：删除 outbox 中的终态行，把收件箱里同键通知置 `cancelled`，原因为 `Terminal result consumed by Await`；回执主键是四元组（种类、任务、运行、接收方）。该取消是良性跳过，其他 claim 错误照常失败（`mailbox-shared.ts:isAwaitedTerminalConsumption`）。
- 转移（`transferNext`）：取接收方同种类 pending 中 `arrivalSeq` 最小者；接收方已删除则置 failed（`Recipient permanently deleted`）；收件箱通知容量满返回 `full`；否则写入 `task_notice` 并删 outbox 行。
- 投递调度（`schedule`）：定时器每次处理一页（100 行），有进展且重试次数 < 5 则继续，退避 `min(50·2^retry, 1000)` ms；失败只记警告并重试。
- 结果快照：终态文本存为消息 `publication-result:<logicalRunId>`（`disp` 角色），预览上限 12000 字符、64KB；`sourceResultRef` 指向实际助手消息或 `background_task:...`；读取按精确运行，不读 actor 的最新结果。解码体积上限 128KB，输出 12000 字符并附截断标记（`publication-result.ts`）。
- 原子写：SQLite 段必须同步，返回 Promise 会回滚并抛错；唯一约束冲突统一成 `WriteConflictError`，PG 的 40001/40P01/55P03 原样抛出由整段重试处理（`runtime-write.ts`）。
- 门面：`getRuntimePublicationService()` 按绑定的后端返回 PG 门面或 SQLite 异步包装；PG 未绑定队列时抛错，不回退 SQLite。`isRuntimePublicationUnavailableError` 仅把"未接线"视为可忽略。
- 读冲突：运行时注册、属主、策略来源任一变了抛 409 `RUNTIME_READ_CONFLICT`（`read-conflict.ts`）。
- 重启回收的身份校验：`recoverStaleTask` 可带 `expected`（重启扫描时看到的行）；PostgreSQL 的终态 CAS 此时还要求 type、父叙述者、子代理、逻辑运行、工具调用、执行尝试号（及给出时的 backgroundKind、command）与扫描时一致，否则不动该行（`postgres-runtime-publication.ts:staleTaskIdentityMatches`，对应 SQLite 的 `assertRestartTask`）。不带 `expected` 时只校验 `status=running`。
- 旧版兼容：legacy 准入用 SQLite `rowid`（PG 用 `insert_seq`）与启动时捕获的边界判断"先于协议"的任务。

## 从哪读起
- `publication.ts:createRuntimePublicationService`（`startRun`、`persistResult`、`schedule`）、`getRuntimePublicationService`。
- `publication-outbox.ts:createPublicationOutbox`；`run.ts:finishRun` 是主要调用方。
- 测试：`publication-result.test.ts`、`awaited-terminal.test.ts`、`service-cancel.test.ts`、各 `*.pg.test.ts`。

## 改它时
- 发布操作两个后端各一份：`publication.ts` 与 `postgres-runtime-publication.ts`，事务内原语来自 `postgres-runtime-queue.ts`；改规则要两边同步。
- 新增事件种类要同时改 `PublicationEvent`、`publicationEvent()`、`commitIntent` 的校验与 `publicationEventFromDedupeKey`。
- `publication.ts`、`publication-outbox.ts`、`publication-reader.ts` 登记在 `server/db/sqlite-dialect-inventory.guard.test.ts`，新增方言用法须同步。

## 相关
- [收件箱与唤醒](mailbox.md)
- [调度与执行](orchestrator.md)
