---
id: narrator.recovery
title: 中断与恢复
summary: 上下文超长与瞬时错误的重试、半截输出清理、子代理接续。
anchors:
  - server/services/narrator-recovery.ts
  - server/services/narrator-output-recovery.ts
  - server/services/narrator-subagent-recovery.ts
  - server/services/__tests__/context-overflow-recovery.test.ts
  - server/services/__tests__/narrator-output-recovery.test.ts
  - server/services/__tests__/narrator-subagent-recovery.test.ts
  - server/lib/agent/recovery-gate.ts
  - server/services/abandoned-tool-cleanup.ts
  - server/services/subagent-recovery-observation.ts
  - shared/continue-tail.ts
  - shared/narrator-catch-up.ts
  - shared/retry-rule-keyword.ts
keywords:
  - 继续
  - Continue
  - 子代理恢复
  - handleContextOverflow
  - MAX_CONTEXT_OVERFLOW_RETRIES
  - context_too_long
  - cleanupIncompleteNarratorOutput
  - recovery-offered
  - narrator_tool_continuations
  - ABANDONED_TOOL_CALL_TTL_MS
  - 重试规则
  - maxTransientRetries
  - retryBackoffCeilMs
  - CatchUpCursor
  - tailRoleAllowsContinue
status: draft
verified_at: 878917e97
---
# 中断与恢复

一轮运行被打断时的三类善后：请求层错误（上下文超长、瞬时错误）自动重试；半截输出清理；子代理未完成工作的接续。进程重启与更新后的整体恢复见 [实例锁、完整性与重启恢复](../platform/instance-recovery.md)，本节只记录它会调用的输出清理。

## 关键规则
- 上下文超长：`narrator-recovery.ts:handleContextOverflow` 分两阶段。阶段 A：若已有更新的压缩（`getLatestCompactSeq` 大于失败请求时的基线）、或有压缩正在进行（等待并把后台压缩升级为 blocking）、或已有未应用的历史压缩，则直接 `retry_compacted`，**不消耗**重试次数。阶段 B：消耗一次重试（`MAX_CONTEXT_OVERFLOW_RETRIES = 2`），找压缩边界后做紧急压缩 `runCustomCompact`（`trigger: "context_overflow"`，摘要追加提示避免再次塞满窗口）。
- 失败原因枚举：`max_retries_exceeded`、`no_compact_boundary`、`compact_noop`、`compact_failed`，各对应固定 errorCode（`context_too_long_*`，`getContextOverflowFailureError`）。重试不轮换 conversationId，以保留缓存/粘性会话；用户中断（signal abort）按失败返回，不算新的恢复尝试。一轮有完成的助手回合后重置计数（`resetContextOverflowRetriesAfterProgress`）。
- 瞬时错误：`handleTransientError` 决定是否重试（退避、日志、前端通知），上限与退避上限来自 `settings.agent`（`maxTransientRetries`、`retryBackoffCeilMs` 等 getter）；`abortableSleep` 在 signal 触发时提前醒来。
- 半截输出：文本/推理块带 `completed` 标记，成功的 assistant_message 才经 `completeAssistantOutput` 把块标为 `completed: true`（`narrator-event-handler.ts` 调用）；冷恢复时 `cleanupIncompleteNarratorOutput` 只处理该叙述者最后一条 assistant 行，删去 `completed === false` 的文本/推理块，用写时复制（`copyOnWriteMessage`，保留执行所有者）落库；没有标记的旧数据视为完整，不靠文本或签名推断（`removeIncompleteOutputBlocks`）。重启恢复在选定目标后逐个调用它（见上述链接）。
- 子代理恢复两条路径（`narrator-subagent-recovery.ts` 文件头）：A，最后一个顶层助手回合里含未完成的 `Agent`（前台）或 `Await({type:"agent"})` 调用时，点“继续”重建“父在等子代理”的状态，前台子代理仍为前台，结束后把结果写回原工具调用（`selectRecoverableToolCalls`、`resumeIncompleteAgentWorkForContinue`）；B，叙述者出错时插入一张仅 UI 的恢复卡，列出 A 不覆盖的失败子代理（后台的、更早回合的前台的），用户勾选后恢复，更早回合的前台子代理先转为后台（`persistSubagentRecoveryCard`、`resumeRecoverySubagents`）。
- 候选筛选刻意宽松：因为三种出错路径留下的工具调用状态不同（成功但输出含 "Subagent error:"、用户中断后 fail、叙述者自身出错留下 initializing/pending/running）；子代理 substatus 含 error / interrupted / timeout 视为未完成。卡片通过 `recovery-offered:` trait 前缀记录已提供过的失败时间，避免重复提示（`buildRecoveryOfferedTrait`）。

- 废弃的未启动工具行：非终态（initializing / pending / running）且 `execution_started_at` 为空、创建超过 30 分钟（`ABANDONED_TOOL_CALL_TTL_MS`）的 `narrator_tool_calls` 行被置为 fail（`Tool call abandoned: execution never started…`）；本进程里仍有待决权限的行跳过，一次最多处理 5000 行；只在启动后台跑一次（`main.ts` 调 `cleanupAbandonedToolCalls`，`abandoned-tool-cleanup.ts`）。已开始执行的 running 行不碰。
- “继续”按钮与接口共用判定：末尾一行角色为 `assistant` 或 `sys`（服务端注入）时才允许继续（`shared/continue-tail.ts:tailRoleAllowsContinue`，前端 `NarratorPanel` 与服务端都用它）。
- 重试规则关键词：错误卡片显示的是带 `Error: ` / `[Error] ` 前缀的装饰串，而规则匹配用原始 provider 消息，所以“标记为可重试”预填的关键词先经 `stripErrorDisplayPrefix` 去前缀（`shared/retry-rule-keyword.ts`，设置路由、`RetryRuleModal`、`lib/agent/error-handling.ts` 共用）。
- 权限闸恢复：重启后重新执行工具前先快照持久化的权限行（`PersistedRecoveryGate`），`isRecoveredHumanPermission` 判断这条是否还在等真人决定（已开始执行或已决定则否；有反思记录时只有 `plan_reflection` 且 `awaiting_user` 才算），快照经 `WeakMap` 绑定到权限选项，不进入工具输入或公开配置（`lib/agent/recovery-gate.ts`）。
- 工具续接记录 `narrator_tool_continuations`：每个工具调用最多一条，`kind` 为 deferred_tool / pending_permission / foreground_agent / background_agent / await_agent / send_await，`state` 为 paused / waiting / resuming / completed / failed / cancelled；恢复阶段记在 `payloadJson.recoveryPhase`（result_written / owner_continuation_pending / owner_continuation_started）（`schema.ts`、`tool-continuation-service.ts`）。冷启动接管的维护权检查与整体重启恢复流程属于 [实例锁、完整性与重启恢复](../platform/instance-recovery.md)；`recovery-handoff.ts`（恢复源清单，≤64 个源、≤10000 个目标、≤4 MiB）与 `recovery-observation.ts`（恢复前后的状态比对）是它的数据通道，本节只引用，未逐行核对。
- 重连追赶：WS 订阅可带 `CatchUpCursor`（父会话最后消息 ID + 至多 32 个子代理流锚点 `childAnchors`），服务端按它补发（`shared/narrator-catch-up.ts`，`narrator-messages.ts` 按上限截取）。

## 从哪读起
- `server/services/narrator-recovery.ts:handleContextOverflow`。
- `server/services/narrator-output-recovery.ts`：半截输出清理。
- `server/services/narrator-subagent-recovery.ts:selectRecoverableToolCalls`、`selectRecoveryCardCandidates`。
- 测试：`context-overflow-recovery.test.ts`、`narrator-output-recovery.test.ts`、`narrator-subagent-recovery.test.ts`。

## 改它时
- 新增失败原因或重试分类：`narrator-recovery.ts` 的原因枚举与 `getContextOverflowFailureError` 的 errorCode、前端错误卡片一起改；`context-overflow-recovery.test.ts` 会失败。
- 改半截输出清理：保持“只看最后一条 assistant 行、只删 `completed === false` 的块、经写时复制落库”，`narrator-output-recovery.test.ts` 覆盖；新增块类型要同步 `completed` 标记写入点（`narrator-event-handler.ts`）。
- 改子代理恢复候选：`narrator-subagent-recovery.test.ts` 与 `subagent-recovery-observation.ts` 的观察一致性检查一起看；新增 `recovery-offered:` 之外的去重标记要避免重复弹卡。
- 改续接记录状态：`schema.ts` 枚举、`tool-continuation-service.ts`、`platform/instance-recovery` 的恢复流程要同步。

## 相关
- [上下文与压缩](context.md)
- [会话生命周期](lifecycle/index.md)
- [实例锁、完整性与重启恢复](../platform/instance-recovery.md)
