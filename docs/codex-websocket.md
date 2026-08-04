# Codex Responses WebSocket 集成

## 概述

NarraFork 的 Codex WebSocket 传输基于 Responses WebSocket。

- HTTP 模式使用 `POST /responses` + SSE
- WebSocket 模式使用同一套 Responses 语义
- WebSocket 不可用时会自动回退到 HTTP

## 关键文件

- `server/lib/agent/codex-websocket.ts` — Responses WebSocket 连接与 session cache
- `server/lib/agent/codex-provider.ts` — Codex provider，负责在 WS / HTTP 之间切换
- `server/lib/agent/openai-provider.ts` — 复用 Responses request 构建与事件解析
- `scripts/test-codex-websocket.ts` — 手动验证脚本

## 协议特征

当前 WebSocket 传输使用：

- WebSocket URL：`wss://chatgpt.com/backend-api/codex/responses`
- 握手头：
  - `Authorization: Bearer ...`
  - `User-Agent: codex-tui/{managed-version} (...)`
  - `originator: codex-tui`
  - `OpenAI-Beta: responses_websockets=2026-02-06`
  - `session-id` / `thread-id` / `x-client-request-id`
  - `x-codex-installation-id`
  - 可选 `ChatGPT-Account-Id`
  - 可选 `x-codex-turn-state`
- **不发送** `x-openai-internal-codex-responses-lite`：该头不是身份标记，而是一份请求体契约的一半。真实客户端由模型目录里的 `ModelInfo.use_responses_lite` 驱动，置位时同时做四件事——省略顶层 `instructions` 与 `tools`、把 `additional_tools` 与 developer 指令消息插到 `input` 最前、`parallel_tool_calls: false`、再加这个头。上游会校验这对配对关系，只要 `tools` 里出现 hosted 工具（如 `web_search` / `image_generation`）就返回 400：`X-OpenAI-Internal-Codex-Responses-Lite only supports function tools, custom tools, and client-executed tool search.`。NarraFork 发送的是经典非 lite 请求体，因此不声明 lite；`stripResponsesLiteHeader` 会把用户 `extraHeaders` 里塞进来的该头也去掉。
- 请求体：`{ type: "response.create", ...ResponsesRequestBody }`，包含稳定的 `client_metadata`、`prompt_cache_key`、`tool_choice: "auto"`、`parallel_tool_calls: false`、`reasoning.context: "all_turns"` 与 `text.verbosity: "low"`

## 已实现能力

- 连接复用（按 session / credential / model 缓存）
- `previous_response_id` 增量续写
- `response.output_item.done` 基线跟踪
- `x-codex-turn-state` 头回放
- 426/404/405/501 等不支持场景自动禁用 WS 并回退 HTTP
- 配额耗尽时继续沿用 Codex credential failover

## 测试

### 手动测试

```bash
bun scripts/test-codex-websocket.ts
```

可选代理：

```bash
bun scripts/test-codex-websocket.ts --proxy=http://proxy.example.com:8080
```

### 单元测试

```bash
bun test server/lib/agent/__tests__/codex-websocket.test.ts
```

## 说明

WebSocket 模式目前仍标记为实验性；如果服务器、代理或网络环境不支持 Responses WebSocket，NarraFork 会自动回退到 HTTP。
