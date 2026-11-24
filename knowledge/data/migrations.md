---
id: data.migrations
title: 迁移（SQLite 与 PostgreSQL）
summary: 只能经生成器生成迁移；PG 单快照谱系；禁止手改 drizzle 目录。
anchors:
  - drizzle/meta/_journal.json
  - scripts/generate-sqlite-migrations.ts
  - scripts/postgres-migrations.ts
  - drizzle-postgres/meta/
  - drizzle.config.ts
  - drizzle.pg.config.ts
  - scripts/generate-sqlite-migrations.ts
  - scripts/postgres-migrations.ts
  - scripts/lib/postgres-migration-transaction.ts
  - server/db/run-migrations.ts
  - server/db/migrate.ts
  - server/db/data-backfills.ts
  - server/db/legacy-request-storage.ts
  - server/db/migrate-narrator-drafts.ts
  - server/db/migrate-role-to-disp.ts
  - server/db/test-role-migration.ts
  - server/services/migration-db.ts
  - shared/aggregation-migration.ts
keywords:
  - db:generate
  - db:migrate
  - db:generate:pg
  - db:check:pg
  - db:baseline:pg
  - db:resume:pg
  - _journal.json
  - current_snapshot.json
  - _snapshot_history.json
  - drizzle-kit
  - embedded-migrations-data
  - runMigrations
  - applyPendingMigrationsByHash
  - 数据回填
  - applySqliteDataBackfills
  - 0207
  - drop_legacy_request_dumps
  - __agg__
  - auto: 前缀
status: draft
verified_at: 2e6441ad0
---
# 迁移（SQLite 与 PostgreSQL）

两套独立迁移目录：`drizzle/`（SQLite，`_journal.json` 的 dialect 为 sqlite）和 `drizzle-postgres/`（PG）。改库结构的流程是：改 `server/db/schema.ts`，再用对应的生成命令；迁移文件不手改。

## 关键规则
- SQLite：`bun run db:generate` 实际运行 `scripts/generate-sqlite-migrations.ts`，它包装 drizzle-kit，带生成锁、pending 阶段记录（started/generated/validated）和摘要校验，并追加 model-history 触发器 SQL。`drizzle/meta/` 保留每个迁移的快照（`NNNN_snapshot.json`）。
- PG：`bun run db:generate:pg --name <name>`、`db:check:pg`、`db:baseline:pg`、`db:resume:pg` 都走 `scripts/postgres-migrations.ts`，在隔离的 stage 目录里生成，再按 receipt → sql → snapshot → history → journal → legacy-cleanup 阶段发布（`postgres-migration-transaction.ts`，`Phase`）。中断后用 `resume` 按摘要校验续发。
- PG 全量快照只有 `drizzle-postgres/meta/current_snapshot.json`；`_snapshot_history.json` 存小型谱系记录（idx、tag、id、prevId、snapshotDigest）。`baseline` 是结构快照收敛，不改写 SQL 和 journal。
- PG schema 不要直接对正式目录跑裸 drizzle-kit；`drizzle.pg.config.ts` 指向隔离副本（`resolvePgSchemaPath` / `resolvePgStageOut`）。
- 运行时：`server/db/migrate.ts` 按后端选择——PG 走 `runPostgresMigrationsOnce`，SQLite 走 `run-migrations.ts:runMigrations`。源码运行且 `./drizzle` 存在时读文件系统；编译后的二进制只用随构建内嵌的迁移数据（`server/generated/embedded-migrations-data`），没有有效内嵌数据则拒绝启动（`resolveMigrationsFolder`）。
- `run-migrations.ts` 还含大量针对历史库的修复和按 hash 补迁移逻辑（`applyPendingMigrationsByHash` 等），测试在 `run-migrations.test.ts`。
- `scripts/check-sqlite-migration-assets.ts` 校验 SQLite 迁移资产（文件数、体积、journal 结构）。
- 启动期数据回填（不是 drizzle 迁移）：`data-backfills.ts:applySqliteDataBackfills` 由 SQLite 生命周期适配器调用（`server/db/index.ts`），内容是叙述者 status/substatus 旧值折叠、trait、草稿隐私迁移等（草稿部分 `migrate-narrator-drafts.ts:migrateLegacyNarratorDraftTraits`）。
- 迁移 0207（`drop_legacy_request_dumps`）的物理半边由 `legacy-request-storage.ts` 拆开：先删便宜的修复表与部分索引；`api_requests` 三列删除要重写整表，所以在仍保留请求转储时延后（回执前缀 `LEGACY_REQUEST_RETIREMENT_RECEIPT_PREFIX`），管理员在存储页分批清转储后下次启动补完（`run-migrations.ts` 里调用 `retireLegacyRequestStorage` / `completeDeferredLegacyRequestRetirement`）。
- 模型聚合值迁移（`__agg__:<id>` → `auto:<model>`）：纯规则在 `shared/aggregation-migration.ts`，由 `main.ts` 启动后调用 `migrateAggregationsOnStartup`；`server/services/migration-db.ts` 让同一份查询在 SQLite（同步事务）和 PG（异步事务）上都能跑。
- `migrate-role-to-disp.ts`（把 `role='system'` 改成 `disp`）和 `test-role-migration.ts` 是手动执行的一次性脚本，不在启动路径上；两者在 `narrator-body-access.guard.test.ts`、`narrator-history-writers.guard.test.ts` 里作为「一次性」例外登记。
- 不改写已发布的 SQL 或 journal；回退已发布结构应追加补偿迁移（团队约定，见 CLAUDE.md，代码里由 receipt/摘要校验间接守护，具体拒绝条件未逐项核实）。

## 从哪读起
- `scripts/generate-sqlite-migrations.ts`、`scripts/postgres-migrations.ts`：生成入口。
- `server/db/run-migrations.ts`：运行时应用。
- `server/db/postgres-runtime.ts`：PG 启动时的迁移派发。

## 改它时
- 改库结构一律：`schema.ts` → `bun run db:generate`（SQLite）→ `bun scripts/generate-postgres-schema.ts` + `bun run db:generate:pg --name <name>`（PG）；不手改 `drizzle/`、`drizzle-postgres/`。
- 加迁移会让这些检查对新文件重新计算：`scripts/check-sqlite-migration-assets.ts`（CI static-checks 里跑，上限：4096 文件、总 128MiB、单 SQL 1MiB，测试 `tests/db/sqlite-migration-assets.test.ts`）、`tests/db/pg-*.test.ts`（PG 谱系与单基线，例如 `pg-metadata-assets.test.ts` 断言只留一份全量基线快照）、`server/db/run-migrations.test.ts`。
- 编译后的二进制只用内嵌迁移数据：新增迁移文件由 `scripts/lib/build-materials.ts` 在构建时打进 `embedded-migrations-data.ts` / `embedded-postgres-migrations-data.ts`，无需另外登记。
- 启动期数据回填写在 `data-backfills.ts`，必须幂等、每次启动都会跑、位置在迁移与 `ensureColumns` 之后、FTS 初始化之前（文件头注释的约束；挪动顺序会让索引建在错误内容上且不报错）；回填默认非致命，只有草稿迁移失败按 ERROR 记录。
- `narrators.next_seq` 不在启动时修复（写路径首次占用时抬升下限），不要把全表扫描加回启动。

## 相关
- [表结构与 Drizzle](schema.md)
- [PostgreSQL 后端](postgres.md)
- [数据导入导出](portability.md)
