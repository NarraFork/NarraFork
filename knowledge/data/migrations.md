---
id: data.migrations
title: 迁移（SQLite 与 PostgreSQL）
summary: 只能经生成器生成迁移；PG 单快照谱系；禁止手改 drizzle 目录。
anchors:
  - drizzle/
  - drizzle-postgres/
  - drizzle.config.ts
  - drizzle.pg.config.ts
  - scripts/generate-sqlite-migrations.ts
  - scripts/postgres-migrations.ts
  - scripts/lib/postgres-migration-transaction.ts
  - server/db/run-migrations.ts
  - server/db/migrate.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
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
- 不改写已发布的 SQL 或 journal；回退已发布结构应追加补偿迁移（团队约定，见 CLAUDE.md，代码里由 receipt/摘要校验间接守护，具体拒绝条件未逐项核实）。

## 从哪读起
- `scripts/generate-sqlite-migrations.ts`、`scripts/postgres-migrations.ts`：生成入口。
- `server/db/run-migrations.ts`：运行时应用。
- `server/db/postgres-runtime.ts`：PG 启动时的迁移派发。

## 相关
- [表结构与 Drizzle](schema.md)
- [PostgreSQL 后端](postgres.md)
- [数据导入导出](portability.md)
