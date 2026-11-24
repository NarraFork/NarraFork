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
  - frontend/components/providers/AddProviderPage.tsx
  - frontend/components/providers/AnthropicProvidersSection.tsx
  - frontend/components/providers/ClientFingerprintFields.tsx
  - frontend/components/providers/CodexSection.tsx
  - frontend/components/providers/CommandCodeSection.tsx
  - frontend/components/providers/CustomApiProviderSection.tsx
  - frontend/components/providers/GeminiSection.tsx
  - frontend/components/providers/LocalProviderImport.tsx
  - frontend/components/providers/NUGProvidersSection.tsx
  - frontend/components/providers/OpenAIProvidersSection.tsx
  - frontend/components/providers/PluginProviderSection.tsx
  - frontend/components/providers/ProviderBalanceStatus.tsx
  - frontend/components/providers/ProviderCard.tsx
  - frontend/components/providers/ProviderConfigView.tsx
  - frontend/components/providers/ProviderDetailPanel.tsx
  - frontend/components/providers/ProviderOverviewView.tsx
  - frontend/components/providers/ProviderStatusBadge.tsx
  - frontend/components/providers/TokenDanceSection.tsx
  - frontend/components/providers/codex-browser-auth-state.ts
  - frontend/components/providers/provider-add-context.ts
  - frontend/components/providers/provider-add-draft.ts
  - frontend/components/providers/provider-catalog.ts
  - frontend/components/providers/provider-create-flow.ts
  - frontend/components/providers/provider-settings-rebase.ts
  - frontend/components/providers/provider-settings-save.ts
  - frontend/components/providers/providers-reducer.ts
  - frontend/components/providers/tokendance-flow.ts
  - frontend/components/providers/types.ts
  - frontend/components/settings/ProviderBaseUrlFixHost.tsx
  - frontend/components/settings/TokenDanceRechargeDialog.tsx
  - frontend/components/settings/TokenDanceRecoveryHost.tsx
  - frontend/hooks/useFastModeUpdates.ts
  - server/lib/agent/attachment-projection.ts
  - server/lib/agent/codex-errors.ts
  - server/lib/agent/codex-request.ts
  - server/lib/agent/gateway-events.ts
  - server/lib/agent/gemini-media-files.ts
  - server/lib/agent/gemini-tool-schema.ts
  - server/lib/agent/nug-delegate-config.ts
  - server/lib/agent/opencode-session.ts
  - server/lib/agent/projection/
  - server/lib/agent/protocol-override.ts
  - server/lib/agent/provider-transport.ts
  - server/lib/agent/reasoning-mandatory-fallback.ts
  - server/lib/agent/reasoning-source.ts
  - server/lib/agent/response-body.ts
  - server/lib/agent/response-format.ts
  - server/lib/agent/session-affinity.ts
  - server/lib/agent/structured-output-fallback.ts
  - server/lib/agent/switchable-protocols.ts
  - server/lib/agent/tool-schema-compat.ts
  - server/lib/agent/unsupported-parameter-fallback.ts
  - server/lib/agent/user-content-order.ts
  - server/lib/codex-network.ts
  - server/lib/commandcode-models.ts
  - server/lib/commandcode-protocol.ts
  - server/lib/fingerprint.ts
  - server/lib/nug-relay/
  - server/lib/tokendance-runtime.ts
  - server/lib/user-agent.ts
  - server/routes/anthropic.ts
  - server/routes/gemini.ts
  - server/routes/openai.ts
  - server/routes/provider-import.ts
  - server/services/codex-image-generation-fix.ts
  - server/services/local-provider-import.ts
  - shared/agent-protocol/
  - shared/codex-image-generation-error.ts
  - shared/local-provider-import.ts
  - shared/opencode-go-endpoint.ts
  - shared/provider-readiness.ts
  - shared/reasoning-credentials.ts
  - shared/reasoning-effort-support.ts
  - shared/reasoning-effort.ts
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
- 多密钥连接包 `PooledProvider`，单密钥直连（见 [凭证池](credentials.md)）。
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
- [凭证池与模型目录](credentials.md)
