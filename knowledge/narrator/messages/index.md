---
id: narrator.messages
title: 消息存储
summary: narrator_messages / narrator_message_refs / narrator_tool_calls / narrator_blocks 的分工；seq 游标分页；压缩点。
anchors:
  - server/services/narrator-messages.ts
  - server/services/narrator-store.ts
  - server/db/schema.ts
keywords:
  - narrator_messages
  - narrator_message_refs
  - narrator_tool_calls
  - narrator_blocks
  - narratorStore
  - 消息存储
status: draft
verified_at: 2e6441ad0
---
# 消息存储

会话消息不按叙述者各存一份，而是“消息实体 + 引用”：消息本体存一次，叙述者通过引用行按序看到它，所以分叉只需复制引用（见 [分叉](../fork.md)）。四张表分工：

- `narrator_messages`：消息本体（`role`、`contentJson`、`parentToolUseId`、`bodyRevision`、`bodyFormat`），也叫“信封”。
- `narrator_message_refs`：叙述者与消息的 junction，`seq` 定序，`isCompact` 标压缩点。
- `narrator_tool_calls`：每次工具调用一行，兼管权限审批状态，没有独立的权限请求表。
- `narrator_blocks`：块格式信封（`body_format=2`）的块行；旧信封（`body_format=1`）整体 JSON 存在 `content_json`。

## 怎么配合
- 写：生产者只经 `narratorStore`（`narrator-store.ts`）写模型可见的历史，每个操作一个事务，转调 `narrator-persistence`；引用的 `seq` 由 `claimNextRefSeq` 分配，块格式信封的块行与 `content_json` 由块同步保持一致。直接写历史表的模块由 `narrator-history-writers.guard.test.ts` 冻结。
- 读：展示页走 worker 的 `readNarratorDisplayMessages`；模型历史按最近压缩点之后加载；正文统一经 `narrator-body-reads.ts`，不要直接读 `content_json`。
- 工具调用行通过 `messageId`/`blockId` 与信封、块关联，详情接口另读。
- 压缩点：`isCompact=1` 的最大 `seq`，后续上下文只从该点之后加载，见 [上下文与压缩](../context.md)。

## 读哪个子节点
- `seq` 怎么分配、游标分页、压缩点、展示页读取、消息数、回合行、时间线、导出、消息来源 → [消息与引用](refs-paging.md)。
- 块 kind/phase、`body_format`、块同步队列、回填任务、`body-reads/writes`、块协议 v2 页输出 → [块存储](blocks.md)。
- `narrator_tool_calls` 各列、状态、耗时与成本、详情接口的限制 → [工具调用记录](tool-calls.md)。

## 改它时
- 动历史表的写入：只能经 `narratorStore` / `narratorPersistence`，新增直接写这些表的模块会被 `narrator-history-writers.guard.test.ts` 拦下（要登记为受审计的写入者）。
- 改 `narrator_*` 表结构：按 CLAUDE.md 先改 `schema.ts` 再生成迁移，并同步 `data-portability.ts` 的 `SNAPSHOT_TABLES` 与导入逻辑。
- 新增列表/导出类读取：必须有字节与行数上限并走 worker，不能在主线程无上限 `.all()`。
- 各子节点有各自的守卫测试，见它们的「改它时」。

## 相关
- [上下文与压缩](../context.md)
- [分叉与前缀快照](../fork.md)

## 下面有什么

- [消息与引用](refs-paging.md)：narrator_messages 与 narrator_message_refs：seq 分配、游标分页、压缩点、时间线。
- [块存储](blocks.md)：narrator_blocks 块信封、块同步队列与回填。
- [工具调用记录](tool-calls.md)：narrator_tool_calls 行：输入输出、执行与审批状态字段、耗时与成本。
