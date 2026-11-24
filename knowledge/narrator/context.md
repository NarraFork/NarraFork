---
id: narrator.context
title: 上下文与压缩
summary: 上下文如何组成、压缩如何插入标记、上下文占用统计。
anchors:
  - server/services/narrator-context.ts
  - server/services/narrator-context-composition.ts
  - server/services/narrator-compact.ts
  - server/services/compact-live-state.ts
  - server/services/compact-queue-drain.ts
  - server/services/context-composition-history.ts
  - server/services/context-ask-service.ts
  - server/services/__tests__/compact-timeout-failure.test.ts
  - server/services/__tests__/compact-queue-drain.test.ts
  - frontend/components/settings/SummaryModelPickerHost.tsx
  - frontend/components/settings/SummaryModelPickerModal.tsx
  - frontend/lib/api/context-composition.ts
  - frontend/lib/compact-live-stream.ts
  - server/lib/agent/input-characters.ts
  - server/lib/agent/tools/context-ask.ts
  - server/lib/context-characters.ts
  - server/lib/context-usage-snapshot.ts
  - server/services/context-composition-projection.ts
  - server/services/context-display-refiners.ts
  - server/services/context-numeric-cache.ts
  - shared/compact-message.ts
  - shared/context-composition.ts
  - shared/context-thresholds.ts
  - shared/context-usage.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 上下文与压缩

模型看到的历史 = 最近一个压缩点之后的消息 + 压缩摘要。压缩不改写旧消息，而是在对话里插入一条 system 压缩标记消息（`narrator_message_refs.isCompact = 1`），旧消息对人仍可见。

## 关键规则
- 三种压缩：整段历史压缩 `runCustomCompact`（模式 blocking / background）、对选定消息的分段压缩 `runSegmentCompact`、由计划批准触发的 `runPlanCompact`（`narrator-compact.ts`）。
- 每个叙述者同一时刻只有一把压缩锁 `compactLocks`：已有压缩在跑时，blocking 请求会等待它，并把后台压缩升级为 blocking；`triggerMidTurnCompact` 遇到锁直接跳过（避免第二个 `[Compacting]` 标记）。
- 压缩标记有 compacting / compacted / failed 状态；超时或停滞由 watchdog 判定并把原因写进失败标记（`createCompactWatchdog`，中止后另有 60s 宽限 `COMPACT_ABORT_GRACE_MS`），测试用 `__setCompactWatchdogTimingsForTests` 缩短时限（`compact-timeout-failure.test.ts`）。从未流出任何字符就失败时，错误信息会追加“检查摘要模型的上下文窗口设置”的提示（`enrichCompactFailureMessage`）。
- 计划压缩：`narrator-persistence.ts:persistPlanMessage` 的实现里设置 `isCompact: 1`、`contextSummary` 与 `apiConversationId: null`（已核对），之后重置上游会话（`runPlanCompact`）。
- 压缩期间叙述者可能是空闲的但不能起新一轮（会基于即将被替换的历史运行），所以用户输入进队列；每次压缩退出（成功、失败、取消、超时）都要重查队列并唤醒（`compact-queue-drain.ts:drainQueuedMessagesAfterCompact`，测试 `compact-exit-drains-queue.test.ts`）。
- 撤回压缩：`DELETE /:id/compact/:messageId` → `narrator-messages.ts:deleteCompactMessage`，只删本叙述者对该标记的引用（分叉兄弟保留自己的视图），正在进行（compacting）的压缩须先取消，否则 409 `COMPACT_IN_PROGRESS`。
- 压缩流式进度：`compact-live-state.ts` 在内存里按消息缓存输出/思考文本，总量上限 200k 字符、单个增量上限 32k 字符。
- 摘要生成：`narrator-context.ts:narratorContext.generateContextSummary` 取“上次压缩以来”的模型历史，已有 `contextSummary` 时一并带入，避免更早的内容丢失；compressed 分叉用同一个摘要（见 [分叉](fork.md)）。
- 上下文占用统计：`narrator-context-composition.ts:getNarratorContextComposition` 按类别（system / summary / tools / 历史各段）汇总字符数，`freezeNarratorContextComposition` 在每次请求时冻结输入字符计数，`storeNarratorContextUsage` 存用量快照。历史读取在 `context-composition-history.ts` 中分批并让出事件循环（`CONTEXT_COMPOSITION_LIMITS`：批 64、切片 4ms、响应 256KiB），单次扫描最多 4096 段；PG 后端不可用时返回 503 `CONTEXT_COMPOSITION_UNAVAILABLE`。
- ContextAsk：`context-ask-service.ts:contextAskService` 用摘要模型对另一叙述者的历史做分块 map/reduce 回答问题，并发上限 4、输出上限 16000 字符、历史最多 `CONTEXT_ASK_HISTORY_MESSAGE_LIMIT`=400 条。

## 从哪读起
- `server/services/narrator-compact.ts:runCustomCompact`：主压缩流程与锁。
- `server/services/narrator-context-composition.ts`：占用统计入口。
- 测试：`narrator-compact-watchdog.test.ts`、`compact-queue-drain.test.ts`、`context-usage-compact-guard.test.ts`。

## 相关
- [消息存储](messages.md)
- [分叉与前缀快照](fork.md)
- [提示词与注入](prompts.md)
