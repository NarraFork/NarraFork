---
id: narrator.runtime.orchestrator
title: 调度与执行
summary: orchestrator、run、transition、ownership：一次运行从开始到结束的状态与边界。
anchors:
  - server/services/agent-runtime/orchestrator.ts
  - server/services/agent-runtime/run.ts
  - server/services/agent-runtime/transition.ts
  - server/services/agent-runtime/ownership.ts
  - server/services/agent-runtime/input.ts
  - server/services/agent-runtime/context.ts
  - server/services/agent-runtime/policy.ts
  - server/services/agent-runtime/checkpoint-stop.ts
  - server/services/agent-runtime/plan-approval-restart.ts
  - server/services/agent-runtime/auto-forced-switch.ts
  - server/services/agent-runtime/model-availability-wait.ts
  - server/services/agent-runtime/inherited-model.ts
  - server/services/agent-runtime/prepare-prefix-request.ts
  - server/services/agent-runtime/finalization-reads.ts
  - server/services/agent-runtime/prompt-characters.ts
  - server/services/turn-continuation-decisions.ts
  - server/services/turn-continuation-registry.ts
  - server/services/__tests__/agent-runtime-orchestrator-contract.test.ts
  - server/services/__tests__/terminal-watch-real-wake.integration.test.ts
keywords:
  - startNarratorRun
  - runAgentLoopUnlocked
  - RunControl
  - ExecutionOwner
  - NARRATOR_EXECUTION_BUSY
  - controlRun
  - detach
  - takeover
  - 接管
  - 配额等待
  - auto 自动切换
  - 跟随父会话模型
  - RuntimePolicy
status: draft
verified_at: 76675714460e80e3a2d4ca0a0ca7e55b76731ed1
---
# 调度与执行

一次运行从 `startNarratorRun` 进入，由 `ownership.ts` 保证同一叙述者同一时刻只有一个执行者，`orchestrator.ts` 跑模型回合，`transition.ts` 决定失败后怎么恢复。共享件归属：`context.ts`、`policy.ts`、`input.ts`、`finalization-reads.ts` 只被本节点使用，故锚在这里；`limits.ts` 归[收件箱与唤醒](mailbox.md)。

## 关键规则
- 所有权：`tryClaimExecution` 是同步 CAS，已有 owner 返回 null；owner 的 `release()` 只在自己仍是当前 owner 时生效，晚到的收尾不能释放新执行（`ownership.ts`）。种类只有 `run` 与 `tool-replay`。
- 启动结果：`startNarratorRun` 在 `acceptingRuns` 为 false 时返回 `notStartedReason: "admission_closed"`；owner 已被占返回 `"owned"`。`stopNarratorRunAdmission` 同时冻结检查点停止准入（`run.ts`）。
- 执行主体：优先 `req.principal`，其次 `binding.principal`，再次会话的当前用户或注册的主体；仍为 undefined 则不启动并记警告（`executeRun`）。
- 取消与期限：`RunControl.cancel` 是整次运行的取消；调用方信号只取消其精确调用；`deadlineAt` 为绝对期限，到期置 `timedOut` 并取消，恢复与 detach 不重置。
- 控制动作（`controlRun`）：
  - `stop`：停当前回合；有 hold 则运行保持，无 hold 则同时取消整次运行；`run.wake` 存在（停靠中）返回 false。
  - `cancel`：取消运行并唤醒停靠；无 run 返回 false。
  - `detach`：仅在有前台等待者、有投递目标且尚未 `finalizing` 时成功，把前台调用方交回、运行继续成任务。
  - `hold`：接管，加 `taken_over` 子状态；`finalizing` 时返回 false。
  - `release`：运行中则标记已释放并唤醒；已结束则起一个有界 owner 投递保留的结果。
- 终态：`finishRun` 先置 `finalizing`；事件类型按顺序判定：超时 `timed_out`、错误 `failed`、中断 `cancelled`、否则 `completed`；被中断（`interrupted`）时不计为错误，超时则同时记为错误。
- 回合失败恢复（`transition.ts:selectRuntimeRecovery`，纯函数），按顺序：
  - 中止 → `aborted`；欠费 → `payment`；模型不可用 → `model-unavailable`；上下文溢出 → `overflow`。
  - 无状态模型的可重试错误 → `retry-exhausted`（提供方循环已重试过，外层不再重放）。
  - 有状态模型的可重试错误或 Codex 静默断开 → `backoff`；`bypassRetryLimit` 时 maxRetries 为 -1。
  - 其余 → `completed`。
- 失败状态按 pass 结算：`onErrorCleanup` 可提前置 `hadError` 并记录 `terminalStatus`；只有既有续跑规则已准入的新 pass（例如工作区重放、held 运行接收明确输入）到达模型调用前，才可清旧 `hadError`、`terminalStatus`、`finalText`。先检查 `active.alive`、当前 owner 与未取消的请求信号，成功写 `working`（`unlessArchived`）后再次检查；归档拒绝写入则中断，不清旧状态。新 pass 成功后不遗留旧诊断；新 pass 失败则按其自身错误收尾（`orchestrator.ts:runAgentLoopUnlocked`）。
- 轮后的 `injection-drain` 只在 `hadError` 为 false 时排空注入并续跑；失败前排队的 Watch/agent 通知不能自行授权恢复。没有获准的新 pass 时，真实失败保留错误终态，`allowInboxWake` 为 false，排队输入保留。错误清理不扩大续跑来源，也不改变取消、held 本地 Stop 与整次运行取消的区别。
- 预算：上下文溢出重试 2 次（`MAX_CONTEXT_OVERFLOW_RETRIES`），回合中断重试 3 次，配额等待每次运行 3 次，`auto:` 源切换每次运行 3 次（`MAX_AUTO_SWITCHES_PER_RUN`）。
- `auto:` 模型：等待不超过 15 分钟则等，否则切到另一个能服务同模型的来源；`<前缀>:<模型>` 不切换（`auto-forced-switch.ts`）。
- 计划批准：响应仍在流式时只标记，等响应落定再压缩并中止；响应落定前结束则丢弃批准（`plan-approval-restart.ts`）。
- 检查点停止：`CheckpointStop` 是进程内释放，不是取消也不是终态；orchestrator 遇到时不写终态，保留待重启接手（`checkpoint-stop.ts`、`orchestrator.ts` 收尾分支）。
- 跟随父会话模型：每次更新用代际作废旧解析，请求边界 `settle` 一次后清除错误（`inherited-model.ts`）。
- `prompt-characters.ts:countRuntimeSystemCharacters`：未在生产代码中找到调用方（未核实是否仍需要）。

## 从哪读起
- `run.ts:startNarratorRun`、`executeRun`、`finishRun`、`controlRun`。
- `orchestrator.ts:runAgentLoopUnlocked`（回合循环与收尾）、`runtimeBasePrompt`。
- `transition.ts` 与同目录 `*.test.ts`（`plan-approval-restart`、`auto-forced-switch`）。

## 改它时
- 新增一种失败恢复：先在 `transition.ts` 的 `RuntimeRecoveryTransition` 与 `settleRuntimeRecovery` 加分支，再在 orchestrator 对应的 `[continuation-source: …]` 处理，并同步 `turn-continuation-registry.ts` 的来源。
- 改失败后的 pass 边界：同时看 `agent-runtime-orchestrator-contract.test.ts` 的合法重放、空成功输出、二次失败、归档竞争与 held 明确输入用例，以及 `terminal-watch-real-wake.integration.test.ts` 的 Watch/agent 通知在失败前排队与失败后送达用例；不能靠清错误锁存让异步通知变成恢复授权。
- 新增控制动作：改 `RunControlAction` 与 `controlRunUnlocked`，注意 `finalizing` 与 `detaching` 的竞争约定。
- `ownership.ts` 末尾会改写旧热重载遗留的 Map/Set；改字段名前先看 `adoptLegacyMap`。

## 相关
- [收件箱与唤醒](mailbox.md)
- [输出发布](publication.md)
- [模型历史](model-history.md)
- [会话生命周期](../lifecycle/index.md)
