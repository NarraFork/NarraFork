---
id: agent.providers.adapters
title: 适配器与历史构造
summary: provider.ts 的适配器接口与解析、Anthropic / OpenAI / Gemini 适配器、历史与图片构造、逐模型协议切换、上游拒绝降级、快速模式。
anchors:
  - server/lib/agent/anthropic-provider.ts
  - server/lib/agent/anthropic-api-version.ts
  - server/lib/agent/openai-provider.ts
  - server/lib/agent/openai-refusal.ts
  - server/lib/agent/sse-frames.ts
  - server/lib/agent/gemini-provider.ts
  - server/lib/agent/gemini-interactions-provider.ts
  - server/lib/agent/gemini-media-files.ts
  - server/lib/agent/gemini-tool-schema.ts
  - server/lib/agent/native-media.ts
  - server/lib/agent/attachment-projection.ts
  - server/lib/agent/projection/
  - shared/agent-protocol/
  - shared/tool-result-images.ts
  - server/lib/agent/protocol-override.ts
  - server/lib/agent/switchable-protocols.ts
  - server/lib/agent/provider-transport.ts
  - server/lib/agent/reasoning-mandatory-fallback.ts
  - server/lib/agent/reasoning-source.ts
  - server/lib/agent/response-body.ts
  - server/lib/agent/response-format.ts
  - server/lib/agent/structured-output-fallback.ts
  - server/lib/agent/tool-schema-compat.ts
  - server/lib/agent/unsupported-parameter-fallback.ts
  - server/lib/agent/user-content-order.ts
  - shared/reasoning-credentials.ts
  - shared/reasoning-effort-support.ts
  - shared/reasoning-effort.ts
  - server/lib/fast-mode.ts
  - server/lib/provider-availability-error.ts
  - server/lib/fingerprint.ts
  - server/lib/user-agent.ts
  - frontend/hooks/useFastModeUpdates.ts
keywords:
  - ProviderAdapter
  - buildHistory
  - formatTools
  - injectSystemPrompt
  - AnthropicProvider
  - OpenAIProvider
  - GeminiProvider
  - GeminiInteractionsProvider
  - apiMode
  - responsesApi
  - geminiTransport
  - toolResultImages
  - NonJsonResponseError
  - switchableModelProtocols
  - fastModeOverride
  - reasoning is mandatory
  - 协议覆盖
  - 结构化输出降级
  - 工具 schema 展平
  - 原生媒体
  - 快速模式
status: draft
verified_at: 15eb583b4a5b86d11cfc8037afcae4065e3a812b
---
# 适配器与历史构造

每个提供商实现 `ProviderAdapter`（`server/lib/agent/provider.ts`）：`formatTools`、`buildHistory`（DB 行转为该协议的历史）、`injectSystemPrompt`、流式 `chat`（产出 `ParsedStreamEvent`）、`generate`，以及可选的图片生成、工具加载目标等。循环只面向这个接口。本节讲通用的三大协议适配器与它们共享的历史构造、协议切换、降级；Codex 与网关类各有单独节点。

本次相关实现以已同步主线 `15eb583b4a5b86d11cfc8037afcae4065e3a812b` 为核对基线；`verified_at` 记录该真实基线，以下说明对应合并后的实现。

## 关键规则
- 显式 UA 优先级：非空 `extraHeaders` 的 User-Agent（不区分大小写）优先于已选择的 UA 模式，未选择或空 custom 回到协议默认值。`mergeExtraHeaders` 对所有头去重，后一个非空值覆盖，空值不删除默认；UA 还会 trim 与清洗。动态头和 transport 钩子执行后，最终 `next()` 发送及钩子重试仍重新钉住显式 UA；其他传输专用字段继续由传输层控制（`user-agent.ts`、`provider-transport.ts`）。
- 托管指纹版本当前为 Claude CLI `2.1.330`、Codex CLI `0.171.0`；Anthropic CLI 形状的 Stainless package 为 `0.128.0`，runtime version 取 `process.version`。这些是代码内固定身份值，不代表完整复刻官方客户端；`mid-conversation-system` 旧 beta 不再发送，原有模型角色能力门仍生效。
- Anthropic 未选 `officialApi`（该开关选择 Claude Code 方言）且 base URL 是 `https://api.anthropic.com` 根或 `/v1` 时，默认版本为 `2026-10-21`。
- Anthropic 中转地址或 `officialApi` 方言默认保持 `2023-06-01`；显式非空 `anthropic-version` 覆盖默认，空覆盖不能清 pin。Messages、辅助生成、原生搜索和模型目录共用版本决策（`anthropic-api-version.ts`）。
- 有效版本为 `2026-10-21` 时，正文不添加采样参数；按实际线上角色移除 user text 的非空 citations（含 tool_result、search_result 与 content document 的文本），直接 assistant document 在发请求前报错。不会递归修改任意工具 input 或 JSON 数据，调用者可复用的历史保留原样；旧版本保留既有行为。
- 普通 Responses 将非空字符串 system/developer 指令作为可缓存的 developer `input_text` 前缀，不放 root instructions；已有 typed developer 和 `additional_tools` 输入保持顺序。Codex 使用独立的稳定 ID 前缀构造，见 [Codex](codex.md)。
- Responses 文本按原生 item/part 保存 `itemId`、`contentIndex`、`phase`；晚到元数据可修订已有文本块，历史重放保留这些边界。响应 id 不冒充 item id，phase 不作为流或逻辑轮次完成信号。
- 结构化拒绝只认 Chat 的 `refusal` 和 Responses 原生 refusal 字段/事件，普通文字及工具参数不推断为拒绝。每次请求尝试有独立累积器，按 item/part 去重，最多 64 段、64 Ki 字符并显式标截断；用量先交付，再发一次不可重试/不可恢复的 `refusal`。已见拒绝后不再发新文本或完成待执行工具；真实 API 错误及用户取消仍保留自身语义（`openai-refusal.ts`）。
- SSE 共用 `readSseFrames`：支持 LF/CRLF/CR、流首 BOM、跨 chunk UTF-8、多行 data 与 EOF 尾帧；仅相邻 data 都能独立解析为完整 JSON 或 `[DONE]` 时兼容旧网关缺空行。单行/事件最多 32 MiB，按 64 KiB 扫描、每 1 MiB 让出事件循环；消费者提前结束或出错会取消 reader，正常 EOF 仅释放锁。
- 普通 Responses 在 `response.completed` 后结束，Chat 在 `[DONE]` 后结束；只有 NUG 的 OpenAI 委托开启 `drainUntilEof` 继续读取计费尾部，Anthropic 仍读到 EOF。完成前断流不把半截 Responses 工具参数补成可执行调用。
- Chat 工具流必须同时取得 id 与 name 才公开参数；先到的参数有界缓存，已确立身份变化、跨 index 重用 id、无身份结束返回 `invalid_tool_call`。正常原生完成可结束空参数调用，截断/过滤或 EOF 不把缺失参数自动当 `{}`。
- Anthropic 工具 start 的 input 快照仅在没有任何 delta 且取得正常完成信号时使用；任意 input_json_delta 都取代快照。只有 start 后断流返回 `incomplete_tool_input`，不会执行占位快照。
- 适配器族：`AnthropicProvider`；`OpenAIProvider`（`apiMode` 为 responses / completions / codex，缺省 responses，旧的 `responsesApi:false` 映射为 completions）；`GeminiProvider` 与 `GeminiInteractionsProvider`（`createGeminiProvider` 按 `geminiTransport === "interactions"` 选择）。
- 逐模型协议覆盖：`resolveModelProtocol` 与连接本身协议不符时换一族适配器并沿用代理等连接字段；构造失败则记录警告并回退到提供商默认适配器。
- 历史构造差异：共享的模型侧投影在 `projection/`（存储行解码、图片字节预取、可见块与顺序，另见 `history-build.ts`）；各适配器的 `buildHistory` 再做自己的线格式。
- 工具结果里的图片：OpenAI Chat Completions 按 `toolResultImages` 配置 `off`（默认）/ `inline` / `separate` 三种形状（`shared/tool-result-images.ts`，`openai-provider.ts` 的 `expandChatToolResults`）。
- 原生媒体（音视频等）：适配器不支持时，`projectUnsupportedNativeMediaForModel` 在历史里降级并产生警告；`rejectNativeMedia` 对不支持的协议直接抛错，提示选择 Gemini 等（`native-media.ts`）。
- 工具加载策略依赖适配器报告的线协议（`toolLoadingTarget`），见 [工具体系](../tools/index.md)。
- 逐模型协议切换：可选协议集合由 `switchable-protocols.ts:switchableModelProtocols` 给出，每个分支一行：
  - tokendance：取目录里该模型声明支持的协议。
  - CommandCode：除 `gemini-compatible` 外的全部协议。
  - 自定义的 Anthropic / OpenAI / Gemini 连接：全部协议。
  - 其他（NUG 按网关渠道路由、Codex 与插件提供商只有一种线协议）：空，不可切换。
  - 换适配器时代理、指纹、额外头、官方 API 标志留在连接上；选中协议与连接原适配器一致时不重建（`protocol-override.ts`）。
- 上游拒绝时的降级，都是进程内、重启即忘（故意不落盘，避免上游已放开后仍被压制）：
  - 拒绝 `reasoningEffort: "none"`（"Reasoning is mandatory"）：去掉推理偏好重发，不替换成某个档位（`reasoning-mandatory-fallback.ts`）。
  - 拒绝可省略的请求字段（如 `prompt_cache_key`）：只在当前正文实际拥有该字段时剥除并有界重试，记忆表有上限。`max_tokens`、`max_completion_tokens`、`max_output_tokens` 是输出预算，绝不学习删除或以无上限正文重试；refusal 中引用的报错文字也不会触发参数学习（`unsupported-parameter-fallback.ts`）。
  - 中转站忽略或拒绝 JSON-Schema 输出约束：按模型记住并降级，原生结构化输出仍是首选（`structured-output-fallback.ts`）。
  - 顶层联合类型的工具 schema 在提供商边界处展平，嵌套组合保持；展平会丢失属性间关联，不支持的约束只留诊断不猜测（`tool-schema-compat.ts`）；Gemini 另有 schema 清洗（`gemini-tool-schema.ts`）。
- 响应体：非 JSON 响应（如 2xx 下的 HTML 挑战页）抛 `NonJsonResponseError`，JSON 上限 2MB、预览 4000 字符（`response-body.ts`）；用户内容里图片占位符 `[image #N: name]` 之后紧跟对应图片（`user-content-order.ts`）。
- Anthropic 请求的 3 字符归因指纹在 `server/lib/fingerprint.ts`，UA 与 originator 在 `user-agent.ts`。
- 快速模式（priority service tier）：`narrators.fastModeOverride` 为准，`inherit` 时请求时刻再取用户默认（`getUserFastModeDefault` 在读 Worker 上读 `user_preferences`，`worker-required`），`on`/`off` 钉死；旧布尔列只是镜像（`server/lib/fast-mode.ts`）。
- 引用模型却解析不出提供商时（PROVIDER_NOT_FOUND / PROVIDER_UNAVAILABLE / PROVIDER_CONFIG_INVALID）是不可重试的注册表错误，与瞬时上游失败区分（`provider-availability-error.ts`）。

## 从哪读起
- `server/lib/agent/provider.ts`：接口与适配器工厂（来源注册与解析见 [模型提供商](index.md)）。
- `server/lib/agent/projection/`：所有适配器共用的历史第一段投影，各适配器的 `buildHistory` 只做线格式。
- `shared/agent-protocol/`：协议层与宿主共享的类型与诊断（插件也可复用，不得依赖 `server/`）。
- 测试：`agent/__tests__/` 下 `anthropic-*`、`openai-*`、`gemini-provider`、`protocol-override`、`*-fallback`、`provider-images`、`native-media-provider`。

## 改它时
- 改某个适配器的 `buildHistory` 或线格式：先对照 `projection/` 的共享投影，按提供商对应的 `*-provider-history.test.ts`、`provider-images.test.ts`、`provider-content-boundaries.test.ts` 回归。
- 改版本、请求头或传输重试：`anthropic-api-version.test.ts`、`user-agent-egress.test.ts` 与 `provider-request-json.test.ts` 覆盖最终线上请求；SSE 边界与拒绝终态分别由 `sse-frames.test.ts`、`openai-refusal.test.ts` 守护，工具流另看 `provider-tool-input-stream.test.ts`。
- 新增上游拒绝降级时沿用「进程内记忆、不落盘、有上限」的写法，别把学到的限制写进设置；对应加 `*-fallback.test.ts`。
- 改可切换协议集合：同步 `switchable-protocols.ts` 与 `protocol-override.ts`，由 `protocol-override.test.ts` 守着；前端选择器 `ModelProtocolSelect` 见 [模型目录与来源](../model-catalog/sourcing.md)。
- 改工具 schema 展平或结构化输出降级：`tool-schema-compat.test.ts`、`structured-output-fallback.test.ts`、`response-format-providers.test.ts`、`provider-tool-schema.test.ts`。
- 改原生媒体降级：`native-media-provider.test.ts`、`loop-native-media.test.ts`。
- `shared/agent-protocol/` 不得引入 `server/` 依赖，插件会复用它。

## 相关
- [模型提供商](index.md)
- [Codex](codex.md)
- [网关类提供商](gateways.md)
