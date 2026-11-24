---
id: data.storage
title: 存储管理与清理
summary: 存储统计、数据库清理、VACUUM 维护窗口。
anchors:
  - server/routes/storage.ts
  - server/services/storage-service.ts
  - server/services/storage-scan-job.ts
  - server/services/storage/
  - server/services/database-cleanup-service.ts
  - server/services/database-cleanup-utils.ts
  - server/services/storage-history-service.ts
  - server/db/backend/sqlite-maintenance.ts
  - frontend/components/settings/BlockBackfillCard.tsx
  - frontend/components/settings/StorageRetentionSection.tsx
  - frontend/components/settings/StorageSection.tsx
  - frontend/routes/admin/storage.tsx
  - frontend/routes/settings/storage.tsx
  - server/routes/storage-history.ts
  - server/services/legacy-request-dump-cleanup.ts
  - server/services/storage-history-mutations.ts
  - server/services/storage-history-runtime.ts
  - server/services/storage-scan-queries.ts
  - shared/storage-categories.ts
  - shared/storage-retention.ts
  - server/db/legacy-request-storage.ts
keywords:
  - 存储空间
  - 存储统计
  - 数据库清理
  - VACUUM
  - /api/storage
  - /api/storage/scan/start
  - /api/storage/database/vacuum
  - /api/storage/database/history
  - DATABASE_VACUUM_UNSUPPORTED
  - storageRetention
  - toolCallPayloads
  - messageHistory
  - 保留天数
  - 自动清理
  - StorageSection
  - BlockBackfillCard
  - /settings/storage
  - /admin/storage
  - invalidateStorageCache
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 存储管理与清理

管理员在设置页查看各类数据占用、预览并清理历史会话和工具调用载荷、手动回收数据库空间。全部是 admin 路由（`requireAdmin`），挂在 `/api/storage`。

## 关键规则
- 扫描按类别独立作业：`database`、`uploads`、`chatAttachments`、`shares`、`worktrees`、`treeSnapshots`、`requestRecordings`、`savedRequestRecordings`、`dormantIgnored`、`coordinatorOutputs`、`containers`（`shared/storage-categories.ts`）。每类有自己的槽和 abort；同类已在跑时返回当前状态而不叠加（`storage-scan-job.ts`）。路由 `/scan/start`、`/scan/status`、`/scan/cancel`。
- 数据库体积测量走 `DatabaseStoragePort`：SQLite 由 worker 执行分片扫描；后端不能测量就拒绝（`DatabaseStorageUnsupportedError`），不返回零值（`storage/database-storage-port.ts`、`storage/store.ts`）。
- 数据库清理目标只有三种：`archivedSessions`、`staleSessions`（默认 90 天）、`toolCallPayloads`（默认 180 天）。`/database/preview` 先预览，`/database/cleanup` 才执行（`database-cleanup-service.ts`）。
- 会话清理有阻断原因：运行中的终端、后台任务、非归档/非陈旧状态、近期活动、团队仍有活跃工作项（`database-cleanup-utils.ts:DatabaseCleanupBlockedReasonCode`）。
- `toolCallPayloads` 走 `storage-history-service`：预览缓存 5 分钟（`PREVIEW_TTL_MS`），执行是异步作业（`/database/cleanup` 返回 202 与 job），而不是在请求里同步删。
- `POST /api/storage/database/vacuum` 是显式的服务级维护窗口：同步执行，期间普通 HTTP/WS/Agent 活动可能暂停。`vacuumDatabase` 在进程内维护锁下先暂停 token 重算与 model-history worker、排空读 worker 池，截断式 checkpoint，再 VACUUM，之后恢复。后端不支持回收时抛 501 `DATABASE_VACUUM_UNSUPPORTED`。
- 变更类操作之后调用 `storageService.invalidateStorageCache()`。
- 历史保留策略（`/api/storage/database/history`：`jobs`、`preview`、`cleanup`、`cancel`，请求体上限 8192 字节）有两个目标 `toolCallPayloads` 与 `messageHistory`（`shared/storage-retention.ts`），规则存 `settings.storageRetention.<target>`（`retentionDays` 1..36500 或 null，`autoCleanup` 默认关）；`storage-history-runtime.ts:startStorageHistoryRetention` 启动自动清理并在设置变化时重新对账；实际改写在 `storage-history-mutations.ts`，不删除 refs 和执行回执，`Write/Edit/StructSed/GenUI` 的输入不被清除，因为旧版首次触碰文件的重建还要用（`retainsStorageReplayInput`）。
- 旧的 `/database/preview`、`/database/cleanup` 在 `target=toolCallPayloads` 时转入同一套历史作业（`routes/storage.ts`），所以旧客户端也不会同步删。
- 区块回填：`GET /blocks/backfill`、`POST /blocks/backfill/pause`、`POST /blocks/projection`；前端 `BlockBackfillCard` 只在回填进行时显示。
- 启动时 `main.ts` 后台调用 `removeLegacyRequestDumpDirs`，删旧版遗留的 `request-dumps`、`malformed-request-dumps`、`token-repair-jobs` 目录（只用异步 fs）。
- 历史请求转储（迁移 0207 延后改写时保留的）单独由 `/database/legacy-request-dumps/clear` 清理。

## 从哪读起
- `server/routes/storage.ts`：全部端点。
- `server/services/database-cleanup-service.ts`：预览、执行、`vacuumDatabase`。
- `server/services/storage-service.ts`：非数据库类别的扫描与缓存。
- `server/db/backend/sqlite-maintenance.ts`：checkpoint / VACUUM 的 SQLite 实现。
- 前端：`frontend/components/settings/StorageSection.tsx`（路由 `/settings/storage`、`/admin/storage`）、`StorageRetentionSection.tsx`（保留策略）、`BlockBackfillCard.tsx`；数据导入导出的卡片见 [数据导入导出](portability.md)。
- `server/services/storage-history-service.ts`、`storage-history-runtime.ts`、`storage-history-mutations.ts`：保留策略的作业、运行时与改写。

## 改它时
- 加一个扫描类别：`shared/storage-categories.ts`（类别键）→ `storage-service.ts` / `storage-scan-job.ts`（槽与 abort）→ 前端 `StorageSection.tsx` 展示；数据库内的分类在 `storage-scan-queries.ts` 的 `DATABASE_STORAGE_CATEGORY_KEYS`，那个模块只能被 worker 导入，不能碰 `server/db/index.ts`（文件头说明）。
- 加一个数据库清理目标：`database-cleanup-service.ts` + `database-cleanup-utils.ts` 的阻断原因码 + `routes/storage.ts` 的 zod schema；测试在 `database-cleanup-utils.test.ts`、`database-cleanup-teams.test.ts`、`database-cleanup-workers.test.ts`。
- 加保留策略目标：`shared/storage-retention.ts:STORAGE_RETENTION_TARGETS`、`settings.storageRetention.*`（`lib/settings/defaults.ts` 与 `index.ts` 的 patch schema）、`storage-history-service.ts`；测试 `routes/__tests__/storage-history.test.ts`、`settings-storage-retention.test.ts`、`storage-history-service.test.ts`、`storage-history-mutations.test.ts`。
- 任何会改变存储占用的变更之后调用 `storageService.invalidateStorageCache()`；全库扫描、清理和 VACUUM 都不能放到普通请求路径里（主线程规则）。
- PG 后端下统计与 VACUUM 必须保持明确拒绝（`DatabaseStorageUnsupportedError` / 501），不要改成返回 0。

## 相关
- [PostgreSQL 后端](postgres.md)：PG 下统计与 VACUUM 的行为。
- [数据导入导出](portability.md)
