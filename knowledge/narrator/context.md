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
  - server/services/narrator-conversation-identity.ts
  - server/services/narrator-history-token-estimate.ts
keywords:
  - 压缩
  - compact
  - ContextAsk
  - contextSummary
  - COMPACT_IN_PROGRESS
  - CONTEXT_COMPOSITION_UNAVAILABLE
  - /api/narrators/:id/compact
  - /api/narrators/:id/context-composition
  - /api/narrators/:id/compact/:messageId/live
  - /api/narrators/:id/segment-compact
  - context_usage
  - settings.agent.contextThresholds
  - settings.agent.summaryModel
  - 摘要模型
  - 上下文占用
  - api_conversation_id
  - model_history_revision
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

- 触发阈值：按模型上下文窗口分档——大于 `LARGE_CONTEXT_BOUNDARY`（600000）为 large，否则 standard；阈值取 `settings.agent.contextThresholds[tier]`，缺省 `DEFAULT_CONTEXT_THRESHOLDS`（standard 95%、large 75%）（`lib/settings/provider.ts:getContextThresholds`、`shared/context-thresholds.ts`）。`context_usage` 事件把 `compactStart` 发给前端，并调用 `hooks.onContextUsage`；真正的触发判断在 `narrator-session.ts:buildContextManagementHooks`（测试 `context-usage-compact-guard.test.ts` 注入固定阈值）。
- 占用快照有硬上限：序列化超过 16 KiB（`CONTEXT_USAGE_SNAPSHOT_MAX_BYTES`）或输入构成与总量对不上就整体丢弃，读时同样校验（`context-usage-snapshot.ts:boundedContextSnapshot`）；构成分段最多 2048 段，各段字符数之和必须恰好等于总量，否则整组作废（`shared/context-usage.ts:readInputCompositionSegments`）；字符数一律是 UTF-16 `length`，不是 token 或字节（`lib/context-characters.ts`）。类别固定为 system / summary / toolDefinition / user / assistant / reasoning / toolCall / toolResult / attachment / other（`shared/context-composition.ts`）。`context-numeric-cache.ts` 只缓存数值（最多 32 个 actor、8 MiB），从不保留正文。
- 上下文变化摘要：`context_update` 行写入时可注册 refiner，用上一行与当前值生成“变了什么”的读者摘要（`context-display-refiners.ts:registerContextDisplayRefiner`）。
- 压缩状态消息：`status` 为 compacting / compacted / failed，`mode` 为 blocking / background，`trigger` 为 manual / background / context_overflow / reasoning_only / retry，最多保留 10 次尝试、错误文本 2000 字符（`shared/compact-message.ts`）。
- 压缩详情实时流：`GET /api/narrators/:id/compact/:messageId/live`（SSE，带 `outputOffset` 等偏移参数），前端 `consumeCompactLiveStream` 只在压缩详情弹窗打开时消费，缓冲上限 64000 字符。
- 对话身份：`narrators.api_conversation_id` 由 `claimConversationIdentity` 以 `model_history_revision` 做乐观比对后写入，比对失败报 409 `CONVERSATION_IDENTITY_CHANGED`；须在叙述者变更准入内、任何 provider 请求之前完成，不轮换前缀纪元（`narrator-conversation-identity.ts`）。
- 压缩后的占用估计：`estimateNarratorBuildHistoryTokens` 用与主循环相同的构建历史与系统提示路径估算下一次请求的 prompt 规模，仅作显示用的临时值，超时 10 秒（`narrator-history-token-estimate.ts`）。
- 摘要模型不可用：设置接口的 `summaryModelAvailable === false` 且已配置摘要模型时，管理员会看到摘要模型选择弹窗；非管理员或向导未完成时不弹（`frontend/components/settings/SummaryModelPickerHost.tsx`、`SummaryModelPickerModal.tsx`）。
- `ContextAsk` 工具：只读，`id` 指向可访问的子代理（主叙述者查子代理，子代理查同队兄弟），最多 8 个问题、每个 ≤ 2000 字符，不传问题则给状态摘要（`lib/agent/tools/context-ask.ts`）。

## 从哪读起
- `server/services/narrator-compact.ts:runCustomCompact`：主压缩流程与锁。
- `server/services/narrator-context-composition.ts`：占用统计入口。
- 测试：`narrator-compact-watchdog.test.ts`、`compact-queue-drain.test.ts`、`context-usage-compact-guard.test.ts`。

## 改它时
- 新增上下文类别：同改 `shared/context-composition.ts` 的 `CONTEXT_CATEGORIES`、`lib/context-characters.ts` / `lib/agent/input-characters.ts` 的分类计数与前端占用图；分段字符和必须等于总量，否则快照被丢弃。
- 改压缩触发或状态：`shared/compact-message.ts`（前后端共用）、`narrator-compact.ts`、`compact-queue-drain.ts` 一起看；`compact-timeout-failure.test.ts`、`compact-queue-drain.test.ts`、`compact-exit-drains-queue.test.ts`、`context-usage-compact-guard.test.ts` 会拦。
- 改压缩阈值默认值：只在 `shared/context-thresholds.ts`，设置页与后端共用同一份。
- 新增压缩退出路径：必须重查队列并唤醒（`drainQueuedMessagesAfterCompact`），否则用户输入会卡在队列里。

## 相关
- [消息存储](messages/index.md)
- [分叉与前缀快照](fork.md)
- [提示词与注入](prompts.md)
