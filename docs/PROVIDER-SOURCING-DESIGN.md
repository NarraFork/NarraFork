# 模型供应体系重设计

> 状态：设计稿，主要决策已于 2026-11-03 评审确定（见 §13）；2026-11-04 改定模型值写法：保留 `前缀:模型`，新增 `auto:模型`（§4.1）。依据 `main@434476d` 的代码现状。本文只定方向与契约，具体迁移、表结构以实施 PR 为准（schema 变更走 `server/db/schema.ts` → `bun run db:generate`）。
>
> 2026-11-14：对照代码复核发现，P0–P3 的子项都叠在旧的“按类型分开的配置数组”上，§3 的三层模型没有落地。数据结构、迁移与接口契约见 §15，后续实施以 §15.9 的阶段为准。

## 1. 目标

1. 常见场景零配置：新手只需登录订阅或粘贴一个 API Key 就能用，复杂选项默认隐藏。
2. 取消“模型聚合”功能，改为**默认聚合**：用户选的是模型，来源（渠道）放进二级菜单，支持“自动”和“指定”。自动模式按可排序的策略打分（价格、订阅重置时间等），并和纪元（代次）系统结合：纪元内保持缓存不切换，纪元轮替时重新选择。
3. 非管理员也能管理自己的模型来源（登录 Codex、填 Kimi Code / OpenCode Go 等套餐 Key）。个人来源默认隔离：**谁拥有叙述者就用谁的凭据**。共享叙述者、邀请协作不改变这一点。
4. 个人额度用完后，自动回落到管理员配置的团队共享来源。
5. 大幅简化模型目录，去掉让人困惑的配置项，消除报错和主线程阻塞。
6. 每个来源都能填写实际开销（订阅月费或真实单价），与理论价对比得出节省量。
7. 用户能分析自己各来源的用量。
8. 管理员能分析全体用户用量；用户可把自己的私人来源设为对管理员不可见。
9. 以 Codex 为标杆统一所有订阅制服务的体验，覆盖 OAuth 与 API Key 两类登录，并支持逐凭据的网络身份策略（代理、UA、设备 ID 等）。

## 2. 现状中需要改变的部分

| 现状 | 问题 |
|---|---|
| 模型值只有 `前缀:模型` 一种写法，前缀即供应商实例 | 同一模型在多个来源时是多个条目；要自动选来源只能另建“模型聚合”对象。前缀本身保留，新增 `auto:` 写法解决（§4.1） |
| 所有供应商配置在全局 `settings.json`，凭据全局共享 | 无法按用户隔离；写设置时 `Atomics.wait` 最长阻塞主线程 2 秒 |
| `resolveProviderAndModel()` 只看模型前缀，不带用户上下文 | 无法按“谁付费”选凭据 |
| 回合的执行身份是**消息发送者**（`_currentUserId`） | 若直接拿来选凭据，协作者 B 会花掉自己的订阅，或者 A 的订阅被任何有写权限的人使用 |
| 只有 Codex 与插件写入 `credentialId` | NUG、自定义 API 的用量只能按前缀区分，无法按来源分析 |
| 只有参考价 `costUsd`，且按模型定价 | 没有实际开销，算不出节省量 |
| 用量分析全部 `requireAdmin`；`/api/dashboard/summary` 却把全员当日开销返回给任何用户 | 用户看不到自己；同时存在越权泄露 |
| 模型目录 8 层合并、变体/绑定/覆盖并存，4 个互相竞争的上下文窗口字段，每次编辑全量校验 242 个模型 | 配置难懂；全量校验约 50ms + 设置锁 + 整份 settings.json 重写 |
| Codex 凭据池能力最完整，但没有逐凭据代理/UA/设备 ID；Kimi、OpenCode 只有状态栏额度显示 | 订阅体验不一致 |
| 私密凭据以明文 0600 文件存放，API key 混在 `settings.json` | 加入个人凭据后需要至少应用层加密，且秘密应与普通配置分开 |

## 3. 概念模型

用户可见的只有三个名词：**模型**、**来源**、**策略**。内部再细分为服务、凭据、渠道。数据结构与接口见 §15.2–15.5。

| 概念 | 含义 | 举例 |
|---|---|---|
| **服务 Service** | 一种上游服务，由**服务模板**描述协议、端点、登录方式、额度探测、模型列表 | Codex（ChatGPT 订阅）、Kimi Code、OpenCode Go、Anthropic API、DeepSeek API、NUG、TokenDance、某个自定义中转 |
| **凭据 Credential** | 服务下的一个账号或 Key。带归属、秘密、网络身份、计费、额度窗口、隐私设置 | “我的 ChatGPT Pro 账号”、“团队 DeepSeek Key” |
| **渠道 Channel**（UI 中叫“来源”） | 运行时可路由的单位 = 服务 × 凭据。记录健康度、缓存亲和、实际单价 | `Kimi Code · 我的 Key` |
| **模型 Model** | 逻辑模型，由目录统一身份，如 `claude-opus-4-6`。一个模型可由多个渠道提供 | 叙述者选“某模型 · 自动”，或选某个服务提供的模型，写法见 §4.1 |
| **计费主体 Billing owner** | 决定这次请求能用谁的个人来源。**等于叙述者的所有者** | 见 §5 |
| **策略 Strategy** | 自动模式下候选渠道的排序规则 | 省钱 / 尽快用掉订阅 / 稳定 |

关系：

- 凭据归属于**用户**（个人来源）或**团队**（管理员配置的共享来源）。
- 一个服务模板可以有很多凭据；Codex 的“多账号凭据池”成为所有服务的通用能力。
- 渠道通过目录把各自的上游模型 ID 映射到逻辑模型。映射对用户透明，`anthropic/claude-opus-4.6`、`claude-opus-4.6` 都归入 `claude-opus-4-6`（只认精确与别名匹配，见 §4.1）。
- 服务在模型值里以前缀出现（`codex`、`deepseek`、自定义供应商的前缀）；凭据不出现在模型值里。
- 插件供应商以“服务模板”的身份加入，凭据仍按用户或团队归属。

## 4. 路由：默认聚合 + 策略打分 + 纪元锁

### 4.1 模型值

所有保存模型的地方（`narrators.model`、Agent 工具的 `model` 参数、子代理模型池、`defaultModel`、`summaryModel`、搜索渠道模型等）继续用一个字符串，不新增字段：

| 写法 | 含义 | 候选渠道 |
|---|---|---|
| `<服务前缀>:<上游模型>`，如 `codex:gpt-5.5`、`deepseek:deepseek-v4-pro` | 指定服务 | 该服务下、计费主体可用的凭据 |
| `auto:<逻辑模型>`，如 `auto:claude-opus-4-6` | 自动 | 所有能提供该逻辑模型的服务 × 凭据 |

- **前缀表示服务，不表示凭据**。同一服务的多个账号 / Key（Codex 凭据池、P2 的 Key 池）在前缀之下选择，按计费主体过滤（P4）。现有的 `前缀:模型` 值原样有效，单凭据时行为不变。
- **指定服务时不跨服务**：只在该服务的凭据之间回落（个人 → 团队）。该服务没有可用凭据时，按现有的额度等待或报错处理，不会换到别的服务。“指定”同样不绕过健康检查与权限。
- **模型值里不指定单个凭据**：同一服务下用哪个账号 / Key，由计费主体、凭据手动优先级和健康状态决定。确有需要时再加叙述者级的凭据偏好，不改模型值写法。
- **`auto` 是保留前缀**，与 `codex`、`tokendance` 一样不能用作自定义供应商、NUG 或插件的前缀。`auto:` 后面是目录模型 id（`catalog.models[].id`）；保存时也接受别名，经 `identifyModel` 归一后写入目录 id。目录不认识的 id 拒绝保存；运行时目录已不再包含该 id 时，按“无候选”报错，提示改选模型，不猜测。
  - 已实现：`normalizeAutoModelValueForSave`（`server/lib/settings/provider.ts`）只对照目录（精确 id 或别名，`canonicalCatalogModelId`），不看此刻有没有服务能提供，因为服务可能临时关闭。入口是创建会话、`PATCH /narrators/:id/model`、设置 PATCH（默认 / 摘要 / 翻译 / 提示优化模型、各类子代理模型与模型池）、Agent 调用的 `model` 参数和子代理换模型。设置 PATCH 只校验与已保存值不同的项，避免目录更新后，已保存的旧值让之后每次保存都失败。
- **逻辑模型只认强匹配**：渠道的上游模型经 P1 的 `identifyModel` 归一，只有 `exact` 与 `alias` 匹配（含去掉 `vendor/` 后的匹配）进入 `auto` 候选。日期后缀与最长前缀属于弱匹配（`weak`），只借模型参数，不参与归并；确实是同一模型时，由目录把该 id 写进 `matches.ids` 或别名。同一渠道有多个上游 id 归到同一逻辑模型时，优先取精确匹配者，否则按 id 排序取第一个。
- **目录外的模型**（私有中转模型、目录尚未收录的新模型）没有逻辑模型，只能用 `前缀:模型` 指定，选择器里不出现“自动”。
- **服务可退出自动**：每个服务的详情页顶部有“用于自动选择来源”开关（默认开，存为 `agent.autoExcludedProviders`）。关闭后，该服务只在被指定时使用，用于同名但实际不是同一个模型的中转（如量化版本）。关闭会让某些 `auto:` 模型没有来源时，开关下方列出这些模型，只提示，不拦截。总览卡片显示“不参与自动”徽章。删除服务时它的前缀从列表中移除，之后同前缀的新服务不会被默认排除。
- 特殊值 `__default__`、`__summary__`、跟随父叙述者保持不变；`__agg__:` 迁为 `auto:`（§11）。
- **渠道锁只记服务，不记凭据**：锁就是会话最近一条回复所用的服务，从压缩点之后、本会话自己的 assistant 消息的 `provider` 列读出（`server/services/auto-sticky-source.ts`），不加新列，重启或闲置回收后照样能恢复。同一服务下用哪个凭据由该服务自己的池决定（Codex 账号池、Key 池的会话粘性），不进锁。纪元记录里只有服务指纹，没有凭据。

### 4.2 一次选择的步骤

```
resolveRoute({ modelValue, billingOwner, narratorId, epoch, caps }) →
  { channel, adapter, upstreamModel, reason }
```

（草案。实施以 §15.5 的签名为准。）

1. **候选**：`auto:<逻辑模型>` 取提供该逻辑模型、且参与自动的全部渠道；`前缀:模型` 取该服务下的全部凭据。
2. **过滤**：
   - 凭据可用于该计费主体：个人凭据只给其所有者，团队凭据按团队策略。
   - 渠道已启用、未归档、熔断未打开。
   - 已知额度未耗尽。
   - 能力满足本次请求，比如图片输入。
3. **分层**：默认个人来源 → 团队来源，用户可在路由策略里改为团队优先。只有上一层没有可用渠道时才进入下一层。团队层是否可用仍由团队策略决定，改顺序不会绕过它。
4. **排序**：在同一层内按用户选择的策略**逐项比较**（字典序，便于解释“为什么选它”）。可选维度：

| 维度 | 定义 | 方向 |
|---|---|---|
| 边际成本 | 订阅窗口内额度 ≈ 0；额度外按 credits 价；按量计费按实际单价 × 预估本轮输入/输出；网关按其报价 | 低优先 |
| 重置紧迫度 | `剩余额度比例 ÷ 距重置时长`，越大表示越多额度即将过期作废 | 高优先 |
| 切换代价 | 非当前渠道且缓存仍热时，加上“整段上下文按未缓存价重算”的差额；纪元边界时为 0 | 低优先 |
| 稳定性 | 近期成功率、首 token 延迟 | 好者优先 |
| 用户手动优先级 | 凭据卡片上的排序 | 小者优先 |

预设：

| 预设 | 排序 |
|---|---|
| **省钱**（默认） | 边际成本 → 重置紧迫度 → 稳定性 |
| **用掉订阅** | 重置紧迫度 → 边际成本 |
| **稳定** | 稳定性 → 边际成本 |
| **均衡** | 同层轮询，会话亲和 |

用户可以在高级设置里拖动排序。

5. **纪元锁**：见 4.3。

**P3 第一版已实现（2026-11-05 决定先做这一档）**：上面的打分表和预设是目标设计，第一版只做了一个固定排序，没有预设、没有可调维度，也还没有 `resolveRoute` 这个入口（解析仍在 `resolveEffectiveModel` → `resolveAutoModel`）。

- **排序**（`shared/auto-route-strategy.ts`）：能否服务 → 订阅优先 → 参考价低者优先（未知价排在已知价后）→ 服务列表顺序。
- **能否服务、是否订阅**（`server/lib/agent/auto-route-signals.ts`，全部是内存读）：Codex 看可用账号数（`availableCount`）；自定义供应商看是否还有 Key 不在额度耗尽或 403 冷却里，单次 429 的短冷却仍算能服务；NUG 看该网关模型是否被记为不可用（按网关模型判断，不同渠道互不影响）；Kimi Code / OpenCode Go 算订阅。
- **能力过滤**（最小版）：同一模型的来源里，声明的输入类型比别的来源少的（如只收文本的中转），排进“不能服务”一组，也不再保持粘性。它不会被丢掉，别的来源都不能服务时仍会用它。没有声明输入类型的来源不算受限。
- **粘性**：会话已在用的服务只要还能服务就继续用；不能服务时换到排序中第一个能服务的来源；全部都不能服务时留在原来源，不为一个同样会失败的来源丢掉缓存。没有已用服务时（新会话、压缩之后）返回排序第一的来源，全部不可用时让上游错误照常报给用户。
- 个人 / 团队分层随 P4 一起做；拖动排序、预设与稳定性维度以后再做。
6. **出站**：渠道的网络身份装配成 `ProviderTransport`（代理、UA、设备 ID、额外请求头），交给协议适配器。

`resolveRoute` 保持同步：读的是内存中按用户分组的渠道快照，凭据变更时通过事件总线失效重建，不在请求路径上查库。

### 4.3 与纪元结合

纪元（前缀纪元）只在**压缩成功**或**实际切换模型目标**时轮替（见 `docs/AGENT_PROVIDERS.md`）。在此基础上，渠道选择分三种时机：

| 时机 | 行为 |
|---|---|
| **纪元内** | 锁定当前渠道，不因打分变化而切换，保住上游缓存 |
| **纪元边界**（新会话、压缩成功、用户换模型） | 完整重新选择，切换代价为 0 |
| **被迫切换**（额度耗尽、来源不可用） | 在模型值允许的候选内换到另一个能服务的来源。等待时长在缓存 TTL 量级以内（15 分钟）时仍然等待；更长、未知或会被拒绝的等待则换来源。换到别的服务时按“实际切换模型目标”开新纪元，同服务内换凭据不开 |

已实现（P3）：
- **纪元边界**：压缩成功时 `markActiveHistoryCompactPending` 置一次性标志 `_autoReselectOnNextTurn`，下一轮解析 `auto:` 时不带粘性服务，按当前排序重选。会话激活时（重启、闲置回收后）用 `lastServedProvider` 取粘性服务（§4.1 渠道锁）。
- **被迫切换**：判定在 `server/services/agent-runtime/auto-forced-switch.ts`（纯函数），orchestrator 有三个接入点：发请求前已知 NUG 模型不可用、模型不可用分支（额度墙，含会被拒绝等待的情形）、普通失败轮（Codex 账号全部用尽、中转的 Key 全部耗尽，这两种 loop 直接报错，不进等待分支）。只有 `auto:` 值会切换；路由仍认为原服务能服务时（例如普通错误）不切换。每次运行最多切换 3 次，防止两个都失败的来源来回交接。
- 等待阈值不沿用 Kimi 24 小时 / OpenCode 8 天的额度等待上限：那是“值不值得等”的上限，而切换要比较的是缓存还热不热。

不做：额度刷新事件（`credential.quotaRefreshed`）与“有更优来源”标记。压缩时本来就会完整重选，订阅额度恢复后在下一个纪元自然切回，不需要额外的事件和状态。

“缓存已冷”（空闲超过渠道缓存 TTL）时是否允许提前重选，目前收益和各上游的 TTL 都不清楚，**本期不做**，P3 先采集数据。纪元锁的实现要给它留出口：选择时机集中在一个判断函数里，以后加一种时机不需要改路由本身。

典型过程：

- 选 `auto:gpt-5.5`：个人 Codex 额度用完 → 被迫切到团队的 OpenAI API Key（同时开新纪元）→ 若干轮后压缩 → 新纪元开始时 Codex 已重置 → 自动切回 Codex。
- 选 `codex:gpt-5.5`：只在 Codex 账号之间切换（个人 → 团队，不开新纪元）；全部不可用时等待重置或报错，不换服务。

两种方式都不换模型。跨模型回落（如 GPT 额度用完改用 DeepSeek）不在本设计范围内，需要时另行设计“回落模型”。

纪元目标指纹保持解析后的 `服务前缀:上游模型`（`resolveEpochTarget`），`auto:` 值本身不进指纹。同服务内换凭据时指纹不变；换服务时指纹改变并开新纪元，这时上游缓存和推理签名本来就已失效。推理签名来源键（`shared/agent-protocol/reasoning-source.ts`）继续按服务前缀 / NUG 渠道区分，不受影响。渠道锁不单独记录，从消息的 `provider` 列读出（§4.1）。

## 5. 归属与隔离

### 5.1 计费主体规则

**计费主体 = 叙述者的 `ownerUserId`**，与谁发的消息无关。

| 场景 | 计费主体 |
|---|---|
| 所有者自己发消息 | 所有者 |
| 协作者 B 在 A 的叙述者里发消息 | A（A 通过授予写权限表示同意；仓库与工作仍是 A 的）。若改用 B 的凭据，同一会话会在两人的来源间来回切换，每次都丢掉上游缓存，所以不提供“仅限本人发起”这类开关 |
| 子代理、搜索子代理 | 沿 `aclRootNarratorId` 找到根叙述者的所有者 |
| 定时任务 | 任务创建的叙述者归 `task.createdBy`，即其所有者 |
| 标题、摘要、压缩、翻译 | 同叙述者所有者 |
| Bot 聊天房间、网关平台 | Bot 叙述者的所有者 |
| 所有者已删除（`ownerUserId` 为空） | 只能用团队来源 |

`senderUserId` 仍然记录在用量里，用于审计“谁触发了这次开销”。

### 5.2 防误用

- 叙述者设为公开可写、加入 Bot 房间时，若会动用个人订阅，界面明确提示：之后所有能在这里发消息的人都会用到你的个人来源。
- 用量里同时记录计费主体与发送者，所有者能在“我的用量”里看到哪些开销来自协作者。
- 管理员把消费级订阅（如 ChatGPT Plus）加入团队来源时提示：这类套餐的用户协议通常不允许多人共用，团队来源建议只放 API Key 或企业套餐。

### 5.3 团队来源与回落

- 管理员配置团队来源，并设定**团队策略**：哪些用户或角色可用、可用哪些模型、预算（见 5.4）。
- 个人层没有可用渠道时回落团队层（目标 4）。回落只在模型值允许的候选内进行：`前缀:模型` 回落到同一服务的团队凭据，`auto:` 可以回落到任一提供该模型的团队服务。回落写入叙述者的状态条：“个人额度已用完，正在使用团队来源 · 约 2 小时后 Codex 重置”。

### 5.4 团队预算

预算只约束**团队来源**的花费。个人来源花的是用户自己的钱，不受管；标记“不计入团队统计”的来源本就不进统计，也不占预算。

| 规则 | 内容 |
|---|---|
| 三本账 | 团队月度总额、个人额度、项目额度。一次请求同时计入三者，任一用完则团队层对该请求关闭 |
| 计量 | 按实际开销计；未填实际价的按参考价计。团队里的订阅类凭据不扣预算，由其额度窗口自行限制 |
| 项目归属 | 叙述者在请求时的主项目（`resolveNarratorProjectId`），写入 `api_requests.projectId` 后不再改写。非 git 会话没有项目，只受个人与团队总额约束 |
| 检查时机 | 回合开始时检查，回合中不打断，超支最多一个回合。判断读内存计数：请求完成时累加，启动时从 `usage_daily` 重建 |
| 用完之后 | 管理员选择：拒绝；只允许指定的低价模型；等到下个周期。达到 80% 时在状态条与“我的用量”提醒 |
| 分配权 | 管理员设定团队总额并分配个人、项目额度。项目所有者在本项目额度内再分配给成员（后续） |

周期按自然月（UTC）计算。预算是路由过滤条件之一：个人来源还可用时，预算完全不影响选择。

## 6. 凭据：以 Codex 为标杆的统一形态

每条凭据都有同样的五块内容，订阅类与 API Key 类共用一套界面。

| 块 | 内容 | 默认 |
|---|---|---|
| **登录** | OAuth（浏览器 / 设备码）、PAT、Agent Identity、API Key，由服务模板声明支持哪几种 | 模板首选方式 |
| **额度** | 模板提供额度探测器，统一产出 `windows[]: { kind: 5h / weekly / monthly / balance, usedRatio, resetsAt }` | 自动探测；不支持的服务显示“未知” |
| **网络身份** | 代理（跟随全局 / 直连 / 系统 / 自定义）、UA 模式、设备 ID（创建时随机生成并固定，如 Codex installation id）、额外请求头 | 全部跟随服务模板；高级选项中可改 |
| **计费** | 订阅：月费、币种、续费日；按量：参考价折扣或自定义单价；网关预付：采用上游报价（NUG `quotaCost`） | 未填写时只计参考价，不算节省 |
| **归属与隐私** | 个人 / 团队；“不计入团队统计” | 个人、关闭 |

额度探测器先覆盖已有实现：Codex `/wham/usage`、Kimi `/coding/v1/usages`、OpenCode Go `/usage`、NUG 余额、TokenDance。其余 Token Plan（MiniMax、智谱、MiMo）按官方接口逐个补，拿不到时只靠 429 被动发现。

网络身份（`CredentialNetwork`）每项都可缺省，缺省即跟随所属服务的设置；代理密码只保存在服务端，接口返回时打码，编辑时原样回传的打码地址会保留原密码。

**自定义 API 供应商的多 Key 池（已实现）**：一个供应商可以有多个 Key（`provider-keys.json`），在供应商页的“Key”列表里添加、排序、停用、设置独立网络身份，并（Kimi Code / OpenCode Go）查看每个 Key 的额度窗口。运行时（`server/lib/agent/pooled-provider.ts`）：

- 会话沿用开始时的 Key（缓存按账号），新会话取顺序中第一个可用 Key；全部在休息时取最早恢复的那个，让上游报错和既有的额度等待逻辑照常起作用。
- 401 → 标记“被拒绝”并停用，直到改 Key；402 或“额度用完”的 429 → 休息 30 分钟；403 → 10 分钟；其他 429 → Retry-After 或 60 秒；5xx / 网络错误不算 Key 的错。参考 sub2api 的账号状态处理。
- 只在 Key 有错且尚未输出任何内容时换下一个 Key 重试；已经输出后照常把错误交给调用方。
- 额度缓存按 Key 记录（`provider-key-subjects.ts`）；缓存看到某个窗口用完时，池子在窗口重置前跳过该 Key（`provider-key-quota.ts`）。状态栏仍按供应商显示，取第一个可用 Key。
- 只有一个普通 Key（没有独立网络身份）时仍走原来的直连适配器，行为完全不变。

**公共凭据池核心（P2 已实现）**：`server/lib/agent/credential-pool.ts` 统一候选过滤、优先级 / 均衡 / 档位选择、会话亲和、已试候选排除、冷却与失败状态决策；CodexManager 和普通 Key 池都调用它，不各自保留选号算法。亲和存储共用 `session-affinity.ts`。Codex 的 OAuth / PAT / Agent Identity 登录、额度探测与预测、持久化和管理界面仍留在 Codex 模块；服务特有的协议与错误识别不塞进公共核心。普通 Key 保留原有顺序和冷却规则，Codex 保留原有三种模式，不新增配置或界面。

## 7. 存储与安全

凭据走文件，不进数据库（2026-11-03 定）：凭据量小、读多写少，文件不依赖 SQLite / PostgreSQL 两套后端，也不碰主线程 SQLite 规则。

> 下面描述的是 S1 之前的现状。统一后的文件布局（`credentials.json`、`credential-state.json`、`settings.sourceGroups[]`）以 §15.3、§15.8 为准；加密、拒读名单、“解不开就不写”、step-up 与口令加密包的规则不变。

- **凭据文件**：`codex-credentials.json`（已有），以及通用凭据池的 `provider-keys.json`。每条凭据：id、所属来源组、`ownerUserId`（空 = 团队）、标签、登录方式、秘密、状态、优先级、归档时间、网络身份、计费、隐私标志。额度快照只在内存与 `*-stats.json`，不写进凭据文件。
- **服务配置**（名称、协议、baseUrl、高级项）仍留在 `settings.json`。自定义 API 供应商的 Key 已迁进 `provider-keys.json`（`server/lib/provider-keys.ts`），磁盘上的 settings.json 不再写 `apiKey`；内存里 `apiKey` 是该供应商的第一个 Key（`settings/provider-keys-projection.ts`），所以读单个 Key 的旧代码不变，写这个字段就是改第一个 Key。迁移出来的 Key 沿用供应商 id，已记账的用量仍归到它名下。凭据文件读不了时什么都不迁，settings.json 照旧保存 Key。回退到此前的版本会读到空 Key，需要重新填写。NUG 供应商、TokenDance、Command Code 和自定义搜索供应商的 `apiKey` 用同一套投影迁出，各占一个 Key，存在带命名空间的归属 id 下（`nug:<id>`、`builtin:tokendance`、`builtin:CommandCode`、`search:<id>`）；删除这些条目或清空 Key 时，存储里对应的 Key 一并删除。NUG 的 OAuth client secret 也沿用标量投影，归属为 `nug-oauth:<id>`，不进入推理 Key 池；搜索供应商的敏感请求头保存为 `search-provider-secrets.json` 中按供应商 id 分组的小 map，复用相同的文件加密与访问保护，普通请求头仍留在 settings.json。加载时自动迁移，内存字段、掩码回传和保存操作不变；显式清空、删除后不恢复旧值。搜索配置本来不属于数据导出或凭据迁移范围，本次不扩展。
- **加密（默认开，可关）**：`server/lib/secret-store.ts` 用 AES-256-GCM 写信封 `{format:"narrafork.secret.v1", iv, tag, data}`，密钥在 `~/.narrafork/secret.key`（0600，首次写入时生成）。读取同时接受信封和明文 JSON，所以开关切换（`settings.secrets.encrypt`，设置 → 服务器与系统）只是把已登记的文件按新形式重写一遍，不会丢数据。
- **它防什么**：凭据文件被单独拷走（备份、同步盘、误分享）。密钥和文件在同一目录，能读整个数据目录的人照样能解密；界面说明如实写出这一点。“不计入团队统计”同样是产品承诺，不是密码学保证。
- **解不开就不写**：文件存在但解密失败（密钥丢失或被换）时，所属管理器只记错误、不加载、不保存，绝不用空列表覆盖唯一一份数据。`secret.key` 与凭据文件一样在 `fs-secret-paths` 拒读名单里。
- **迁移到另一台实例**（设置 → 存储空间 → 凭据迁移，仅管理员）：
  - 导出单个、多个或全部凭据前，先过**二次核验**：账号密码 + 第二因素（验证器动态码、备用码或通行密钥），见 `server/services/step-up-service.ts`。没有登记任何第二因素的账号不能导出。核验成功得到 5 分钟内、仅本会话、仅“凭据导出”这一用途、只能用一次的授权；失败次数与登录 MFA 共用限流。
  - 导出文件用管理员现场设定的口令加密（scrypt N=2¹⁶ + AES-256-GCM，`server/lib/credential-transfer/bundle.ts`），与本机 `secret.key` 无关，所以能在任何拿到口令的实例上打开。文件只带登录、设置与网络身份，不带额度快照、失败计数等运行时状态；手动停用和封禁会随账号带走。
  - 导入先预览：按账号识别“新增 / 本机已有 / 本机不支持”，新增默认勾选，覆盖已有账号需要显式勾选；覆盖时保留本机的 id、优先级和统计。导入只需管理员身份和口令——它能做的事管理员本来就能手动做。
  - 每类凭据以 `TransferKind` 接入：Codex 账号，以及 API Key（随附所属供应商的非机密配置，目标实例没有该供应商时按原配置新建，前缀冲突时加序号）。OAuth 刷新令牌会轮换，两台实例同时使用同一账号会互相顶掉，界面在导出时提示。
- API 只把凭据的公开投影交给前端，并且只给其所有者。管理员能看到团队凭据，看不到个人凭据的秘密。
- 文件很小，原子写（临时文件 + rename）；变更后通过事件总线让路由快照失效。
- **数据导出里的 Key**（2026-11-06 决定）：“数据导入 / 导出”勾选供应商时，带上这些供应商的全部 Key，需要与凭据迁移相同的密码 + 第二因素核验，Key 用口令加密成单独的 `provider-keys.sealed.json`，`providers.json` 里不再有 Key。会话和供应商在同一次导入里处理，所以供应商因前缀冲突改名时，导入的会话能跟着改前缀；拆成数据导出 + 凭据迁移两个文件分两次导入，这个联动就断了，用户也要多走一步。凭据迁移照旧保留，用于单独搬登录和 Key，Codex 账号只能用它搬。实现与格式见 `docs/DATA_PORTABILITY.md`。

## 8. 模型目录：缩到必要的最小集

### 8.1 运行时真正读取的字段

上下文窗口、最大输出、输入模态、推理档位 / 默认档 / 能否关闭、原生搜索、`tool_loading_modes`、四项参考价（输入 / 输出 / 缓存读 / 缓存写）。其余字段只用于展示。

### 8.2 新结构

只合并三层：

```
内置目录（随版本发布） < 上游发现（NUG / Gemini 列表等） < 用户覆盖（按逻辑模型，可选按渠道）
```

具体变化（P1 已实现，见 `shared/model-catalog/{override,resolve}.ts`、`server/lib/model-catalog/`）：

- **删除**：用户自建的模型 / 变体 / 绑定、overrides 数组、hidden ids、`legacyFields` 与永久保存的 `legacyArchive`、在线更新的固定 / 回滚 / 历史快照、长上下文计价编辑器、逐字段“未知”状态、按修订号的冲突检测。目录自身的变体（如 `gpt-5.5@codex`）是目录数据，保留。
- **用户覆盖是类型化的**：`ModelOverride` 只有 8 类字段（上下文窗口、最大输出、输入类型、原生搜索、推理档位 / 默认档 / 可关闭、工具加载方式、四项价格），编辑界面不接触原始键名。两个作用域：模型通用（按目录模型 id，只作用于按 id 或别名精确匹配的来源）和单个来源（按 `前缀:模型`）。上下文窗口统一写入 `working_context_tokens`；供应商级 `defaultContextWindow` 暂留，P2 随供应商配置一起迁移。
- **匹配**：精确 > 别名 > 声明了可剥离日期后缀 > 最长前缀；未命中时再去掉 `vendor/` 前缀重试。同级候选按 id 排序取第一个，**请求时不再抛错**；默认档位不在生效档位列表里时直接丢弃。
- **校验**：只校验被编辑的那一条，并带上出错字段；界面按字段显示本地化提示。
- **存储**：用户覆盖存到 `~/.narrafork/model-catalog/overrides.json`，而不是数据库表：PostgreSQL 后端下 SQLite 句柄会拒绝访问，设置模块又早于数据库加载，独立小文件同时避开了这两个问题。编辑只做一次原子文件写，不碰设置文件锁。`settings.json` 只保留 `agent.modelCatalog.autoUpdate`；旧版内联的本地层在加载时一次性迁入，数据导入导出改为携带 `{ autoUpdate, overrides }`。
- **在线更新：保留，重做为一个开关加两个按钮。**
  - “自动更新目录”（默认开）、“立即检查”、“恢复内置版本”。关闭自动更新时，检查到的新版本保存一份待应用副本，页面显示“新增 N 个、更新 M 个模型 · 应用”。
  - 不再有固定版本、多版本历史和回滚列表；状态拆成 `catalog.json`（使用中的下载版本）、`pending.json`、`status.json` 三个小文件，检查结果不再改写整份目录。
  - 用户覆盖与目录分开存放，更新目录时不需要重新校验覆盖。
  - 更新失败只在目录设置页显示一行原因。
  - **待办**：目录仓库仍按 tarball 发布约 418 KB 的完整元数据，解压与校验仍在主线程（每日一次，约 100 ms）。改为单文件、只含运行时字段的发布需要改目录仓库，之后再把解析挪进 worker。

### 8.3 界面

- 设置 → 模型页底部是“模型目录”：版本与更新控制，以及所有已配置模型的表格（上下文、最大输出、推理档位、参考价，可搜索、可只看已自定义）。
- 点击任一行、供应商页的上下文窗口徽标、或模型菜单的价格弹窗，都打开同一个参数编辑器：每个字段显示当前生效值和来源（目录 / 供应商上报 / 供应商默认 / 模型通用 / 此来源 / 默认值），打开“自定义”开关才可编辑。
- 新模型未匹配到目录时，用上游发现的值；仍缺上下文窗口时用保守默认值，不要求用户先填表。

## 9. 实际开销与用量分析

### 9.1 记录

`api_requests` 补充：

| 字段 | 含义 |
|---|---|
| `credentialId` | 来源 ID。沿用现有列，但所有来源都必须写，不再只有 Codex 与插件 |
| `billingUserId` | 计费主体（叙述者所有者），与已有 `userId`（发送者）并存 |
| `projectId` | 请求时叙述者的主项目，写入后不再改写 |
| `actualCostUsd`、`actualCostStatus` | 按量与网关来源逐条计；订阅类不逐条分摊（P5） |

新增日汇总表 `usage_daily`，键为（UTC 日期，计费用户，项目，供应商，来源，模型），保存请求数、各类 token、参考开销；P5 再加实际开销。在 `finishApiRequest` 里和现有汇总同一事务做一次带索引的 upsert。叙述者删除后明细会级联删除，日汇总不受影响。键里的空值统一存空字符串，保证唯一索引能命中同一行。

### 9.2 节省量

- **按量 / 网关**：节省 = Σ 参考开销 − Σ 实际开销。
- **订阅**：周期节省 = 该凭据本周期 Σ 参考开销 − 月费按周期折算。同时显示“利用率”：已用参考价值 ÷ 月费。
- 所有计算基于 `usage_daily`，在只读 worker 上执行。

### 9.3 谁能看什么

| 视图 | 内容 |
|---|---|
| **我的用量**（所有用户） | 按来源 / 模型 / 日期分析；实际开销 vs 参考开销；各订阅利用率与节省 |
| **团队用量**（管理员） | 全体用户、全部团队来源；按用户 / 来源 / 模型拆分；团队预算执行情况 |
| **隐私** | 标记“不计入团队统计”的个人来源，其用量完全不进入管理员的任何视图：明细、拆分、总量、用户排行都不包含，也不提示“存在未披露用量”。标记在查询时按凭据判断，因此开关对历史数据同样生效。用户自己的“我的用量”照常包含 |
| **修复** | `/api/dashboard/summary` 改为只统计当前用户（管理员另有团队总览） |

## 10. 交互设计

### 10.1 首次使用

设置向导与“添加来源”共用一张页面，第一屏只有几张卡片：

- **登录 ChatGPT**（Codex）
- **Kimi Code / OpenCode Go / MiniMax / 智谱 / MiMo 套餐**：粘贴 Key
- **API Key**：Anthropic、OpenAI、DeepSeek、Gemini……
- **其他**：自定义中转、NUG、插件（进入高级流程）

粘贴 Key 后自动完成：识别服务、探测协议、拉模型列表、读额度。成功即回到对话，模型选择器里已经出现可用模型。

### 10.2 模型选择器

- 一级：逻辑模型，按厂商分组。每项带来源标记（个人订阅 / 个人 Key / 团队），不可用的置灰并说明原因。目录外的模型按服务单独列出，只能指定，没有“自动”。
- 二级“来源”：
  - **自动**（默认，保存为 `auto:<逻辑模型>`），显示当前选中的来源和理由，如“Codex · 主账号，订阅额度内，边际成本 0”。
  - 提供该模型的服务列表：每项显示该服务下当前会用的账号 / Key、额度条、重置倒计时、实际单价。
  - 点任一服务即“指定”，保存为 `前缀:上游模型`。同一服务下用哪个账号 / Key 由凭据优先级和计费主体决定。
- Agent 工具、子代理模型池和各项模型设置用同一套值。Agent 工具描述里的可用模型列表同时列出 `auto:<逻辑模型>` 与 `前缀:模型`，子代理模型池里也可以放 `auto:` 值。

已实现（P3，`ModelMenuItems.tsx`、`model-menu-selection.ts`）：

- 一级：`auto:` 模型按目录的 `family` 分组（GPT、Claude、Gemini……，没有 family 的进“其他模型”），排在固定组之后。目录的 `vendor` 字段目前全为空，所以按 family 分；目前 242 个目录模型里有 160 个没有 family。一个模型只出现一次：服务分组里只留没有 `auto:` 行覆盖的模型（目录外的，或该服务已退出自动），这些只能指定。当前选中的值总会保留它的行。
- 二级来源：“自动”项下方写出现在用哪个来源和理由（订阅额度内 / 可用来源中参考价最低 / 列表中第一个可用 / 都不可用）。每个服务行显示该服务的额度条（与该服务组标题上的相同）、订阅与不可用徽章、每百万 token 的参考价（目录有价时），以及打开该服务设置的按钮。
- 搜索也匹配 `auto:` 行的来源服务名。
- 与上文的差距：来源行没有单独显示“当前会用的账号 / Key”和重置倒计时，额度条的提示里有部分信息；来源标记（个人订阅 / 个人 Key / 团队）随 P4 再做。

### 10.3 设置页结构

| 位置 | 内容 |
|---|---|
| 设置 → **我的来源** | 按服务分组的凭据卡片；Codex 式详情页（额度窗口、网络身份、计费、隐私） |
| 设置 → **路由策略** | 预设、排序拖动、个人优先 / 团队优先（默认个人）、额度耗尽时“等待重置 N 分钟内 / 回落团队” |
| 设置 → **我的用量** | §9.3 |
| 管理 → **团队来源** | 团队凭据、团队策略（可用人群、模型、预算） |
| 管理 → **团队用量** | §9.3 |
| 高级 → **模型参数** | §8.3 |

高级选项（协议、baseUrl、额外请求头、UA、代理、设备 ID、目录覆盖）一律折叠在“高级”里，模板默认值能用就不展示。

## 11. 迁移

| 现有 | 迁移为 |
|---|---|
| `customApiProviders` / `openaiProviders` / `anthropicProviders` / `geminiProviders` / `nugProviders` / `tokendance` / `commandCode` | 团队来源组 + 团队凭据（一对一，见 §15.8） |
| `codex-credentials.json` | Codex 服务下的团队凭据（保留优先级、归档、用量历史） |
| `narrators.model = 前缀:模型` | 不变，即“指定服务”。用户可在选择器里改为“自动”，存为 `auto:<逻辑模型>` |
| 模型聚合 `__agg__:<id>`（自动） | 成员都强匹配到同一个逻辑模型时迁为 `auto:<逻辑模型>`。成员分属不同模型、或含目录外模型的聚合，迁为第一个可用成员的 `前缀:模型`，并记日志。priority 聚合的成员顺序**不迁移**：`auto:` 排序不读服务的手动顺序（服务列表是固定拼接顺序，`providerOrder` 也不影响它），写进去也不会生效；聚合本身保留在设置里（只读），原顺序在那里可查 |
| 模型聚合 `__agg__:<id>:<前缀:模型>`（聚合内指定） | 直接取后半段的 `前缀:模型` |
| 已有供应商的前缀恰好是 `auto` | 改为不冲突的前缀（加序号），同步改写引用它的模型值和配置键，并记日志；历史用量记录不改写 |
| `summaryModel`、`translationModel`、子代理模型池、搜索渠道模型 | 不变；引用了聚合的按上两行迁移。之后也可以填 `auto:` 值 |
| 目录本地层 `connections` / `overrides` / 绑定 | 仅保留 8 类运行时字段，转入 `overrides.json`；用户自建模型与变体丢弃并记日志（P1 已实现） |

迁移在后台分页执行，单批次有上限并让出事件循环，不在一个同步事务里改写上万行。

已实现（P3）：
- 聚合迁移：`server/services/aggregation-migration-service.ts`，规则在 `shared/aggregation-migration.ts`。启动时在后台执行，作用于 settings.agent 的各模型字段、子代理池与固定档位、搜索渠道模型，以及 `narrators.model` / `pending_model_restore`、`scheduled_tasks.model`、`hooks.model`。先写日志，再在一个事务里逐行比对后改写，最后保存设置；失败时把行改回原值，下次启动重试。规划之后被用户改过的行会跳过。聚合本身保留在设置里（界面只读），引用已删除聚合的值不改，照旧回落到默认模型。
- `auto` 前缀改名：`migrateReservedAutoPrefixOnStartup`（`provider-prefix-migration-service.ts`），改为第一个空闲的 `auto-N`，复用前缀迁移的日志与回滚。改名之前，`auto:` 值仍按普通前缀解析。
- 两项迁移在 SQLite 和 PostgreSQL 后端都会执行。`services/migration-db.ts` 按后端选择句柄：SQLite 走原来的同步句柄，PostgreSQL 用组合根注入的 `postgresRuntime.client.db`（`setMigrationPgHandle`，在 `main.ts` 的前缀迁移之前和 `composePostgresStores` 各注入一次）。扫描是异步分批读取，提交在一个事务里逐行更新（PG 为异步事务）。注意：`selectFrom` 不能是 async——await 一个 Drizzle 构造器会把它执行掉，返回的是行而不是构造器。
- 顺序：还有 `auto` 前缀的供应商时（改名失败或尚未执行），聚合迁移推迟到下次启动，否则写出的 `auto:` 值会被当成那个供应商的模型。
- 数据导入 / 导出（`server/services/data-portability.ts`）：`agent.autoExcludedProviders` 随供应商导出，导入时与本地取并集，并跟随供应商前缀改名；清空供应商时一起清掉。导入的供应商因前缀冲突改名（如 `openai` → `openai-2`）时，本次写入的会话的 `model` / `pending_model_restore` 也改到新前缀（只认完整前缀，含 `__agg__`，`auto:` 值不动）；冲突时被跳过的本地会话不动。

## 12. 分阶段实施

每个阶段都能独立发布，不依赖后续阶段。

> 2026-11-14 重新规划：下表 P0–P3 记录已做的事，其中 P2、P3 是在旧配置结构上的过渡实现。P3 剩余、P4、P5 改按 §15.9 的 S1–S6 推进：先统一凭据与服务模板，再做 `resolveRoute`、个人来源、设置页重组与成本分析。

| 阶段 | 内容 | 用户可见变化 |
|---|---|---|
| **P0 地基**（已完成） | 所有来源写 `credentialId`；`api_requests` 记录计费主体与项目；`usage_daily`；修复首页汇总越权 | 用量可按来源区分；首页只显示自己的开销 |
| **P1 目录重做**（已完成） | 按 §8 重做模型目录：3 层合并、8 类字段、独立覆盖文件、精简在线更新、新模型卡界面；删除变体 / 绑定 / 遗留归档 | 模型参数页只剩必要字段，不再报错和卡顿。后续逻辑模型路由依赖这里的模型身份匹配，所以提前 |
| **P2 存储**（已完成） | 凭据文件加密；二次核验 + 口令加密迁移；API Key、站点 token、NUG OAuth secret 与搜索敏感头迁出普通配置；数据导出中的 Key 与 OAuth secret 进入密文包；多 Key 池、会话亲和、故障切换、逐 Key 额度及网络身份；Codex 与 Key 池共用选择与失败决策核心。见 §6、§7 | Kimi / OpenCode 等获得 Codex 式详情页；现有保存和使用操作不变 |
| **P3 路由**（部分完成） | `auto:` 模型值、`resolveRoute`、策略预设、纪元锁、模型选择器二级菜单；把聚合迁为 `auto:`（`前缀:模型` 值无需迁移）。**已完成**：`auto:` 值与保存校验、聚合迁移（SQLite 与 PostgreSQL）、固定排序（能否服务 → 订阅 → 参考价）与最小能力过滤、被迫切换、渠道锁（激活恢复、压缩后重选）、“参与自动”开关、选择器来源行与按厂商分组、状态栏额度跟随会话实际来源、来源行当前账号 / Key 与重置倒计时（§4、§10.2、§14.1）。**剩余**：`resolveRoute` 统一入口、策略预设与拖动排序、稳定性维度、路由策略设置页（§4.2、§10.3；本期只做设置页 + “省钱”“用掉订阅”两个预设） | “模型聚合”消失，来源变为二级菜单 |
| **P4 个人来源** | 个人凭据、计费主体规则、团队回落、团队策略与个人预算 | 非管理员可登录自己的订阅 |
| **P5 开销与分析** | 计费配置、实际开销、节省量、我的用量 / 团队用量、隐私、项目预算 | 用量页对所有人开放 |
| 以后 | 缓存冷点重选（先在 P3 采集各渠道的空闲间隔与缓存命中数据再定）；项目所有者再分配预算 | — |

## 13. 已定决策（2026-11-03 评审）

1. **协作者回合使用所有者的个人订阅**：允许，且不提供“仅限本人发起”开关。改用协作者的凭据会让同一会话在两人的来源间切换，每次都丢缓存，代价太高。
2. **“不计入团队统计”**：被标记的个人来源用量完全不进入管理员统计，不做部分隐藏，也不提示存在未披露用量。
3. **在线目录更新**：保留，按 §8.2 重做为“自动更新开关 + 立即检查 + 恢复内置版本”。
4. **个人优先 / 团队优先**：用户可选，默认个人优先。
5. **缓存冷点重选**：本期不做，P3 先采集数据，以后再定。
6. **团队预算**：团队总额、个人、项目三本账，只约束团队来源，见 §5.4。
7. **凭据存储**：加密文件，不进数据库；允许管理员关闭加密改存明文，见 §7。
8. **凭据迁移**：管理员经密码 + 第二因素核验后，可导出单个 / 多个 / 全部凭据为口令加密文件，在另一台实例导入，见 §7。
9. **模型值写法**（2026-11-04 改定）：保留 `前缀:模型`，含义改为“指定服务”，凭据在前缀之下选；新增 `auto:<逻辑模型>` 表示自动选来源。不再新增 `narrators.modelSource` 字段，也不把 `narrators.model` 改成不带前缀的逻辑模型。理由：前缀让一个字符串就能确定上游，目录外的模型照样可用，同名而实际不同的上游模型不会被误合并，纪元与推理签名的边界也不用改；而按计费主体选凭据、个人到团队的回落，在前缀之下就能完成。见 §4.1。

## 14. 交接：现状与下一步（2026-11-14 更新）

本节给接手的人：做到了哪里、代码在哪、下一步按什么顺序做、有哪些已知的坑。设计本身以前文为准，数据结构与阶段以 §15 为准。

### 14.1 已完成

下表是已合并的工作。注意：它们都建在旧的按类型配置结构上，§15.1 列出了哪些会保留、哪些会在 S1–S5 中被替换。

| 阶段 | 内容 | 主要位置 |
|---|---|---|
| P0 | `api_requests.billingUserId / projectId`；`usage_daily` 日账本（SQLite 0236、PG 0053）；首页“今日开销”只算本人 | `server/services/usage-daily.ts`、`user-usage-totals.ts`、`server/lib/request-source.ts`、`routes/dashboard.ts` |
| P1 | 模型目录重做：3 层合并、8 类字段、`model-catalog/overrides.json`、精简在线更新、新模型卡界面 | `shared/model-catalog/{override,resolve}.ts`、`server/lib/model-catalog/`、`routes/model-catalog.ts`、`frontend/components/settings/ModelCatalogSection.tsx` 等 |
| P2 | 逐凭据网络身份（Codex 账号） | `shared/credential-network.ts`、`server/lib/codex-network.ts`、`CredentialNetworkEditor.tsx` |
| P2 | 凭据文件加密（可关） | `server/lib/secret-store.ts`、设置 → 服务器与系统 |
| P2 | 凭据迁移：密码 + 第二因素核验、口令加密导出、预览导入 | `server/services/step-up-service.ts`、`server/lib/credential-transfer/`、`routes/credential-transfer.ts`、`CredentialTransferCard.tsx` |
| P2 | 自定义 API 供应商多 Key 池：Key 迁出 settings.json、会话粘性轮换与故障切换、逐 Key 额度与网络身份、Key 列表界面 | `server/lib/provider-keys.ts`、`settings/provider-keys-projection.ts`、`agent/pooled-provider.ts`、`provider-key-{subjects,quota}.ts`、`routes/provider-keys.ts`、`ProviderKeysPanel.tsx` |
| P2 | NUG、TokenDance、Command Code、自定义搜索供应商的 `apiKey` 迁出 settings.json（同一投影，归属 id 带命名空间） | `settings/provider-keys-projection.ts` |
| P2 | 公共池核心：选择模式、亲和与候选排除、失败停用和冷却决策；两种池接入并删除重复实现 | `agent/credential-pool.ts`、`codex-manager.ts`、`agent/pooled-provider.ts` |
| P2 | NUG OAuth secret 与搜索敏感头自动迁出，保持掩码保存；OAuth 随既有密文导出包往返 | `settings/provider-keys-projection.ts`、`settings/search-header-secrets.ts`、`services/data-portability-keys.ts` |
| P3 | 模型值改定为 `前缀:模型` + `auto:<模型>`（§4.1）；`auto` 成为保留前缀；`agent.autoExcludedProviders` | `shared/auto-model.ts`、`server/lib/settings/provider.ts` |
| P3 | `auto:` 排序：能否服务 → 订阅优先 → 参考价；会话来源仍能服务时不换 | `shared/auto-route-strategy.ts`、`server/lib/agent/auto-route-signals.ts` |
| P3 | 子代理可用模型与模型池接受 `auto:` | `server/lib/agent/tools/task.ts`、`settings/provider.ts` |
| P3 | 启动迁移（SQLite 与 PostgreSQL）：`auto` 前缀的供应商改名为 `auto-N`；聚合值迁为 `auto:` / `前缀:模型` | `services/provider-prefix-migration-service.ts`、`services/aggregation-migration-service.ts`、`services/migration-db.ts`、`shared/aggregation-migration.ts` |
| P3 | 模型菜单 `auto:` 行与来源子菜单；聚合设置页只读 | `GET /api/model-catalog/auto`（`server/lib/model-sourcing/auto-models.ts`）、`ModelMenuItems.tsx`、`useModels.ts`、`ModelAggregationsSection.tsx` |
| P3 | 被迫切换（§4.3）；NUG 按网关模型的可用性信号 | `services/agent-runtime/auto-forced-switch.ts`、`orchestrator.ts`、`auto-route-signals.ts` |
| P3 | 渠道锁：激活时取最近回复的服务、压缩后重选、全部不可用时留在原来源（§4.1、§4.3） | `services/auto-sticky-source.ts`、`narrator-session.ts`、`narrator-session-state.ts`、`settings/provider.ts` |
| P3 | 能力过滤：输入类型少的来源排后（§4.2） | `settings/provider.ts` 的 `inputLimitedCandidates` |
| P3 | 保存时校验 `auto:`（§4.1） | `normalizeAutoModelValueForSave`、`routes/narrators.ts`、`routes/settings.ts`、`subagent-runner.ts`、`subagent-model-switch.ts` |
| P3 | 服务详情页“用于自动选择来源”开关与卡片徽章（§4.1） | `AutoParticipationSwitch.tsx`、`providers-reducer.ts`、`routes/settings/providers.tsx` |
| P3 | 选择器：来源行额度条 / 参考价 / 设置入口、自动理由、按厂商分组与去重（§10.2） | `ModelMenuItems.tsx`、`model-menu-selection.ts` |
| P3 | 数据导入 / 导出补 `autoExcludedProviders`、导入会话跟随前缀改名（§11） | `services/data-portability.ts` |

P2 收尾已随 PR #461 合并（`main@384cc950e`）。

S1（统一凭据，§15.9）：拒读名单（#644）、显式上报 `credentialId`（#645 / #654）、运行时状态拆到 `credential-state.json`（#646）已合并；`credentials.json` 与一次性启动迁移（`server/lib/credential-store.ts`、`credential-migration.ts`）已实现。`ProviderKeyStore` 尚未收窄为搜索专用：模型 Key 的外观仍在，S2 以来源组取代投影时再删。

架构说明页（可分享）：设计 https://claude.ai/artifact/19BW1ReTRShtDynQHXJDUE ，现状梳理 https://claude.ai/artifact/HJfhaWMvFtFjxhFDaN8S8E （以本文为准）。

### 14.2 下一步，按顺序

1. 用户评审 §15 并确认 §15.11（2026-11-14 已完成）。
2. 按 §15.9 实施 S1（统一凭据与来源组），之后依次 S2–S6。路由策略预设与成本录入不再单独提前做。

### 14.3 约定与已知事项

- 仓库规则见 CLAUDE.md：不手改 `drizzle/`；schema 改动后 `bun run db:generate`，PG 走 `bun scripts/generate-postgres-schema.ts` + `bun run db:generate:pg --name <name>`，并同步 `scripts/lib/__tests__/check-postgres-schema-parity.test.ts` 的表 / 列数；schema 变更同步 `data-portability.ts`。与 main 合并撞迁移号时：取 main 的 meta / postgres-schema / parity 测试，删掉本分支的迁移文件后重新生成（本分支已做过两次）。
- 只跑相关测试（`bun test --isolate <文件>`），全量交给 CI。
- 回退到 Key 迁出之前的版本会读到空 Key（§7）。
- 状态栏的 Kimi / OpenCode 额度按供应商显示，取第一个可用 Key，不一定是当前会话正在用的 Key；做 P3 时可改为显示会话实际来源。
- 冷却状态只在内存；只有 `invalid`（401）会写进 `provider-keys.json`。
- `identifyModelValue` / `queryForModel` 只认已配置供应商的前缀和 `codex` / `anthropic` / `openai` / `gemini`；未配置的前缀会把整串当上游 id，匹配结果为 `none`。测试里要先注入 `customApiProviders`。
- 路由读 Codex 可用性用 `availableCount`，不要用 `hasAvailableCredentials`：后者会恢复账号并重写凭据文件。
- 目录的 `referencePricing` 是每百万 token 的十进制字符串，可能为 null。
- 新建的 worktree 没有 `frontend/routeTree.gen.ts`（开发服务器启动时生成），`tsgo` 会对全部路由文件报 `parameter of type 'undefined'`，属于既有问题。
- 隔离开发实例：`NARRAFORK_HOME=<空目录> bun run dev` 与 `bun run dev:frontend`；不要动正在运行的 `bun run start:dev` 进程。
- `frontend/components/providers/provider-presets.test.ts` 的 MIT 许可用例读 `node_modules/normalize-path/LICENSE`；worktree 里没装这个包时会失败，与代码改动无关。
- `auto:` 被迫切换的阈值（15 分钟）与每次运行的切换上限（3 次）在 `auto-forced-switch.ts`，是按缓存寿命估的经验值，有用量数据后再调。

## 15. 架构契约（2026-11-14 用户确认）

前文定了概念，但没定数据结构、迁移和接口，P0–P3 的每个 PR 只能在旧结构上逐类打补丁。本节把 §3 的三层模型落到可以直接实现、评审能逐条核对的契约，并按用户 2026-11-14 的决定收窄：**用户和管理员不维护“服务”，只添加凭据或 API**，服务退为系统内部的分组（15.2）。依据 `main@6bda69b5d`，经过两轮对照代码的独立评审；15.11 的问题已按推荐定下。

### 15.1 现状评估

| 设计要素 | 现状 | 证据 |
|---|---|---|
| 服务 / 凭据 / 渠道（§3） | 未开始 | 配置仍是 `customApiProviders`（派生出 openai / anthropic / gemini 三个数组）、`nugProviders`、`tokendance`、`commandCode`、`codex`、插件各自一套；全仓没有 `serviceId`、服务模板、`resolveRoute` |
| 服务模板 | 未开始 | 登录、额度探测、是否订阅、模型列表写死在各 manager 和缓存里；`autoSourceFacts` 用 `provider === "codex"`、`isKimiCustomApiProvider` 等分支判断；`provider-presets.ts` 只在前端，只有端点和协议 |
| 凭据统一形态（§6） | 部分 | 只有 Codex 有多种登录方式；网络身份只覆盖 Codex 账号和自定义 API 的 Key；没有计费、归属字段 |
| 通用凭据池 | 只共享算法 | `credential-pool.ts` 的选择 / 失败决策两边共用，但存储、管理 API、界面仍是 `codex-credentials.json` 与 `provider-keys.json` 两套；NUG 被显式排除出 Key 池（`provider.ts` 的 `kind === "nug" ? []`）；TokenDance、Command Code 的 Key 只是移出 settings 的单值 |
| 来源 id | 不统一 | Codex 账号 id、Key id（首个 Key 等于连接 id）、NUG 连接 id、字面量 `tokendance` / `CommandCode`、插件自报任意值或 `null`；Key 存储里的 `nug:<id>`、`builtin:*` 与请求记录的 id 对不上 |
| 路由入口 | 未统一 | 仍是 `resolveProviderAndModel(前缀, 粘性服务)`，不知道计费主体；约 20 个非测试位置直接解析；原生搜索、NUG 路由直接构造适配器，绕过注册表与 Key 池 |
| 权限 | 只有管理员 | `provider-keys`、`codex`、凭据迁移路由和设置 PATCH 都是 `requireAdmin`；凭据没有归属 |
| 设置页（§10.3） | 偏离 | `providers.tsx` 按类型分派 Section；没有“我的来源 / 团队来源 / 路由策略”；添加页没有“粘贴 Key 自动识别” |
| 模型聚合 | 未下线 | UI 只读，但设置 PATCH 仍接受写入，模型菜单仍能选出新的 `__agg__:` 值，运行时仍解析 |

已完成且会保留的：`auto:` / `前缀:模型` 写法、纪元锁与被迫切换、`credential-pool.ts`、`session-affinity.ts`、`secret-store.ts`、step-up 核验与口令加密包、`usage_daily`、模型目录。会被替换的：`provider-keys.json` 与 `codex-credentials.json` 两种格式、`provider-keys-projection.ts` 的投影、`request-source.ts` 的多种 id 写法、`autoSourceFacts` 的类型分支、`providers.tsx` 的按类型分派。

### 15.2 用户只添加凭据或 API；来源组由系统自动维护（2026-11-14 用户决定）

用户和管理员不再维护“服务”。可以添加的只有两种东西：

- **凭据**：已知服务的账号或 Key，端点由模板决定。例如登录 ChatGPT（Codex）、粘贴 Kimi Code / OpenCode Go / DeepSeek / Anthropic / OpenAI / Gemini 官方 Key、TokenDance、Command Code。用户不填地址、不起名、不设前缀。
- **API**：自定义端点，即地址 + Key（中转、NUG、自建网关、官方服务的镜像地址）。

“服务”只在系统内部存在，叫**来源组**：路由、凭据池、额度汇总和模型前缀都以它为单位。来源组由系统维护：

- **添加时自动归组**：已有同模板、同端点（含区域）、且没有改过高级项的组，新凭据加进这个组的池；没有就自动新建一个组。个人凭据与团队凭据可以在同一组里，归属记在凭据上，路由时按计费主体过滤、分层（15.5）；这样 `前缀:模型` 也能在同一组内从个人回落到团队（§5.3）。
- **自动消失**：组里最后一个凭据被删除时，组一起删除。
- **不需要配置**：显示名默认取模板名或主机名（可改），前缀自动生成且不再变；高级项（协议、请求头、UA、代理、上下文窗口、工具图片等）在组的“高级”里，默认折叠，模板默认值能用就不展示。

**服务模板**（代码注册表，`server/lib/sourcing/templates.ts`）：描述“一种上游怎么用”，不含用户数据。S2 PR 1 先只放数据字段，行为方法随后续 PR 逐个挂上；`identify` 不挂在模板上，而是一张共用的识别表（见下）。

```ts
interface ServiceTemplate {
  id: string;                  // 已知服务："codex" | "kimi-code" | "opencode-go" | "deepseek" | "anthropic"
                               //   | "openai" | "gemini" | "tokendance" | "command-code"
                               // API 用：  "openai-compatible" | "anthropic-compatible" | "gemini-compatible" | "nug" | "plugin"
  kind: "known" | "api";       // known：用户只加凭据；api：用户加 API（地址 + Key）
  preferredPrefix?: string;    // 新建组时优先用的前缀，如 "kimi"；被占用时按现有规则加序号
  endpoints?: Partial<Record<Protocol, string>>;      // known 模板各协议的官方地址
  regions?: Record<string, Partial<Record<Protocol, string>>>;  // 区域变体，如 Kimi 国内 / 国际
  authKinds: AuthKind[];       // 支持的登录方式
  multiCredential: boolean;    // 能否放多个凭据进池
  subscription: boolean;       // 订阅制（额度窗口内不另计费）
  defaults?: Partial<SourceGroupOptions>;  // 模板默认的高级项，如 Kimi 的 UA
  probeQuota?(group, credential, signal): Promise<QuotaSnapshot>;
  listModels?(group, credential, signal): Promise<string[]>;
  isModelAvailable?(group, upstreamModel): boolean;  // 内存判断，如 NUG 按网关模型的可用性
  dedupeKeys?(credential): string[];   // 导入时识别同一账号（Codex：rt / sub / 账号+邮箱 / at / agent）
  identify?(input: { baseUrl?: string; protocol?: Protocol; apiKey?: string }): boolean;  // 粘贴识别与旧配置归类
  personal: boolean;           // P4：是否允许个人凭据
}
```

- `autoSourceFacts` 的“能否服务 / 是否订阅”改由模板的 `subscription`、`isModelAvailable` 与凭据状态得出，不再按类型写分支。前端预设改由后端下发模板列表。
- `identify` 用精确的主机 + 路径表（`shared/sourcing/identify.ts` 的 `identifyService({ baseUrl, protocol })` → `{ templateId, region? }`，前后端共用），识别不出就给对应协议的 `*-compatible`，NUG 连接一律 `nug`。原来散在各处的额度探测白名单（`isKimiCustomApiProvider` / `isOpencodeCustomApiProvider` / `isDeepSeekCustomApiProvider` 及前端同款）改为调用它，判定逐条不变：Kimi 行仍是 `kimi.com` / `kimi.ai` 及子域的任意地址（国内 / 国际），OpenCode Go、DeepSeek 与新增的 OpenAI / Anthropic / Gemini 官方行要求 https、默认端口、无用户信息 / 查询 / 片段，因为命中即会把 Key 发去额度接口。Moonshot 的 `api.moonshot.{cn,ai}` 是按量计费平台，不是 Kimi Code 套餐，归 `*-compatible`。`isOfficialChatGPTDomain`（决定是否发送 `ChatGPT-Account-Id` / ChatGPT Origin）不是模板识别，保持原样。归类错了只影响默认值和额度探测，不影响请求发往哪里，因为端点保存在组上。
- 现有的 `ProviderSourceRegistry` 保留为“按模板构造适配器”的后端；`registerCredentialProviderSource` 的协议族注册变成 `api` 类模板。

**来源组**（`settings.json` 的 `sourceGroups[]`，非机密，待决 1）。组本身没有归属：一个用户能看到、能用一个组，当且仅当组里有对他可用的凭据。

> **2026-11-23 用户决定：来源组推迟到 S5 才落盘。** S2 不改 `settings.json` 结构，也不做投影翻译层：每个现有连接本来就是一个来源组，来源组只在内存里从现有数组算出——`server/lib/sourcing/source-groups.ts` 的 `SourceGroupView { id, templateId, kind, prefix, name, disabled, endpoint: { baseUrl?, protocol?, region? } }`，来自 `customApiProviders`、`nugProviders`、TokenDance / Command Code / Codex 单例与插件供应商；`listSourceGroups()` / `getSourceGroup(id)` / `getSourceGroupByPrefix(prefix)` 只读，按 settings revision 与插件注册表 revision 缓存。下面的 `SourceGroup` / `SourceGroupOptions` 是 S5 的落盘形态；S5 之前高级项仍在各旧连接对象上。S5 重做设置页时一次性把磁盘改成 `sourceGroups[]` 并删除旧数组。

```ts
interface SourceGroup {
  id: string;                  // 沿用旧 id：自定义 API / NUG 用原 provider id；单例用 "codex" / "tokendance" / "CommandCode"
  templateId: string;
  name: string;
  endpoint: { baseUrl?: string; protocol?: Protocol; region?: string };  // known 模板可只给 region
  prefix: string;              // 自动生成并固定；迁移时沿用旧前缀
  disabled?: boolean;
  options?: SourceGroupOptions;
}

interface SourceGroupOptions {   // 由现在 CustomApiProviderConfig / NUGProviderConfig 的字段原样搬入
  defaultModel?; geminiTransport?; defaultContextWindow?; defaultReasoningEffort?;
  proxy?; tlsRejectUnauthorized?; nativeSearch?; toolResultImages?;
  userAgentMode?; customUserAgent?; extraHeaders?;
  codexAccountId?; codexWebSocket?; codexWebSearch?; codexImageGeneration?;   // openai-responses 协议都用
  quotaSiteUrl?; quotaUserId?;
  nugUsername?; nugUserId?; oauthClientId?; oauthDeviceId?; oauthCallbackUrl?;
  egressMode?; egressProxyUrl?; egressAllowDirectFallback?;
}
```

- 组的机密（站点 token `quotaAccessToken`、NUG OAuth client secret）不是推理凭据，存在凭据文件的 `groupSecrets[groupId][field]`；它们的读方都经内存里的 settings 字段读取，过渡投影回填后不用改。
- 模型值写法不变：`前缀:模型` 指定来源组，`auto:模型` 自动选组。前缀全局唯一，`auto` 保留。用户在选择器和设置页看到的是组的显示名，不需要知道前缀。
- “参与自动”、隐藏模型、自定义模型、逐模型协议这些现有偏好继续按前缀存在 `agent.*` 里，在设置页挂在对应的组上显示。
- Codex 的全局偏好（`settings.codex` 里的 WebSocket、原生搜索、生图开关）是 `codex` 组的选项，位置不变。

搜索供应商不属于模型来源，不纳入本体系（待决 4）：其 Key 继续存在 `provider-keys.json` 的 `search:<id>` 条目，敏感头继续存在 `search-provider-secrets.json`；S1 之后 `provider-keys.json` 只剩搜索 Key，`provider-keys.ts` 收窄为搜索专用。

### 15.3 凭据实体

```ts
interface Credential {
  id: string;                  // 规则见下
  target:                      // 属于哪个来源组
    | { groupId: string }               // 来源组（已知服务或 API）
    | { pluginContributionId: string }; // 插件供应商，配置仍由插件配置服务管理
  ownerUserId: string | null;  // null = 团队凭据；P4 之前只接受 null
  label?: string;              // Codex 的 displayName
  priority: number;            // 组内顺序，小者优先
  createdAt: number;           // Codex 没有此字段，迁移时取迁移时间
  archivedAt?: number;
  disabled?: boolean;          // 只表示人工或判定为不可用的停用，见下
  disabledReason?: "manual" | "invalid" | "banned";
  network?: CredentialNetwork;
  auth:
    | { kind: "api_key"; apiKey: string }
    | { kind: "oauth"; refreshToken?: string; accessToken?: string; expiresAt?: number }
    | { kind: "pat"; accessToken: string }
    | { kind: "agent_identity"; agentRuntimeId: string; agentPrivateKey: string; taskId?: string }
    | { kind: "opaque"; fields: Record<string, string> };  // 插件的 secret 字段包
  account?: { accountId?: string; email?: string; sub?: string; fedramp?: boolean };
  options?: { useCreditQuota?: boolean };
  billing?: never;             // P5 再定义，先不放
  privacy?: never;             // P5 再定义
}
```

字段名与 Codex 现有字段、导入格式一致（`agentRuntimeId` / `agentPrivateKey` / `taskId`、只有 accessToken 的 OAuth 凭据合法）。`accessToken`、`expiresAt`、`taskId` 会自动轮换或按需注册，凭据文件会随之频繁重写，这与 Codex 现状相同。

**id 规则：迁移后等于当前写进 `api_requests.credentialId` 的值，历史用量不断档。**

| 来源 | 凭据 id |
|---|---|
| Codex 账号 | 原账号 id |
| 自定义 API，多个 Key 或带网络身份 | 原 Key id（PooledProvider 记账用的就是它） |
| 自定义 API，只有一个启用的普通 Key | 连接 id（直连适配器记账用的是连接 id）。原 Key id 与连接 id 不同时（删过首个 Key、重排过），迁移把这个 Key 改用连接 id；连接 id 已被别的 Key 占用时保留原 Key id，单 Key 期间的历史与之断开，迁移日志记下 |
| NUG | NUG 连接 id（不是 Key 存储里的 `nug:<id>`） |
| TokenDance / Command Code | `tokendance` / `CommandCode` |
| 插件 | `plugin:<pluginId>:<contributionId>`，插件自报的 id 不再原样记账（待决 3） |
| 新建 | `generateId()`（21 位） |

存储保证 id 全局唯一；撞上时迁移报错停止，不静默改 id（处理见 15.8）。

**存储**：一个加密文件 `credentials.json`（`secret-store`，与现有凭据同一套加密开关、拒读名单与“解不开就不写”规则），内容 `{ version, credentials[], groupSecrets }`，取代 `codex-credentials.json` 与 `provider-keys.json` 中的模型凭据。

**运行时状态不进凭据文件**：额度快照（Codex 的 `usage`）、`usageHistory`、冷却、成功 / 失败计数（现在的 `codex-stats.json`），以及系统判定的暂时不可用 `blocked?: { reason: "too_many_failures" | "quota_exhausted"; resetsAt? }`（现在的 `disabledReason` + `quotaResetsAt`），放 `credential-state.json`（非机密，防抖写入）与内存。

- **能否参与选择** = 未停用 且 未归档 且 未被阻挡。自愈、重置恢复只改 `blocked`，不碰用户的 `disabled`。
- `invalid` / `banned` 由系统写入并持久化在凭据上，直到用户编辑凭据，或重新登录 / 导入同一账号时清除（现有行为）。
- `credential-state.json` 读不了时按空状态启动（额度会重新探测），不阻止凭据加载；必须在池第一次选择之前加载完，因为档位均衡要读 `usage.plan_type`。

### 15.4 额度快照

所有探测器统一产出，按凭据存取：

```ts
interface QuotaSnapshot {
  fetchedAt: number;
  error?: string;
  scope: "key" | "account" | "wallet" | "subscription";
  windows: Array<{ kind: "5h" | "weekly" | "monthly" | "other"; label?: string;
                   usedRatio: number | null; resetsAt: number | null }>;
  balances: Array<{ unit: string; remaining: number | null; total?: number; unlimited?: boolean }>;
  plan?: string;               // 套餐档位，如 Codex 的 plan_type
  detail?: unknown;            // 模板私有的原始数据，如 Codex 的 credits、code_review、重置额度
}
```

- Codex、Kimi Code、OpenCode Go、Command Code 有窗口；DeepSeek、TokenDance、NUG、站点额度只有余额；provider-balance 两者都可能有，`resetsAt` 可空。
- 通用界面（额度条、选择器来源行、自动路由）只读 `windows` / `balances` / `plan`；Codex 的档位均衡、用 credits 续用、重置额度按钮与预测继续读 `detail` 里的原结构。
- 现在按 provider 探测的（DeepSeek、站点额度、NUG、provider-balance）迁移后挂在该来源组的首个凭据上。
- 持久化统一用带身份指纹的 `persisted-credential-cache`；Kimi、站点额度、NUG 现在的明文缓存随之替换。
- 池的“额度用完跳过”沿用 `keyQuotaBlockedUntil`（已按 Key id 工作），扩展到所有模板的凭据。

### 15.5 渠道快照与 `resolveRoute`

渠道 = 来源组 × 凭据。路由只读内存快照，不查库、不发网络请求；凭据、API 或运行时状态变化时经事件总线（`sourcing.changed`）失效重建。

```ts
resolveRoute({
  modelValue,                  // "前缀:模型" | "auto:模型" | 遗留 "__agg__:…"
  billingOwner,                // userId | null（null = 只用团队凭据）
  narratorId?,                 // 有叙述者时传，用于取缓存的计费主体与诊断
  stickyPrefix?,               // 纪元锁：会话最近一次回复所用来源组的前缀（auto-sticky-source 读出的就是前缀）
  caps?,                       // 能力需求，如图片输入
  forceReselect?,              // 压缩后重选
}) → { group, prefix, upstreamModel, credentialFilter, adapter, reason } | null
```

本签名取代 §4.2 开头的草案。前缀在来源组创建后不再改变；用户确实改了前缀时沿用现有前缀迁移（改写模型值）。`stickyPrefix` 找不到组时视为没有粘性。

- **两级选择**：先选来源组，再在组内选凭据。
  - 选组：`前缀:模型` 直接定组；`auto:` 按现有排序与粘性。判断一个组“能否服务”时只看 `credentialFilter` 里的凭据（个人用完、团队可用算能服务；没有团队权限的用户则不算），再加模板的 `isModelAvailable`。§4.2 的过滤与分层在这一步完成。
  - 选凭据：仍在请求时由该组的池完成（保住会话亲和、故障切换、额度跳过），只在 `credentialFilter` 范围内选。CodexManager 与 PooledProvider 退化为“给定凭据集合的池 + 适配器 + 失败上报”。
- **同步**：计费主体按叙述者缓存（沿 `aclRootNarratorId` 取 `ownerUserId`，逻辑同 `usage-daily.ts` 的 `resolveRequestAttribution`），叙述者激活时取一次（PostgreSQL 后端在激活的异步流程里取），转让所有者、移动或重挂 ACL 根时失效。路由时不查库。
- **纪元指纹不变**：仍是 `前缀:上游模型`；凭据不进指纹，同组内换凭据不开新纪元。
- **切换顺序**：
  1. `resolveProviderAndModel(model, sticky)` 改为调用 `resolveRoute({ billingOwner: null })` 的薄壳，行为不变。薄壳保留现有 `ProviderResolution.adapter`、默认模型回落（`buildResolution`）与 NUG / TokenDance 的 `prepareForModel`。
  2. 主对话（orchestrator、loop）、子代理、`agentGenerate*` / `summaryGenerate*`（从 `tracking.narratorId` 推导）改传计费主体；没有叙述者的入口（git 提交信息、设置页测试、启动检查）继续只用团队凭据。
  3. 直接构造适配器的入口改为经模板与凭据取适配器：原生搜索的 `new AnthropicProvider`（`search/router.ts`），`new NugProvider` 的 `routes/nug.ts` 三处、`nug-model-refresh-coordinator.ts`、`nug-availability-poller.ts`。
- **聚合下线**：先从模型菜单移除（`useModels.ts` 仍会列出聚合）、设置 PATCH 拒绝写入 `modelAggregations`；入口把遗留 `__agg__` 规范化为 `auto:` 或具体值，同样按计费主体过滤；一个版本后删除运行时分支与设置字段。

### 15.6 归属与权限（只定到不阻塞 P4）

- 团队凭据（`ownerUserId = null`）：仅管理员可增删改。
- 个人凭据：所有者可增删改、查看秘密的掩码；管理员可见元数据、可停用，看不到秘密。只有所有者的会话能用到它。
- 来源组的高级项：组里有团队凭据时只有管理员能改；只有某个用户的个人凭据时由这个用户改。前缀全局唯一，别人只能从“前缀已占用”得知一个纯个人组存在，影响可以接受。
- 个人凭据只能加在模板 `personal = true` 的服务下（Codex、Kimi Code、OpenCode Go、官方 API Key 类）或自己的 API 上。
- 计费主体 = 根叙述者所有者（§5.1）；所有者为空时只用团队凭据。
- NarraForkAdmin 的设置 deepMerge 不得写 `sourceGroups` 与凭据；凭据只经凭据 API 修改。（对 `sourceGroups` 的写保护随其落盘在 S5 做。）

### 15.7 插件供应商

插件的 secret 已在宿主的 `plugins/secrets.json`（明文 0600，键 `provider.<contributionId>.<field>`），宿主每次调用时读出传给插件；插件协议没有额度、登录、订阅方法。

- 插件供应商是一个 `plugin` 模板的来源组，配置仍由插件配置服务管理；凭据是 `opaque` 字段包。不参与多凭据池、不声明订阅，`auto:` 中视为按量来源。每个插件供应商只有一个凭据，所以来源 id 按 `plugin:<pluginId>:<contributionId>` 记账；插件内部若轮换多个账号，宿主看到的仍是一个来源。
- 迁入时机待决（待决 2）：推荐第 1 阶段不动插件 vault，第 2 阶段把 provider 字段搬进统一凭据，其余插件秘密留在 vault。
- 额度、多账号要等插件协议新增方法，本契约不预设。

### 15.8 迁移与兼容

> **2026-11-23 调整**：`sourceGroups[]` 落盘、下面的“过渡投影”与 Key 归属命名空间（`nug:` / `builtin:`）的外观清理、NarraForkAdmin 对来源组的写保护都推迟到 S5。S2 只有内存视图 `SourceGroupView`（15.2），一对一规则与 `identify` 归类照样适用于它；数据导出与凭据迁移在 S2 改为“旧数组里的非机密配置 + 密封的统一凭据”。

- **一对一迁移，不合并**：每个旧连接变成一个来源组，id、前缀、端点、高级项原样保留；连接的全部 Key 成为该组的凭据。没有前缀别名，不改任何模型值、纪元指纹与推理签名来源，会话不因迁移开新纪元。
  - `templateId` 由模板的 `identify` 判定（精确主机 + 路径，忽略 `disabled`），识别不出就归为对应协议的 `*-compatible`。它只决定默认值和额度探测，不影响请求发往哪里。
  - Codex 账号 → `codex` 组；TokenDance、Command Code → 各自的单例组；NUG → `nug` 模板的组；插件不动（15.7）。
  - 多个旧连接指向同一已知服务时仍是多个组，不自动合并。用户以后想合到一个池里，可以把凭据移到同一组，空组自动消失（S5 提供入口）。
- **过渡期新建**：S5 之前前端仍用旧的“添加供应商”页，新建的连接一律按上面的规则一对一建组，不并入已有组。
- **一次性启动迁移**（S1，已实现，`server/lib/credential-migration.ts`）：
  - 模式由文件决定，不用 settings 标记：`credentials.json` 存在即统一模式，CodexManager 与 `ProviderKeyStore` 都从它读写（`credential-store.ts` 每个 home 一个实例，两者各交自己的一段——按登录方式区分，`api_key` 归 Key 段、其余归 Codex 段——写文件时拼上另一段最近保存的内容，互不覆盖）；不存在时两者照旧读写 `codex-credentials.json` / `provider-keys.json`。`search:` 条目两种模式都留在 `provider-keys.json`。
  - 时机：首次加载设置时，`secrets.encrypt` 生效之后、任何凭据所有者创建之前（旧的 per-provider `codexOAuth` 迁移随之挪到加密开关之后）；热重载和加载设置的 Worker 线程（如请求录制）不跑。只在没有 `credentials.json` 且旧文件里有模型凭据时执行，新装实例在有凭据后的下一次启动迁移。不读 settings：Key 的归属 id 已带连接 id 与命名空间。
  - 步骤：读两个旧文件（任一不可读 → 放弃，零写入）→ 按 15.3 定 id（id 重复，或两类连接共用一个组 id，如 NUG 与自定义 API 同 id、自定义 API 的 id 为 `codex` → 放弃，零写入）→ 把 `settings.json`、`codex-credentials.json`、`provider-keys.json`、`credential-state.json`、`codex-stats.json` 中存在的复制到 `credential-backups/pre-sourcing-<时间>/`（目录 0700、文件 0600）→ 旧 Codex 文件里仍内嵌的运行时状态写进 `credential-state.json`（`codex-stats.json` 仍由 CodexManager 加载时迁走）→ 原子写出完整的 `credentials.json` → 清理：`provider-keys.json` 只留搜索 Key（没有就删除），删 `codex-credentials.json`。
  - 崩溃恢复：写出 `credentials.json` 之前崩溃，下次从旧文件重做（多一份备份）；之后崩溃，下次以统一模式启动并重做清理（幂等，所有者忽略残留的非搜索条目）。
  - 放弃时旧体系照常可用、可编辑，下次启动重试。id 冲突不会自愈：记日志，`GET /api/settings` 只对管理员带 `credentialMigrationConflicts`（id、所属来源组与类别、标签），供应商设置页顶部显示一条提示，管理员删除或重新添加其中一个后重启即可完成迁移。
  - 文件中 Key 归属按组：`nug:<id>` → `<id>`，`builtin:tokendance` / `builtin:CommandCode` → `tokendance` / `CommandCode`；`quota:<id>` / `nug-oauth:<id>` 成为 `groupSecrets[<id>]` 的 `quotaAccessToken` / `oauthClientSecret`。旧命名空间只留在 `ProviderKeyStore` 外观里，调用方语义不变。
- **过渡投影**（推迟到 S5，S2 不做）：设置页重组（S5）之前，内存里的 `settings` 继续由来源组 + 凭据投影出 `customApiProviders` / `nugProviders` / `tokendance` / `commandCode` 及派生的三个数组；因为迁移是一对一，投影出的连接 id、前缀与迁移前完全相同。`GET /api/settings` 与整数组 `PATCH` 照旧，写入翻译成来源组与凭据。这沿用了 Key 迁出时 `provider-keys-projection.ts` 的做法。
  - 记账：所有适配器路径（含只有一个普通 Key 的直连路径）都显式上报 `credentialId`，`defaultRequestSourceId` 只留给旧数据。这样单凭据组的记账 id 不再依赖“按前缀找连接 id”，网络身份下沉到凭据后也不会变。
  - 依赖完整对象的约 25 个读方（适配器构造、额度缓存、各家模型列表与测试路由）先读投影，逐步迁走；只读前缀 / 名称的读方收窄成 `SourceGroupView`（参照 `token-recalculation-protocol.ts` 的窄接口）。
  - 整数组写入 settings 的地方都要经翻译层，并各有回归测试：设置 PATCH（含掩码 Key 回填）、`provider-prefix-migration-service`、凭据迁移导入时新建供应商（`credential-transfer/kinds.ts`）、数据导入、`tokendance-service`、`routes/nug.ts`、`fix-provider-baseurl` 与 `codex-image-generation-fix`。
  - NarraForkAdmin 的 `deepMerge` 不得改写投影出的数组与 `sourceGroups`。
- **降级**：迁移后旧版本读不到新文件；用备份目录可手动恢复迁移前的全部文件。发布说明写明。
- **数据导入 / 导出**：S2 起供应商部分导出旧数组里的非机密配置（与逐模型设置）与密封的统一凭据（`credential` / `group-secrets` 条目）；S5 落盘后再改为导出来源组。下面的兼容规则不变：导入同时接受旧格式（v1 明文 Key、v2 密封 Key）并按一对一规则转换，前缀冲突沿用现有的改名与会话联动。旧包按 `nug:<id>`、`nug-oauth:<id>`、`quota:<id>`、`builtin:*` 归属存条目且不带 Key id，这些命名空间的解析只留在导入兼容模块里；导入的凭据拿新 id，旧实例上的用量不跟过来（与现状相同）。
- **凭据迁移**：`TransferKind` 合并为一种“凭据”，覆盖所有模板；旧包可导入。
- **用量历史**：凭据 id 规则见 15.3；`usage_daily.provider` 与 `credential_usage_totals.provider` 仍是请求时前缀。迁移不改前缀，按前缀与按凭据的汇总都连续。按 id 查询的地方（`usage-history-service`、`requestSourceName`、`resolveCredentialDisplayName`）改为查凭据实体。删除凭据时沿用 Codex 现在的做法清掉其 `credential_usage_totals`，对所有模板一致。
- **数据库**：凭据仍走文件，无表结构变更。

### 15.9 分阶段实施

| 阶段 | 交付 | 验收 | 用户可见变化 | 删掉的旧代码 |
|---|---|---|---|---|
| **S1 统一凭据** | `Credential` 实体与 `credentials.json`（`target.groupId` 即现有连接 id 或 `codex` / `tokendance` / `CommandCode`）；所有适配器显式上报 `credentialId`；运行时状态拆到 `credential-state.json`；单一内存所有者 `CredentialStore`，`ProviderKeyStore` 与 CodexManager 成为它的视图；启动迁移、备份与冲突提示 | 每类旧凭据迁移后记账 id 不变（逐类测试，含“删过首个 Key 的单 Key 连接”）；连接 id、前缀、旧模型值解析结果与纪元指纹不变；现有设置 API、Key 面板、Codex 页行为不变；旧导出包与凭据迁移包可导入；不可读 / 冲突时零写入；搜索 Key 不受影响 | 几乎没有 | `codex-credentials.json` / `codex-stats.json` 读写、`provider-keys.ts` 中的模型凭据部分（收窄为搜索专用） |
| **S2 服务模板**（来源组只做内存视图） | 模板注册表与行为（额度探测、模型列表、`isModelAvailable`、去重）；`identify` 识别表；内存视图 `SourceGroupView`（不落盘）；`QuotaSnapshot` 统一与按凭据探测；TokenDance / Command Code / NUG 按模板进池；前端预设由后端下发；凭据迁移与数据导出改为“旧数组配置 + 密封统一凭据”；插件 provider 秘密迁入统一凭据 | `settings.json` 结构、连接 id 与前缀不变；旧判定函数的结果逐条不变；`autoSourceFacts` 无类型分支；通用额度界面只读 `QuotaSnapshot`；插件按 `plugin` 模板列出 | 额度显示一致；同一来源可放多个凭据 | `autoSourceFacts` 分支、各明文额度缓存、前端 `provider-presets.ts` / `provider-connection-presets.ts`；旧导出 / 迁移包的命名空间解析收进导入兼容模块 |
| **S3 resolveRoute** | 渠道快照；`resolveRoute` 与薄壳；计费主体缓存；直接构造适配器的入口收口；聚合下线 | 全部路由调用经 `resolveRoute`；行为测试覆盖粘性、被迫切换、能力过滤不回归；菜单无聚合项 | “模型聚合”彻底消失 | `resolveAggregation`、`modelAggregations` |
| **S4 个人来源**（原 P4） | 凭据与 API 按归属鉴权；个人 → 团队分层与回落；状态条回落提示 | 协作者回合用所有者凭据；所有者为空只用团队；个人秘密不对管理员可见 | 非管理员能登录自己的订阅、加自己的 Key 或 API | `requireAdmin` 的凭据路由 |
| **S5 设置页重组** | `settings.sourceGroups[]` 落盘（一对一迁移、`identify` 推断模板）并删除旧数组；Key 归属命名空间外观清理；NarraForkAdmin 对来源组的写保护；“我的来源 / 团队来源 / 路由策略”；按来源组列出凭据，Codex 式统一凭据详情；添加入口只有“添加凭据 / 添加 API”，粘贴 Key → 模板识别 → 拉模型与额度；路由策略两个预设 | 迁移后连接 id 与前缀不变；设置页不再按类型分派；新用户粘贴一个 Key 即可用 | 设置结构按 §10 | `providers.tsx` 分派、`providers-reducer` 多数组状态、`customApiProviders` / `nugProviders` 等旧数组、Key 投影的归属命名空间（只留导入兼容） |
| **S6 成本与用量**（原 P5） | 凭据 `billing` / `privacy`；实际开销、节省量；我的用量 / 团队用量；项目预算 | 见 §9 | 用量页对所有人开放 | — |

每阶段独立发布。S1、S2 没有明显的用户可见收益，但跳过它们直接做 S4 / S5 会再次在旧结构上双份打补丁。

**2026-11-14 实施收窄**：因为迁移一对一，S1 不需要改 settings 结构——凭据的 `target.groupId` 直接用现有连接 id，settings 里的各数组在 S1 期间继续充当来源组。因此 `sourceGroups[]`、过渡投影翻译层和导出 / 凭据迁移的格式变化一起移到 S2：S1 不动设置 PATCH、前端与整数组写入方，旧导出包和凭据迁移包经兼容视图照常读写。Key 冷却继续只在内存，不新增持久化。S1 拆成五个 PR：拒读名单与备份目录 → 显式上报 `credentialId` → 运行时状态拆分 → `CredentialStore` 单一所有者 → `credentials.json` 与启动迁移。实际实现把后两步合在最后一个 PR：`CredentialStore` 只负责一个文件的读写与加密重写，CodexManager 与 `ProviderKeyStore` 各自保留内存数据与原有 API，按段交给它写出；迁移与模式切换见 15.8。

**2026-11-23 S2 收窄**：来源组推迟到 S5 落盘（15.2），S2 不改 `settings.json`、不做投影翻译层。S2 拆成九个 PR，顺序 PR 1 → PR 2 ∥ PR 3 → PR 4 → PR 5 ∥ PR 6 → PR 7 → PR 8 ∥ PR 9：

1. 模板注册表（只有数据字段）、`identify` 识别表与 `SourceGroupView` 内存视图；旧判定函数改为调用 `identify`，无行为变化。
2. 预设由后端下发：`provider-presets.ts` / `provider-connection-presets.ts` 的数据搬进模板，`GET /api/sourcing/templates`。
3. 统一额度快照的存储与探测器（Kimi、OpenCode、DeepSeek、中转余额），池的“额度用完跳过”统一注册；旧接口从快照转换。
4. 其余来源接入快照（TokenDance、Command Code、NUG、响应头余额；Codex 从 `credential-state.json` 投影）。
5. 前端改读统一快照，删各类型的格式化与 hook 及旧接口。
6. `autoSourceFacts` / `autoSourcePreview` 按模板，删类型分支。
7. TokenDance / Command Code / NUG 进凭据池，是否走池由模板 `multiCredential` 决定。
8. 统一的凭据迁移与数据导出格式（旧数组配置 + 密封统一凭据），共享的组 id 与前缀避让，旧包经兼容模块导入。
9. 插件供应商按 `plugin` 模板列出，provider 秘密迁入统一凭据。

### 15.10 不做 / 推迟

稳定性维度、均衡预设、拖动排序、跨模型回落、缓存冷点重选、团队预算的分配权下放、插件额度协议、在模型值里指定单个凭据。路由策略的两个预设随 S5 设置页一起做。

### 15.11 已决问题（2026-11-14 用户按推荐确认）

正文中的“待决 N”指下列各条，均已按推荐执行。

1. `sourceGroups[]` 放 `settings.json` 还是独立文件。推荐 `settings.json`：非机密、与其他设置同一套热重载和 PATCH。
2. 插件 provider 的 secret 何时迁入统一凭据。推荐 S2，S1 不动插件 vault。
3. 插件来源 id 加 `plugin:` 命名空间会让插件历史用量与新记录断开。推荐接受：插件历史记录多数为 `null`。
4. 搜索供应商是否纳入本体系。推荐不纳入：它不是模型来源。
5. ~~P4 时普通用户能否自建服务实例~~：随“不再有服务”自然解决，普通用户在 P4 可以加个人凭据或个人 API，系统自动建个人来源组。
6. 已知服务有区域变体（Kimi 国内 / 国际等）时，自动归组按区域分开。推荐分开：两个区域的 Key 不通用。
