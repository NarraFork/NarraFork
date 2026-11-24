---
id: data.postgres
title: PostgreSQL 后端
summary: PG 支持的范围、方言差异、哪些功能只在 SQLite 上。
anchors:
  - server/db/postgres-runtime.ts
  - server/db/postgres-client.ts
  - server/db/pg-fts.ts
  - server/db/index.ts
  - server/services/postgres-composition.ts
  - server/services/storage/postgres-database-storage.ts
  - server/db/__tests__/sqlite-backend-baseline.test.ts
  - server/db/backend/
  - server/db/pg-errors.ts
  - server/db/pg-retry.ts
  - server/db/postgres-schema.ts
keywords:
  - PostgreSQL
  - Postgres
  - PG
  - NF_DATABASE_BACKEND
  - NF_DATABASE_URL
  - DATABASE_URL
  - database.backend
  - PostgresStartupError
  - composePostgresStores
  - pg_trgm
  - withPgRetry
  - classifyPgError
  - SQLSTATE
  - notApplicable
  - DatabaseStorageUnsupportedError
  - bun-sql
status: draft
verified_at: 2e6441ad0
---
# PostgreSQL 后端

默认后端是 SQLite；PostgreSQL 是显式选择的第二后端，目前只覆盖部分业务存储。选 PG 后整个进程只用 PG，不会与 SQLite 混用。

## 关键规则
- 选择：`NF_DATABASE_BACKEND` 环境变量或 settings 的 `database.backend`，值只能是 `sqlite`（默认）或 `postgres`，未知值启动即报错。选 postgres 还必须有 `NF_DATABASE_URL`（其次 `DATABASE_URL`）；只有 `DATABASE_URL` 不会选中 PG；URL 不允许写进 settings.json（`postgres-runtime.ts:resolveDatabaseBackendConfig`）。选 PG 时不得再设 `NF_READ_BACKEND` / `NF_WRITE_BACKEND`。
- 启动分阶段、失败即终止、无 SQLite 回退：连接探测 → `drizzle-postgres` 迁移 → `ensurePgFts` → FTS 回填就绪（`PostgresStartupError` 标明阶段，错误信息会抹掉 URL 密码）。
- PG 模式下 `server/db/index.ts` 不打开任何 SQLite 连接，`db` / `sqlite` 变成访问即抛错的代理；仍读 SQLite 句柄的代码路径会明确失败，而不是悄悄写第二个库。实例锁照常获取。
- 已有 PG 实现的存储由 `postgres-composition.ts:composePostgresStores` 一次性注入：注册账号、认证会话与 MFA、知识库读写、大纲存储与访问读、项目读适配器、运行时队列、叙述者消息引用端口、搜索。其余服务不在此列，PG 下是否可用要看各自是否经这些端口。
- SQLite 专属机制在 PG 下不存在：WAL、干净关闭标记、完整性探针、VACUUM 窗口。维护端口对 checkpoint / 统计 / 可回收空间 / 回收空间全部返回 `notApplicable`（`createPostgresMaintenanceRefusals`）；VACUUM 路由因此得到 501。
- 存储统计：PG 的 `databaseStoragePort` 声明所有能力为 false，`scanBreakdown` 抛 `DatabaseStorageUnsupportedError`，不返回 0（`storage/postgres-database-storage.ts`）。
- 全文搜索：用 pg_trgm GIN 影子表 + 触发器代替 FTS5（`pg-fts.ts`），见 [全文搜索](search.md)。
- 数据导入导出直接使用 `sqlite` 句柄，PG 下不可用，见 [数据导入导出](portability.md)。
- 方言差异的守护：`server/db/sqlite-dialect-inventory.guard.test.ts` 盘点 SQLite 方言用法；`db/pg-errors.ts`、`pg-retry.ts` 处理 PG 错误分类与重试。

## 从哪读起
- `server/db/postgres-runtime.ts`：配置解析、启动、关闭。
- `server/services/postgres-composition.ts`：哪些存储接了 PG。
- `server/db/postgres-schema.ts`：生成物，勿手改。
- `server/db/postgres-client.ts`：用 Bun 的 `SQL` + drizzle `bun-sql` 创建惰性连接的客户端（目前只支持 `driver: "bun-sql"`，URL 不能为空）；`server/db/backend/` 放后端无关的端口与能力声明（`capability.ts`、`maintenance-port.ts`、读写选择器）。

## 改它时
- 给某个存储加 PG 实现：在 `postgres-composition.ts:composePostgresStores` 里注入（缺口会在这一个函数里可见）；SQLite 句柄在 PG 下是访问即抛错的代理，新代码不要再直接 `import { sqlite }` 走老路径。
- 改 PG 错误处理走 `pg-errors.ts:classifyPgError`（按 SQLSTATE，不看 message；Bun SQL 的 SQLSTATE 在 `errno` 字段）与 `pg-retry.ts:withPgRetry`；测试 `server/db/pg-errors.test.ts`、`pg-retry.test.ts`、`postgres-client.test.ts`、`postgres-runtime.test.ts`。
- `server/db/__tests__/sqlite-backend-baseline.test.ts` 是防「第二种方言被悄悄启用」的绊线：默认必须是 SQLite，环境里的 `DATABASE_URL` 不能改变任何行为；`sqlite-dialect-inventory.guard.test.ts` 盘点 SQLite 专有用法，新用法要登记。
- 新增 PG 迁移/schema 变更见 [迁移](migrations.md)、[表结构](schema.md)；`postgres-schema.ts` 是生成物。
- 不能破：PG 模式启动失败即终止，不回退 SQLite；不返回「假零值」（统计、VACUUM 都明确拒绝）。

## 相关
- [迁移](migrations.md)
- [表结构与 Drizzle](schema.md)
- [存储管理与清理](storage.md)
