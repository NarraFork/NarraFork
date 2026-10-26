# 叙述者消息原生块存储设计

> 状态：讨论稿（分支 `claude/sleepy-bell-wfodnn`）。本文只做设计，不含实现。
> 调研基线：`main` @ `a5a2128e`。文中 `path:line` 都相对仓库根目录；标「推测」的结论没有在代码或测试中直接验证。
> 前提：本设计不以 vlist 性能为目标。vlist 变快只是附带结果，取舍以数据模型的正确性和可扩展性为准。
> 修订：块的粒度与种类按附录 C 的推导修订，第二轮调研基线 `af933c09`。
> 第三轮修订（基线 `95c68304`，本轮新增的 `path:line` 以此为准）：种类从 7 种收为 5 种、phase 从 6 个收为 4 个（§3.3、§3.5）；`provider_meta` 改为「来源 + 线上骨架」（§3.4）；列与约束定稿（§4.1）；纪元改为历史里的标记块（§7.7）；吸收已实现的工具加载（§7.8）；新增逐协议投影（§7.9）、场景走查（§5.6）、效率预算（§12.7）。

## 0. 摘要

**现状**
- 一条消息的正文是 `narrator_messages.content_json` 里的一个 JSON 数组。
- 模型可见的工具结果只存在 `narrator_tool_calls`。
- 另有 `content_text`、`context_chars_json`、`original_content_json` 等派生列和快照列。
- 块没有身份。几十处代码按「消息 id + 数组下标」寻址，或者在 SQL 里读 `$[0]`、用 `LIKE` 扫 JSON。
- 编辑、展示、组装各自对「一个单元」有一套隐含定义，彼此对不上（§1.3 J、K）。

**提案**
- 分三层：信封 → 块 → part（§3.1）。
  - **信封**（`narrator_messages`）：一个 assistant 步（一次 provider 响应），或一条输入。它是作者、用量、fork 共享与 COW 的单位。`narrator_message_refs` 不变。
  - **块**（新表 `narrator_blocks`，一块一行）：落库、编辑、展示、组装四个维度里，任何一个需要独立寻址、独立生命周期或独立取舍的最小内容。共 5 种：`input`、`output`、`reasoning`、`tool`、`context`（§3.3）。非 assistant 信封恰好一块。
  - 生命周期只有 4 个 phase：`open`、`done`、`aborted`、`failed`（§3.5）。模型可见性由 kind、phase 和 `model_text` 三者决定，没有别的开关。
  - **part**：块内有序的内容片段，包括文本、图片、文件、文件引用、推理分段。按（块 id, 下标）引用，不单独成行。
- 工具调用与它被采用的结果合成一个 `tool` 块。执行账本 `narrator_tool_calls` 保留，每个 attempt 一行，通过 `block_id` 挂到块上。
- 这套粒度的推导见附录 C：四个维度的证据、五种候选方案的对比、业界做法。

**三条贯穿规则**
1. **块 id 由服务端在块开始产生时分配。** 流式事件、数据库行、前端、HTTP API、回退、导出，全程使用同一个 id。
2. **模型可见的正文写定后不可变。** UI 状态和运行期状态放在独立的 `state` 列，修改它们不影响模型历史的 revision，也不需要 COW。
3. **结构在写入时确定。** 轮、步、attempt、工具的配对与采用、并行组、因果关系都写进数据，读取方不再推导；loop 生成的模型可见文本也落库。

**读路径**
- 引入规范历史视图和两段投影：先投成与 provider 无关的轮次，再投成各家线上格式（§7）。
- loop 内的实时请求和从 DB 重建走同一套投影，消除两条路径的字节差异。
- provider 凭据按「来源 + 上游原样骨架」保存，同源回放逐字节还原上游 item（§3.4）。
- 纪元是历史里的一个标记块；工具加载与 system 变化在每次请求前对账，差异写成提醒块（§7.7、§7.8）。

**迁移**
- 每个信封有一个 `body_format`：1 表示旧 JSON，2 表示原生块。读取层两种都认，不需要停机切换。
- 新数据先双写，旧数据由后台分页回填。
- `content_json` 最终只作为兼容投影，供 project.db 归档和导出使用，由块组装；新行写 `'[]'`。

**分四期实施**
- P0：收口写入与投影，不建新表。
- P1：建新表，双写，切换到流式 v2。
- P2：读路径切换，回填存量。
- P3：退役 JSON 依赖，开放块级能力。

## 1. 现状

### 1.1 存储形态

| 存储 | 内容 | 备注 |
|---|---|---|
| `narrator_messages.content_json` | 块数组（TEXT，json mode） | 定义在 `schema.ts:1584`。没有统一的 TS union，写入层用 `{type:string; [k]:unknown}` 兜底（`narrator-persistence.ts:2266`） |
| `narrator_messages.content_text` | 搜索文本和回退文本 | **不是** content_json 的纯函数，见表下说明 |
| `context_chars_json` → `narrator_message_context_stats` | 按块统计的上下文字符数 | 应用层计算（`server/lib/context-characters.ts:49-136`），再由触发器投影到统计表（`drizzle/0206_context_numeric_stats.sql`） |
| `original_content_json` | 首次编辑前的整数组快照 | 写入点 `narrator-session.ts:6989`；publication 用 `COALESCE(original_content_json, content_json)` 读取权威结果 |
| `compact_pending` | VIRTUAL 生成列，读 `$[0]` | 依赖「compact 块永远是首元素」（`schema.ts:1650-1669`） |
| `narrator_tool_calls` | 工具执行账本；**模型可见的工具结果只存在这里** | 每个 attempt 一行。`output_json` 是截断后的文本（2000 行 / 50KB）。与块只靠 `(messageId, toolUseId)` 对应，而 toolUseId 不唯一（`schema.ts:1888`） |
| `narrator_message_refs` | 叙述者 → 消息，带 seq | fork 时共享消息行。seq 不唯一，插入时整体移位（`narrator-refs/seq-store.ts:160-181`） |

`content_text` 与 `content_json` 不一致的几处：
- user 行含附件提示（`narrator-session.ts:3222-3236`）。
- 控制行写的是 `[Compacting]` 一类哨兵字符串（`narrator-persistence.ts:1550,1676,4179`）。
- assistant 行的拼接符两处不一致：`narrator-persistence.ts:2002-2007` 用 `\n`，`narrator-session.ts:7060-7063` 用 `\n\n`。

触发器：
- **FTS 3 个。** update 触发器不限定列，任何列更新都会重建该行的索引（`server/db/fts.ts:378-385`）。
- **`model_history_v1` 共 11 个。** 覆盖消息、工具、ref、用户名、叙述者标题与摘要（`agent-runtime/model-history-revision-sql.ts`）。运行时会核对触发器数量，数量不对就不信任 revision（`model-history-revision.ts:54,107`）。
- **context stats 2 个。**

### 1.2 一次 provider 响应怎样落库

1. 首个 `block_complete` 到达时，懒建一个空壳 assistant 行：`contentJson: []`，不 bump（`narrator-event-handler.ts:2005-2060`）。
2. `OutputContentAccumulator` 在以下时刻产出 checkpoint：lane 切换、provider 内容边界、工具出现前、turn 结束或 abort（`server/lib/agent/output-content.ts:43-56`）。每个 checkpoint 在一个同步事务里：
   - 读出整列；
   - 按 `id+revision` 合并，或按 `outputIndex` 插入；
   - 整列写回，同时重算 `content_text` 和 `context_chars_json`；
   - 随后 bump，并广播整条 `message_updated`（`narrator-persistence.ts:2208-2383`）。
3. tool_use 块落库时建账本行（状态 `initializing`）。之后权限、执行、结果都写账本（`narrator-persistence.ts:2385-2420,3674-3824`）。
4. 收到 `assistant_message` 事件后：
   - 补写 `messageUuid` 和用量；
   - 把块标为 `completed:true`，经 COW 写回；
   - 按调用顺序重排 tool_use 块，这一步是直接 UPDATE（`narrator-event-handler.ts:2270-2391`）。

### 1.3 现状问题

**A. 块没有身份。**
- 现有的块 id：
  - text / reasoning 有 lane id（`${attempt nanoid}:${order}`，`output-content.ts:52,112`），每个 attempt 都会换。
  - tool_use 用 provider 给的 toolUseId，跨消息不唯一。
  - redacted_thinking 和绝大多数自定义块没有 id。
- 因此寻址全靠数组下标：
  - 块删除 / 回滚 API（`routes/narrators.ts:4005-4036,6221-6260`）；
  - 前端 key `${msgId}-b${bi}`，并用正则从 key 字符串反解下标（`vlist-block-target.ts:66-75`）；
  - `toolUseOrder`（`tool-continuation-service.ts:403-413`）；
  - 注入块配对用的 `sourceIndices`（`shared/native-injection.ts:132-138`）；
  - 丢弃 attempt 时按块数基线截断（`narrator-event-handler.ts:1201-1211`）。
- 文件回退为此自建了一套身份：「消息 id + 内容摘要 + 出现序号」。它还在 worker 里手写了一个 JSON 顶层逗号扫描器，用来切出原始片段（`revert-history-commit.ts:1788-1830`；`revert-selection-service.ts:77-99`）。
- 重复的 toolUseId 在前端靠 `#dupN` / `dedupeSuffix` 补丁区分（`pretext-layout-manifest.ts:64-91`；`render-units.ts:488-495`）。

**B. 模型可见正文与 UI 状态混在一列。**
- `translatedText`、review 的 `applied`、merge 的 `isLatest`、卡片 status、`completed` 都写在 content_json 里。
- 改其中任何一个，都会：
  - bump `body_revision` 和所有持有者的 `model_history_revision`；
  - 重建该行的 FTS 索引；
  - 刷新 context stats。
- 其中多处为了省事，绕过 COW 原地修改共享行（`merge-summary-service.ts:186-199`、`narrator-messages.ts:4888-4994`、`narrator-persistence.ts:2429-2458` 等）。

**C. 同一事实多份存储，派生规则各写各的。**
- 工具输入存了两份：`tool_use.input` 和 `input_json`。各 provider 重放时取的不是同一份：
  - Anthropic 取账本（`anthropic-provider.ts:3225-3247`）；
  - Responses 优先账本（`openai-provider.ts:4025-4030`）；
  - Gemini 优先块（`gemini-provider.ts:707-709`）。
- `content_text` 有约 15 个写入点，各自生成。它还被当作查询条件，例如 `eq(contentText,"[Compacting]")`（`narrator-compact.ts:527`）。
- 字符统计在 worker 里另有一份副本（`revert-history-commit.ts:1788-1830`）。

**D. 模型历史有两条产出路径，结果不一致。**

每个 pass 开头从 DB 重建一次历史；loop 内再用 `pushAssistantTurn` / `formatToolResult` 增量追加。已知差异：
- **工具结果顺序。** 重建时，同一消息的工具调用按账本行 id 排序，而行 id 是随机 nanoid（`model-history-source.ts:247-248`），所以工具结果顺序与调用顺序无关。
- **只在内存里的内容。** 工具结果里的图片、turn nudge 都不落库（`loop.ts:7275-7276,7451-7458`）。
- **broken 调用。** 实时路径会剔除，重建时会回放（`loop.ts:7583-7611`）。
- **mid-pass 注入。** 实时路径拼进下一个 user turn，重建后变成独立的 sys 行（`loop.ts:3309-3311`）。
- **strict 判定。** `buildHistory` 用带前缀的 model，`chat()` 用裸 model（`openai-provider.ts:697,710` 对比 `806-807`），对 `nug:gpt-5.5` 两边结论相反。
- **测试。** 目前只有一条「重建 == 实时」的字节等价测试（`openai-provider-history.test.ts:986-1043`）。

**E. provider 不透明数据挂载不全。**
- 已持久化的：
  - reasoning 的 `providerMetadata` + `signatureSource`；
  - tool_use 的 `thoughtSignature`，同时以保留键嵌进 `input_json`（`narrator-persistence.ts:515-536`）；
  - `redacted_thinking.data`。
- 没有持久化的：Responses 的 function_call item id、message `phase`、Gemini 普通 text part 的签名。
- `messageUuid` 只能存一个值，存在两个问题：
  - 多个 message item 时被逐个覆盖（`loop.ts:5254`）；
  - 重放时只挂在第一个 message item 上，而且不检查来源（`openai-provider.ts:3910-3919`）。

**F. 结构靠读取方推导。**
- 服务端只有叙述者级的 `turnStartedAt`（`schema.ts:817`）。
- 前端至少有三套「轮」的定义：
  - recency：以任何非 assistant 消息为界（`run-segments.ts:31-45`）；
  - 流式交接：只以 user 消息为界（`streaming-handoff.ts:19-29`）；
  - 工具排队：按单元前缀（`segment-adapter.ts:4577-4593`）。
- 并行分组在服务端（`tool-execution-groups.ts`）和前端（`shared/tool-parallel-groups.ts`）各算一遍。

**G. 写放大。**
- 每个 checkpoint 都重写整列，并依次触发：
  - FTS 删除再插入；
  - `model_history` 更新，其内部的嵌套 UPDATE 又会再触发一次 FTS；
  - 所有持有者叙述者行的 UPDATE；
  - context stats 的 upsert。
- 然后整条消息广播一次。
- 前端每收到一个 delta，就对已加载窗口重跑 segment → group → adapt → measure：900 条约 5.3ms，6000 条约 35.7ms（`vlist-head-trim.ts:8-17`）。

**H. 共享与 COW 有五套实现。**
- 五处实现对新行的 `narrator_id`、是否克隆工具行，处理各不相同：
  - `copyMessageForNarratorTx`
  - `copyOnWriteMessage`
  - `applyBlockDeletionTx` 的共享分支
  - `copySharedCompactMessageTx`
  - revert 的 `copy_on_write`
- 另有十余处原地修改不检查共享，包括流式追加、翻译、输入改写、卡片状态、段压缩操作。

**I. SQL 依赖 JSON 的数组位置和序列化格式。**
- `compact_pending` 读 `$[0]`。
- compact finalize 的 CAS 用 `json_extract(content_json,'$[0]…')`（`narrator-persistence.ts:1914-1929`）。
- 问题补充读 `$[0]/$[1].body.supplement`（`narrator-question-service.ts:794`）。
- merge summary 和孤儿上传检测都用 `LIKE` 全表扫 JSON（`merge-summary-service.ts:175-183`；`storage-service.ts:826-835`）。
- External API 用 `json_each` 抽取推理块（`external-resource-service.ts:1225-1263`）。

**J. 逻辑单元与物理块错位。** 编辑和展示各自认定的单元，与 `content_json` 的数组元素对不上：
- **用户消息。** 逻辑上是原子的，回滚代码明写 "User messages must remain atomic"（`narrator-session.ts:6112-6122`）；物理上却是 `[image…, text_file…, file_reference…, text]` 多块。前端把整条气泡登记为 blockIndex 0（`vlist-block-target.ts:117-120`），所以对带附件的消息点「删除」，删掉的是第一个附件（代码推断，未运行验证）。
- **assistant 编辑。** 入口是单个 text 行，作用域却是整条消息：所有 text 块合并进第一个，工具之后的文字被搬到工具之前。恢复用的是首次编辑时的整数组快照，可能复活已删的工具调用（`narrator-session.ts:6904-7094`；复活一点为推测）。
- **reasoning。** UI 以相邻块组成的 run 为单位，行菜单删除 run 时只删最后一块（`use-message-revert-confirm.ts:63-68`；推测）。
- **review 结论。** `[text, review_feedback]` 不在任何配对规则里，块删除 API 能把模型文本和卡片拆开（`shared/native-injection.ts:22-30,208-215`）。
- **内部执行。** Eval 的内部 Read 只有账本行、没有块（`narrator-persistence.ts:3199-3263`），而构造器会把「账本有、块里没有」的调用补进历史（`anthropic-provider.ts:3251-3271`），模型可能看到自己没发过的调用（推测）。

**K. 组装各自为政。**
- **构造器各写一套。** 所有构造器都逐行翻译 DB 消息，各自实现分组、图片位置、文本拼接、工具排序：
  - Chat Completions 与 Gemini 的重建路径丢掉历史图片（`openai-provider.ts:4276`；`gemini-provider.ts:770-776`）；
  - Gemini 的 functionResponse 按名称和顺序配对（`gemini-provider.ts:758-769`）。
- **实时与重建有 19 处差异。** 可归为几类：工具结果的顺序与图片、turn nudge、broken 调用、loop 自造文本不落库、mid-pass 注入的合并方式、当前轮的拼接顺序、strict 判定、item id 与分段（附录 B 第 1–3 条、第 26–35 条）。
- **投影依赖运行期文件系统。** 附件提示里的 worktree 路径在投影时读文件系统决定（`attachment-projection.ts:99-118`），所以构造器不是存储数据的纯函数。
- **Responses 结构在落库时丢失。**
  - 多段 summary 被压成一段（`openai-provider.ts:2288-2303`）。
  - Codex WS 的增量续写要求逐项 JSON 前缀相同，而本地重新序列化的 item 缺字段，推测几乎总是退化为全量请求（`codex-websocket.ts:259-292`）。

## 2. 目标、收益与非目标

### 2.1 目标

1. **块是一等存储单位。** 有全局唯一的 id，跨流式、持久化、UI、API、回退都不变；有显式序号；可以按种类和状态查询。
2. **模型可见内容只有一个来源，模型历史只有一种产出方式。** 同一版本内，任何时候从 DB 重建出的请求，都与当时实际发送的请求逐字节一致。
3. **正文、UI 状态、provider 凭据分列存放。** 改 UI 状态不会让模型历史失效，也不需要 COW。
4. **多 provider 组装是规范块上的纯投影。** 跨 provider 时携带、降级还是丢弃，规则集中在一处。
5. **结构在写入时确定。** 轮、步、attempt、工具配对、并行组都在写入时记录。
6. **写入按块增量进行。** 流式与持久化共用同一个块对象。
7. **旧数据零停机迁移。** 新旧格式按信封共存；每一期都能单独上线、单独回退。

### 2.2 收益

**修正现有缺陷**（对应 §1.3）：
- 重建历史时工具结果的顺序；工具结果里的图片和附言丢失。
- strict 判定前后不一致；外来 provider 的 item id 被回放给 Responses。
- 改 UI 状态会让模型历史和 prompt cache 失效。
- 下标身份在删块、重试、编辑时错位。
- 五套 COW 和各处绕过共享的原地写入。
- 段压缩标记被 sender 投影当作人类消息（见附录 B）。
- 编辑、删除、回滚的目标与用户看到的单元不一致（§1.3 J）。
- loop 生成的模型可见文本、工具结果图片不落库，重建与实时不一致（§1.3 K）。

**块原生存储新打开的能力**：

| 能力 | 说明 |
|---|---|
| 块级永久链接与引用 | 链接形如 `#blk-<id>`。引用锚点从「消息 id + 前 48 字 needle」（`quote-jump.ts:73-185`）换成块 id。经 COW 复制后，靠 lineage 仍能解析到原块。 |
| 块级搜索 | 块级 FTS（P1 起，D6）：命中直接定位到块并高亮。现在只能定位到消息（`frontend/lib/api/types.ts:1055-1062`）。 |
| 块级评论 / 批注 | 以块的 lineage 为键挂评论，fork 后依然可见。现在没有这项能力。 |
| 块级编辑历史 | `original_payload` 保持现有的「看原文」能力；之后可以按需扩展成块 revision 表，支持撤销和对比。 |
| 按种类查询 | 例如 merge summary、图片引用、推理块，都能走索引，不再 `LIKE` 全表扫描或 `json_each`。 |
| 按块的存储治理 | 统计每块字节数；可以按种类制定保留策略，例如旧截图降级为占位、过期的加密推理凭据清除；超大正文的定位也细到块。 |
| 按块的上下文构成 | 「哪些块吃掉了上下文」可以细到单个工具结果或单个推理块，现在是消息级分段。 |
| provider 扩展成本降低 | 新增 provider 只需写一个投影函数和一条携带策略。插件 DTO（`plugin-provider-rpc.ts:350-359`）可以与规范块一一对应。 |
| 增量同步与导出 | WS、catch-up、project.db 同步都能按块变化推送，也就不再出现「原地修改不会再次同步」的缺口（`project-db-sync.ts:289-324`）。 |
| 对外接口演进 | External API 可以在 `full` 层追加 `blockId`，属于向后兼容的扩展；插件也可以按权限拿到块级只读视图。 |
| 前端去推导 | 流式替身、交接启发式、`#dupN`、三套「轮」的定义都可以删除（§8.3）。vlist 因此变简单，变快只是附带结果。 |

### 2.3 非目标

- **不改变 fork 的共享粒度。** `narrator_message_refs` 仍然指向消息（信封），不下放到块。
- **不把工具执行账本并入块表。** 权限、attempt、执行身份、文件历史仍然放在 `narrator_tool_calls`。
- **不改变对外数据契约。** 包括 External API v1、`project.db` 归档格式（只扩展）、插件 API 的可见范围。
- **不在本轮让 PG 承载叙述者写路径。** 但新 schema 必须能被 PG 转译生成，触发器两种方言各写一份。
- **不以 vlist 性能为验收目标。**

## 3. 核心模型

### 3.1 三层与切分原则

```
narrator_message_refs ──▶ 信封 narrator_messages
  （叙述者, seq）           一个 assistant 步，或一条输入
                            role · 作者 · origin · turn · provider/model · usage · cause
                                │ 1:N，按 ordinal 排序；非 assistant 信封恰好 1 块
                                ▼
                            块 narrator_blocks
                            id · kind · subtype · phase · payload(part) · model_text · state · provider_meta
                                │ 每个 tool 块 1:N
                                ▼
                            账本 narrator_tool_calls（每个 attempt 一行）
```

- **信封**回答「谁、在什么时候、以什么角色、在哪次请求里说了这一段」。它是 fork 共享、COW、用量统计的单位。
- **块**回答「说了什么」。它是身份、寻址、生命周期、模型可见性与携带策略、编辑、展示的单位。
- **part** 是块内有序的内容片段，回答「以什么形态说的」：文本、图片、文件、文件引用、推理分段。它只按（块 id, 下标）引用，不单独成行。
- **账本**回答「工具实际是怎么执行的」：权限、attempt、执行身份、文件历史。它不是会话内容，模型只通过 tool 块看到其中被采用的那一次结果。

切分原则：

> **块 = 落库、编辑、展示、组装四个维度里，任何一个需要独立寻址、独立生命周期或独立取舍的最小内容。四个维度都不单独处理的结构，留在块内做 part。**

下表逐条检验候选边界，证据与完整推导见附录 C：

| 候选边界 | 拆开的理由 | 合在一起的理由 | 结论 |
|---|---|---|---|
| 用户文本 / 图片 / 附件 | 线上 part 不同，但这可以由投影在块内处理 | 一次写入；所有写操作按整条进行（回滚、编辑、删除）；展示为一个气泡；正文里的 `[image #N]` 占位符把图片和文本绑在一起 | 合：一个 `input` 块，带 part 列表 |
| tool 调用 / 结果 | 写入时间与产生方不同；线上位置不同，但投影可以拆 | 配对是所有 provider 的硬约束；展示为一张卡；一起删除；没有单独作用于结果的写操作；只有调用、没有结果的信封不能被 fork 共享 | 合：一个 `tool` 块，分两段生命周期（§3.5） |
| assistant 可见文本 / 推理 | 各自流式、各自完成；凭据与携带策略不同，可被独立丢弃；展示、编辑、搜索、外部 API 都分开处理 | 都出自同一步 | 拆：`output`、`reasoning` |
| 同一步的多个输出 item | 各有线上 id、phase、签名；与工具调用交错 | — | 拆：一个 provider item 一块 |
| item 内的子段（Responses 的多段 summary、多个 output_text） | 展示成步骤 | 凭据属于 item；没有独立操作 | 合：做 part |
| 注入正文 / 伴随卡片 / 旧格式的 text 配对 | — | 删除时已经按逻辑块一起删；属于同一次投递 | 合：一个 `context` 块 |
| 注入 / 控制标记 / 纯 UI 卡片 | 前两轮设计为三种 kind（`context`、`marker`、`notice`） | 都是系统写的单块信封；区别只在「是否有 `model_text`」和 subtype 专属的行为，kind 上再分没有任何读写方用得到 | 合：一个 `context` kind，按 subtype 分族（§3.3） |
| 同一工具的多次 attempt | 执行身份、权限、文件历史各不相同 | — | 拆：账本行；块指向被采用的那一次 |
| 同一轮的多步 | 用量、模型、响应 id、共享与 COW 都按步 | 展示上合成 activity 或 run | 信封 = 步；轮由 `turn_id` 表达 |

### 3.2 身份

| 字段 | 含义 |
|---|---|
| `id` | 全局唯一，由 `generateId()` 生成，在块开始产生时由服务端分配：流式 item 打开、工具调用开始流式输入、输入落库、注入写入。流式事件、DB 行、前端、HTTP API、回退、导出都用这个 id。 |
| part 地址 | `(块 id, part 下标)`。part 在块 `done` 之后不可变，所以下标稳定；编辑产生新 revision 时整体替换。 |
| `origin_block_id` | COW 复制出的块指向 lineage 的**根**（不是直接父块），原块为 null。「同一个逻辑块」即同一个根。指向根而不是父，查找永远一跳，链不会随多次 COW 变长。跨叙述者解析永久链接、引用时，在本叙述者的 refs 范围内按 `id` 或根找唯一的一行，与账本 `executionOriginToolCallId` 的定位规则一致（`narrator-persistence.ts:3349-3394`）。 |
| `ordinal` | 信封内的顺序。由服务端在 item 打开时按到达顺序分配（每个信封一个内存计数器，恢复时取 `max(ordinal)+1`），不是在落库时计算。所以落库先后不影响顺序，也不需要中途重新编号；丢弃的 attempt 会留下空号，允许不连续。 |
| `wire_id` | tool 块的线上调用 id，写入时一次确定：provider 给的 id 合法、且在本叙述者历史内唯一，就沿用；否则生成一个 wire-safe 的替代值，规则沿用 `tool-use-id-dedup.ts`。原始 id 留在 `provider_meta.wire` 里。投影不再做改名，实时与重建也就不会改出两个名字（附录 B 第 35 条）。 |
| `attempt_id` | 产生该块的 provider attempt，即现在的 `OutputContentAccumulator.attempt`。丢弃某个 attempt 时按它精确删除，不再按数组下标基线截断。 |

旧数据的块 id 按确定性规则 `${messageId}:${index}` 生成：多个物理块合成一块时，index 取组内第一个下标（§10.2）。这样回填前后 id 不变。id 对所有读取方都是不透明字符串，不解析其结构。

### 3.3 块的种类

5 种 kind 按「谁写的、怎样产生」划分，内容形态交给 part：

| kind | 是什么 | 所在信封 | payload / part | 模型可见 |
|---|---|---|---|---|
| `input` | 一个参与者写的一条输入，参与者可以是人，也可以是经 mailbox 投递的其他代理 | user，一信封一块 | part：`text`、`image`、`file`、`file_ref`；可带 composer 文档 `doc` | `done` 时可见：`model_text` 加图片 part |
| `output` | assistant 的一个可见输出 item | assistant 步 | part：`text`（带 citations）、`image` | `done` 或 `aborted` 时可见 |
| `reasoning` | assistant 的一个推理 item，含 redacted | assistant 步 | part：推理分段（`text` part，`segment` 取 `summary` 或 `content`）；redacted 时没有 part | `done` 时按携带策略（§7.4） |
| `tool` | 一次工具调用及其被采用的结果 | assistant 步 | `input`、`executor`、`issuer`、`result`（§3.7）；工具名存 `subtype` | `done` 时调用与结果成对可见 |
| `context` | 系统或运行期写的一切单块内容：注入、提醒、控制标记、UI 卡片 | user、sys、system 或 disp，一信封一块 | `subtype` 加 `body`（UI 用的结构化正文） | `done` 且 `model_text` 非空时可见 |

**`context` 按 subtype 分三族。** 族只是文档上的分组，存储上只有 subtype：

| 族 | subtype | `model_text` | 专属行为 |
|---|---|---|---|
| 注入与提醒 | `system_injection`、`spec_continuation`、`knowledge_hint`、`merge_summary`、`review_feedback`、`tool_loaded`、`tool_unloaded`、`turn_nudge`、`broken_call`、`reminder`（§7.7）等 | 有 | 无 |
| 控制标记 | `compact`、`plan`、`clear_context`、`segment_compact`、`file_history_checkpoint`、`epoch` | 只有完成的 `segment_compact` 有 | 有 lifecycle（`open` → `done`/`failed`）；`compact`、`epoch` 开启纪元（§7.7）；`segment_compact`、`file_history_checkpoint` 经 `refs.segment_compact_id` 隐藏 ref |
| UI 卡片 | `error`、`info`、`ask_in_passing`、`subagent_recovery`、`cwd_recovery`、`spec_goal_added`、`publication_result` 等 | 无 | 状态写 `state` |

**为什么把前两轮的 `marker`、`notice` 并进 `context`**（D22）
- 三者都由系统写、一信封一块、写入后只改 `state`。
- 读写方真正分支的依据是 subtype（compact 与段压缩的行为完全不同），不是 kind。
- 模型可见性在三者里本来就由「有没有 `model_text`」决定：段压缩完成后有，compact 没有，卡片没有。并成一种之后，规则只剩一条：**非 assistant 块，`done` 且 `model_text` 非空即可见**。
- 部分索引、启动恢复、COW 都少一个分支。

**`input` 和 `context` 按作者区分，不按 role 区分。**
- role=user 不等于人类输入。自动续跑、批准反馈、审查检查、`/load` 通知、段压缩标记现在都是 role=user 的行（`orchestrator.ts:2740-2915`；`narrator-service.ts:539-630`），sender 投影因此可能把它们当成人写的（附录 B 第 4 条）。
- 改为：人或其他代理写的才是 `input`，其余都是 `context`。协议上需要的 role 仍由信封决定。
- 一条不变式：`input` 只出现在 role=user 的信封里；assistant 信封里只有 `output`、`reasoning`、`tool`；`context` 不出现在 assistant 信封里。store 写入时检查，违反即抛错。

**`output` / `reasoning` 的粒度是 provider 的原生输出 item：**

| provider | `output` 块 | `reasoning` 块 |
|---|---|---|
| Anthropic | 一个 text content block | 一个 thinking 或 redacted_thinking block |
| Responses | 一个 message item，多个 output_text 成为 part | 一个 reasoning item，多段 summary（或 content）成为 part |
| Gemini generateContent | 连续的 text part 合成一块；带签名的 part 结束当前块 | 连续的 thought part 合成一块，同样在签名处断开 |
| Gemini Interactions | 一个 model_output step | 一个 thought step，多段 summary 成为 part |
| Chat Completions / 插件 | 该步的 content | 该步的 `reasoning_content`，或插件的 reasoning |

这样带来两点好处：
- 凭据（签名、encrypted_content、item id、phase、step id）总是落在它所属的那一块上。
- Responses 的多段 summary 不再在落库时被压成一段（现在用 `\n\n` 拼接，`openai-provider.ts:2288-2303`），前端也不必再从 `**标题**` 反推步骤。

**part 类型在所有 kind 之间共用：**

| part | 字段 | 用在 |
|---|---|---|
| `text` | `text`、`citations?`、`segment?` | input、output、reasoning |
| `image` | `assetId`、`mediaType`、`width?`、`height?`、`name?`、`sha256?` | input、output、tool 结果 |
| `file` | `assetId`、`name`、`size`、`mediaType?` | input（text_file） |
| `file_ref` | `reference`、`snapshotText`、`snapshotHash`、`capturedAt` | input |

用户图片、工具结果截图、生成的图片因此共用一套投影，包括磁盘还原、按协议能力放置、NUG 的 sha256 引用。块与上传文件的引用关系另由 `narrator_block_assets` 记录（§4.1），供孤儿回收与保留策略使用。

### 3.4 正文、状态、凭据三分

| 列 | 内容 | 可变性 | 影响模型历史 revision | 共享信封上的修改 |
|---|---|---|---|---|
| `payload` | 块正文与 part | 信封可共享之前可以随流式更新；之后不可变，编辑产生新 revision | 是 | 必须 COW |
| `model_text` | `input`、`context` 的模型可见文本，写入时冻结；assistant 块恒为 null（它们的模型可见文本就是 part） | 同上 | 是 | 必须 COW |
| `state` | 非模型可见的可变元数据，见下 | 随时 | **否** | 原地更新，所有持有者可见，与现状一致 |
| `provider_meta` | 产出来源与上游原样骨架（见下），只有 assistant 块有 | 随正文写定 | 是 | 必须 COW |

`state` 收纳：
- reasoning 的翻译（按 part）；
- review 的 `applied`、merge summary 的 `isLatest`；
- 卡片 status、ask_in_passing 的 resolved；
- compact 的 attempts、mode、error；
- tool 的并行组标注（`execGroup`）。

`model_text` 的规则：
- **`input`**：用户正文（含 quote 与占位符）加附件提示，写入时一次生成。
  - 附件提示里的路径也在此时确定，投影不再读文件系统（现状见 `attachment-projection.ts:99-118`）。
  - sender 标记不进 `model_text`，由投影按信封作者生成。
- **`context`**：沿用原生注入的 `modelText`（`shared/native-injection.ts:20-48`），并推广到所有系统文本。
- **不再回退 `content_text`。** 现在块里没有文本时会回退到 `content_text`；今后 `/bash` 命令、`/load` 通知、段压缩摘要都显式写 `model_text`。

`provider_meta` 的形状：

```
{ source: string,      // 产出它的上游，即现在的 signatureSource 键，如 "codex"、"nug:<channel>:anthropic"
  wire?: object,       // output / reasoning：上游 item 原样骨架；tool：调用 item 的骨架
  result?: object }    // 只有 executor = "provider" 的 tool：结果 item 的骨架
```

**骨架 = 上游返回的原始 item，去掉模型可见的正文。** 正文换成 part 引用 `{"$part": i}`，其余字段（id、status、phase、signature、encrypted_content、annotations、未知的新字段）按上游的键顺序原样保留。同源回放时，第二段把 part 填回骨架，得到与上游逐字节相同的 item。骨架取自 item 完成时的上游原文：Responses 是 `response.output_item.done` 里的 item（Codex WS 续写的基线也是它，`codex-websocket.ts:757-760,1719-1720`），Anthropic 是 `content_block_stop` 时累积完的块，Gemini 是收到的 part。

| 上游 | `wire` 里留下什么（正文换成 part 引用） |
|---|---|
| Anthropic | `thinking`：`signature`；`redacted_thinking`：`data`；`text`：`citations`；`tool_use`：`id`、`name` |
| Responses | message：`id`、`status`、`role`、`phase`、各 `output_text` 的 `annotations`；reasoning：`id`、`encrypted_content`、`summary` / `content` 的分段结构；function_call：`id`、`call_id`、`name`、原始 `arguments` 字符串、`status` |
| Gemini generateContent | part 的 `thought`、`thoughtSignature`；functionCall 的 `id`（上游给了才有）、`name`。合成一块的连续 part 各留一份骨架，按顺序组成数组 |
| Gemini Interactions | step 的 `type`、`id`、`signature`、summary 分段结构 |
| Chat Completions | 无（`reasoning_content` 只有文本，没有凭据），`wire` 为空 |
| 插件 | 插件给出的 `continuation`（`remote-provider-adapter.ts:373-423`） |

为什么不按字段白名单存（前两轮的 `anthropic? / openai? / gemini?` 形状，D24）：
- 白名单每遇到上游新增字段就要改 schema。Responses 的 `phase`、function_call 的 item id、Gemini 普通 text part 的签名，都是因为白名单漏了才没落库（§1.3 E）。
- Codex WS 增量续写要求逐项 JSON 相同，包括键顺序（`codex-websocket.ts:255-267`）。只有存原样骨架才能由构造保证，白名单只能靠测试逐个补字段（§7.3）。
- 跨源时第二段完全不读 `wire`，只用 part 降级或丢弃（§7.4），所以骨架里多存的字段不会泄漏到别家。

两条细则：
- **工具参数。** function_call 的骨架保留上游原始 `arguments` 字符串。第二段在 `JSON.parse(arguments)` 与块的 `input` 深相等时回放原始字符串（字节不变），否则序列化 `input`（D2：回放实际执行的输入）。其他协议同理。
- **大字段。** 上游 item 里的二进制（image_generation 的 base64 结果）不进骨架，落盘成 asset，骨架里换成 `{"$asset": id}`。

tool 的调用侧和结果侧分开存，与 AI SDK 的 `callProviderMetadata` / `resultProviderMetadata` 一致（附录 C.3）：
- **调用侧**（`wire`）：Responses 的 `fc_` item id、Gemini 的 thoughtSignature。后者不再嵌进账本 `input_json` 的保留键（`narrator-persistence.ts:515-536`），也就不会再泄漏给别家（附录 B 第 34 条）。
- **结果侧**（`result`）：只用于 provider 执行的工具，例如 `web_search_call`、`image_generation_call` 的结果骨架。

### 3.5 生命周期 `phase`

全部 kind 共用 4 个 phase：

| phase | 含义 | 对模型 | 信封可共享 |
|---|---|---|---|
| `open` | 还没完成：item 在流式中、工具在等结果、compact 在进行 | 不可见 | 否 |
| `done` | 正常完成 | 可见（`context` 还要有 `model_text`） | 是 |
| `aborted` | 被中断，已产生的内容保留；只用于 output / reasoning | output 可见，reasoning 不可见（D4） | 是 |
| `failed` | 完成但作废：broken 工具调用、失败的 compact / 段压缩 | 不可见 | 是 |

```
output / reasoning:  open ──▶ done | aborted
tool:                open ──▶ done ──┐  重跑被拒工具：新 attempt，回到 open
                       ▲             │
                       └─────────────┘
                     open ──▶ failed       输入损坏（broken），永不执行
context:             写入即 done；控制标记 compact、段压缩为 open ──▶ done | failed
```

前两轮 tool 用了 `open`（输入流式中）、`called`（等结果）、`settled`（有结果）三个名字。收成一个 `open` 的理由（D23）：
- 输入流式阶段只走 WS，从不落行（§5.2），数据库里看不到它，不需要名字。
- `called` 与 output 的 `open` 在所有规则里待遇相同：对模型不可见、阻止共享、启动恢复要处理。差别只在恢复动作，而恢复本来就按 kind 分支。
- `settled` 与 `done` 同义。
- 结果：部分索引、触发器条件、共享判定都只看 `phase = 'open'` 一个值。

`tool` 在 `open` 期间：
- 可能等权限、等前台子代理，或被 continuation 挂起并跨越重启（`tool-continuation-service.ts`）。
- 块行与账本 attempt 1 在**同一个事务**里插入。现在是分两步写的（`narrator-persistence.ts:2210-2333` 与 `2385-2420`）。
- 被采用的 attempt 到达终态（success / fail）时进入 `done`，调用与结果成对对模型可见。
- `done` 之后被采用的结果仍可能改变：detach 的真结果覆盖中断占位、Agent 结论被改写、遗弃清扫补写（`run.ts:996-1049`；`abandoned-tool-cleanup.ts:97-121`）。每次改变都是这一块的新 revision，phase 不变。
- broken 输入直接进入 `failed`：对模型不可见，同时写一条 `context` 块（subtype `broken_call`）说明被移除的调用（§5.3，D11）。这与实时路径一致：实时路径剔除 broken 调用并加提醒（`loop.ts:7583-7619`），而现在的重建路径会把它们重放出来。

由此带来的规则：
- **信封可共享 ⇔ 信封里没有 `open` 的块。**
  - fork 只共享可共享的信封；工具执行期间 fork，子叙述者拿到的是上一步为止的历史。
  - 这取代了现在「排除进行中 compact」的特例。
  - 也修复了 partial 行先被共享、后被原地追加的问题（`narrator-persistence.ts:2208-2333`；`narrator-session-state.ts:895-901`）。
- **块在信封可共享之前可以原地修订**，例如迟到的签名、引文回补（`output-content.ts:175-200`）。此后模型可见内容只能经编辑 API 产生新 revision，共享时走 COW。
- **启动恢复只扫 `phase = 'open'` 的部分索引**，按 kind 处理：
  - output / reasoning → `aborted`；
  - 控制标记 → `failed`；
  - tool 不动，由账本与 continuation 服务决定。
  - 这取代了 `recoverStaleCompactingMessages` 和冷启动对 `completed:false` 的清理。
- **模型可见性是 (kind, phase, model_text) 的纯函数**：

  | kind | 可见条件 |
  |---|---|
  | `output` | `done` 或 `aborted`（`aborted` 的 text 照常重放，因为用户已经看到） |
  | `reasoning` | `done`（`aborted` 的凭据不完整，不重放），再经携带策略（§7.4） |
  | `tool` | `done` |
  | `input`、`context` | `done` 且 `model_text` 非空 |

  此外只有两条规则能让一块不出现：携带策略判为 `drop`（§7.4）；subtype `reminder` 在它所属的纪元之后跳过（§7.7）。没有别的开关。

### 3.6 轮、步、attempt、因果：写入时盖章

| 概念 | 定义 | 存放位置 |
|---|---|---|
| 轮（turn） | 一次运行：从叙述者被一次输入唤醒，到回到 idle 或等待用户为止，即 orchestrator 一个 active run 的生命周期（`orchestrator.ts:813`）。期间的插话、注入、自动续跑、错误卡都属于该轮；idle 时写入的卡片不属于任何轮 | 信封 `turn_id` |
| 步（step） | 一次 provider 响应，即一个 assistant 信封；同一步内的重试 attempt 共用这个信封 | 信封本身；轮内顺序就是 refs 的 seq，不另存序号 |
| attempt | 同一步内的一次 provider 请求；被丢弃的 attempt，其 item 块整体删除 | 块 `attempt_id` |
| 并行组 | loop 的 `groupToolExecutions` 给出的执行分组 | tool 块 `state.execGroup` |
| 工具采用 | 模型看到的是哪一次 attempt | tool 块 `payload.result.toolCallId`；账本 `block_id` |
| 因果 | 信封由哪个块引起，例如：<br>- 后台任务的完成通知 → 启动它的 tool 块<br>- 异步问答的答复 → AskUserQuestion 的 tool 块<br>- `/goal` 的确认卡与续跑注入 → `/goal` 的 input 块<br>- `/bash` 的合成 assistant 步 → `/bash` 的 input 块 | 信封 `cause_block_id` |

- `turn_id` 由 orchestrator 在一次运行开始时生成，随持久化上下文传给 store。
- 前端的 recency（最近两轮）、流式交接、工具排队都改为读这些字段，原来的三套定义合成一套（§8.3）。
- 因果链接让展示可以把后台通知挂在它的工具卡旁，也让删除可以提示连带内容；它不参与投影。现在一条 `/goal` 命令散落成三行，彼此没有关联。
- 子代理在自己的叙述者上有自己的轮。
- 前两轮设计还有一个 `step_index` 列。它是「同一 `turn_id` 内 assistant 信封按 seq 的名次」，可以由 refs 推出，没有读取方需要它在 SQL 里过滤，所以删去。

### 3.7 tool 块与账本

**tool 块**：一次调用及其被采用的结果。

```
subtype: 工具名                   // 唯一存放处，payload 不再重复
payload: {
  input,                         // 重放给模型的那一份（重定向、修复之后，D2）
  executor: "local" | "provider",
  issuer: "model" | "user",      // /bash 由用户发起
  result?: {                     // 进入 done 时写入
    toolCallId,                  // 被采用的 attempt（provider 执行的工具为空）
    isError,
    parts?: [image…],            // 工具结果里的图片（现在只在内存）
    appendix?: string            // 确实属于这个结果的附言（turn nudge 不放这里，见 D12）
  }
}
```

- **结果文本不复制进块**（D1）。它仍在账本被采用行的 `output_json`，账本的输入输出已约 1.5GB（`execution-log-service.ts:4-6`）。
- **turn nudge 不再随结果走**（D12）。现在它只拼在本轮最后一个工具的结果上，代码注释的理由是 loop 未必能走到下一个边界（`loop.ts:7271-7277`）。改为在该步最后一个工具进入 `done` 的同一事务里写一条 `context` 块（subtype `turn_nudge`），投影时排在该步工具结果之后、同一个 user 轮里，所以不依赖 loop 走到下一个边界。`appendix` 字段保留给今后确实属于某个结果的附言。
- **AskUserQuestion** 的作答仍写账本 attempt，模型经结果文本（"User answered: …"）看到。块的 `input` 不含作答，投影不再需要剥离（`question-model-input.ts:1-84`）。
- **provider 执行的工具**（web_search、image_generation）也是 tool 块，`executor = "provider"`，没有账本行。现在它们本来就是「调用和结果在一个块里」（`narrator-event-handler.ts:2141-2187`）。
- **`/bash`**：
  - 用户输入是一个 `input` 块，`model_text` 为命令原文。
  - 合成的 assistant 步里是一个 `issuer = "user"` 的 tool 块，`cause_block_id` 指回输入。
  - 现在 assistant 行里那个只给显示用的 `tool_result` 块不再需要（`narrator-service.ts:1117-1131`）。
- **重跑与迟到结果。** 重跑被拒工具时，在共享信封上先 COW 再开新 attempt，与现状一致（`narrator-persistence.ts:3397-3501`）。done 之后被采用结果的改变，在共享信封上按 `preserveExecutionOwner` 的语义处理：执行所有者原地更新，其他持有者保留克隆（`narrator-persistence.ts:4031-4058`）。

**账本行**：每个 attempt 一行，`block_id` 指向它执行的 tool 块。
- 重复的 toolUseId 不再有歧义，`#dupN` 和 `resolveToolCallWriteId` 里的猜测可以去掉。
- 被采用的 attempt 由块显式指向，不再在读取时用 `latestToolCallAttempts` 推导（`narrator-messages.ts:2026-2048`）。
- **内部执行**，如 Eval 的内部 Read（toolUseId 以 `internal_read_` 开头，`narrator-persistence.ts:3199-3263`），不挂块，以显式字段标记，投影一律跳过。现在构造器的向后兼容路径会把它们补成模型从没发过的调用（推测，附录 B 第 21 条）。

**投影**：tool 块拆成两部分。调用放进 assistant 轮；结果按协议放置，可能是下一个 user 轮里的 tool_result、function_call_output、role=tool 消息或 functionResponse。顺序就是块的 ordinal，即调用顺序。按名称加顺序配对的协议（Gemini generateContent 现在的 functionResponse 不带 id，`gemini-provider.ts:653-662`）因此总能配对正确：结果的顺序由结构保证，不再取决于账本行 id。

### 3.8 非 assistant 信封：一块

`input`、`context` 所在的信封恰好一块。现有的多块形态在这一块里合并：

| 现有形态 | 合并为 |
|---|---|
| user 输入 `[image…, text_file…, file_reference…, text]` | 一个 `input` 块，part 按原顺序排列，`model_text` 冻结 |
| 子代理收到的消息 `[附件…, text, system_injection(无 modelText)]`（`narrator-service.ts:2134-2165`） | 一个 `input` 块。那个注入块只用来表达发送者（`sender-projection.ts:40-53`），改为写进信封的作者字段 |
| review 结论 `[text, review_feedback]` | 一个 `context` 块：`model_text` 是 text，卡片进 `body`，`applied` 进 `state` |
| 注入 `[system_injection, subagent_messages…]`、旧格式 `[text, system_injection]` | 一个 `context` 块，伴随卡片进 `body` |

这条规则让「删除、回滚、选择、编辑都以整条为单位」由结构保证：不再依赖前端借用 blockIndex 0，也不再依赖 `injectionBlockViews` / `contextBlockViews` 的配对扫描。

## 4. 数据模型（schema 草案）

### 4.1 `narrator_blocks` 与 `narrator_block_assets`（新表）

```
narrator_blocks                                         小列在前，大 JSON 列在后（见下）
  id               text     PRIMARY KEY                 §3.2
  message_id       text     NOT NULL REFERENCES narrator_messages(id) ON DELETE CASCADE
  ordinal          integer  NOT NULL                    item 打开时分配，可不连续（§3.2）
  kind             text     NOT NULL                    input | output | reasoning | tool | context
  subtype          text                                 context 的子类型；tool 的工具名
  phase            text     NOT NULL DEFAULT 'done'     open | done | aborted | failed
  revision         integer  NOT NULL DEFAULT 0          正文版本；checkpoint、离开 open、编辑时递增
  wire_id          text                                 tool 的线上调用 id（§3.2）
  attempt_id       text                                 产生它的 provider attempt
  origin_block_id  text                                 COW lineage 的根
  model_chars      integer  NOT NULL DEFAULT 0          计入上下文的字符数
  byte_size        integer  NOT NULL DEFAULT 0          model_text + payload + state + provider_meta 的字节数
  created_at       text     NOT NULL
  completed_at     text                                 离开 open 的时间
  model_text       text                                 input / context 冻结的模型可见文本
  payload          text     NOT NULL                    JSON：块正文与 part
  state            text                                 JSON：非模型可见的可变元数据
  provider_meta    text                                 JSON：{source, wire?, result?}（§3.4）
  original_payload text                                 JSON：首次编辑前的正文，只用于 output
```

**列顺序有意义。** SQLite 按记录顺序存列，大值溢出到链式溢出页；读一行里排在大列之后的列，要先走过前面列的溢出页。所以定长与短文本列放前面，只读元数据的查询（启动恢复、共享判定、页面 API 的骨架、COW 预算）不必加载正文。

**约束**：让无效状态写不进去。`schema.ts` 已有用 `check()` 定义表级约束的先例（`server/db/schema.ts:182-192`），PG 生成器也能转译 CHECK（`scripts/generate-postgres-schema.ts:291`）。

| 约束 | 表达式 | 排除的无效状态 |
|---|---|---|
| kind 取值 | `kind IN ('input','output','reasoning','tool','context')` | — |
| phase 取值 | `phase IN ('open','done','aborted','failed')` | — |
| subtype 归属 | `(subtype IS NOT NULL) = (kind IN ('tool','context'))` | 没有子类型的 context；带子类型的 output |
| aborted 归属 | `phase <> 'aborted' OR kind IN ('output','reasoning')` | 「中断了一半」的工具或输入 |
| input 不经历 open | `phase = 'done' OR kind <> 'input'` | 流式中的用户输入 |
| model_text 归属 | `model_text IS NULL OR kind IN ('input','context')` | assistant 块上的第二份正文 |
| provider_meta 归属 | `provider_meta IS NULL OR kind IN ('output','reasoning','tool')` | 系统块上的凭据 |
| wire_id 归属 | `(wire_id IS NOT NULL) = (kind = 'tool')` | 没有线上 id 的工具调用 |
| original_payload 归属 | `original_payload IS NULL OR kind = 'output'` | — |

CHECK 管不到的跨行不变式，由 store 在写入时检查，并有守卫测试：
- 非 assistant 信封恰好一块；`input`、`context` 只在非 assistant 信封里，`output`、`reasoning`、`tool` 只在 assistant 信封里（§3.3）。其中「至多一块」由下面的部分唯一索引保证。
- `wire_id` 在本叙述者可见历史内唯一（§3.2）。
- `phase = 'done'` 的 tool 块，`payload.result` 必须存在；provider 执行的工具之外，`result.toolCallId` 必须指向一行 `block_id` 等于本块的账本行。

**索引**

| 索引 | 用途 |
|---|---|
| `UNIQUE (message_id, ordinal)` | 读取一个信封的块（读路径唯一的块查询，§12.7），同时约束顺序 |
| `UNIQUE (message_id) WHERE kind IN ('input','context')` | 非 assistant 信封至多一块 |
| `(message_id) WHERE phase = 'open'` | 信封能否共享（一次索引探测）；启动恢复扫描。替代 `idx_messages_compact_pending` |
| `(origin_block_id) WHERE origin_block_id IS NOT NULL` | 按 lineage 解析永久链接、引用、评论 |
| `(subtype) WHERE kind = 'context'` | 按子类型查找：merge summary、compact 标记、纪元标记 |
| `(wire_id) WHERE kind = 'tool'` | 按 toolUseId 查找工具详情（兼容旧 API）；`wire_id` 唯一性检查 |

**大小上限**（建议值，P1 前用生产库副本的分布核对）

| 对象 | 上限 | 超出时 |
|---|---|---|
| 单块 `byte_size` | 4 MiB，与模型历史单批上限 `MODEL_HISTORY_BATCH_BYTES` 相同（`agent-runtime/model-history-query.ts:5`），保证一块总能放进一批 | output / reasoning：封块并记错误，后续内容开新块；input：在上传校验处拒绝；tool `input`：沿用现有工具输入上限 |
| `state` | 1 MiB（推理译文按 part 存，体量与推理相当） | 拒绝写入 |
| `provider_meta` | 1 MiB（encrypted_content 是大头） | 记错误，凭据置空，该块按跨源处理（降级或丢弃） |
| 单块 checkpoint 频率 | 块超过 256 KiB 后，最多每 2 秒一次 | 合并到下一次 |

```
narrator_block_assets
  block_id   text NOT NULL REFERENCES narrator_blocks(id) ON DELETE CASCADE
  asset_id   text NOT NULL                       上传文件 id，或文本快照的 sha256
  role       text NOT NULL                       input_image | input_file | output_image | tool_image | epoch_snapshot
  PRIMARY KEY (block_id, asset_id)
  INDEX (asset_id)
```

- store 写入含 `image` 或 `file` part 的块、或纪元标记块（§7.7）时，在同一事务里维护这张表。
- 孤儿上传回收与保留策略改为按 `asset_id` 查，替代 `LIKE '%"type":"image"%'` 全表扫描（`storage-service.ts:826-835`），而且能覆盖工具结果截图与生成的图片。
- `epoch_snapshot` 行的 `asset_id` 是 `narrator_text_snapshots` 的 sha256（§7.7）。两种 asset 共用这张引用表，回收逻辑相同：没有引用行即可回收。

说明：
- **不设 `narrator_id` 列。** 块属于哪个叙述者，一律经 refs → 信封判定。块的作者就是信封的作者。
- **不设 `search_text` 列。** 可搜索文本是 payload / model_text（tool 块再加账本里被采用的结果）的纯函数。`deriveEnvelope` 在同一事务里手上就有块，写块级 FTS 时直接算出来，不需要再存一份（§4.6、D6）。
- **`ordinal` 不重新编号。** 顺序在 item 打开时就确定（§3.2），落库先后无关。

### 4.2 `narrator_messages` 新增列（只做 `ALTER … ADD`）

| 列 | 含义 |
|---|---|
| `body_format integer NOT NULL DEFAULT 1` | 1 = `content_json` 是权威；2 = 块行是权威 |
| `turn_id text` | §3.6 |
| `author_narrator_id text` | 不可变的作者，COW 时保留；为 null 时视为 `narrator_id`（旧行）。sender 投影和归属展示读这一列（§6.3）。其他代理经 mailbox 投递的消息也写在这里（§3.8） |
| `cause_block_id text` | §3.6 |
| `provider_response_id text` | provider 的响应 id。现在 `sdk_message_uuid` 会被当作 item id 回放；以后 item id 由各块的 `provider_meta.wire` 携带，这一列只记响应 id |
| `body_bytes integer NOT NULL DEFAULT 0` | 派生：本信封全部块的 `byte_size` 之和，由 `deriveEnvelope` 维护。读路径按它切批，不必为了算批大小读正文（§12.7） |

已有列在 `body_format = 2` 下的语义：

| 列 | 语义 |
|---|---|
| `content_json` | P1–P2 期间写入由块派生的兼容投影（供回退开关使用）；P3 起新行写 `'[]'`（§10.4） |
| `content_text` | 由块按统一规则派生（§4.6）；只在信封封口、工具进入终态、编辑或删除时重算，不在 checkpoint 或单个 item 封闭时重算 |
| `context_chars_json` | 由块的 `model_chars` 和 kind 派生，context stats 触发器不变 |
| `original_content_json` / `compact_pending` | 只对 `body_format = 1` 有意义 |
| `body_revision` | 块触发器同样会 bump 它（§4.5） |

### 4.3 `narrator_tool_calls` 新增列

- **`block_id text → narrator_blocks.id`**：这次 attempt 执行的 tool 块。
  - 新写入的非内部行必填；旧行为 null。
  - COW 克隆账本行时，`block_id` 重映射到克隆后的块。
- **内部执行标记**：现有的内部执行行（`createInternalRead` 写入，toolUseId 以 `internal_read_` 开头）改为显式标记。它们的 `block_id` 为 null，投影与展示配对都跳过。

### 4.4 `narrator_turns`（P1 建，D7）

一行是一次运行（D3），`id` 就是信封上的 `turn_id`。

| 列 | 说明 |
|---|---|
| `id text primary key` | 运行开始时生成，写进这次运行产生的每个信封的 `turn_id` |
| `narrator_id text not null` | 执行这次运行的叙述者，随叙述者删除级联 |
| `status text not null` | `running`、`completed`、`interrupted`、`failed`；CHECK 约束 |
| `trigger_message_id text` | 触发这次运行的信封（用户输入、自动续跑、定时任务等）；为空表示无输入触发 |
| `started_at text not null`、`ended_at text` | 运行起止时间 |
| `stop_reason text` | 结束原因：模型自然停止、用户中断、达到 maxTurns、错误等 |
| `step_count integer`、`tool_call_count integer` | 本次运行的 provider 请求次数与工具调用次数 |
| `usage_json text` | token 用量与费用汇总（输入、输出、缓存读写），按模型分项 |

- 索引：`(narrator_id, started_at desc)`，供轮列表与 External API 的游标分页。
- 写入只有两次：运行开始时插入一行（`running`），运行结束时更新一次。计数和用量在内存里累加，结束时一次写入；运行中途不写这张表。
- 启动恢复：仍为 `running` 的行改为 `interrupted`，`ended_at` 取它最后一个信封的时间。
- fork 共享信封时，`turn_id` 仍指向原叙述者的那一行；轮表行不复制。`turn_id` 只是分组键，不设外键：原叙述者删除后，fork 里的信封仍能按 `turn_id` 分组，只是没有汇总数据可显示。
- 用途：轮级 UI（本轮用时、工具次数、用量、停止原因），External API 的轮列表，以及按轮的用量统计。

### 4.5 revision 触发器契约 v2

块表触发器，SQLite 与 PG 各一套。动作都是：bump 所属信封的 `body_revision`，并 bump 所有持有者叙述者的 `model_history_revision`（与现有 `holderUpdate` 相同）。触发条件：

| 事件 | 条件 |
|---|---|
| INSERT | `NEW.phase <> 'open'` |
| DELETE | `OLD.phase <> 'open'` |
| UPDATE OF `payload, model_text, provider_meta, kind, subtype, ordinal, phase, message_id` | `NOT (OLD.phase = 'open' AND NEW.phase = 'open')` |

要点：
- **`state` 的变化不触发。** 这就把「UI 状态让模型历史失效」从根本上去掉了。
- **流式 checkpoint 与工具执行不触发。** 块离开 `open` 时触发一次；tool 从 `done` 回到 `open`（重跑）也触发，因为调用与结果从模型历史中消失。phase 收成 4 个之后，三个条件都只比较一个值。
- **信封表上监视 `content_json` 的触发器只对旧格式生效。** 双写期间原生信封也写兼容的 `content_json`；如果信封表的触发器照旧监视它，同一次修改会 bump 两次。v2 给这些触发器加条件 `body_format = 1`。
- **账本触发器保留。** 被采用的结果文本仍在账本（D1），所以 v1 里监视 `narrator_tool_calls` 的触发器照旧保留；块表触发器不重复监视它。
- **只对原生信封生效。** 三个触发器的条件都再加一条「所属信封 `body_format = 2`」（一次主键查找）。物化与回填先在 `body_format = 1` 的信封下插入块，最后才翻转格式，所以「把旧数据换成块」本身不 bump 任何 revision；投影字节本来就相同（§10.2）。
- **契约版本升级。** 契约 id 改为 `model-history-v2`，运行时核对的触发器数量随之更新。
- **由生成器产出。** 生成器（`scripts/lib/generated-model-history-triggers.ts`）需要学会产出 v2，以「带版本的重装迁移」形式交付。finalizer 拒绝直接重建触发器表时，报错信息也指向这条路：`"Model-history trigger table rebuild requires a versioned reinstall migration"`（`scripts/finalize-sqlite-resource-migration.ts:744-751`）。
- **禁止手改迁移文件。** 不得手改 `drizzle/`，也不重复 0206 那种在生成结果后人工追加 SQL 的做法。
- **增量复用改为按块。** `model-history-delta` 仍按信封的 `body_revision` 判断哪些信封变了，然后只重读这些信封的块。

### 4.6 派生字段由一个函数生成

`deriveEnvelope(role, blocks, adoptedToolCalls)` 输出三项：`content_text`、`context_chars_json`，以及 P1–P2 期间的兼容 `content_json`。

**调用方式**
- 由 store 在同一事务内调用。
- 时机：信封封口（`sealStep`、单块信封写入）、tool 进入终态、编辑或删除之后。
- 单个 item 封闭时**不**调用（D28）。一步有 N 个 item 时，`content_text` 只写一次而不是 N 次，FTS 也只重建一次（§12.7）。流式中途的部分文本搜不到，这与「封口才算完成」一致；崩溃恢复把 open 块改为 `aborted` 时补算一次。

**派生规则**
- 第一版逐条复刻现状，包括 user 行的附件提示和控制行的哨兵字符串，所以 External API `detail=text` 的输出不变（`external-resource-service.ts:1559-1577`）。
- 只统一已知的不一致，即 assistant 行拼接用 `\n` 还是 `\n\n`。

**以哨兵字符串做查询条件的地方，改为查块**
- `eq(contentText,"[Compacting]")` 改为按块的 `subtype` / `phase` 查询。
- `isNotNull(contentText)` 改为「存在可见文本块」。

**块级 FTS（D6，P1 起）**
- 新建 `narrator_blocks_fts`：FTS5、trigram 分词（与现有三个索引一致，支持 CJK），contentless（`content=''`），rowid 取块行的 rowid。正文不再存一份。
- 写入时机与 `deriveEnvelope` 相同（D28）：一步封口、工具进入终态、编辑或删除时，变化过的块需要新的索引文本。流式中途不写。
- P3e 起，同步不在写入者的事务里分词：它把块记进 `narrator_block_index_queue`，后台任务在 db-worker 里算出文本，主线程按预算分批写入（见 P3e）。搜索因此比写入晚几百毫秒。
- 每块的索引文本：
  - `input`、`output`：`model_text`；
  - `reasoning`：推理分段原文；
  - `tool`：工具名 + 输入的紧凑 JSON + 被采用结果的文本（取自账本，截断到 64 KiB）；
  - `context`：有 `model_text` 时取它，UI 卡片取 `body` 里的标题与正文。
- 搜索结果返回 `blockId`，前端直接定位到块并高亮；列表仍按信封聚合显示。
- 迁移期两套索引并存：没有块的旧信封仍由信封级索引命中；回填（§10.3）为旧信封补写块级索引；回填完成后搜索只查块级索引，信封级 FTS 在 P3 退役（`content_text` 仍保留，供列表摘要）。退役的条件与做法见 P3c 实现说明。

**信封级 FTS 触发器（迁移期）**
- update 触发器改为 `AFTER UPDATE OF content_text`。
- FTS 触发器由运行期的 `ensureFts` 安装（`server/db/fts.ts:372-393`），不在 drizzle 迁移里。改动时要给触发器定义加版本号，并做 DROP + CREATE，因为现在用的是 `CREATE TRIGGER IF NOT EXISTS`，不会替换已有定义。

### 4.7 PG

- `narrator_blocks` 经 `scripts/generate-postgres-schema.ts` 转译生成，JSON 列用 `jsonText`。
- 不使用生成列；`phase` 是普通列，不受 PG 生成列表达式白名单的限制。
- PG 的块触发器用 AFTER 触发器，更新父信封和持有者；增量迁移通过 `db:generate:pg` 生成。
- 回填游标在 PG 上用 `(created_at, id)` keyset，因为 PG 没有 rowid。
- PG 的叙述者写路径尚未完成（目前只有 5 个持久化方法有 PG 实现，`narrator-persistence.ts:4466-4499`），所以本设计只要求 PG 的 schema 和迁移可以生成、可以检查，不要求 PG 写路径可用。

## 5. 写入路径

### 5.1 唯一写入层

**现状**：直接写 `narrator_messages` 的非测试文件有 22 个。

**目标**：收口成一个模块（暂名 `server/services/narrator-store/`）。只有它可以写以下数据：
- 信封的正文列；
- `narrator_blocks`、`narrator_block_assets`；
- refs；
- 账本中与块关联的列。

接口草案：

```ts
interface NarratorStore {
	// 非 assistant 信封：一信封一块
	appendSingle(tx, env: NewEnvelope, block: NewSingleBlock, ref: RefPlacement): BlockId;
	// assistant 步
	openStep(tx, env: NewStepEnvelope, ref: RefPlacement): MessageId;
	checkpointItem(tx, messageId, item: ItemCheckpoint): void; // 首次插入（open），之后只更新这一行
	closeItem(tx, blockId, phase: "done" | "aborted", final?: ItemPatch): void;
	discardAttempt(tx, messageId, attemptId): void;
	sealStep(tx, messageId, usage: EnvelopeUsage): void;
	// 工具
	callTool(tx, messageId, call: NewToolCall): { blockId: BlockId; toolCallId: string }; // 块 open + 账本 attempt 1
	settleTool(tx, blockId, toolCallId, settlement: ToolSettlement): void; // 采用、图片、附言 → done
	retryTool(tx, holderNarratorId, blockId): { toolCallId: string }; // 新 attempt，块回到 open；共享则先 COW
	failTool(tx, blockId, reminder: NewSingleBlock): void; // broken：块 failed，另写一条 context
	// 纪元与对账（§7.7、§7.8）
	changeTools(tx, narratorId, change: ToolChange): BlockId | null; // 改 enabledTools 并写 tool_loaded / tool_unloaded，同一事务
	openEpoch(tx, narratorId, epoch: EpochSnapshot): BlockId; // 写 epoch 标记块与 system 快照引用
	// 修改
	editBlock(tx, holderNarratorId, blockId, patch): BlockId; // 共享则 COW，返回新 id
	deleteBlocks(tx, holderNarratorId, blockIds: BlockId[]): void; // 共享则 COW；tool 连同账本
	patchState(tx, blockId, statePatch): void; // 不 bump revision，不 COW
	// 读取
	loadBlocks(messageIds): Map<MessageId, Block[]>; // 两种 body_format 都认
}
```

**约束**
- 所有方法都是同步的，因为 bun:sqlite 的事务里不能 await（`db/transaction-atomicity-contract.test.ts`）。
- 派生字段在方法内部重算。
- 广播在事务提交之后进行。

**P0 先收口，再改存储**
- P0 就把 22 个写入文件改为走这个接口，此时底层仍是 `content_json`。这样 P1 更换存储只发生在 store 内部。
- 收口的同时修掉现有的非原子写入：
  - tool_use 块与账本行分两步落库（`narrator-persistence.ts:2210-2333` 与 `2385-2420`）；
  - tool_loaded / tool_unloaded、/bash 的 ref 单独开事务追加（`narrator-persistence.ts:654-667`）；
  - `persistAssistantMessage` 在消息事务之后逐个 await 插入账本行（`2044-2081`）；
  - `overwriteToolCallInput` 分两次 await 读改写（`4073-4119`）。

### 5.2 流式：开 item → 单行 checkpoint → 封 item

1. **step 开始。** 分配信封 id（同一步内的各 attempt 共用）和 attempt id。不写库。
2. **item 打开。** provider 开始一个输出 item（content block、output item、part run、step）时分配块 id，广播 `block_opened {messageId, blockId, kind, ordinal, attemptId}`。不写库。
3. **delta。** 广播 `block_delta {blockId, part, revision, textOffset, text}`。
   - 只带增量。
   - 按帧合并（约 16–50ms），遵守 CLAUDE.md 关于 WS 高频输出要合并、节流的规则。
   - `part` 是块内分段的下标，例如 Responses 的 `summary_index`。前端可以按段封存，只重解析活动的那一段；现在为此在落库文本里插 `\n\n`（`openai-provider.ts:2288-2303`），以后不再需要。
4. **checkpoint。**
   - 首次：插入信封（如果还不存在）和块，phase 为 open。
   - 之后：只 UPDATE 这一块的 `payload`、`revision`。
   - 广播 `block_checkpoint {blockId, revision}`，不再广播整条消息。
5. **item 完成。** `closeItem(done)`：
   - 写入最终的 `provider_meta`（上游 item 的骨架，§3.4）；
   - phase 离开 `open`，触发一次 revision bump；
   - 不重算派生字段。
6. **工具输入完整。** `callTool` 在一个事务里插入 tool 块（phase 为 `open`）和账本 attempt 1（带 `block_id`）。
7. **工具结束。** `settleTool` 与账本的结果写入放在同一个事务里：写入被采用的 attempt、结果图片、appendix，phase 改为 `done`，重算派生字段。需要回合将尽提示时，同一事务里再写一条 `turn_nudge` context 块（D12）。
8. **step 结束。** `sealStep` 补写用量和 `provider_response_id`，重算 `content_text`、`context_chars_json`、`body_bytes`。
   - 不重写块，也不需要 COW。
   - 现在 `completeAssistantOutput` 为了写 `completed:true` 要走一次 COW（`narrator-output-recovery.ts:46-63`），这一步随之消失。
9. **信封变为可共享。** 信封里不再有 `open` 的块之后，fork 才能共享它（§3.5）。

**写入代价**
- SQLite 不能部分更新一个 TEXT 值，所以每个 checkpoint 仍要重写该块的 `payload`。不过开销只与这一块的长度成正比，不再与整条消息的长度成正比；超过 256 KiB 的块限频（§4.1）。
- open 块不触发 revision；FTS 只在封口时随 `content_text` 更新一次。逐项计数见 §12.7。

### 5.3 丢弃 attempt、中断、错误、broken、loop 文本

| 场景 | 现在 | 改为 |
|---|---|---|
| `attempt_discarded` | 按 `api_request_start` 时记录的块数基线截断数组。基线是数组下标，而块又按 `outputIndex` 排序插入，可能切错（推测，`narrator-event-handler.ts:1201-1211` 与 `output-content.ts:67-81`） | `discardAttempt(messageId, attemptId)` 删除该 attempt 的 item 块。<br>已经执行过的 tool 块保留，因为副作用已经发生。<br>投影时，同一信封里属于更早 attempt 的块单独成一个 assistant 轮并带上结果，排在当前 attempt 的内容之前，这样「thinking 必须在首位」一类约束仍然成立（§7.2）。<br>现在这些块留在信封里，重试请求却没带它们（`narrator-event-handler.ts:1318-1323`） |
| 用户中断 | 内容 flush 后保持 `completed:false`；之后运行中会重放，冷启动时又会删除 | open item 改为 `aborted`，重放规则见 §3.5。<br>执行中的工具照旧以 interruptedByUser 结束并进入 `done`；detach 的真结果稍后到达时，作为新 revision 替换 |
| 终止性错误 | `finalizeOrCleanupPartialMessage` 的三个分支在数组上做过滤 | 同样三个分支，改为按 kind / phase / 账本状态删除块行 |
| broken 输入 | 实时路径剔除调用并加提醒；账本存净化后的输入与 brokenToolCallResult；重建时又重放出来 | `failTool`：tool 块改为 `failed`（不可见），再写一条 `context` 块（subtype `broken_call`），内容是提醒原文。实时与重建一致 |
| loop 自造的文本 | brokenToolCallReminder、userContinue、reflection 纠正只在内存（`loop.ts:6445,6889,7130,7179,7617`） | 各写一条 `context` 块。loop 的其他提醒（relaxed_plan、knowledge hint、silent_progress）本来就落 sys 行，两者规则统一 |
| 冷启动 | 扫 compact 部分索引，并删除最后一条 assistant 中 `completed:false` 的块 | 只扫 `phase = 'open'` 的部分索引，一次处理完（§3.5） |

### 5.4 UI 状态写入

`patchState` 只做单行 UPDATE 加广播 `block_state`：
- 不 bump revision；
- 不 COW；
- 不触发 FTS。

下列现有写入点都迁到 `patchState`：

| 写入点 | 现在的问题 |
|---|---|
| `patchReasoningTranslation` | 没走 COW，却 bump 模型历史。改为按 part 存译文 |
| review 的 `markReviewFeedbackApplied` / `release` | 同上 |
| merge summary 的 `isLatest` | 之前要先 `LIKE` 全表扫描定位；定位改为按 `subtype` 查索引 |
| ask_in_passing 改为 resolved | |
| subagent_recovery 卡片 status | |
| compact 的 lifecycle（mode、attempts、error） | |

compact finalize 的 CAS 改为：

```sql
WHERE id = ? AND phase = 'open' AND revision = ?
```

即比较块的 `phase` 和 `revision` 列，不再对 JSON 路径做 `json_extract`。

AskUserQuestion 的作答不走 `patchState`：它是 attempt 的执行输入，仍写账本，模型经结果文本看到（§3.7）。

### 5.5 编辑与操作的目标

每个操作都落在一个块（或一组块）上，不再借用数组下标：

| 操作 | 目标 | 行为 | 修正的现状问题 |
|---|---|---|---|
| 编辑 user 输入并重新生成 | `input` 块 | 新 revision：`doc`、part、`model_text` 一起重新生成；截断其后的历史 | — |
| 编辑 assistant 文本 | 被点的那个 `output` 块 | 只改这一块；与新文本对不上的 citations 丢弃；首次编辑前的正文存 `original_payload`；`provider_meta.wire` 清空（`source` 保留），此后按纯文本投影，不再冒充上游原样 item | 现在合并全部 text 块，把工具之后的文字搬到工具之前（附录 B 第 20 条） |
| 恢复原文 | 同一块 | 回到该块的 `original_payload`，不影响其他块 | 整数组快照会复活已删的工具调用 |
| 删除、回滚到此 | 一组块 id | 共享信封走 COW；tool 块连同全部账本 attempt 一起删；`input` 整块；reasoning run 传整组 id | user 气泡只删第一个附件；run 只删最后一块；回滚截掉 run 后半（附录 B 第 18、19 条） |
| 删除并回退文件 | tool 块 | 由 `block_id` 找到全部 attempt 的执行证据 | 要求 tool_use 与账本行 1:1，重跑过的工具会失败（附录 B 第 24 条） |
| 重执行被拒工具 | tool 块 | `retryTool`：开新 attempt，块回到 `open` | — |
| AskUserQuestion 作答 | tool 块的当前 attempt | 写账本；结果文本对模型可见 | — |
| reasoning 翻译 | reasoning 块的 part | 写 `state`，不 bump revision | — |
| 卡片状态 | `context` 块 | `patchState` | 现在原地改 JSON 并 bump 模型历史 |
| 引用、永久链接、搜索跳转 | 块 id，可附 part 下标与字符区间 | 锚点 `b:<blockId>`，经 lineage 解析 | 锚点只到消息，COW 换 id 后失效（附录 B 第 25 条） |
| 复制 | 块或 run | 复制块的显示文本；`input` 复制用户原文，不带附件提示 | 复制 user 消息时会带出附件提示 |

编辑菜单只对 `output` 与 `input` 块开放。现在对所有 markdown 行开放，点系统行会被服务端拒绝（附录 B 第 23 条）。

### 5.6 场景走查

每个场景写出「什么时候写哪些块、什么 phase」，并核对三条不变式：**I1** 可共享的信封里没有 `open` 块；**I2** 模型可见性只由 (kind, phase, model_text) 决定（§3.5）；**I3** 实时请求与重建出的请求逐字节相同。

| 场景 | 写入（按时间顺序） | 不变式要点 |
|---|---|---|
| 正常一步 | `openStep` → 每个 item：首个 checkpoint 插入 `open` 块，之后单行 UPDATE → `closeItem(done)` 写骨架 → tool：`callTool`（块 `open` + 账本 attempt 1）→ `settleTool`（`done`）→ `sealStep` 派生 | I1：封口前信封不可共享；I3：loop 把同一块对象追加进 view（§7.3） |
| 崩溃在 item 中途 | 已落库的是最后一次 checkpoint 的 `open` 块 | 恢复：output / reasoning → `aborted`，补算派生；未落库的尾部 delta 丢失，与现在相同 |
| 崩溃在工具执行中 | tool 块 `open`，账本行非终态 | 恢复不动块，由账本与 continuation 决定 settle 或补 fail（`tool-continuation-service.ts`） |
| 用户中断 | open item → `aborted`；执行中的工具以 interruptedByUser 结果 `done` | aborted reasoning 不可见（D4）；detach 的真结果迟到时是新 revision |
| 同一步重试（attempt） | 新 `attempt_id`；被丢弃 attempt 的 item 块 `discardAttempt` 删除；已执行的 tool 块保留 | 投影把保留的 tool 块放成更早的一轮（§5.3）；I3 由同一投影保证 |
| 重跑被拒工具 | `retryTool`：共享则先 COW；账本 attempt+1；块 `done` → `open` | 回到 `open` 触发 revision，调用与结果从历史消失，直到新结果 `done` |
| 权限请求 | 块保持 `open`，账本 `pending` | 不写块；权限状态只在账本 |
| broken 调用 | `failTool`：块 `failed` + `context/broken_call` | D11；I2：failed 不可见，提醒可见 |
| 子代理 | 子叙述者自己的信封与块；父侧的 Agent 调用是一个 tool 块，`open` 直到子代理结论成为结果 | 关联仍是 `parentToolUseId`（父侧 `wire_id`）与 `narrators.originToolCallId`（§6.5） |
| fork / COW | fork 复制 ref；共享信封上的修改走 `cowEnvelope`，块复制并指向 lineage 根 | I1 保证 fork 不会拿到写到一半的信封 |
| compact | `context/compact` 块 `open` → `done`（开新纪元，§7.7）或 `failed`；attempts 进 `state` | CAS 比较 `phase` 与 `revision`（§5.4） |
| 段压缩 | `context/segment_compact` `open`（不可见）→ `done` 写 `model_text`；被选 ref 的 `segment_compact_id` 指向它 | 段压缩是显式操作，允许改写前缀（§7.7） |
| 注入（mailbox、知识、spec） | `deliverInjection` 写单块 `context`，伴随卡片进 `body` | mid-pass 注入落在 seq 上的位置就是投影位置，不再拼进下一个 user turn（§7.3） |
| mailbox 消息被发送方修改 | 未采纳：原地改写该 `input` 块（新 revision）；已采纳：追加 `context/reminder` | D18 |
| assistant 编辑 / 删除 / 回滚 | `editBlock`、`deleteBlocks`；共享则 COW | 显式操作，允许改写前缀；编辑清空骨架（§5.5） |
| 翻译 | `patchState`（按 part） | 不触发 revision，前缀不变 |
| 跨 provider 切换 | 下一次请求前 `openEpoch(reason = target)` | 旧块的凭据按携带策略降级或丢弃（§7.4）；新纪元完整重建 |
| reflection 循环 | 不写块。reflection 拿到父请求所投影的行（父 transcript + 当前轮输入），自己的 prompt 与纠正轮写进它的内存 transcript，经同一投影发出，工具表沿用父请求的快照；前缀与父请求逐字节相同 | 结论经父侧 tool 块的结果（账本）回到历史；reflection 自己的轮次不入库，与现状相同（关掉了它的持久化回调） |
| 内部执行（`internal_read_`） | 只写账本行，`block_id` 为 null，带内部标记 | 不投影（§3.7） |
| `/bash` | `input`（`model_text` = 命令）→ 合成 assistant 步，一个 `issuer = "user"` 的 tool 块，`cause_block_id` 指回输入 | 不再有只给显示用的 `tool_result` 块 |
| plan mode | 进入 / 退出写 `context/plan` 标记；system 中的 plan 段冻结，变化追加提醒 | 工具描述的 plan 改写见 §7.7 |
| `/load`、`/unload` | `changeTools`：改 `enabledTools` 并写 `context/tool_loaded` 或 `tool_unloaded`，同一事务 | §7.8 |
| 前缀提醒 | 每次请求前对账，差异写 `context/reminder`（§7.7） | 只追加，I3 成立 |


## 6. 共享、fork 与 COW

### 6.1 不变的部分

- refs 仍以信封为粒度。
- fork 仍用 `INSERT…SELECT` 复制 ref（`narrator-service.ts:2959-2995`）。
- 惰性回填（`narrator-refs-backfill.ts`）、seq 的分配与移位语义都不变。

块只跟着信封走，fork 本身的成本不变。

### 6.2 不可变规则

1. **信封可共享之后，块的正文不可变**，这里的正文指 `payload` / `model_text` / `provider_meta`。在此之前（信封里还有 `open` 的块）只有写入方会改它（§3.5）；之后在被共享的信封上做编辑或删除，一律经 COW。
2. **共享判定要补上惰性 fork 的缺口。**
   - 现在只数 refs。惰性 fork 的子叙述者对祖先区间还没有 ref，所以父叙述者原地修改旧消息时，子叙述者回填后会看到修改后的版本（推测）。
   - 新判定：refs 数大于 1，或者存在一个惰性继承者，其待回填区间覆盖该 ref 的 seq。后者经 `refs_inherited_from` 的部分索引查询，是常数级开销。
3. **含 `open` 块的信封不参与共享**（§3.5）。

### 6.3 一个 COW 实现，作者与属主分开

`cowEnvelope(tx, messageId, holderNarratorId, mutate)` 取代现有的五套实现。步骤如下：

1. 复制信封。
   - 新行的 `narrator_id` 为持有者，用于属主与回收。
   - `author_narrator_id` 保留原作者。
2. 复制全部块：分配新 id，`origin_block_id` 取原块的 `origin_block_id ?? id`（即 lineage 根），然后应用 `mutate`。同时复制 `narrator_block_assets` 行。
3. 克隆账本行，沿用现有语义：
   - `executionOriginToolCallId` 指回原行；
   - 克隆行不可执行；
   - `block_id` 重映射到新块。
4. 把持有者的 ref 改指新信封。
5. 在同一事务里更新 mailbox 回执（`updateRecipientMessageRef`）。
6. 预算沿用现有上限（1000 个持有者、8MiB），改按信封的 `body_bytes` 计算，不读正文。

**为什么要把作者和属主分开**

现在几处 COW 对新行的 `narrator_id` 取值不同：
- 一处设为接收者（`narrator-persistence.ts:390-491`）；
- 一处保留原值（`revert-history-commit.ts:856-857`："historical authorship does NOT move to the fork owner"）。

而 sender 投影会读消息作者叙述者的标题（`model-history-query.ts:161-167`）。作者一变，模型看到的署名和请求字节都会跟着变。拆成两列之后：
- 属主可以随 COW 和「删除叙述者时转交」变化；
- 作者永远不变。

### 6.4 compact、段压缩、清空上下文

**compact 标记**
- 形态：role=system 的信封，内含一个 `context` 块（subtype `compact`）。
- 生命周期：phase 从 `open` 变为 `done` 或 `failed`；attempts、mode、error 记在 `state` 里。
- 进入 `done` 时同时开启新纪元：块的 `payload.epoch` 写入纪元快照（§7.7），不另写纪元标记。
- `refs.is_compact` 和 `narrators.context_summary` 的语义都不变。
- `compact_pending` 生成列及其部分索引，由块表的 `phase` 部分索引取代。

**段压缩标记**
- 现状：
  - 它是 role=user、没有 origin 的行，模型文本靠 `content_text` 回退（`narrator-persistence.ts:4166-4182`）。
  - sender 投影可能把它当作人类消息（推测）。
  - 压缩进行中，模型还会看到 `[Segment compacting]`。
- 改为：
  - 信封 role 保持 user，以保住协议位置；`origin = system`。
  - `context` 块（subtype `segment_compact`）在 `done` 时写入 `model_text`，以 `[Earlier conversation summarized]` 一类的前缀标明这是摘要。
  - phase 为 open 时对模型不可见。

**计划 / 清空上下文**：都是 `context` 块的 subtype（`plan`、`clear_context`），`refs.is_compact` 的写法不变。

**file_history_checkpoint**
- 仍用 `segment_compact_id` 指向自身来隐藏（`narrator-messages.ts:1662-1706`）。
- 块形态是 `context` / `file_history_checkpoint`；被克隆的账本行带上 `block_id`。

### 6.5 子代理、提取、注入、mailbox

| 对象 | 设计 |
|---|---|
| 子代理消息 | 关联方式不变：`parentToolUseId` 是父叙述者那边的线上 id，子代理与 Agent 调用的精确关联仍用 `narrators.originToolCallId` |
| 子代理收到的消息 | 一个 `input` 块；发送者写进信封的 `author_narrator_id` 与 origin，不再用一个无 `modelText` 的注入块表达（§3.8） |
| 子代理提升为 primary（extract） | 深拷贝信封、块和账本行（新 id，带 lineage）。现在不复制账本行，这些 tool_use 在模型历史里会被丢掉（`subagent-extract.ts`，推测） |
| 注入 | `deliverInjection` 写一个 `context` 块（subtype 为 `system_injection` 等），带 `model_text`；伴随卡片（`subagent_messages`）并入 `body` |
| loop 生成的文本 | broken 提醒、reflection 纠正、userContinue、knowledge hint 等都写 `context` 块（§5.3） |
| 后台任务与异步问答 | 完成通知、异步答复各写一条 `context` 块，`cause_block_id` 指向启动它的 tool 块（§3.6） |
| mailbox | `recipientMessageId` 的预留与 materialize 保持在信封粒度，不变 |
| 问题补充 | 读该信封唯一的 `context` 块的 `body.supplement`，不再读 `$[0]/$[1].body.supplement` |

## 7. 读取路径与 provider 投影

### 7.1 规范历史视图

```ts
interface HistoryView {
	envelopes: Array<{
		id: string;
		role: "user" | "assistant" | "sys";
		origin: Origin;
		author: { narratorId: string; title: string; username?: string };
		parentToolUseId: string | null;
		turnId: string | null;
		blocks: CanonicalBlock[]; // 只含模型可见的块（§3.5），按 ordinal 排序；同源判定读块的 provider_meta.source
	}>;
	adoptedOutputs: Map<string /* toolCallId */, { status: "success" | "fail"; output: ToolOutput }>;
	epoch: {
		markerId: string | null; // 最近一个开启纪元的块（compact 或 epoch）；旧数据为 null
		tools: NeutralToolDefinition[] | null; // 纪元开始时冻结的工具定义；旧数据为 null，按 §7.8 倒推
		system: SystemSections;   // 纪元开始时冻结的 system 各节（§7.7）
		senders: Record<string, string>; // 纪元开始时冻结的作者标题
	};
	tools: { managed: ReadonlySet<string>; current: ReadonlySet<string> }; // 工具加载的输入（§7.8）
}
```

前两轮的 `stepIndex` 与信封级 `source` 删去：前者可由 seq 推出（§3.6）；后者在同一步内并不唯一（同一步的不同 attempt 可能来自不同上游），只有块级的 `provider_meta.source` 是准确的。旧数据没有块级来源时，由解码从信封的 `provider` 列补上（§10.2）。

**加载器**
- 沿用模型历史 worker 和 `model_history_revision` 源缓存（`model-history-source.ts:334-445`）。
- 读取顺序：refs → 信封 → 块 → 被采用的账本行。账本行按 tool 块的 `result.toolCallId` 精确读取，不再先按行 id 排序、再推导最新 attempt。
- `body_format = 1` 的信封在 worker 里解码（§10.2）。
- 图片等二进制在 worker 里按 asset 预取。读不到的留空槽，规则与现在的 `orderUserContent` 一致（`user-content-order.ts:63-73`）。投影本身不读文件系统。

### 7.2 两段投影

```ts
toTurns(view: HistoryView, target: ProjectionTarget): NeutralTurn[]        // 第一段：与 provider 无关
toWire(turns: NeutralTurn[], target: ProjectionTarget): ProviderWireHistory // 第二段：各家线上格式
```

**第一段 `toTurns`** 决定结构，所有 provider 共用。
- **分组**
  - 每个 assistant 步投成一个 assistant 轮，其中的 output、reasoning、tool 调用按 ordinal 排列。
  - 同一信封里属于更早 attempt 的已执行 tool 块单独成一轮，连同结果排在前面（§5.3）。
  - 每个 assistant 轮之后紧跟该步 `done` 的 tool 结果，按 ordinal 排列，也就是调用顺序。
  - 从这之后到下一个 assistant 步之前的可见 `input`、`context`，按 seq 组成一个 user 侧分组。每项保留自己的 user / sys 角色，由第二段决定合成一条 user 消息还是拆出 system。
  - `tool_loaded` / `tool_unloaded` 块在分组里除了文本，还带一个中立的工具变更项（§7.8），由第二段按协议放置。
  - 本次请求的工具表也在第一段算出：`{active, deferredTail, placeholder}`（§7.8）。它与历史一起构成中立请求，第二段只做格式化。
- **内容**
  - `input` 投成 `model_text` 加图片 part。图片按 `[image #N]` 占位符就位，规则沿用 `user-content-order.ts:15-56`。
  - file_ref 展开为引用文本。
  - 按信封作者加 sender 标记，标题取 `epoch.senders`，纪元内第一次出现的作者取写入时的标题（§7.7）。
  - 旧行里的 `citeturn…` 标记由解码一次性清掉（§10.2），新数据本来就没有，投影不再处理。
  - tool 结果 = `outputToText(账本输出)` + `appendix` + 结果图片。
- **取舍**：每块按携带策略（§7.4）决定原生回放、降级为文本或丢弃。strict 只由裸 model 名计算一次。
- **跨块规则**：少数规则依赖上下文，例如 Await 问答回执要看同一请求里是否已有答复（`question-model-input.ts:112-165`）。它们是 view 的确定性函数，统一写在第一段，作为显式规则测试。
  - 这类规则只许「前面的内容影响后面的内容」，不许反过来。现在的回执规则是反过来的：后到的用户回执会把更早的工具结果缩短成一句引用（`question-model-input.ts:119-137`），等于改写已发送的前缀。改为只有 seq 更早的回执才能缩短后面的结果；后到的回执与更早的结果都保留全文（D26）。这样规则仍是纯函数，又天然只追加，不再需要「第一次投影时的判断」这种额外状态（§7.7）。

**第二段 `toWire`** 只做格式映射，不再决定结构：

| 中立结构 | Anthropic | Responses | Chat Completions | Gemini generateContent | Gemini Interactions |
|---|---|---|---|---|---|
| assistant 轮 | 一条 assistant 消息，content block 按 ordinal 排列；相邻同角色合并，首条补 user（`ensureAlternating`） | 平铺的 item | 一条 assistant 消息：content + tool_calls + reasoning_content | 一个 model content | 平铺的 step |
| output 块 | text block | message item：part → output_text；同源时带 itemId、phase | 拼进 content | text part，同源时带签名 | model_output step，同源时带 step id |
| reasoning 块 | thinking（strict 时仅同源带签名）或 redacted_thinking | reasoning item：part → summary / content；同源时带 encrypted_content，否则降级或丢弃 | reasoning_content（仅非 strict） | thought part，同源时带签名 | thought step，part → summary |
| tool 调用 | tool_use | function_call：`call_id = wire_id`，同源时带 item id | tool_calls | functionCall，带 thoughtSignature | function_call，签名用前置 thought step 表达 |
| tool 结果 | 下一条 user 消息最前面的 tool_result；图片放进 content | function_call_output；图片放进紧随其后的 user `input_image`，支持时放进 output 数组 | role=tool 消息；图片放进紧随其后的 user 消息 | functionResponse；不支持多模态结果时，图片放进随后的 user content | function_result，非错误结果可带图片 |
| provider 执行的工具 | web_search 投成 user 文本摘要；image_generation 跳过 | web_search_call / image_generation_call | user 文本摘要 | 跳过 | 跳过 |
| user 侧分组 | user 消息；官方 API 下 sys 项投成对话中途的 system，位置受约束 | user input_text / input_image；system 与 developer 汇入 `instructions` | user 消息 | user content | user_input |

说明：
- 表中各格是现有构造器行为的整理，各处偏差见附录 B 第 26 条起。第一版逐条复刻现状，只修正 §11 P0 列出的项。
- 「图片放进随后的 user 消息」是现在 Responses 实时路径的做法（`openai-provider.ts:3591-3611`）。Chat Completions 与 Gemini 现在直接丢图（`openai-provider.ts:1077-1088`；`gemini-provider.ts:361-378`）。统一之后，由第二段按协议能力决定放在哪里。
- Gemini generateContent 的 functionResponse 现在不带 id，按名称和顺序配对（`gemini-provider.ts:758-769`），同名并行调用可能配错（推测）。协议支持 id 时由第二段带上。

### 7.3 实时请求与重建合为一条路径

**做法**
- loop 持有一个 `HistoryView`。store 写入块之后，把**同一个规范块对象**追加进 view。
- 每次发请求都调用 `toTurns` 和 `toWire`。
- provider 接口删去 `pushAssistantTurn`、`pushUserTurn`、`formatToolResult`、`buildHistory`，只剩 `toWire` 和 `chat(wire)`。

**P0 的实现**（块表之前，行仍是 `DbMessage`）
- 行 → provider 历史只有一个入口：`buildAdapterHistory`（`server/lib/agent/history-build.ts`），宿主重建与 loop 投影都走它。
- loop 持有 `LoopTranscript`（`server/lib/agent/loop-transcript.ts`）：与 store 相同写入点、相同行形状的内存行（输入行、带账本的 assistant 步、结果结算）。宿主的行作为初值，每次重建替换它。
- 有宿主时，首个请求用宿主构造的历史，之后每个请求用 `rebuildRequestHistory`（DB 行）；没有宿主（reflection、搜索探针）或重建失败时，请求就是 transcript 的投影，`content` 为空。
- provider 接口已删去 `pushAssistantTurn`、`pushUserTurn`、`formatToolResult`，`BuiltHistory.trailingToolResults` 一并删除；`buildHistory` 暂作第二段入口，P1 改为 `toWire`。
- loop 内的 tool_use id 重映射随之删除：重复或不合规的 id 由投影里的 `uniquifyDbMessageToolUseIds` 统一处理。
- loop 内不再拼接字符串。当前轮由哪些单元组成、以什么顺序合并，完全由 seq 和第一段的分组规则决定。现在由三处各自拼接：`history.ts:238-243`、`orchestrator.ts:2007`、`loop.ts:3309-3311`。

**性能与缓存**
- 按信封记忆两段的结果，键为 `(envelopeId, body_revision, targetFingerprint)`。每次请求只投影新增或变化的信封。
- 前缀字节天然稳定，有利于 prompt cache。

**Codex WS 的增量续写**
- 前提条件：新请求必须是「上次输入 + 上游返回的原始 item」的逐项前缀（`codex-websocket.ts:259-292`）。
- 现状：本地重新序列化的 item 缺 `status`、`annotations`、`id`、`phase` 等字段，并且合并了 summary 分段。推测几乎每次有 assistant 输出之后，都会退化为全量 `response.create`。
- 要求：Responses 的 output、reasoning、tool 块经第二段投影后，必须还原出与上游原始 item 相同的 JSON。§3.4 的骨架由构造满足这一点：同源时第二段把 part 填回骨架，不重新序列化。测试只需钉住「填回 == 上游原样」一条。
- 工具加载的 `additional_tools` 项放在 input 里，不改顶层 `tools`，所以续写条件（去掉 input 后的请求必须相同，`codex-websocket.ts:752-756`）不受加载影响（§7.8）。

### 7.4 跨 provider 的携带策略集中在一处

`carryPolicy(block, target)` 按块返回三种结果之一：`native`、`degrade-to-text`、`drop`。同源判定只读块的 `provider_meta.source`，与 target 的来源键做相等比较（`shared/agent-protocol/reasoning-source.ts:56-62`）；缺失视为不同源。`native` 时第二段使用 `wire` 骨架，其余两种只用 part。

第一版逐条编码现有规则：
- Anthropic strict 模式下，外源签名整块丢弃；中转模式保留文本，签名置空。
- Responses 同源时回放 encrypted reasoning，否则降级为文本或丢弃。
- Gemini 的 thought 文本总是回放，签名只在同源时携带。
- 插件只携带同源的 continuation。

同时修正几处现状：
- strict 只由裸 model 名计算一次。现在 `buildHistory` 用的是带前缀的 model（`openai-provider.ts:695-699`），NUG 也是如此（`nug-provider.ts:383-397`）。
- message item id、Interactions 的 step id 只在同源时回放。现在不检查来源（`openai-provider.ts:3910-3919`；`gemini-interactions-provider.ts:697-754`）。
- image_generation 结果的读盘挪出主线程。现在投影时在主线程 `readFileSync`（`openai-provider.ts:3989-3996`），改为在加载器 worker 里预取。

### 7.5 冻结的、显式输入的、传输层的

投影必须是数据的纯函数。每样东西属于三类之一：

| 类别 | 内容 | 处理 |
|---|---|---|
| 写入时冻结进块 | 附件提示与路径；`/bash` 等命令的模型文本；wire-safe 工具 id；上游 item 骨架；turn nudge（作为 `context` 块）；broken 提醒与 loop 自造文本；工具加载事件与前缀提醒（`context` 块）；ExitPlanMode 计划正文的引用形态（随进入 `done` 冻结，现在随账本 status 变化，`strip-plan-body.ts:30-60`）；被采用的 attempt | 投影只读数据 |
| 写入纪元标记 | 纪元开始时的工具定义、system 各节、作者标题（§7.7） | 投影读最近一个纪元标记 |
| 投影的显式输入 | target（协议、裸 model、strict、官方或中转、能力、工具加载策略）；asset 字节是否可读 | 进 `targetFingerprint` 或 view |
| 投影之后的传输层 | NUG 的图片 sha256 引用与网关 ack 剥离（`nug-provider.ts:444-507`）；Codex WS 的续写判定 | 不影响投影结果的缓存 |

### 7.6 字节稳定性约定

- **同一版本内**：「从 DB 重建 == 实时发送」由构造保证，并由每个 provider 的等价测试兜底（§13）。
- **跨越投影切换的那次发布**：允许一次性的 prompt cache 未命中。这与 compact 之后换 conversationId 重新起缓存（`narrator-session-state.ts:471-478`）的代价同级，在发布说明里写明即可。

### 7.7 前缀保持：纪元内只追加，不改写

**原则**：在一个纪元内，发给模型的请求前缀只追加、不改写。存储可以修改，但模型看到的那份按日志对待：派生数据变了，就在末尾追加一个事件，而不是回头改已经发过的字节。换纪元时，按最新数据完整重建一次。

这样 prompt cache 只在换纪元时失效。前缀包含三层，按 Anthropic 的拼接顺序依次是工具定义、system prompt、历史（D15）。

**纪元边界**（D16）
- compact 成功。
- 切换 provider 或模型（`targetFingerprint` 变化）。
- 缓存肯定已冷：距上次请求的空闲时间超过该 target 的缓存有效期。例如 Anthropic 按所用的缓存档位（5 分钟或 1 小时）判断。有效期不确定的 provider 不按这条换纪元，保守处理。
  - 「上次请求」取本叙述者可见历史中最后一个 assistant 信封的 `created_at`，不另存时间戳。
  - 误判的代价有限：开启新纪元是「按最新数据重建」，最新数据与冻结值相同时，重建出的字节不变，缓存照样命中。
- 已实现的工具加载只把 compact 当作边界（`tool-loading.ts` 文件头注释，`95c68304`）。另外两种边界由本节的纪元标记块补上（§7.8）。

**现在会改写前缀的来源，以及纪元内的处理**

| 层 | 来源 | 纪元内的处理 |
|---|---|---|
| 工具定义 | `/load` 加载工具 | 按模型在 catalog 里声明的策略追加，前缀不变；没有可用策略时直接改 tools[] 并开启新纪元（§7.8） |
| 工具定义 | 绕过 `/load` 改变已加载集合：resident 模式变化、重启后预加载、知识或设置预加载 | 对账时补写一条 system 来源的 `tool_loaded` / `tool_unloaded`，按上一行处理（§7.8） |
| 工具定义 | plan mode 把禁用工具的描述换成「已禁用」（`loop.ts:2801-2816`），现在每次切换都重新格式化 tools[] | 纪元内不改描述；plan mode 的限制由 system 段的提醒表达，执行期由权限层拦截：plan mode 下有效权限模式为 `readOnly`，Write / Edit 另有专门处理（`narrator-permission.ts:806,841`）。`readOnly` 是否覆盖 `PLAN_MODE_ALLOWED_TOOLS` 之外的全部工具待核；不覆盖的部分在执行器补一条与「未加载工具」同样的拒绝。下个纪元按当时状态重建（D27） |
| 工具定义 | `/unload` 卸载工具、MCP 工具消失 | 纪元内只增不减：定义留在前缀里（工具表取自纪元快照，见下文「存储」），追加一条 `tool_unloaded` 说明该工具已不可用，执行器拒绝调用（未加载的 managed 工具被拒，注册表里已没有的工具返回 Unknown tool）；下个纪元再移除 |
| 工具定义 | 纪元中途出现的新工具（新连上的 MCP、插件工具） | 对账时写一条 system 来源的 `tool_loaded`，按策略送达；策略 5 则开启新纪元 |
| system prompt | 在线设备列表、默认设备是否可用（`narrator-prompt.ts:176-200`） | 冻结纪元开始时的文本；变化追加提醒，如「设备 X 已离线」 |
| system prompt | AGENTS.md 等项目说明（`narrator-prompt.ts:248-262`） | 冻结；文件变化时追加提醒，说明已更新，并附新内容或差异（体积受同样的上限约束） |
| system prompt | plan mode 开关、计划文件字节数（`narrator-prompt.ts:300-316`） | 冻结；进入或退出 plan mode、计划文件写入时追加提醒 |
| system prompt | cwd | 冻结；cwd 变化追加提醒 |
| 历史 | 叙述者标题、用户名（sender 标记） | 纪元内沿用旧值，**不提醒**（纯展示性变化，D17）；下个纪元生效 |
| 历史 | Await 问答回执的改写（`question-model-input.ts:112-165`） | 改为只许更早的回执缩短更晚的结果（§7.2 跨块规则），天然只追加，不需要记录状态 |
| 历史 | ExitPlanMode 计划正文的引用形态 | 已在工具进入 `done` 时冻结（§7.5） |
| 历史 | 历史图片读不到、附件路径变成 unavailable | 附件路径已在写入时冻结（§3.4）。图片 part 带 sha256；字节被保留策略或用户删除之后读不到，投成固定的占位文本。这是存储治理的显式操作，归入「不受约束的情况」，前缀核对记一次违例 |
| 历史 | agent 消息投递后被发送方修改（mailbox 语义编辑） | 接收方还没采纳的（`injection_consumed_at` 为空），原地改写；已经采纳的，原消息不动，追加一条「来自 X 的消息已修订为：……」（D18） |

**不受约束的情况**（本来就改变前缀，接受缓存失效）
- 用户显式的编辑、删除、回滚、段压缩。
- 用户手动「按最新数据重建上下文」：斜杠命令 `/refresh-context`（D19）。执行时调用 `openEpoch(reason = "manual")`，下一次请求按最新数据完整重建；不加界面入口。

**提醒的分级**（D17）
- 影响模型行为的变化追加提醒：设备、项目说明、plan mode、cwd、工具可用性、消息修订。
- 纯展示性的变化不提醒，纪元内静默沿用旧值：叙述者改名、用户改昵称。
- 提醒是 `context` 块，`subtype = reminder`，`body.topic` 标明类别（如 `system:devices`），`model_text` 简短。工具可用性的变化不走 `reminder`，走 `tool_loaded` / `tool_unloaded`（§7.8）。

**对账：每次请求前一次，差异写成块**

纪元内的「冻结值 + 已发提醒」与「当前实时值」不一致，就是要追加提醒的时候。把这件事收成一个动作：

```
reconcile(narrator, target, now):
  if 纪元边界成立（target 变化 / 缓存肯定已冷 / 工具策略为 replace_tools 且集合变了）:
      openEpoch(...)                    // 写纪元标记块，冻结最新值；之后不需要提醒
  else:
      for 每个被冻结的对象（system 各节、工具加载集合）:
          expected = 纪元冻结值 ⊕ 纪元内已写的提醒 / 工具变更块
          if expected != live: 写一条 reminder 或 tool 变更块
```

- loop 在每次 provider 请求之前调用它，与 §7.3 的「store 写块 → 追加进 view」走同一条路，所以写下的块马上出现在这次请求里，实时与重建一致。
- 规则「idle 时的变化随下一次运行的第一条请求发出」「同一对象变化多次只保留最后一条未发送的提醒」由此自然成立：对账只在请求前做，两次请求之间的多次变化只比较一次。
- 比较只用哈希，没有差异时不写库，开销是每次请求几次内存比较。
- 提醒带上它所属的纪元（标记块 id 写进 `body.epoch`）。进入新纪元后，正文已按最新数据重建，旧纪元的 `reminder` 在投影时跳过，但不删除。

**存储：纪元是历史里的一个标记块**（D25）

前两轮设计用两张旁表记纪元：`narrator_projection_epochs`（冻结的 system 与工具）和 `narrator_projection_overrides`（逐对象的冻结值）。改为不建旁表：

- **开启纪元 = 在历史末尾写一个 `context` 块。** compact 成功时就是那个 compact 块本身；其他原因（切换 target、缓存已冷、`replace_tools`）写 subtype `epoch` 的块，所在信封 role=system，对模型不可见。
- **块的 `payload.epoch` 存冻结值：**

  ```
  epoch: {
    reason: "compact" | "target" | "cold" | "tools_replaced" | "manual",
    target: string,                          // targetFingerprint
    tools: sha256,                           // 纪元开始时的工具定义（中立形态：名称、描述、schema）
    system: [{ key, sha256 }],               // system 各节的哈希；正文在快照表
    senders: { [narratorId]: title }         // 纪元开始时历史中各作者的标题
  }
  ```
- **工具定义与 system 正文按内容寻址存一次：**

  ```
  narrator_text_snapshots
    sha256      text PRIMARY KEY
    text        text NOT NULL
    byte_size   integer NOT NULL
    created_at  text NOT NULL
  ```
  纪元标记块经 `narrator_block_assets(role = 'epoch_snapshot', asset_id = sha256)` 引用它。内容不变的纪元（最常见的是「缓存已冷」）不新增快照行；回收按 `asset_id` 判断有没有引用，与上传文件同一套。
- **工具表取自快照。** 纪元内 tools[] 由快照里的定义按 target 格式化，再加上 §7.8 的占位与 deferred 尾部；注册表、MCP、描述文案的变化都不会改动它。纪元内的一切增减都是追加的 `tool_loaded` / `tool_unloaded` 块。
  - 已实现的版本不存基线，而是从当前集合沿可见历史倒推（§7.8）。块存储下倒推保留两个用途：没有 `payload.epoch` 的旧 compact 标记（回填前的数据）用它算基线；有快照时用它做一致性检查，不一致记前缀违例。
  - 前两轮考虑过只靠倒推、不存快照。倒推依赖「当前集合」与「managed 集合」都只经由提示行变化，而 resident 模式、预加载、能力天花板、MCP 都会绕过提示行；system 正文更是无法从历史倒推。
- **作者标题**：纪元内，`senders` 里有的作者用冻结值；纪元内第一次出现的作者用它第一个信封写入时的标题。两者都不随改名变化，换纪元时重取（D14）。

这样做的好处：
- **fork 不需要额外动作。** 纪元标记块就在历史里，fork 复制 ref 时一起带上，子叙述者第一次请求的前缀与父叙述者逐字节相同，可以命中父叙述者的缓存。前两轮的旁表要在 fork、惰性 fork、提取时各复制一遍。
- **compact 与纪元是同一个概念的两种来源**，读取时都是「最近一个开启纪元的块」，一次部分索引查询（`(subtype) WHERE kind = 'context'`）。
- **删除、回滚自动正确。** 回滚到纪元开始之前，纪元标记块随之被删，投影退回到更早的纪元或按最新数据重建，不会留下指向不存在位置的旁表行。

**前缀核对**
- 每次请求记录各段投影字节的哈希：工具定义、system 各节、每个信封。
- 下一次请求时比对。纪元没换、已发送部分的哈希却变了，就记为前缀违例，写进慢操作日志与请求证据，附上是哪一段、哪个信封。
- 这同时是测试网（§13），也是诊断缓存失效原因的工具。
- Codex WS 增量续写本来就要求逐项前缀相同（§7.3），前缀保持直接提高它的命中率。

**代价**
- 模型在纪元内会看到旧的标题、旧的 system 文本，靠追加的提醒获知变化。纪元越长，提醒越多。compact 与冷缓存会定期截断这种积累。
- 工具「只增不减」会让卸载后的定义继续占用 token，直到下个纪元。

### 7.8 纪元内加载工具：五种策略

`/load` 在纪元内加载工具时，按模型声明的能力与当前线上协议选一种策略（D20）。

> 这部分已先于块存储重构，在现有消息结构上实现（`95c68304`，主文件 `server/lib/agent/tool-loading.ts`）：纪元边界取最近一次 compact，加载事件来自现有的 `tool_loaded` / `tool_unloaded` 提示行。实现与线上字段见 `docs/AGENT_PROVIDERS.md`「会话中加载工具时保持缓存前缀」。块存储怎样接住这份实现，见本节末尾「从已实现形态到块」。

| # | 策略 id | 做法 | 适用 | 参考实现 | 前缀 |
|---|---|---|---|---|---|
| 1 | `anthropic_tool_addition` | 先在 tools[] 里放一个 `defer_loading` 的占位工具；加载时按 Anthropic API 的官方方式追加工具 | Claude 模型，`anthropic-messages` 协议 | pi | 保持 |
| 2 | `anthropic_deferred_tail` | 精简版的 1：同样要占位工具；新增工具不在 system 消息里放完整定义，而是把定义放到 tools[] 末尾并加上 `defer_loading` | DeepSeek 模型，`anthropic-messages` 协议 | deepseek-harness | 保持 |
| 3 | `openai_additional_tools` | Responses 的 additional tools 方式 | GPT 模型，`openai-responses` 协议 | codex 开源实现 | 保持 |
| 4 | `custom_injection` | 注入一条自定义消息提供新工具的 schema，tools[] 不变 | 推理设施对 schema 校验不严格的其他模型，任意协议 | — | 保持 |
| 5 | `replace_tools` | 直接改 tools[] | 都不支持时的兜底 | — | 失效；立即开启新纪元 |

各策略的线上字段（占位工具的形状、追加方式、模型调用新工具时的 id 与结果回传）以参考实现为准，实现前逐一核实。

**默认按模型名启用，用户可以禁用**

为减少 catalog 的维护量，默认值按模型名决定，不要求 catalog 逐个声明（D21）：

| 模型名包含（不区分大小写） | 默认启用 |
|---|---|
| `gpt` | `openai_additional_tools` |
| `claude` | `anthropic_tool_addition` |
| `deepseek` | `anthropic_deferred_tail` |
| 其他 | `custom_injection` |

- 匹配用去掉 provider 前缀之后的裸模型名，例如 `nug:claude-…` 按 `claude-…` 判断。去前缀的规则与 strict 判定共用同一个函数（§7.4）。
- 实现在名称默认值上加了文档记载的版本下限：Claude 要求 Opus 4.8+、Sonnet / Haiku 5.5+ 或 Fable / Mythos；GPT 在 OpenAI API 上要求 5.4+，Codex 后端要求 5.6+；版本号解析不出时照常启用（`tool-loading.ts:82-123`）。低于下限的模型得到空列表，即策略 5。
- 网关按路由后的模型名匹配：NUG 的 `toolLoadingTarget` 报告渠道协议与 `routedModel`（`nug-provider.ts:383-399`）；TokenDance 转给按协议选出的委托（`tokendance-provider.ts:282-284`）。插件 provider 不报告协议（`remote-provider-adapter.ts` 没有 `toolLoadingTarget`），一律策略 5。
- 优先级：用户配置 > catalog 显式声明（模型卡元数据键，暂名 `tool_loading_modes`，按优先级排列，可多种）> 按名称的默认值。
- 用户可以按模型禁用其中的某种方案，也可以整体关闭；禁用后只剩策略 5。配置走 catalog 现有的本地覆盖机制（`shared/model-catalog/card.ts` 的 `metadata` 与 provenance）。

**选择规则**
- 每种策略有它要求的协议：策略 1、2 要求 `anthropic-messages`，策略 3 要求 `openai-responses`，策略 4 与 5 不限。
- 加载时，在模型声明的列表里按顺序取第一个与当前 target 协议相容的策略。
- 都不相容就用策略 5。例如经 Chat Completions 协议访问的 Claude 模型，默认的 `anthropic_tool_addition` 不相容，会落到策略 5；需要的话可以在本地覆盖里给它加上 `custom_injection`。
- 同一个模型经不同通道（例如 NUG 的 anthropic 通道与 responses 通道）可能走不同协议，所以选择发生在投影时，按当时的 target 判断，而不是在加载时写死。

**存储与投影**
- 一次加载写一条 `context` 块，subtype `tool_loaded`；一次卸载写 subtype `tool_unloaded`。沿用现有提示行的名字，解码一对一。
  - `body = { toolNames: string[], label: string, definitions?: NeutralToolDefinition[] }`：`toolNames` 是这次实际变化的注册表工具名；`label` 是给人看的名字（可能是例程 id）；`definitions` 只在加载时有，是写入时的中立定义（名称、描述、schema）。
  - `model_text` 是提示原文，写入时冻结。
  - **存定义，不存策略。** 定义写入时冻结，与纪元快照里的工具同等对待，所以纪元内即使跨了一次发布，已发送的定义字节也不变。策略是 target 的属性，在投影时选（上面「选择规则」）；纪元内 target 不变，所以策略也不变。前两轮写的「payload 存工具定义与加载时选定的策略」与「选择发生在投影时」自相矛盾，以后者为准。
  - 已实现的版本在投影时从注册表解析定义，并且只接受静态描述的工具（`resolveLoadableToolDefinition`，`tool-loading.ts:171-176`）；现有 `OPTIONAL_TOOLS` 都是静态描述（`grep` 核对：动态描述只出现在 Bash、ExitPlanMode、SwitchWorkingDirectory 等核心工具）。块存储下改为写入时冻结，这条限制随之只作用于写入那一刻。
- 写入走 `changeTools`：改 `narrators.enabledTools` 与写块在同一事务。现在两者分开写，ref 还单独开事务追加（`narrator-persistence.ts:654-667`）。
- **第一段**为每个 `tool_loaded` / `tool_unloaded` 块产出两样东西：提示文本，以及一个中立的工具变更项 `{additions: [{name, definition?}], removals: [name]}`。按策略：
  - 策略 1：additions 带定义；removals 照发。
  - 策略 2：additions 只带名字，定义进本次请求工具表的 `deferredTail`。removals 不发：deepseek-harness 给 DeepSeek 声明的是只认加载的 `addition-only`。`cf036d13` 已按此实现。
  - 策略 3：additions 带定义；每个工具每纪元只声明一次；removals 不发，靠提示文本。
  - 策略 4：不产出变更项，把 schema 文本拼到提示文本后面；每个工具每纪元只拼一次。
  - 策略 5：不产出变更项；工具表直接跟随当前集合，并开启新纪元。
- **第二段**只放置：
  - Anthropic：本组 user 消息之后紧跟一条 `role: "system"` 消息，内容是 `tool_removal` / `tool_addition` 块，可以与同组的中途 system 文本合在一条里；请求头带策略对应的 beta。位置天然满足「紧跟 user、后面是 assistant 或末尾」。
  - Responses：提示文本那条 user 项之前插入一项 `additional_tools`。
- **工具表**也在第一段算出：`active`（纪元快照里的工具，顺序同快照）、`deferredTail`（策略 2：纪元内加载过的工具，按首次加载顺序）、`placeholder`（策略 1、2，且 `active` 非空）。三者都只随追加的块增长，所以纪元内已发送的字节不变。
- 卸载按 §7.7：纪元内定义不撤，执行器拒绝调用未加载的 managed 工具（`tool-executor.ts:891-899`）。

**换纪元：完全重新构建**
- 新纪元开始时，工具表按当时已加载的全部工具重新生成，直接放进 tools[]。
- 旧纪元里的 `tool_loaded` / `tool_unloaded` 块在新纪元只投提示文本，不再产出变更项或 schema 文本。提示文本保留，因为它记录的是用户真的执行过的命令；它与工具表一致，不会误导模型。
- 策略 5 改了 tools[]，本身就是一次失效，所以同时开启新纪元，按上述方式完全重建。

**切换模型或 provider**：本来就开启新纪元（D16），新 target 不需要兼容旧策略的线上形态。

**从已实现形态到块**

| 已实现（`95c68304`） | 块存储下 | 变化 |
|---|---|---|
| 提示行 `contentJson[0] = {type, toolName, toolNames, text}`（`narrator-service.ts:540-545,619-624`） | `context/tool_loaded`、`tool_unloaded`，`body.toolNames`、`body.label`、`model_text` | 解码一对一（§10.2） |
| 旧提示行没有 `toolNames`，读时按例程展开（`tool-loading.ts:202-208`） | 回填作业在服务端展开一次，写进 `body.toolNames` | 解码保持纯函数，不依赖运行期注册表 |
| `deriveToolLoadingState`：从当前集合沿可见历史倒推纪元基线（`tool-loading.ts:231-252`） | 基线取自纪元快照（§7.7）；倒推只用于没有快照的旧 compact 标记，以及一致性检查。窗口从「最近一次 compact 之后」改为「最近一个开启纪元的块之后」 | 补上 target 切换与缓存已冷两种边界 |
| 基线可能漂移：resident、预加载等没有提示行的变化会让倒推结果在纪元中途改变，tools[] 随之改变 | 对账（§7.7）把每次漂移补写成一个 system 来源的 `tool_loaded` / `tool_unloaded`；tools[] 只取快照 | 漂移变成追加，前缀不变 |
| 定义在投影时从注册表解析（`tool-loading.ts:171-176`） | 写入时冻结进 `body.definitions` | 跨发布也不改已发送字节 |
| `managed` 只含可选工具（`orchestrator.ts:924-943`） | 快照覆盖全部工具；MCP、插件工具的增减同样走工具变更块 | D15 的工具层完整覆盖 |
| `ToolLoadingChange` 经 `WeakMap` 挂在投影出的行对象旁（`tool-loading.ts:346-361`），构造器用 `toolLoadingChangeOf` 读 | 第一段产出的中立变更项，是 `NeutralTurn` 的一等成员 | 旁路通道消失 |
| 构造器弹出当前轮时单独保留它的变更（`anthropic-provider.ts:3171-3176`；`openai-provider.ts:4109-4114`） | 不再弹出当前轮（§7.3） | 特例消失 |
| `custom_injection` 在 `buildRuntimeHistory` 里改写提示行文本（`agent-runtime/history.ts:240-247`） | 第一段拼接 | 与其他策略同一处处理 |
| 策略在每次组装时按适配器解析（`tool-loading.ts:153-164`） | `ProjectionTarget` 的一个字段，进 `targetFingerprint` | 策略变化即 target 变化，开启新纪元 |
| 占位工具与 deferred 尾部在 `formatRequestTools` 里拼接（`tool-loading.ts:315-336`） | 第一段给出 `{active, deferredTail, placeholder}`，第二段格式化 | — |
| 执行器拒绝未加载的 managed 工具（`tool-executor.ts:891-899`） | 不变 | — |

迁移时这部分不需要单独的数据迁移：现有提示行由通用解码与回填转换；P0 把上表的投影逻辑挪进两段投影时，用已有的 `tool-loading.test.ts`、`loop-tool-loading.test.ts` 做字节等价测试。

### 7.9 逐协议投影

§7.2 的表给出结构怎样映射。本节逐个协议核对其余维度：凭据回放、图片、provider 执行的工具、工具 id 与配对、对话中途的 system、缓存、工具加载，以及哪些内容被降级或丢弃。「现状」列标出本设计要修正的偏差；没有标的格子与现状一致。

**A. 内容**

| 协议 / 通道 | 凭据回放（同源才用 `wire`） | 用户图片 | 工具结果图片 | provider 执行的工具 | 工具 id 与配对 |
|---|---|---|---|---|---|
| Anthropic 官方 | strict（Claude）：thinking 同源回放，否则整块丢弃，不存在无签名的 thinking（`shared/agent-protocol/reasoning-source.ts:44-50`）；redacted 只在同源时回放 | image block，按占位符就位 | 放进 tool_result 的 content | web_search 投成 user 文本 `[Web search: q]`（`anthropic-provider.ts:3209`）；image_generation 跳过 | `tool_use.id = wire_id`；tool_result 在下一条 user 消息最前面，按 ordinal |
| Anthropic 中转（relay、NUG anthropic 渠道、TokenDance / CommandCode 的 messages 委托、DeepSeek 的 Anthropic 端点） | 来源键带渠道（`nug:<channel>:…`、`tokendance:<protocol>`，`tokendance-provider.ts:245-262`）；非 Claude 模型不 strict，外源推理保留文本、签名置空 | 同上 | 同上 | 同上 | 同上 |
| Responses（OpenAI HTTP） | strict（gpt / o 系列）：同源时 reasoning item 原样回放（含 `encrypted_content`），否则降级为文本或丢弃；message 与 function_call 的 item id 只在同源时带（现状：不查来源，附录 B 第 13 条） | `input_image` | 紧随其后的 user `input_image`（`openai-provider.ts:3596-3616`）；协议已允许 output 数组带图，第二段可按能力改用 | `web_search_call`、`image_generation_call` 原样回放（`openai-provider.ts:3959-4010`）；生成图片的字节在 worker 预取（现状：主线程读盘） | `call_id = wire_id`（≤64 字符，wire-safe 规则在写入时执行） |
| Codex HTTP | 同上，来源键 `codex` | 同上 | 同上 | 同上，原生工具追加在函数工具之后 | 同上 |
| Codex WS | 同上；骨架逐字节还原是续写的前提（§7.3） | 同上 | 同上 | 同上 | 同上 |
| Chat Completions（含 DeepSeek / GLM / Kimi 等思考中转） | 无凭据。非 strict 时推理作 `reasoning_content` 回放；思考中转要求每条 assistant 都带该字段，空推理补 `""`（`openai-provider.ts:472-480`） | `image_url` part（现状：历史图片全丢，附录 B 第 27 条） | 紧随其后的 user 消息（现状：丢弃） | web_search 投成 user 文本（`openai-provider.ts:4246-4259`）；image_generation 跳过 | `tool_calls[].id = wire_id`；role=tool 消息按 ordinal |
| Gemini generateContent | thought part 的文本总回放，`thoughtSignature` 只在同源时带；普通 text part 的签名也进骨架（现状：解析时丢弃，附录 B 第 28 条） | `inlineData`（现状：历史图片丢失） | Gemini 3 放进 functionResponse 的 parts，旧模型放进随后的 user content，由能力位决定 | 跳过 | 现状 functionResponse 不带 id，按名称加顺序配对（`gemini-provider.ts:653-662`）；块存储下顺序由 ordinal 保证；上游给了 `functionCall.id` 时存进骨架并原样回带（现状：一律本地生成 id，`gemini-provider.ts:948-950`） |
| Gemini Interactions | thought step 的签名同源才带；工具调用的签名用前置 thought step 表达，没有 reasoning 块时由 tool 骨架合成（`gemini-interactions-provider.ts:428-445`）；model_output 的 step id 同源才带（现状：不存） | `user_input` 里的图片（现状：重建丢失） | function_result 非错误时可带图 | 跳过 | `call_id = wire_id`（`gemini-interactions-provider.ts:772-773`） |
| 插件 / 远程 provider | 只回放同源的 `continuation`（`remote-provider-adapter.ts:373-423,1289-1300`） | DTO 的通用 block（`plugin-provider-rpc.ts:350-359`）；现状：只有 imageId 的块被丢弃 | 同左 | 跳过 | 由插件定义；现状：不看账本状态，未完成的调用也发出（附录 B 第 32 条），块存储下只发 `done` 的 tool 块 |

**B. 请求级**

| 协议 / 通道 | sys 项（`context` 的 role=sys 信封） | 缓存 | 工具加载默认 | 引用 citations |
|---|---|---|---|---|
| Anthropic 官方 | 模型支持时投成对话中途的 `role: "system"`（`anthropic-provider.ts:1635`），否则并入 user | system 三块：首块是由首条 user 文本派生的计费头（`anthropic-provider.ts:269-272`，纪元内首条不变，所以稳定），第二、三块带断点；末条消息末块一个断点 | 策略 1（Claude 新版本） | text 块的 `citations` 在骨架里，同源原样回放 |
| Anthropic 中转 | 并入 user；带工具变更的 system 消息不降级 | 不加 `cache_control` | 策略 1（Claude）、2（DeepSeek）、其余 4 | 同上 |
| Responses / Codex HTTP | role=sys 投成 user `input_text`；system 与 developer 汇入 `instructions` | `prompt_cache_key = conversationId`（`codex-request.ts:78`） | 策略 3（GPT 新版本） | `annotations` 在骨架里 |
| Codex WS | 同上 | 去掉 input 后请求相同、且 input 是上次 input 加上游 item 的逐项前缀，才发增量（`codex-websocket.ts:741-773`） | 策略 3；`additional_tools` 在 input 里，不破坏续写 | 同上 |
| Chat Completions | 并入 user | 由上游隐式前缀缓存 | 策略 4（GPT 名称会选 3，但协议不相容，落到 5） | 纯文本 |
| Gemini generateContent | 并入 user content | 无显式缓存 | 策略 4 | 纯文本 |
| Gemini Interactions | 并入 user_input | 无 | 策略 4 | 纯文本 |
| 插件 | 由 DTO 的 role 表达 | 由插件决定 | 策略 5（不报告协议） | 纯文本 |

**几条贯穿规则**
- **同源才用骨架。** `carryPolicy` 返回 `native` 时第二段把 part 填回 `wire`；其余情况只用 part。外源骨架里的字段（item id、step id、签名、annotations）一律不出现在请求里。
- **图片的放置由能力位决定。** 第一段只给出「这个结果带这些图片」；第二段按 target 的能力选 tool_result 内、output 数组、随后的 user 消息三处之一。能力位进 `targetFingerprint`，所以能力变化等同于换纪元。
- **工具 id 只在写入时处理一次。** 任何协议都直接用 `wire_id`；Responses 的 64 字符限制、DeepSeek 一类重复 id（`call_go_0`）都在写入时解决。
- **并行调用。** 一步内多个 tool 块按 ordinal 排列，结果按同一顺序投放；并行组只是 `state.execGroup` 上的展示信息，不影响投影。

**当前设计表达不了、或需要后续补的情况**

| 情况 | 现状 | 处理 |
|---|---|---|
| Anthropic 服务端 compaction（`compaction` 块经 `tool_changes` 回传区间内的工具变更） | 未使用 | 若采用，需要一个 assistant 侧的新块种类或 output 骨架约定，届时另议 |
| Anthropic `pause_turn`（服务端工具未完成的暂停轮）之后不能紧跟 `tool_addition` | 主请求不声明服务端工具，不会出现 | 若将来在主请求声明服务端工具，第二段需检查这条位置约束 |
| Responses 的 `tool_search_call` / `tool_search_output` 加载方式 | 未实现，策略 3 只用 `additional_tools` | 可表达为一个 `executor = "provider"` 之外的第三种工具执行者；不在本轮范围 |
| 音频等 image / file 之外的多模态 part | 没有写入点 | part 类型可扩展；新增时按「能力位 + 第二段放置」同一规则 |
| 用户输入里的 `document` / `attachment` 块 | 附录 A 标「待核」 | 解码时用真实数据确认后归入 `file` 或新增 part |
| Responses message 的 `refusal` content | 骨架原样保留；文本进 part（`segment = "refusal"`） | 跨源降级时按普通文本处理 |

## 8. 前端与传输

### 8.1 页面 API

`GET /:id/pretext-document` 一步切换到规范化结构（D5），与读路径切换同在 P2：

- P1 期间前端不动：接口仍返回由块派生的 `contentJson`，WS 仍发旧事件。
- P2 时接口、WS v2 与前端 store 一起切换，不设「数组元素附带块 id」的过渡形态。还没回填的旧信封在读取时经 `decodeLegacyContent` 现场解码成块，所以前端只需要支持一种形态。
- 切换后的形态：
  - 返回规范化结构：`{messages: EnvelopeDTO[], blocks: BlockDTO[], ...}`，块按 `messageId + ordinal` 组织。
  - 工具 IO 截断仍按块的叶子做，每个叶子 8KiB（`shared/pretext-layout/tool-io-projection.ts:67`）。
  - 详情接口改为按块寻址，例如 `GET /:id/blocks/:blockId`；旧的 `/tool-calls/:toolUseId` 保留为兼容接口。

### 8.2 WS 协议 v2

| 事件 | 载荷 | 取代 |
|---|---|---|
| `block_opened` | `messageId, blockId, kind, ordinal, attemptId` | 前端合成 `streaming:text:<i>` 一类的 id |
| `block_delta` | `blockId, part, revision, textOffset, text`（按帧合并） | `content_block_delta` |
| `block_checkpoint` / `block_closed` | `blockId, revision, phase` | 每个 checkpoint 一次的整条 `message_updated` |
| `block_state` | `blockId, statePatch` | 卡片状态、翻译等整条消息重发 |
| `blocks_deleted` | `blockIds` | 只接受严格前缀截断、否则整窗重载的限制（`vlist-message-replace.ts`） |
| `message_upserted` / `message_sealed` | 信封元数据 | `message`、`message_updated` 中的信封部分 |

- `streaming_snapshot` 保留，用于重连，但内容改为「open 块列表」，以块 id 为键。
- catch-up 游标仍以信封为粒度（`shared/narrator-catch-up.ts`），补发的信封携带完整的块。

### 8.3 前端删除的推导与补丁

| 现在 | 改为 |
|---|---|
| `__streaming__` 合成消息、`projectStreamingMessage` / `projectStreamingDocument`、supersede 启发式、`dropPersistedStreamingTools`、`finalizedRef`（`streaming-handoff.ts`；`streaming-block-supersede.ts`；`useVListStreamingMessage.ts`） | 流式块就是 store 里 phase 为 open 的块，以 id 为键。交接这一步不再存在 |
| `#dupN`、`dedupeSuffix`、`tool-<toolUseId>` 行 key | `blk-<blockId>` |
| 从 key 字符串用 `-b(\d+)` 反解下标；API 用 `(messageId, blockIndex)` 寻址 | 块 id |
| user 气泡登记为 blockIndex 0（`vlist-block-target.ts:117-120`） | `input` 块 id；删除、选择、回滚都作用于整块 |
| `enrichToolUseBlocks` 把账本字段注入块，再由 `latestToolCallAttempts` 推导最新 attempt | 工具卡 = tool 块 + 被采用（或正在执行）的 attempt 的账本摘要，按 `block_id` 精确关联 |
| 从 reasoning run 的文本按 `**标题**` 反推步骤（`segment-adapter.ts:1225-1246`） | 有分段的 provider 直接用 part；只有单段的 provider（如 Anthropic）才解析标题 |
| reasoning run 的操作只带一个下标 | run = 同一信封里相邻 reasoning 块的 id 列表，操作带整组 id |
| 三套「轮」的定义；前端重算并行分组 | 读 `turn_id`、`state.execGroup` |
| 后台任务的完成通知与启动它的工具卡之间没有关联 | 读 `cause_block_id`，通知可以挂在工具卡旁 |
| live patch 按 toolUseId 写所有出现位置（`vlist-live-patch.ts:222-231`） | 按账本 `block_id` 精确写入 |

客户端仍然要做的只剩展示层的事：LOD 折叠、跨信封的 tool-run 与 activity 分组、测量。

## 9. 其它消费方的迁移

| 消费方 | 现在依赖 | 改为 | 阶段 |
|---|---|---|---|
| 模型历史加载与各 provider builder | `content_json` + 账本；各 builder 自行解析 | 规范视图 + 两段投影（§7） | P0 改为吃规范块；P2 切换到块表 |
| 展示页 worker / WS / catch-up | 整数组读取、按字节预检、`enrichToolUseBlocks` | 按块读取、按块计字节；过渡期仍组装数组 | P1–P2 |
| FTS / 搜索 / Recall | `content_text` | 块级 FTS 定位到块；`content_text` 保留，供列表摘要 | P1 起新信封走块级；P2 回填后全部走块级；P3 退役信封级 FTS |
| compact / 段压缩 | `$[0]`、生成列、JSON CAS、哨兵字符串查询 | `context` 块（subtype `compact` / `segment_compact`）+ `phase` + `state` | P1 |
| 文件回退 / 块删除 / 回滚到块 | 原始字节、摘要 + 出现序号身份、下标 | 块 id + `revision`；`RewriteWorker` 不再解析 JSON 片段 | P2 |
| 编辑与恢复 | 整数组快照 `original_content_json` | 块的 `original_payload`；publication 读 `COALESCE(original_payload, payload)` | P1 |
| merge summary / 孤儿上传回收 | `LIKE` 全表扫描 | 按 `subtype` / kind 查部分索引 | P2 |
| External API v1 | `content_text`、`json_each` 抽推理 | 读块；契约不变，可加 `blockId` 字段 | P2 |
| project.db 同步 / 导入 | `content_json` 列（格式固定，只能扩展） | 导出时由块组装 `content_json`；导入时解码；之后可在 project.db 中新增块表 | P2 |
| transcript 导出 / session interchange | 整数组 | 从块组装 | P2 |
| 问题补充 / parent-injection-queue | `$[0]`、`$[1]` 路径 | 按 subtype 取块 | P1 |
| tool continuation 恢复排序 | `toolUseOrder`，即数组下标 | 块的 `ordinal` | P1 |
| context 构成 | `context_chars_json` | 不变（派生）；可选扩展为按块构成 | P1；按块构成在 P3 |
| 插件 / IM 网关 / 标题 / 通知 | 只读 `content_text` 或元数据 | 不变 | — |
| 测试（约 350 个文件直接使用 contentJson） | 原生 INSERT 造数据 | fixture helper 走 store；过渡期 decode 保证旧 fixture 仍可读 | 贯穿各期 |

## 10. 迁移与兼容

### 10.1 按信封共存两种格式

- 每个信封自带 `body_format`，读取层（`loadBlocks`、两个 worker）对两种格式都认。没有全库切换日。
- 任何**修改** `body_format = 1` 信封的操作，都先在同一个事务里把它物化：解码，写入块行，改为 `body_format = 2`。然后再按块 id 执行修改。
- 前置条件：P0 已经把所有直接改 `content_json` 的旁路写入收口进 store；否则下标身份会在物化之前就被改乱。
- 这种共存是永久的，不是过渡期：读取时现场解码、写时物化与回填作业一直保留（§10.7）。

### 10.2 旧数据的确定性解码 `decodeLegacyContent`

| 旧形态 | 解码结果 |
|---|---|
| 块 id | `${messageId}:${i}`；多个物理块合成一块时，`i` 取组内第一个下标 |
| user 输入 `[image…, text_file…, file_reference…, text]`、命令类 `[file_reference…, text]` | 一个 `input` 块，part 按原顺序排列；`model_text = content_text`，即冻结现有的附件提示，旧行投影出的字节不变 |
| 子代理收到的消息里，无 `modelText` 的 system_injection | 并入信封作者；块仍是 `input` |
| `bash_command` | `input`，`model_text = content_text`（现在就是经 `content_text` 回退对模型可见的） |
| origin 为 system 的 user `[text]`（自动续跑、批准反馈、审查检查） | `context`，`model_text = content_text` |
| `tool_loaded`、`tool_unloaded` | `context`，subtype 同名；`model_text = content_text`；`body.toolNames` 取块里的 `toolNames`，没有时由回填作业按例程展开后写入（§7.8），`body.label` 取 `toolName` |
| review `[text, review_feedback]` | 一个 `context` 块：`model_text` 取 text，卡片进 `body`，`applied` 进 `state` |
| 注入及其伴随块、旧格式 `[text, system_injection]`、sys 的原生卡片与纯 text | 一个 `context` 块；配对规则沿用 `injectionBlockViews` / `contextBlockViews` |
| `$[0]` 的 compact 块、计划、清空上下文 | `context`，subtype `compact` / `plan` / `clear_context`。status 映射为 phase；attempts、mode、error 放进 `state`；没有 `payload.epoch`，读取时按「旧纪元标记」处理（工具基线倒推，system 取当前值） |
| `segment_compact` | `context/segment_compact`；已完成的取 `model_text = content_text` |
| `file_history_checkpoint` | `context/file_history_checkpoint` |
| error、info、spec 卡片、恢复卡、ask_in_passing、发布结果 | `context`，subtype 同名，没有 `model_text` |
| assistant `text` | `output`，一块对一块。旧数据没有 item 分组，第二段对没有骨架的相邻 output 沿用现在「合成一个 message item」的做法。文本里遗留的 `citeturn…` 标记在这里清掉（规则沿用 `shared/citations.ts` 的 `cleanAssistantText`），投影不再处理 |
| `reasoning`、旧 `thinking`、`redacted_thinking` | `reasoning`。`signatureSource` 成为 `provider_meta.source`（没有时取信封的 `provider` 列，按 §7.4 只会判为不同源）；签名、`providerMetadata` 按 §3.4 的形状拼成 `wire` 骨架。旧数据的 summary 分段已不可恢复，当作单段 |
| `tool_use` + 账本 | `tool`：被采用的 attempt 取最新一次；终态 → `done`，非终态 → `open`；工具名进 `subtype`；`thoughtSignature`（含账本 `input_json` 里的保留键）并入 `provider_meta.wire`。`/bash` 行里那个只给显示用的 `tool_result` 块丢弃 |
| `web_search`、`image_generation` | `tool`，`executor = "provider"` |
| 没有对应块的账本行 | 内部执行（`internal_read_` 前缀）标为 internal，不投影；只有账本的旧数据按现在的向后兼容路径合成 `tool` 块，保持旧行投影出的字节不变 |
| `completed:false` | `aborted` |
| `translatedText`、`applied`、`isLatest`、卡片 status | 移入 `state` |

- 解码是纯函数，放在 `shared/`。读取路径、回填作业、project.db 导入都用它。
- 它的测试用例就是现有的各种块形态，包括 `injection-row-placement`、`provider-content-boundaries` 等测试里的数据。

### 10.3 后台回填作业

**为什么不能放在迁移 SQL 或启动回填里**
- finalizer 只接受白名单内的 DDL，迁移里不能做数据回填（`scripts/finalize-sqlite-resource-migration.ts:604-852`）。
- CLAUDE.md 禁止在主线程做大扫描。
- 启动回填（`db/data-backfills.ts`）会阻塞服务就绪。

**作法**：照持久游标作业的先例来做，即 `resource-protection-index.ts:603-633,979-993`，以及已删除的 `usage_token_repair_jobs`（`git show 85b2a46a:server/services/usage-token-repair-runner.ts`）。

| 方面 | 规则 |
|---|---|
| 进度 | 持久游标行，记录 `cursor` 和 `complete`。SQLite 按 `narrator_messages.rowid` 推进，PG 按 `(created_at, id)` |
| 单片 | 每片不超过 100 个信封、4 MiB 源字节、1 秒，先到先停 |
| 解码位置 | 在只读 db-worker 中读 `content_json` 并解码（`lib/db-worker/pool.ts`），主线程不碰正文 |
| 写入 | 回到主线程，每片一个短的同步事务：插入块与 asset 行，写 `body_bytes`，最后把 `body_format` 改为 2。带 `WHERE body_format = 1` 守卫：幂等，且能与同时发生的物化安全并发。目标每个事务 50ms 以内，超过记慢操作日志并把下一片减半 |
| 不触发的东西 | 块插入时信封仍是 `body_format = 1`，块触发器不生效（§4.5），所以回填不 bump `body_revision` / `model_history_revision`，源缓存不失效；`content_text`、`context_chars_json` 原样保留，不触发信封级 FTS。回填只改存储形态，不改任何投影字节 |
| 块级 FTS | 同一事务里为本片的块写块级索引（D6）。索引文本在 db-worker 里随解码一起算好，主线程只做插入 |
| 节奏 | 片与片之间 `setTimeout(0)`；由定时器重入；重启后从游标继续 |
| 校验 | 对 P1 双写期间产生的 `body_format = 2` 信封，比对「块组装出的数组」与 `content_json`，不一致的写入诊断表。双写一致性因此有了持续的证据 |
| 进度展示 | 在存储页显示进度，可以暂停 |

### 10.4 `content_json` 的终态

| 阶段 | `body_format = 2` 信封的 `content_json` | 回退方式 |
|---|---|---|
| P1–P2 | 写入完整的派生投影 | 关闭 `narratorBlocks.read` 开关，读取方回到 `content_json` |
| P3 | 继续写派生投影（D8）。P3b 起可开 `narratorBlocks.compactJson`：新行写 `'[]'` 并置 `body_rows_only = 1`（compact 标记除外），旧行由管理员启动的 `clear` 作业清空 | 关闭开关后新行恢复写投影；已清空的由 `restore` 作业从块写回，之后才能关闭 `narratorBlocks.read` |

- 这一列本身不删除。重建带触发器的表需要一次带版本的重装迁移，收益不值得这个代价。
- 只要存在只存行的信封，读者就一直读块，读开关不生效；回退顺序是关 `compactJson` → 运行 `restore` → 关 `read`。
- 清空释放出的空间，只能在管理员维护窗口里用 `/api/storage/database/vacuum` 回收。

### 10.5 对外格式

- **project.db**：保留 `content_json` 列，同步时由块组装（`project-archive/manifest.ts:5-7`，格式固定，只能扩展）。旧归档导入时走解码。
- **External API v1**：契约不变，内部实现改为读块；可以追加 `blockId` 字段。
- **session interchange / transcript 导出**：由块组装，输出格式不变。

### 10.6 开关

| 开关 | 作用 | 引入阶段 |
|---|---|---|
| `narratorBlocks.write` | store 写块表（双写） | P1 |
| `narratorBlocks.read` | 读取方读块表 | P2 |
| `narratorBlocks.wsV2` | WS 协议 v2，与页面 API、前端一起切换（D5）；默认开，关闭即回到 v1（前端两种都处理）。P3d 第 7a 步已与 v1 协议一起删除，设置加载时去掉存量的键 | P2 |
| `narratorBlocks.compactJson` | 新行的 `content_json` 写 `'[]'`（`body_rows_only = 1`）；只在 SQLite 且 `write`、`read` 都开时生效，默认关 | P3b |

每个开关都可以单独关闭。P3 之前，关闭 `narratorBlocks.read` 就完全回到现状；P3b 之后，存在只存行的信封时须先运行 `restore`。

### 10.7 从无块的旧版本直接升级（永久支持）

总会有用户从完全没有块表的旧版本直接升级到最新版本，中间不经过任何一个跑过回填的版本。旧格式的读取与转换因此永久保留，不设「必须先升到某个中间版本」的要求：

- **升级后立即可用**：迁移建好块表后，所有信封仍是 `body_format = 1`。消息页、模型历史、External API、导出经中央正文层读取，旧格式信封现场解码成块（`decodeLegacyContent`）；修改旧格式信封时先物化（§10.1）。前端只收到一种形态。
- **后台转换**：convert → verify → reindex 照常自动运行，按 §10.3 的节奏和主线程预算（P3c 实现说明），不阻塞启动。
- **搜索**：信封级 FTS 留到本实例自己的 reindex 完成后才退役（P3c）。回填期间大部分信封还没有块，只读块索引会让旧信封退化成 `content_text` 子串扫描，所以两种搜索模式都保留。
- **要永久保留的代码**：`decodeLegacyContent`（回填和 project.db 导入本来就要用）、中央正文层里 `body_format = 1` 的读取分支、写时物化、三个回填作业、两种搜索模式及退役条件。这些都已集中在正文层、回填服务与搜索 store 里，体量很小。
- **PG**：PG 还没有块行，所有信封都是旧格式，同样依赖这条读取路径。
- **不选「强制中转版本」**：要在启动时拒绝运行并提示先升中转版本，手动安装二进制的用户会绕过更新服务器；为了删掉一小段集中的代码，换来一个可能卡住用户的升级步骤，不值得。
- **验收**：一个直接升级测试，用 P1 之前的 schema 与各种真实形态的旧数据做库快照，跑完全部迁移后：回填完成前，消息页、模型历史、搜索立即可用且与升级前一致；回填作业依次完成；信封级 FTS 在 reindex 完成后的下次启动时退役；前端按块渲染这些会话。

## 11. 实施阶段

### P0 收口（不建新表）

**交付**
1. `NarratorStore` 成为唯一写入层，22 个写入文件全部迁入，顺带修掉 §5.1 列出的非原子写入，包括 tool_use 块与账本行分两步落库。
2. `shared/narrator-blocks/`：规范块与 part 的 TS 类型和 Zod schema，以及 `decodeLegacyContent`、`deriveEnvelope`。
3. 两段投影（§7.2）：各 provider 只保留第二段；数据仍由 `content_json` 解码而来；loop 改为由同一投影生成每次请求。
4. 先在现有表里落库原来只在内存里的模型可见内容：
   - loop 自造的文本写成 sys 行；
   - 工具结果图片与附言写进账本行的输出结构。
5. 已实现的工具加载（§7.8 末尾的对照表）并入两段投影：变更项成为中立结构，`WeakMap` 旁路与当前轮特例删除；以现有 `tool-loading.test.ts`、`loop-tool-loading.test.ts` 做字节等价测试。
6. 修正现存偏差，见附录 B 第 1–4、21、27 条：
   - 重建时按调用顺序排列工具结果；
   - strict 只由裸 model 名计算一次；
   - 各 provider 的用户图片与工具结果图片按同一规则放置；
   - 段压缩标记的 origin；
   - 内部执行不进模型历史。
7. 测试网：
   - 每种 provider 模式都有「重建 == 实时」等价测试，覆盖 loop 实际使用的 `orderedContent` 路径；
   - 测试多工具结果顺序、broken 调用、mid-pass 注入、当前轮合并；
   - 新旧实现对真实会话的请求做字节 diff：开启 `requestEvidence.autoPin`，比对录制。

**退出条件**
- 生产代码只经 store 写入，有守卫测试，类似 `sqlite-dialect-inventory.guard.test.ts`。
- 所有 provider 只实现第二段；loop 内没有字符串拼接式的历史组装。
- 新旧投影在录制语料上逐字节相同（附录 B 中有意修正的项除外，逐项列出）。

### P1 新表与双写

**交付**
1. schema：
   - 新建 `narrator_blocks`、`narrator_block_assets`；
   - `narrator_messages` 新增 `body_format`、`turn_id`、`author_narrator_id`、`cause_block_id`、`provider_response_id`、`body_bytes`；
   - `narrator_text_snapshots`（纪元的工具定义与 system 快照，§7.7）；
   - `narrator_tool_calls` 新增 `block_id` 与内部执行标记；
   - `narrator_turns`（§4.4，D7），运行开始与结束各写一次。
2. v2 触发器契约：生成器支持，SQLite 与 PG 各一份。
3. 信封级 FTS 触发器加列过滤，并带版本号；新建块级 FTS `narrator_blocks_fts`，搜索合并两套索引的结果（D6）。
4. store 写块表，新信封一律为 `body_format = 2`，同时写派生的 `content_json`。
5. 流式按 provider item 写入（§5.2）；按 `attemptId` 丢弃 attempt。WS 仍发旧事件，由块派生（D5）。
6. tool 块合并调用与结果，采用两段生命周期（§3.5、§3.7）；`state` 写入（§5.4）；`phase` 统一。
7. 只保留一个 COW 实现；作者与属主分开。
9. 纪元标记块与请求前对账（§7.7）：compact 成功写 `payload.epoch`，target 切换与缓存已冷写 `epoch` 块；工具表改为取自纪元快照，已实现的倒推降为兜底。

**退出条件**
- 新会话全部是原生块；关闭开关能回到现状。
- 双写校验没有差异。
- 流式期间块表每秒的写入次数，不高于现状的 checkpoint 次数。

**P1 实现说明（与上文的差异）**
- **块行内容。** P1 的块行 `payload = {raw: [原样存储元素]}`，读者专用字段（译文、卡片状态、`isLatest`）移进 `state = {raw: [...]}`；`assembleContent` 把各行按 ordinal 拼回后与 store 写入的 `content_json` 逐字节一致（`shared/narrator-blocks/storage.ts`；读者专用字段排在最后，见 P2b 实现说明的键序规则）。kind、subtype、phase、`model_text`、`wire_id` 取自 `decodeLegacyContent`。规范化 payload（parts、`provider_meta`）在所有读取方改读块表时（P2）再换，P1 先不存两份正文。
- **同步路径。** store 的写操作在同一事务里同步受影响的信封（`server/services/narrator-block-sync.ts`）。其余写入方由生成的 v2 触发器写入 `narrator_block_sync_queue`，再由三处排空：事务末尾的 flush（有上限）、5 秒一次的限时清扫，以及启动恢复。块行按 key 匹配，id、attempt、lineage 在改写中保持不变。
- **revision。** P1 中 `content_json` / `content_text` 的变化对所有格式仍然 bump（读取方仍读 `content_json`）。所以 `patchState` 类写入（译文、卡片状态）在 P1 仍会让模型历史 revision 加一次，P2 切读后取消。
- **旧信封。** `body_format = 1` 的信封被修改时不就地物化成块，统一留给 P2 回填。
- **PG。** v2 触发器、块表与 FTS 的迁移齐全，但 PG 写路径在 P1 仍写 `body_format = 1`，块同步只在 SQLite 上进行。
- **COW。** 事务内的复制统一走 `cowEnvelopeTx`（`narrator-persistence.ts`），四处调用方都改用它：
  - 副本的属主是持有者，作者保留原值；
  - 副本的块指回所复制的块。
  - `revert-history-commit` 的批量程序同样改为属主为持有者、作者保留；
  - sender 标签读作者（`coalesce(author_narrator_id, narrator_id)`），v2 的标题触发器同时覆盖作者。
- **丢弃 attempt。** 按块上的 `attempt_id`（即 loop 的 requestId）。没有块行的旧格式信封仍按基线截断。
- **轮。**
  - 每次 `runAgentLoopUnlocked` 写一行。
  - `trigger_message_id` 取运行开始时历史里最新、且尚未归属任何轮的 user 行，并把这行的 `turn_id` 一并补上。
  - `cause_block_id`、`provider_response_id` 列已建，P1 不写。
- **纪元。** P1 只冻结工具集合：
  - compact 成功时，compact 元素里写 `epoch`。
  - 对账在每个 pass 开始时做，而不是每次请求：
    - target 变化或缓存已冷，而且重建确实会改变工具布局时，写一行 role=system 的 `epoch` 标记（模型不可见，前端隐藏）；
    - 冻结纪元内绕过 `/load` 的变化，写成 origin=system 的 `tool_loaded` / `tool_unloaded` 提示。
  - 冻结工具定义、system 分节快照与提醒、前缀核对，以及 `narrator_text_snapshots` 的写入，留到后续阶段。
- **双写校验。** 启动时审计最近 50 个块格式信封（`auditRecentEnvelopes`）。有差异就记日志并重新同步。

### P2 切换读取与回填

**交付**
1. 模型历史 worker、展示页 worker、External API、回退、块删除、导出、project.db 同步、merge summary、存储 GC，都改为读块表。
2. 前端一步切换（D5）：页面 API 改为规范化形态，WS v2 上线；前端 store 以块 id 为键，`blockId` 作为 key 和 API 寻址，操作目标按 §5.5；删除流式交接的启发式（§8.3）；`turn_id` 驱动 recency；`cause_block_id` 驱动通知与工具卡的关联；轮级 UI 读 `narrator_turns`。
3. 回填作业（§10.3），同时为旧信封补写块级 FTS。旧会话没有 `turn_id`，不补建轮表行。

**退出条件**
- 回填完成。
- 除 project.db 组装和 decode 兜底之外，代码中不再读取 `content_json`。
- SQLite 方言台账里与 `content_json` 有关的 `json_extract` / `json_each` / `LIKE` 全部清零。

**P2 拆分与 P2a 实现说明**
- P2 分三个 PR：P2a 回填作业（本节）、P2b 服务端读取方改读块表、P2c 前端一步切换与 WS v2。
- **回填作业**（`server/services/narrator-block-backfill.ts`）：
  - 两个作业共用一张进度表 `narrator_block_backfill`：`convert` 把旧信封转成块，`verify` 校验块格式信封。游标为 `narrator_messages.rowid`。
  - **读与写的分工：** 只读 db-worker 中的 `blockBackfillSlice` 读正文并规划块行（`server/lib/db-worker/block-backfill-query.ts`），规划逻辑与 store 同步共用 `shared/narrator-blocks/plan.ts`。主线程只插入。
  - **单片上限：** 100 个信封 / 4 MiB / 1 秒；写事务超过 50ms 时下一片减半。worker 不可用时回到主线程，单片降为 10 个信封 / 256 KiB。
  - **一个事务内的写入顺序：** 删除残留块行，插入块、asset、块级索引，绑定账本 `block_id`，最后写 `body_bytes` 并把 `body_format` 改为 2，再清掉翻转引起的同步队列项。块插入时信封仍是格式 1，所以不 bump 任何 revision。
  - **过期计划：** 若 `body_revision` 或账本指纹（行数与 `model_revision` 之和）与 worker 读取时不同，只翻转格式，由 store 同步按当前内容建块。
  - **无法解码：** 不是数组的 `content_json` 记入 `narrator_block_diagnostics`（`undecodable`），信封保持格式 1，作业越过它继续。
  - **校验：** `verify` 在 worker 中比对「块组装出的数组」与 `content_json`，不一致的记 `mismatch` 并重新同步；仍在同步队列里的信封不算。
  - **启动与控制：** 服务就绪后在后台启动，`setTimeout(0)` 驱动，重启后从游标继续。存储设置页显示进度，可暂停与继续（`/api/storage/blocks/backfill`）。
  - **PG：** 与 P1 一致，只在 SQLite 上运行。

**P2b 实现说明（服务端读取方）**
- **开关与统一读取：** `narratorBlocks.read`（默认开）。读取方把原来选 `content_json` 的位置换成 `bodySql(alias)`（`server/lib/narrator-bodies.ts`），再由 `readBodies` / `blockBodies` 从块行组装为 NULL 的正文：
  - 读块的条件（`blocksCurrentSql`）：`body_format = 2`、不在同步队列里、且有块行；
  - 其余情况仍读 `content_json`：旧信封、仍在同步队列里的信封（store 之外改过正文，块行还没重建），以及没有块行的信封（空内容或无法解码）；
  - 开关关闭或在 PG 上时，读取方与 P2 之前完全一致（PG 仍只写旧格式）。
- **字节预算：** 块格式信封按 `body_bytes` 计；需要精确字符数或字节数的地方（导出的子代理摘录、归档的行上限）用 `assembledBodyLengthSql` 由块行长度算出，不解析 payload。解码预检逐个作用于块的 payload / state 字符串。
- **已切换的读取方：**
  - 模型历史 worker（全量与增量）；
  - 展示页 worker；
  - External API 的推理扫描：按 `kind = 'reasoning'` 的块读取；
  - transcript 导出、session interchange 导出、project.db 同步 / 归档：归档格式不变，`content_json` 列由块组装；
  - merge summary 的三处扫描：经 `idx_blocks_context_subtype` 定位；
  - 孤儿上传回收：经 `input_image` asset 行定位；
  - 问题补充回执、compact epoch：读单块 payload。
- **旧信封索引：** 部分索引 `idx_messages_legacy_body`（`body_format = 1`）正好收录旧信封。扫描的旧信封分支、回填的候选查询都走这条索引，回填完成后索引为空。旧信封在回填完成之后仍可能出现：块写入关闭期间写入的、或导入的。启动时若有这类信封（不含无法解码的），`convert` 作业回到第一条重新转换；块写入关闭期间 `convert` 不运行。
- **一条键序规则：** 元素的读者专用字段（§10.1 的 state 字段）排在其他字段之后。
  - store 由块派生 `content_json`，本就遵守这条规则；P1 之前写入的、或在 store 之外写入的 `content_json` 可能把这些字段放在中间，含义相同。
  - 双写审计与 `verify` 用 `inAssembledOrder(stored)` 与组装结果比较，不再把仅键序不同的信封记为 mismatch。
  - 有意的字节变化：输出原始元素的读取方（JSON 导出、归档的 `content_json` 列、展示页与模型历史的元素对象）在这类信封上按此键序输出。
- **其它行为变化：** External API 原先对超过 256 KiB 的整条信封标记「推理不可用」；改为只看推理块本身，所以与大工具输入同在一条信封里的推理现在可以返回。
- **留给 P2c 的读取方：** 主线程的读改写路径仍读 `content_json`，在 P2c 改为按块 id 寻址时一起切换：
  - 编辑、翻译、块删除、回退（`narrator-messages.ts`、`routes/narrators.ts`、`revert-*`）；
  - 页面 API（`pretext-document`）与 WS；
  - 会话 / 恢复路径（`narrator-session.ts`、`narrator-service.ts`、`narrator-output-recovery.ts`、`tool-continuation-service.ts`、`subagent-extract.ts`）；
  - 投递与收件（`agent-runtime/inbox.ts`、`agent-message-delivery.ts`、`send-delivery-resolution.ts`、`await-agent-resolution.ts`）。
  双写期间 `content_json` 与块行一致，这些路径的结果不变；P3 把新行的 `content_json` 写成 `'[]'` 之前必须全部切换。
- **不切换的：** compact 定稿的 CAS 是按主键读一行来保护对 `content_json` 本身的写入，块的 `phase` / `revision` 不携带它比较的尝试次数与状态，留在 `content_json` 上，随 P2c 的 compact 写入改造一起处理。project.db 导入仍读 `content_json` 列（§9）。

**P2c 拆分与 P2c-1 实现说明（服务端：按块寻址、状态写入、余下的读取方）**
- P2c 分三个 PR：
  - P2c-1：服务端按块 id 的操作、`patchState`、余下的纯读取方；前端不动。
  - P2c-2：页面 API v2 与 WS v2，挂在 `narratorBlocks.wsV2` 开关后（默认关）。
  - P2c-3：前端以块 id 为键的 store，删除流式交接启发式，同一 PR 打开 `wsV2`。
- **按块寻址**（`server/services/narrator-block-targets.ts`）：
  - 块 id 解析为它所持有的元素区间：
    - 有块行的信封按各行 `payload.raw` 的长度累加，不解析正文（在同步队列里的先同步，未变的块 id 不变）；
    - 未转换的旧信封用解码器给出的 id，经 `splitEnvelope` 匹配。解码 id 表示位置，只在信封仍是旧格式时有效；信封有了块行（转换或被按块操作物化）后解码 id 一律 409。
    - 一次解析解析正文的总量有上限（旧信封与待同步信封合计 32 MiB，单个 16 MiB）。
  - 解析在叙述者的 admission 内进行，结果交给现有有界、带 COW 的历史机制，所以安全检查与按下标的路径相同。
  - 按块删除先物化目标旧信封（块写入开启时），再按行删除：删除事务内即重建块行，并把被删的行标为 retired（`withRetiredBlocks`），同步与 COW 副本都不会让剩下的块接走被删块的 id。重试同一删除因此失败，而不是删掉顶上来的块。
- **块行匹配**（`matchBlocks`，`shared/narrator-blocks/storage.ts`；同步与 COW 血缘共用）：
  1. 有自身身份的块（tool 调用、带 id 的元素、输入的整块）按 key 匹配，无论移到哪里；
  2. 其余按顺序对齐：身份按 key、无身份的按 payload 原文（最长公共子序列，先去掉相同的头尾），删除或插入一个无 id 的块不会把它的 id 交给只是同类型、同位置的邻居，`original_payload` 也不会迁到别的块；
  3. 仍未匹配的，在相邻两个对齐块之间按类型顺序配对：原地编辑或流式增长的块保留其行。
  - 此前按 `type#n` 位置 key 匹配：删掉第一个无 id 文本后，第二个文本会接走它的 id 与 `original_payload`。
- **新接口**（按下标的旧接口保留，供 P2c-3 之前的前端使用）：
  - `DELETE /:id/blocks`：整块删除。tool 块连同其调用的全部账本 attempt；`input` 连同全部附件；reasoning run 传整组 id（修正附录 B 第 18、19 条）。
  - `POST /:id/blocks/rollback`：所有目标块整块保留，删除最后一块之后的内容（修正附录 B 第 19 条）。
  - `POST /:id/blocks/:blockId/edit` 与 `.../restore`：只改被点的 `output` 块（修正附录 B 第 20 条）。
    - 编辑保留元素身份（块 id 不变），只保留仍逐字对应的 citations，去掉上游 item 元数据与译文。
    - 首次编辑前的正文存 `original_payload`，COW 副本继承它；未转换的信封编辑时先建块行。
    - 按消息的旧恢复接口会清掉各块的 `original_payload`。
  - `GET /:id/blocks/:blockId`：单块完整内容；tool 块附账本详情。
  - 预览（`rollback-preview`、`edit-preview`、`delete-preview`、`revert-action-preview`）、`edit-and-regenerate`、`allow-retry` 都有按块 id 的版本。
- **删除并回退文件：** 选中 tool 块调用的全部执行 attempt（修正附录 B 第 24 条）。`fileChangeRevertActionMatches` 因此允许一个 tool 块对应多个 tool call id；带此 UI 动作的计划只能由服务端从单个块推导出来。
- **状态写入 `patchState`**（`narratorStore.patchState`）：
  - 一个事务：写 `content_json`（完整的兼容投影）并令 `state_revision + 1`，同时更新变化块行的 `state` / `byte_size` 与信封的 `body_bytes`。
  - 不 bump revision，不 COW（共享信封原地修改），不写块级 FTS。
  - 改到非状态字段，或改到解码器据以派生列的状态字段（compact 的 `status` 决定 phase）时，自动退化为正文写入。
- **触发器契约 v3**（迁移 SQLite 0216、PG 0032）：一次 UPDATE 若移动了 `state_revision`，其 `content_json` / `content_text` 变化既不 bump 也不入同步队列；其余与 v2 相同，v2 的渲染保持不变。
- **迁到 `patchState` 的写入：** reasoning 翻译、review feedback 的 applied / release、merge 卡片 `isLatest`、子代理恢复卡片、compact 的 `mode` 切换。
  - 子代理恢复卡片的 `status/mode/resumedCount/subagents` 加入 `STATE_KEYS`；它是 `disp` 行，模型不读。已有行会重新切分一次。
- **不迁的：**
  - ask_in_passing 作答：它改写模型可见的 `content_text`。
  - compact 定稿 CAS：块的 `phase/revision` 不携带尝试次数与重试基线，旧信封没有块行，P1–P2 期间块行在 `content_json` 写入之后才派生；P3 写入改为以块为准后再迁。
- **余下的纯读取方**（`server/services/narrator-body-reads.ts`）：
  - 消息查询族（分页、最近消息、compact 摘要、历史恢复）、卡片关闭检查、段压缩、事件处理与会话中的广播重读、publication、子代理提取、prompt 优化上下文、计划任务清理，都按 P2b 的规则读块行。
  - 工具续跑的恢复排序改按 tool 块的 `ordinal`（§9），不再读正文。
  - 对正文本身设限的地方（`storedBodyBytesSql`：composer 文档上限、历史恢复阈值、计划任务清理、工具续跑）按块行组装出的数组精确计算（`assembledBodyLengthSql`），与 `content_json` 的长度一致；不用 `body_bytes`，它把输入的文本按 model text 又算了一遍。只用来切分读取批次的（worker 里的 `bodyBytesSql`）仍用 `body_bytes`：高估只会让批次变小，且不必为测量而读正文。
- **回填**：计划同时记录 `state_revision`；worker 读取后发生的状态写入（如翻译）会让应用改走"翻转格式 + 同步队列"，不再用过期计划建行。
- **留给 P3 的 `content_json` 读改写：** `narrator-output-recovery`、编辑重生成与工具清理、删除叙述者时的归属转移、`updateCompactSummary`、计划输入补丁、`copyOnWriteMessage`、`discardAttemptBlocks`、段压缩摘要更新、compact 定稿；以及按 `content_json` 精确字节摘要与重写的回退管线（`revert-selection-service`、`revert-history-commit`）。双写期间这些路径的结果不变。

**P2c-2 实现说明（页面 API v2 与 WS v2，开关 `narratorBlocks.wsV2`）**
- **开关与协商：**
  - `narratorBlocks.wsV2` 默认关。
  - `messages` 订阅可带 `protocol: 1 | 2`：开关开时授予 v2，按连接、按叙述者记录，并回 `message_protocol {narratorIds, protocol}`；不带 `protocol` 的客户端看不到任何变化。
  - 页面接口（含公开分享页）带 `?protocol=2` 时同理：开关开时返回 `{protocol: 2, messages: EnvelopeDTO[], blocks: BlockDTO[], minSeq, maxSeq, hasPrev, hasNext, messageVersion}`，否则仍是 v1 页面。
- **页面 v2**（`server/services/narrator-block-page.ts`）：
  - 信封是 v1 的行去掉 `contentJson` 与 `children`，加上按顺序的 `blockIds`；子行平铺在父行之后，靠 `parentToolUseId` 定位。
  - 块：`id, messageId, ordinal, kind, subtype, phase, revision, wireId, attemptId, elements, hasOriginal`。
  - 块格式信封按块行切分（各行 `payload.raw` 的长度；在同步队列里的先同步，发出的 id 就是行保留的 id）；旧信封按解码器分组，id 是块 id 接口在它仍为旧格式时能解析的解码 id。
  - `elements` 就是 v1 发出的元素（工具 IO 已截断、账本字段已注入），v2 只多读块行布局。
- **流式块的 id**（§3.2，`server/services/narrator-block-ids.ts`）：
  - 按（叙述者，元素自身标识）发放：文本、推理元素是 `${attempt}:${order}`，工具是调用 id。
  - WS 适配器在元素的第一个 delta、工具的第一个输入分片时取 id；store 的流式同步插入该元素的块行时用同一个 id（该 id 已被别的行占用时换新 id 并更新映射）。哪一侧先要就由哪一侧发放，另一侧取到同一个。
  - 映射有界（4096 项，丢弃最旧的）；attempt 重试换新 attempt id，元素标识不会重复。
- **WS v2 事件**（中央适配器 `server/websocket/narrator-block-protocol.ts`）：发送方仍发 v1 帧；`broadcastToNarrator` 对协商了 v2 的连接按下表映射，每次广播只算一次。
  - `message` / `user_message` / `message_updated` → `message_upserted {cause, messages, blocks, …COW 别名}`。`cause` 保留 v1 帧类型，客户端按帧计 `messageVersion` 的规则不变。
  - 文本、推理 delta（`stream_event`）→ `block_delta {blockId, kind, elementId, text, revision, textOffset, outputIndex}`；元素的第一个 delta 之前先发 `block_opened`（`messageId` 为 null：信封在第一次检查点才写入）。
  - 工具的第一个输入分片之前发 `block_opened {kind: "tool", wireId}`，分片本身不变。
  - `streaming_snapshot` 为每个活动项附上 `blockId`；`catch_up` 改为 `{protocol: 2, messages, blocks, subagentActivities, cursor, messageVersion}`。
  - 公开分享连接先做公开投影再转 v2；其余帧原样发送。
  - 与 §8.2 的差别：信封不再列出的块就是已删除的块，所以不单独发 `blocks_deleted`；`message_sealed` 并入 `message_upserted`，由块的 `phase` 表明是否仍在流式。
- **留给后续：** 检查点仍随 `message_upserted` 发整条信封的块（与 v1 的整行等量）。只带 `blockId, revision, phase` 的 `block_checkpoint`、`block_state` 增量、按帧合并 delta，等 P2c-3 前端确定消费方式后再做。

**P2c-3 实现说明（前端切到块协议，`narratorBlocks.wsV2` 默认开）**
- **一个 PR，分步提交，每步 CI 单独验证。**
- **传输边界解码**（`frontend/lib/block-protocol.ts`）：
  - 所有 `messages` 订阅都带 `protocol: 2`（服务端按连接、按叙述者只有一种协议，三处订阅必须一致），页面请求带 `?protocol=2`（含公开分享页）。
  - v2 页面与帧在边界还原成 v1 形态：信封 + 块 → 带 `contentJson` 与嵌套 `children` 的 `TreeMessage`；`message_upserted` → 其 `cause` 指名的 v1 帧（按帧计 `messageVersion` 不变）；`block_delta` → v1 `stream_event`；v2 catch-up → `topLevel` / `orphanChildren`。
  - 每行附 `blockRefs`（块 id 与在 `contentJson` 中的元素区间），解码时同时记入 `frontend/lib/block-refs.ts`（P3d 第 4 步删除这个登记表，操作改从行读块）。
  - 服务端信封带 `parentMessageId`（在 v1 中嵌套于哪一行），v2 catch-up 带 `orphanMessageIds`，客户端据此精确还原 v1 树。往返测试保证"服务端编码 + 客户端解码"得到原来的 v1 页面与帧。
  - 服务端回 v1（`wsV2` 关）时一切照旧，所以 `wsV2` 是回退开关。
- **按块寻址的操作**：删除（单个、批量）、回滚、回滚与删除预览、文件恢复预览、编辑重生成，在已知块时走 `/blocks` 路由，作用于该元素所在的整块；只从 v1 服务端见过的消息仍走按下标的路由。编辑、恢复 assistant 消息仍按整条消息（编辑器编辑的是整条文本，按块编辑需要编辑器指明块）；allow-retry 按调用 id，本就精确。
- **账本按块打补丁**：v2 连接上的 `tool_started` / `tool_completed` 带账本 attempt 所属的 tool 块（`blockId`：帧带 `toolCallId` 时取该 attempt 的 `block_id`，否则取该调用最新的 attempt）；前端只写持有该块的那一行，没有块 id 或未加载该块时仍写所有出现处。
- **元素按块 id 作键**：以块协议到达的消息，其元素键为 `${messageId}-blk[<blockId>]`（多元素块的后续元素加 `+<offset>`），取代按位置的 `${messageId}-b<index>`；删除或插入前面的块不再改变后面行的键（测量高度、折叠、选择随之保留）。v1 消息仍用按位置的键。tool 行仍以调用 id 作键（反思、权限匹配、跳转都按它寻址）。
- **流式交接**：流式元素与其落库副本已按元素的全局标识（`${attempt}:${order}`，即 v2 的块 id 所对应的元素）配对：supersede 用 id + revision，生命周期动画用 `lifecycleId`。按文本后缀、`outputIndex` 的旧匹配只服务于不带元素 id 的 provider 流与 `wsV2` 关闭时的 v1，因此保留，在 P3d 与 v1 协议和开关一起删除（前提是先确认各 provider 的流都带元素 id）。P3d 第 2、6 步确认了这一前提并删除了旧匹配。

### P3 退役与新能力

**交付**
1. 新行的 `content_json` 写 `'[]'`；运行清空旧行的作业。compact 标记保留投影，`compact_pending` 及其读取方不变（见 P3b 实现说明）。
2. 退役信封级 FTS：删除 `narrator_messages_fts` 及其触发器，搜索只查块级索引。
3. 解码路径永久保留：读取时现场解码、写时物化、回填作业与 project.db 旧归档导入都用它，跨版本直接升级的实例靠它在后台转换期间照常可用（§10.7）。
4. 按需开放新能力：
   - 块级永久链接、引用、评论；
   - 按块的保留策略；
   - 块 revision 历史；
   - External API 追加 `blockId`。

**P3 分阶段**：每阶段一个 PR，PR 内分步提交、每步 CI。
- P3a：所有读改写经正文层，不改数据（下文）。
- P3b：`narratorBlocks.compactJson`（默认关）让新行写 `'[]'`；清空旧行的作业只在回填 verify 之后由管理员显式触发。
- P3c：退役信封级 FTS（下文）。
- P3d：删除 v1 页面与 WS 协议、`wsV2` 开关和流式交接的旧启发式；前端改为直接按块渲染，去掉入口处转回 v1 形状的那层（P3d 设计见下文）。旧格式的读取与转换不删（§10.7）。这些都与库里存的是什么无关，所以不必等各实例回填完成；`wsV2` 作为回退开关，在 v2 经过一个正式版本后再删。验收包括 §10.7 的直接升级测试。

**P3a 实现说明（正文只经正文层读写）**
- **正文层**（`server/services/narrator-body-writes.ts`）：写入方把正文交给它，块行由交来的正文建出，不回读 `content_json`，所以列里存什么（P3b）对写入方透明。
  - `insertEnvelope` / `insertEnvelopeIfAbsent`：插入信封并同事务建行；`rows` 先写随信封落库的 ref、账本行，`copyOf` 让副本的块继承原块谱系。
  - `writeEnvelopeBody`：替换正文（`set` 带同变的列，`where` 做比较并交换，`rows` 先写随正文的账本变更）；`updateEnvelope`：可能含正文的一组列。
  - `readEnvelope` / `readEnvelopeBody`：读改写的起点，与读者同口径（行当前时组装自行）。
  - `insertEnvelopeQueued`：批量复制（子代理提取最多 2000 条）不在主线程逐条同步，列保留完整投影，由同步队列建行。
- **同步**：`syncEnvelope` 接收写入方刚写的正文；不带正文时（账本变化等）按读者口径读正文：排队时读列，行当前时读行，由行与账本重新推导 tool 块的 phase。双写审计与回填 verify 以列为基准，用 `resyncFromColumn` 重建。
- **读取**：读改写一律经 `bodyColumns` / `contentJsonSql` / `readEnvelope`。删除与截断的体积预算用 `envelopeStoredBytesSql`（行持有正文时计 `body_bytes`）。文件历史检查点用 `hasStoredElementSql` 查找，不再精确匹配 `content_json`。
- **compact finalize**：比较并交换改为在同一事务里重读标记并逐项比对，不再对 `content_json` 做 `json_extract`；`narrator-persistence` 不再依赖 JSON1。
- **revert 管线**：选择阶段与提交阶段都按读者口径度量与读取正文（`bodyLengthSql`、`boundedBodyText`），摘要两边一致；提交时的行检查用 `body_revision` / `state_revision` 固定正文（任何正文或状态写入都会推进其一），不再捕获 `content_json`。预编译语句仍把改写后的正文写入列、由同步队列建行，因为 apply 阶段不允许读取与 JSON 处理。回滚预览改为解析有界正文（`boundedStoredBody`），不再在 HTTP 线程上对列做 JSON1。
- **守卫**：`narrator-body-access.guard.test.ts` 按文件计数直接把列当正文的读写，只减不增。P3a 结束时余下的都是长期条目：正文层本身；列即正文的读取方（旧格式、PG、读开关关闭）；由同步队列从列建行的写入（旧格式导入、revert 预编译语句）。
- **测试**：`narrator-body-writes.test.ts` 先让列与正文脱钩（列置 `'[]'` 且不入队，即 P3b 的样子），再逐一验证 COW、步内写入、工具输入覆盖、compact finalize 及其 CAS、段压缩、丢弃 attempt、删块、编辑输出块、改压缩摘要、输出恢复、有界正文读取都从行出发。
- **留给 P3b**：
  - 账本变化会让信封入队，入队期间读者与同步读列。对紧凑信封（列为 `'[]'`）要么免除这项排队判断，要么让队列区分"列被外部写入"与"账本变化"（触发器契约 v4）。
  - `compact_pending` 生成列读 `content_json`：启动恢复与 fork 排除运行中 compact 的读取方需改看 compact 块的状态。
  - 审计与回填 verify 只对非紧凑信封以列为基准。
  - 由队列从列建行的写入在 P3b 继续写完整投影；清空作业只处理行已当前的信封。
  - `compactJson` 只在 `narratorBlocks.read` 开启且为 SQLite 时生效。

**P3b 实现说明（只存行的信封）**
- **标记**：`narrator_messages.body_rows_only`（默认 0）。为 1 时 `content_json` 是 `'[]'`，正文只在块行里。
  - 用单独的列，而不是新的 `body_format` 值或 `'[]'` 哨兵：这些信封仍是 `body_format = 2`，触发器契约 v3 原样适用，不需要 v4。
  - 部分索引 `idx_messages_rows_only` 让"是否存在只存行的信封"只是一次索引探测（`hasRowsOnlyBodies`，主线程缓存为 `rowsOnlyEnvelopesExist`）。
- **写入**：开关生效时（`rowsOnlyWrites`：SQLite，`compactJson`、`write`、`read` 都开），正文层（`insertEnvelope`、`writeEnvelopeBody`）与 `patchEnvelopeState` 按 `storedProjection` 存列。
  - 块格式、数组正文、不是 compact 标记：存 `'[]'`，标记置 1。
  - 其他情况：存完整投影，标记置 0。开关关闭后，下一次重写就把投影写回。
  - 由队列从列建行的写入（`insertEnvelopeQueued` 批量复制、revert 预编译语句、导入）继续写完整投影，并把标记置 0。
- **compact 标记保留投影**：首元素类型为 `compact` 或 `segment_compact` 的标记（`keepsProjection`），包括 compact、plan、clear 与段压缩，始终写完整投影。`compact_pending` 生成列、启动恢复与 fork 排除因此不用改。
- **读取与同步**：
  - `blocksCurrentSql` / `blocksCurrent` 把只存行的信封视为行当前，排队时也一样。账本变化入队期间，读者与无正文的同步都读行，不需要让队列区分写入来源。
  - `writeBlockStates` 对只存行的信封不推迟到队列。
  - 审计、回填 verify、`resyncFromColumn` 与图片扫描的列分支都跳过只存行的信封。
- **读开关**：只要存在只存行的信封，`blockReadsEnabled()` 就保持为真，读开关不会把读者带到空列上。原先自己判断读开关的读者也改走同一规则：模型历史源、消息页、导出、External API 推理读取、revert 选择与提交。
- **作业**（`narrator-block-backfill.ts`）：与 convert / verify 共用游标表，CHECK 扩为四个作业。由管理员在存储页启动，一次只跑一个；行初始为暂停；重启后已启动的作业继续。
  - `clear`：要求开关生效，且 convert、verify 已完成。
    - db-worker 找出块组装结果与列完全一致的块格式信封，跳过 compact 标记与排队中的信封。
    - 主线程只在 `body_revision`、`state_revision` 与读取时相同、且信封不在队列中时，才置 `'[]'` 和标记 1。
    - 不一致的信封记入诊断表，并按列重建，与 verify 相同。
  - `restore`：要求开关关闭。
    - db-worker 由行组装出投影。
    - 主线程只在 revision 与行签名都与读取时相同时写回，并把标记置 0。行签名由各行的 id、revision 与 state 长度按 ordinal 组成，覆盖了只改 state、不推进任何 revision 的同步重写。
    - 每遍走到最后一个只存行的信封。没有剩余即完成；否则从头再来一遍；从头开始的一整遍没有写回任何信封，就停下并记日志。
  - 两个作业都是仅状态写入（推进 `state_revision`）：模型可见内容和块行都不变，不 bump、不入队。读取后作业被停止或前置条件消失，这一片就不落库。
  - API：`POST /api/storage/blocks/projection`，参数为 `clear`、`restore` 或 `stop`。进度接口给出两个作业的状态、各自缺少的前置条件，以及是否存在只存行的信封。
- **测试**：
  - `narrator-rows-only.test.ts`：读者、排队、账本、状态写入、审计、读开关，以及开关开启时的写入与 compact 标记。
  - `narrator-projection-jobs.test.ts`：清空与恢复、前置条件、读取后被改写的信封被跳过、中途关开关、两作业互斥。
  - 把开关默认值临时改为开启，跑了相关测试：余下的失败都是测试本身直接读写 `content_json`。

**P3c 实现说明（退役信封级 FTS）**
- **只读块索引的搜索**：`createSqliteSearchStore` 带 `blockOnly` 模式，默认读 `isEnvelopeIndexRetired`（由 `ensureFts` 在启动时设定）。退役前各路径照旧；退役后全局消息、会话聚合与命中、时间线、Recall 的索引路径只读 `narrator_blocks_fts`：
  - 消息的某一个块包含全部可索引词即命中，取最好的 rank 并带上该块的 id；
  - 太短、无法用 trigram 索引的词仍作为 `content_text` 的子串过滤；
  - 旧格式信封（`body_format = 1`：导入、关闭块写入时写的、回填解不开的）没有块，按 `content_text` 子串匹配，无 rank，排在有 rank 的命中之后；
  - 摘录取消息文本中首个词附近的一段；只有块里有这个词时（工具输入输出、context）取该块的摘录；Recall 仍用 `>>>`/`<<<` 标出命中。
  - 子串策略不用索引，两种模式下相同。
  - **行为变化**：同一条消息里分在不同块的词（例如被一次工具调用隔开的两段输出）不再一起命中。这就是 D6 选定的按块匹配。
- **重建块索引的作业 `reindex`**：块索引是 contentless 的，文本由 store 计算，SQL 无法重建，所以退役前必须有重建它的办法。
  - `narrator_block_backfill` 增加 `reindex` 作业，接在 verify 之后自动运行。
  - 只补缺失的条目：store 在块或其采纳的账本结果变化时总会重写该块的条目，所以已有的条目就是对的；会缺的是丢失或清空后的索引。worker 先按 rowid 查块索引里有没有每个块（只读负载之前的列，约 2µs 一次），整条信封都齐就不再读它的正文与账本；有缺的才组装正文、用同一规划器算出缺失块的文本（流式中的块若留有条目则删掉）。因此完好的索引上 reindex 几乎不写；清空的索引上只有插入，不产生墓碑。`blockIndexText` 的公式若改变，须清空块索引让作业从头补齐。
  - 与 convert 相同的分工：只读 db-worker 读块行与账本、组装正文；每片受信封数 100、（读了正文的信封的）正文 4 MiB、索引文本 25.6 万字符与 1 秒的限制。
  - 主线程逐块写 FTS，每个写事务写到它的索引文本预算或超过 50ms 就结束，一片分几个事务写完；一条带几兆工具输出的信封也会被拆开。预算按整个事务（含提交）的耗时调整：超过 50ms 减半（最少 4K 字符），不到 25ms 且用满预算时增四分之一（最多 256K，起始 32K）。FTS5 写入时只做分词，落段与合并都在提交时做，约占事务时间的九成，大致与写入的文本量成正比；只看循环耗时会让提交拖到数秒。游标在信封写完后才越过它，重启时写了一半的信封整条重写。块按 rowid 升序写：FTS5 遇到 rowid 回退就要把待写词项落成新段。
  - 每个事务对它要写的信封重新检查：块的 rowid、id 与 revision 自读取以来都没变、读取开始后没被同步过、也不在同步队列里，才写 worker 算好的文本；否则（读取或写入期间正被写入的少数信封）改以 reindex 标记在主线程跑一次块同步，按当前内容重算。作业在两个事务之间被暂停或被送回起点时，这一片就此停下。不推进任何 revision。
  - "读取开始后没被同步过"由 `watchSyncs` 在内存里记录：store 同步自己写的信封，触发器把其余改动（含账本）排进同步队列，所以没被同步、也不在队列里的信封就是读取时的样子。主线程因此不再读账本：`model_revision` 是后加的列，物理上排在 `input_json`/`output_json` 之后，读它要走完每个工具结果的溢出页。
  - 所有作业的写事务按耗时让出主线程：事务用了 T，下一个写事务至少等 3T（至多 30 秒），即后台作业最多占主线程四分之一；worker 读取不受影响。其余作业仍是一片一个事务，超过 50ms 时下一片减半（最少 1 条信封）。慢事务告警每分钟至多一条，带作业名；reindex 只在单个事务超过 100ms 时告警（一个块或一次回退同步本身就花了这么久），并带上块数、索引字符数与回退同步数。
  - 最初版本在主线程逐条信封组装正文、读账本、规划并重写索引，大信封单片可达数百毫秒；第二版把计算移进 worker，但主线程仍逐条读账本指纹、一片一个事务，实例上每分钟仍有数百个 50–185ms 的事务；第三版拆成按时间截止的短事务，但没计提交时的落段与合并，且把完好索引里的每个条目删了重写（墓碑让 FTS5 把旧段整体重写），单个事务仍达 2.6 秒。已改为上述做法。
  - 存储页列出该作业，暂停对它同样有效。
- **退役**：`ensureFts` 在启动时，若 reindex 作业已完成，就在一个事务里先删三个触发器、再删 `narrator_messages_fts`，并设定 `isEnvelopeIndexRetired`。退役的判断先于一切信封级索引的处理，非 trigram 检查、缺触发器修复、非正常退出后的探测都跳过已退役的索引。
- **块索引丢失**：删除触发器缺失（表被迁移重建，rowid 可能已变），或后台完整性检查点名它损坏时（下一次启动），清空块索引并让 reindex 从头开始。非正常退出本身不再触发启动探测：FTS5 的 `integrity-check` 要拿写锁、在监听端口前读完整个索引，47 GB 的库上服务因此长时间起不来；而 WAL 下索引变更与它索引的行同一事务提交，崩溃拆不开两者。索引损坏由后台子进程的只读 `quick_check`（SQLite 3.44+ 会跑 FTS5 自带的索引检查）发现，只怪 FTS 索引的报告记入 `fts-repair.json`，下次启动只重建点名的索引，不走整库恢复。信封级索引因此留下，或者经已有的缺触发器修复从 `content_text` 重建回来，直到 reindex 再次完成。旧版本发现索引缺失时也按同样方式重建，所以退役可以回退。
- **PG**：PG 还没有块行，搜索不变。
- **存储页**：块索引计入「搜索」分类。
- **测试**：`block-only-search.test.ts`（删掉信封级索引后覆盖各路径、旧信封、跨块语义）；`narrator-block-backfill.test.ts`（reindex 在 verify 后运行且不动 revision，清空的块索引重建得与写入时一致，覆盖只存行的信封）；`fts-retire.test.ts`（退役前后、退役后再丢块索引的恢复、无块存储的库）。

**P3d 设计（前端按块渲染，删除 v1 协议）**

现状（main，P3c 之后）：
- **只有一个渲染器**：叙述者面板、聊天、公开分享都挂 `PretextExactMessageList`（vlist）。
- **入口转回 v1**：页面（`getPretextDocumentPage`、分享页）与 WS（`narrator-ws-manager`）都请求 `protocol=2`。`frontend/lib/block-protocol.ts` 在入口处把信封 + 块拼回带 `contentJson` 的 `TreeMessage`，按 `parentMessageId` 嵌进 `children`，块的范围另存进 `block-refs.ts` 的模块级登记表。
- **存储与渲染**：`PretextLayoutCoordinator` 持有 `TreeMessage[]`。行由 `message-segments` → `render-units` → `pretext-document-layout` → `segment-adapter`（`shared/pretext-layout`，只有前端用）按 `contentJson` 下标逐元素构建，注入与伴随块的配对在前端用 `contextBlockViews` / `injectionBlockViews` 重做一遍。
- **已经按块的**：行键（`blk-<blockId>`）、账本补丁（`tool_started` / `tool_completed` 带 `blockId`）、删除与回滚等操作（已知块时走 `/blocks` 路由）。
- **流式还不按块**：`block_delta` 被转回 v1 的 `stream_event`，块 id 丢掉；`block_opened` 被丢弃。流式副本与落库副本按元素 id + revision 配对，没有元素 id 的流（provider 不带 id 时服务端不发 `block_delta`，原样发 v1 `stream_event`）靠文本后缀与 `outputIndex` 的启发式。
- **规模**：约 48 个生产文件、5.5–7 千行要改，另有约 1 千行死代码可删（`message-tree-utils` 中 15 个无调用的导出、`narrator-message-helpers` 的几个辅助函数、`TreeMessage._blockOriginalIndices`、没人填充的 React Query 消息缓存）。

目标：前端只认信封 + 块。入口不再转换，`contentJson`、`children`、`blockRefs` 登记表从叙述者消息的前端代码里消失。

- **store**：`PretextDocumentInput` 改为 `{envelopes, blocks}`。
  - 信封保留现有元数据（role、origin、`toolCalls` 账本行、编辑信息、`parentMessageId`、seq），按 seq 排序，用 `blockIds` 列出自己的块。
  - 块按 id 存（`BlockDTO`：kind、subtype、phase、revision、wireId、attemptId、elements、hasOriginal）。
  - 派生索引代替树遍历：`parentMessageId` → 子信封（取代 `children`），`wireId` → tool 块，信封 → 块。
- **帧的应用**：
  - `message_upserted` 与 catch-up：信封替换；块按 id + revision 取新；信封不再列出的块删除。
  - `messages_deleted`：删信封及其块。
  - `segment_compact_hide`、compact 标记状态：照旧作用于信封。
  - 现有的 upsert / replace / insert / remove 改写为按块的同一套规则。`message_updated` 只接受截尾或 COW 别名的限制随之消失，因为块按 id 合并，不再按元素下标比对。
- **流式**：
  - `block_opened` 在 store 里建一个 open 块（尚无 messageId 时挂在流式尾部）；`block_delta` 按块 id 追加（revision / textOffset 去重）；工具的输入片段按 `block_opened` 给出的块 id 归到 tool 块。
  - 同一块 id 的落库块（下一次 checkpoint 的 `message_upserted`）到达时直接取代 open 块。
  - 流式累加器、`streaming-handoff`、`streaming-block-supersede` 的文本后缀与 `outputIndex` 启发式、`streaming-tool-chunks` 里遍历 `contentJson` / `children` 找已落库工具的逻辑全部删除。
  - 前提：服务端给每个流式元素都配上元素 id（provider 不带时由服务端按 `${attempt}:${order}` 补上），这样每个增量都以 `block_delta` 发出，不再有 v1 `stream_event` 的旁路。
- **建行**：
  - 分段、活动单元、`segment-adapter` 改为逐块遍历。一个块是一个渲染来源，多元素块（附件 + 文本的 input、注入 + 伴随的 context）把块内元素交给现有的逐元素适配函数（`adaptSystemBlock`、`adaptReviewCard`、`adaptFramedSystemCard`、`adaptSpokenInjection`、`buildToolCardData` 等）。
  - 注入与伴随块的配对由块边界给出，服务端解码与同步时已按同样的规则分组，前端不再重做 `contextBlockViews` / `injectionBlockViews`。
  - tool 卡由 tool 块与信封的 `toolCalls` 按 `wireId` 关联；reasoning 段由相邻的 reasoning 块组成。
  - 键：叙述者消息一律 `blk-<blockId>`，块内多个可选元素加 `+<offset>`；tool 行仍是 `tool-<toolUseId>`；按位置的 `-b<i>` 键只剩非叙述者行。
- **补丁与寻址**：
  - 工具字段：按 `blockId`；只给了 toolUseId 的事件经 `wireId` 索引找块。
  - 子代理活动：经子信封索引。
  - 选择、编辑目标、ask-in-passing、工具元信息、反思与 spec 任务索引：从 `(messageId, blockIndex)` 改为块 id（加块内偏移）。
  - 操作只走 `/blocks` 路由，前端删除按下标的调用；服务端按下标的路由若无其他调用方一并删除。
  - 「显示原文」按块的 `hasOriginal` 走块详情路由，不再读信封的 `originalContentJson`。
- **非叙述者行**：聊天（`chat-vlist-adapter`）与分享页讨论区现在拼合成的 `contentJson` 行，改由一个小的辅助函数生成信封 + 块（每个元素一块，合成 id），渲染器只有一种输入形态。
- **服务端**：
  - 删除 v1 页面与 v1 消息帧的输出、订阅时的协议协商和 `narratorBlocks.wsV2` 设置（设置迁移去掉这个键）。
  - 发射方内部仍可产出 v1 形态的帧，经 `narrator-block-protocol.ts` 映射后发出；这个映射成为唯一出口。
  - 旧格式信封照旧现场解码成块（§10.7），前端只见块。
- **回退**：前端改造后 v1 路径不可达，所以 `wsV2` 开关与改造在同一个 PR 里删除，回退靠上一个正式版本。P3d 在默认开启 v2 的版本正式发布之后开始，这样 v2 协议本身已在线上跑过。

**P3d 分步**（每步提交后 CI 全绿、应用可用；服务端两步与前端各自成 PR）：
1. 直接升级测试（§10.7）：P1 之前 schema 的库快照，覆盖迁移、现场解码、回填与退役。只测服务端，先行落地，后面各步都受它保护。（已完成）
2. 服务端保证每个流式增量都带元素 id：loop 是 `stream_text` / `stream_reasoning` 唯一的产生者，它的 `OutputContentAccumulator` 总给出与落库元素相同的 `${attempt}:${order}`；事件类型改为必填，删掉无 id 的回退（按 lane 的随机 id、OpenAI itemId、`FileReferenceContextTracker` 按输出下标的通道），每个增量都以 `block_delta` 发出。（已完成）
3. 前端的块访问器 `messageBlocks`（`shared/narrator-blocks/message-blocks.ts`）：协议行按它带的块；客户端自建的行（流式行、聊天与分享页的行、测试数据）按服务端切分旧信封的同一函数 `splitEnvelope` 切块，两边分组一致（块页测试里有对齐检查）。之后读消息正文的代码都经它，不再按 `contentJson` 下标。（已完成）
4. 身份：所有元素行按块作键（`elementKey` 经访问器）；块目标、选择、编辑目标、ask、各索引与操作改为块 id（加块内偏移），经文档里的行解析，不再查全局登记表。
   - 已完成：元素行键与 vlist 块目标经访问器；删除（单个、批量）、回滚、文件恢复预览与编辑重生成在操作开始时从列表的行解析块（`MessageListHandle.messageOf` + `message/block-target.ts`），API 直接用块 id。服务端命名过的块（`MessageBlock.named`）才走 `/blocks` 路由，客户端自建的行仍走按下标的路由，直到第 7 步。`block-refs.ts` 与没有调用方的回滚预览、块删除预览查询已删除。
   - 余下的选择项、编辑目标、ask、工具元信息与反思索引并入第 5 步：它们的 `(messageId, blockIndex)` 来自分段按元素下标的遍历，分段改为逐块后随之得到块 id，单独先改只会多一层下标与块之间的换算。
5. 正文经访问器：读消息正文的代码一律经 `messageBody`（元素）或 `messageBlocks`（块），不再读行的 `contentJson`。`frontend/lib/narrator-body-access.guard.test.ts` 按文件计数余下的直接使用，只降不升：访问器本身、行类型、构建或改写行的代码（store 的合并与补丁、流式、协议解码、聊天与夹具的行）。（已完成）
   - 分组不另改写：非 assistant 消息在服务端解码为一个块（input 或 context），注入与伴随块的配对用的是与服务端解码相同的 `contextBlockViews` / `injectionBlockViews`；assistant 消息的分段按元素的类别（正文、工具、相邻 reasoning 成段），块边界只落在元素之间、不跨类别（旧信封每个元素一块）。按元素遍历得到的分组因此与逐块遍历相同，改写不会改变输出。
   - 元素在消息内的位置只作遍历坐标（选择项、编辑目标、ask、各索引仍以 `(messageId, 位置)` 记），由 `messageBody` 从块推出，第 7 步后含义不变；身份（行键、操作）已按块。
6. 流式只认元素标识：每个流式增量都带元素 id、revision 与原始偏移，服务端快照块同样（loop 的累加器本来就给出，`stream_text` / `stream_reasoning` 的这两个字段改为必填，事件处理去掉缺偏移的分支）。前端的增量折叠、快照合并与交接只按 id + revision：删除按 `outputIndex` 认道、按文本后缀与 `providerMetadata.openai.itemId` 判断覆盖、合成的 `streaming:*` id，以及只为无版本块保留的丢弃路径；不带标识的增量与快照道不再应用。web_search / image_generation 仍按 id 在本轮落库后退场。开发用的模拟流按服务端的方式给出 id、revision 与偏移。（已完成）
   - 累加器与交接保留：它们本就以元素 id 为键。交接把更新的 revision 合进同 id 的落库块，把已按该 revision 落库的道从流式行里去掉，这就是"同一块 id 的落库块取代 open 块"。把它们改成 store 里的 open 块只换数据结构，与第 7 步行直接持有块一起做。
7. 协议与行：
   - 7a 删除 v1 协议与 `wsV2`：页面接口（含公开分享页）与 WS 只发 v2，消息帧、流式快照、catch-up、工具开启都按 v2 发给每个订阅者；订阅不再协商协议（已加载的旧前端仍会带的 `protocol` 字段照常接受、不起作用），`message_protocol` 帧删除；设置加载时去掉存量的 `narratorBlocks.wsV2`。前端不再请求协议，解码不再放行 v1 页面与 v1 catch-up。服务端内部仍以行的形状（`contentJson`、`children`）构建消息，由 `narrator-block-protocol.ts` / `narrator-block-page.ts` 统一转成 v2 发出。（已完成）
   - 7b 行改为直接持有块：`messageBody` / `messageBlocks` 改从块读，守卫里列出的改写行的代码改为按块；删除 `contentJson`、`children`、`blockRefs`、`block-protocol.ts` 的回转、按下标的路由与死代码；更新文档。分三个 PR：
     - 7b-1 行持有块：`TreeMessage.blocks`（`RowBlock`：块的身份 + 元素，服务端命名的块 `named`）取代 `contentJson` + `blockRefs`。解码器直接给出块；客户端自建的行（流式行、子代理流式行、工具分片行、聊天行、夹具）由 `rowWithElements` / `splitRowBlocks` 按 `splitEnvelope` 切块；改写正文一律经 `mapRowElements` / `filterRowElements`，块保持 id，未变的块与行保持引用，空块去掉。`messageBody` 按块数组缓存展平结果，正文身份随块不变。交接从流式行去掉已落库的块后，余下块的 id（与键）不再因重切而移位。守卫只剩访问器与行类型；尚未迁移的夹具仍以 `contentJson` 建行，访问器读它时按服务端规则切块。（已完成）
     - 7b-2 删除行上的 `contentJson`：`TreeMessage.blocks` 必填，`contentJson` 从行类型与访问器里删除，没有块的行正文为空，访问器不再替任何行切块。顺手问的开始与解答接口原先直接返回带 `contentJson` 的行，改为按块协议返回该消息（`toEnvelopes`），前端在接口层解码（`decodeBlockMessage`）。测试夹具一律经 `rowWithElements` 建行，原地改正文的测试改为替换块。守卫只剩 `splitRowBlocks` 交给服务端切分函数的一处。（已完成）
     - 7b-3a 按下标的路由与死代码：前端的块操作（回滚、删除块、批量删除、文件恢复预览）只认服务端命名的块，客户端自建的行（流式行）没有可操作的块，不再退回按下标的路由。服务端删除只有旧前端调用的按下标路由：`POST /:id/rollback/:messageId`、`DELETE /:id/messages/:messageId/blocks/:blockIndex`、`DELETE /:id/messages/batch-blocks`、`GET /:id/rollback-preview`、`GET /:id/block-delete-preview`，以及没有调用方的 `GET /:id/segment-compact/:messageId/messages`；路由测试改走 `/blocks` 路由（`tests/block-ids.ts` 按元素位置取块 id）。编辑重生成仍可按消息寻址（整条消息，不是下标）。前端删除没有生产调用方的消息树与流式子行辅助函数（React Query 消息缓存、按 toolUseId 的索引、子代理流式子行、顶层流式分片对账等）及只测它们的用例，失效查询里去掉已无查询的预览键。服务层按下标的函数仍是块路由的实现，保留。（已完成）
     - 7b-3b 行平铺，删除 `children`：服务端只把一种消息嵌在另一行下面——旧数据里非子代理工具的内联回复（`inlineRows`；Agent / Task / Send 的子会话从不进父树，父行只带活动摘要），前端从不单独渲染它们。解码器不再把信封嵌回 `children`，行按信封顺序平铺：每行之后紧跟嵌在它下面的行，嵌套的行保留 `parentMessageId`（`TreeMessage.children` 删除，`message/nested-rows.ts` 给出判断与索引）。会话主线是不嵌套的行：分段、选择、尾部元信息、catch-up 游标、spec 任务定位与流式交接跳过嵌套的行；工具项的嵌套行（定子代理样式）由分段每轮按 `parentMessageId` + `parentToolUseId` 建索引取得，分段缓存按它浅比较。补丁、反思索引、工具元信息与已落库工具的收集直接扫平铺的行，不再递归。文档操作：追加拒绝嵌套的行，尾部 seq 判断跳过它们；upsert 原地更新已有行（嵌套的行原地不动，不再继承 `children`），新的嵌套行插到父行的嵌套行之后，父行不在则拒绝；中间插入与 ask 卡不插进一行与它的嵌套行之间；删除与裁头连带嵌套的行；COW 替换让嵌套的行改挂到新 id。守卫测试以类型检查保证 `TreeMessage` 没有 `children`。（已完成）

**验收**：
- §10.7 的直接升级测试通过。
- 前端生产代码里叙述者消息不再读 `contentJson` / `children`（`narrator-body-access.guard.test.ts`：`contentJson` 按文件计数，`children` 由类型检查保证）。
- 流式、交接、编辑、删除、回滚、ask、反思、子代理、compact、翻译的现有前端测试改为喂信封 + 块后全部通过。
- 浏览器测试覆盖一次完整的流式回合：open 块 → 落库块，键不变、无闪烁。

### P3e 同步成本：工具结束不再拖住主线程

**问题**（多个代理并行时主线程卡顿）
- 工具结束（`updateToolCallResult`）的事务末尾调用 `flushChangedEnvelopes()`，从全局队列取最多 64 条消息同步，不限于本次写入的消息，也不计时间预算。
- 同步一条消息总是整条重算：读出全部正文与全部工具记录（含完整输出），每个输出解析两次。
- 条件里有 `output !== undefined`，每个有工具记录的工具块每次同步都要重写附件、重算 `outputToText`，并删插一遍 trigram 索引。
- 一条消息有 N 个并行工具时，每个工具的每次状态变化都让整条消息重新入队，索引写入总量是 N² 级。实测（Bun，32 个各 50 KiB 输出的工具逐个结束）：第 k 次结束写 k 条索引，单次阻塞从 15ms 涨到 201ms，合计约 2.8s；队列里积压 64 条时，一次小工具结束在单个事务里阻塞 542ms。

**设计**（不改触发器契约，v3 原样保留）
1. 按工具记账（工具记录轮）
   - 块行新增 `ledger_revision`：它上次同步时采用的工具记录，记为 `调用 id:model_revision`。`model_revision` 由 v3 触发器在输入、输出、状态、attempt 等列变化时递增，所以它就是"这次调用变了没有"。
   - 信封新增 `blocks_content_hash`：块行上次所依据的 `content_json` 文本的哈希。store 写正文时由序列化结果算出（drizzle 的 JSON 列即 `JSON.stringify`），队列同步时由列文本算出。
   - 队列同步先判断正文是否没变：只存块行的信封（块行就是正文），或列文本仍哈希到记录值。没变时只走工具记录轮：读出各工具块的指纹和被采用调用的 id 与 `model_revision`（不读输入输出），只重派生指纹变了的工具块；每块单独解码它自己的元素和它那一次调用，得到 phase、subtype、`model_chars`、附件、账本绑定，并排入索引。工具块的这些列只取决于它自己的元素和这一次调用，所以与整条消息解码的结果相同（测试逐列比对）；单块解码得不到同一个调用的工具块、或 payload 与行不一致时，退回完整同步。
   - 完整同步也不再读工具输出：输出列只取"是否 `_broken`"（SQL 里先 `instr` 预筛再 `json_type`，与 `isBrokenToolOutput` 等价），附件只为新块、变化的块和指纹变了的块读取它那一次调用的输出。`model_chars` 变化也计入"变化"，从而随工具记录输入的改写更新。
2. 索引出队（`narrator-block-index.ts`）
   - 新表 `narrator_block_index_queue (block_id, version)`。同步不写索引文本，只把封闭的块排入队列（再次排入时 `version + 1`）；块回到 `open` 时同步删掉它的索引行并出队。
   - 后台任务：db-worker（`blockIndexQueueSlice`）从只读连接按 `plannedTexts`（与重建索引任务同一套）算出排队块的文本；主线程按 rowid 顺序写入，每个事务以字符预算和 `APPLY_TARGET_MS` 截止，之后按耗时的 3 倍让出主线程。写入前核对：队列 `version` 未变、所在信封不在同步队列里、块的 rowid 未变，否则留待下次。
   - 重建索引任务跳过排队中的块，由队列写入。启动时有积压就开始写。
3. 写入事务只同步自己排入的项
   - store 事务开头取同步队列的水位线（`syncQueueMark`），结束时只同步水位线之后排入的项（`flushQueuedSince`，上限 64）。别人此前排入的项、批量复制有意留给清扫的项，都交给清扫。
   - 清扫每处理一条就检查一次 25ms 预算；有积压时按耗时的 3 倍（至少 100ms）后再来，没有积压时 5 秒一次。单条同步超过 50ms 记慢日志（一分钟最多一行）。

**效果**：一个工具结束只读它自己那一次调用、只写它自己的块，与消息里有多少工具、多少代理同时跑无关；分词移到后台、有预算的切片里。

**取舍**：排队中的信封由列读取（已有行为），排队窗口变长不影响正确性；块的派生列（附件、`model_chars`、索引）对非 store 写入最多滞后到下一次清扫；搜索滞后几百毫秒。

## 12. 风险与成本

### 12.1 存储
- **每行固定开销。** 每个块一行，开销包括行头、`id`/`message_id`/`attempt_id` 三个 21 字节文本，以及主键和 `(message_id, ordinal)` 两条索引的条目，粗估每块 150–250 字节。按 100 万块计，约 150–250MB。
- **先测量再定。** P1 之前，在生产库副本上用存储扫描 worker 统计「每条消息的块数分布」和正文体积，确认上面的估算。参考规模：
  - 一个 3.1 万条消息的叙述者，前缀正文约 149MB（`narrator-service.ts:216-218`）；
  - 账本表 56.1 万行，所在库 6.6GB（`schema.ts:1789-1790`）。
- **双写期正文约占两份。** P1–P2 期间，新信封同时保留派生的 `content_json` 和块行，正文体积接近翻倍；P3 清空后需要一次管理员 VACUUM 才能回收。

### 12.2 写入与触发器
- **流式期间写得更少。** 每个 checkpoint 从「整列重写 + 四组触发器」降为「单块 UPDATE，不触发 revision」；revision 触发器只在块封闭时触发。
- **超长块的成本依旧。** 单块重写的开销与块长度成正比，所以 10 万字级别的单个文本块在每个 checkpoint 仍有成本，与现在的量级相同。必要时可以对超长块的 checkpoint 限频。
- **持有者扇出不变。** 块封闭时 bump 持有者叙述者的方式与现在一样；被 fork 树广泛共享的信封不会在流式中，所以不受影响。

### 12.3 投影改造的回归风险
这是最大的风险：一个字节的差异，就意味着 prompt cache 失效，甚至产生非法请求。缓解手段：
- P0 不改 schema、单独发布，先在生产上稳定运行。
- 每种 provider 模式都有等价测试，并对真实请求录制做 diff。
- 每处有意的行为修正（附录 B）单独列出，单独验证。

### 12.4 双格式的复杂度
- 解码路径、写时物化、回填作业永久保留（§10.7）：跨版本直接升级的实例、PG 与 project.db 导入都离不开它们。
- 代价是一直背着两种存储格式的读取；P3a 之后它们只在中央正文层与回填服务里，其余代码只见块。要删的是协议层的双轨（v1 / v2）和前端入口处的形状转换（P3d），不是存储层的旧格式。

### 12.5 PG 与迁移工具
- 新表和触发器要维护两种方言，并由生成器支持 v2 契约。这是 P1 的前置工具改动。
- 不得手改 `drizzle/` 或 `drizzle-postgres/`。
- PG 写路径不在本设计范围内。PG 只要求 schema 能生成、`db:check:pg` 能通过。

### 12.6 语义变化
以下几处是有意的行为变化，需要逐项写进 changelog：
- COW 时作者与属主分开（§6.3）；
- 惰性 fork 的共享判定（§6.2）；
- 工具执行期间 fork，不再带上正在执行的那一步（§3.5）；
- `input` 与 `context` 按作者区分，系统写的 role=user 行不再带人类的 sender 标记（§3.3）；
- 段压缩标记的 origin（§6.4）；
- broken 调用在重建出的历史里不再出现，改为一条说明（§5.3）；
- 内部执行不进模型历史（§3.7）；
- assistant 编辑只改被点的那一块（§5.5）；
- `aborted` 块的重放规则（§3.5）；
- turn nudge 从工具结果里移出，改为该步工具结果之后的一条独立文本（D12）；
- 纪元内不再改写已发送的前缀（工具、system prompt、历史）：影响行为的变化改为追加提醒，改名等展示性变化延到下个纪元生效；已被采纳的 agent 消息修订改为追加通知（§7.7）；
- 跨越投影切换的那次发布，会有一次 prompt cache 未命中（§7.6）；
- Await 回执只许更早的回执缩短更晚的工具结果（§7.2）；
- 纪元内 plan mode 不再改写工具描述（§7.7）；
- 编辑过的 assistant 文本按纯文本回放，不再带上游 item id 与 annotations（§5.5）；
- Gemini 上游给出的 `functionCall.id` 原样回带（§7.9）。

「轮」的定义一旦落库就很难再改，因此 D3 必须在 P1 之前定下来。

### 12.7 效率预算

**流式写入：一步的写入次数**

设一步有 N 个 item、K 个工具调用、C 次 checkpoint、H 个持有者（流式中 H = 1）。

| 动作 | 现在 | 块存储 |
|---|---|---|
| 每次 checkpoint | 读整列 + 写整列 + 重算 `content_text` / `context_chars_json`；FTS 删插；`model_history` 触发器（其嵌套 UPDATE 再触发一次 FTS）；H 行叙述者 UPDATE；context stats upsert；广播整条消息（§1.3 G） | 一行块 UPDATE（`payload`、`revision`），无触发器；广播 `block_checkpoint` |
| 每个 item 封闭 | 同上（也是一次 checkpoint） | 一行块 UPDATE + 一次 revision 触发（1 行信封 + H 行叙述者） |
| 每个工具 | 块与账本分两步写；settle 写账本 | `callTool` 2 行 INSERT；`settleTool` 2 行 UPDATE + 一次 revision 触发 + 一次派生 |
| 封口 | 再一次 COW 写 `completed:true`（`narrator-output-recovery.ts:46-63`） | 一行信封 UPDATE（用量与派生），FTS 重建一次，context stats 一次 |
| 合计 | O(C) 次整列重写与四组触发器，FTS 约 2C 次 | C 次单行小写；revision 触发 N + K 次；FTS 1 + K 次 |

单次 checkpoint 的字节量从「整条消息」降到「这一块」。超过 256 KiB 的块限频（§4.1），所以最坏情况受 `块大小 × 每 2 秒一次` 约束。

**模型历史读取：每批三次有界查询**

每批最多 200 个 ref（`MODEL_HISTORY_REF_BATCH`，`agent-runtime/model-history-query.ts:4`），全部在只读 worker 里执行：

1. refs JOIN 信封元数据：取 seq、role、作者、`body_format`、`body_bytes`。按 `body_bytes` 把 ref 切成不超过 4 MiB 的子批。现在这一步要对每行算 `length(CAST(content_json AS BLOB))`（`model-history-query.ts:122-127`），会读到正文。
2. 块：`WHERE message_id IN (…) AND phase <> 'open' ORDER BY message_id, ordinal`，走 `UNIQUE (message_id, ordinal)`。
3. 被采用的账本行：`WHERE id IN (result.toolCallId …)`，主键查找，按 `output_json` 长度切批。不再分页扫描整个信封的全部 attempt 再推导最新一次。

另加一次纪元查询：最近一个开启纪元的块（`(subtype) WHERE kind = 'context'` 部分索引 + refs 的 seq），以及它引用的 system 快照（主键）。总预算沿用 128 MiB / 10 秒（`model-history-query.ts:6,101-108`）。

**主线程规则对照**（CLAUDE.md「后端主线程性能规则」）

| 规则 | 本设计 |
|---|---|
| 主线程 SQLite 只做小、快、有索引、有限制的 CRUD | store 的每个方法只碰一个信封的块；共享判定是一次部分索引探测；对账没有差异时不写库 |
| 禁止无上限 `.all()` | 块查询总带 `message_id IN (≤200)`；启动恢复按部分索引分页（每页 100，沿用 `COMPACT_RECOVERY_PAGE_SIZE`，`narrator-persistence.ts:745`） |
| 列表 API 不读大字段 | 页面 API 不选 `provider_meta`、`original_payload`；需要「有没有加密推理」时只判 `provider_meta IS NOT NULL`（推测：SQLite 只看记录头的类型码即可判 NULL，P1 用 `EXPLAIN` 与基准确认；否则加一个派生的整数标志列） |
| 分页用游标 + `LIMIT n+1` | 页面 API 仍按 refs.seq 游标，块随信封批量取 |
| 大工作放 worker | 解码、回填读正文、asset 预取、投影都在 worker；主线程只做每片一个短事务 |

**FTS**
- 信封级索引：更新次数从每次 checkpoint 一次（触发器不限定列时还要更多）降到每步 1 + K 次；P3 退役。
- 块级索引（D6）：与信封级在同一时刻、同一事务里批量写入，每步 1 + K 个事务，每次删插这一步变化过的块（一步 N 个 item 就是 N 行）。行数多了，事务次数没有增加。
- 回填不改 `content_text`，不写信封级索引；但要为旧信封补写块级索引，这部分 FTS 写入计入每片 50ms 的预算（§10.3）。
- 存储：contentless 表只存倒排索引，trigram 索引大约是正文的 1–3 倍（推测，P1 前在生产库副本上测）。迁移期两套索引并存，P3 退役信封级后回落。

**迁移成本**
- 存储：每块固定开销 150–250 字节（§12.1）；双写期正文约占两份。
- 回填：每片不超过 100 个信封、4 MiB、1 秒，主线程每片一个短事务。以 100 万个信封、每片 50ms 主线程时间粗估，主线程累计约 8 分钟，分散在片与片之间（推测，需在生产库副本上测）。
- 回填不 bump revision、不失效源缓存、不改信封级 FTS，所以运行中的会话感知不到它；块级 FTS 的补写只影响搜索结果的粒度。

## 13. 验收矩阵

| 场景 | 期望 | 验证 |
|---|---|---|
| 各 provider 投影：Anthropic 官方/中转、Responses HTTP、Codex HTTP/WS、Completions、Gemini generateContent/Interactions、NUG 各通道、TokenDance、插件 | 新旧实现在录制语料上逐字节相同（附录 B 中有意修正的项除外） | 单测 + 请求录制 diff |
| 重建 == 实时 | 同一 pass 内的任一请求，都能由 DB 重建出相同字节。覆盖 broken 调用、mid-pass 注入、当前轮合并、工具结果图片、turn nudge、丢弃的 attempt | 每种 provider 的等价测试 |
| 并行工具 | 结果顺序等于 tool 块的 ordinal，即调用顺序 | 单测 |
| 单元一致性 | 非 assistant 信封恰好一块；`input` 的删除、选择、回滚作用于整块；reasoning run 的操作带整组 id | store 守卫 + 前端测试 |
| assistant 编辑 | 只改被点的 output 块，其他块的 id、位置、revision 不变；恢复不影响其他块 | 单测 |
| 流式 | 块 id 从 `block_opened` 到落库不变；没有合成消息；重连后不重复、不回退 | 前端集成测试 |
| 丢弃 attempt | 只删除该 attempt 的 item 块；已执行的 tool 块保留，并投影为更早的独立一轮 | 单测 |
| 中断与冷启动 | `open` 的 output / reasoning 改为 `aborted`，控制标记改为 `failed`；tool 不动；按 §3.5 重放 | 单测 + 重启恢复测试 |
| fork | 含 `open` 块的信封不共享；惰性 fork 之后，父叙述者修改旧消息会走 COW | 单测 |
| 约束 | §4.1 的每条 CHECK 都有一个写入被拒的测试；跨行不变式有 store 守卫测试 | 单测 |
| 骨架回放 | 每种协议：同源时「part 填回骨架」与上游原始 item 逐字节相同；跨源时请求里不出现骨架字段 | 用上游录制做测试 |
| COW | 只有一个实现；作者不变；克隆的账本行不可执行，且 `block_id` 已重映射；mailbox 回执同步更新 | 单测 |
| UI 状态 | `patchState` 不改变 `model_history_revision`，不触发 FTS | 触发器测试 |
| compact 与段压缩 | 生命周期与现状等价；CAS 不再使用 JSON 路径 | 现有 compact 测试迁移 |
| 回退与块删除 | 以块 id 寻址；重跑过的工具也能删除并回退文件；预算按块字节计算；共享信封走 COW | 现有回退测试迁移 |
| Codex WS | 有 assistant 输出之后的下一次请求仍能增量续写 | 用上游原始 item 的录制做测试 |
| 工具加载策略 | 五种策略各自的线上形态与参考实现一致；按协议选择正确；策略 5 开启新纪元；新纪元里旧的 `tool_loaded` / `tool_unloaded` 只投提示文本；已实现版本的测试（`tool-loading.test.ts`、`loop-tool-loading.test.ts`）在两段投影上不改即过 | 单测 + 请求录制 |
| 对账 | 绕过 `/load` 的集合变化（resident、预加载）在下一次请求前补写一个工具变更块，纪元基线不变；system 各节变化写 `reminder`；没有差异时不写库 | 单测 |
| 前缀保持 | 纪元内，已发送的工具定义、system 各节、信封投影哈希不变；违例被记录并带上原因；换纪元的三种条件都能触发重建；fork 的第一次请求与父叙述者前缀相同 | 前缀核对 + 单测 |
| External API v1 | 现有契约测试不修改即通过 | 契约测试 |
| project.db | 导出再导入，内容相等；旧归档可以导入 | 往返测试 |
| 搜索 | 结果与现状一致（content_text 规则逐条复刻） | 搜索测试 |
| 回填 | 可中断、可恢复、幂等；校验无差异；主线程单片不超过 1 秒；不改变任何叙述者的 `model_history_revision`，不写 FTS | 作业测试 + 慢操作日志 |
| 性能 | 流式写入耗时、模型历史加载、页面首屏都不劣于现状 | benchmark |
| 存储 | 在生产库副本上测得的增量落在预估范围内 | 存储扫描 |
| PG | schema 和迁移可以生成，`db:check:pg` 通过 | CI |

## 14. 决策记录

| # | 问题 | 结论 | 状态 |
|---|---|---|---|
| D1 | tool 结果的文本是否复制进块 | 不复制。块只存被采用的 attempt、结果图片、附言；文本留在账本 | **已定** |
| D2 | tool 块的 `input` 以哪份为准 | 重放实际执行的输入（重定向或修复之后）；账本保留每个 attempt 的执行输入 | **已定** |
| D3 | 「轮」的边界 | 以一次运行为界（§3.6）：插话、注入、自动续跑都留在同一轮 | **已定** |
| D4 | `aborted` 块是否重放 | text 重放，reasoning 不重放 | **已定** |
| D5 | 前端传输怎样演进 | 一步到位：P1 前端不动，P2 时页面 API、WS v2 与前端 store 一起切换到规范化结构；未回填的旧信封读取时现场解码（§8.1） | **已定** |
| D6 | 是否做块级 FTS | P1 起建块级 FTS（contentless、trigram），与派生字段同一时刻批量写入；迁移期两套索引并存，回填补写旧信封，P3 退役信封级 FTS（§4.6、§12.7） | **已定** |
| D7 | 是否建 `narrator_turns` 表 | P1 就建 `narrator_turns`：运行开始插入、结束更新一次；`turn_id` 不设外键（§4.4） | **已定** |
| D8 | `content_json` 的终态 | 当前版本保留派生投影；确认稳定后再单独立项清理（§10.4） | **已定** |
| D9 | 作者与属主是否拆分 | 拆分，新增 `author_narrator_id` | **已定** |
| D10 | assistant 编辑的作用域 | 只改被点的那个 `output` 块（§5.5） | **已定** |
| D11 | broken 调用在历史中的形态 | tool 块 `failed`、不可见，另加一条 `context` 说明，与实时路径一致 | **已定** |
| D12 | turn nudge 放在哪里 | 单独一条 `context` 块（subtype `turn_nudge`），排在该步工具结果之后；不再拼进工具结果。这会改变发给模型的内容，列入 §12.6 | **已定** |
| D13 | 引用锚点是否写进模型可见正文 | 保持写在正文里；锚点改为块 id（`b:<blockId>`），COW 后靠 lineage 解析 | **已定** |
| D14 | sender 标记里的标题与用户名在改名后的处理 | 纪元内沿用旧值、不提醒；换纪元时按最新数据重建（§7.7） | **已定** |
| D15 | 前缀保持覆盖哪几层 | 工具定义、system prompt、历史三层都覆盖（§7.7） | **已定** |
| D16 | 纪元边界 | compact 成功、切换 provider 或模型、缓存肯定已冷 | **已定** |
| D17 | 哪些变化追加提醒 | 只对影响模型行为的变化提醒；纯展示性变化静默沿用旧值 | **已定** |
| D18 | mailbox 语义编辑 | 未被接收方采纳的原地改写；已采纳的追加修订通知 | **已定** |
| D19 | 是否提供「按最新数据重建上下文」的手动操作 | 只提供斜杠命令 `/refresh-context`，执行 `openEpoch(reason = "manual")`；不加界面入口（§7.7） | **已定** |
| D20 | 纪元内加载工具 | 五种策略，由模型在 catalog 里声明（可多种），按当前协议选用；都不适用时直接改 tools[] 并开启新纪元；新纪元完全重新构建（§7.8） | **已定** |
| D21 | 工具加载策略的默认值 | 按裸模型名匹配：含 gpt 用 `openai_additional_tools`，含 claude 用 `anthropic_tool_addition`，含 deepseek 用 `anthropic_deferred_tail`，其他用 `custom_injection`；catalog 声明可覆盖，用户可禁用（§7.8） | **已定** |
| D22 | kind 是否从 7 种收为 5 种 | 推荐收：`marker`、`notice` 并入 `context`，按 subtype 分族；可见性统一为「`done` 且 `model_text` 非空」（§3.3）。备选：保留 7 种，代价是三处 kind 分支与三套可见性规则 | **已定** |
| D23 | phase 是否从 6 个收为 4 个 | 推荐收：tool 的 `called`、`settled` 分别并入 `open`、`done`；输入流式阶段不落行，不需要名字（§3.5）。备选：保留，代价是部分索引、触发器、共享判定都要比较两个值 | **已定** |
| D24 | `provider_meta` 的形状 | 推荐「来源 + 上游原样骨架」：正文换成 part 引用，其余字段原样；同源回放把 part 填回（§3.4）。备选：按协议的字段白名单，每遇上游新字段都要改 schema，Codex WS 续写只能靠测试补字段 | **已定** |
| D25 | 纪元状态存在哪里 | 推荐：开启纪元写一个 `context` 标记块（compact 块兼任），工具定义与 system 正文按内容寻址存 `narrator_text_snapshots`；纪元内一切变化由每次请求前的对账写成追加的块（§7.7、§7.8）。已实现的倒推保留为旧数据的兜底与一致性检查。备选 A：前两轮的两张旁表，fork / 提取要另外复制；备选 B：全部倒推（即已实现的做法），绕过提示行的变化会漂移，system 正文也无法倒推 | **已定** |
| D26 | Await 回执改写怎样满足只追加 | 推荐：只许 seq 更早的回执缩短更晚的工具结果；后到的回执与更早的结果都保留全文（§7.2）。备选：记录「第一次投影时的判断」，要多一份状态 | **已定** |
| D27 | plan mode 改写工具描述与前缀保持冲突 | 推荐：纪元内不改描述，限制靠 system 提醒与执行期拦截（权限层已有 `readOnly`，覆盖范围待核，§7.7）。备选：切换 plan mode 视为纪元边界，代价是每次切换一次缓存未命中（即现状） | **已定** |
| D28 | 派生字段（`content_text` 等）何时重算 | 推荐：只在封口、工具进入终态、编辑或删除时；流式中途的部分文本搜不到（§4.6）。备选：每个 item 封闭时重算，FTS 写入多 N 倍 | **已定** |
| D29 | 旧格式的读取与转换是否删除 | 永久保留：总有用户从无块的旧版本直接升级到最新版，回填完成前要靠现场解码照常使用；PG 与 project.db 导入也要用。P3d 只删协议层的 v1 与 `wsV2` 开关（§10.7） | **已定** |
| D30 | 前端是否直接按块渲染 | 是：P3d 去掉入口处把 v2 转回 v1 形状（`contentJson` + `children`）的那层，前端 store 与渲染直接以信封 + 块为准 | **已定** |

## 附录 A：现有块 type 到 kind 的映射

标「待核」的条目，在 P0 实现 `decodeLegacyContent` 时用真实数据确认。

| 现有 type | 常见 role | kind / subtype | 合并方式 | 模型是否可见（现状） | 说明 |
|---|---|---|---|---|---|
| text | user（人写） | `input` 的 `text` part | 与同一行的附件合成一块 | 是 | `model_text` 冻结 `content_text` |
| text | user（origin 为 system） | `context` | — | 是 | 自动续跑、批准反馈、审查检查 |
| text | sys | `context` | — | 是 | plan mode 退出、浏览器 tracing 通知等 |
| text | assistant | `output` 的 `text` part | 一个 item 一块 | 是 | |
| text | disp | `context` / publication_result（卡片族） | — | 否 | 带 `publicationResult` 字段 |
| text（与注入或 review 配对的那一个） | sys / user | 并入 `context` 块的 `model_text` | 与配对块合成一块 | 是 | |
| image | user | `input` 的 `image` part | 并入 `input` | Anthropic、Responses 原生；其他 provider 为附件提示，重建时丢失 | |
| image | assistant（插件） | `output` 的 `image` part | — | 待核 | |
| text_file | user | `input` 的 `file` part | 并入 `input` | 附件提示 | |
| file_reference | user | `input` 的 `file_ref` part | 并入 `input` | 展开为引用文本 | |
| attachment、document | user | `input` 的 part | 并入 `input` | 待核 | 调研中列出，但未找到写入点 |
| reasoning、旧的 thinking | assistant | `reasoning` | 一个 item 一块 | 按携带策略 | `translatedText` 移入 `state` |
| redacted_thinking | assistant | `reasoning`（redacted） | — | 仅 strict 且同源时 | `data` 移入 `provider_meta.wire` |
| tool_use | assistant | `tool`，工具名进 subtype | 与被采用的账本 attempt 合成一块 | 是，需账本到达终态 | `thoughtSignature` 移入 `provider_meta.wire` |
| tool_result | assistant（/bash） | 并入 `tool` | — | 否（只给显示用） | 显示数据改由账本提供 |
| web_search | assistant | `tool`，`executor = "provider"` | — | Responses 原生；Anthropic、Completions 为文本摘要；Gemini 跳过 | |
| image_generation | assistant | `tool`，`executor = "provider"` | 生成的图片为结果 part | 仅 Responses | `result` 只在落盘失败时存在 |
| bash_command | user | `input` | — | 是（经 `content_text` 回退） | `model_text` 为命令原文 |
| tool_loaded、tool_unloaded | user | `context` / 同名 | — | 是（经 `content_text` 回退） | `toolNames` 进 `body`，旧行由回填展开（§7.8） |
| system_injection 及旧拼写（sidecar、side_car、injection、system-injection） | sys / user | `context` / system_injection | 旧形态与前一个 text 合并 | 是（modelText） | |
| spec_continuation、spec_blocked_continuation、knowledge_hint、container_ready、browser_session_lost、merge_summary | sys | `context` / 同名 | — | 是（modelText） | `merge_summary.isLatest` 移入 `state` |
| subagent_messages、background_agents_completed | 注入的伴随块 | 并入所属 `context` 块的 `body` | 与注入合成一块 | 否 | |
| review_feedback | user（前面带一个 text） | `context` / review_feedback | 与前面的 text 合成一块 | 前面的 text 可见 | `applied` 移入 `state` |
| ask_in_passing | system | `context` / ask_in_passing（卡片族） | — | 否 | status 移入 `state` |
| subagent_recovery、cwd_recovery | disp | `context` / 同名（卡片族） | — | 否 | status 移入 `state` |
| spec_goal_added、spec_fork_carryover、spec_context_cleared | disp | `context` / 同名（卡片族） | — | 否 | spec_goal_added 的信封 `cause_block_id` 指向 `/goal` 输入 |
| info | disp | `context` / info（卡片族） | — | 否 | |
| error | system | `context` / error（卡片族） | — | 否 | |
| compact（含 subtype plan，以及清空上下文） | system | `context` / compact、plan、clear_context（控制标记族） | — | 否（摘要走 system prompt） | status、attempts 移入 `phase` / `state` |
| segment_compact | user | `context` / segment_compact（控制标记族） | — | 是（现在经 `content_text`） | 改为 `model_text`，origin 为 system |
| file_history_checkpoint | disp | `context` / file_history_checkpoint（控制标记族） | — | 否 | |

## 附录 B：调研中顺带发现的现存问题

第 1–4 条在 P0 修复，其余建议单独立项。标「推测」的条目需要先复现。

1. **重建历史时，工具结果按随机 nanoid 排序**（`agent-runtime/model-history-source.ts:247-248`，已核实），与调用顺序无关，重建出的请求前缀与实际发送的不同。
2. **strict 判定用的 model 字符串不一致。**
   - OpenAI 的 `buildHistory` 用带前缀的 model，`chat()` / `pushAssistantTurn` 用裸 model（`openai-provider.ts:697,710` 对比 `806-807,1058-1060`）。
   - 结果：`nug:gpt-5.5`、`tokendance:gpt-5` 在前者判为 false，在后者判为 true。
3. **Responses 当前轮图片的位置有三处说法。**
   - 代码把图片放在后面，并有测试钉住（`openai-provider.ts:3559`）；
   - `docs/AGENT_PROVIDERS.md:21` 写的是放在前面；
   - 重建历史时放在前面（`openai-provider.ts:3675`）。
4. **段压缩标记被当作人类消息**（推测）。标记行 role=user 且没有 origin，sender 投影会判为 human（`narrator-persistence.ts:4166-4182`；`sender-projection.ts:80-81`）。压缩进行中，模型会看到 `[Segment compacting]`。
5. **FTS update 触发器不限定列**（`server/db/fts.ts:378-385`）：信封上任何列的更新都会重建该行索引。`model_history` 插入触发器内的嵌套 UPDATE 会再触发一次（推测）。
6. **丢弃 attempt 时可能切错块**（推测）。截断按下标基线进行，而块按 `outputIndex` 排序插入（`narrator-event-handler.ts:1201-1211`；`output-content.ts:67-81`）。
7. **子代理提升为 primary 时不复制账本行**（推测）。这些 tool_use 因为没有已完成的账本行，会在模型历史中被丢弃（`subagent-extract.ts`）。
8. **插件 provider 可能把最新输入发两次**（推测）。它的 `buildHistory` 不弹出末尾的 user 消息（`remote-provider-adapter.ts:135-183`）。
9. **惰性 fork 的两个问题**（推测）。
   - 父叙述者之后若插入移位，子叙述者回填时按父叙述者当前的 seq 区间拷贝，可能错位（`narrator-refs-backfill.ts:194-211`）。
   - 共享判定不计算惰性继承者（§6.2）。
10. **编辑 assistant 后前端可能显示旧内容**（推测）。编辑后块的 `revision` 不变（`narrator-session.ts:6917-6921`），前端测量缓存可能命中旧高度和旧内容（`NarratorPanel.tsx:856-866`）。
11. **重复 toolUseId 的块菜单可能作用到别的块上**（推测）：`tc-x#dup1` 在选择索引里查不到，会回退到 `blockIndex 0`（`vlist-block-target.ts:108-114`；`PretextExactMessageList.tsx:4977-4982`）。同样因为重复 id，live patch 会写入同一 toolUseId 的所有出现位置（`vlist-live-patch.ts:222-231`）。
12. **assistant `content_text` 的拼接符不一致**：一处用 `\n`（`narrator-persistence.ts:2002-2007`），另一处用 `\n\n`（`narrator-session.ts:7060-7063`）。
13. **外来 provider 的 id 会进入 Responses 请求。** Responses 回放 message item id 时用的是 `messageUuid`，并且不检查来源（`openai-provider.ts:3910-3919`）。
14. **段压缩标记被 fork 共享后可能删不掉**（推测）。`deleteSegmentCompact` 按 `narratorMessages.narratorId` 定位；标记被 fork 共享时，其他 ref 的外键会让删除失败（`narrator-persistence.ts:4376-4398`）。
15. **一次性脚本已经过时且危险**（推测）。`server/db/migrate-role-to-disp.ts` 会把所有 `role='system'` 改为 disp，现在运行会连 compact / plan 标记一起改掉。
16. **文档与代码不一致。**
    - `docs/INJECTION.md:138` 提到的 `loadSubagentHistory` 已经不存在，实际逻辑在 `agent-runtime/history.ts:190-195`。
    - `docs/INJECTION.md:16` 说「每次请求发送完整历史」，但 Codex WS 可能只发增量。
    - `docs/codex-websocket.md:50` 写的是 `parallel_tool_calls: false`，代码是 true（`codex-request.ts:85`）。
17. **`drizzle/0206_context_numeric_stats.sql` 疑似人工追加过 SQL。** 文件里有 finalizer 产不出的 `INSERT…SELECT` 和 `CREATE TRIGGER`，推测是生成之后人工追加的，与 CLAUDE.md「禁止手改 drizzle/」冲突。

以下第 18–37 条来自块粒度的第二轮调研（编辑与展示、provider 组装、落库与生命周期三个维度）。标注规则同上。

18. **删除 user 气泡只删 blockIndex 0**（代码推断，未运行验证）。气泡的删除和多选删除都指向 index 0（`vlist-block-target.ts:117-120`；`vlist-selection.ts:216`），而 user 块的持久化顺序是 `[image…, text_file…, file_reference…, text]`（`narrator-session.ts:3195-3221`），所以带附件的消息被删掉的是第一个附件。
19. **reasoning run 的删除与回滚。**
    - 行菜单按 blockIndices 循环调用删除，但 `handleDeleteBlock` 每次都覆盖上一个待删目标，最终只删 run 的最后一块（`use-message-revert-confirm.ts:63-68`；`VListRowInteractionControls.tsx:354-366`；代码推断）。
    - 回滚到 run 用的是起点下标，会截掉 run 的后半段（`narrator-session.ts:6207-6211`；是否有意待核）。
20. **assistant 编辑。**
    - 把所有 text 块合并进第一个，工具之后的文字被搬到工具之前；保留下来的块 id 与 revision 不变；citations 偏移对不上新文本（`narrator-session.ts:6904-6935`；`shared/citations.ts:517`；citations 一点为推测）。
    - 恢复用的是首次编辑时的整数组快照，会丢失之后的删块、翻译、卡片状态，并可能复活已删的工具调用（`narrator-session.ts:7032-7094`；推测）。
21. **内部执行进入模型历史**（推测）。
    - Eval 的内部 Read 只写账本行，toolUseId 以 `internal_read_` 开头（`narrator-persistence.ts:3199-3263`）。
    - 模型历史查询与构造器都不过滤它们，向后兼容路径会把它们补成 tool_use 加结果（`anthropic-provider.ts:3251-3271`；`openai-provider.ts:4033-4042`）。
22. **review 结论行可被拆开。** `[text, review_feedback]` 不在原生块与上下文卡的白名单里，块删除 API 能单独删掉模型文本或卡片（`shared/native-injection.ts:22-30,208-215`）。
23. **编辑菜单不检查 role。** 任何 markdown 行都显示「编辑」，系统或上下文消息里的 text 行点编辑后会被服务端拒绝（`vlist-edit-target.ts:56-59`；`narrator-session.ts:6973-6975`；推测）。
24. **删除并回退文件要求 tool_use 与账本行 1:1**，重跑过的工具会因 EVIDENCE_INCOMPLETE 失败（`revert-planner-local-access.ts:533-553`；推测）。
25. **引用锚点。**
    - `@@m:<id>` 写在模型可见的正文里（`shared/composer-document.ts:226-236`），消息经 COW 换 id 后会失效。
    - L1/L2 下工具折进 activity，`t:` 锚点找不到对应的行（`quote-selection.ts:94-103`；`quote-jump.ts:116-118`）。
    - 两点均为推测。
26. **text 拼接符不一致。**
    - 编辑器用 `\n\n`，user 气泡用 `\n`，composer 校验用 `""`，恢复后的 content_text 用 `\n\n`（`message-edit-text.ts:28`；`segment-adapter.ts:1772-1775`；`server/lib/composer-document.ts:95-145`）。
    - Responses 重建 user 文本用 `""`，其他构造器用 `\n`（`openai-provider.ts:3613-3686`）。
    - Completions 的 assistant 文本实时用 `""`，重建用 `\n`（`openai-provider.ts:1173-1176,4168`）。
27. **历史图片在重建中丢失。** Chat Completions、Gemini、Interactions、插件的重建路径只用 `content_text` 或丢弃只有 imageId 的块（`openai-provider.ts:4276`；`gemini-provider.ts:770-776`；`gemini-interactions-provider.ts:775-781`；`remote-provider-adapter.ts:1311-1325`）。工具结果中的图片在所有 provider 的重建路径都丢失，因为它们只存在于内存（`loop.ts:7278-7286,7454-7460`）。
28. **Gemini。**
    - functionResponse 不带 id，按名称加顺序配对，同名的并行调用可能配错（`gemini-provider.ts:758-769`；推测）。
    - 普通 text part 的签名在解析时被丢弃（`gemini-provider.ts:917-985`）。
29. **Responses。**
    - 多段 summary 落库时被压成一段（`openai-provider.ts:2288-2303`）。
    - function_call 的 item id 与 message 的 phase 都不落库。
    - image_generation 重建时在主线程 `readFileSync`，并插入一条只在重建路径出现的 developer 指令（`openai-provider.ts:3989-4011`）。
30. **Codex WS 增量续写几乎总是退化**（推测）。续写要求逐项 JSON 前缀相同，而本地重新序列化的 item 缺少 `status`、`annotations`、`id`、`phase`（`codex-websocket.ts:259-292,741-773`）。现有测试只用简化过的 item 验证（`codex-websocket.test.ts:72-85`）。
31. **NUG 的 OpenAI 系通道在 `buildHistory` 中的 strict 判定恒为 false**，与第 2 条同源（`nug-provider.ts:270,383-397`）。
32. **插件 provider**（推测）。
    - 不看账本状态，发出全部 tool_use，未完成的调用没有结果（`remote-provider-adapter.ts:1181-1202`）。
    - 不过滤 `parentToolUseId`。
    - 保留 role=system 的旧行。
33. **当前轮的拼接顺序与 DB 顺序不同。** 尾部 sys 文本放在用户输入之前，知识注入拼在之后（`agent-runtime/history.ts:238-243`；`orchestrator.ts:1976-2007`），到下一个 pass 重建时，分段和顺序都会变。
34. **Gemini 保留键在跨 provider 时泄漏**（推测）。账本 `input_json` 里的 `__geminiThoughtSignature` 在 Anthropic、OpenAI 重放时不剥离，会进入工具输入（`anthropic-provider.ts:3228-3238`；`openai-provider.ts:4028,4232`）。
35. **工具 id 改名有两套算法。** 实时用 `reserveUniqueToolUseIds`，重建用 `uniquify`；同一 id 多次出现时，两边可能改出不同的名字（`tool-use-id-dedup.ts:258-337,409-428`；推测）。
36. **`/bash`。**
    - user 行经 `content_text` 对模型可见，但上下文统计按 0 字符计（`context-characters.ts:131-133`）。
    - assistant 行里的 tool_result 块只给显示用，删除时不与 tool_use 配对，可能留下孤立的块（`narrator-messages.ts:647-655`；推测）。
37. **子代理收到的消息。** 删除那个无 modelText 的注入，会连带删掉 text，却留下图片和文件（`shared/native-injection.ts:168-171`；推测）。

## 附录 C：块粒度的推导

本附录记录 §3 的切分是怎样得出的。证据来自三份只读调研（编辑与展示、provider 组装、落库与生命周期），以及业界做法。

### C.1 四个维度各自需要的单位

| 维度 | 用户输入 | assistant 可见文本 | 推理 | 工具 | 注入与卡片 |
|---|---|---|---|---|---|
| 落库 | 整条一次写入（`narrator-persistence.ts:1238-1316`） | 按 provider item 流式产生、各自完成（`output-content.ts`） | 同左；凭据在 item 结束时到达 | 调用在流式中写入；结果可能在数小时后、跨重启才写入；被采用的结果会变 | 整条一次写入 |
| 编辑 | 整条：编辑器里可以逐个增删附件，提交时整条重建 | 入口是单块，现在的语义却是整条合并（附录 B 第 20 条） | 不可编辑；翻译按块 | 不可编辑；重跑、作答作用于 attempt | 整条删除；状态原地修改 |
| 展示 | 一个气泡，附件按占位符嵌入正文 | 每块一行 | 相邻块组成 run，再拆成步骤 | 一张卡：调用 + 被采用的输出 + 流式状态 + 权限 + 子代理 | 一个逻辑注入一张卡 |
| 组装 | 一个 user 轮的内容；块内按 part 映射为文本、图片、附件提示 | 每个 provider item 一个线上单元，凭据挂在 item 上 | 同左；跨 provider 时可被单独丢弃或降级 | 调用进 assistant 轮，结果进下一个 user 轮；必须成对 | `model_text` 进 user 轮或 system |

四个维度在下面几处一致：
- 用户输入是一个单元；
- assistant 的每个输出 item 是一个单元；
- 工具调用连同其结果是一个单元；
- 一次注入是一个单元。

比单元更细的结构（附件、推理分段、item 内的 content part）只有组装和展示需要，而且只作为内容使用，没有任何独立的写操作。比单元更粗的结构（步、轮、run、activity）由信封和写入时盖章的字段表达。

### C.2 候选方案

| 方案 | 落库 | 编辑 | 展示 | 组装 | 结论 |
|---|---|---|---|---|---|
| A. 现状：消息 = JSON 数组 | 每个 checkpoint 重写整列，并触发四组触发器 | 用下标作身份，删、改、回滚各自修补 | 流式交接、配对、轮次全靠推导 | 每个构造器各自解析；实时与重建有 19 处差异 | 要换 |
| B. 线上 part 粒度（本文初稿）：text、image、attachment、tool_use、tool_result 各一行 | 按 part 写，粒度最细 | 用户输入被拆成多块，又得另造一个「整条」身份；tool_use 与 tool_result 分两行，配对要额外维护 | 气泡要从多块重组，工具卡要拼两行 | 贴近 Anthropic；Responses、Gemini 要重新分组；配对靠约束保证 | 不选。初稿还有一个漏洞：tool_result 在信封封口后才追加，可能改到已被 fork 共享的信封 |
| C. 按角色合并：user_input、assistant_output（一步一块）、tool | 一步的全部文字合成一块，流式又回到整段重写 | 用户输入、工具没问题；assistant 只能整步编辑 | 用户输入、工具没问题；assistant 的每个 item 还要再做子寻址 | 凭据与携带策略得沉回块内数组；文字与工具交错时无法表达 | 不选，但其中「用户输入一块、工具一块」被采纳 |
| D. 单元粒度 + part（推荐） | 每个 provider item 一行；工具调用与结果一行，另有账本 | 每个操作都有对应的块；无效结构（只有图片的轮、没有结果的调用）不可表达 | 视觉单元与块一一对应；run、activity 由盖章字段分组 | 两段投影；凭据挂在所属块上；配对由结构保证 | 采用 |
| E. 事件溯源：只追加事件 + 物化视图 | 天然适合流式与审计 | 编辑是事件，历史完整；但 COW 与 fork 语义变复杂 | 仍需物化成 D 的形态 | 同 D（建在物化视图上） | 不选。比 D 多一层，现有需求用不上；编辑历史可以用块 revision 表单独实现（P3） |

### C.3 业界做法

- **Vercel AI SDK（`UIMessage`）**：与本设计的 D 基本同构。
  - 消息由 part 组成。text 与 reasoning 是不同的 part，各带流式状态和 `providerMetadata`。
  - 一次工具调用是**一个** part，状态依次为 `input-streaming`、`input-available`、`approval-requested`、`approval-responded`，最后是 `output-available`、`output-error` 或 `output-denied` 之一。
  - 调用侧和结果侧各有一份 provider 元数据；`providerExecuted` 标记由 provider 执行的工具；`step-start` part 标记步边界。
  - 存储与展示用这套结构，发给模型之前再转换成各家格式。
- **TanStack AI**：工具调用与结果是两个 part，但结果会再复制一份挂到调用 part 上。这说明展示层需要的仍是合在一起的形态。
- **OpenAI Responses**：`function_call` 与 `function_call_output` 是两个 item，因为它是只追加的日志，两者由不同的一方追加。本设计的存储不是只追加日志（信封可变，靠 COW 保护），这个理由不适用；线上格式由第二段投影负责。
- **工具结果中的图片**：
  - Anthropic 的 tool_result 可以带图；
  - Responses 自 2025 年 9 月起，允许 `function_call_output` 的 output 是含 `input_image` 的数组；
  - Gemini 3 支持多模态函数结果，旧模型会返回 400；
  - Chat Completions 不支持。

  因此工具结果在存储中应该是「文本 + 图片 part」，放到哪里由第二段按协议能力决定。
- **NarraFork 自己的 External API v1**：已经按「消息 → 文本、推理步骤、工具条目（调用与结果合一）、子代理」的结构输出（`docs/OPEN_API.md` §7.6）。

来源：
- [AI SDK `ui-messages.ts`（ai@7.0.40）](https://app.unpkg.com/ai@7.0.40/files/src/ui/ui-messages.ts)
- [AI SDK UIMessage 参考](https://ai-sdk.dev/v5/docs/reference/ai-sdk-core/ui-message)
- [TanStack AI Tool Architecture](https://tanstack.com/ai/latest/docs/tools/tool-architecture)
- [OpenAI 社区：Images and files as function call outputs](https://community.openai.com/t/images-and-files-as-function-call-outputs/1360081)
- [Gemini 3 Pro 模型页（Vertex AI）](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-pro?hl=hi)
