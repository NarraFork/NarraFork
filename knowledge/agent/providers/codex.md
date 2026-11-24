---
id: agent.providers.codex
title: Codex
summary: Codex 提供商：请求身份头、Responses WebSocket 传输、额度故障转移的重建重试、图片生成错误、设置页区块。
anchors:
  - server/lib/agent/codex-provider.ts
  - server/lib/agent/codex-websocket.ts
  - server/lib/agent/codex-errors.ts
  - server/lib/agent/codex-request.ts
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
verified_at: 776dbf07e
---
# Codex

Codex 是内置来源之一（`provider.ts` 的 codex 来源），适配器为 `CodexProvider`，走 OpenAI Responses 线协议；账号、额度与换号在 [凭证池与存储](../credentials.md)。

## 关键规则
- 配置：`useWebSocket` 缺省 true，`useWebSearch`、`useImageGeneration` 缺省 true，取自 `settings.codex`（`provider.ts` 的 codex 来源）。
- 传输：WebSocket 传输在 `codex-websocket.ts`；`useWebSocket` 关闭时走 HTTP。
- 请求身份：稳定请求身份，`x-codex-window-id` 由会话 id 确定性派生，另带 `x-codex-installation-id`，不发 `turn_id`（`codex-request.ts`）。
- 错误归类与额度故障转移的外层重试错误 `CodexRebuildHistoryRetryError` 在 `codex-errors.ts`；换账号的选择在 [凭证池与存储](../credentials.md)。
- 图片生成失败：错误形状在 `shared/codex-image-generation-error.ts`，服务端修复动作在 `services/codex-image-generation-fix.ts`。
- 前端：`CodexSection` 是设置区块，浏览器授权的状态机在 `codex-browser-auth-state.ts`。
- 模型在 `auto:` 路由里属于订阅制来源，见 [模型目录与来源](../model-catalog/sourcing.md)。

## 从哪读起
- `server/lib/agent/codex-provider.ts`：适配器主体。
- `server/lib/agent/codex-websocket.ts`：WebSocket 传输与恢复。
- 测试：`agent/__tests__/codex-*.test.ts`（`codex-provider`、`codex-request`、`codex-websocket*`、`codex-http-turn-state`、`codex-provider-policy-violation`）。

## 改它时
- 改 Codex WebSocket：看 `codex-websocket.test.ts`、`codex-websocket-handshake.test.ts`、`codex-websocket-recovery.test.ts`。
- 改请求身份头：`codex-request.test.ts` 守着窗口 id 的确定性与不发 `turn_id`。
- 改错误归类或换号重试：`codex-provider.test.ts`、`codex-provider-policy-violation.test.ts`；换账号逻辑在凭证池节点。
- 改图片生成开关或错误：同步 `shared/codex-image-generation-error.ts` 与服务端修复，再看 `image-generation*.test.ts`。
- 新增 Codex 设置项：`settings.codex`、`provider.ts` 的来源构造与 `CodexSection` 一起改。

## 相关
- [模型提供商](index.md)
- [适配器与历史构造](adapters.md)
- [凭证池与存储](../credentials.md)
