---
id: data.schema
title: 表结构与 Drizzle
summary: schema.ts、relations、主键与 ID 约定。
anchors:
  - server/db/schema.ts
  - server/db/relations.ts
  - server/db/index.ts
  - server/db/ensure-columns.ts
  - server/db/connection.ts
  - server/lib/id.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 表结构与 Drizzle

SQLite 表结构的唯一来源是 `server/db/schema.ts`（Drizzle `sqliteTable`，目前约 147 张表）；关系在 `relations.ts`；`db/index.ts` 把两者交给 `drizzle({ client, schema })`，导出 `db`（Drizzle）和 `sqlite`（原生 `bun:sqlite` 句柄）。

## 关键规则
- 主键是文本：多数表 `id: text("id").primaryKey()`，值来自 `server/lib/id.ts:generateId`（nanoid，默认 21 字符）；`generateShortId` 默认 8 字符。部分关联表用复合主键（`primaryKey({ columns: [...] })`）。
- FTS5 虚拟表不在 Drizzle schema 里，由 `fts.ts` 单独管理；`drizzle.config.ts` 用 `tablesFilter: ["!*_fts*"]` 把它们排除出迁移生成。
- 可写主库连接只能经 `connection.ts:openDatabase` 打开：设置 WAL、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=250`（刻意很短，锁冲突交给应用层重试），并在测试进程里拒绝打开真实 `~/.narrafork` 库。
- `ensure-columns.ts:ensureColumns` 在迁移后按 schema 补缺失列，兜底迁移历史与实际库分叉的情况。
- 改 schema 必须同步 `data-portability`（`SNAPSHOT_TABLES` / `copyTable` / `clearData`），见 [数据导入导出](portability.md)。
- PG 的 `server/db/postgres-schema.ts` 是由 `scripts/generate-postgres-schema.ts` 从本文件转译出的生成物，文件头写明不可手改；`scripts/check-postgres-schema-parity.ts` 检查两边一致。
- 迁移文件不手写，流程见 [迁移](migrations.md)。

## 从哪读起
- `server/db/schema.ts`：全部表。文件头注释列了改 schema 时的导入导出检查项。
- `server/db/relations.ts`：Drizzle relations（只覆盖部分表）。
- `server/db/index.ts`：启动序列与后端选择（SQLite 或 PG）。

## 相关
- [迁移](migrations.md)
- [PostgreSQL 后端](postgres.md)
- [全文搜索](search.md)
