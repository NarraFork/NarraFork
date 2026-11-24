---
id: agent.loop
title: Agent Loop
summary: 一轮请求如何构造历史、流式处理、工具调用与重试。
anchors:
  - server/lib/agent/loop.ts
  - server/lib/agent/history-build.ts
  - server/lib/agent/pipeline-rules.ts
  - server/lib/agent/pipeline-state.ts
  - server/lib/agent/loop-transcript.ts
  - server/lib/agent/tool-executor.ts
  - server/lib/agent/tool-execution-groups.ts
  - server/lib/agent/error-handling.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# Agent Loop

叙述者的一次响应由 `agentLoop`（异步生成器，产出 `AgentEvent`）驱动：按轮（turn）向模型发请求、流式解析、执行工具，直到模型不再调用工具或达到上限。它不负责持久化，持久化由宿主根据产出的事件完成。

## 关键规则
- 轮数上限取 `min(config.maxTurns ?? settings.agent.maxTurns, 搜索执行域剩余轮数)`，默认设置为 1000（`loop.ts:agentLoopInMetadataSnapshot`、`settings/defaults.ts`）。外层 `turnLoop` 每轮先检查 abort 和 guidance 信号。
- 每个请求的历史都由 `history-build.ts:buildAdapterHistory` 构造：先对行做仅供模型的投影（AskUserQuestion、计划正文替换为路径引用、剥离引用标记、文件引用展开、原生媒体投影、发送者标注、tool_use id 去重、工具加载投影），都在内存副本上，数据库行不变；再交给适配器的 `buildHistory`。投影之间会按约 8ms 让出事件循环。
- 没有宿主的循环（反思、搜索探测）用 `loop-transcript.ts:LoopTranscript` 在内存里维护同样形状的行，请求同样走 `buildAdapterHistory`，没有第二套构造方式。
- 工具调用分组：同一轮内的 tool_use 按提供商顺序分组，连续的并行安全工具并发，其余各自成组形成串行屏障（`shared/tool-parallel-groups.ts:groupToolExecutions`）。Bash 默认串行，仅 `parallel: true` 且无 `strict_serial` 才可并行；Agent 之后的 Watch/Send、Send 之后的 Watch 开新组。流式过程中可以提前启动已成形的调用（`tool-execution-groups.ts:selectStreamingToolExecutions`），参数流没有形成合法输入的调用不会被执行（`loop.ts:shouldEagerExecuteTool`）。
- 权限请求在循环内串行化（`permissionTail`），避免并发的权限弹窗和危险反思互相竞争；返回 `dangerReflection` 的结果会进入 `resolveDangerReflectionDecision`。
- 反思循环（危险操作、ExitPlanMode、任务状态变更）由 `runReflectionLoop` 以嵌套的 `agentLoop` 运行，`maxTurns` 被钳在 1–2，复用父请求的行以保持缓存前缀。
- 重试（`loop.ts` 的 `chatRetryCount` 循环）：仅无状态提供商在循环内重试同一次 `provider.chat()`；有状态模型（`usesStatefulModel`）或本轮已有图片生成时 `getMaxChatRetries()` 为 0，由外层运行时重放。重试次数来自 `config.maxTransientRetries`（-1 表示无限），退避上限默认 20s。是否可重试由 `error-handling.ts:isRetryableError` 判定：策略违规（policy violation）与 TokenDance 恢复动作一律不重试，排在自定义重试规则之前。
- 空响应：默认最多重放 3 次；上游已确认服务过的 `usage_only` / `stop_without_content` 只重放 1 次（`loop.ts:maxEmptyResponseRetriesFor`）。畸形请求重放上限 2 次（`MAX_MALFORMED_REPLAYS`）。
- 辅助 AI 调用（摘要、标题、反思等）的重试次数被硬限在 10（`error-handling.ts:getAuxiliaryMaxRetries`）。
- 流水线（Pipeline）：`pipeline-rules.ts` 校验并执行对工具输出的类 shell 管道规则，规则 4096 字符、最多 16 条命令、执行预算 250ms、输出 50000 字符；`pipeline-state.ts` 保存每个叙述者的捕获（最多 64 条），有控制工具集合 `isPipelineControlTool`。

## 从哪读起
- `server/lib/agent/loop.ts:agentLoop`：入口；`turnLoop` 在 `agentLoopInMetadataSnapshot` 内。
- `server/lib/agent/tool-executor.ts:executeTool`：单个工具调用的准入、权限、执行目标冻结（`freezeToolExecutionTarget`）与结果截断。
- `server/lib/agent/history-build.ts`、`loop-transcript.ts`：历史构造。
- `server/lib/agent/__tests__/loop-*.test.ts`：按行为拆分的循环测试（重试、空响应、反思、并行预检、工具结算等）。

## 相关
- [模型提供商](providers.md)
- [工具体系](tools/index.md)
- [执行后端](execution.md)
