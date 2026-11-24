---
id: narrator.recovery
title: 中断与恢复
summary: 进程重启、输出中断、子代理恢复。
anchors:
  - server/services/narrator-recovery.ts
  - server/services/narrator-output-recovery.ts
  - server/services/narrator-subagent-recovery.ts
  - server/services/restart-recovery-service.ts
  - server/services/__tests__/context-overflow-recovery.test.ts
  - server/services/__tests__/narrator-output-recovery.test.ts
  - server/services/__tests__/narrator-subagent-recovery.test.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 中断与恢复

一轮运行被打断时的三类善后：请求层错误（上下文超长、瞬时错误）自动重试；半截输出清理；子代理未完成工作的接续。进程重启后的整体恢复在 `restart-recovery-service.ts`，本节只记录它对输出清理的调用。

## 关键规则
- 上下文超长：`narrator-recovery.ts:handleContextOverflow` 分两阶段。阶段 A：若已有更新的压缩（`getLatestCompactSeq` 大于失败请求时的基线）、或有压缩正在进行（等待并把后台压缩升级为 blocking）、或已有未应用的历史压缩，则直接 `retry_compacted`，**不消耗**重试次数。阶段 B：消耗一次重试（`MAX_CONTEXT_OVERFLOW_RETRIES = 2`），找压缩边界后做紧急压缩 `runCustomCompact`（`trigger: "context_overflow"`，摘要追加提示避免再次塞满窗口）。
- 失败原因枚举：`max_retries_exceeded`、`no_compact_boundary`、`compact_noop`、`compact_failed`，各对应固定 errorCode（`context_too_long_*`，`getContextOverflowFailureError`）。重试不轮换 conversationId，以保留缓存/粘性会话；用户中断（signal abort）按失败返回，不算新的恢复尝试。一轮有完成的助手回合后重置计数（`resetContextOverflowRetriesAfterProgress`）。
- 瞬时错误：`handleTransientError` 决定是否重试（退避、日志、前端通知），上限与退避上限来自 `settings.agent`（`maxTransientRetries`、`retryBackoffCeilMs` 等 getter）；`abortableSleep` 在 signal 触发时提前醒来。
- 半截输出：文本/推理块带 `completed` 标记，成功的 assistant_message 才经 `completeAssistantOutput` 把块标为 `completed: true`（`narrator-event-handler.ts` 调用）；冷恢复时 `cleanupIncompleteNarratorOutput` 只处理该叙述者最后一条 assistant 行，删去 `completed === false` 的文本/推理块，用写时复制（`copyOnWriteMessage`，保留执行所有者）落库；没有标记的旧数据视为完整，不靠文本或签名推断（`removeIncompleteOutputBlocks`）。重启恢复在选定目标后逐个调用它（`restart-recovery-service.ts`）。
- 子代理恢复两条路径（`narrator-subagent-recovery.ts` 文件头）：A，最后一个顶层助手回合里含未完成的 `Agent`（前台）或 `Await({type:"agent"})` 调用时，点“继续”重建“父在等子代理”的状态，前台子代理仍为前台，结束后把结果写回原工具调用（`selectRecoverableToolCalls`、`resumeIncompleteAgentWorkForContinue`）；B，叙述者出错时插入一张仅 UI 的恢复卡，列出 A 不覆盖的失败子代理（后台的、更早回合的前台的），用户勾选后恢复，更早回合的前台子代理先转为后台（`persistSubagentRecoveryCard`、`resumeRecoverySubagents`）。
- 候选筛选刻意宽松：因为三种出错路径留下的工具调用状态不同（成功但输出含 "Subagent error:"、用户中断后 fail、叙述者自身出错留下 initializing/pending/running）；子代理 substatus 含 error / interrupted / timeout 视为未完成。卡片通过 `recovery-offered:` trait 前缀记录已提供过的失败时间，避免重复提示（`buildRecoveryOfferedTrait`）。

## 从哪读起
- `server/services/narrator-recovery.ts:handleContextOverflow`。
- `server/services/narrator-output-recovery.ts`：半截输出清理。
- `server/services/narrator-subagent-recovery.ts:selectRecoverableToolCalls`、`selectRecoveryCardCandidates`。
- 测试：`context-overflow-recovery.test.ts`、`narrator-output-recovery.test.ts`、`narrator-subagent-recovery.test.ts`、`restart-recovery-service.test.ts`。

## 相关
- [上下文与压缩](context.md)
- [会话生命周期](lifecycle.md)
