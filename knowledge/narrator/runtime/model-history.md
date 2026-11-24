---
id: narrator.runtime.model-history
title: 模型历史
summary: model-history-*：发给模型的历史怎么查询、增量与修订。
anchors:
  - server/services/agent-runtime/model-history-source.ts
  - server/services/agent-runtime/model-history-query.ts
  - server/services/agent-runtime/model-history-delta.ts
  - server/services/agent-runtime/model-history-revision.ts
  - server/services/agent-runtime/model-history-revision-sql.ts
  - server/services/agent-runtime/model-history-worker.ts
  - server/services/agent-runtime/model-history-json.ts
  - server/services/agent-runtime/model-history-fixture.ts
  - server/services/agent-runtime/history.ts
  - server/lib/model-history-preparation.ts
  - server/services/narrator-epochs.ts
keywords:
  - model_history_revision
  - model_history_revision_contracts
  - loadModelHistorySource
  - buildRuntimeHistory
  - MODEL_HISTORY_WORKER_DISABLED
  - MODEL_HISTORY_WORKER_PAUSED
  - MODEL_HISTORY_WORKER_CLOSED
  - 历史准备
  - 只读 worker
  - 增量历史
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 模型历史

发给模型的历史是"最近一次 compact 之后"的消息加工具调用。读取在独立的只读 worker 里做，主线程只拿结果；`history.ts:buildRuntimeHistory` 再把读出的行投影成提供方输入。`history.ts` 与测试夹具 `model-history-fixture.ts` 锚在这里。

## 关键规则
- 范围：取最近 `is_compact = 1` 的 ref 的 seq 作边界，其后 `segment_compact_id IS NULL` 且角色不是 `disp` 的 ref，按 seq 分批（每批 200 个 ref）读正文与工具行（`model-history-query.ts`）。
- 预算：整次预准备估算上限 128MB，每批 4MB；每个 JSON 值解析前先按容器与槽位预占，超出抛 `ModelJsonBudgetError`；大 JSON 需要 worker，生产路径不在主线程内联解析（`model-history-json.ts`）。
- 缓存键为"数据库标识 + 叙述者"；命中必须同时满足 `narrators.model_history_revision` 与触发器目录标识一致，且合同可信。以下情况不缓存：合同不可信、内存数据库、带 `limit` 的读取；全局缓存 64MB，超出按最旧淘汰（`model-history-source.ts:ModelHistorySourceCache`）。
- 可信合同（`model-history-v3`）：SQLite 需合同表版本匹配且触发器数量齐全，PG 还要触发器处于启用状态；旧库缺列则返回 `unversioned`，永不缓存（`model-history-revision.ts`）。
- 增量：有旧缓存且目录标识相同时只传变化的正文与工具行，其余复用；ref 被删、重排、compact 或段变化抛 `Model history delta structure changed`，由调用方整体重读一次，不做部分增量（`model-history-delta.ts`、`loadModelHistorySource`）。
- worker 失败路径，均不回退主线程：
  - `NARRAFORK_DB_WORKER=off` 或并发配置为 0 → `MODEL_HISTORY_WORKER_DISABLED`（503）。
  - 数据库维护暂停 → `MODEL_HISTORY_WORKER_PAUSED`；进程关闭 → `MODEL_HISTORY_WORKER_CLOSED`。
  - 队列满（上限 32）→ 503；排队超时 → `ModelHistoryTimeoutError`；取消 → 抛取消错误。
  - 旧版热重载遗留 worker 所有权无法证实 → `MODEL_HISTORY_WORKER_RESTART_REQUIRED`。
  - worker 报错只转发固定预算错误文案与标量诊断，PG 驱动错误不带连接信息。
- 池：并发 2、不复用 worker；SQLite 整读最多重试 3 次，PG 不重试（`loadModelHistorySource`）。
- 一致性：worker 在事务快照内先读签名，再读行；读前读后合同可信性不一致则抛错、不发请求。
- 修订触发器：由 `model-history-revision-sql.ts` 渲染，改消息、工具调用、ref、块或作者名都会递增 `narrators.model_history_revision`；仅 `state_revision` 变化的写入不递增（v3）。v1、v2 文本已冻结，不可改。

## 从哪读起
- `model-history-source.ts:loadModelHistorySource`；`model-history-worker.ts`（worker 侧）；`history.ts:buildRuntimeHistory`。
- 调用入口：`narratorService.getModelHistorySinceLastCompact` 与 `prepare-prefix-request.ts`（见[调度与执行](orchestrator.md)）。
- 测试：`model-history-lifecycle.test.ts`、`model-history-v2-triggers.test.ts`、`model-history-source.test.ts`、`model-history-shipped.test.ts`。

## 改它时
- 改触发器：v1/v2 渲染文本在源码注释里标为已冻结（迁移侧守卫未核实），应新增合同版本而非改旧文本；同时更新 `MODEL_HISTORY_REVISION_CONTRACT`、触发器名单与 `model-history-v2-triggers.test.ts`、`model-history-shipped.test.ts`（后者校验已迁移库的合同）。
- 给消息、工具行加会影响模型输入的列：要把它放进触发器的"变更列"，否则缓存不会失效。
- worker 文件不得导入 `db/index`；这几个文件登记在 `server/db/sqlite-dialect-inventory.guard.test.ts`。

## 相关
- [调度与执行](orchestrator.md)
- [消息存储](../messages/index.md)
- [Agent 循环](../../agent/loop.md)
