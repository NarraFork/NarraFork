---
id: files.write-queue
title: 文件写入与变更记录
summary: 单文件写队列、写入结果与历史可用性、变更运行时的单次尝试语义，以及本机/远程两条写入分支。
keywords:
  - withFileWrite
  - executeLocalFileChange
  - executeEditorFileChange
  - ensureFileSnapshot
  - file_busy
  - queue_full
  - historyStatus
  - diskOutcome
  - FILE_HISTORY_DISABLED
  - legacy_unverified
  - /api/fs/write
  - NEEDS_CONFIRMATION
  - narrator_file_snapshots
  - fileChangeEvidence
anchors:
  - server/lib/agent/disk-safety.ts
  - server/lib/disk-safety-config.ts
  - server/lib/disk-safety.ts
  - server/services/file-write-queue.ts
  - server/services/file-change-runtime.ts
  - server/services/file-change-apply-result.ts
  - server/services/file-history-policy.ts
  - shared/file-change-protocol.ts
  - server/lib/agent/tools/track-file-change.ts
  - server/lib/fs-write-boundary.ts
  - server/lib/validators/fs.ts
  - server/services/file-change-diagnostics.ts
  - server/services/file-change-execution-segments.ts
  - server/services/file-change-history-diagnostics.ts
  - server/services/file-change-identity.ts
  - server/services/file-change-local-io-evidence.ts
  - server/services/file-change-local-io.ts
  - server/services/file-change-merge.ts
  - server/services/file-change-platform-capability.ts
  - server/services/file-change-write-footprint.ts
  - server/services/struct-sed-remote-change.ts
  - server/routes/fs.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 文件写入与变更记录

Write/Edit/StructSed/GenUI 等改文件的工具、编辑器保存和回退都经过同一个进程内单文件队列 `withFileWrite`。队列之上，**本机后端与远程设备走两条不同的写入分支**，历史的来源也不同：本机由 `LocalFileChangeRuntime` 只记身份与真实 IO 元数据，远程由 `ensureFileSnapshot` 存写前快照。

## 队列
- 队列按 `(deviceId, pathFlavor, 路径身份键)` 做 FIFO；路径必须是绝对路径，含 \0 或缺设备即抛 TypeError（`file-write-queue.ts:fileKey`）。
- 限额：默认等待 30s，上限 60s，单文件最多 64 个等待者，全局 1024；超时报 `file_busy`，满了报 `queue_full`（`FILE_WRITE_QUEUE_LIMITS`、`FileWriteQueueError`）。`waitTimeoutMs: 0` 表示忙就立刻失败。
- 取消只影响排队；已获得槽位的写体必须自己结束才释放（`FileWriteQueue.run`）。队列状态用 `hotSafe` 跨热重载保留。

## 写入结果与历史状态
- 写入结果四种：`applied | not_applied | conflict | unknown`；历史状态三种：`complete | unavailable | disabled`（`shared/file-change-protocol.ts`）。`isFileHistoryEnabledForDevice`：deviceId 存在且不等于 `"local"` 才为真。
- 工具结果 metadata 里放 `diskOutcome`、`historyStatus`；远程分支另放 `fileChangeEvidence: { version: 1, grade: "legacy_unverified" }`，本机分支放运行时给的证据引用（`write.ts`、`edit.ts`、`file-change-runtime.ts:fileWriteOutcomeMetadata`）。

## 写入分支（每条一行）
- 工具写入，本机后端（`backend.kind === "local"`）：`executeLocalFileChange` → `LocalFileChangeRuntime.execute` → `executeBound`。`historyEnabled = false`，历史状态固定 `disabled`；不初始化 blob 命名空间，只取 `sourceInstanceId`，仍写 scope/operation/effect 元数据行（前后状态记为 `unknown/history_unavailable`），但**不发布任何 blob**（`file-change-runtime.ts:executeBound`；测试 `file-change-runtime.test.ts` “Write/Edit/StructSed bypass blob initialization and keep metadata, counts and replay fences”）。
- 工具写入，远程设备：`executeLocalFileChange` 对非本机后端直接返回 `undefined`，工具回到自己的路径：`withFileWrite` 排队 → 读旧内容 → `boundedFileHistory(ensureFileSnapshot(..., "best-effort"))` → `backend.mkdirp` 与 `writeFileBytes`（`write.ts`、`edit.ts`）。历史来自 `narrator_file_snapshots` 表的“首次写前原文”快照（`file-snapshot-service.ts:ensureFileSnapshot`，已有则 `existing`，设备为 `local` 返回 `disabled`），不经 `LocalFileChangeRuntime`，没有 blob、没有 effect。快照失败只让 `historyStatus` 变 `unavailable`，不挡写。
- StructSed：本机同样走 `executeLocalFileChange`；远程且非 dry-run 时在 `withFileWrite` 内用 `prepareRemoteStructSedChange` 先 `ensureFileSnapshot`，再把解析后的操作写进 tool-call 行的 `inputJson` 作为恢复线索，再派发 RPC（`struct-sed/tool.ts`、`struct-sed-remote-change.ts`）。
- GenUI 创建入口文件：`recorded` 为 `undefined`（远程）时在 `withFileWrite` 内先尽力 `ensureFileSnapshot` 再独占写；结果固定 `historyStatus: "unavailable"`、`fileChangeHistoryReason: "remote_journal_unsupported"`；本机却没有记录则报 409（`gen-ui/runtime.ts`）。
- 编辑器保存，本机：`/api/fs/write`（`routes/fs.ts`）与编辑器文档提交都调 `executeEditorFileChange`，后端为本机，行为同第一条（无 blob）。
- 编辑器保存，远程设备：只有这一条把证据送到远程——`request.remote` 存在时 `historyEnabled = true`，初始化 blob 命名空间，写前/预期写后内容发布成 blob，记 effect 并结算操作（`executeEditor` → `executeBound`；要求 `hashKind: "raw-sha256"` 与快照修订号，且 IO 提供者必须绑定同一设备）。
- 回退恢复文件：单文件在 `withFileWrite` 内执行，见 [回退与文件历史](revert.md)。
- 技能创建、设备传输也用 `withFileWrite` 串行（`skill-write-scope.ts`、`device-transfer-service.ts`）。

## 单次尝试与预算
- 同一请求只允许尝试一次：键为 `sourceKind:sourceId:attempt`，重复则抛错且不重试变更（`attempts` 缓存，上限 `MAX_ATTEMPTS=8192`）；远程工具的免派发路径有自己的 `remoteAttempts`。
- 历史准备有 1500ms 预算（`HISTORY_BUDGET_MS`、`boundedFileHistory`），超时只让历史变 `unavailable`，不影响磁盘写入结果。
- 本地 IO 的返回要带“执行证明”：被拒/异常的适配器不算“没有发生写入”，一律归为 `target_mutation_unknown`，回执为 `unknown`（`file-change-apply-result.ts:applyLocalFileChange`）。新建的父目录必须落在已声明的写入足迹内（`file-change-write-footprint.ts`）。
- 人工写边界：`/api/fs/write` 是允许名单，只允许叙述者 cwd 和 `settings.paths.extraWritableDirs` 内；根外路径返回 409 `NEEDS_CONFIRMATION` 并需 `confirmOutsideRoots`，密钥路径、git 内部和符号链接逃逸是硬拒绝；乐观锁靠 `baseHash`（不符 409 `STALE_WRITE`）（`fs-write-boundary.ts:checkWriteBoundary`、`validators/fs.ts:fsWriteSchema`）。
- 证据（范围/操作/结果与内容 blob）的存储、配额与审计见 [文件变更证据](change-evidence.md)。

## 从哪读起
- `server/services/file-write-queue.ts`：队列，`withFileWrite` 是入口。
- `server/services/file-change-runtime.ts`：`executeLocalFileChange`（本机分支入口）、`executeEditorFileChange`、`executeBound`。
- `server/lib/agent/tools/write.ts`：同一个工具里本机（`executeLocalFileChange`）与远程（`withFileWrite` + `ensureFileSnapshot`）两个分支并排。
- `server/services/file-snapshot-service.ts`：远程历史的来源。
- `server/lib/agent/tools/track-file-change.ts`：写后记归因；`evidenceRecorded` 为真时不重复记。

## 改它时
- 新增一个会写文件的工具：本机分支必须走 `executeLocalFileChange`，远程分支必须自己 `withFileWrite` + `ensureFileSnapshot`，两者都要返回 `diskOutcome`/`historyStatus` metadata；然后接 `trackFileChange`、`FileChangeToolName`、权限分类和前端卡片。不能直接 `fs` 写。
- 改历史状态或写入结果枚举：`shared/file-change-protocol.ts`、`file-change-apply-result.ts`、证据表、回退对 `unknown` 的处理一起改。
- 改队列限额：回退事务、编辑器保存、技能创建共用同一队列；`file-write-queue.test.ts` 覆盖 FIFO、取消、超时、热重载共享。
- `file-change-runtime.test.ts`、`file-change-runtime-default.test.ts` 守着“本机不发布 blob、不读内容、重放受阻”的约束；改 `historyEnabled` 判定前先读它们。
- 不变量：磁盘结果与历史状态互相独立；历史准备失败不能让写入失败；同一 attempt 不重试变更。

## 相关
- [文件变更证据](change-evidence.md)
- [回退与文件历史](revert.md)
- [编辑器文档](editor.md)
- [一次文件修改与回退](../flows/file-change.md)
