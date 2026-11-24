---
id: narrator.messages.refs-paging
title: 消息与引用
summary: narrator_messages 与 narrator_message_refs：seq 分配、游标分页、压缩点、时间线。
anchors:
  - server/services/narrator-refs/
  - server/services/narrator-persistence.ts
  - server/services/narrator-display-page-reader.ts
  - server/services/narrator-message-count.ts
  - server/services/narrator-turns.ts
  - server/services/narrator-turn-timing.ts
  - server/services/narrator-timeline.ts
  - server/services/narrator-export.ts
  - server/routes/narrator-timeline.ts
  - server/lib/validators/narrator-timeline.ts
  - server/scripts/benchmark-narrator-history.ts
  - server/services/__tests__/narrator-messages-history.test.ts
  - frontend/lib/api/narrator-timeline.ts
  - shared/export-turn-range.ts
  - shared/message-origin.ts
  - shared/narrator-timeline.ts
keywords:
  - narrator_turns
  - PRETEXT_DOCUMENT_CHANGED
  - DISPLAY_PAGE_READER_UNAVAILABLE
  - DISPLAY_PAGE_READER_BUSY
  - DISPLAY_PAGE_LIMITS
  - /api/narrators/:id/export
  - /api/narrators/:id/export-turns
  - /api/narrators/:id/timeline
  - /api/narrators/:id/timeline/turns
  - 会话导出
  - 时间线
  - 消息数
  - originLabel
  - MessageOrigin
  - beforeSeq
  - afterSeq
  - segmentCompactId
  - injectionConsumedAt
  - claimNextRefSeq
  - dbTransactionWithSeqFloor
  - narrators.nextSeq
  - getNarratorMessageRefsPort
  - admittedMutation
  - partitionTimeline
  - resolveLazyLineage
status: draft
verified_at: 776dbf07e
---
# 消息与引用

`narrator_messages`（消息本体）与 `narrator_message_refs`（叙述者按序引用）的读写规则：`seq` 分配、游标分页、压缩点，以及建立在它们上面的回合行、时间线、导出和消息数。

## 关键规则
- `narrator_messages`：`role` 为 user/assistant/system/sys/disp；`contentJson` 存 content blocks，`parentToolUseId` 把子代理消息挂到工具调用下，`bodyRevision` 在模型可见内容变化时事务内递增；`bodyFormat` 为 1（旧式整体 JSON）或 2（块格式，见[块存储](blocks.md)）（`server/db/schema.ts:narratorMessages`）。
- `narrator_message_refs`：叙述者与消息的 junction，`(narratorId, messageId)` 唯一，`seq` 定序，`isCompact=1` 标记压缩点，`segmentCompactId` 指向隐藏该引用的分段压缩摘要，`injectionConsumedAt` 记录注入何时被收件循环采纳。
- `seq` 由 `narrators.nextSeq` 单调分配：`narrator-refs/seq-store.ts:claimNextRefSeq` 自增并返回旧值；写事务应经 `seq-floor-tx.ts:dbTransactionWithSeqFloor`，先把计数抬到不低于现有最高 seq，且只在事务提交后才把叙述者标记为已修复（回滚不会留下假标记）。
- 分页以 `refs.seq` 为游标：默认取尾页，`beforeSeq` 取更旧一页，`afterSeq` 升序取更新部分；查 `limit+1` 判断是否还有更多，单页上限 100（`narrator-messages.ts:getPretextDocumentPage`）。已被分段压缩隐藏的引用（`segmentCompactId` 非空）不进入页。页组装期间文档版本变化会抛 `PRETEXT_DOCUMENT_CHANGED`（409）。
- 压缩点：查询“最近 compact”用 `isCompact = 1` 的最大 seq（`narrator-messages.ts` 内 `lastCompactRow` 系列查询）；后续上下文只从该点之后加载，见 [上下文与压缩](../context.md)。
- 变更类方法（删除消息/块、更新压缩摘要、dismiss 各类提示）在 `narratorMessageQueries` 中统一包了 `admittedMutation`（`narrator-messages.ts` 末尾）。
- 引用存储有 SQLite 与 PostgreSQL 两种实现：`narrator-refs/store.ts:getNarratorMessageRefsPort` 在绑定了 PG 端口时返回它，否则为 `undefined` 走 SQLite 路径（`assertSqliteNarratorOperation` 在 PG 下拒绝仅 SQLite 的操作）。
- 写入层：生产者经 `narrator-store.ts:narratorStore`（`appendInput`、`appendNotice`、`openStep`、`writeStepItem`、`appendStep`、`settleTool`、`patchState` 等）写模型可见的历史，每个操作一个事务；它转调 `narrator-persistence.ts:narratorPersistence`（实现所在，体量很大）。
- 展示页读取：`narrator-display-page-reader.ts:readNarratorDisplayMessages` 只走 worker（SQLite 路径或 PG 端口），不可用时报 `DISPLAY_PAGE_READER_UNAVAILABLE`（503，“不允许主线程原始 JSON 回退”），并发 2、排队上限 32，满则 `DISPLAY_PAGE_READER_BUSY`（503）；单次最多 10000 行、原始 16 MiB、输出 4 MiB、10 秒（`DISPLAY_PAGE_LIMITS`，`lib/db-worker/display-page-protocol.ts`）。
- 消息数：展示的数字都现算——详情数单个叙述者的引用数，列表只数当前页的 id（一条分组查询）；`narrators.message_count` 只是只增不减的上界，仅供 `sortBy=messageCount` 排序，不回填（`narrator-message-count.ts`）。
- 回合行：每次 run 一行 `narrator_turns`，开始时插入 `running`，结束时更新为 completed / interrupted / failed；步数、工具调用、用量只在内存累积，运行期间写入的信封带 `turn_id`（`narrator-turns.ts`）。回合暂停时长以 `turn_paused_ms:` / `turn_pause_started_ms:` 前缀的 substatus 标签记录（`narrator-turn-timing.ts`）。
- 时间线（只读）：`GET /api/narrators/:id/timeline/turns`（最新在前，`before` 为 startedAt 游标，单页最多 50 回合）与 `GET /:id/timeline?turnId=`（缺省取最新回合）；每个 agent 每回合一条连续泳道，分段数上限 2000，每源行数 2000，泳道 16，每泳道子代理 20，深度 2；工具/模型耗时行走 worker 池，按 `(narrator_id, created_at)` 键集分页；大输入（> 16 KiB）不解析摘要。读权限在路由自带的闸门里检查（`narrator-timeline.ts`、`routes/narrator-timeline.ts`、`shared/narrator-timeline.ts:partitionTimeline`）。
- 导出：`GET /api/narrators/:id/export`（Markdown 或 JSON，可选回合范围）流式分页输出，每页一条带索引的范围查询，字节预算由 SQL 强制；懒分叉的祖先历史用 `resolveLazyLineage` 联合读取，不触发回填写；每处截断都在输出里标注，JSON 以 `"complete": true` 收尾，没有它就是不完整（`narrator-export.ts`、`narrators.ts` 的 `/export`、`/export-turns`）。
- 消息来源：`MessageOrigin` 为 user / system / assistant，`originLabel` 存 `sourceKey` 或 `sourceKey:detail` 的稳定机器标记（如 `autoContinuation`、`forkNarrator`、`agentMessage`），前端渲染时再走 i18n（`shared/message-origin.ts`）。
- 基准脚本 `server/scripts/benchmark-narrator-history.ts` 对历史查询跑 EXPLAIN 与计时，不是运行时代码。

## 从哪读起
- `server/services/narrator-refs/port.ts`：引用端口的操作集（append、insertBefore、copyRefs、page）。
- `server/services/narrator-messages.ts:narratorMessageQueries`：全部消息读写入口。
- 前端：`lib/api/narrator-timeline.ts` 是时间线客户端。
- 测试：`narrator-messages-history.test.ts`、`narrator-refs/__tests__/seq-store-contract.test.ts`、`store-selection.test.ts`、`narrator-timeline.test.ts`、`narrator-export.test.ts`。

## 改它时
- 动历史表的写入：只能经 `narratorStore` / `narratorPersistence`；新增直接写这些表的模块会被 `narrator-history-writers.guard.test.ts` 拦下（要登记为受审计的写入者）。
- 新增引用写入路径：必须在 `dbTransactionWithSeqFloor` 内并经 `claimNextRefSeq` 分配 seq；`seq-store-contract.test.ts` 约束 SQLite 与 PG 实现行为一致，`store-selection.test.ts` 覆盖端口选择。
- 新增变更类方法：包 `admittedMutation`。
- 改分页或压缩点查询：`narrator-messages-history.test.ts` 覆盖；保持 `limit+1` 判断，不要先 `COUNT(*)`。
- 新增列表/导出/时间线类读取：必须有字节与行数上限并走 worker；展示页读取不得回退主线程（`DISPLAY_PAGE_READER_UNAVAILABLE`）。
- 加新的消息来源标记：只存机器标记，文案放前端 i18n。

## 相关
- [消息存储](index.md)
- [上下文与压缩](../context.md)
- [分叉与前缀快照](../fork.md)
