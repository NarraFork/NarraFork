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
- 握手头（`buildHandshakeHeaders`，按实际发送顺序）：
  - `Authorization: Bearer ...`（`authorization` 选项优先，否则用 `apiKey`）
  - `User-Agent`：调用方传入的 `userAgent`，缺省为 `codex-tui/{managed-version} (...)`
  - `originator: codex-tui`（可被 `extraHeaders` 覆盖）
  - `Origin`：官方域名下为 `https://chatgpt.com`，否则为 `baseUrl`
  - `OpenAI-Beta: responses_websockets=2026-02-06`
  - `session-id` / `thread-id`：同取 `conversationId`
  - `x-client-request-id`：同取 `conversationId`。**仅 WS 握手发送**——codex-rs 全仓只有
    `build_websocket_headers` 写这个头，HTTP `/responses` 与 `/responses/compact` 都不发，
    因此它不在 `buildCodexEmulationHeaders`（HTTP/WS 共用的身份层）里，由本传输自己设置
  - `x-codex-window-id`：由 `conversationId` 确定性派生（见 `deriveCodexWindowId`）
  - `x-codex-installation-id`（经 `extraHeaders` 传入）
  - 可选 `ChatGPT-Account-Id`（仅官方域名且提供了 accountId 时）
  - 可选 `x-codex-turn-metadata`（仅调用方显式传入时）
  - 最后合并调用方的 `extraHeaders`，因此它可以覆盖上面任意一项
- **握手头不含** `x-codex-turn-state`：该 token 要等一个 turn 的首个响应才拿到，而那时本连接的
  握手早已发出、且连接会被 turn 内后续请求复用，握手头结构上不可能承载它。它改走每个
  `response.create` 的 `client_metadata`（见 `applyTurnStateToRequest`），与 codex-rs 一致——
  上游 `build_websocket_headers` 显式传 `/*turn_state*/ None`，并在 WS 的 `client_metadata`
  里注入该 token；只有 HTTP 路径才把它作为请求头发送
- **不发送** `x-openai-internal-codex-responses-lite`：该头不是身份标记，而是一份请求体契约的一半。真实客户端由模型目录里的 `ModelInfo.use_responses_lite` 驱动，置位时同时做四件事——省略顶层 `instructions` 与 `tools`、把 `additional_tools` 与 developer 指令消息插到 `input` 最前、`parallel_tool_calls: false`、再加这个头。上游会校验这对配对关系，只要 `tools` 里出现 hosted 工具（如 `web_search` / `image_generation`）就返回 400：`X-OpenAI-Internal-Codex-Responses-Lite only supports function tools, custom tools, and client-executed tool search.`。NarraFork 发送的是经典非 lite 请求体，因此不声明 lite；`stripResponsesLiteHeader` 会把用户 `extraHeaders` 里塞进来的该头也去掉。
- 请求体：`{ type: "response.create", ...ResponsesRequestBody }`，包含稳定的 `client_metadata`、`prompt_cache_key`、`tool_choice: "auto"`、`parallel_tool_calls: false`、`reasoning.summary: "auto"`（非 lite 形态省略 `reasoning.context`，与 codex-rs 0.146.0 一致）与 `text.verbosity: "low"`，`client_metadata` 含会话稳定的 `x-codex-window-id`，以及拿到 turn state 之后的 `x-codex-turn-state`
- 增量续写复用判定（`requestWithoutInput`）**排除 `client_metadata`**：该字段带有随请求变化的运行时值
  （尤其是 `x-codex-turn-state`），若参与比较，首个响应之后的每个请求都会被判定为「不同请求」，
  从而静默退化成全量重发并丢失 prompt cache。codex-rs 的
  `responses_request_properties_match` 划的是同一条线：input 单独比较、metadata 直接忽略

两条调用路径都呈现托管 Codex 客户端身份：`openai-provider.ts` 的 codex 通道传
`userAgent` + `extraHeaders`（由 `resolveClientFingerprint` 解析，含 `originator`、
`x-codex-installation-id`、`session-id`/`thread-id`、`x-codex-window-id`）；内置 Codex
adapter（`codex-provider.ts`）不传 `extraHeaders`，因此走 `buildHandshakeHeaders` 的
缺省值——同样是 codex-tui UA 与 `originator: codex-tui`。

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
