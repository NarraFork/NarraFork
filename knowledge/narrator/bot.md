---
id: narrator.bot
title: Bot 叙述者
summary: bot trait、聊天房间、Send({ user })、监控视图。
anchors:
  - server/services/bot-chat.ts
  - server/services/chat-service.ts
  - server/lib/agent/tools/send.ts
  - server/lib/prompts/bot.ts
  - server/services/agent-runtime/policy.ts
  - server/services/__tests__/bot-chat.test.ts
keywords:
  - bot trait
  - BOT_TRAIT
  - BOT_RUNTIME_CEILING
  - admitBotPost
  - sendAsBot
  - postBotMessage
  - bot:<narratorId>:<userId>
  - /api/chat/rooms/bot/:narratorId
  - CHAT_BOT_MESSAGE_MAX_CHARS
  - 监控视图
  - 聊天房间
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# Bot 叙述者

Bot 是带 `bot` trait 的叙述者：人们在聊天房间里和它对话，只能看到它用 `Send({ user })` 发出的内容；它自己的回复、思考、工具调用只留在会话记录里（即“监控视图”）。

## 关键规则
- 创建：`kind: "bot"` 必须带 `title`（它在房间里的名字），创建时写入 `BOT_TRAIT` 和一个运行时上限（`narrator-service.ts:createNarrator` 中 `input.kind === "bot"` 分支）；trait 创建后不再切换（`server/lib/narrator-utils.ts:isBotNarrator`）。
- 上限 `BOT_RUNTIME_CEILING` 拒绝 `askUserQuestion` 与 `planApproval`：没人读 bot 的记录，不能让它停在提问或计划审批上（`agent-runtime/policy.ts`）；bot 创建时也不进入计划模式。
- 分叉出来的是普通叙述者，不带 bot trait，人的对话留在原 bot 上（`narrator-service.ts:forkTraits`）。
- 房间：每个“bot + 人”一个私有房间，键为 `bot:<narratorId>:<userId>`（`chat-service.ts:buildBotRoomKey`、`resolveBotRoom`）；只有对话中的那个人能读；发帖需要有“驱动该 bot”的权限，收窄权限后历史仍可读（测试 `bot room access`）。
- 入站：人在房间发帖先交给 `admitBotPost`，成功入队后才记录帖子；bot 队列满等失败直接回给发帖人。走与 composer 相同的 `acceptUserMessage`，归档的 bot 会先恢复为 idle；`executionIntent.literal` 使“/new …”不被当作命令（`bot-chat.ts:admitBotPost`）。附件整体复制进 bot 工作目录，任一失败则整帖拒绝。
- 出站：`Send` 带非空 `user` 即走 bot 路径，不能与 agent 目标、resume/model、doInterrupt 混用（`lib/agent/tools/send.ts:sendToUser`）；真正的 bot 校验在 `bot-chat.ts:sendAsBot`（再读一次 trait，非 bot 抛 ValidationError）。收件人先精确匹配用户名，再唯一的大小写不敏感匹配，容许前导 `@`。
- 消息长度上限 `CHAT_BOT_MESSAGE_MAX_CHARS = 32_000`（`chat-service.ts`）。
- 权限：带 `user` 的 Send 对 bot 永远免审批，对非 bot 不放行（`narrator-permission.ts` 中 `input.user !== undefined` 分支）。
- 提示词：bot 的 system prompt 后追加 bot 模式协议（协调者角色、先 Send、耗时工作交子代理）（`agent-runtime/orchestrator.ts:runtimeBasePrompt`、`lib/prompts/bot.ts:getBotModePrompt`）。

## 从哪读起
- `server/services/bot-chat.ts`：入站 `admitBotPost` 与出站 `sendAsBot`。
- `server/services/chat-service.ts:postBotMessage`：写入房间。
- `server/services/__tests__/bot-chat.test.ts`：房间解析、访问、Send 行为的测试。

## 改它时
- 房间路由 `GET /api/chat/rooms/bot/:narratorId`（`server/routes/chat.ts`）按调用者首次打开时创建房间；改房间键格式必须同步 `buildBotRoomKey` / `resolveBotRoom` 和前端用到该键的地方。
- 新增会让 bot 停下等人的能力（提问、审批类工具）：在 `agent-runtime/policy.ts` 的 `BOT_RUNTIME_CEILING` 里拒绝，否则会话会卡在没人读的记录里；`bot-chat.test.ts` 覆盖房间与 Send。
- 新增创建/分叉路径：bot trait 创建后不可切换，分叉不继承（`forkTraits`）；别在新路径里补写 `BOT_TRAIT`。
- 改 Send 的 `user` 参数语义：`send.ts:sendToUser` 的互斥检查、`sendAsBot` 的二次 trait 校验和 `narrator-permission.ts` 的免审批分支要一起看。

## 相关
- [提问与计划模式](questions-plan.md)
- [提示词与注入](prompts.md)
