---
id: narrator
title: 叙述者（会话）
summary: NarraFork 的核心对象：一个绑定工作目录的 AI 会话。它的生命周期、消息存储、上下文、提示词与提问。
anchors: []
status: stub
verified_at: null
---
# 叙述者（会话）

> 待填写：NarraFork 的核心对象：一个绑定工作目录的 AI 会话。它的生命周期、消息存储、上下文、提示词与提问。

## 下面有什么

- [会话生命周期](lifecycle.md)：创建、运行、停止、归档；narrator-service 的拆分（session/executor/subagent/context/prompt/title/recovery/event-handler）。
- [消息存储](messages.md)：narrator_messages / narrator_message_refs / narrator_tool_calls / narrator_blocks 的分工；seq 游标分页；压缩点。
- [上下文与压缩](context.md)：上下文如何组成、压缩如何插入标记、上下文占用统计。
- [提示词与注入](prompts.md)：系统提示词拼装、动态段、服务端把内容注入对话的机制。
- [分叉与前缀快照](fork.md)：full / compressed / fresh 三种继承；前缀快照。
- [提问与计划模式](questions-plan.md)：AskUserQuestion、异步提问、计划模式与审批。
- [中断与恢复](recovery.md)：进程重启、输出中断、子代理恢复。
- [Bot 叙述者](bot.md)：bot trait、聊天房间、Send({ user })、监控视图。
