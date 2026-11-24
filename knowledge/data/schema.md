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
  - server/db/type-level-claims.probe.ts
keywords:
  - schema.ts
  - sqliteTable
  - relations.ts
  - generateId
  - generateShortId
  - nanoid
  - ensureColumns
  - openDatabase
  - busy_timeout
  - WAL
  - foreign_keys
  - postgres-schema.ts
  - tablesFilter
  - db 句柄
  - bun:sqlite
status: draft
verified_at: 2e6441ad0
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
- `type-level-claims.probe.ts` 是一份纯类型层面的反例（异步回调能通过 `=> T` / `=> void` 的包装签名），配合 `transaction-atomicity-contract.test.ts` 说明类型系统挡不住事务回调里的 async，该约束靠 `transaction-atomicity-contract.test.ts` 守。

## 加一个字段的步骤
1. 改 `server/db/schema.ts`（SQLite 是唯一来源，见上文；关系变化再改 `relations.ts`）。不要手改 `drizzle/`，见 [迁移](migrations.md)。
2. 运行 `bun run db:generate` 生成 SQLite 增量迁移，再 `bun run db:migrate`（流程与资产检查见 [迁移](migrations.md)）。
3. 重新生成 PG schema：`bun scripts/generate-postgres-schema.ts`，再 `bun run db:generate:pg --name <name>` 生成 PG 增量迁移；`scripts/check-postgres-schema-parity.ts` 检查两边一致（见 [PostgreSQL 后端](postgres.md)）。
4. 核对数据导入导出（见 [数据导入导出](portability.md)）：
   - 新表：加进 `snapshot-protocol.ts:SNAPSHOT_TABLES`，并在 `applyImport` 补 `copyTable`。
   - `copyTable` 按两库列交集拷贝：旧快照缺的新列导入后取默认值，快照里多出的列会丢。
   - 新增 NOT NULL 且无默认值的列：旧快照缺该列，导入会失败；要给默认值，或拒绝旧版本快照。
   - 需要清空的数据：在 `clearData` 处理。

## 从哪读起
- `server/db/schema.ts`：全部表。文件头注释列了改 schema 时的导入导出检查项。
- `server/db/relations.ts`：Drizzle relations（只覆盖部分表）。
- `server/db/index.ts`：启动序列与后端选择（SQLite 或 PG）。
- `server/db/connection.ts`、`ensure-columns.ts`：连接参数与补列。

## 改它时
- 加表或加列：只改 `schema.ts`，其余按上面「加一个字段的步骤」；迁移文件、`postgres-schema.ts` 都是生成物，不手改。
- 加表还要同步导入导出：`SNAPSHOT_TABLES`、`applyImport` 的 `copyTable`、`clearData`（`data-portability.test.ts` 等会拦住缺漏的一部分，不是全部）。
- `server/db/__tests__/sqlite-backend-baseline.test.ts` 要求 schema 模块导出的表都是 SQLite 方言、迁移 journal 的 dialect 是 sqlite；schema 里混进别的方言的表定义会失败。
- 新写 SQLite 专有 SQL（`json_extract`、`MATCH`、`INSERT OR REPLACE`、PRAGMA 等）时，`server/db/sqlite-dialect-inventory.guard.test.ts` 会报出未登记的文件和能力；要么移植，要么在其 `DIALECT_INVENTORY` 登记。
- `tests/sqlite-template.ts:sqliteTemplateKey` 对 `drizzle/*.sql`、journal 和 `server/db/`、`server/db/backend/` 下非测试 `.ts` 取哈希来缓存测试库模板：改这些文件会自动重建模板，不需要手动清理。
- 不能破：SQLite 事务回调必须同步——`bun:sqlite` 的 `transaction(fn)` 在 `fn` 返回（即第一个 `await`）时就提交，async 回调会让后续写入落在事务外（`transaction-atomicity-contract.test.ts` 的契约，类型检查拦不住，见上）；`openDatabase` 的 `busy_timeout=250`（见 CLAUDE.md 主线程规则），以及测试进程拒绝打开真实 `~/.narrafork` 库。

## 相关
- [迁移](migrations.md)
- [PostgreSQL 后端](postgres.md)
- [全文搜索](search.md)
