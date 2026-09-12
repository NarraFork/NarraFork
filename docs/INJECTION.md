# Injection 机制解析

> 服务端把自己的话放进叙述者对话的唯一通道。本文档梳理截至当前代码状态的全部使用点。
>
> 核心实现：`server/services/narrator-injection.ts`

---

## 1. 这个机制解决什么问题

注入内容历史上走两条互不相干的路：

1. **side-car**（`narrator_sidecars` 表）—— 一行挂在**别人**的消息上的记录，在 API 调用时由七份 `buildHistory` 各自的手写状态机重新拼进 `tool_result` 输出或下一个 user turn。
2. **消息行**（`persistSystemMessage`）—— 一条普通 `role: "sys"` 行，每个 provider 本来就知道怎么回放。

路 1 解决的问题路 2 也能解决。NarraFork 每次请求都发送**完整历史**（`store: false`，见 `openai-provider.ts` 的注释），所以模型收到什么是消息行的纯函数——同样字节的 side-car 和 `sys` 行在线上是一样的，side-car 只是为此额外付出了一张表、一个 `body_json` 列、七份 flush 状态机和一层 `<side_car>` 包装。

**路 1 已完全移除**（表、列、状态机、包装全部删除）。下文描述的是唯一剩下的路。

---

## 2. 两个正交的轴

旧设计把这两件事混在一起：`role` 既决定协议角色，又（通过每个 provider 的"末尾 user 行就是当前 turn"规则）决定这行会不会被当成需要回答的东西。这正是"注入但不排 turn"没有干净写法的原因，也是 side-car 被发明出来绕开 `role` 的原因。

### 2.1 `role` —— 这内容**是**什么

| 值 | 语义 | provider 映射 |
|---|---|---|
| `sys`（默认） | 系统事实（容器起来了、任务完成了） | Anthropic 官方 API 上是**真正的**对话中 `system` 消息；其他 provider 映射成 `user` |
| `user` | 代表用户说话 | 权重更高，而且理应如此 |

`user` 的存在有具体理由：`taskReflection` 读父历史，只有当请求以 user turn 形式到达时，它才能识别出这是用户真正要求的任务。这是 `spec-edit-interject.ts` 存在的全部原因。

### 2.2 `schedule` —— 因此**应该发生**什么

| 值 | 行为 | 典型用途 |
|---|---|---|
| `none`（默认） | 只写行，别的什么都不改。下次请求碰巧读到就读到，可能几秒后、也可能永远不会 | 容器就绪、评审反馈、合并摘要、浏览器会话丢失 |
| `onNextTurn` | 写行**并且**把内容送进**正在运行**的 loop 的下一个 turn | loop 只在 pass 开始时重建内存历史，turn 中途写的行在下一 pass 前是不可见的 |
| `interject` | 写行并请求运行中的 loop 在下一个工具边界停下，让内容被及时取用 | 内容改变了叙述者**该做什么**（计划编辑），而不只是它知道什么 |
| `wakeIfIdle` | 写行，如果叙述者空闲就起一个 turn；忙时退化为 `none` | 行已就位，运行中的 loop 下一 pass 会取到 |

**`wakeIfIdle` 对子代理走 `resumeSubagent`，不是 `runAgentLoop`。** 分派在 `startInjectionContinuationIfPossible` 里（`narrator-session.ts`），调用方不需要选。理由是 `runAgentLoop` 跑子代理不只是「另一条路」，它绕过了让子代理运行合法的全部东西：resume 锁、origin tool_use id 解析、以及把结果写回父叙述者那个仍然打开的 Agent 工具调用的结论发布——这正是 `sendMessage`/`continueNarrator`/`retryLastMessage` 一律拒绝子代理并要求走 `resumeSubagent` 的原因。用的 intent 是 `continue_tool_results`（「内容已在历史里」），而不是 `follow_up`（后者要求 prompt，会再写一行「continue」，把注入行挤出 history builder 会提起的尾部位置）。

这个分派**修的是既有隐患**，不是新增能力：`async_question` 早就在目标空闲时用 `wakeIfIdle`，而该入口原先没有 `isSubagentVariant` 守卫。失败模式是静默的——不会抛错，只会产生一个结果永远到不了父工具调用的 turn。

**`onNextTurn` 不是双份投递**：当前 pass 读内存副本，之后的 pass 读那一行，两者永不作用于同一个请求。调用方拿到 `turnText` 追加进 loop 的 next-turn 缓冲；**无条件追加会导致重复投递**。

### 2.3 为什么 `schedule` 是参数而不是列

它在投递这个动作里被消费掉了。持久化它会让 fork 或历史回放**重新触发几个月前就已发生的唤醒**。行是永久的，意图不是。

> 遗留：这没有动 provider 的"末尾 `user` 行即当前 turn"规则——`buildHistory` 仍从行的形状推断调度。去掉这层推断需要一个持久化标记，刻意留在范围外。

---

## 3. 数据形状：一行两个投影

注入行的 `contentJson` 是 `[{ type: "text", text }, injectionBlock, ...extraBlocks]`：

| block | 给谁看 | 内容 |
|---|---|---|
| `text` | **模型** | 模型向文案原样保留，指令 boilerplate 全在里面（"tasks.json 只保留 text/status/protected"、"不要添加 ID"） |
| `system_injection` | **读者** | 刻意携带**结构化 body**（`SideCarBody`），而非预先措辞好的文本 |

这个拆分是承重的。provider 只投影 text block，所以第一块必须是模型向原文。

### 3.1 为什么 block 存 `body` 而不是 Markdown

读者向措辞活在**前端**的消息表里（各 locale 的 `narrator.json` 中 `sidecar.body.*`，22 个键），通过 `ctx.labels` 取用；服务端的 `sidecar.*` 表只有模型向文案。在写入时投影意味着把 ~22 个读者向字符串复制进服务端，并且**把它们冻结在写入时刻**——以后修翻译永远到不了已存在的行。

`sideCarBodyToMarkdown` 因此跑在 UI。两个投影不会漂移，因为都从同一份载荷派生，而载荷只在一处写入。

### 3.2 `SideCarBody` 的 7 种 kind

| kind | 载荷 | 读者看到的 |
|---|---|---|
| `notice` | `params?` | 一句话提醒，全在标题里，没有正文可展开 |
| `prose` | `text` | 行为围栏用固定标题；其他散文用自己第一行做标题 |
| `tasks` | `variant` + `tasks[]` | `### 3 条开放任务` + Markdown 列表，`protected` 标注 |
| `knowledge` | `hits[]` | `### N 条知识库条目` + 每条一个 bullet（标题 — 摘要） |
| `tasksDone` | `flavor` + `items[]` | 每个任务一个 `####` 子标题 + 输出预览 + 截断说明 |
| `messages` | `items[]` | 单条时发送者名做标题；多条时计数标题 + 每人子标题 |
| `specUpdates` | `items[]` | 单文件时 uri 做标题，摘要做正文 |

投影**有界**：`SIDECAR_PROJECTION_MAX_LINES = 200`，且预算**跨 item 共享**（不是每 item 各自封顶，否则总量仍随 N 增长）。原因是测量层要等投影постро完数组后才能决定截断，无界投影会把一条病态记录变成每次测量 pass 的全长开销。

### 3.3 无结构化 body 的行

走 `rawSideCarToMarkdown`：原文照搬，**刻意不做任何解析**——不拆 XML 包装、不剥 `[System]` 前缀、不做 bullet 检测。像 `<side_car source="…">` 这类标记会被套进代码围栏，作为可见字符显示，而不是被 Markdown 渲染器当 HTML 标签吃掉。猜测生产者丢弃的结构是这套设计移除的复杂度。

---

## 4. API

```ts
// server/services/narrator-injection.ts

deliverInjection(narratorId, {
  content: string,              // 模型向文本，原样存为首个 text block
  source: string,               // 生产者标签
  body?: SideCarBody,           // 结构化载荷，为读者投影成 Markdown
  role?: "sys" | "user",        // 默认 sys
  schedule?: InjectionSchedule, // 默认 none
  locale?: Locale,
  originSource?: MessageOriginSource,  // 归属标签（review、autoContinuation…）
  originDetail?: string | null,
  createdBy?: string | null,
  subagent?: {                  // 接收者是子代理时必须给（见 4.2）
    parentToolUseId: string,
    parentNarratorId: string,
  },
  extraBlocks?: any[],          // 已有富卡片的生产者保留其 UI
}): Promise<{
  messageId: string | null,     // 没写行时为 null
  turnText: string | null,      // 仅 onNextTurn 非 null
  started: boolean,             // wakeIfIdle 在空闲叙述者上起了 turn
  interjected: boolean,         // interject 在运行中叙述者上请求了软停
}>
```

**空内容不产生行**：调用方会 drain 空队列、碰到空 cadence，空行对读者是张白卡、对模型是一次浪费的 turn。

`buildSystemInjectionBlock(source, body)` 单独导出，便于生产者构造 block 并断言而不碰数据库。

### 4.1 接收者是子代理

给 `subagent` 就是一个决定的两个后果，不能只取其一：

| | 不给（主叙述者） | 给（子代理） |
|---|---|---|
| 行的 `parent_tool_use_id` | null（顶层行） | 那个 Agent/Task 的 tool_use id |
| 谁能加载 | 该叙述者页面 | **子代理自己的页面**（其 loader 刻意不加 `isNull(parentToolUseId)` 过滤，并在投影时把该字段置 null）；父页面不内联绘制它，子代理的子行由有界的活动快照代表 |
| 广播 | 一次，发给自己 | **双通道**（复用 `server/websocket/narrator-dual-broadcast.ts`）：父副本保留 `parentToolUseId` 以挂到正确的工具卡片，子代理副本剥离该字段以被当作顶层行 |
| 父叙述者的 `messageVersion` | 不动 | **bump**（父的工具卡片也变了；不 bump 则增量同步认为「无变化」，父页面一直停在旧卡片） |

**这个字段决定的是读者，不是模型看到什么。** 每个 provider 的 `buildHistory` 都硬过滤 `!m.parentToolUseId`，而子代理自己的历史走 `loadSubagentHistory`，它在建历史前先把该字段清成 null —— 所以同一行「不作为子行进入模型历史」和「子代理自己读得到」同时为真，两者容易混淆但只有一个是 bug。

`parentToolUseId` / `parentNarratorId` **由调用方给，模块不自己查**：`resolveSubagentOriginToolUseId` 是一次扫描且对从未启动过的子代理会抛错，而运行中的执行器本来就持有当前调用的准确 id；在这里查等于给一个调用方已经答对的问题一个更弱的答案，答错就把行写到别人的工具卡片下面。

### 4.2 调度接缝

```ts
setInjectionScheduler({ requestSoftStop, wakeIfIdle })
```

一个显式可替换接缝，而非 `mock.module` 目标。两个理由：

- `narrator-session` 既是本模块的协作者也是消费者，静态 import 会在模块初始化时形成循环，所以必须懒加载。
- **`mock.module` 在 Bun 里是进程级的。** 为一个测试文件替换 `narrator-session`，会把替换品交给同一次运行里后续的每个文件；由于若干兄弟服务持有模块级懒加载 map，这会静默重置其他套件依赖的状态（它曾弄坏 9 个 narrator-buffer 断言）。测试自己设置并还原的接缝把影响半径关在测试内部。

---

## 5. 生产者全表

### 5.1 会话层（`narrator-session.ts`）

`drainInjectionsIntoHistory()` 在**忙**叙述者的 turn 边界排空各队列：

| source | body kind | schedule | 触发 |
|---|---|---|---|
| `living_work_spec` | `tasks` | `onNextTurn` | cadence（默认每 15 个完成工具调用） |
| `behavior_fence` | `prose` | `onNextTurn` | cadence（默认关闭，`-1`） |
| `bg_agent` | `tasksDone` (agent) | `onNextTurn` | 后台子代理完成 + `background_agents_completed` extraBlock |
| `bg_bash` | `tasksDone` (bash) | `onNextTurn` | 后台 bash 任务完成 |
| `subagent_message` | `messages` | `onNextTurn` | 子代理 `Send({ id: "parent" })` + `subagent_messages` extraBlock |
| `spec_update` | `specUpdates` | `onNextTurn` | 用户在 UI 编辑 spec 文件（仅空闲回退路径） |

**空闲**路径是分开的函数，`schedule: "none"`：

| 函数 | source | 为什么 none |
|---|---|---|
| `drainAndPersistBackgroundCompletionNotice` | `bg_agent` | 调用方持有 `continuationStartLock` 并自己起 loop，让 `deliverInjection` 唤醒会重入同一把锁并死锁 |
| `drainAndPersistParentInboundNotice` | `subagent_message` | 同上 |

这两条空闲路径的**文本**仍来自各自原有的格式化函数（那套措辞是它们一直发送的、且在别处被断言），body 只是随行给读者。

### 5.2 Agent Loop（`server/lib/agent/loop.ts`）

loop 自己抬起的提醒进 `pendingLoopInjections` 队列，在 turn 边界由 `flushLoopInjections()` 经宿主的 `deliverInjectionRow` 钩子落库：

| source | body kind | 触发 |
|---|---|---|
| `pipeline_exit_confirmation` | `notice` | Pipeline 退出确认待处理 |
| `silent_progress` | `notice` | 连续 N 次工具调用无可见文本输出 |
| `relaxed_plan` | `notice` | 宽松计划模式提醒 |
| `knowledge_base_hint` | `knowledge` | 工具输出扫中知识库条目（point B） |

两个关键性质：

- **队列而非返回值**：一条提醒要写一行，不是每个碰巧拼装了它的 tool result 写一行。
- **幂等**：`processTooResult` 会对同一个工具**被调用多次**（结果可能在流式期间被 drain、又被执行组循环 drain 一次），`processedToolUseIds` 让整个函数体幂等。没有它，一次 silent-progress 阈值跨越会重复投递。
- 宿主**没有**提供这个钩子时返回 `""` 且提醒被丢弃，**不回退到 side-car**——两条路都投递就是同样的话在对话里出现两次。

### 5.3 子代理执行器（`subagent-executor.ts`）

| source | body kind | schedule |
|---|---|---|
| （转发 loop 的）`injection.source` | 透传 | `onNextTurn` |
| `living_work_spec` | `tasks` | `onNextTurn` |
| `team_message` | `messages` | `onNextTurn` |

子代理的排队用户消息**不走** `deliverInjection`：行由 `persistSubagentUserMessage` 作为真正的 `role: "user"` turn 写入（它本来就是——用户打的字），再注入一次会重复。文本仍需要，因为 loop 在 pass 开始时就建好了内存历史。

`persistSubagentUserMessage` 现在**共用** `persistUserMessage` 的 insert 路径（传 `{ parentToolUseId }` 落位），只保留三件通用入口不该做的决定：向投递注册表认领归属（`claimAgentMessageOrigin`，consume-once，只能在真正投递 agent-to-agent 消息的路由上做）、AI 撰写时扣留 creator（`createdBy` 仍作审计留在行里）、以及附件 block 与 `[user sent image(s)]` 占位。

### 5.4 cadence 抽象（`server/lib/injection-cadence.ts`）

`InjectionCadence` 把"每 N 个完成工具调用做一次"独立出来。原先有三份各自长起来的计数器（`narrator-session` 两份、`subagent-executor` 一份），在一个要紧的细节上不一致：

**空情况。** cadence 可能到期然后什么都没产出（`spec://tasks.json` 可能没有开放任务，行为围栏可能是空的）。`due()` 刻意**不是**纯谓词——**问它是否到期就是消费掉这个 tick**。产出为空的调用方也花掉了这一 tick。否则 cadence 永久处于到期状态，之后**每个** tool result 都会从 SQLite 重读 spec 文件，即一次同步主线程读取 per 工具调用，只要会话还活着就一直如此。`subagent-executor` 原来只在成功时推进，正好有这个问题。

interval 语义：`> 0` 每 N 次触发；`-1` 关闭；`0` 也当关闭（"每次都触发"没人想要，而配置错误能产生它）。interval **每次检查都重读**而不是捕获，这样叙述者的 override 改了能在下一个边界生效。

标记存储通过访问器间接化，让标记能**活得比** cadence 对象长：`narrator-session` 的标记放在 ActiveNarrator 上，因为一个会话跑很多 loop pass 且每次重建 config，cadence 自己持有标记会在每个 pass 重启日程。

---

## 6. 渲染：两条路径

| 路径 | 有 body 的注入 | 无 body 的历史行 |
|---|---|---|
| chunked（准备删除） | `SystemInjectionNotice.tsx` 单卡片承载整个 delivery | 同左 |
| vlist 精确布局 | `injection-bubble`：每说话人一个**左侧带框气泡**（`measure-injection-bubble` / `RenderInjectionBubble`） | 复用 `origin_notice`：标题行 + 折行正文 |

**有主体 / 无主体的划分**（`adaptSpokenInjection`，`shared/pretext-layout/segment-adapter.ts`）：

| body kind | 来源 | 拆法 | speaker |
|---|---|---|---|
| `messages` | `subagent_message` / `team_message` / `group_message` | 每 sender 一个 | `fromTitle` → `fromId` 前 8 位 → 未知发送者 |
| `tasksDone` | `bg_agent` / `bg_bash` | 每任务一个 | `alias` → `title` → `id` |
| `knowledge` | `knowledge_base_hint` | **仅当全部 hits 都有实质 summary** 时每条一个 | `title` → `entryId` |
| `tasks` / `prose` / `notice` / `specUpdates` | 平台例行提醒（`living_work_spec`、`behavior_fence`、`relaxed_plan`、`silent_progress`、`pipeline_exit_confirmation`、`spec_update`） | 整条投递一个气泡 | 统一平台身份（不给每种事件编名字） |
| 无结构化 body 的历史行 | 任意 | 不拆 | —（走原样 verbatim 卡片） |

`knowledge` 的形态跟着**数据**走而非跟着 tag 走：`summary` 常为空串，那时气泡正文只剩标题、与自己的 header 重复，是一叠空壳。全空或混合批次整批退回紧凑列表。

气泡侧的承重不变量（详见 `frontend/components/narrator/vlist/CONTRACT.md` §4「注入气泡」）：正文画在 `measured.contentWidth` 而非框内宽、note 行 measure/render 单向一致、`spec.key` 用内容身份而非数组位置、`injection-bubble` 必须在 `UNKNOWN_HEIGHT_FORWARDING_KINDS` 里、正文有 `INJECTION_BODY_MAX_CHARS` 硬顶。

另外，用户自己的消息与**队友**的消息现在也分侧：`isSelf`（`creator.id` vs 登录用户）决定右侧 indigo 或左侧中性。该判断在集成层解析，不进 adapter——两侧高度相同，让观看者身份进入 measure 数据会按用户分叉缓存。

`MessageBubble` 在纯文本分支**之前**先查 `system_injection` 块——顺序是承重的：那行也带 text block（模型向文案，boilerplate 齐全），fall through 到文本分支就会把 prompt 工程显示给读者。

两条路径视觉上刻意与 `SystemOriginNotice` 一致（低对比度小字灰卡），语义是：注入内容是对话里的一条注记，不是对话的参与者。

未映射的生产者标签回退到通用 system 标签，而不是泄露内部 tag——表里没有的新生产者是命名缺口，不是该给读者看的东西。

### 6.0 点击气泡 header 跳转到它所指的地方

说话人的 header 行本身是可点区域，点击去它这条气泡真正指向的那个东西。

**目标是一个带 tag 的值，不是一堆平铺字段**（`shared/pretext-layout/injection-target.ts`）。第一版只有 `sessionNarratorId` + `sessionMessageId` 两个平铺字段；随后又来了三种目标，平铺形状的问题不只是"字段变多"，而是**它无法表达互斥**——没有任何东西阻止一行同时带叙述者 id 和 spec uri，集成层就会静默地按检查顺序挑一个。一个 tagged union 让互斥变成结构性的，新增一种目标是一个 variant + 一个编译器强制的 `switch` 分支。

| 行 | 目标 | id 来源 |
|---|---|---|
| `subagent_message` / `team_message` | `narrator`（+ 消息） | `message.fromId` / `SideCarInboundMessage.fromMessageId` |
| `bg_agent`（`flavor === "agent"`） | `narrator`（+ 消息） | `task.id`（后台代理的任务 id **就是**其叙述者 id）/ `SideCarDoneTask.resultMessageId` |
| `knowledge_base_hint` | `knowledge` | `hit.entryId`，scope 恒为 global（注入命中来自全局集合） |
| `spec_update`（**仅单文件**） | `spec` | `item.uri` |
| `review_feedback` | `chapter` | `block.reviewChapterId`（producer 早已写入） |
| `merge_summary` | `chapter` | `block.sourceChapterId`（producer 早已写入） |
| `bg_bash` / 任务摘要 / 多文件 spec 保存 | — 不可点 | — |

三条刻意的"不给目标"：
- **`bg_bash`**：`speakerId` 有值（它是 identicon 种子，**每种说话人都有**），但 bash 任务 id 指的是一次 shell 调用。用 identicon 种子导航就会去打开一个不存在的叙述者——这是分开两个字段要防的唯一 bug。
- **多文件 spec 保存**：没有诚实的单一目的地，静默取第一个会把读者带到这行从未承诺的地方。
- **任务摘要（`living_work_spec`）**：它是**关于** spec 的，不是某个文件变更的报告。

**知识库命中是唯一"正文本身不完整"的气泡**：excerpt 是条目正文的扁平化切片，所以"读全文"是它的自然下一步——这也是它值得可点的理由，而不只是因为它有个 id。

**消息 id 是纯读者向，绝不进模型向文本。** 服务端在 `getSubagentResultMessageId` 上取：`bg_agent` 取产出结论的那条 assistant 消息；`Send`/`TeamStatus` 因为「发消息」本身不是发送方历史里的一条消息，取的是发送方**刚写完的**那条（"它说这句话时在哪"最接近的真相）。取不到就省略字段（不写 null），此时打开会话停在末尾——`sidecar-body.test.ts` 有断言确保这些 id 不出现在模型向字节里，理由与 alias 化同一条：让模型看见内部 id 会教它把 id 反引回来。

**能力按种类分别 gate**（`InjectionNavigation`）：每个 opener 独立可选，宿主够不到某种目标就让那些行保持惰性，而不是回落到另一种 opener——把 spec 行交给叙述者 opener 会路由到错误的地方。`coerceInjectionTarget` 还会拒收畸形目标（缺 id、未知 kind），因为**缺 id 的目标正是那种"画出一个看起来能点、点了跳到 undefined"的形状**。

**Spec 文件的跳转走一个小注册表**（`frontend/components/narrator/spec-file-reveal.ts`），不是 dock context 也不是冒泡事件：点击时 Spec 面板通常还不存在（打开它正是这次点击的第一个效果），所以 dock context 无法承载第二步；而 dock 面板不是 chat viewport 的 DOM 后代，`spec-open-tasks` 那种冒泡事件到不了它。注册表带**有界**重试（面板挂载需要一两帧），到期安静放弃——真正的失败模式是"这个 surface 没有 Spec 面板"。选择走 `handleSelectFile` 而非裸 `setSelectedUri`，因为未保存编辑的确认对话框在那个 handler 里，绕过它会静默丢弃读者正在打的字。

**跳转请求是请求，不是状态。** `SubagentPanelParams.highlightMessageId` 走 panel **参数**而非 `scrollToMessage` 桥，因为点击时面板通常还不存在、没有注册者可调。它与 `highlightRequestId` 一起被 `stripIdentityFromLayout` 剥掉：恢复布局必须把会话停在读者上次离开的位置，而不是重放上一次访问的跳转。`highlightRequestId` 的存在是因为 `NarratorPanel` 按 (narrator, target) latch 一次跳转（刻意如此，否则会跟读者自己的滚动打架）——没有这个变化的 token，读者滚开后再点同一行会静默无反应。

### 6.1 12 个来源标签

`silent_progress`、`todo_reminder`（`living_work_spec` 映射到它）、`relaxed_plan`、`knowledge_base_hint`、`bg_agent`、`bg_bash`、`team_message`、`buffered_user`、`subagent_message`、`spec_update`、`behavior_fence`、`pipeline_exit_confirmation`。

---

## 7. 两阶段落库约束

有两类副作用**必须在行持久化之后**才能执行，宿主（而非 loop）负责：

| 副作用 | 为什么必须后置 |
|---|---|
| `knowledgeInjection`（`KnowledgeInjectionRecord`） | 去重键 `(narratorId, compactSeq, entryId)` 在数据库里，且内存集合在 compact 后从该表重载。内容还没落库就记账，会**永久压制**这些条目在 compact 后重新注入 |
| `pipelineExitConfirmationStateId` | 提醒还没存下来就清 pending 标记，等于**丢掉一个模型从未收到的警告** |

两者都通过 `deliverInjectionRow` 的返回值确认行已 durable（`messageId` 非 null）后才执行。

---

## 8. 结构化系统 block 的落库现状

结构化系统卡片现在直接在自身 block 上保存 `modelText`，不再依赖旁边的 `text` 副本：

| producer | block 类型 |
|---|---|
| `narrator-session.ts`（两处） | `spec_blocked_continuation`、`spec_continuation` |
| `agent-runtime/orchestrator.ts`（知识 point A） | `knowledge_hint` |
| `container-event-handler.ts` | `container_ready` |
| `browser-session-recovery.ts` | `browser_session_lost` |
| `merge-summary-service.ts` | `merge_summary` |

`persistSystemMessage` 统一识别这些 native context block，并将其自身的 `modelText` 写入 `contentText`。历史 `[text, structuredBlock]` 行由共享 logical-block mapper 兼容读取和删除，因此删除外壳不会留下可重新投影的灰色卡片。

三处路由级纯文本通知仍直接写普通 `text` block；它们没有第二个结构化投影，不需要再套 injection。compact、review 和权限/问题控制卡片也保持自己的生命周期与 renderer，不被错误合并为 injection。

知识注入 point A 与 point B 现在都使用自包含模型投影；point A 仍在 durable message 成功后记录去重事件，避免消息写入失败时污染知识注入账本。

---

## 9. 命名现状（诚实说明）

投递机制叫 **injection**，载荷类型仍叫 **SideCar**：

- 新机制层：`system_injection`、`SystemInjectionBlock`、`deliverInjection`、`deliverInjectionRow`、`InjectionSchedule`、`InjectionScheduler`、`SystemInjectionNotice`、`InjectionCadence`
- 载荷层（沿用旧名）：`SideCarBody` 及其 5 个子接口、`coerceSideCarBody`、`readSideCarBody`、`renderSideCarBodyToText`、`sideCarBodyToMarkdown`、`rawSideCarToMarkdown`、`sideCarBodyWithText`、`SideCarLabels`、`SideCarModelTemplates`，以及 i18n 的 `sidecar.body.*`（22 键）和 `sidecar.sources.*`（12 键）

保留旧名不是漏改：被删的是"挂载到别人消息上"的投递与渲染机制，而 `SideCarBody` 描述的是**注入内容的结构化载荷**，这个概念没变、依然是唯一真相来源。改名要动两份 locale 的 34 个键、服务端 `sidecar.*` 模板表，以及 `sidecar-body.test.ts` 里按键名比对的字节级 parity 断言——大量改动换零行为变化。

但这留下认知负担：读代码的人会看到 `deliverInjection` 里传 `SideCarBody`，而 sidecar 已不存在。若要清理，正确做法是一次纯机械重命名（`SideCarBody` → `InjectionBody`、`sidecar.*` → `injection.*`）单独成 commit，不混功能改动。

### 9.1 已知死代码

- `frontend/locales/{en,zh-CN}/narrator.json` 中 `sidecar.*` 下 6 个键引用数为 0：`unknownSource`、`copy`、`copied`、`truncated`、`showAll`、`attachedCount`（全是被删尾注卡片的 UI chrome）。⚠️ 注意 `sidecar.truncated` 与仍在使用的 `sidecar.body.tasksDoneTruncated` 是**两个不同的键**，前者是尾注的"预览被截断"、后者是后台任务输出被裁的说明，删前者不影响后者
- `SIDECAR_PRESENTATION_FALLBACKS` 现在只被 `sidecar-body.ts` 内部的 `label()` 使用，不再是跨层契约，可降为模块私有
- `spec-edit-interject.ts` 的 `SpecEditDelivery = "interjected" | "sidecar"`：`"sidecar"` 这个字面量现在名不副实，实际含义是"进了空闲队列等下次读取"

---

## 10. 测试覆盖

| 文件 | 覆盖 |
|---|---|
| `server/services/__tests__/narrator-injection.test.ts` | 持久化行、`role`、`schedule`、`role × schedule` 正交性、`buildSystemInjectionBlock` |
| `server/services/__tests__/subagent-injection.test.ts` | 子代理接收者：行落在 tool_use 子树且属于子代理、ref 挂在子代理上、父 `messageVersion` 被 bump、子代理页面能加载且投影为顶层、**带 link 时不进模型历史 / loader 清 link 后进**、双通道两副本形状与内容一致、主叙述者路径不变（顶层行、单播、仍进模型历史） |
| `server/services/__tests__/injection-wake-dispatch.test.ts` | `wakeIfIdle` 的引擎分派：子代理走 `resumeSubagent` 且 intent/actor 正确、plan 模式与在飞 resume 与无父子代理均为拒绝而非抛错、resume 抛错被降级为 `started: false`、主叙述者永不进入 resume 路径 |
| `server/services/__tests__/background-completion-delivery.test.ts` | 忙/空闲两条路径的差异 |
| `server/lib/__tests__/injection-cadence.test.ts` | cadence 的 tick 消费语义、interval 归一化 |
| `frontend/components/narrator/vlist/system-injection-adapter.test.ts` | 路由（`origin_notice` vs `injection-bubble`）、拆气泡与 key 稳定性、读者向 body、标题标签回退、六种导航目标 + 三种刻意不给（`bg_bash` / 多文件 spec / 任务摘要）、缺 message id 仍可开、高度中性 |
| `frontend/components/narrator/vlist/vlist-injection-header.test.tsx` | 说话人身份/头像分型，以及可点 header：四种目标各自透传、**每种只用自己的 opener**、**不按 identicon 种子导航**、畸形目标被拒、按种类取 label |
| `shared/pretext-layout/__tests__/injection-target.test.ts` | `coerceInjectionTarget`：接受合法目标、null/空串 message id 归一、scope 兜底 global、拒收缺 id / 未知 kind / 非对象 |
| `frontend/components/narrator/spec-file-reveal.test.ts` | 面板已挂载即同步选中、点击后才挂载的等待、可取消、到期放弃、remount 的 last-write-wins 与**陈旧 unregister 不清活跃 selector** |
| `frontend/components/narrator/dock/narrator-dock-layout.test.ts` | 布局持久化剥掉一次性跳转请求，保留 subagent 资源身份 |
| `frontend/components/narrator/vlist/measure/measure-injection-bubble.test.ts` | 气泡几何：shrink-wrap 宽度纪律、header/note 固定行、字符硬顶 |
| `frontend/components/narrator/vlist/render/RenderInjectionBubble.test.tsx` | measure/render parity：画在测量宽度上、header/note 只在预留时画 |
| `frontend/components/narrator/vlist/render/RenderMessageBubble.side.test.tsx` | 本人/队友分侧，且两侧共用同一份测量几何 |
| `shared/__tests__/sidecar-body.test.ts` | 模型向文本的字节级 parity、有界投影、wire 强制转换 |
| `shared/__tests__/sidecar-body-markdown.test.ts` | 7 种 kind 的 Markdown 投影、boilerplate 剥离、转义 |
| `server/lib/agent/__tests__/loop-abort.test.ts` | 提醒在 turn 边界作为独立行投递、不混进 tool 输出 |
