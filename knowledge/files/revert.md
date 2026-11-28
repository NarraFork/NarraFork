---
id: files.revert
title: 回退与文件历史
summary: 逐项恢复、部分成功保留、消息 COW、历史可用性策略，以及远程设备的首次写前快照与回放。
keywords:
  - revert-plans
  - revert-action-preview
  - REVERT_APPLY_NOT_COMMITTED
  - ACTION_MISMATCH
  - IO_PENDING
  - FILE_HISTORY_DISABLED
  - skipRevert
  - 回退文件
  - 撤销修改
  - rollback_to_block
  - edit_and_regenerate
  - narrator_file_snapshots
  - permission-file-preview
  - revert_operations
anchors:
  - server/services/file-read-snapshots.ts
  - server/services/revert-transaction-service.ts
  - server/services/revert-plan-service.ts
  - server/services/revert-selection-service.ts
  - server/services/revert-history-commit.ts
  - server/services/revert-mutation-journal.ts
  - server/services/revert-blockers.ts
  - server/services/narrator-scoped-revert.ts
  - server/services/file-history-policy.ts
  - frontend/lib/revert-result.ts
  - frontend/lib/revert-warnings.ts
  - server/services/file-change-local-restore.ts
  - server/services/file-change-reversal.ts
  - server/services/file-snapshot-service.ts
  - server/services/file-state-rebuild.ts
  - server/services/postgres-revert-journal-store.ts
  - server/services/postgres-revert-plan-store.ts
  - server/services/revert-planner-local-access.ts
  - server/services/revert-planner-service.ts
  - server/services/revert-transaction-manifest-worker.ts
  - server/services/revert-transaction-worker-protocol.ts
  - server/services/revert-transaction-worker.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 回退与文件历史

回退把会话选中范围内的文件恢复到变更前状态，并可同时改写消息历史。流程是“预览（plan）→ 用户确认 → 事务执行”，预览与执行都有持久化记录。

## 关键规则
- 动作四种：`revert_files | rollback_to_block | delete_tool_block | edit_and_regenerate`，必须与预览时落库的 operation 种类一致，否则 `ACTION_MISMATCH`（`revert-transaction-service.ts:verifyEntrypoint`）。
- 执行前校验计划未过期（`planLifetimeMs` 10 分钟）和选择仍然新鲜，再 `startExecution` 把状态从 `prepared` 推到 `applying`；非 `prepared` 的计划只回放已记录结果，不会再次写盘（`RevertTransactionService.run`）。
- 逐文件执行，每个文件在 `withFileWrite` 队列里完成：目标身份变了记 `conflict`，当前预期状态未知记 `conflict`，目标状态未知记 `failed`（`attempt`）。每个文件结果为 `applied | unchanged | conflict | failed | unknown | not_attempted`，部分成功保留，不整体回滚（`revert-mutation-journal.ts:RevertFileStatus`）。
- 整体状态 `committed | partial | failed | cancelled | executing`；全部文件校验通过后才提交历史（消息改写与 COW），否则 `historyCommitted` 为 false，已测得的文件结果保留（`run`、`commitHistory`）。
- 并发限制：同时执行数不得超过 `captureConcurrency`（2），超出 `BUSY`；默认总超时 60s，超时/取消后响应最多再等 30s 清理，真实 IO 未结束就返回 `IO_PENDING`（`execute`）。
- 阻塞条件：叙述者有 `initializing/pending/running` 的工具调用、叙述者忙或另一预览在跑（`revert-blockers.ts:collectRevertBlockers`）。
- 消息改写/COW 单行不得超过 4MiB（`historyCowBytes`），选择上限见 `REVERT_SELECTION_LIMITS`（子叙述者 1000、超时 30s）。
- 仅启用文件历史的设备才能恢复文件；否则带 `skipRevert` 的路径只改消息（`file-history-policy.ts:resolveNarratorMessageOnlyRevert`，未启用时显式要求恢复报 409 `FILE_HISTORY_DISABLED`）。
- Tree 快照（整树内容哈希、Bash 观测、编辑预览、写入认领）不在本节点，见 [Tree 快照](tree-snapshots.md)。

- 远程设备的历史是另一套：`narrator_file_snapshots` 存每个 (叙述者, 设备, 路径) 的“首次写前原文”（`file-snapshot-service.ts:ensureFileSnapshot`，已有则不覆盖），`file-state-rebuild.ts` 从快照出发回放成功的 Write/Edit 工具调用重建当前内容，回放与记录不一致抛 `ReplayDivergedError`；本机设备（`local`）不走它（`isFileHistoryEnabledForDevice`）。调用点之一是 `GET /api/narrators/:id/permission-file-preview`（`routes/narrators.ts`）：启用历史的设备用 `rebuildDeviceFileState` 算当前内容，其余设备另行安全读取。回退事务能否用这套快照恢复远程文件：未核实。
- 后端分工：预览编排与历史选择只有 SQLite 实现（`revert-planner-service.ts`、`revert-selection-service.ts`，后者含 `rowid` 键集扫描与 worker 侧收集器）；计划与日志存储另有 PG 对应实现（`postgres-revert-plan-store.ts`、`postgres-revert-journal-store.ts`），但上层编排仍为 SQLite。`file-change-reversal.ts` 把已落的 effect 转成反向操作输入（v3 用操作日志序号排序，旧记录保留记录顺序）。清单校验在 Worker 里（`revert-transaction-manifest-worker.ts`、`revert-transaction-worker-protocol.ts`、`revert-transaction-worker.ts`）。
- 前端：`frontend/lib/revert-result.ts` 把回退应用响应整理成文件级结果（最多展示 12 个文件细节），`revert-warnings.ts` 把服务端返回的结构化建议码与计数翻成本地化文案，供回退对话框、删除预览页和 toast 共用。

## 从哪读起
- `narrator-scoped-revert.ts`：叙述者回退的对外入口（预览、按块/按消息/按 seq 回退）。
- `revert-planner-local-access.ts`、`revert-plan-service.ts`：预览与计划持久化。
- `revert-transaction-service.ts`：事务执行；`revert-transaction-worker.ts` 在 Worker 里校验清单。
- `revert-history-commit.ts`：历史提交；`file-change-local-restore.ts`：单文件恢复。

## 改它时
- 加或改回退动作：`shared/file-change-protocol.ts` 的动作/选择器类型、`narrator-scoped-revert.ts`（选择）、`revert-plan-service.ts`（计划）、`revert-transaction-service.ts:verifyEntrypoint`（动作与落库 operation 必须一致，否则 `ACTION_MISMATCH`）、`revert-history-commit.ts` 与前端 `revert-result.ts` 一起改。
- 改文件结果状态枚举（`applied|unchanged|conflict|failed|unknown|not_attempted`）：`revert-mutation-journal.ts`、PG 日志存储、前端结果渲染一起；`revert-*.test.ts`（`revert-transaction-service`、`revert-mutation-journal`、`revert-planner-local-access` 等）会断言。
- 改选择上限（`REVERT_SELECTION_LIMITS`）或 4MiB 历史 COW 上限：`revert-selection-service.test.ts`、`revert-history-commit.test.ts`。
- 不变量：执行前计划必须仍是 `prepared` 且未过期；非 `prepared` 只回放记录结果；部分成功保留，历史只在文件全部校验后提交；回退写文件必须在 `withFileWrite` 队列里。
- `narrator-history-writers.guard.test.ts` 守着哪些文件可以直接写 `narrator_messages/refs/tool_calls` 三张表（`file-change-runtime.ts`、`file-change-evidence.ts` 的操作链接在名单里）：未登记的直接写会失败，登记了却不再写也会失败；新增写这三张表的代码要对照它。

## 相关
- [文件写入与变更记录](write-queue.md)
- [文件变更证据](change-evidence.md)
- [Tree 快照](tree-snapshots.md)
