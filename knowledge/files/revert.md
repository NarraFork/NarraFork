---
id: files.revert
title: 回退与文件历史
summary: 逐项恢复、部分成功保留、消息 COW、历史可用性策略。
anchors:
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

## 从哪读起
- `narrator-scoped-revert.ts`：叙述者回退的对外入口（预览、按块/按消息/按 seq 回退）。
- `revert-planner-local-access.ts`、`revert-plan-service.ts`：预览与计划持久化。
- `revert-transaction-service.ts`：事务执行；`revert-transaction-worker.ts` 在 Worker 里校验清单。
- `revert-history-commit.ts`：历史提交；`file-change-local-restore.ts`：单文件恢复。

## 相关
- [文件写入与变更记录](write-queue.md)
- [文件变更证据](change-evidence.md)
- [Tree 快照](tree-snapshots.md)
