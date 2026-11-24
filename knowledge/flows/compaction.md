---
id: flows.compaction
title: 一次上下文压缩
summary: 什么时候触发、压缩消息怎么插入、之后的请求从哪开始读。
anchors:
  - server/services/narrator-compact.ts
  - server/services/narrator-persistence.ts
  - server/services/narrator-session.ts
  - server/services/agent-runtime/orchestrator.ts
  - server/services/agent-runtime/model-history-query.ts
  - server/services/compact-queue-drain.ts
  - server/services/narrator-recovery.ts
  - server/lib/settings/provider.ts
  - server/routes/narrators.ts
keywords:
  - 压缩
  - compact
  - compactStart
  - autoCompactKeepPairs
  - compact_done
  - compact_failed
  - 压缩标记
  - 自动压缩
  - 上下文超长
status: draft
verified_at: 878917e97
---
# 一次上下文压缩

把较早的对话换成一份摘要，让之后的请求只带"压缩点之后的消息 + 摘要"。旧消息不删除，只是模型看不到了。

## 路径
1. 触发，四个来源：
   - 用户手动：`POST /api/narrators/:id/compact`（`routes/narrators.ts`），已有压缩在跑返回 409 `compact_in_progress`，否则 fire-and-forget 调 `runCustomCompact`；
   - 轮内用量：`narrator-session.ts:buildContextManagementHooks` 的 `onContextUsage`，占用百分比 ≥ `getContextThresholds(model, provider).compactStart`（`lib/settings/provider.ts`，按上下文窗口分 large / standard 两档，可被 `settings.agent.contextThresholds` 覆盖）且没有压缩锁，则 `triggerMidTurnCompact`（background 模式）；
   - 一轮结束后：`orchestrator.ts` 对 `_contextUsagePct` 做同样判断，直接 `runCustomCompact(..., { mode: "background" })`；
   - 错误恢复：上下文超长时 `narrator-recovery.ts:handleContextOverflow` 做紧急压缩（见 [中断与恢复](../narrator/recovery.md)）；只推理不出内容且占用高时 `onReasoningOnlyHighContext` 做阻塞压缩。
2. 前一次压缩的结果还没被循环应用时（`hasPendingHistoryCompact` 或 `isCompactDone`），用量触发被跳过，避免对即将缩小的上下文再压一次。
3. 选边界：`narratorService.getCompactBoundaryMessage(narratorId, getAutoCompactKeepPairs())` 找出保留最近若干对消息之外的压缩边界（保留对数限制在 1–25）；找不到边界就不压缩。手动压缩可带 `beforeMessageId`。
4. 加锁：`compactLocks` 每个叙述者一把；已有压缩时 blocking 请求等待它并把后台升级为 blocking，`triggerMidTurnCompact` 直接跳过。见 [上下文与压缩](../narrator/context.md)。
5. 插入标记：`persistCompactingMessage` 在边界处插入一条状态为 compacting 的 system 标记消息，设置 `compacting` 子状态，广播 `message`（标记消息，重试时为 `message_updated`）与 `compacting`，界面显示压缩中。
6. 生成摘要：`narratorContext.generateCompactSummary` 用摘要模型（`settings.agent.summaryModel` 或调用方指定）读"上次压缩以来"的模型历史，流式输出由 watchdog 监控；超时或停滞判失败。
7. 分支，成功：在叙述者的变更准入内 `finalizeCompactingMessage` 一个事务里把该引用置 `isCompact = 1`，写 `narrators.contextSummary`，清 `apiConversationId` 与上下文用量快照；随后重置上游会话、标记"历史压缩待应用"，广播 `message_updated`（带压缩后占用估算）与 `compact_done`。标记与摘要状态冲突时报 `COMPACT_FINALIZE_CONFLICT`。
8. 分支，失败 / 取消 / 超时：标记被定为 failed（带原因）或还原，广播 `compact_failed`，`contextSummary` 不变。
9. 之后的请求怎么读：`model-history-query.ts` 查最近一个 `is_compact = 1` 的 `seq` 作为游标，只读 `seq` 大于它、未被分段压缩隐藏、非 `disp` 的消息；摘要不在消息里，而是随 `contextSummary` 进入 `buildSystemPrompt`。见 [模型历史](../narrator/runtime/model-history.md)、[提示词与注入](../narrator/prompts.md)。
10. 运行中的循环：下一次请求前，`rebuildRequestHistory` / `onBeforeTurn` 钩子重建历史与系统提示词（并 `clearActiveHistoryCompactPending`）；本轮已发出的请求不受影响。
11. 排队消息：压缩期间用户输入只入队；每次压缩退出（成功、失败、取消、超时）都调 `drainQueuedMessagesAfterCompact` 重查队列并唤醒，见 [一轮对话](turn.md) 的排队分支。
12. 撤回或编辑：`DELETE /:id/compact/:messageId` 只删本叙述者对该标记的引用；编辑摘要后 `refreshCompactContextPercentAfter` 重新测占用。

## 改它时
- 改触发条件：阈值在 `provider.ts:getContextThresholds`，三个自动触发点（轮内、轮后、错误恢复）各有自己的判断，别只改其一；跳过逻辑（步骤 2）同时防止重复压缩。
- 改"压缩点之后读什么"：`model-history-query.ts` 的游标与 `narrator-messages.ts` 的 `lastCompactRow` 系列查询、消息分页要保持同一语义（压缩点 = `isCompact = 1` 的最大 seq）。
- 新增一种压缩：参照 `runSegmentCompact` / `runPlanCompact`，要同时处理锁、标记状态、watchdog、退出时排空队列、分叉对摘要的继承（[分叉](../narrator/fork.md)）。
- 改标记的状态或字段：`persistCompactingMessage` / `finalizeCompactingMessage`、前端压缩标记组件、撤回与编辑路由、数据导出兼容一起看。

## 相关
- [上下文与压缩](../narrator/context.md)
- [一轮对话](turn.md)
- [消息存储](../narrator/messages/index.md)
- 「未核实」：步骤 6 中摘要模型请求的具体重试层次与 watchdog 时限数值；步骤 10 中钩子在每个请求前被调用的确切条件（只确认了 `rebuildRequestHistory` 在 `buildContextManagementHooks` 里清待应用标记）。
