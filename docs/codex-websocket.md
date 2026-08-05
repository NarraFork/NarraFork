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
  - `User-Agent`：调用方传入的 `userAgent`，缺省为 NarraFork UA
  - `originator: narrafork`（可被 `extraHeaders` 覆盖）
  - `Origin`：官方域名下为 `https://chatgpt.com`，否则为 `baseUrl`
  - `OpenAI-Beta: responses_websockets=2026-02-06`
  - `x-client-request-id`：取 `sessionKey`（每会话稳定标识）
  - 可选 `ChatGPT-Account-Id`（仅官方域名且提供了 accountId 时）
  - 可选 `x-codex-turn-state`（上一轮响应回放）
  - 可选 `x-codex-turn-metadata`（仅调用方显式传入时）
  - 最后合并调用方的 `extraHeaders`，因此它可以覆盖上面任意一项
- 请求体：`{ type: "response.create", ...ResponsesRequestBody }`

两条调用路径传入的指纹不同：`openai-provider.ts` 的 codex 通道会传
`userAgent` + `extraHeaders`（由 `resolveClientFingerprint` 解析，含
`originator`、`x-codex-installation-id`、`session-id`/`thread-id`）；内置
Codex adapter（`codex-provider.ts`）两者都不传，因此走缺省的 NarraFork UA 与
`originator: narrafork`。

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
