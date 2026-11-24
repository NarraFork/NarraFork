---
id: flows.subagent
title: 一次子代理委派
summary: 派出子代理、选模板与工具、嵌套与资源、结果怎么回到父会话。
anchors:
  - server/lib/agent/tools/task.ts
  - server/services/subagent-runner.ts
  - server/services/narrator-service.ts
  - server/services/agent-runtime/policy.ts
  - server/services/agent-runtime/run.ts
  - server/services/delegation-depth.ts
  - server/services/subagent-resources.ts
  - server/services/narrator-event-handler.ts
  - server/services/parent-injection-queue.ts
keywords:
  - Agent 工具
  - 派出子代理
  - run_in_background
  - 后台任务
  - background_task_started
  - subagent_type
  - 委派深度
  - subagent_conclusion_updated
  - takeover_by_user
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 一次子代理委派

主叙述者调用 `Agent` 工具，起一个独立的叙述者记录（`type="subagent"`）去做一件事，结果回到父会话的那次工具调用上。前台委派让父的工具调用一直等到子代理结束；后台委派立即返回，结果之后以通知回来。

## 路径
1. 工具入口：`tools/task.ts` 的 `agentTool.execute` 校验参数（`subagent_type` 缺省 `general`，`run_in_background`，`alias`，`workdir` 等；Bot 会话强制后台），可选地登记团队工作项或大纲委派，调 `runSubagent`。见 [子代理](../agent/subagents.md)。
2. 先走 [一次工具调用](tool-call.md) 的准入与权限，`Agent` 与其他工具一样经过 `executeTool`。
3. 串行化与解析：`subagent-runner.ts:runSubagent` 在父的 `withNarratorWorkAdmission` 内进入；模板名规范化，解析自定义模板定义，拼委派基础提示词，算超时（后台默认上限 5 小时 `BACKGROUND_TASK_TIMEOUT_MS`）。
4. 编译能力上限：`policy.ts:compileDelegationPolicy` 把模板变成写进新叙述者的 runtime policy；`resolveEffectiveSubagentModelPolicy` + `selectSubagentModel` 选模型（只能在父有效策略内收窄），无可用模型抛 `ValidationError`。
5. 建叙述者：`narratorService.createSubagent`（`narrator-service.ts`）先沿 `parent_narrator_id` 校验深度（`delegationDepthOf`，超限报 `DELEGATION_DEPTH_LIMIT_MESSAGE`），再写行并打深度戳 `withDelegationDepth`。见 [会话生命周期](../narrator/lifecycle/index.md)。
6. 登记：别名注册并持久化（会话内唯一，冲突时改名并在结果里加注）；可选 `delegateOutlineTask`；组装运行绑定 `binding`：`deliverTo`（父叙述者 + toolUseId + 精确的 toolCall 与 attempt）、前台才带 `cancelWith`、`deadlineAt`。
7. 写入初始提示：`persistSubagentUserMessage` 把任务文本作为子代理的用户消息落库，挂在父的 `toolUseId` 下。见 [消息存储](../narrator/messages/index.md)。
8. 分支，前台：`startNarratorRun({ binding, cancelSignal, foreground: true })`，随后 `await handle.foreground`，父的工具调用一直挂着，父的取消经 `cancelWith` 传到子；返回 `result.output` 作为工具结果。
9. 分支，后台：`backgroundTaskService.createAgentTask` 登记，发 `narrator:background_task_started` 事件与同名 WebSocket 帧，`startNarratorRun` 采用该登记，工具**立即**返回含 `<background_task_id>` 的启动文本。`takeover_by_user` 时先建运行保持（hold），完成不通知父。
10. 子代理运行：与 [一轮对话](turn.md) 的步骤 6-12 同一条路径（`run.ts:executeRun` → `orchestrator`）；它的事件在 `processEvent` 里带 `parentToolUseId`，经 `dualBroadcast` 同时发给子叙述者和父叙述者，所以父的界面能内联显示子的进展。
11. 子的工具与资源：子代理的工具集受步骤 4 的上限约束，被委派者默认不能再启动代理、向用户提问、切换目录；只有 `worker` 能再向下启动一层。子代理创建的终端和浏览器在运行结束或被归档时由 `subagent-resources.ts` 回收（浏览器在无待处理工作时关，终端保留）。
12. 结束：`run.ts:finishRun` 汇总终态；前台交付走 `commitAgentTerminal`（delivery: foreground）并 `bindResultMessage`，结果就是步骤 8 工具调用的返回；`settleStatus` 把子置回 `idle` 并向父广播 `subagent_status_changed`。
13. 分支，后台结束：`deliverDetachedResult` 把后台任务标为 completed / failed / cancelled / timed_out，提交终态；`recordTaskNoticeUser`、`announcePersistedAgentTerminal` 让父收到任务通知；父若空闲则由收件箱唤醒下一轮，若运行中则排队。结果同时更新父那次 `Agent` 工具调用的结论并广播 `subagent_conclusion_updated`。
14. 分支，超时 / 取消 / 出错：终态分别为 `timed_out` / `cancelled` / `failed`，文本里带最后输出；父停止或超时时 `stopSubagentHelpers` 一并停掉它的 helper。

## 改它时
- 新增一个模板：`policy.ts:compileDelegationPolicy` 里的能力上限、`task.ts` 的 `subagent_type` 描述与枚举、模型偏好 `settings.agent.subagentModels`、前端的子代理卡片与创建界面；未知名字会按只读处理，不会报错。
- 改嵌套深度：`MAX_DELEGATION_DEPTH` 同时作用于深度戳（`withDelegationDepth`）和兜底校验（`delegationDepthOf`，`createSubagent` 与 `narrator-control.ts` 都用），ForkNarrator 另有独立的 fork 深度。
- 改结果回传：前台看 `finishRun` 的 foreground 分支，后台看 `deliverDetachedResult` 与 `backgroundTaskService`，崩溃恢复看 [中断与恢复](../narrator/recovery.md) 的子代理接续——三处契约要一起对齐。
- 改子代理的资源回收：`subagent-resources.ts` 的归档路径与一次运行结束路径是两个入口。

## 相关
- [子代理](../agent/subagents.md)
- [一轮对话](turn.md)
- [调度与执行](../narrator/runtime/orchestrator.md)
- 「未核实」：团队工作项（`isolation: "worktree"`）与大纲委派在步骤 1、6 的细节没有追到底；`backgroundTaskService` 内部的状态机未逐项核对。
