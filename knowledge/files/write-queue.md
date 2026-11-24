---
id: files.write-queue
title: 文件写入与变更记录
summary: 单文件写队列、写入结果与历史可用性、变更运行时的单次尝试语义。
anchors:
  - server/services/file-write-queue.ts
  - server/services/file-change-runtime.ts
  - server/services/file-change-apply-result.ts
  - server/services/file-history-policy.ts
  - shared/file-change-protocol.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 文件写入与变更记录

Write/Edit/StructSed/GenUI 等改文件的工具、编辑器保存和回退都经过同一个进程内单文件队列；写入时再由 `LocalFileChangeRuntime` 记录“实际发生了什么”，与工具成功与否分开。

## 关键规则
- 队列按 `(deviceId, pathFlavor, 路径身份键)` 做 FIFO；路径必须是绝对路径，含 \0 或缺设备即抛 TypeError（`file-write-queue.ts:fileKey`）。
- 限额：默认等待 30s，上限 60s，单文件最多 64 个等待者，全局 1024；超时报 `file_busy`，满了报 `queue_full`（`FILE_WRITE_QUEUE_LIMITS`、`FileWriteQueueError`）。`waitTimeoutMs: 0` 表示忙就立刻失败。
- 取消只影响排队；已获得槽位的写体必须自己结束才释放（`FileWriteQueue.run`）。队列状态用 `hotSafe` 跨热重载保留。
- 写入结果分四种：`applied | not_applied | conflict | unknown`；历史状态三种：`complete | unavailable | disabled`（`shared/file-change-protocol.ts`）。
- 本地后端（`backend.kind === "local"`）不保留文件历史：只留身份、重放保护和真实 IO 元数据，历史状态为 `disabled`；仅显式远程设备才有历史（`file-change-runtime.ts:executeLocalFileChange` 内的 `historyEnabled`、`isFileHistoryEnabledForDevice`：deviceId 存在且不等于 `"local"`）。
- 同一请求只允许尝试一次：键为 `sourceKind:sourceId:attempt`，重复则抛错且不重试变更（`attempts` 缓存，上限 `MAX_ATTEMPTS=8192`）。
- 历史准备有 1500ms 预算（`HISTORY_BUDGET_MS`、`boundedFileHistory`），超时只让历史变 `unavailable`，不影响磁盘写入结果。
- 本地 IO 的返回要带“执行证明”：被拒/异常的适配器不算“没有发生写入”，一律归为 `target_mutation_unknown`，回执为 `unknown`（`file-change-apply-result.ts:applyLocalFileChange`）。新建的父目录必须落在已声明的写入足迹内（`file-change-write-footprint.ts`）。
- 证据（范围/操作/结果与内容 blob）的存储、配额与审计见 [文件变更证据](change-evidence.md)。

## 从哪读起
- `server/services/file-write-queue.ts`：队列，`withFileWrite` 是入口。
- `server/services/file-change-runtime.ts`：`LocalFileChangeRuntime`，一次写入的完整流程（命名空间初始化、前后状态、证据）。
- `server/lib/agent/tools/write.ts`：工具如何接入 `executeLocalFileChange` 与 `withFileWrite`。

## 相关
- [文件变更证据](change-evidence.md)
- [回退与文件历史](revert.md)
- [编辑器文档](editor.md)
