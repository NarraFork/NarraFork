---
id: narrator.fork
title: 分叉与前缀快照
summary: full / compressed / fresh 三种继承；前缀快照。
anchors:
  - server/lib/agent/tools/fork-narrator.ts
  - server/lib/agent/fork-narrator-depth.ts
  - server/services/narrator-service.ts
  - server/services/narrator-prefix-snapshots.ts
  - server/services/narrator-prefix-snapshot-gc.ts
  - server/services/narrator-prefix-state.ts
  - server/services/narrator-prefix-tool-snapshots.ts
  - shared/prefix-context.ts
  - server/services/narrator-prefix-state.test.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 分叉与前缀快照

分叉出新的独立叙述者，按 `inheritMode` 决定带多少历史；“前缀快照”是把系统提示词各部分、工具定义和上下文更新按内容哈希存储，使分叉与重放共享大体积前缀。

## 关键规则
- 三种继承（`narrator-service.ts:forkNarrator`，默认 `fresh`）：
  - `fresh`：不带历史、不带摘要。
  - `full`：复制父会话的消息引用而不复制消息本体；只取最近压缩点之后、未被分段压缩隐藏、排除未完成压缩的引用，最多 `MAX_INHERITED_FULL_FORK_REFS = 500` 条（超出只保留最近的并记 warn）；继承父的 `contextSummary`；不继承 `apiConversationId`，子会话建立自己的上游会话。
  - `compressed`：用 `narratorContext.generateContextSummary` 生成摘要，追加到子会话 system prompt（"Previous Context Summary"），并插入一条已完成的 compact 标记消息（`[Compressed context from parent conversation]`）。
- 不能从子代理叙述者分叉（抛 `ValidationError`）。分叉出的叙述者的 trait 去掉 named / scheduled / background / bot / team 后重新加上 standalone，保留执行约束与显式受众（`narrator-service.ts:forkTraits`）；bot 的分叉是普通叙述者，见 [Bot](bot.md)。
- 分叉点：`forkMessageId` 或最新消息；`full` 会把仍在流式写入的前缀扩展进去（`extendMutableForkPrefixTx`）。
- 工具 `ForkNarrator`（`mode: fresh | fork`，`inheritMode: full | compressed`，默认 full）经 `forkStandaloneFromTool` 创建：子会话继承到“发起该调用的那一步之前”，因为那一步可能仍在流式追加（`callingToolCallId` → `getMessageIdBeforeToolCallStep`）。`worktreeSource` / `commitSha` 已废弃，传入即报错，文件系统资源改用 CreateWorktree。初始消息以 `origin: "assistant"` 异步发送，不等待。
- 深度上限：祖先数 +1 超过 `FORK_NARRATOR_MAX_DEPTH = 8` 时拒绝（沿 `parent_narrator_id` 走，步数有界，`fork-narrator-depth.ts`），防止模型无人值守地逐层分叉。
- 前缀 = 基线（contract、各命名 part、tools 的哈希）+ 后续 `context_update` 的按 key 替换（值为 null 表示移除）（`shared/prefix-context.ts`:`PrefixSnapshot`、`contextChanges`、`applyContextChanges`）。`narrator-prefix-state.ts` 把历史里的基线与更新合并为当前 `PrefixState`，带进程内缓存；压缩来源边界变化或 `body_revision` 变化会使缓存失效，普通助手正文编辑不会（`narrator-prefix-state.test.ts`）。
- 快照读写（put/get 文本、JSON、工具定义，64 位十六进制哈希）都在 Worker 池里完成，带队列字节上限 64MiB 与结果校验（`narrator-prefix-snapshots.ts`）；GC 分阶段扫描 assets/messages/blocks/manifests 引用并清理未被引用且超过 24 小时宽限期的快照（`narrator-prefix-snapshot-gc.ts:PrefixSnapshotCollector`，`PREFIX_SNAPSHOT_GRACE_MS`）。

## 从哪读起
- `server/services/narrator-service.ts:forkNarrator`、`forkStandaloneFromTool`。
- `server/lib/agent/tools/fork-narrator.ts`：工具入口。
- `server/services/narrator-prefix-state.ts`：前缀状态合并。
- 测试：`fork-lazy-refs.test.ts`、`fork-pending-compact.test.ts`、`narrator-prefix-snapshots*.test.ts`。

## 相关
- [消息存储](messages.md)
- [上下文与压缩](context.md)
- [提示词与注入](prompts.md)
