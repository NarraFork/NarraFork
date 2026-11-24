---
id: agent.providers
title: 模型提供商
summary: 各模型提供商的总览：适配器接口、来源注册与解析、四个下级节点（适配器、Codex、网关类、设置页）如何配合。
anchors:
  - server/lib/agent/provider.ts
  - server/lib/agent/provider-source-registry.ts
  - shared/provider-readiness.ts
keywords:
  - 提供商
  - provider_not_configured
  - PROVIDER_NOT_FOUND
  - PROVIDER_UNAVAILABLE
  - PROVIDER_CONFIG_INVALID
  - resolveProviderAndModel
  - ProviderSourceRegistry
  - registerCredentialProviderSource
  - PooledProvider
  - modelProtocols
  - tutorial
status: draft
verified_at: 776dbf07e
---
# 模型提供商

每个提供商实现 `ProviderAdapter`（`server/lib/agent/provider.ts`）：流式 `chat`、`buildHistory`、`formatTools`、`injectSystemPrompt`、`generate` 等。Agent Loop 只面向这个接口，不知道背后是哪家上游。本节是总览：来源怎么注册、模型 ID 怎么解析到适配器；具体适配器、协议细节和设置页在下级。

## 由哪几部分组成
- 来源与解析（本节）：`resolveProviderAndModel` 与 `ProviderSourceRegistry`。
- 通用适配器：Anthropic / OpenAI / Gemini 及其历史构造、协议切换、上游拒绝降级，在 [适配器与历史构造](adapters.md)。
- Codex：独立的 Responses WebSocket 适配器，在 [Codex](codex.md)。
- 网关类：NUG、TokenDance、CommandCode、OpenCode，委托通用适配器并经网关出站，在 [网关类提供商](gateways.md)。
- 设置页与路由：添加连接、模型列表缓存、本机导入，在 [设置页与路由](settings-ui.md)。

## 关键规则
- 模型 ID 形如 `prefix:model`，`resolveProviderAndModel` 先查内置来源（`ProviderSourceRegistry`，路由与就绪状态必须一起注册），内置都不接受时才查插件提供的外部来源，因此插件不能抢占内置前缀；都没有则抛出 “provider is not configured”（`provider.ts`）。前缀 `tutorial` 已退役，直接报错。
- 内置来源：tokendance、codex、CommandCode，以及 anthropic / nug / openai / gemini 四族按配置实例化的 API 连接（`registerCredentialProviderSource`）。
- 多密钥连接包 `PooledProvider`，单密钥直连（判定分支见 [凭证池与存储](../credentials.md)）。
- 引用模型却解析不出提供商时是不可重试的注册表错误，与瞬时上游失败区分，见适配器节点。
- 适配器族与委托关系：`AnthropicProvider`、`OpenAIProvider`、`GeminiProvider`/`GeminiInteractionsProvider`、`CodexProvider`、`NugProvider`（委托 Anthropic/OpenAI）、`TokenDanceProvider`（按所选协议委托）、CommandCode（按模型选 Anthropic 或 OpenAI 适配器）。
- 就绪状态的共享投影在 `shared/provider-readiness.ts`，设置页据此显示状态。

## 该读哪个下级
- 历史怎么构造、图片/媒体怎么降级、拒绝某个参数后怎么办、协议怎么切换、快速模式：[适配器与历史构造](adapters.md)。
- Codex 请求头、WebSocket、换号重试：[Codex](codex.md)。
- NUG 图片去重与出口中继、TokenDance 恢复动作、CommandCode 凭据、OpenCode 会话头：[网关类提供商](gateways.md)。
- 设置页组件分工、模型列表路由、本机导入：[设置页与路由](settings-ui.md)。
- 模型卡、上下文窗口、`auto:` 路由：[模型目录与来源](../model-catalog/index.md)。

## 从哪读起
- `server/lib/agent/provider.ts`：接口、来源注册、解析。
- `server/lib/agent/provider-source-registry.ts`：来源注册表。
- 测试：`agent/__tests__/provider-resolution.test.ts`、`provider-source-registry.test.ts`、`provider-source-readiness.test.ts`。
- 未核实：`docs/AGENT_PROVIDERS.md` 中的细节未逐条对照，本节未采用。

## 改它时
- 加一种提供商来源：在 `provider.ts` 注册来源时路由与就绪状态必须一起注册（`provider-source-registry.ts`，`provider-source-registry.test.ts`、`provider-source-readiness.test.ts` 会拦），前缀不得与内置前缀冲突，`tutorial` 已退役；再补 `shared/provider-readiness.ts` 的投影与前端 `provider-catalog.ts`、对应设置区块。
- 改完整个提供商面（适配器、降级、设置页）后，按下级节点各自的「改它时」回归。

## 相关
- [Agent Loop](../loop.md)
- [凭证池与存储](../credentials.md)
- [供应商余额与额度](../provider-quota.md)

## 下面有什么

- [适配器与历史构造](adapters.md)：适配器接口与解析、Anthropic / OpenAI / Gemini 适配器、历史与图片构造、协议切换、降级、快速模式。
- [Codex](codex.md)：Codex 提供商：请求身份头、Responses WebSocket、换号重试、图片生成错误。
- [网关类提供商](gateways.md)：NUG、TokenDance、CommandCode、OpenCode 等经网关或中转接入的提供商。
- [设置页与路由](settings-ui.md)：提供商设置页、各提供商路由、导入与连接测试。
