---
id: agent.providers
title: 模型提供商
summary: Anthropic / OpenAI / Gemini / Codex / NUG 等适配，历史构造与图片处理差异。
anchors:
  - server/lib/agent/provider.ts
  - server/lib/agent/provider-source-registry.ts
  - server/lib/agent/anthropic-provider.ts
  - server/lib/agent/openai-provider.ts
  - server/lib/agent/gemini-provider.ts
  - server/lib/agent/gemini-interactions-provider.ts
  - server/lib/agent/codex-provider.ts
  - server/lib/agent/codex-websocket.ts
  - server/lib/agent/nug-provider.ts
  - server/lib/agent/nug-image-dedup.ts
  - server/lib/agent/tokendance-provider.ts
  - server/lib/agent/commandcode-provider.ts
  - server/lib/agent/native-media.ts
  - shared/tool-result-images.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 模型提供商

每个提供商实现 `ProviderAdapter`（`provider.ts`）：`formatTools`、`buildHistory`（DB 行转为该协议的历史）、`injectSystemPrompt`、流式 `chat`（产出 `ParsedStreamEvent`）、`generate`，以及可选的图片生成、工具加载目标等。循环只面向这个接口。

## 关键规则
- 模型 ID 形如 `prefix:model`，`resolveProviderAndModel` 先查内置来源（`ProviderSourceRegistry`，路由与就绪状态必须一起注册），内置都不接受时才查插件提供的外部来源，因此插件不能抢占内置前缀；都没有则抛出“provider is not configured”（`provider.ts`）。前缀 `tutorial` 已退役，直接报错。
- 内置来源：tokendance、codex、CommandCode，以及 anthropic / nug / openai / gemini 四族按配置实例化的 API 连接（`registerCredentialProviderSource`）。
- 适配器族：`AnthropicProvider`；`OpenAIProvider`（`apiMode` 为 responses / completions / codex，缺省 responses，旧的 `responsesApi:false` 映射为 completions）；`GeminiProvider` 与 `GeminiInteractionsProvider`（`createGeminiProvider` 按 `geminiTransport === "interactions"` 选择）；`CodexProvider`；`NugProvider`（内部委托 Anthropic/OpenAI 并走 NUG 网关）；`TokenDanceProvider`（按所选协议委托 Anthropic/Gemini/OpenAI）；CommandCode 不写新适配器，按模型选 Anthropic 或 OpenAI 适配器。
- 逐模型协议覆盖：`resolveModelProtocol` 与连接本身协议不符时换一族适配器并沿用代理等连接字段；构造失败则记录警告并回退到提供商默认适配器。
- Codex：`useWebSocket` 缺省 true，`useWebSearch`、`useImageGeneration` 缺省 true，取自 `settings.codex`（`provider.ts` 的 codex 来源）。WebSocket 传输在 `codex-websocket.ts`。
- 多密钥连接包 `PooledProvider`，单密钥直连（见 [凭证池](credentials-models.md)）。
- 历史构造差异：共享的模型侧投影在 `history-build.ts`；各适配器的 `buildHistory` 再做自己的线格式。工具结果里的图片：OpenAI Chat Completions 按 `toolResultImages` 配置 `off`（默认）/ `inline` / `separate` 三种形状（`shared/tool-result-images.ts`，`openai-provider.ts` 的 `expandChatToolResults`）。
- 原生媒体（音视频等）：适配器不支持时，`projectUnsupportedNativeMediaForModel` 在历史里降级并产生警告；`rejectNativeMedia` 对不支持的协议直接抛错，提示选择 Gemini 等（`native-media.ts`）。
- NUG 图片去重：每张图带内容哈希 `imageRef`，网关确认缓存后才去掉内联数据只发引用，请求结束（成败皆然）必须还原；网关 409 缓存未命中则丢弃该确认并内联重发（`nug-image-dedup.ts`）。该逻辑只在 NUG 路径使用。
- 工具加载策略依赖适配器报告的线协议（`toolLoadingTarget`），见 [工具体系](tools/index.md)。

## 从哪读起
- `server/lib/agent/provider.ts`：接口、来源注册、解析。
- `server/lib/agent/__tests__/`：按提供商分的测试（`anthropic-*`、`codex-*`、`gemini-provider`、`nug-*`、`openai-*`）。
- 未核实：`docs/AGENT_PROVIDERS.md` 中的细节未逐条对照，本节未采用。

## 相关
- [Agent Loop](loop.md)
- [凭证池与模型目录](credentials-models.md)
