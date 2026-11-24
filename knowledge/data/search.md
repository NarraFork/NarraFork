---
id: data.search
title: 全文搜索
summary: FTS5 trigram、触发器同步、搜索服务。
anchors:
  - server/db/fts.ts
  - server/db/pg-fts.ts
  - server/routes/search.ts
  - server/services/search-service.ts
  - server/services/search/
  - server/services/search/__tests__/search-backend-contract.test.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 全文搜索

站内会话、消息和知识库的全文检索。SQLite 用 FTS5 trigram 虚拟表，PostgreSQL 用 pg_trgm 影子表，二者藏在同一个 `SearchStore` 端口后。

注意：`server/lib/search/` 是 Agent 的联网搜索渠道（bocha、tavily 等适配器），与本节点无关，见 agent 与工具相关节点。

## 关键规则
- SQLite 索引表：`narrator_blocks_fts`、`narrator_messages_fts`、`narrators_fts`、`knowledge_entries_fts`、`knowledge_drafts_fts`、`outline_blocks_fts`（`fts.ts:FTS_INDEX_TABLES`）；都是外部内容表 + 触发器同步，tokenizer 为 `trigram`；旧的非 trigram 表在 `ensureFts` 里被检出并重建。
- 块索引文本每块最多 `BLOCK_INDEX_MAX_CHARS`（256K 字符）。块索引的重写完成后，`narrator_messages_fts` 被退役（`isEnvelopeIndexRetired`），搜索只读块索引。
- 启动时 `ensureFts` 不读索引来判断好坏；只有 `NARRAFORK_DB_FULL_INTEGRITY_CHECK=1` 或 `NARRAFORK_FTS_FULL_REBUILD=1` 才在非干净关闭后全量重建。后台完整性检查发现的坏索引经 `repairFtsTables` 重建（`ftsIndexFindings`）。
- trigram 至少 3 个字符才能用索引（`search/query.ts:INDEX_MIN_QUERY_CHARS`），含 CJK；更短的查询走 `LIKE` 子串路径。查询文本由调用方 `sanitizeQuery` 清洗，后端不自行清洗。
- 权限闸门必须在查询内部应用（端口文档约定）；知识库命中是例外，返回后由 `knowledgeService.filterReadable` 过滤。
- 端口方法全是异步。SQLite 实现通过读 worker 执行（`search/sqlite-worker-runner.ts`），单次超时 30s（`SEARCH_QUERY_TIMEOUT_MS`）、并发上限 32（`SEARCH_MAX_OUTSTANDING`）。各情形的错误：
  - 并发中的查询已达 32 个：503 `SEARCH_QUERY_BUSY`。
  - 单次执行超过 30s：504 `SEARCH_QUERY_TIMEOUT`。
  - 查询过大或不合法（读预算校验不通过）：413 `SEARCH_QUERY_BUDGET_EXCEEDED`，与上面两个上限无关。
  - 调用方取消：499 `SEARCH_QUERY_CANCELLED`。
  - worker 其他故障：503 `SEARCH_QUERY_UNAVAILABLE`。
- 后端按主数据库选择；没有注册实现会抛错而不是回退 SQLite（`search/backend.ts`）。PG 的影子表与触发器由 `pg-fts.ts:ensurePgFts` 幂等创建，漂移可用 `probePgFtsDrift` / `repairPgFts` 检测修复。
- 系统内部叙述者（`hidden_from_lists`、modeltrace）不参与搜索（`search/scope.ts`）。

## 从哪读起
- `server/routes/search.ts`：`GET /api/search`（分段 sessions/knowledge，分页或 cursor）与 `/sessions/:narratorId/hits`；`limit` 上限分别 100 / 50（`validators/search.ts`）。
- `server/services/search-service.ts`：产品层搜索逻辑与排序。
- `server/services/search/port.ts`：端口；`sqlite-store.ts` / `postgres-store.ts` 两个实现。
- `server/db/fts.ts`：建表、触发器、重建。

## 相关
- [PostgreSQL 后端](postgres.md)
