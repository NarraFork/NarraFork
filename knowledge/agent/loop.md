---
id: agent.loop
title: Agent Loop
summary: 一轮请求如何构造历史、流式处理、工具调用与重试。
anchors:
  - server/lib/agent/loop.ts
  - server/lib/agent/pending-plan-reflection.ts
  - server/lib/agent/history-build.ts
  - server/lib/agent/pipeline-rules.ts
  - server/lib/agent/pipeline-state.ts
  - server/lib/agent/loop-transcript.ts
  - server/lib/agent/tool-executor.ts
  - server/lib/agent/tool-execution-groups.ts
  - server/lib/agent/error-handling.ts
  - frontend/components/settings/AgentSection.tsx
  - server/lib/agent/abortable-sleep.ts
  - server/lib/agent/citation-stream.ts
  - server/lib/agent/diagnostic-fetch.ts
  - server/lib/agent/error-diagnostics.ts
  - server/lib/agent/execution-timeout.ts
  - server/lib/agent/generate-first-token-timeout.ts
  - server/lib/agent/malformed-request.ts
  - server/lib/agent/output-content.ts
  - server/lib/agent/retry-after.ts
  - server/lib/agent/stream-progress.ts
  - server/lib/agent/stream-wakeups.ts
  - server/lib/agent/strip-citation-markers.ts
  - server/lib/agent/tool-input-stream.ts
  - server/lib/agent/tool-use-id-dedup.ts
  - server/lib/agent/truncate.ts
  - server/lib/agent/types.ts
  - server/lib/stream-timeout.ts
  - server/services/reasoning-translation-activity.ts
  - server/services/reasoning-translation-runtime.ts
  - server/services/reasoning-translation-scheduler.ts
  - shared/stream-timeout.ts
  - shared/citations.ts
keywords:
  - agentLoop
  - AgentEvent
  - 最大轮数
  - maxTurns
  - 重试
  - chatRetryCount
  - isRetryableError
  - 空响应
  - MAX_MALFORMED_REPLAYS
  - 反思循环
  - runReflectionLoop
  - 历史构造
  - buildAdapterHistory
  - LoopTranscript
  - 流水线
  - Pipeline
  - StreamStallPhase
  - tool_use id 去重
  - retry-after
  - 首 token 超时
  - tool-output 截断
status: draft
verified_at: 878917e97
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
- 按需计划反思：`executeToolAfterReflections` 在 ExitPlanMode 走「本次不反思」分支（且非反思循环内）时，把 `createPendingPlanReflectionRunner` 生成的运行器按 narrator + tool_use 注册到 `pending-plan-reflection.ts`，审批等待结束即注销（闭包持有本轮 `config`/`rows`）。
- 运行器 `runPendingExitPlanReflection`：只用审批卡已解析的输入；无法形成决策时交回人工（`handOverExitPlanReflection`），不 fail-closed 驳回；等待先被人工决定或本轮中止时，`discardExitPlanReflection` 丢弃合成 gate、不落库覆盖真实记录；登记的 gate 带 `onDemand: true`，审查过程不写 `narrator_tool_calls` 行（那一行仍是人的待批审批），结论只经 `resolvePermission` 落到该行，详见[反思门](../security/tool-permissions/reflection.md)。
- 辅助 AI 调用（摘要、标题、反思等）的重试次数被硬限在 10（`error-handling.ts:getAuxiliaryMaxRetries`）。
- 流水线（Pipeline）：`pipeline-rules.ts` 校验并执行对工具输出的类 shell 管道规则，规则 4096 字符、最多 16 条命令、执行预算 250ms、输出 50000 字符；`pipeline-state.ts` 保存每个叙述者的捕获（最多 64 条），有控制工具集合 `isPipelineControlTool`。

## 从哪读起
- `server/lib/agent/loop.ts:agentLoop`：入口；`turnLoop` 在 `agentLoopInMetadataSnapshot` 内。
- `server/lib/agent/tool-executor.ts:executeTool`：单个工具调用的准入、权限、执行目标冻结（`freezeToolExecutionTarget`）与结果截断。
- `server/lib/agent/history-build.ts`、`loop-transcript.ts`：历史构造。
- `server/lib/agent/__tests__/loop-*.test.ts`：按行为拆分的循环测试（重试、空响应、反思、并行预检、工具结算等）。
- 流式与超时：`stream-progress.ts` 记录一次流式尝试的传输层进度，只用于说明卡在哪个阶段（`no_response_headers` / `headers_only` / `heartbeat_only` / `unparsed_data`），心跳不会延长任何计时器；`stream-timeout.ts`（实现在 `shared/stream-timeout.ts`）给读取加空闲超时与字节预算；`generate-first-token-timeout.ts` 只限制等首个输出的时间，不限整个生成；`stream-wakeups.ts:interleaveWakeups` 让循环在提供商事件之间也能处理中途启动的工具的结算。
- 流内容整理：`output-content.ts` 按车道累积输出（原生标识只在请求内有效，`outputIndex` 只是顺序）；`tool-input-stream.ts` 按 UTF-16 偏移增量解码工具入参字段；`citation-stream.ts` / `strip-citation-markers.ts` 与 `shared/citations.ts` 处理助手文本的来源引用（结构化注释与旧的文本标记两种来源，送模型前剥离旧标记）；`tool-use-id-dedup.ts` 保证历史里 tool_use id 唯一且字符集合法（`^[a-zA-Z0-9_-]+$`，跨提供商重放不被拒）。
- 重试相关：`retry-after.ts` 解析 `retry-after-ms`、`retry-after`、`ratelimit-reset`、`x-ratelimit-reset*` 等时间提示，只回答「何时可重试」，不判断是否瞬时；`abortable-sleep.ts` 是所有退避共用的可中断睡眠；`malformed-request.ts` 识别上游不透明的「请求畸形」并生成结构摘要；`error-diagnostics.ts` 与 `diagnostic-fetch.ts` 提供有界的错误诊断与连接密钥脱敏；`execution-timeout.ts` 里 0/缺省表示无墙钟期限，显式期限分块调度（单个 setTimeout 有 32 位上限）。
- 工具输出截断：`truncate.ts` 默认最多 2000 行 / 50KB，超出的完整输出落到临时目录 `narrafork-tool-output`，并有启动清理。
- 类型：`types.ts` 是 `AgentEvent`、`ApiError`、`ToolContext` 等宿主侧类型的汇集（协议部分的定义在 `shared/agent-protocol/types.ts`）。设置页 `frontend/components/settings/AgentSection.tsx` 编辑 `settings.agent` 的最大轮数等项。
- `server/services/reasoning-translation-*.ts`：按「可见性目标」调度的推理翻译（`translateDemand` 调用 `summaryGenerate`，经 publish 回调推补丁，由 `narrator-ws.ts` 与 `narrator-event-handler.ts` 使用）；不属于循环本身，归属未核实。

## 改它时
- 加一种 `AgentEvent`：改 `types.ts` 的联合类型，再在宿主的 `narrator-event-handler.ts:processEvent` 与 WebSocket/前端消费处处理；循环不负责持久化，只产出事件。
- 改重试规则：判定在 `error-handling.ts:isRetryableError`，策略违规与 TokenDance 恢复动作必须排在自定义重试规则之前；退避走 `abortable-sleep.ts`；畸形请求重放里宣告的 `delayMs` 与实际睡眠只算一次、共用同一个值。
- 改历史投影要同时看 `history-build.ts` 与各适配器的 `buildHistory`；`loop-transcript.ts` 的内存行必须与数据库行同形，不要另造一套历史构造。
- 工具并行规则的单一来源是 `shared/tool-parallel-groups.ts`，改它要跑 `tool-execution-groups.test.ts` 与 `loop-*` 并行预检测试。
- 任何新增的主线程长耗时（压缩、哈希、大 JSON 序列化）按仓库规则放工作线程，且工作线程失败不得回退主线程（`tests/worker-main-thread-fallback.guard.test.ts` 扫描遗留的回退标识）。
- 测试：`agent/__tests__/loop-*.test.ts`、`tool-execution-groups.test.ts`、`tool-use-id-dedup.test.ts`、`error-handling.test.ts`、`retry-after.test.ts`。

## 相关
- [模型提供商](providers/index.md)
- [工具体系](tools/index.md)
- [执行后端](execution.md)
- [会话运行时](../narrator/runtime/index.md)：循环之外的运行调度、收件箱、发布与模型历史
