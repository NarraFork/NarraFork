---
id: files.change-evidence
title: 文件变更证据
summary: 写入证据的存储：blob 存储与目录、物理审计、保留清单、改动归属视图。证据只在编辑器保存到远程设备时才带 blob。
keywords:
  - fileChangeScopes
  - fileChangeOperations
  - fileChangeEffects
  - fileChangeBlobs
  - file-change-blobs
  - file_attributions
  - 改动归属
  - /modifications
  - BLOB_NOT_READY
  - REQUEST_CONFLICT
  - quota_exceeded
  - --file-change-physical-audit-worker
  - 物理审计
  - 保留清单
anchors:
  - server/services/file-change-blob-store.ts
  - server/services/file-change-blob-catalog.ts
  - server/services/file-change-physical-audit.ts
  - server/services/file-change-retention-inventory.ts
  - server/services/file-change-evidence.ts
  - server/services/workspace-modification-view.ts
  - shared/file-change-protocol.ts
  - server/routes/git.ts
  - frontend/components/git/attribution-label.ts
  - server/services/attribution-actors.ts
  - server/services/file-attribution-service.ts
  - server/services/file-change-physical-audit-worker.ts
  - server/services/postgres-file-change-blob-catalog.ts
  - server/services/postgres-file-change-evidence-store.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 文件变更证据

一次写入留下的“事实”分两层存：元数据（范围、操作、结果）在 SQLite，文件内容（前后状态）在按哈希寻址的 blob 目录。上层有两个只读视图：维护用的物理审计 / 保留清单，和面向 Git 面板的改动归属视图。写入本身怎么发生见 [文件写入与变更记录](write-queue.md)。

## 关键规则
- 元数据服务 `FileChangeEvidenceService`：`prepareScope` → `beginOperation` → `recordEffect` → `finishOperation`，表为 `fileChangeScopes/Operations/Effects`（`server/db/schema.ts`）。同一 `(sourceInstanceId, sourceKind, sourceId, attempt)` 重放只返回已有行（`replayed: true`），内容不一致则 `REQUEST_CONFLICT`；终态结果不可改；单个操作的证据字节累计不得超过 256MiB（`file-change-evidence.ts:recordedCounts`）。
- 引用的 blob 必须在目录里是 `ready` 且大小一致，才允许落 effect（`recordEffect` 的 `assertBlobMetadata`，否则 `BLOB_NOT_READY`）。
- blob 存储（`FileChangeBlobStore`）只管原始不可变字节：目录 `<privateRoot>/file-change-blobs/sha256/<前2位>/<digest>`（`file-change-runtime.ts` 的命名空间初始化；`privateRoot` 的具体位置未核实）；先写 `.tmp` 私有临时文件（0600、O_EXCL、O_NOFOLLOW），边写边算 sha256，校验大小/哈希后用硬链接发布（不覆盖已有对象，已存在则复核后复用）；单块 32MiB、单个输入分块 1MiB、可用空间需留出 1GiB（`FILE_CHANGE_LIMITS`）。读取同样先校验再流式输出。
- blob 目录（`FileChangeBlobCatalog`）管配额：预留额度在进程内计数，发布成功才把 `usedBytes` 记进预算行并写 `fileChangeBlobs`；预算行默认配额 5GiB，超出 `quota_exceeded`。目录要求 SQLite `busy_timeout` ≤250ms 且开启外键。旧的预留行只作存档，不重放。
- 物理审计（`auditFileChangePhysical`）是显式触发的只读维护，在独立子进程里跑（入口标志 `--file-change-physical-audit-worker`，`index.ts` 在加载应用前分派），默认 30s、最长 120s；仓库内除测试外没有调用方，只有关闭钩子 `closeFileChangePhysicalAudits`（`main.ts` 关停流程）。它不结算预留、不过期证据、不授予 GC 权限。
- 保留清单（`FileChangeRetentionInventory.listPage`）按 digest 游标分页，只给出“被哪些外键根引用”，故意不产出任何删除候选；无引用宽限 7 天（`unreferencedGraceMs`）。同样没有非测试调用方。整库审计、物理枚举与 GC 必须放进 worker，这里不做。
- 谁真正写 blob（与旧说法相反）：工具写入的远程设备分支不经过这里，它只用 `file-snapshot-service.ts:ensureFileSnapshot` 存写前原文，结果带 `fileChangeEvidence.grade: "legacy_unverified"`；`executeLocalFileChange` 对非本机后端返回 `undefined`。本机后端进入运行时，但 `historyEnabled=false`：不初始化 blob 命名空间，只写 scope/operation/effect 元数据行，前后状态记为 `unknown/history_unavailable`，历史状态 `disabled`。blob 只在 `executeEditorFileChange` 的远程分支（`request.remote`）发布。分支逐条见 [文件写入与变更记录](write-queue.md)（`file-change-runtime.ts:executeBound`、`publish`）。
- 证据的读取方：编辑预览（`tool-edit-preview.ts`）对带 `fileChangeOperationId` 的非本机工具调用读 effect 的写前/实测写后 blob（`FileChangeBlobStore.readBytes`，单侧上限 `FILE_CHANGE_LIMITS.previewFileBytes`）；回退计划读 effect 与 blob 重建恢复内容（见 [回退与文件历史](revert.md)）。
- 归属时间线（`FileAttributionService.recordAttribution`，表 `file_attributions`）与证据是两套记录：工具写完后 `trackFileChange` 若发现证据已记（`evidenceRecorded`）就不重复记；写入 fire-and-forget、失败不挡工具；AI 归属会在 15s 内“遮住”同一路径，避免被监视器归为外部改动（`RECENT_ATTRIBUTION_TTL_MS`）。操作者身份统一由 `attribution-actors.ts` 解析（含 `narrator_unknown`），前端标签由 `attribution-label.ts:attributionLabelKind` 按最新事件自己的操作者决定。
- `shared/file-change-protocol.ts` 定义共享协议：证据版本 `FILE_CHANGE_EVIDENCE_VERSION = 3`、结果/历史枚举、`FILE_CHANGE_LIMITS`；`shared/streaming-edit-origin.ts` 是流式 Edit 的固定大小来源指纹，不属于存储层（属于哪一节：未核实）。
- PostgreSQL 的 blob 目录与证据存储（`postgres-file-change-blob-catalog.ts`、`postgres-file-change-evidence-store.ts`）是元数据 SQL 的异步对应实现；仓库内除测试外没有构造它们的调用方（未接入生产路径）。
- 改动归属视图 `getWorkspaceModificationView`：读 `file_attributions` 表，返回历史观测而非净差异；默认 500 条、上限 2000，每个路径最多 10 条，最多查询 400 个路径、附加 cwd 范围 32 个；`completeness`/`baselineStatus: "unverified"` 明说只覆盖已记录的行；`findImpreciseChanges` 是有上限的警告扫描，触顶不会变成“无风险”。HTTP 入口是 `routes/git.ts` 里的 `/modifications`。

## 从哪读起
- `server/services/file-change-evidence.ts`：元数据状态机。
- `server/services/file-change-blob-store.ts`、`file-change-blob-catalog.ts`：内容与配额。
- `server/services/workspace-modification-view.ts`：归属视图查询。
- `server/services/file-attribution-service.ts`、`attribution-actors.ts`：归属时间线与操作者解析；`frontend/components/git/attribution-label.ts`：前端标签。

## 改它时
- 加或改证据表字段：`schema.ts` → `bun run db:generate`；同时看 `file-change-evidence.ts` 的重放/内容比较、`postgres-file-change-evidence-store.ts`（PG 对应实现）、回退对 effect 的读取（`file-change-reversal.ts`、`file-state-rebuild.ts`）。这些表是否进入数据导入导出（`data-portability.ts`）：未核实。
- 改 `FILE_CHANGE_LIMITS`（blob 大小、分块、预留空间）：`file-change-blob-store.test.ts`、`file-change-blob-catalog.test.ts`、`file-change-evidence.test.ts` 会断言具体数字。
- 改物理审计/保留清单：`file-change-physical-audit.test.ts`、`file-change-retention-inventory.test.ts`；它们必须留在 worker/子进程里，不得进主线程做整库枚举，也不得产出删除候选。
- 改归属视图上限（500/2000、10 条、400 路径）：同步 `routes/git.ts` 和前端 Git 面板；`/modifications` 返回的是历史观测，不能当净差异。
- 不变量：blob 必须 `ready` 且大小一致才能落 effect；终态结果不可改。

## 相关
- [文件写入与变更记录](write-queue.md)
- [回退与文件历史](revert.md)
- [Tree 快照](tree-snapshots.md)
- [一次文件修改与回退](../flows/file-change.md)
