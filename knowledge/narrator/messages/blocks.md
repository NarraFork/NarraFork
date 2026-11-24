---
id: narrator.messages.blocks
title: 块存储
summary: narrator_blocks 块信封、块同步队列与回填。
anchors:
  - server/services/narrator-block-*.ts
  - server/services/narrator-body-*.ts
  - server/lib/narrator-bodies.ts
  - server/lib/narrator-body-length.ts
  - server/services/__tests__/narrator-block-page.test.ts
  - frontend/lib/block-protocol.ts
  - shared/narrator-blocks/
keywords:
  - narrator_blocks
  - narrator_block_sync_queue
  - narrator_block_index_queue
  - narrator_block_backfill
  - narrator_block_assets
  - body_format
  - bodyRevision
  - narratorBlocks.write
  - narratorBlocks.read
  - narratorBlocks.compactJson
  - 块协议
  - 块格式信封
  - rows-only
  - syncEnvelope
  - flushQueuedSince
  - runSweep
  - fillBodies
  - insertEnvelope
  - writeEnvelopeBody
  - decodeBlockPage
  - assembledBodyLengthSql
status: draft
verified_at: 776dbf07e
---
# 块存储

信封（`narrator_messages` 行）的另一种存法：`body_format=2` 时，正文拆成 `narrator_blocks` 里的块行，`content_json` 只是投影；`body_format=1` 是旧式整体 JSON。读写正文的代码因此要同时认两种格式。

## 关键规则
- `narrator_blocks`：kind 为 input/output/reasoning/tool/context，phase 为 open/done/aborted/failed（`schema.ts:narratorBlocks`）。一个非 assistant 信封只有一个块（input 或 context），assistant 步骤里每个 provider item 一个块；`ordinal` 在条目打开时分配，可有空洞但不重排；`aborted` 只能用于 output/reasoning，input 必为 done；tool 块有 `wireId`（线上调用 id），其余没有。
- 一个信封的块行与 `content_json` 由 `narrator-block-sync.ts:syncEnvelope` 保持一致，行 id 在重写中保持稳定。同步模式 `streaming` / `sealed` / `keep`。
- 新信封格式：`newEnvelopeFormat()` 在 `settings.narratorBlocks.write` 关闭或没有块表时返回 1，否则启动同步扫描并返回 2。`rowsOnlyWrites()` 仅在 SQLite 且 `compactJson`、`write`、`read` 都开时为真，此时新块格式正文只存在块行里（rows-only）。
- 同步队列已核对实现：触发器把块格式信封的变更写入 `narrator_block_sync_queue`；写事务开头 `syncQueueMark()` 取队列最大 rowid，结束前 `flushQueuedSince(mark)` 同步并删除此后新入队的条目（`narrator-block-sync.ts`，`seq-floor-tx.ts:dbTransactionWithSeqFloor` 调用）；定时 `runSweep` → `drainQueue` 在限时预算内清其余积压。触发器本身的 SQL 未逐条核对。
- 搜索索引：块行因正文或工具账本变化被排进 `narrator_block_index_queue`（带 `version`，旧读结果不会覆盖新变化），由 `narrator-block-index.ts` 的后台任务在 worker 里算文本、短事务写入，不在写事务内分词。
- 后台任务（`narrator-block-backfill.ts`，进度存 `narrator_block_backfill`，可暂停，仅 SQLite）：`convert` 给旧信封补块行并最后把它置为格式 2，`verify` 校验块行能还原存储内容并记入诊断，`reindex` 重写块搜索索引文本，三者按此顺序；`clear` 丢弃已验证信封的 `content_json` 投影（压缩标记保留），`restore` 把投影写回，供回滚。读由 worker 完成，主线程只在信封自读取后未变时才应用。
- 读写正文统一走 `narrator-body-reads.ts`（`fillBodies`）与 `narrator-body-writes.ts`（`insertEnvelope`、`writeEnvelopeBody`），不要直接读 `content_json`。
- 服务端正文长度与来源判定：`lib/narrator-bodies.ts` 判断块存储是否可用并给出读取 SQL，`lib/narrator-body-length.ts:assembledBodyLengthSql` 在 SQL 里度量块格式信封的长度。
- 页输出：`narrator-block-page.ts`（`toBlockPage`、`toEnvelopes`）产出块协议 v2 的页；前端 `lib/block-protocol.ts`（`decodeBlockPage` / `decodeBlockMessage` / `decodeBlockFrame`）把页和 WS 帧还原成文档行。

## 从哪读起
- `server/db/schema.ts`：`narratorBlocks` 及其约束、`narratorBlockSyncQueue`、`narratorBlockIndexQueue`、`narratorBlockAssets`、`narratorBlockBackfill`。
- `narrator-block-sync.ts:syncEnvelope`、`narrator-block-page.ts:toBlockPage`、`narrator-block-targets.ts`（按块定位删除/编辑目标，`MAX_BLOCK_DELETE_ELEMENTS` = 4096）。
- 测试：`narrator-block-page.test.ts`、`narrator-block-storage.test.ts`、`narrator-block-backfill.test.ts`、`narrator-block-scans.test.ts`、`narrator-body-writes.test.ts`。

## 改它时
- 读写 `content_json` 正文：必须走 `narrator-body-reads.ts` / `narrator-body-writes.ts`；`narrator-body-access.guard.test.ts` 与前端 `lib/narrator-body-access.guard.test.ts` 按文件计数访问点：服务端要求登记的计数与现状一致，前端要求计数只降不升。
- 新增块 kind 或改块格式：同改 `shared/narrator-blocks/`、`frontend/lib/block-protocol.ts` 的解码与 `narrator-block-sync.ts` 的同步，并留意 `schema.ts` 里的 CHECK 约束（kind/phase/subtype 等）；`narrator-block-page.test.ts` 覆盖页输出。
- 改同步队列或扫描：`narrator-block-sync-cost.test.ts`、`narrator-block-state.test.ts` 覆盖成本与状态；写事务仍须带 `syncQueueMark` / `flushQueuedSince`。
- 改回填/投影任务：`narrator-block-backfill.test.ts`；读必须留在 worker，主线程只做短事务写。
- 改块表结构：按 CLAUDE.md 先改 `schema.ts` 再生成迁移，并同步 `data-portability.ts`。

## 相关
- [消息存储](index.md)
- [消息与引用](refs-paging.md)
- [工具调用记录](tool-calls.md)
