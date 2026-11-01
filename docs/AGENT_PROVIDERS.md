# Agent Provider 注意事项

## 历史构造与宿主更新

历史统一走 [history-build.ts](../server/lib/agent/history-build.ts) 与 [projection](../server/lib/agent/projection/index.ts)：持久行先解码为 neutral turns，再由各 provider 映射线上形状。实时请求与恢复使用相同投影，不再把尾部 `sys` 弹出并另造当前轮文本。

- 普通 `sys` 注入沿现有协议门控：Anthropic 支持对话中 system 的路径交给 `ensureAlternating` 调整合法位置，其余走已有 user 载体。
- **`context_update` 是例外：所有当前适配器都使用已有 user 宿主载体。** Anthropic 也不把它变成 system，避免末尾更新被 `ensureAlternating` 移到后续 user 输入之后。Responses/Codex 保留在 `input`，不提进顶层 `instructions`。没有据此推断上游支持任意中途 developer 文本。
- 基线声明具名动态部分的替换契约；user 载体不是提升消息角色。更新只替换点名部分，未提及部分保持不变，固定安全规则和执行权限不由更新修改。
- 大更新正文已外置：持久 `sys` 行只存 `[{type:"text", text:"Context updated: keys"}, {type:"context_update", epochId, changes:[], snapshotRef}]`；`snapshotRef` 指向既有 `narrator_text_snapshots` 中冻结的 `{changes, modelText}`，并登记块资产引用以参与生命周期管理。`buildRuntimeHistory` 调用 `hydrateContextUpdates`，恢复完整 text 与 changes 后才交给 provider 投影；列表读取不展开大正文。旧的全文 text + 内联 changes 双块仍可读取。
- 解码只信任 `sys` 行的结构化元数据，正文只发一次；用户粘贴相同标签不会变成宿主更新。恢复后的 changes 中，`null` 表示移除，空字符串是有效值；持久引用行上的 `changes:[]` 不表示更新为空，须先解析 snapshotRef。
- **历史图片必须恢复字节。** 共享投影按上传者目录读取 `imageId`；读不到时保留序号槽位并记 WARN，不能让后续图片错位。

验证见 [loop-transcript.test.ts](../server/lib/agent/__tests__/loop-transcript.test.ts) 与 [anthropic-wire-legality.test.ts](../server/lib/agent/__tests__/anthropic-wire-legality.test.ts)：覆盖工具结果后更新、后续 user 追加、块编解码恢复和 mocked 出站请求。它们验证本地投影与请求结构，不代表真实上游缓存命中率。

## 请求准备、增量状态与快照生命周期

- 首次请求、后续轮次和重试统一进入 [prepare-prefix-request.ts](../server/services/agent-runtime/prepare-prefix-request.ts)。工具刷新、prompt 构建和权威历史协调沿已有加载串行队列执行；prefix 整条准备链没有固定 10 秒总超时，真实 signal 可取消。每次历史源读取仍有独立查询预算，不能把两者混为一谈。
- [narrator-prefix-state.ts](../server/services/narrator-prefix-state.ts) 复用已归并状态：相同历史源直接复用；追加历史只重放新增的本代 `context_update` 与工具事件。无关普通消息不触发旧更新再次归并；历史修订、compact 边界变化或非追加变更需要重建。请求生命周期内共享已读取的更新载荷，协调与 `hydrateContextUpdates` 不重复读取同一快照；驻留预算影响缓存保留，不是用户总量上限。
- 工具目录采用 manifest：`{format:"narrafork.prefix-tools.v1", definitions:[hash,...]}`，每份静态定义按 hash 独立存储。`putPrefixToolDefinitions` / `getPrefixToolDefinitions` 以定义单元分批读写，复用未变定义与冻结对象，不把每个新目录重新存成整包 schema；旧整包快照仍有兼容读取。见 [narrator-prefix-tool-snapshots.ts](../server/services/narrator-prefix-tool-snapshots.ts)。
- 发布通过 `withPrefixSnapshotPublication` 持有并刷新 publication lease，保护尚未挂上历史引用的根及 manifest 子定义。后台 GC 分批标记已登记资产、兼容历史载荷与 manifest 子引用，只在完整标记后清理过宽限期的无根快照；畸形载荷或失败不按“无引用”继续 sweep。关闭时停止维护、取消并等待相关工作，`close()` 清缓存并等待队列与 worker 退出，不把异步退出当作已经完成。见 [narrator-prefix-snapshots.ts](../server/services/narrator-prefix-snapshots.ts) 与 [narrator-prefix-snapshot-gc.ts](../server/services/narrator-prefix-snapshot-gc.ts)。
- `senders` 是具名上下文部分，冻结同代首次见到的具名 human 用户名（未知名称也冻结为空）；后来改名不改写旧 sender 投影，新出现身份追加进该部分。`projectFrozenSenders` 只投影显示名，不改持久行、身份、role 或 origin。当前实现不应被扩大描述为已冻结所有 agent 标题。见 [sender-context.ts](../server/lib/agent/sender-context.ts)。

## NUG 网关事件与图片去重

- **gateway 事件**：NUG 用自有事件名下发排队状态、配额余额、模型目录与图片缓存确认，在 `shared/agent-protocol/gateway-events.ts` 里解析。`AnthropicProvider` / `OpenAIProvider` 的 SSE 循环有泛化的 gateway 事件短路（走 `isGatewayEventType`），新增事件名无需改动它们。
- **图片去重的形状按 delegate 判定，不按渠道名**：`chat()` 里的 `dedupHistory` 分派用 `delegate instanceof AnthropicProvider` 而非渠道名。按渠道名分派会让某些组合走错形状的遍历器，**找不到任何图片从而静默停用去重**，症状是每轮重传全部图片——看起来像网关问题。

## 用户消息里的图片位置

- composer 投影在图片附件跟在文字之后时，会在原位置写入 `[image #N: 文件名]` / `[file #N: 文件名]`（N 为该类附件的上传序号，从 1 开始）；附件全部在文字前面时不写占位符，保持历史投影。
- 各 provider 的用户 parts 统一经 `server/lib/agent/user-content-order.ts` 的 `orderUserContent` 排列：被占位符点名的图片紧跟在占位符文本之后（占位符兼作官方建议的 `Image N:` 标签），未被点名的图片保持该 provider 原来的位置（Anthropic/Responses 当前轮在前，其余在后）。
- **图片序号必须与占位符对齐。** 历史重建时读不到的图片要留 `null` 槽位，当前轮转 base64 失败时用 `position` 记录原序号；直接丢弃会让后面的图片错位到别的占位符上。

## 会话中加载工具时保持缓存前缀

工具声明与动态上下文统一使用前缀纪元：首次请求建立基线；运行中只有 **compact 成功或实际切换模型目标** 换代。配置变化、cwd/device 切换、工具加载/卸载、registry generation、重启和缓存过期都不换代。显式清空上下文后的首次请求属于重新初始化。

每代冻结 system prompt 与工具定义；description、参数 schema 和参数说明是静态的。目录、设备/模型候选、技能、计划状态、语言和工具可用性由具名 prompt 部分承载，变化先持久化为 `context_update` 再发送。模型向快照不是授权凭据，执行端始终按当前权限、设备和工作目录检查。

`/load` 沿既有加载事件和协议追加，不借工具集合变化重建顶层前缀。加载协议集中在 [tool-loading.ts](../server/lib/agent/tool-loading.ts)，代际协调在 [narrator-epochs.ts](../server/services/narrator-epochs.ts)。这里只保证应用不因环境变化任意回写已发前缀；缓存过期、上游路由和请求参数变化仍可能造成未命中。

**原生能力撤权是明确的协议例外。** Codex 的 hosted `web_search` / `image_generation` 由出站适配器按实时开关附加或删除。当前没有在该通道验证过独立于声明的执行 allow-list，因此禁用时必须移除声明，不能为了缓存继续授予能力。这可能改变顶层 tools 前缀，但不换 epoch/conversationId；冻结的本地函数工具数组不被修改。日志以 `prefixException: "native-capability-policy"` 标明该例外。Anthropic 主会话不声明原生搜索，搜索走独立请求；其他适配器不因此自动获得 hosted 工具。不能宣称所有 provider 在原生能力切换时前缀仍不变。

**请求 JSON 构建。** [request-json.ts](../server/lib/agent/request-json.ts) 对小请求保留原生 `JSON.stringify`；大请求先做有界结构检查，随后协作式遍历并按有界文本/节点包交给独立 worker 转义，不先同步序列化探测体积、不整包 structured-clone。OpenAI 同一次请求的 strip-and-retry 复用未变化的 tools/history 顶层字段片段；不对可变对象做跨请求盲缓存。真实 AbortSignal 可中止本调用，不影响其他调用；请求总量不由这个 helper 拒绝，最终仍需物化 provider 所要求的 body 字符串，上游自己的上下文/API 限制不变。

验收观测（2026-10-30，本地 mock fetch，不调用付费上游）：[provider-request-json.test.ts](../server/lib/agent/__tests__/provider-request-json.test.ts) 使用真实 provider 格式化、历史投影、AbortSignal 与 HTTP body 构建。4 个并发调用方中取消 1 路，其余 3 路完整到达 mock；2000 工具/约 4.8MB 每 body 时测得 398ms、RSS 峰增 114MiB、最大心跳间隔 34ms。显式以 `NF_REQUEST_JSON_STRESS_TOOLS=10000 NF_REQUEST_JSON_STRESS_CHARS=8192` 扩大同一测试，3 条 83.0–83.6MB body 测得 2165ms、RSS 峰增 873MiB、292 次心跳、最大间隔 **267ms**。同日以 `NF_REQUEST_JSON_STRESS_CHARS=8000` 复测，3 条 81.1–81.7MB body 测得 2185ms、RSS 峰增 985MiB、287 次心跳、最大间隔 254ms，说明较小输入也不能保证较小 RSS。这些是单机观测，不是时间/内存保证；最终大字符串物化和协议格式化仍有主线程成本，不能声称完全流式或全程低于 50ms，更不表示上游接受该体积。

**数组与历史怎么分工**
- `managed` 是受会话加载控制的可选工具：能力天花板允许全部工具时，取 `OPTIONAL_TOOLS` 中可用（`isAvailable`）且通过其他过滤（天花板、OAuth、trait 禁用）的那些。`managed` 为空的会话保持旧的请求形态，不带占位工具和 beta。
- 已经在内存里预加载的工具（resident）再 `/load` 时返回 `already_loaded`，不写提示行；否则提示行会把它移出数组。
- `base` 来自本代已发布快照；旧历史没有快照时才用既有倒推兼容路径。resident、预加载、fork 继承和注册表变化不能改写已经发布的基线。
- 顶层工具保持本代基线；新工具按提示行位置送达（deferred 策略沿已有尾部追加规则）。成功 compact 或实际模型切换建立的新基线吸收当时有效状态；恢复旧加载记录使用冻结定义，不从最新 registry 重渲染。
- 卸载只改变执行可用性与提示，不缩小声明数组；Anthropic 也不发 `tool_removal`，同代重新加载已声明工具不重复发送 schema。执行器拒绝未加载的 managed 工具（`config.isToolLoaded`）。
- 显式 `/load` 与自动对账共用 `classifyToolAdditions`：本代策略缺失或为 `replace_tools` 时，只允许重新启用已声明工具，不暗中转成 custom injection。自动发现的未声明工具不发虚假 `tool_loaded`，只在 `tools.availability` 写明限制；无关已可用工具继续工作。显式加载返回协议限制，新的完整声明等待合法 compact/模型切换边界。
- 提示行的 `contentJson[0].toolNames` 记录实际变化的注册表工具名；旧行只有 `toolName`（可能是例程 id），按例程展开。

**既有追加方式**（`replace_tools` 是遗留替换方式，不是同代改写顶层或另起纪元的许可）

| 策略 | 协议 | `tools` 数组 | 加载位置写什么 |
|---|---|---|---|
| `anthropic_tool_addition` | Anthropic Messages | `base` + 末尾一个 `defer_loading` 占位工具 | `role:"system"` 消息：首次声明用 `tool_addition` 内联完整定义；卸载不发 removal、重载不重发 schema；请求头加 `inline-tools-2026-09-15` |
| `anthropic_deferred_tail` | Anthropic Messages | `base` + 占位工具 + 纪元内加载过的工具（`defer_loading`，按首次加载顺序追加在末尾） | `role:"system"` 消息：`tool_addition` 按名引用；不发 `tool_removal`（已知端点只读 addition）；请求头加 `mid-conversation-tool-changes-2026-07-01` |
| `openai_additional_tools` | OpenAI Responses | `base` | 提示行之前插入一项 `{type:"additional_tools", role:"developer", tools}`；每个工具每纪元只声明一次；卸载只靠文本 |
| `kimi_system_tools` | Chat Completions | `base` | 提示行之前插入一条 `{role:"system", tools}`，`tools` 与顶层 `tools` 同格式、带完整定义；每个工具每纪元只声明一次；卸载只靠文本 |
| `custom_injection` | 任意 | `base` | 提示行文本末尾追加 `<tool_definitions>` JSON schema；每个工具每纪元只追加一次 |

**选择规则**
- 模型卡字段 `tool_loading_modes`（按优先级排列）优先；未声明时按裸模型名取默认值：含 `claude` → `anthropic_tool_addition`（Opus 4.8+、Sonnet/Haiku 5.5+、Fable/Mythos；更早的版本不启用），含 `gpt` → `openai_additional_tools`（OpenAI API 需 5.4+，Codex 后端需 5.6+；开源权重的 `gpt-oss` 按"其他"处理），含 `deepseek` → `anthropic_deferred_tail`，Kimi K3+（`kimi-k3*`、Kimi Coding 的 `k3`/`k3-256k`）与 `kimi-for-coding` → `kimi_system_tools`、`custom_injection`（K2.x 与 `kimi-for-coding-highspeed` 会以 400 拒绝带 `tools` 的 system 消息，只用 `custom_injection`；经 Anthropic/Responses 协议访问时落到 `custom_injection`），其他 → `custom_injection`。解析不出版本号的照常启用。
- 取列表里第一个与适配器 `toolLoadingTarget()` 报告的协议相容的方式，都不相容就用 `replace_tools`。NUG 按渠道类型报告协议，并用路由后的模型名匹配默认值。
- 因此新增 Kimi 供应商时默认创建为 Chat Completions 协议（预设字段 `creationProtocol`，见 `frontend/components/providers/provider-connection-presets.ts`），只有这条路径能给出 `kimi_system_tools`。Anthropic/Responses 仍可在协议下拉里手选，届时按上一条落到 `custom_injection`。
- 设为空列表 `[]` 即对该模型关闭，在设置页模型卡里编辑。

**几处容易出错的地方**
- Anthropic 的系统消息只能紧跟 user 轮，且后面只能是 assistant 轮或数组末尾。构造器把工具变更放在提示行旁边，由 `ensureAlternating` 统一挪到下一个 assistant 之前；兼容端点的 system 降级为 user 时，带工具变更的消息不降级。
- 尾部提示行直接保留在统一历史投影中；工具变更跟随同一条记录，避免实时路径和重建路径各放一次。
- `custom_injection` 在共享历史构建阶段把冻结 schema 追加到提示文本；原生方式由 `toolLoadingChangeOf(row)` 进入 neutral item，再由适配器放置。
- plan mode 或配置变化可以刷新执行状态，但不换代、不重写描述；工具定义的首次发布字节保持固定。同名不兼容定义不能靠 registry generation 自动换代掩盖，应按实际不可用/参数错误处理，下一合法边界再吸收新定义。
