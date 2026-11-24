---
id: data
title: 数据与存储
summary: 数据库表、迁移、两种数据库后端、全文搜索、导入导出与存储清理。
anchors:
  - server/db/index.ts
keywords:
  - 数据库
  - SQLite
  - PostgreSQL
  - drizzle
  - bun:sqlite
  - ~/.narrafork/narrafork.db
  - schema.ts
  - 迁移
  - 全文搜索
  - 导入导出
  - 存储清理
  - server/db/index.ts
  - db 句柄
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 数据与存储

数据层由一份 Drizzle schema（`server/db/schema.ts`）加两套迁移目录组成：SQLite 的 `drizzle/` 是默认后端，PostgreSQL 的 `drizzle-postgres/` 是显式选择的第二后端，PG 表结构由 SQLite schema 转译生成。`server/db/index.ts` 在启动时二选一，导出统一的 `db` / `sqlite` 句柄；选 PG 时 SQLite 句柄变成访问即抛错的代理，只有已经接入端口的存储（见 postgres 节点）能工作。

其余几块都挂在这个选择上：全文搜索在 SQLite 用 FTS5 trigram、在 PG 用 pg_trgm 影子表，统一在 `SearchStore` 端口后；存储统计和 VACUUM 经存储与维护端口，PG 下明确拒绝而不是返回零；数据导入导出基于 SQLite 快照文件，只合并少数几张表，改 schema 时必须同步。后端主线程规则决定了这些重活（快照构建、搜索查询、存储扫描）都在子进程或 worker 里执行。

## 下面有什么

- [表结构与 Drizzle](schema.md)：schema.ts、relations、主键与 ID 约定。
- [迁移（SQLite 与 PostgreSQL）](migrations.md)：只能经生成器生成迁移；PG 单快照谱系；禁止手改 drizzle 目录。
- [PostgreSQL 后端](postgres.md)：PG 支持的范围、方言差异、哪些功能只在 SQLite 上。
- [全文搜索](search.md)：FTS5 trigram、触发器同步、搜索服务。
- [数据导入导出](portability.md)：SNAPSHOT_TABLES、导入合并的表、schema 变更时的兼容要求。
- [存储管理与清理](storage.md)：存储统计、数据库清理、VACUUM 维护窗口。
