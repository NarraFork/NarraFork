---
id: narrator.messages
title: 消息存储
summary: narrator_messages / narrator_message_refs / narrator_tool_calls / narrator_blocks 的分工；seq 游标分页；压缩点。
anchors:
  - server/services/narrator-messages.ts
  - server/services/narrator-refs/
  - server/services/narrator-block-*.ts
  - server/services/narrator-body-*.ts
  - server/db/schema.ts
  - server/services/__tests__/narrator-block-page.test.ts
  - server/services/__tests__/narrator-messages-history.test.ts
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

## 从哪读起
- `server/db/schema.ts`：四张表的列与索引注释。
- `server/services/narrator-refs/port.ts`：引用端口的操作集（append、insertBefore、copyRefs、page）。
- `server/services/narrator-messages.ts:narratorMessageQueries`：全部消息读写入口。
- `server/services/narrator-block-page.ts`：块协议 v2 的页输出。
- 测试：`narrator-block-page.test.ts`、`narrator-messages-history.test.ts`、`narrator-refs/__tests__/seq-store-contract.test.ts`。

## 相关
- [上下文与压缩](context.md)
- [分叉与前缀快照](fork.md)
