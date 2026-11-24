---
id: agent.modeltrace
title: 模型鉴别（ModelTrace）
summary: 向上游发数数挑战、用本地检测器给候选模型打分，判断模型是否货真价实（/modeltrace）。
anchors:
  - server/lib/agent/modeltrace-request.ts
  - server/lib/modeltrace/
  - server/services/modeltrace-compat.ts
  - server/services/modeltrace-service.ts
  - server/services/modeltrace-store.ts
  - shared/modeltrace-result.ts
  - frontend/components/narrator/vlist/render/RenderModelTraceResult.tsx
  - frontend/components/narrator/vlist/measure/measure-modeltrace-result.ts
keywords:
  - /modeltrace
  - --fork
  - --calibrate
  - modeltrace_result
  - lmfpd-sdk
  - 模型指纹
  - 模型真伪
  - modeltraceKey
  - unscorable
  - not_model
  - calibrationRequested
  - cacheReadTokens
  - NARRAFORK_DISABLE_MODELTRACE_WORKER
  - /api/narrators/:id/modeltrace
  - adoptLegacyModelTraceNarrators
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---

# 模型鉴别（ModelTrace）

用来检查「这个提供商后面的模型是不是它声称的那个」：向上游发数数挑战，让本地检测器按输出的数字模式给候选模型打分。命令 `/modeltrace`（可带 `--fork`、`--calibrate`）触发，结果是一条仅供界面显示的 `modeltrace_result` 块，不进模型对话历史。

## 关键规则
- 入口：`POST /api/narrators/:id/modeltrace`（body 严格对象 `{ fork?, calibrate? }`，无 body 视为旧的单样本请求，返回 201 与诊断叙述者 id）；`POST /api/narrators/:id/modeltrace/retry` 在同一诊断会话里重跑一轮；`GET /api/narrators/modeltrace/lookup?model=` 查当前用户该模型已有的诊断叙述者（`routes/narrators.ts`，校验在 `validators/narrators.ts:modelTraceOptionsSchema`）。
- 三种取样方式，每个分支一行：
  - 默认：向由来源叙述者解析出的提供商/模型发 1 个挑战；历史、工具为空，每个样本用全新的传输会话键，不复用来源会话的缓存与亲和键。
  - `--calibrate`：连续发 3 个挑战，结果带 `calibrationRequested`；挑战提示依次作为用户消息发布到诊断会话里。
  - `--fork`：重放来源会话最近一次上游请求的冻结前缀（`modeltrace-request.ts` 在每次请求开始时按叙述者记住，最多 64 条、不含反思循环），并追加挑战；要求适配器支持诊断分叉、连接与凭证仍是原来的，否则报错让用户先发一条消息再试；分叉要求对来源叙述者同时有写和读权限；每个分叉新建独立的私有诊断叙述者，结果带每次请求的缓存读 token（`cacheReadTokens`，未报告为 null）。
- 挑战与采样：`lmfpd-sdk` 的 `generateChallenges` 出题，提示要求不用工具、直接生成数字；回答最长 10,000 字符、期望个数在 292–332；样本发出期间任何工具调用、`invalidState`、静默断开、输出被截断或停止原因不是正常结束，都按失败处理，每个样本（成功或失败，失败的可能带可计费用量）都经 `finishApiRequest` 记一条 `api_requests`（`kind: "modeltrace"`），记账失败只告警；整轮 180 秒超时（`modeltrace-service.ts`）。
- 评分在本地：`lib/modeltrace/` 的检测器和词库（`shared_detector.bin`、`unified_bank.json`）随构建内嵌，不联网、无缓存；每次分析起一个一次性工作线程、不排队（`maxQueued: 0`）、超时 5 秒；工作线程被禁用（`NARRAFORK_DISABLE_MODELTRACE_WORKER=1`）、起不来或失败时结果为 `unscorable`（「本地检测暂不可用」），不在主线程重算。取消返回「检测已取消」。结果块 `decision` 取值：`scored`（概率为 null）、`partial`（单样本，概率是未校准的相对权重，温度 1 的 softmax）、`unscorable`、`not_model`；最多 5 行，每行 model/displayName ≤256 字符。
- 诊断叙述者：默认模式按（用户、提供商、模型）复用一个私有、不进列表、trait 为 `modeltrace` 的叙述者（`modeltraceKey` 唯一，`modeltrace-store.ts:ensureTraceNarrator`），启动时先抢占执行锁再清空历史（只去掉本舱的消息引用，独占消息连同工具调用一并删除）；fork 模式每次新建一个 `fork/<id>` 键的一次性诊断叙述者。
- 取消与互斥：同一诊断叙述者同时只能有一个执行（`tryClaimExecution`）；会话中断时 `cancelModelTrace` 只取消诊断子会话，不碰来源会话的运行（`narrator-session.ts`）。
- 旧数据兼容：改造前每次 `/modeltrace` 都 fork 一个主叙述者；启动时（`main.ts`，仅 SQLite）`adoptLegacyModelTraceNarrators` 把每个用户每个可解析模型最近的一条收编为「舱」，其余只隐藏，解析不了或无所有者的写成 `legacy/<id>`，并清掉相关最近标签页（`modeltrace-compat.ts`）。

## 从哪读起
- `server/services/modeltrace-service.ts:startModelTrace`、`retryModelTrace`：整条流程（`runRound` → `runSample` → `analyzeModelTrace`）。
- `server/lib/modeltrace/index.ts`、`worker-client.ts`、`worker.ts`、`protocol.ts`：本地检测与工作线程。
- `server/lib/agent/modeltrace-request.ts`：fork 用的冻结请求与凭证校验；`loop.ts` 在 `onRequestStart` 里记录。
- 前端：`/modeltrace` 命令在 `hooks/useCommands.ts` 与 `components/narrator/interaction/use-narrator-send.ts` 处理（远程构建下被拦），渲染在 `vlist/render/RenderModelTraceResult.tsx` 与 `measure/measure-modeltrace-result.ts`，API 在 `lib/api/narrators.ts`，类型 `shared/modeltrace-result.ts`。
- 测试：`server/services/modeltrace-service.test.ts`、`modeltrace-store.test.ts`、`modeltrace-stream.integration.test.ts`，`server/lib/modeltrace/modeltrace.test.ts`、`compiled.test.ts`（编译产物里从干净目录运行、无网络请求）。

## 改它时
- 改结果块形状（`ModelTraceResultBlock`）：同步 `lib/modeltrace/protocol.ts:isRanking` 的校验、`RenderModelTraceResult.tsx` 与它的行高测量 `measure-modeltrace-result.ts`，以及存量块的兼容（`decision` 缺省表示旧结果）。
- 改挑战参数（个数、期望范围、最长文本）要同时改 `validOutputs`、`MODELTRACE_MAX_TEXT_LENGTH` 与工作线程里的重复校验，否则样本会被判为超限。
- 检测器必须保持工作线程隔离：失败只能返回 `unscorable`，不得在主线程回退；新增或修改工作线程客户端要按仓库规则做故障注入（禁用、启动失败、运行失败、超时），并断言没有在主线程执行（参照 `modeltrace.test.ts`；全仓扫描见 `tests/worker-main-thread-fallback.guard.test.ts`）。
- 改 fork 模式要保证不继承来源会话的设置、消息、工具与回调、不共用 abort 信号，且每个样本使用独立传输会话键；改后跑 `modeltrace-service.test.ts`。
- 诊断叙述者与会话列表、ACL 的关系（私有、`hiddenFromLists`、不进最近标签页）不能放宽。

## 相关
- [模型提供商](providers/index.md)
- [Agent Loop](loop.md)
- [用量与费用](usage.md)
