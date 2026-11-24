---
id: data
title: 数据与存储
summary: 数据库表、迁移、两种数据库后端、全文搜索、导入导出与存储清理。
anchors: []
status: stub
verified_at: null
---
# 数据与存储

> 待填写：数据库表、迁移、两种数据库后端、全文搜索、导入导出与存储清理。

## 下面有什么

- [表结构与 Drizzle](schema.md)：schema.ts、relations、主键与 ID 约定。
- [迁移（SQLite 与 PostgreSQL）](migrations.md)：只能经生成器生成迁移；PG 单快照谱系；禁止手改 drizzle 目录。
- [PostgreSQL 后端](postgres.md)：PG 支持的范围、方言差异、哪些功能只在 SQLite 上。
- [全文搜索](search.md)：FTS5 trigram、触发器同步、搜索服务。
- [数据导入导出](portability.md)：SNAPSHOT_TABLES、导入合并的表、schema 变更时的兼容要求。
- [存储管理与清理](storage.md)：存储统计、数据库清理、VACUUM 维护窗口。
