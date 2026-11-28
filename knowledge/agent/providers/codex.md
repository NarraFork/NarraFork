---
id: agent.providers.codex
title: Codex
summary: Codex 提供商：请求身份头、Responses WebSocket 传输、额度故障转移的重建重试、图片生成错误、设置页区块。
anchors:
  - server/lib/agent/codex-provider.ts
  - server/lib/agent/codex-websocket.ts
  - server/lib/agent/codex-errors.ts
  - server/lib/agent/codex-request.ts
  - server/lib/agent/codex-turn-state.ts
  - server/services/codex-image-generation-fix.ts
  - shared/codex-image-generation-error.ts
  - frontend/components/providers/CodexSection.tsx
  - frontend/components/providers/codex-browser-auth-state.ts
keywords:
  - CodexProvider
  - Codex WebSocket
  - useWebSocket
  - useWebSearch
  - useImageGeneration
  - settings.codex
  - x-codex-window-id
  - x-codex-installation-id
  - CodexRebuildHistoryRetryError
  - Responses WebSocket
  - 图片生成错误
  - 浏览器授权
  - codex-websocket
status: draft
verified_at: 15eb583b4a5b86d11cfc8037afcae4065e3a812b
---
# Codex

Codex 是内置来源之一（`provider.ts` 的 codex 来源），适配器为 `CodexProvider`，走 OpenAI Responses 线协议；账号、额度与换号在 [凭证池与存储](../credentials.md)。

## 关键规则
- 配置：`useWebSocket` 缺省 true，`useWebSearch`、`useImageGeneration` 缺省 true，取自 `settings.codex`（`provider.ts` 的 codex 来源）。
- 传输：WebSocket 传输在 `codex-websocket.ts`；`useWebSocket` 关闭时走 HTTP。
- 请求身份：`x-codex-window-id` 由会话 id 确定性派生；`x-codex-installation-id` 仅放正文 `client_metadata`，不作直接请求头。有显式逻辑轮次时携带 `turn_id`；同轮工具续写和恢复共用该身份，新输入或认证归属变化不沿用旧路由 token。
- 指令前缀：HTTP、WS 和辅助请求共用 `applyCodexStableRequestFields`，只把非空基础指令放入 developer `input_text` 前缀，id 由会话和指令内容的哈希稳定生成；同轮重建替换原前缀，不添加重复项，空指令不生成默认消息。typed developer 与 `additional_tools` 保留在原输入序列；顶层 tools、`parallel_tool_calls: true` 保持非 Lite 形状，不声明未实现的 Responses Lite 头。
- `ProviderTurnContext` 是内存对象，`codex-turn-state.ts` 以 WeakMap 持有其路由锁。首个非空服务端 token 固定本轮；HTTP 从响应头及 metadata 事件捕获并在续写请求头回送，WS 从升级头及 metadata 事件捕获并在下一帧 `client_metadata` 回送；没有上下文的独立传输调用不共享锁。
- 路由锁归属由规范化端点、凭证 id 和最终认证头的 SHA-256 摘要判定；内置 Codex 的 HTTP 委托使用与 WS 相同的真实凭证 id，同轮 WS→SSE 回退不会误清路由 token。认证 A→B→A 会替换旧锁，不复活 A 的旧 token；只改 UA、非认证头或代理不改变这个归属。缓存只保留不可逆摘要与服务端 token，不保留认证明文。
- WS 连接身份另按最终握手头、有效代理与端点摘要复核，变化就重建 socket；头名大小写与顺序不造成误重建。重连/断链重建当前请求，不沿用失效 `previous_response_id`，同一逻辑轮次路由锁仍可复用。
- `diagnosticFork` 的指令前缀 ID 与 `prompt_cache_key` 保留父会话值，以便核对相同前缀；握手/线上会话身份走独立 `transportSessionKey`，请求投影不继承父 `turnContext`。反思循环也新建上下文；普通辅助调用每次独立创建，其内部重试可共用。
- refusal 是内容终态，不触发换号、额度恢复或凭证成功/失败计数；先交付已收到用量再终止，真实 API 错误保留原判定。Responses 的 `end_turn` 与文本 phase 规则见 [Agent Loop](../loop.md)。
- 请求 metadata、HTTP 响应头、成功 SSE 响应帧及 WS 消息的证据遮蔽 `turn_id` 与 `x-codex-turn-state`，不改变实际线上正文；细节见[用量与费用](../usage.md)。
- 错误归类与额度故障转移的外层重试错误 `CodexRebuildHistoryRetryError` 在 `codex-errors.ts`；换账号的选择在 [凭证池与存储](../credentials.md)。
- 图片生成失败：错误形状在 `shared/codex-image-generation-error.ts`，服务端修复动作在 `services/codex-image-generation-fix.ts`。
- 前端：`CodexSection` 是设置区块，浏览器授权的状态机在 `codex-browser-auth-state.ts`。
- 模型在 `auto:` 路由里属于订阅制来源，见 [模型目录与来源](../model-catalog/sourcing.md)。

## 从哪读起
- `server/lib/agent/codex-provider.ts`：适配器主体。
- `server/lib/agent/codex-websocket.ts`：WebSocket 传输与恢复。
- 测试：`agent/__tests__/codex-*.test.ts`（`codex-provider`、`codex-request`、`codex-websocket*`、`codex-http-turn-state`、`codex-provider-policy-violation`）。

## 改它时
- 改 Codex WebSocket：看 `codex-websocket.test.ts`、`codex-websocket-handshake.test.ts`、`codex-websocket-recovery.test.ts`；请求形状还由 `codex-chat-parity.test.ts`、`codex-utility-parity.test.ts` 与 `modeltrace-transport.test.ts` 覆盖，拒绝终态由 `openai-refusal.test.ts` 覆盖。
- 改请求身份：`codex-request.test.ts` 守护窗口 id 和指令前缀的确定性；`codex-turn-state.test.ts`、`codex-http-turn-state.test.ts` 与 WS 恢复回归验证逻辑轮次、认证归属及路由 token 的隔离。
- 改错误归类或换号重试：`codex-provider.test.ts`、`codex-provider-policy-violation.test.ts`；换账号逻辑在凭证池节点。
- 改图片生成开关或错误：同步 `shared/codex-image-generation-error.ts` 与服务端修复，再看 `image-generation*.test.ts`。
- 新增 Codex 设置项：`settings.codex`、`provider.ts` 的来源构造与 `CodexSection` 一起改。

## 相关
- [模型提供商](index.md)
- [适配器与历史构造](adapters.md)
- [凭证池与存储](../credentials.md)
