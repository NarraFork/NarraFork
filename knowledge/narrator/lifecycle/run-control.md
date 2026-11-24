---
id: narrator.lifecycle.run-control
title: 运行与停止
summary: 创建会话、启动一次运行、停止与中断、归档与删除；narrator-service 各部分的分工。
anchors:
  - server/services/narrator-control.ts
  - server/services/narrator-archive.ts
  - server/services/narrator-session-state.ts
  - server/services/narrator-event-handler.ts
  - server/services/narrator-subagent.ts
  - server/db/schema.ts
  - server/lib/narrator-utils.ts
  - frontend/hooks/useNarrator.ts
  - frontend/hooks/useNarratorReadable.ts
  - frontend/lib/agent-reference-store.ts
  - frontend/lib/api/narrators.ts
  - frontend/routes/narrators/
  - frontend/types/narrator.ts
keywords:
  - acceptUserMessage
  - feedMessageUnlocked
  - ensureNarrator
  - activeNarrators
  - narratorCreationLocks
  - withNarratorStartAdmission
  - enqueueBufferedMessage
  - claimInboxHead
  - queueMode
  - Message queue is full
  - prepareNarratorCreation
  - publishNarratorCreated
  - executeAgentLoop
  - processEvent
  - block_complete
  - persistContentCheckpoint
  - CriticalEventPersistenceError
  - reportUnsettledRunLoopError
  - authorizeAgentControl
  - transitionNarratorArchiveGroup
  - isAskInPassing
  - archivedWithNarratorId
  - narrator:status_changed
status: draft
verified_at: 878917e97
---
# 运行与停止

创建、状态写入在 `narrator-service`，运行一轮在 `narrator-session`，单次 agent loop 的事件消费在 `narrator-executor` 与 `narrator-event-handler`；叙述者间控制在 `narrator-control`，归档在 `narrator-archive`。

## 关键规则
- 创建：`narratorService.create` 先 `prepareNarratorCreation` 组装行（校验 handle、项目、工作区、traits，`kind` 为 knowledge/setup/bot 时预装对应工具/提示词），再由 `createPreparedNarratorInTransaction` 在同一事务里同步断言并插入，提交后 `publishNarratorCreated` 做事件副作用（`narrator-service.ts`）。
- 运行入口 `narrator-session.ts:acceptUserMessage`：先在 `withNarratorStartAdmission`（按叙述者串行）内把输入写进缓冲邮箱 `enqueueBufferedMessage`（满则 `ValidationError("Message queue is full")`）；空闲则 `claimInboxHead` 认领并 `feedMessageUnlocked` 立即起跑，忙则按 `queueMode`（turn / tool / interrupt）排队、软停或紧急插入。
- `feedMessageUnlocked` 把状态置为 `working`（`updateStatus(..., "working", { setTurnStart })`），`ensureNarrator` 懒创建内存中的 `ActiveNarrator`（`activeNarrators` 表），同一叙述者的重建用 `narratorCreationLocks` 去重。
- 一轮执行：`runAgentLoop` → `narrator-executor.ts:executeAgentLoop`，它把 `agentLoop` 事件交给 `narrator-event-handler.ts:processEvent` 落库/广播，并把结果归类（上下文超长、可重试错误、余额不足、模型不可用、中断、最大轮数等）返回给 session 层决定重试、压缩或收尾。`executeAgentLoop` 的调用点在 `agent-runtime/orchestrator.ts:runAgentLoopUnlocked`，位于 `while (active.alive && owner.isCurrent())` 循环内（已核对）；子代理是否只跑一次、走不走这条路径：未核实。
- 运行失败兜底：仍处 working/waiting 的叙述者被置回 `idle` 并带 `substatus: ["error"]`（`reportUnsettledRunLoopError`）。
- 文本/推理块的落库点是 `block_complete`，不是流式增量：`processEvent` 的 `stream_text` 分支只更新内存快照并广播 `stream_event`；`block_complete` 分支先 `openStep` 保证存在部分消息，再经 `persistContentCheckpoint`（调用 `narratorStore.writeStepItem`）写入 text / reasoning 块。`executeAgentLoop` 里“文本块不在流式期间增量落库、只在内存里等到回合末”的注释已过时，以此为准。
- 中断后的排空：`config.signal` 已 abort 时，executor 仍继续处理 `tool_result`、`block_complete`、`error` 三类事件，其余事件丢弃（`executeAgentLoop`）；`block_complete` / `assistant_message` 处理抛错则升级为 `CriticalEventPersistenceError` 中止循环，其他事件只记日志（`tool_result` 失败另向前端发 `warning`）。
- 控制：叙述者对另一叙述者的 stop / steer / archive 必须持有目标登记的 controller 授权，且调用方上限允许编排、未到最大委派深度、其执行用户当前对目标有写权限；用户正接管（run hold）时 stop/archive 被拒（`narrator-control.ts:authorizeAgentControl`）。人通过 HTTP 的操作走普通写 ACL，不经此处。
- 归档：`narrator-archive.ts:transitionNarratorArchiveGroup` 对父会话和满足条件的“顺带提问”子会话（`isAskInPassing`，最多 200 个，超出报错）成组切换 `archived` / `idle`。先做运行时取消（`prepareNarratorArchive`），再在单个事务内改状态，仅提交后才发 `narrator:status_changed` 和 WS `status_change`；归档子会话记 `archivedWithNarratorId`，只有它们会随父会话一起恢复。
- 所属项目、权限等不在此展开，见各自节点。

## 从哪读起
- `server/services/narrator-service.ts:narratorService`（CRUD 与状态）、`prepareNarratorCreation`。
- `server/services/narrator-session.ts:acceptUserMessage`、`feedMessageUnlocked`、`ensureNarrator`。
- `server/services/narrator-executor.ts:executeAgentLoop`。
- `narrator-session-state.ts`：`ActiveNarrator` 与缓冲邮箱/待决权限等内存状态类型；`narrator-subagent.ts` 只是子代理模块（alias/team/executor/runner/tools）的再导出桶。
- 前端：`hooks/useNarrator.ts`（列表/分页/详情及文件树状态、回退预览等 hooks）、`lib/api/narrators.ts`（API 客户端）、`routes/narrators/`（`$narratorId`、`archived`、`index`、`workspace`）、`types/narrator.ts`（待决权限与异步提问类型）、`lib/agent-reference-store.ts`（按 WS 订阅的 agent 引用状态 unknown/unavailable/ready）、`hooks/useNarratorReadable.ts`（能否打开某会话，沿用 `useNarrator` 的请求与缓存）。
- 测试：`server/services/__tests__/narrator-session-loop.test.ts`、`narrator-executor.test.ts`。

## 改它时
- 新增 `narrators.status` 取值：`server/db/schema.ts` 枚举、`frontend/types/narrator.ts`、状态广播与前端筛选都要同步；改 schema 另须按 CLAUDE.md 生成迁移并核对 `data-portability` 导入导出。
- 新增 HTTP 控制面（stop/steer/archive 等）：人走普通写 ACL，agent 间调用必须经 `narrator-control.ts:authorizeAgentControl`，不要绕过 controller 授权。
- 改落库时机（`processEvent` 的 `block_complete` 分支）：`narrator-history-writers.guard.test.ts` 要求只有登记过的模块能直接写历史表，事件流的写入须经 store；`narrator-interrupt-task-guard.test.ts` 与 `streamed-content-publication.test.ts` 覆盖中断后的内容保留与发布。
- 改归档：归档事件只在事务提交后发；改成组范围（`isAskInPassing`、200 上限）时同看恢复逻辑 `archivedWithNarratorId`。
- 其他：先读 `narrator-session-loop.test.ts`、`narrator-executor.test.ts`。

## 相关
- [会话生命周期](index.md)
- [消息存储](../messages/index.md)
- [中断与恢复](../recovery.md)
