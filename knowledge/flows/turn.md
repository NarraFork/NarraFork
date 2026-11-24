---
id: flows.turn
title: 一轮对话
summary: 用户消息进入、排队、组装上下文、请求模型、流式输出、落库、广播到前端。
anchors:
  - server/routes/narrators.ts
  - server/services/narrator-session.ts
  - server/services/agent-runtime/run.ts
  - server/services/agent-runtime/orchestrator.ts
  - server/services/agent-runtime/history.ts
  - server/services/narrator-executor.ts
  - server/lib/agent/loop.ts
  - server/services/narrator-event-handler.ts
  - server/websocket/narrator-ws.ts
  - frontend/lib/narrator-ws-manager.ts
  - frontend/hooks/useNarratorWS.ts
  - shared/progress-phase.ts
keywords:
  - 发送消息
  - 消息排队
  - queueMode
  - buffer_set
  - user_message
  - stream_event
  - POST /api/narrators/:id/messages
  - 流式输出
status: draft
verified_at: 878917e97
---
# 一轮对话

从用户在输入框按下发送，到模型回复落库并出现在界面上的完整路径。工具执行、压缩、子代理各是这条路径上的分支，分别见各自的流程节点。

## 路径
1. HTTP 入口：`POST /api/narrators/:id/messages` 解析正文、附件、命令；`/new` 命令且叙述者空闲时直接建新叙述者并返回 201（`server/routes/narrators.ts`，`narratorRoutes.post("/:id/messages")`）。见 [会话生命周期](../narrator/lifecycle/index.md)。
2. 准入：调 `narrator-session.ts:acceptUserMessage`，在 `withNarratorStartAdmission` 内先把输入写进缓冲邮箱 `enqueueBufferedMessage`（满则 `ValidationError("Message queue is full")`）。见 [收件箱与唤醒](../narrator/runtime/mailbox.md)。
3. 分支，忙（运行中或有压缩在跑）：
   - `queueMode = interrupt` → `requestUrgentBufferedGuidance`；
   - `queueMode = tool` → `requestBufferedMessageSoftStop`；
   - `queueMode = turn`（默认）→ 只排队；
   - 三者都广播 `buffer_set`，HTTP 返回 202 `{ buffered: true }`；本轮结束后由 `run.ts:afterRunRelease` → `wakeInboxIfEligible` 唤醒消费。
4. 分支，空闲且未被 `queueOnly` 压住：`tryClaimExecution` → `ensureNarrator` → `claimInboxHead` 认领刚入队的那条 → `feedMessageUnlocked`；HTTP 返回 201 带用户消息。
5. 落库用户消息：`feedMessageUnlocked` 经 `persistClaimedUserInput` 写 `narrator_messages` 与引用行，广播 `user_message`，把状态置 `working`，首轮设临时标题。见 [消息存储](../narrator/messages/index.md)。
6. 起运行：`runAgentLoop` → `agent-runtime/run.ts:startNarratorRun` 取得执行所有权（`tryClaimExecution(id, "run")`，已有所有者则 `started: false`），建 `RunControl`，进入 `executeRun`。见 [调度与执行](../narrator/runtime/orchestrator.md)。
7. 登记运行：`executeRun` 读取运行来源、确定执行主体、`prepareLogicalRun` 登记逻辑运行与交付目标（子代理才有交付目标，见 [子代理委派](subagent.md)）。
8. 进入编排：`orchestrator.ts:runAgentLoopUnlocked` 每个 pass 先 `buildSystemPrompt`（契约 + 动态段 + 压缩摘要）再 `history.ts:buildRuntimeHistory` 取模型历史（最近压缩点之后）；有真实用户文本时先做知识库被动注入并持久化为 sys 行再重建历史。见 [提示词与注入](../narrator/prompts.md)、[模型历史](../narrator/runtime/model-history.md)。
9. 请求模型：`narrator-executor.ts:executeAgentLoop` 调 `agentLoop`，循环里构造请求历史、流式解析、重试。见 [Agent Loop](../agent/loop.md)、[模型提供商](../agent/providers/index.md)。
10. 消费事件：`executeAgentLoop` 对每个事件调 `narrator-event-handler.ts:processEvent`：`stream_text` 等只广播；`block_complete`、`assistant_message`、`tool_result` 落库后再广播。落库失败：`block_complete` / `assistant_message` 抛 `CriticalEventPersistenceError` 中止，`tool_result` 则广播 `warning` 继续。
11. 广播：`dualBroadcast` → `narrator-ws.ts:broadcastToNarrator` 发给订阅了该叙述者的 WebSocket 连接，同时向事件总线发 `narrator:message_broadcast`。见 [HTTP 与 WebSocket](../platform/http-ws.md)、[事件总线](../platform/event-bus.md)。
12. 前端接收：`narratorWSManager` 单连接分发 → `useNarratorWS` 按 `type`（`message`、`user_message`、`stream_event`、`permission_request` 等）调回调更新面板。见 [数据获取与实时同步](../frontend/data-flow.md)。
13. 分支，模型本轮带 tool_use：转 [一次工具调用](tool-call.md)，工具结果回到步骤 9 的下一轮；无 tool_use 则 `done`。
14. 分支，上下文占用超阈值：转 [一次上下文压缩](compaction.md)。
15. 分支，请求出错：`executeAgentLoop` 把结果归类（上下文超长、可重试错误、余额不足、模型不可用、中断、最大轮数），orchestrator 据此调 `handleContextOverflow` / `handleTransientError` 或收尾。见 [中断与恢复](../narrator/recovery.md)。
16. 收尾：`run.ts:finishRun` 汇总终态、（子代理）提交交付结果、`settleStatus` 把叙述者置回 `idle`（`substatus` 为 `unread` / `error` / `interrupted` / `timeout`），`afterRunRelease` 检查收件箱里排队的输入并唤醒下一轮。

## 改它时
- 加一种新的输入来源（像 IM、定时任务）：要走步骤 2 的缓冲邮箱与步骤 4 的认领，不要绕过 `acceptUserMessage` 直接起 `runAgentLoop`；同时看 `sendMessage` 的 `origin` 归属参数。
- 加一种新的 `AgentEvent`：`loop.ts` 产出、`narrator-event-handler.ts:processEvent` 的 `switch` 加分支、`server/websocket/narrator-ws-types.ts` 的消息类型、`useNarratorWS.ts` 的 `switch`、以及它的界面落点一起改；`executeAgentLoop` 若要据此终止或归类也要加。
- 改"什么算一次终态"：`executeAgentLoop` 的结果字段、`orchestrator.ts` 的分支、`run.ts:finishRun` 三处要对齐。
- 改发给模型的内容：步骤 8 的 `buildSystemPrompt` 与 `buildRuntimeHistory`；循环内另有 `history-build.ts:buildAdapterHistory` 的仅供模型的投影，别在两处各改一半。
- 改排队语义：`queueMode` 的三个分支在 `acceptUserMessage`，消费端在 `inbox.ts` / `prepareQueuedRunInput`，前端的 `buffer_set` 展示一起看。

## 相关
- [会话运行时](../narrator/runtime/index.md)
- [一次工具调用](tool-call.md)
- [一次上下文压缩](compaction.md)
- 「未核实」：步骤 8 中知识库被动注入之外，orchestrator 在每个 pass 里还有多少类 sys 行注入（工作区变更通知等）没有逐一列出。
