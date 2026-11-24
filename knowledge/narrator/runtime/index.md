---
id: narrator.runtime
title: 会话运行时
summary: agent-runtime：一次运行怎么被调度和执行，收件箱与唤醒，输出发布，模型历史。
anchors:
  - server/services/agent-runtime/orchestrator.ts
  - server/lib/validators/runtime-registration.ts
keywords:
  - agent-runtime
  - startNarratorRun
  - runAgentLoopUnlocked
  - 执行所有权
  - 运行时队列
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 会话运行时

`server/services/agent-runtime/` 把"一次叙述者运行"拆成四块：调度执行、收件箱与唤醒、输出发布、模型历史。目录里约 40 个非测试文件，按下面四个叶子分别锚定。

## 一次运行怎么走
- 入口只有一个：`run.ts:startNarratorRun`。用户消息、委派、Send 唤醒、继续、工具重放、重启恢复都经它。
- 步骤：短启动准入内 `ownership.ts:tryClaimExecution` 拿执行所有权，建立 `RunControl`；随后在工作准入内 `executeRun`：读注册信息和执行主体、`prepareLogicalRun` 登记逻辑运行（有投递目标时同时预留发布槽位）、再调 `orchestrator.ts:runAgentLoopUnlocked` 跑模型回合。
- 回合开始前，orchestrator 经 `prepare-prefix-request.ts` 取得前缀与历史；历史由 [模型历史](model-history.md) 从只读 worker 读出、`history.ts` 投影成模型输入。
- 回合之间、运行结束时，orchestrator 与 run 通过 [收件箱与唤醒](mailbox.md) 判断有无排队输入或未完成工作：有排队输入则同一运行继续（新一轮取新的所有权），有投递目标的运行遇到未完成的后台工作，则停靠等待（`run.ts:awaitPendingWake`）。
- 运行结束由 `run.ts:finishRun` 提交终态：结果经 [输出发布](publication.md) 的 outbox 与 `runtimePublication` 写成通知，再转入接收方的收件箱；随后释放所有权并按需唤醒收件箱。
- 存储后端：SQLite 为默认同步实现，PostgreSQL 通过 `runtime-queue-port.ts` 绑定的异步队列；两者共用同一套领域规则，见各叶子。

- 运行时注册信息：`narrators` 上存一份严格校验的 JSON（≤ 64 KiB，`version: 1`），只存关系与事实——模型池 `modelPool`、控制授权 `controller`（`steer` / `stop` / `archive`，另见 [会话生命周期](../lifecycle/index.md) 的 `authorizeAgentControl`）、历史落点 `historyPlacement`、本次运行的绑定 `run`（`logicalRunId`、`cancelWith`、`deliverTo`、`principal`、绝对 `deadlineAt`、`historyStartSeq`；新运行整体替换旧运行的事实）、outline 委派任务 `delegatedTask`；能力上限在 trait 里，策略来源链深度上限 16（`lib/validators/runtime-registration.ts`）。

## 下面有什么
- [调度与执行](orchestrator.md)：orchestrator、run、transition、ownership：一次运行从开始到结束的状态与边界。
- [收件箱与唤醒](mailbox.md)：mailbox、inbox、pending-wake、async-work：消息怎么排队、会话怎么被唤醒。
- [输出发布](publication.md)：publication、outbox、runtime-write：运行结果怎么持久化并对外发布。
- [模型历史](model-history.md)：model-history-*：发给模型的历史怎么查询、增量与修订。

## 相关
- [会话生命周期](../lifecycle/index.md)
- [Agent 循环](../../agent/loop.md)
