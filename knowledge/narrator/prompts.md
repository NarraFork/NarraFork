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
  - frontend/hooks/usePromptLibrary.ts
  - server/lib/agent/sender-context.ts
  - server/lib/agent/sender-projection.ts
  - server/lib/global-prompt-paths.ts
  - server/lib/injection-cadence.ts
  - server/lib/instruction-file-cache.ts
  - server/lib/prompt-i18n.ts
  - server/lib/sidecar-templates.ts
  - server/routes/prompt-library.ts
  - server/routes/prompt-optimize.ts
  - server/services/prompt-library.ts
  - shared/native-injection.ts
  - shared/sidecar-body.ts
  - server/lib/message-language-read.ts
  - server/services/narrator-reply-context.ts
  - shared/reply-context.ts
keywords:
  - 系统提示词
  - buildEffectiveSystemPrompt
  - deliverInjection
  - system_injection
  - InjectionSchedule
  - wakeIfIdle
  - onNextTurn
  - interject
  - context_update
  - AGENTS.md
  - AGENTS.override.md
  - 提示词库
  - /api/prompt-library
  - /api/prompt-optimize/draft
  - reply_context
  - replyInUserLanguage
  - 回复语言
  - side-car
  - InjectionCadence
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
  - `wakeIfIdle`：写行，叙述者空闲则起一轮，忙则退化为 `none`。`wakeIfIdle` 经 `narrator-injection.ts:resolveScheduler` 调 `narrator-session.ts:startInjectionContinuationIfPossible`，后者对空闲叙述者 `runAgentLoop(active, "")`；该函数体内未见子代理分支，源码注释所说“子代理改走 `resumeSubagent`”未核实。
- 子代理收件人通过 `subagent` 参数指定放置位置，否则按主叙述者的顶层行写并单次广播。

- 项目指令文件名优先级：`AGENTS.override.md`、`AGENTS.md`、`AGENT.md`、`CLAUDE.md`（`lib/global-prompt-paths.ts:PROJECT_PROMPT_FILENAMES`）；读取走带签名（dev/ino/size/mtime/ctime）的进程内缓存，只缓存指令文件字节，不缓存拼好的提示词（`lib/instruction-file-cache.ts`）。
- 语言段：`replyInUserLanguage` 为真或 locale 不是 `en` 时才追加 `language` 段（`narrator-prompt.ts`）。这两个值来自叙述者持久化的 `narrators.reply_context`（`{ locale, replyInUserLanguage }`）：缺失时由 `ensureReplyContext` 用所有者的 `user_preferences` 补一次（CAS 写入，已有值不被覆盖；没有偏好行时：有所有者则 `replyInUserLanguage: true`，无所有者为 false），只有可信的人类入队才会 `adoptHumanReplyContext` 改写，发送者身份不算证据（`narrator-reply-context.ts`、`shared/reply-context.ts`）。HTTP 发消息时的语言偏好经 `lib/message-language-read.ts` 读，并发 1、排队 4、超时 5 秒，满则 `DbReadTaskOverloadedError`。
- 频率注入：`InjectionCadence` 是“每 N 次完成的工具调用做一次”的闸门，`due()` 即消费；间隔 `> 0` 生效，`-1` 与 `0` 都视为关闭；间隔每次检查时现读，所以会话级覆盖在下个边界生效（`lib/injection-cadence.ts`，`narrator-session.ts` 里的 Dynamic Spec 摘要与行为围栏各用一个实例）。
- 发送者显示名冻结：`collectSenderContext` 记录首次见到的人类显示名（JSON 映射），`projectFrozenSenders` 只改展示用户名，不改来源行、身份、角色和 origin（`lib/agent/sender-context.ts`、`sender-projection.ts`）。
- 注入块的结构：持久化为自包含的原生块，`modelText` 为模型文本、`body` 为结构化展示体，旧行可能带相邻文本块并经 `normalizeLegacyInjectionBlock` 归一（`shared/native-injection.ts`）；`shared/sidecar-body.ts:renderSideCarBodyToText` 决定结构化体怎样拼成文本，文案由 `lib/sidecar-templates.ts:getSideCarModelTemplates(locale)` 提供。
- 提示词库：每条一个 markdown 文件 `~/.narrafork/prompt-library/<id>.md`，正文上限 `MAX_PROMPT_CHARS` = 10000（与 `createNarratorSchema.systemPrompt` 上限对齐）、名称 ≤ 100、描述 ≤ 500；路由 `/api/prompt-library`（列表、`POST /summarize` 无状态摘要、`/:id` 读写删，只要求登录）与 `/api/prompt-optimize/draft`（无会话时的提示词优化）；前端 `usePromptLibrary` 共用查询键 `["prompt-library"]`。

## 从哪读起
- `server/services/narrator-prompt.ts:buildEffectiveSystemPrompt`。
- `server/services/narrator-injection.ts:deliverInjection`、`InjectionSchedule`。
- 测试：`narrator-prompt.test.ts`、`narrator-injection.test.ts`、`injection-wake-dispatch.test.ts`、`subagent-injection.test.ts`。

## 改它时
- 新增动态段：在 `narrator-prompt.ts` 用 `appendPart` 加一个固定 key，并考虑 `unreadable` 时沿用旧值；前缀基线/更新的合并在 `shared/prefix-context.ts`，`narrator-prompt.test.ts` 会检查段序与内容。
- 新增注入类型：经 `deliverInjection`，别直接写消息行；先定 `role` 与 `schedule`，结构化体加到 `shared/sidecar-body.ts` 并补 `lib/sidecar-templates.ts` 各 locale 文案，前端渲染要认这个块；`narrator-injection.test.ts`、`injection-wake-dispatch.test.ts` 覆盖。
- 新增模型提示词文本：放 `server/lib/prompts/` 并经 `prompt-i18n.ts` 取，保证 zh-CN 缺失时回落英文；用户可见文案走 `lib/i18n`，不要混。
- 改项目指令文件名：只在 `PROJECT_PROMPT_FILENAMES`（顺序即优先级）；全局指令的候选路径与 PUT 可写判定在 `getGlobalPromptCandidates` / `isWritableGlobalPromptPath`，两者须一致。

## 相关
- [会话生命周期](lifecycle/index.md)
- [消息存储](messages/index.md)
