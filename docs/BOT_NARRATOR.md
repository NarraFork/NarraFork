# Bot 模式叙述者

> Bot 是一个**面向聊天房间而不是面向会话记录**的叙述者：人们在聊天界面里和它对话，只看到自己的发言和它用 `Send({ user })` 发来的消息；它的回复、思考和工具调用留在会话记录里，那是“监控”视图。
>
> 核心实现：`server/services/bot-chat.ts`（桥）、`server/services/chat-service.ts`（`bot` 房间）、`server/lib/agent/tools/send.ts`（`user` 目标）。

---

## 1. 两个正交的东西

| | 是什么 | 存在哪 |
|---|---|---|
| **Bot 身份** | 叙述者的永久 trait `bot`（`BOT_TRAIT`），创建时通过 `kind: "bot"` 打上，之后不切换 | `narrators.traits` |
| **对话** | 每个人与这个 bot 的一间 `bot` 房间，按人的 **id** 存（改名不分叉） | `chat_rooms`（`kind = "bot"`，`narrator_id` = bot，`dm_key = bot:<narratorId>:<userId>`）+ `chat_messages` |

监控（`/narrators/$id?view=monitor`）只是同一个叙述者的另一种视图，放在 URL 里，**不改变任何状态**：bot 不会因为被监控而变成普通叙述者。指向会话记录某条消息的深链接（`scrollTo` / `#msg-`）也直接进监控。从对话打开的监控是向前一步，返回就是后退一步（历史状态 `botMonitorFromChat`），来回切换不会堆积历史记录。

对话页头部是人唯一能看到 bot 工作状态的地方（`bot-activity.ts`，由 status + substatus 推出）：思考中、等待处理（只有能驱动 bot 的人会被提示去监控里处理）、等待模型恢复、运行出错。对话页本身就是 bot 的回复，所以阅读对话也会清掉 bot 的 `unread`，和打开监控一样。

## 2. 两个方向

```
人 ── 发帖 ──▶ bot 房间 ── admitBotPost ──▶ bot 的下一条输入
人 ◀────────── bot 房间 ◀── sendAsBot ◀──── bot 调用 Send({ user })
```

- **入站**：在 bot 房间发言就是在 bot 的输入框里打字。`chat-service.postMessage` 先把发言交给 `bot-chat.admitBotPost`，**bot 接下了才记录**：走与 bot 输入框相同的 `acceptUserMessage`（忙时排队、空闲时开轮）；bot 接不下（队列满、文件复制失败、bot 没有工作目录却带了附件）时这次发言整体被拒，房间里什么都不记，内容和附件草稿仍留在发言人的输入框里可以重发——和输入框的报错一致，而不是房间显示了一条 bot 从没收到的消息。同一个 bot 的发言串行（`AsyncMutex`），接收顺序就是房间的 seq 顺序。作者是发言人，所以模型从普通的 `<sender kind="human" id="…" name="…">` 标记读出是谁在说话；回复以 `> 引文` 前置，附件复制进 bot 工作目录 `.narrafork/attached/` 并附 `<attached_files>` 提示（与讨论房间转发同一布局；被拒时复制品会删掉）。聊天文字按原文投递（`executionIntent.literal`）：`/new …`、`/goal …` 只是一句话，不会被当成会话命令。bot 自己的消息永远不会回投给它。
- **出站**：`Send({ user, message })` 只对 bot 提供（`AgentConfig.bot` 决定 schema；`sendAsBot` 重新读取 trait 作为权威检查）。按用户名解析（精确匹配优先，其次大小写不敏感的唯一匹配，忽略前导 `@`），写入 `postBotMessage`：`sender_narrator_id` 记作者，`sender_user_id` 为空。**只能发给能打开这个 bot 的人**（与 `resolveBotRoom` 同一门槛）：否则收件人收到一条来自任意名字、既查不到来源也无法回复的消息。权限层对 bot 的 `Send({ user })` 自动放行（`shouldAutoAllowSendWithinScope`）——那是它唯一的声音。
- **不等没人看得见的人**：没人读 bot 的会话记录，所以创建时给它存一层运行时上限（`BOT_RUNTIME_CEILING`，与委派模板同一机制）：禁用 AskUserQuestion 与计划审批，也不会以计划模式启动。需要问人时用 Send 发问，回答作为对方下一条消息到达。同理，bot 在一轮工具调用（通常就是 Send）之后不再输出任何文字，是正常收尾：Agent Loop 把这种“已服务但无内容”的回复当作 `done`，而不是上游空响应错误（拒答、截断等仍照常报错）。普通叙述者在一轮包含 Agent、后台 Bash 或 Send 的工具调用之后也一样——后续结果会作为新的输入到达，此刻无话可说是正常的。工具权限审批仍会发生，头部会提示能驱动 bot 的人去监控里处理。
- **提示词**：`runtimeBasePrompt` 在 bot 自身的 system prompt（人设）之后追加 bot 协议段（`server/lib/prompts/bot.ts`）：对方只看得到 Send 的内容、按发送者标记回复谁、每条来自人的消息都要回复、提问也走 Send、多人对话互相隔离（除非作者本人要求转达）。
- **主循环只做协调**：bot 的主循环同时服务房间里所有人，它一忙谁都等不到回复。所以协议要求它先用一两句话回复、再把耗时工作（搜代码、长命令、改文件、构建测试、网络调研）交给子代理；子代理回报后由 bot 整理成简短结论再 Send 给提问的人。同一个任务的后续追问用 `Send({ id: <别名> })` 交给原来的子代理（保留上下文），只有新任务才新开。代码侧兜底：bot 的 `Agent` 调用一律后台运行（`ToolContext.bot`，见 `tools/task.ts`），模型即便要求前台也不会卡住主循环，结果作为下一条输入到达。
- **引用**：原生搜索（Codex/Responses）的 `\ue200cite\ue202turn0search0\ue201` 标记只有出现在 assistant 文本里才能借 annotations 还原成链接，写进 Send 参数里的标记没有 URL 可还原。所以照 Codex `web.run` 工具描述的做法，提示词要求 bot 用 `[标题](URL)` 引用、不写内部引用 ID；`sendToUser` 落盘前再用 `cleanAssistantText` 兜底剥掉漏网标记。

**输入框**：bot 对话页的输入框就是叙述者的 `NarratorComposer`（`BotChatComposer`）：内联图片/文件、`#file` 引用 bot 工作目录、@提及、输入历史、提示词优化、全屏编辑、拖放上传都与叙述者一致。发送时文件先上传为聊天附件，再作为普通帖子发出，入站路径不变。两处有意不同：草稿只存本机（按房间，`draft.sessionId` 指向 bot，不会覆盖 bot 监控页输入框的服务端草稿）；不显示斜杠命令菜单，因为聊天文字按原文投递。

## 3. 访问控制

| 操作 | 条件 |
|---|---|
| 打开房间（`GET /api/chat/rooms/bot/:narratorId`） | 能**读** bot（与 bot 页面同一门槛）；返回 `canPost` |
| 读房间 | 房间成员（与 DM 相同：bot 发给你的话归你读） |
| 发言、上传附件草稿 | 成员 **且** 能**写**（驱动）bot——发言就是 bot 的下一条输入；每次发言都重新检查，所以收窄权限立即生效，历史仍可读 |
| bot 写入 | 只有 bot 叙述者；收件人必须能**读** bot |

注意：共享给多人的 bot 只有**一个**上下文。能读 bot 的人可以打开监控看到所有人的对话——这是“共享 bot”本身的语义，提示词只约束 bot 不主动转述。同理，在房间里删除一条已投递的发言只会从房间撤下，bot 已经收到的输入不会被撤回（会话记录里仍在）。

**Fork**：fork 出来的是普通叙述者（去掉 `bot` trait；bot 由创建决定：必须有名字、独立，人们的对话房间留在原 bot）。运行时上限和其他上限一样随 fork 保留——fork 从不放宽上限。

## 4. 复用的东西

bot 房间是普通聊天房间，所以分页、实时帧、未读角标（计入导航 `dmTotal`，见 `shared/chat-room-kinds.ts` 的 `isConversationRoomKind`）、通知中心、附件、引用回复、消息列表渲染（bot 作者显示叙述者头像）全部沿用，`/messages` 也会列出 bot 对话（不能再驱动的 bot 显示为只读）。

## 5. 往群聊扩展

群聊（多 bot、多人）不需要改变上面的形状：

- 新房间种类（如 `group`），成员里加入 bot；`isConversationRoomKind` 加上它。
- 入站规则不变：**发帖投递给房间里除作者外的每个 bot**（目前 bot 房间只有一个 bot：`narrator_id`）。但“bot 接下了才记录”只适用于一个收件 bot：一条帖子要送达多个 bot 时，某个 bot 队列满不应拒掉整条帖子。届时改为每个 bot 成员一个投递水位（相当于 bot 的已读 seq），先记录、再按 seq 投递，失败的下次再投。
- 出站规则不变：`Send` 增加 `room` 目标；作者仍记在 `sender_narrator_id`，引用作者在 `reply_to_sender_narrator_id`。
- bot 之间互相投递时需要防循环（例如只投递 @ 到自己的消息），这是群聊阶段要定的规则。

## 6. 文件地图

| 文件 | 职责 |
|---|---|
| `server/db/schema.ts` | `chat_rooms.kind` 加 `bot`；叙述者讨论房间唯一索引改为部分索引；`chat_messages.sender_narrator_id` / `reply_to_sender_narrator_id` |
| `server/services/chat-service.ts` | `resolveBotRoom`、`postBotMessage`、bot 作者快照、对话列表与角标 |
| `server/services/bot-chat.ts` | 入站 `admitBotPost`、`sendAsBot` |
| `server/lib/agent/tools/send.ts` | `user` 目标 |
| `server/lib/prompts/bot.ts` | bot 协议提示词 |
| `server/services/narrator-service.ts` | `kind: "bot"`（必须独立、必须有名字、不以计划模式启动、存运行时上限）；fork 去掉 `bot` |
| `server/services/agent-runtime/policy.ts` | `BOT_RUNTIME_CEILING` |
| `frontend/components/chat/BotChatPage.tsx` | bot 页面：头部（状态、监控）+ `ChatRoomView` |
| `frontend/components/chat/BotChatComposer.tsx` | bot 对话的输入框：`NarratorComposer`（本地草稿、无斜杠菜单）→ 上传聊天附件 → 发帖 |
| `server/lib/agent/tools/task.ts` | bot 的 `Agent` 调用强制后台 |
| `frontend/components/chat/bot-activity.ts` | 头部状态文案的判定 |
| `frontend/routes/narrators/$narratorId.tsx` | bot 默认显示对话，`?view=monitor` 显示会话记录 |
