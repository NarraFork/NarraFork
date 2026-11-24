---
id: narrator
title: 叙述者（会话）
summary: NarraFork 的核心对象：一个绑定工作目录的 AI 会话。它的生命周期、消息存储、上下文、提示词与提问。
anchors: []
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 叙述者（会话）

叙述者是 NarraFork 的核心对象：`narrators` 表里的一行，绑定工作目录，状态为 idle / working / waiting / archived，类型分主叙述者与子代理；带 `bot` trait 的是 Bot。

各部分如何配合：
- 输入（人、bot 房间、服务端注入、子代理消息）统一经缓冲邮箱进入 `narrator-session`，由它起一轮 agent loop（[生命周期](lifecycle.md)）。
- 每轮的系统提示词由“契约 + 命名动态段”组成，服务端通过注入把内容写成消息行（[提示词与注入](prompts.md)）。
- 消息本体只存一份，叙述者经 `narrator_message_refs` 按 `seq` 引用；块表保存正文细粒度行（[消息存储](messages.md)）。
- 模型看到的是最近压缩点之后的历史加摘要；压缩与占用统计见[上下文与压缩](context.md)；分叉按 full / compressed / fresh 复用或摘要这份历史（[分叉](fork.md)）。
- Agent 向人提问、提交计划需要人的决定（[提问与计划模式](questions-plan.md)）；运行被打断或出错后的善后见[中断与恢复](recovery.md)；Bot 是以聊天房间为界面的特殊叙述者（[Bot](bot.md)）。

## 下面有什么

- [会话生命周期](lifecycle.md)：创建、运行、停止、归档；narrator-service 的拆分（session/executor/subagent/context/prompt/title/recovery/event-handler）。
- [消息存储](messages.md)：narrator_messages / narrator_message_refs / narrator_tool_calls / narrator_blocks 的分工；seq 游标分页；压缩点。
- [上下文与压缩](context.md)：上下文如何组成、压缩如何插入标记、上下文占用统计。
- [提示词与注入](prompts.md)：系统提示词拼装、动态段、服务端把内容注入对话的机制。
- [分叉与前缀快照](fork.md)：full / compressed / fresh 三种继承；前缀快照。
- [提问与计划模式](questions-plan.md)：AskUserQuestion、异步提问、计划模式与审批。
- [中断与恢复](recovery.md)：进程重启、输出中断、子代理恢复。
- [Bot 叙述者](bot.md)：bot trait、聊天房间、Send({ user })、监控视图。
