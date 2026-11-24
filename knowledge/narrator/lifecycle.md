---
id: narrator.lifecycle
title: 会话生命周期
summary: 创建、运行、停止、归档；narrator-service 的拆分（session/executor/subagent/context/prompt/title/recovery/event-handler）。
anchors:
  - server/services/narrator-service.ts
  - server/services/narrator-session.ts
  - server/services/narrator-executor.ts
  - server/services/narrator-control.ts
  - server/services/narrator-archive.ts
  - server/services/narrator-session-state.ts
  - server/services/narrator-event-handler.ts
  - server/services/narrator-subagent.ts
  - server/services/workspace-context-service.ts
  - server/db/schema.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 会话生命周期

叙述者一行记录在 `narrators` 表；状态只有四种：`idle / working / waiting / archived`（`server/db/schema.ts` narrators.status 枚举）。创建、状态写入在 `narrator-service`，运行一轮在 `narrator-session`，单次 agent loop 的事件消费在 `narrator-executor`。

## 关键规则
- 创建：`narratorService.create` 先 `prepareNarratorCreation` 组装行（校验 handle、项目、工作区、traits，`kind` 为 knowledge/setup/bot 时预装对应工具/提示词），再由 `createPreparedNarratorInTransaction` 在同一事务里同步断言并插入，提交后 `publishNarratorCreated` 做事件副作用（`narrator-service.ts`）。
- 运行入口 `narrator-session.ts:acceptUserMessage`：先在 `withNarratorStartAdmission`（按叙述者串行）内把输入写进缓冲邮箱 `enqueueBufferedMessage`（满则 `ValidationError("Message queue is full")`）；空闲则 `claimInboxHead` 认领并 `feedMessageUnlocked` 立即起跑，忙则按 `queueMode`（turn / tool / interrupt）排队、软停或紧急插入。
- `feedMessageUnlocked` 把状态置为 `working`（`updateStatus(..., "working", { setTurnStart })`），`ensureNarrator` 懒创建内存中的 `ActiveNarrator`（`activeNarrators` 表），同一叙述者的重建用 `narratorCreationLocks` 去重。
- 一轮执行：`runAgentLoop` → `narrator-executor.ts:executeAgentLoop`，它把 `agentLoop` 事件交给 `narrator-event-handler.ts:processEvent` 落库/广播，并把结果归类（上下文超长、可重试错误、余额不足、模型不可用、中断、最大轮数等）返回给 session 层决定重试、压缩或收尾。`executeAgentLoop` 的调用点在 `agent-runtime/orchestrator.ts:runAgentLoopUnlocked`，位于 `while (active.alive && owner.isCurrent())` 循环内（已核对）；子代理是否只跑一次、走不走这条路径：未核实。
- 运行失败兜底：仍处 working/waiting 的叙述者被置回 `idle` 并带 `substatus: ["error"]`（`reportUnsettledRunLoopError`）。
- 控制：叙述者对另一叙述者的 stop / steer / archive 必须持有目标登记的 controller 授权，且调用方上限允许编排、未到最大委派深度、其执行用户当前对目标有写权限；用户正接管（run hold）时 stop/archive 被拒（`narrator-control.ts:authorizeAgentControl`）。人通过 HTTP 的操作走普通写 ACL，不经此处。
- 归档：`narrator-archive.ts:transitionNarratorArchiveGroup` 对父会话和满足条件的“顺带提问”子会话（`isAskInPassing`，最多 200 个，超出报错）成组切换 `archived` / `idle`。先做运行时取消（`prepareNarratorArchive`），再在单个事务内改状态，仅提交后才发 `narrator:status_changed` 和 WS `status_change`；归档子会话记 `archivedWithNarratorId`，只有它们会随父会话一起恢复。
- 工作目录上下文：`workspaceContextService`（`workspace-context-service.ts`）管叙述者的工作目录与设备目录映射，修订号存 `narrators.workspaceRevision`；`withRevision` 在变更准入内比对修订号，变了报 `WORKSPACE_CONTEXT_CONFLICT`，忙碌报 `WORKSPACE_CONTEXT_BUSY`；`switch` 仅限 primary 且无 `background` 特征、非知识管家的叙述者，HTTP 来源在运行/等待中被拒，agent 来源不受此限（`supportsDirectorySwitch`、`switch`）。它不读写 `workspaces` 面板表，面板见[工作区布局](workspaces.md)。
- 所属项目、权限等不在此展开，见各自节点。

## 从哪读起
- `server/services/narrator-service.ts:narratorService`（CRUD 与状态）、`prepareNarratorCreation`。
- `server/services/narrator-session.ts:acceptUserMessage`、`feedMessageUnlocked`、`ensureNarrator`。
- `server/services/narrator-executor.ts:executeAgentLoop`。
- 测试：`server/services/__tests__/narrator-session-loop.test.ts`、`narrator-executor.test.ts`。

## 相关
- [消息存储](messages.md)
- [中断与恢复](recovery.md)
- [提示词与注入](prompts.md)
