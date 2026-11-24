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
  - frontend/components/search/
  - frontend/hooks/useNarratorMessageSearch.ts
  - frontend/hooks/useSearch.ts
  - frontend/lib/search-page-focus.ts
  - frontend/lib/search-utils.tsx
  - frontend/routes/search.tsx
  - server/lib/validators/search.ts
keywords:
  - 搜索
  - 全局搜索
  - /api/search
  - /search
  - /api/narrators/:id/search
  - SearchStore
  - narrators_fts
  - narrator_blocks_fts
  - knowledge_entries_fts
  - trigram
  - pg_trgm
  - FTS5
  - ensureFts
  - SEARCH_QUERY_BUSY
  - SEARCH_QUERY_TIMEOUT
  - NARRAFORK_FTS_FULL_REBUILD
  - SEARCH_INCLUDES
  - Recall
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
- 同一个端口还服务 Agent 的 Recall 工具（`port.ts:searchRecallMessages`，端口注释称它不做查看者闸门，因为 Recall 以叙述者身份运行）；`search/recall-store.ts` / `recall-reader.ts` 是它的读实现，不属于全局搜索页。
- 前端：全局搜索页 `/search`（`frontend/routes/search.tsx`）有 `all` 与分段标签，概览每段 5 条、分段页每页 20 条（`hooks/useSearch.ts`）；`include` 可选 `subagents/system/tools/archived`，排序 `relevance`（默认）或 `time`（`lib/search-utils.tsx`）；⌘K / Ctrl+K 与侧栏入口经 `lib/search-page-focus.ts` 聚焦搜索框。
- 单个会话内搜索走 `GET /api/narrators/:id/search`（`hooks/useNarratorMessageSearch.ts`，300ms 防抖，至少 2 字符才发请求）。

## 从哪读起
- `server/routes/search.ts`：`GET /api/search`（分段 sessions/knowledge，分页或 cursor）与 `/sessions/:narratorId/hits`；`limit` 上限分别 100 / 50（`validators/search.ts`）。
- `server/services/search-service.ts`：产品层搜索逻辑与排序。
- `server/services/search/port.ts`：端口；`sqlite-store.ts` / `postgres-store.ts` 两个实现。
- `server/db/fts.ts`：建表、触发器、重建。
- `frontend/routes/search.tsx`、`frontend/components/search/`：搜索页与结果卡片；`frontend/hooks/useSearch.ts`：分段查询。
- `server/lib/validators/search.ts`：查询参数 schema。

## 改它时
- 加一个可搜索的实体（新 FTS 表）：`fts.ts` 的建表与触发器 + `FTS_INDEX_TABLES`，PG 侧同步 `pg-fts.ts` 的影子表；`search/port.ts` 加方法后，`sqlite-store.ts` 与 `postgres-store.ts` 两边都要实现。
- `search/__tests__/search-backend-contract.test.ts` 会拦：端口方法没有生产调用点、业务层出现 FTS5 查询文本、业务层直接引入 `bun:sqlite`、端口方法不返回 Promise、默认后端不是 SQLite、postgres 后端在客户端未绑定时没有 fail-closed。
- 新增 SQLite 专有 SQL 要登记到 `server/db/sqlite-dialect-inventory.guard.test.ts` 的 `DIALECT_INVENTORY`；FTS 行为分别由 `server/db/fts*.test.ts`、`db/__tests__/pg-fts.test.ts`、`search/sqlite-worker-runner.test.ts` 覆盖。
- 改请求参数：`server/lib/validators/search.ts`（`limit` 上限、`include`、`sections`）与前端 `frontend/lib/search-utils.tsx`、`hooks/useSearch.ts` 的常量/参数要一起看；错误码变化要同步前端展示。
- 不能破：端口方法全是异步且在 worker 里执行、权限闸门在查询内部、搜索路径不做同步全表扫描（CLAUDE.md 主线程规则）。

## 相关
- [PostgreSQL 后端](postgres.md)
