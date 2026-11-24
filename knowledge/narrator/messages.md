---
id: narrator.messages
title: 消息存储
summary: narrator_messages / narrator_message_refs / narrator_tool_calls / narrator_blocks 的分工；seq 游标分页；压缩点。
anchors:
  - shared/export-turn-range.ts
  - server/services/narrator-messages.ts
  - server/services/narrator-refs/
  - server/services/narrator-block-*.ts
  - server/services/narrator-body-*.ts
  - server/db/schema.ts
  - server/services/__tests__/narrator-block-page.test.ts
  - server/services/__tests__/narrator-messages-history.test.ts
  - frontend/lib/api/narrator-timeline.ts
  - frontend/lib/block-protocol.ts
  - server/lib/narrator-bodies.ts
  - server/lib/narrator-body-length.ts
  - server/lib/validators/narrator-timeline.ts
  - server/routes/narrator-timeline.ts
  - server/scripts/benchmark-narrator-history.ts
  - server/services/narrator-display-page-reader.ts
  - server/services/narrator-export.ts
  - server/services/narrator-message-count.ts
  - server/services/narrator-persistence.ts
  - server/services/narrator-store.ts
  - server/services/narrator-surface-reads.ts
  - server/services/narrator-tool-detail.ts
  - server/services/narrator-turn-timing.ts
  - server/services/narrator-turns.ts
  - server/services/narrator-timeline.ts
  - shared/message-origin.ts
  - shared/narrator-blocks/
  - shared/narrator-timeline.ts
keywords:
  - narrator_messages
  - narrator_message_refs
  - narrator_tool_calls
  - narrator_blocks
  - narrator_turns
  - narrator_block_sync_queue
  - body_format
  - bodyRevision
  - PRETEXT_DOCUMENT_CHANGED
  - DISPLAY_PAGE_READER_UNAVAILABLE
  - DISPLAY_PAGE_READER_BUSY
  - TOOL_CALL_DETAIL_TOO_LARGE
  - TOOL_CALL_DETAIL_SELECTION_REQUIRED
  - /api/narrators/:id/export
  - /api/narrators/:id/timeline
  - /api/narrators/:id/tool-calls/:toolUseId
  - narratorStore
  - 会话导出
  - 时间线
  - 消息数
  - originLabel
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 消息存储

会话消息不按叙述者各存一份，而是“消息实体 + 引用”：消息本体存一次，叙述者通过引用行按序看到它，所以分叉只需复制引用（见 [分叉](fork.md)）。

## 关键规则
- `narrator_messages`：消息本体，`role` 为 user/assistant/system/sys/disp；`contentJson` 存 content blocks，`parentToolUseId` 把子代理消息挂到工具调用下，`bodyRevision` 在模型可见内容变化时事务内递增；`bodyFormat` 为 1（旧式整体 JSON）或 2（块格式）（`server/db/schema.ts:narratorMessages`）。
- `narrator_message_refs`：叙述者与消息的 junction，`(narratorId, messageId)` 唯一，`seq` 定序，`isCompact=1` 标记压缩点，`segmentCompactId` 指向隐藏该引用的分段压缩摘要，`injectionConsumedAt` 记录注入何时被收件循环采纳。
- `seq` 由 `narrators.nextSeq` 单调分配：`narrator-refs/seq-store.ts:claimNextRefSeq` 自增并返回旧值；写事务应经 `seq-floor-tx.ts:dbTransactionWithSeqFloor`，先把计数抬到不低于现有最高 seq，且只在事务提交后才把叙述者标记为已修复（回滚不会留下假标记）。
- `narrator_tool_calls`：每次工具调用一行（`toolUseId`、`toolName`、输入输出 JSON 及字符数、执行设备/cwd 等冻结的执行目标、`modelRevision`），同时承担权限审批状态；没有独立的权限请求表。
- `narrator_blocks`：块格式信封（`body_format=2`）的块行，kind 为 input/output/reasoning/tool/context，phase 为 open/done/aborted/failed；一个信封的块行与 `content_json` 由 `narrator-block-sync.ts:syncEnvelope` 保持一致，行 id 在重写中保持稳定；队列流程已核对实现：触发器把块格式信封的变更写入 `narrator_block_sync_queue`；写事务开头 `syncQueueMark()` 取队列最大 rowid，结束前 `flushQueuedSince(mark)` 同步并删除此后新入队的条目（`narrator-block-sync.ts`，`seq-floor-tx.ts:dbTransactionWithSeqFloor` 调用）；定时 `runSweep` → `drainQueue` 在限时预算内清其余积压（`newEnvelopeFormat` 返回 2 时启动 `startSweep`）。触发器本身的 SQL 未逐条核对。读写正文统一走 `narrator-body-reads.ts`（`fillBodies`）与 `narrator-body-writes.ts`（`insertEnvelope`、`writeEnvelopeBody`），不要直接读 `content_json`。
- 分页以 `refs.seq` 为游标：默认取尾页，`beforeSeq` 取更旧一页，`afterSeq` 升序取更新部分；查 `limit+1` 判断是否还有更多，单页上限 100（`narrator-messages.ts:getPretextDocumentPage`）。已被分段压缩隐藏的引用（`segmentCompactId` 非空）不进入页。页组装期间文档版本变化会抛 `PRETEXT_DOCUMENT_CHANGED`（409）。
- 压缩点：查询“最近 compact”用 `isCompact = 1` 的最大 seq（`narrator-messages.ts` 内 `lastCompactRow` 系列查询）；后续上下文只从该点之后加载，见 [上下文与压缩](context.md)。
- 变更类方法（删除消息/块、更新压缩摘要、dismiss 各类提示）在 `narratorMessageQueries` 中统一包了 `admittedMutation`（`narrator-messages.ts` 末尾）。
- 引用存储有 SQLite 与 PostgreSQL 两种实现：`narrator-refs/store.ts:getNarratorMessageRefsPort` 在绑定了 PG 端口时返回它，否则为 `undefined` 走 SQLite 路径（`assertSqliteNarratorOperation` 在 PG 下拒绝仅 SQLite 的操作）。

- 写入层：生产者经 `narrator-store.ts:narratorStore`（`appendInput`、`appendNotice`、`openStep`、`writeStepItem`、`appendStep`、`settleTool`、`patchState` 等）写模型可见的历史，每个操作一个事务；它转调 `narrator-persistence.ts:narratorPersistence`（实现所在，体量很大）。直接写历史表的模块由 `narrator-history-writers.guard.test.ts` 冻结。
- 展示页读取：`narrator-display-page-reader.ts:readNarratorDisplayMessages` 只走 worker（SQLite 路径或 PG 端口），不可用时报 `DISPLAY_PAGE_READER_UNAVAILABLE`（503，“不允许主线程原始 JSON 回退”），并发 2、排队上限 32，满则 `DISPLAY_PAGE_READER_BUSY`（503）；单次最多 10000 行、原始 16 MiB、输出 4 MiB、10 秒（`DISPLAY_PAGE_LIMITS`，`lib/db-worker/display-page-protocol.ts`）。
- 消息数：展示的数字都现算——详情数单个叙述者的引用数，列表只数当前页的 id（一条分组查询）；`narrators.message_count` 只是只增不减的上界，仅供 `sortBy=messageCount` 排序，不回填（`narrator-message-count.ts`）。
- 回合行：每次 run 一行 `narrator_turns`，开始时插入 `running`，结束时更新为 completed / interrupted / failed；步数、工具调用、用量只在内存累积，运行期间写入的信封带 `turn_id`（`narrator-turns.ts`）。回合暂停时长以 `turn_paused_ms:` / `turn_pause_started_ms:` 前缀的 substatus 标签记录（`narrator-turn-timing.ts`）。
- 时间线（只读）：`GET /api/narrators/:id/timeline/turns`（最新在前，`before` 为 startedAt 游标，单页最多 50 回合）与 `GET /:id/timeline?turnId=`（缺省取最新回合）；每个 agent 每回合一条连续泳道，分段数上限 2000，每源行数 2000，泳道 16，每泳道子代理 20，深度 2；工具/模型耗时行走 worker 池，按 `(narrator_id, created_at)` 键集分页；大输入（> 16 KiB）不解析摘要。读权限在路由自带的闸门里检查（`narrator-timeline.ts`、`routes/narrator-timeline.ts`、`shared/narrator-timeline.ts:partitionTimeline`）。
- 导出：`GET /api/narrators/:id/export`（Markdown 或 JSON，可选回合范围）流式分页输出，每页一条带索引的范围查询，字节预算由 SQL 强制；懒分叉的祖先历史用 `resolveLazyLineage` 联合读取，不触发回填写；每处截断都在输出里标注，JSON 以 `"complete": true` 收尾，没有它就是不完整（`narrator-export.ts`、`narrators.ts` 的 `/export`、`/export-turns`）。
- 工具调用详情：`GET /api/narrators/:id/tool-calls/:toolUseId` 经 worker 读快照；引用必须是 ≤128 字符的 ID，选择有歧义 `TOOL_CALL_DETAIL_SELECTION_REQUIRED`（409），超过载荷上限 `TOOL_CALL_DETAIL_TOO_LARGE`（413）；读后重新鉴权并核对仍是当前版本（`narrator-tool-detail.ts`）。面板类读取共用 `narrator-surface-reads.ts` 的预算：最长 30 秒、必须 worker 执行。
- 消息来源：`MessageOrigin` 为 user / system / assistant，`originLabel` 存 `sourceKey` 或 `sourceKey:detail` 的稳定机器标记（如 `autoContinuation`、`forkNarrator`、`agentMessage`），前端渲染时再走 i18n（`shared/message-origin.ts`）。
- 前端：`lib/block-protocol.ts`（`decodeBlockPage` / `decodeBlockMessage` / `decodeBlockFrame`）把块协议 v2 的页和 WS 帧还原成文档行；`lib/api/narrator-timeline.ts` 是时间线客户端。
- 服务端正文长度与来源判定：`lib/narrator-bodies.ts` 判断块存储是否可用并给出读取 SQL，`lib/narrator-body-length.ts:assembledBodyLengthSql` 在 SQL 里度量块格式信封的长度。基准脚本 `server/scripts/benchmark-narrator-history.ts` 对历史查询跑 EXPLAIN 与计时，不是运行时代码。

## 从哪读起
- `server/db/schema.ts`：四张表的列与索引注释。
- `server/services/narrator-refs/port.ts`：引用端口的操作集（append、insertBefore、copyRefs、page）。
- `server/services/narrator-messages.ts:narratorMessageQueries`：全部消息读写入口。
- `server/services/narrator-block-page.ts`：块协议 v2 的页输出。
- 测试：`narrator-block-page.test.ts`、`narrator-messages-history.test.ts`、`narrator-refs/__tests__/seq-store-contract.test.ts`。

## 改它时
- 动历史表的写入：只能经 `narratorStore` / `narratorPersistence`；新增直接写这些表的模块会被 `narrator-history-writers.guard.test.ts` 拦下（要登记为受审计的写入者）。
- 读写 `content_json` 正文：必须走 `narrator-body-reads.ts` / `narrator-body-writes.ts`；`narrator-body-access.guard.test.ts` 与前端 `lib/narrator-body-access.guard.test.ts` 按文件计数访问点：服务端要求登记的计数与现状一致，前端要求计数只降不升。
- 新增块 kind 或改块格式：同改 `shared/narrator-blocks/`、`frontend/lib/block-protocol.ts` 的解码与 `narrator-block-sync.ts` 的同步；`narrator-block-page.test.ts` 覆盖页输出。
- 改 `narrator_*` 表结构：按 CLAUDE.md 先改 `schema.ts` 再生成迁移，并同步 `data-portability.ts` 的 `SNAPSHOT_TABLES` 与导入逻辑。
- 新增列表/导出类读取：必须有字节与行数上限并走 worker，不能在主线程无上限 `.all()`。

## 相关
- [上下文与压缩](context.md)
- [分叉与前缀快照](fork.md)
