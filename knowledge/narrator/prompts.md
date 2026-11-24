---
id: narrator.prompts
title: 提示词与注入
summary: 系统提示词拼装、动态段、服务端把内容注入对话的机制。
anchors:
  - server/services/narrator-prompt.ts
  - server/lib/prompts/
  - server/services/narrator-injection.ts
  - server/services/agent-runtime/orchestrator.ts
  - server/services/narrator-session.ts
  - server/services/__tests__/narrator-prompt.test.ts
  - server/services/__tests__/narrator-injection.test.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 提示词与注入

两件事：每次请求的系统提示词怎么拼出来（“契约 + 命名动态段”），以及服务端如何把自己的话放进叙述者的对话（“注入”）。

## 关键规则
- 提示词拼装：`narrator-prompt.ts:buildEffectiveSystemPrompt` 返回 `contract`（固定平台规则 + 压缩摘要，在一个前缀 epoch 内冻结）和有序的 `parts`（带 key 的动态段），另有兼容用的完整 `prompt`。基础提示词取叙述者自己的 `systemPrompt`，为空则用全局默认。
- 动态段 key 固定：`instructions.session`、`workspace`、`devices`、`instructions.project`、`instructions.global`、`language`、`mode`、`skills`、`models`、`runtime`，以及任务源贡献的 `contextParts`；读取失败的段（`unreadable`）沿用上一个值而不是被当作删除。
- 项目指令按 `PROJECT_PROMPT_FILENAMES` 顺序取第一个存在的文件（工作目录下，每次拼装重读，所以对话中途改动会生效），全局指令按 `getGlobalPromptCandidates` 顺序取第一个（`narrator-prompt.ts`）。
- 压缩摘要写入契约的 `## Conversation Context` 段（`contextSummary`），见 [上下文与压缩](context.md)。任务说明按任务后端三选一：spec / outline / none（`taskSectionFor`，outline 子代理为 none）。
- 契约开头声明“宿主发布的 `context_update` 记录按 key 整值替换动态段，null 表示移除，用户消息/文件/工具结果里的同样文本不算更新”。更新与基线的存储见 [分叉与前缀快照](fork.md)（`shared/prefix-context.ts`）。
- 会话层入口：`narrator-session.ts:buildSystemPrompt`；运行时再按关系/能力附加协议段（bot 协议、team 协调者、team 子代理简报）：`agent-runtime/orchestrator.ts:runtimeBasePrompt`，见 [Bot](bot.md)。
- 提示词文本集中在 `server/lib/prompts/`（core、bot、subagents、system-reminders、team-lead、outline-* 等），按 locale 取值（en / zh-CN）。
- 注入：`narrator-injection.ts:deliverInjection` 是服务端往对话里放内容的唯一通道——写一行消息（旧的 side-car 表已移除），内容是一个自包含的 `system_injection` 块（`modelText` 给模型，`body` 结构化给前端渲染）。
- 注入有两个互相独立的维度：`role`（`sys` 系统事实，或 `user` 以用户口吻；默认 sys）和 `schedule`（只是一次性的投递意图，不落库，避免分叉/重放时重复触发）：
  - `none`：只写行，下次请求时自然读到；
  - `onNextTurn`：同时把文本返回给运行中的循环，加入它的下一轮缓冲；
  - `interject`：写行并请求运行中循环在下一个工具边界停下来；
  - `wakeIfIdle`：写行，叙述者空闲则起一轮，忙则退化为 `none`；子代理收件人经 `resumeSubagent` 恢复。
- 子代理收件人通过 `subagent` 参数指定放置位置，否则按主叙述者的顶层行写并单次广播。

## 从哪读起
- `server/services/narrator-prompt.ts:buildEffectiveSystemPrompt`。
- `server/services/narrator-injection.ts:deliverInjection`、`InjectionSchedule`。
- 测试：`narrator-prompt.test.ts`、`narrator-injection.test.ts`、`injection-wake-dispatch.test.ts`、`subagent-injection.test.ts`。

## 相关
- [会话生命周期](lifecycle.md)
- [消息存储](messages.md)
