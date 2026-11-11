# Injection 机制解析

> 服务端把自己的话放进叙述者对话的唯一通道。本文档梳理截至当前代码状态的全部使用点。
>
> 核心实现：`server/services/narrator-injection.ts`

---

## 1. 这个机制解决什么问题

注入内容历史上走两条互不相干的路：

1. **side-car**（`narrator_sidecars` 表）—— 一行挂在**别人**的消息上的记录，在 API 调用时由七份 `buildHistory` 各自的手写状态机重新拼进 `tool_result` 输出或下一个 user turn。
2. **消息行**（`persistSystemMessage`）—— 一条普通 `role: "sys"` 行，每个 provider 本来就知道怎么回放。

路 1 解决的问题路 2 也能解决。NarraFork 从有序持久历史统一投影模型输入；Codex WS 可在前缀相容时续写 delta，断链时重放完整历史。传输是否增量不改变历史记录的语义，也不触发重建基线。side-car 为相同的注入语义额外付出了一张表、一个 `body_json` 列、七份 flush 状态机和一层 `<side_car>` 包装。

**路 1 已完全移除**（表、列、状态机、包装全部删除）。下文描述的是唯一剩下的路。

---

## 2. 两个正交的轴

旧设计把这两件事混在一起：`role` 既决定协议角色，又（通过每个 provider 的"末尾 user 行就是当前 turn"规则）决定这行会不会被当成需要回答的东西。这正是"注入但不排 turn"没有干净写法的原因，也是 side-car 被发明出来绕开 `role` 的原因。

### 2.1 `role` —— 这内容**是**什么

| 值 | 语义 | provider 映射 |
|---|---|---|
| `sys`（默认） | 宿主发布的事实或上下文 | 普通注入沿 Anthropic 既有中途 system 门控，其余映射为 user；结构化 `context_update` 在所有当前适配器都用 user 载体，保持追加位置 |
| `user` | 代表用户说话 | 按用户输入投影；不能仅凭正文标签获得宿主更新身份 |

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

> 模型历史与调度分开：统一投影保留末尾输入，不再由 provider 弹出末尾 `user` 来猜测调度。`context_update` 是每次真实 provider 请求前的持久化协调结果，不另触发一轮回答，也不走第二份 live 文本注入。

---

## 3. 数据形状：一行两个投影

注入行的 `contentJson` 是 `[{ type: "text", text }, injectionBlock, ...extraBlocks]`：

| block | 给谁看 | 内容 |
|---|---|---|
| `text` | **模型** | 模型向文案原样保留，指令 boilerplate 全在里面（"tasks.json 只保留 text/status/protected"、"不要添加 ID"） |
| `system_injection` | **读者** | 刻意携带**结构化 body**（`SideCarBody`），而非预先措辞好的文本 |

这个拆分是承重的。普通注入的第一块直接保存模型向原文；下述外置 `context_update` 则先由模型历史准备路径恢复完整 text，provider 不把持久摘要当作更新正文。

### 具名动态上下文更新

动态初始值在每代基线中声明，后续更新仍用已有 `sys` 消息/块存储，不另建 side-car 或日志。大更新已外置，持久行只保存摘要和快照引用：

```ts
[
  { type: "text", text: "Context updated: workspace" },
  { type: "context_update", epochId, changes: [], snapshotRef },
]
// snapshotRef → 既有 narrator_text_snapshots 中的冻结 JSON 载荷：
// { changes: [{ key: "workspace", value: "/repo/b" }], modelText: frozenModelText }
```

- `context_update` 块可以带一份只给读者看的 `display`（按部件 key，`ContextPart.display`；不参与变更比较、不进前缀哈希、不发给模型，JSON 超过 8 KiB 不存）。部件可以在 `server/services/context-display-refiners.ts` 注册 refiner：写更新行时拿到「本代里上一条改过该部件的行存的 display」和这一次的 display，返回要存的那份。基线是会话上一次**被注入**的内容，不是读缓存：每代第一条更新行与代标记上的 `baselineDisplays` 比（开代时把前缀基线里该部件的 display 存在标记行上，基线里没有该部件存 `null`；只给读者，不进前缀及其哈希）；旧代标记没有这个字段、或上一行没存 display 时没有基线。大纲「当前任务」视图（`outline.tasks`）用它存状态表 `states`（最多 60 个地址）和变化 `changes`（最多 5 条，其余计数），转录里那一行据此写成「完成『…』，开始『…』」；refiner 最多点读 5 个块，失败时按未比较的 display 存。模型侧文字在 refiner 运行前已经渲染并冻结。
- `buildRuntimeHistory` 在进入 provider 投影前调用 `hydrateContextUpdates`，从快照恢复完整 text 与 changes。`narrator-prefix-state` 增量归并本代新增的相关更新/工具事件；相同历史源或仅增加无关消息不重放旧更新，修订/非追加变化则重建。同一请求的协调与水合共享载荷，避免重复读取。持久行不内联全文，列表不展开正文；`snapshotRef` 登记块资产引用。
- 旧版 `[{type:"text",text:frozenModelText},{type:"context_update",epochId,changes}]` 内联双块仍可读。恢复/重试使用原快照，不能根据实时配置重新生成模型正文。
- 恢复后的 `changes` 是同名部分的完整替换；`null` 删除，空字符串合法，未提及的 key 保持当前值。引用行上的 `changes:[]` 只是载荷外置的占位，不能当作无变化。正文生成一次后冻结，元数据不再渲染成第二份文本。
- 只有宿主 `sys` 行的结构化元素会解码成 `ContextBlock.contextUpdate`，并传入 `NeutralInputItem.contextUpdate`；普通用户文本中的 `<context_update>` 或同名结构不会变成可信宿主更新。
- 基线明确授权这种具名动态状态替换，但不修改固定安全规则、不授予权限。权限、设备和 cwd 在执行端实时检查，不能由 prompt 快照反向决定。
- provider 使用已有 user 宿主载体。Responses/Codex 不把更新抽进 `instructions`；Anthropic 不让 `ensureAlternating` 把更新移到后续 user 输入后。其余适配器复用同一份冻结正文，不各自生成文案。
- 首次请求、后续轮次、重试共用 `preparePrefixRequest`：每次实际请求前协调当前状态，先持久化再进入统一历史构建。整条 prefix 准备链没有固定 10 秒总超时，历史源读取各有查询预算，真实 signal 可取消；失败重试和恢复重放原记录。已经发布 B 后再回 A 要追加 A，不删除 B；两次请求之间未发布的 A→B→A 不产生更新。
- publication lease 保护“快照已写、历史引用尚未发布”的窗口；工具快照 manifest 引用逐定义 hash，分批读写并复用未变定义。后台 GC 按完整标记、宽限期和活动保护做保守清理，不在失败或畸形载荷时猜测无引用；关闭维护/存储会等待取消、队列收束和 worker 退出后才报告完成。
- `senders` 部分保存同代首次见到的具名 human 用户名，未知名称以空值冻结；同代改名不改写模型历史，新身份可追加。显示名投影不改变持久行、身份或消息角色，不能将这一实现扩大描述成已冻结所有 agent 标题。
- 显式加载与自动工具对账共用 `classifyToolAdditions`。replace-only/缺失策略不暗中升级成兼容注入：未声明的新工具只在 `tools.availability` 表明不可用，不写虚假 loaded 事件、不阻断其他工具。Anthropic 的卸载同样不发 removal；本代重新加载不重复声明 schema。
- 首次初始化、清空上下文后的初始化建立基线；运行中只有 compact 成功和实际模型切换换代。cwd/device、配置、registry generation、工具加载、重启及缓存过期不换代。工具 description/schema 静态，动态候选与状态放在这些具名部分中。

行为围栏、任务、知识命中等既有追加链保留单一来源，不同时写入另一份 `context_update`。这是本地状态与投影契约，不宣称 user 角色等同 system，也不保证上游缓存命中。

两项边界仍然存在：Codex hosted 原生工具必须实时撤权，必要时移除声明并改变前缀，不能为了缓存继续授权；大请求没有总量业务门槛，但最终 wire 仍需物化字符串，并非完全流式。已测 83MB×3 并发出站 body 的 RSS 峰增为 873MiB、最大心跳间隔为 267ms，不能据此宣称上游接受此体积。普通小请求保持简单 JSON 构建，详细方法与观测见 [AGENT_PROVIDERS.md](AGENT_PROVIDERS.md)。

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
| `outline_task_edit` | `prose` | `onNextTurn` | 大纲会话运行中有人改了它的任务（看板、大纲编辑器、退回目标完成）：`outline-task-edits.ts` 在内存里攒着，本函数在工具边界取走（`takeOutlineTaskEditNotice`，仅主会话，子代理不取） |
| `outline_team_activity` | `outlineTasks`（`activity`） | `onNextTurn` | 长回合里团队动态再看一次：距上次看满 10 分钟、有新东西才写（`outline/team-activity.ts`，仅大纲根会话；见下） |

**空闲**路径是分开的函数，`schedule: "none"`：

| 函数 | source | 为什么 none |
|---|---|---|
| `drainAndPersistBackgroundCompletionNotice` | `bg_agent` | 调用方持有 `continuationStartLock` 并自己起 loop，让 `deliverInjection` 唤醒会重入同一把锁并死锁 |
| `drainAndPersistParentInboundNotice` | `subagent_message` | 同上 |

这两条空闲路径的**文本**仍来自各自原有的格式化函数（那套措辞是它们一直发送的、且在别处被断言），body 只是随行给读者。

**大纲任务的人为改动（`outline_task_edit`，`server/services/outline-task-edits.ts`，outline P2 PR 5）**：一律 `role: sys`，不带 `createdBy`，正文以「系统通知（不是用户发言）」开头，按人分组写明谁改了哪个任务（地址、标题、改动），不多于大纲里本来就有的内容。改动的人可能读不到这个会话（项目空间的写者改了某个私有会话认领的任务），所以它从不作为那个人的消息、也从不成为运行的主体（principal）。按会话合并（安静 1 秒、最长 4 秒），每个人的改动各自成组：

| 会话状态 | schedule | 去处 |
|---|---|---|
| 空闲 | `none` | 直接写一行，下一回合读到；不唤醒（有人整理任务不该花一次请求） |
| 运行中 | `onNextTurn` | 在内存里等，下一个工具边界由 `drainInjectionsIntoHistory` 取走并写行 |
| 运行在工具边界前就结束了 | `none` | 守望定时器（2 秒）发现运行已结束，把还在等的通知写成一行 |

看板的「添加并开始」「重新打开并开始」在启动会话前先 `flushOutlineTaskEdits`，让这一回合读到通知。`/goal` 自己的提交不发通知（它的消息已经说了）。行为边界页上的复选框是规则不是任务，不发通知。

**本会话建的任务在别处结束（`outline_task_finished`，`server/services/outline/task-finished.ts`，outline P2 PR 9b）**：监听 `outline:committed`，读这次提交写的版本（不读正文，最多 200 条）。任务在这次提交前是待办或进行中、提交后是完成或取消，且 `task_json.manager` 是一个会话（agent）时，告诉那个会话（子代理建的任务告诉它的根会话）；不告诉的情况：结束它的就是这个会话或它的子代理（子代理的结果本身就是通知）、会话不存在或已归档、会话的任务不在大纲、人的提交而 PR 5（`outline_task_edit`）已经会告诉这个会话。管理者是人时这里不发（进汇报，看板标「新完成」）。
- 一律 `role: sys`、不带 `createdBy`；body 是 `outlineTasks`，variant `finished`，每个任务带结束者和状态变化，读者看到「X 结束了本会话建的 N 个任务」（X 是会话标题或用户名，不带哪种语言的字）。
- 每个提交、每个会话一条，一个提交最多告诉 20 个会话（其余记日志）；整次提交最多列 20 个任务，按会话轮流分，每个被告诉的会话至少列一个，其余在各自会话那条里计数。给模型的文字按会话所有者的语言（en、zh-CN）。
- SQLite：消息 id 由（空间、提交 seq、会话、任务）推出，`schedule: wakeIfIdle`；同一提交再送一次时发现那一行已在，不再写也不再唤醒。人的提交 `schedule: none`：照样写一行，下一回合读到，不唤醒（同 PR 5：有人整理任务不该花一次请求）。PostgreSQL：不指定 id，`schedule: none`（同 PR 7 的回答送达）。没有补发队列：提交和送达之间进程停了，这条就丢了（PR 10 并进 runtime inbox 的 `team` 通道）。

**团队动态（`outline_team_activity`，`server/services/outline/team-activity.ts`，outline P2 PR 10b）**：上一轮之后别人在本会话周围做的事。范围集中在 `OUTLINE_TEAM_ACTIVITY_SCOPE` 一处（负责人 Q5 未定，现按设计说明的推荐 A）：本会话领着、管着、被指派、最近 7 天写过的任务所在的任务树（项目空间里，往上到页下面最上层的任务）里别人的状态变化、转交、新子任务、笔记 / 报告 / 回答（只计数）；项目任务页（别名 `tasks`）上任务级的变化，最多 8 行；本会话改过、别的会话进行中的任务后来也改了的文件（`outline/overlap.ts`）。不放：自己和自己子代理的提交；人对它领着（或上次领着）的任务的改动（PR 5 的 `outline_task_edit` 已经说过）；整理（改字、挪位置）；会话空间。
- 一律 `role: sys`、不带 `createdBy`，不唤醒。运行开头（`prepareOutlineRun`，第一次准备前缀之前）写一行，`schedule: none`，这一轮的历史读进来时已经带着；长回合在工具边界最多每 10 分钟再看一次（两次之间什么都不读），有新东西才写，`onNextTurn`。
- 只追加在历史末尾，不进系统提示、工具定义和命名上下文：正文是确定的（没有相对时间、租约时间），重建历史、重试请求发出去的字节一样，两轮之间的系统提示字节不变。
- 正文最多 4 KiB、20 行，一棵树最多 5 行，标题截到 80 字；放不下的在最后一行计数，并指向项目任务页。名字按 `canSessionReadNarrator`：读这个会话的人都能读的会话才写标题，否则写「另一个会话」；人写用户名。读者看到的 body 是 `outlineTasks`，variant `activity`，每项带「谁」（标题或用户名，不带哪种语言的字），change 多了 `notes` / `reports` / `answers`（计数）、`claimable`、`overlap`（文件路径）。
- 窗口：每个（会话，空间）一个 seq 游标，只在内存；第一次（新进程、新会话、fork）从会话上一次运行结束（`narrator_turns`，没有就是会话创建）开始，最多往回 2 小时。读的都是有界、走索引的：每个空间最多 50 个提交、300 条不带正文的版本、30 个标题。会话运行时只在 SQLite 上跑，所以只在 SQLite 上写行；读的部分两种方言共用，PG 上有同一组场景测试。
- 重叠提示（同一个 PR）不是注入：它是 Write、Edit 工具结果末尾的一行（`trackFileChange` 返回，`withOverlapHint` 接上），见 `outline/overlap.ts`。

**开工说明（`outline_task_brief`，`server/services/outline/task-session.ts`，outline P2 PR 10c-1）**：人在项目看板上点「开新会话做这个」时，系统给新会话写的第一条消息。新会话建好、任务替它领取之后写，再按 `preferTaskId` 启动第一轮；所以它是这个会话历史里的第一行，续跑提示是第二行。
- `role: sys`、不带 `createdBy`、`schedule: none`（启动由 `openTaskSession` 自己做）。每个为任务开的会话只写这一次，之后不改、不重发：任务状态的变化走「当前任务」视图，别人做的事走团队动态；compact 之后它被摘要掉，不补发。
- 只在历史里，不进系统提示、工具定义和命名上下文：同项目会话的工具定义和系统提示（各自的命名上下文部分除外，见下）不因它多一个字节；说明自己在第一次请求之后就在缓存的前缀里。正文是确定的（没有相对时间、租约时间），重建历史、重试请求发出去的字节一样。
- 正文最多 16 KiB（点的人写的补充说明不计），给模型看的框架文字是英文，任务、笔记的内容保持原文。顺序：头（标题、上级目标、地址、领取代数）→ 任务正文（最多 3 KiB）→ 上一个会话的交接（P2 PR 10c-2，任务被放手过才有；最多 2.5 KiB：最新一块交接完整给出，连同它引用的笔记全文，更早的只留第一行；交接块不再出现在下一节里）→ 任务下的笔记、步骤、提问和前置（复用委派说明的渲染 `renderDelegationBrief`）→ 背景（往上最近 3 个任务的标题和第一段，最近那个的子任务列表）→ 任务里链接的事实（任务和它下面的块里的链接、再到上级任务里的链接，合计最多 8 个，各按事实视图读最多 600 字节；放不下的只留标题和地址）→ 项目空间的页目录（最多 20 页，每页最多 5 行）→ 补充说明 → 规则（做完勾 `[x]` 留一行结果；要人定用 `Ask`；做不完在任务下写交接、说明停在哪，再结束）。前面的节没用完的预算顺延给后面的节。不做检索（D54）。
- 新会话不按实例默认建成公开会话（默认是 private 时归点的人自己，否则是项目可见），也不按实例默认进计划模式；建好后先确认它读得到任务所在的空间，读不到就归档、拒绝（`unreadable`），不领取也不写说明。
- 权限：用新会话自己的读范围整理（`OutlineAgentScope`，不带人，所以不读任何人的个人空间），不用点的人的范围；它读不到的链接目标写成 `(a block this session cannot read)`，不带标题和地址。
- 读者看到的 body 是 `prose`，标题行是说明的第一行（任务标题），其余折叠；来源标签「Opening brief / 开工说明」。
- 交接本身不是注入（P2 PR 10c-2，`server/services/outline/handoff.ts`、`release.ts`）：会话一轮运行结束时放手团队任务，是一次系统提交（actor `outline-handoff`）在任务下写一块大纲块，不往任何会话的历史里写行，也不唤醒谁；放手的那个会话下次运行时从「当前任务」视图看到任务不在它名下了。下一个会话只通过上面那一节读到交接。同一个 PR 在大纲会话的系统提示（`getOutlineTaskSystemReminder`，属于 contract，不是注入）里加了一段话：项目空间的任务这一轮做不完时先在任务下写交接。发布时所有大纲会话的提示缓存前缀失效一次。
- 命名上下文的注意点：每代基线渲染在系统提示里，其中 `outline.tasks` 是每个会话自己的当前任务，所以两个会话的系统提示在这一部分本来就不同；开工说明不改变这一点（`outline-task-session.e2e.test.ts` 逐字节比较了这一部分之前和之后）。

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
| `knowledge_base_hint` | `knowledge` | `hit.entryId` + `hit.scope`（global / personal；旧消息缺省 global）。personal 命中来自当前用户未发布的个人条目 |
| `spec_update`（**仅单文件**） | `spec` | `item.uri` |
| `bg_bash` / 任务摘要 / 多文件 spec 保存 | — 不可点 | — |
| `review_feedback` / `merge_summary`（叙事线移除前的历史消息） | — 不可点 | 所指章节已不存在 |

三条刻意的"不给目标"：
- **`bg_bash`**：`speakerId` 有值（它是 identicon 种子，**每种说话人都有**），但 bash 任务 id 指的是一次 shell 调用。用 identicon 种子导航就会去打开一个不存在的叙述者——这是分开两个字段要防的唯一 bug。
- **多文件 spec 保存**：没有诚实的单一目的地，静默取第一个会把读者带到这行从未承诺的地方。
- **任务摘要（`living_work_spec`）**：它是**关于** spec 的，不是某个文件变更的报告。

**知识库命中是唯一"正文本身不完整"的气泡**：excerpt 是条目正文的扁平化切片，所以"读全文"是它的自然下一步——这也是它值得可点的理由，而不只是因为它有个 id。

**消息 id 是纯读者向，绝不进模型向文本。** 服务端在 `getSubagentResultMessageId` 上取：`bg_agent` 取产出结论的那条 assistant 消息；`Send`/`TeamStatus` 因为「发消息」本身不是发送方历史里的一条消息，取的是发送方**刚写完的**那条（"它说这句话时在哪"最接近的真相）。取不到就省略字段（不写 null），此时打开会话停在末尾——`sidecar-body.test.ts` 有断言确保这些 id 不出现在模型向字节里，理由与 alias 化同一条：让模型看见内部 id 会教它把 id 反引回来。

**能力按种类分别 gate**（`InjectionNavigation`）：每个 opener 独立可选，宿主够不到某种目标就让那些行保持惰性，而不是回落到另一种 opener——把 spec 行交给叙述者 opener 会路由到错误的地方。`coerceInjectionTarget` 还会拒收畸形目标（缺 id、未知 kind），因为**缺 id 的目标正是那种"画出一个看起来能点、点了跳到 undefined"的形状**。

**Spec 文件的跳转走一个小注册表**（`frontend/components/narrator/spec/spec-file-reveal.ts`），不是 dock context 也不是冒泡事件：点击时 Spec 面板通常还不存在（打开它正是这次点击的第一个效果），所以 dock context 无法承载第二步；而 dock 面板不是 chat viewport 的 DOM 后代，`spec-open-tasks` 那种冒泡事件到不了它。注册表带**有界**重试（面板挂载需要一两帧），到期安静放弃——真正的失败模式是"这个 surface 没有 Spec 面板"。选择走 `handleSelectFile` 而非裸 `setSelectedUri`，因为未保存编辑的确认对话框在那个 handler 里，绕过它会静默丢弃读者正在打的字。

**跳转请求是请求，不是状态。** `SubagentPanelParams.highlightMessageId` 走 panel **参数**而非 `scrollToMessage` 桥，因为点击时面板通常还不存在、没有注册者可调。它与 `highlightRequestId` 一起被 `stripIdentityFromLayout` 剥掉：恢复布局必须把会话停在读者上次离开的位置，而不是重放上一次访问的跳转。`highlightRequestId` 的存在是因为 `NarratorPanel` 按 (narrator, target) latch 一次跳转（刻意如此，否则会跟读者自己的滚动打架）——没有这个变化的 token，读者滚开后再点同一行会静默无反应。

### 6.1 12 个来源标签

`silent_progress`、`todo_reminder`（`living_work_spec` 映射到它）、`relaxed_plan`、`knowledge_base_hint`、`bg_agent`、`bg_bash`、`team_message`、`buffered_user`、`subagent_message`、`spec_update`、`behavior_fence`、`pipeline_exit_confirmation`。

之后加入的标签见 `shared/pretext-layout/segment-adapter.ts` 的 `INJECTION_SOURCE_LABEL_KEYS`，其中大纲会话的：`outline_task_turn_end`（plan PR 4，长回合结束时仍有没碰过的进行中任务）、`outline_task_edit`（P2 PR 5，有人改了会话的任务，标签「Task changes by people / 有人改了任务」）、`outline_task_finished`（P2 PR 9b，会话建的任务在别处结束了，标签「Tasks this session created were finished elsewhere / 本会话建的任务在别处结束了」）`outline_team_activity`（P2 PR 10b，团队动态，标签「Team activity / 团队动态」）和 `outline_task_brief`（P2 PR 10c-1，为任务开的会话的开工说明，标签「Opening brief / 开工说明」）。

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
- ~~`spec-edit-interject.ts` 的 `SpecEditDelivery = "interjected" | "sidecar"`：`"sidecar"` 这个字面量现在名不副实~~ **已改名**：现为 `SpecEditDelivery = "interjected" | "queued"`，`queued` 表示"进了空闲队列等下次读取"

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
| `frontend/components/narrator/spec/spec-file-reveal.test.ts` | 面板已挂载即同步选中、点击后才挂载的等待、可取消、到期放弃、remount 的 last-write-wins 与**陈旧 unregister 不清活跃 selector** |
| `frontend/components/narrator/dock/narrator-dock-layout.test.ts` | 布局持久化剥掉一次性跳转请求，保留 subagent 资源身份 |
| `frontend/components/narrator/vlist/measure/measure-injection-bubble.test.ts` | 气泡几何：shrink-wrap 宽度纪律、header/note 固定行、字符硬顶 |
| `frontend/components/narrator/vlist/render/RenderInjectionBubble.test.tsx` | measure/render parity：画在测量宽度上、header/note 只在预留时画 |
| `frontend/components/narrator/vlist/render/RenderMessageBubble.side.test.tsx` | 本人/队友分侧，且两侧共用同一份测量几何 |
| `shared/__tests__/sidecar-body.test.ts` | 模型向文本的字节级 parity、有界投影、wire 强制转换 |
| `shared/__tests__/sidecar-body-markdown.test.ts` | 7 种 kind 的 Markdown 投影、boilerplate 剥离、转义 |
| `server/lib/agent/__tests__/loop-abort.test.ts` | 提醒在 turn 边界作为独立行投递、不混进 tool 输出 |
