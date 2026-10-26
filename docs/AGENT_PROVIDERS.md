# Agent Provider 注意事项

## Anthropic 历史构造的两处易错点

`buildAnthropicHistory`（`server/lib/agent/anthropic-provider.ts`）有两处做错了不会报错、只会静默降低质量的地方：

1. **尾部 `sys` 行必须提到当前轮**（`trailingUserText`）。Dynamic Spec 提醒、目标续跑这类注入若留在历史末尾，模型会当作背景而非「刚被问到的事」。做错**只表现为模型重视程度下降**，没有任何错误信号。
   **只在 `officialApi: false` 时提取**：官方 API 路径把 `sys` 映射为 `role:"system"`（Claude Code 的刻意行为，本身已表达「常驻指令」），不可改写。

2. **历史图片的 `imageId` 必须从磁盘还原。** 存储的消息只有 imageId，字节在上传者的目录下。该函数原本只读 text 块，**历史里的图片全部丢失**——追问一张早前的截图时，模型收到的请求里什么都没有（`openai-provider.ts` 是另一条做对了的路径）。
   失败一律跳过并记 WARN（文件被清理、读不出、owner 未知）：丢一张图不好，但为一张被清理的旧图让整轮失败更糟。

## NUG 网关事件与图片去重

- **gateway 事件**：NUG 用自有事件名下发排队状态、配额余额、模型目录与图片缓存确认，在 `shared/agent-protocol/gateway-events.ts` 里解析。`AnthropicProvider` / `OpenAIProvider` 的 SSE 循环有泛化的 gateway 事件短路（走 `isGatewayEventType`），新增事件名无需改动它们。
- **图片去重的形状按 delegate 判定，不按渠道名**：`chat()` 里的 `dedupHistory` 分派用 `delegate instanceof AnthropicProvider` 而非渠道名。按渠道名分派会让某些组合走错形状的遍历器，**找不到任何图片从而静默停用去重**，症状是每轮重传全部图片——看起来像网关问题。

## 用户消息里的图片位置

- composer 投影在图片附件跟在文字之后时，会在原位置写入 `[image #N: 文件名]` / `[file #N: 文件名]`（N 为该类附件的上传序号，从 1 开始）；附件全部在文字前面时不写占位符，保持历史投影。
- 各 provider 的用户 parts 统一经 `server/lib/agent/user-content-order.ts` 的 `orderUserContent` 排列：被占位符点名的图片紧跟在占位符文本之后（占位符兼作官方建议的 `Image N:` 标签），未被点名的图片保持该 provider 原来的位置（Anthropic/Responses 当前轮在前，其余在后）。
- **图片序号必须与占位符对齐。** 历史重建时读不到的图片要留 `null` 槽位，当前轮转 base64 失败时用 `position` 记录原序号；直接丢弃会让后面的图片错位到别的占位符上。

## 会话中加载工具时保持缓存前缀

`/load` 以前直接改请求的 `tools` 数组。`tools` 位于各家缓存前缀的最前面，所以每次加载都会让整个会话的 prompt cache 失效。现在在一个上下文纪元（最近一次 compact 之后的可见历史）内，`tools` 数组保持不变，加载在历史里按目标协议送达。实现集中在 `server/lib/agent/tool-loading.ts`。

**数组与历史怎么分工**
- `managed` 是受会话加载控制的可选工具：能力天花板允许全部工具时，取 `OPTIONAL_TOOLS` 中可用（`isAvailable`）且通过其他过滤（天花板、OAuth、trait 禁用）的那些。`managed` 为空的会话保持旧的请求形态，不带占位工具和 beta。
- 已经在内存里预加载的工具（resident）再 `/load` 时返回 `already_loaded`，不写提示行；否则提示行会把它移出数组。
- 从当前已加载集合出发，把可见历史里的加载/卸载提示行倒放，得到纪元开始时已加载的集合（`base`）。resident 预加载、创建时预加载、fork 继承的工具没有提示行，自然落在 `base` 里。
- `tools` 数组只放非 managed 工具和 `base`；纪元内加载的工具在其提示行的位置送达。compact 之后可见历史变了，`base` 随之吸收之前的加载。
- 卸载不缩小数组，执行器拒绝调用未加载的 managed 工具（`config.isToolLoaded`）。
- 提示行的 `contentJson[0].toolNames` 记录实际变化的注册表工具名；旧行只有 `toolName`（可能是例程 id），按例程展开。

**五种保持前缀的方式**（策略 5 `replace_tools` 即旧行为）

| 策略 | 协议 | `tools` 数组 | 加载位置写什么 |
|---|---|---|---|
| `anthropic_tool_addition` | Anthropic Messages | `base` + 末尾一个 `defer_loading` 占位工具 | `role:"system"` 消息：`tool_addition` 内联完整定义；卸载发 `tool_removal`；请求头加 `inline-tools-2026-09-15` |
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
- 提示行本身是当前轮（被构造器弹出）时，变更仍要进入请求：Anthropic 放在历史末尾，Responses 与 Kimi 放在当前轮之前，与之后重建时的位置一致。
- `custom_injection` 的文本改写在 `buildRuntimeHistory` 里做，这样从历史恢复的当前轮文本和接收方守卫看到的字节都带 schema；原生方式在 `buildHistory` 的最后一步按行打标，构造器通过 `toolLoadingChangeOf(row)` 读取。
- 历史重建（compact、plan mode 切换）会返回新的加载状态，loop 据此重新格式化 `tools`；换模型时按新适配器重新选择策略。
