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
- 单元测试：`server/lib/agent/__tests__/codex-websocket*.test.ts`

## 协议特征

当前 WebSocket 传输使用：

- WebSocket URL：`wss://chatgpt.com/backend-api/codex/responses`
- 握手头（`buildHandshakeHeaders`，按实际发送顺序）：
  - `Authorization: Bearer ...`（`authorization` 选项优先，否则用 `apiKey`）
  - `User-Agent`：调用方传入的 `userAgent`，缺省为 `codex-tui/{managed-version} (...)`
  - `originator`：默认 `codex-tui`；当 `userAgentMode` 为 `narrafork` 时由
    `resolveClientFingerprint` 写成 `narrafork`，并经 `extraHeaders` 覆盖握手默认值。
    其他模式（`codex` / `claude-code` / `custom` / 未设置）保持 `codex-tui`。
  - `Origin`：官方域名下为 `https://chatgpt.com`，否则为 `baseUrl`
  - `OpenAI-Beta: responses_websockets=2026-02-06`
  - `session-id` / `thread-id`：同取 `conversationId`
  - `x-client-request-id`：同取 `conversationId`。codex-rs 在 HTTP `/responses`
    （codex-api/src/endpoint/responses.rs，与 `build_session_headers` 同处）和 WS 握手
    （`build_websocket_headers`）都发送它，只有 `/responses/compact` 不发。因此它由
    `buildCodexEmulationHeaders`（HTTP/WS 共用的身份层）统一投影，本传输再写入同值
  - `x-codex-window-id`：由 `conversationId` 确定性派生（见 `deriveCodexWindowId`）
  - **不发送** `x-codex-installation-id` 直接头：codex-rs 的 `compatibility_headers()`
    只投影 window-id / session-id / thread-id / turn-metadata / parent-thread / subagent，
    installation id 只出现在 body `client_metadata`（及 turn-metadata blob）；唯一把它做成
    真实 HTTP 头的是 remote-control 注册接口，不是 `/responses`。
  - 可选 `ChatGPT-Account-Id`（仅官方域名且提供了 accountId 时）
  - 可选 `x-codex-turn-metadata`（仅调用方显式传入时）
  - 最后合并调用方的 `extraHeaders`，因此它可以覆盖上面任意一项
- **握手头不含** `x-codex-turn-state`：该 token 要等一个 turn 的首个响应才拿到，而那时本连接的
  握手早已发出、且连接会被 turn 内后续请求复用，握手头结构上不可能承载它。它改走每个
  `response.create` 的 `client_metadata`（见 `applyTurnStateToRequest`），与 codex-rs 一致——
  上游 `build_websocket_headers` 显式传 `/*turn_state*/ None`，并在 WS 的 `client_metadata`
  里注入该 token；只有 HTTP 路径才把它作为请求头发送
- **不发送** `x-openai-internal-codex-responses-lite`：该头不是身份标记，而是一份请求体契约的一半。真实客户端由模型目录里的 `ModelInfo.use_responses_lite` 驱动，置位时同时做四件事——省略顶层 `instructions` 与 `tools`、把 `additional_tools` 与 developer 指令消息插到 `input` 最前、`parallel_tool_calls: false`、再加这个头。上游会校验这对配对关系，只要 `tools` 里出现 hosted 工具（如 `web_search` / `image_generation`）就返回 400：`X-OpenAI-Internal-Codex-Responses-Lite only supports function tools, custom tools, and client-executed tool search.`。NarraFork 发送的是经典非 lite 请求体，因此不声明 lite；`stripResponsesLiteHeader` 会把用户 `extraHeaders` 里塞进来的该头也去掉。
- 请求体：`{ type: "response.create", ...ResponsesRequestBody }`，包含稳定的 `client_metadata`、`prompt_cache_key`、`tool_choice: "auto"`、`parallel_tool_calls: false`、`reasoning.summary: "auto"`（非 lite 形态省略 `reasoning.context`，与 codex-rs 0.159.2 一致）与 `text.verbosity: "low"`，`client_metadata` 含会话稳定的 `x-codex-window-id`，以及拿到 turn state 之后的 `x-codex-turn-state`
- 增量续写复用判定（`requestWithoutInput`）**排除 `client_metadata`**：该字段带有随请求变化的运行时值
  （尤其是 `x-codex-turn-state`），若参与比较，首个响应之后的每个请求都会被判定为「不同请求」，
  从而静默退化成全量重发并丢失 prompt cache。codex-rs 的
  `responses_request_properties_match` 划的是同一条线：input 单独比较、metadata 直接忽略

两条调用路径都通过 `resolveClientFingerprint` 解析 `userAgent` + `extraHeaders`
（含 `originator`、`session-id`/`thread-id`、`x-codex-window-id`；
`x-codex-installation-id` 只在 body `client_metadata`，不进 header 集合）。
`openai-provider.ts` 的 codex 通道与内置 Codex adapter
（`codex-provider.ts`）均如此；默认 `userAgentMode` 为 `codex` 时呈现
`codex-tui` UA 与 `originator: codex-tui`，显式选 NarraFork 时两者都变为
`narrafork`。

## 已实现能力

- 连接复用（按 session / credential / model 缓存）
- `previous_response_id` 增量续写
- `response.output_item.done` 基线跟踪
- `x-codex-turn-state` 回放（握手响应头 + `response.metadata` 事件两个来源）
- 426/404/405/501 等不支持场景自动禁用 WS 并回退 HTTP
- 配额耗尽时继续沿用 Codex credential failover
- 连接寿命上限主动回收 + `websocket_connection_limit_reached` / `previous_response_not_found` 自动恢复

## 重连与错误处理契约

这一节记录的都是"做错了不会报错、只会让会话莫名死掉"的地方。

### 连接寿命：上游 60 分钟硬顶

上游会在 60 分钟后主动retire一条 Responses WebSocket，并下发
`websocket_connection_limit_reached`，消息原文是
`Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.`

两件事必须同时做对，缺一个就会把一次**必然可恢复**的事件变成终端错误：

1. **主动回收（`CONNECTION_MAX_LIFETIME_MS` = 55 分钟）。** 在请求之间替换临近上限的连接，
   而不是等上游在响应中途拆链路。请求间重建不可见，响应中途重建会打断输出。
2. **被动恢复必须重连，而不是只判断"有没有已输出内容"。** 早先的实现只在
   `!hasYieldedEvents` 时重连，于是实践中真正会发生的场景——长时会话跑到一小时、
   上限在响应中途触发——永远走不到重连分支。

### 恢复时必须重建请求，不能沿用旧的 delta

`previous_response_id` 是**连接作用域**的。任何新 socket 都让旧的响应链失效，这正是
`previous_response_not_found` 报的事。所以每条重连路径都调用 `discardResponseChain()`
清掉 `lastRequest`/`lastCompleted`，随后 `buildRequestFrame()` 会自然退化为一次全量
`response.create`。codex-rs 划的是同一条线：`websocket_connection()` 每次决定要新连接时
都会调用 `reset_websocket_session()`。

沿用缓存的 delta（仍带 `previous_response_id`）会让"本该救回这一轮"的重发在新 socket 上
必然失败——症状看起来像重连没用，实际是重连时带了一个新连接根本不认识的基线。

`turnState` **不清**：sticky-routing token 属于 turn 而非连接，同一 turn 内经由替换 socket
发出的请求仍必须回放它。

### 重连必须清空 accumulator

`toolAccum` / `reasoningAccum` 按 output index 索引。被放弃的那次响应里半写完的 tool call
若不清掉，会和替换响应的 index 0 合并，产出一个 arguments 是两段不同 JSON 拼接的 tool
call——JSON.parse 直接失败，且这个失败离真正的原因已经很远。

### 恢复失败时抛 `CodexWebSocketRetryableError`，不能抛普通 Error

这是整条链路最隐蔽的一环。`isRetryableError` 会优先读结构化的 `retryable: true`，
而上游那句话**不匹配任何关键词启发式**：没有 "overload"、没有 "try again"、不是 5xx。
作为普通 `Error` 抛出时它被判定为**不可重试**；codex 又是 stateful provider
（loop 层 `getMaxChatRetries()` 返回 0，没有 in-loop 重试），于是这一轮直接死掉——
和上游那句"请新建连接继续"的指示恰好相反。

`resumable` 字段区分两种恢复语义：已经有输出流给调用方时（调用方已持久化该部分轮次）
重发会重复输出，必须由 agent loop 从部分轮次续跑；没有输出时才可以整体重放。

对应地，`codex-provider.ts` 收到这个类型会**原样抛出**，不走 failover 分支——那条路会
`reportFailure()` 惩罚一个完全健康的 credential，累积到 `too_many_failures` 甚至把它禁用。

### close 帧的 reason 会被截断到 123 字节

RFC 6455 限制 close reason 最长 123 字节，而上游放进去的 JSON 约 230 字节。也就是说
**真实的 close 帧永远是截断的、`JSON.parse` 必然失败**。因此
`findCodexRecoverableCloseCode()` 直接在原文里找错误码子串——这些 code 不会出现在自然语言里，
而另一种选择是丢掉该帧仅剩的可识别信息，把它当成匿名断连处理（旧行为，抛不可重试的普通 Error）。

### 超时预算分三档

- `HANDSHAKE_TIMEOUT_MS`（15s，对齐 codex-rs `websocket_connect_timeout`）——
  被代理/防火墙静默丢弃的 TCP 连接既不完成也不报错，没有这个定时器 `connect()` 永不 settle，
  调用方（叙述者事件循环）就那样挂住且没有任何错误可报。失败时会 `terminate()`，
  否则悬挂的 socket 既泄漏 fd 又占用上游按账号计算的连接配额。
- `FIRST_EVENT_IDLE_TIMEOUT_MS`（60s）——首个事件之前的静默通常意味着 socket 被接受后遭遗弃，
  只有重连能解决。
- `CONNECTION_IDLE_TIMEOUT_MS`（300s，对齐 codex-rs `stream_idle_timeout`）——
  事件已在流动之后的静默通常意味着模型在工作。旧实现两段都用 60s，普通的上游排队就会触发超时，
  而每次超时代价是一次重连 + 全量重发，于是繁忙的后端会演变成重试风暴而非"慢一点的响应"。
- `SEND_TIMEOUT_MS`（60s）——半开 TCP 路径会把写入吞进永不排空的缓冲区，无上限的 send
  会让调用方永久停住。codex-rs 同样用 idle timeout 包住它的 send。

### 上游错误必须按内容识别，不能只认 `type` 判别字段

**这一条不限于 WebSocket，SSE 路径同样适用**（`parseUpstreamErrorEnvelope`，实现在
`shared/agent-protocol/error-diagnostics.ts`，两条传输共用）。

各处流解析原本都以 `type === "error"`（或 `error.message` 存在）作为判据，而实践中至少还有
三种形状会到达：

- `{"error":{"message":"..."}}`——**没有 `type` 字段**（网关转发时常见）
- `{"error":"backend refused the request"}`——`error` 本身就是字符串
- `{"error":{"detail":"..."}}`——文本在 `detail` / `description` 下

这些形状此前**解析结果为空**：Responses 解析器在 `if (!type) return []` 就返回了，
于是上游唯一的解释被丢弃，流看起来像是自然结束，随后由空响应守卫报成
`stream_closed_before_response_completed` / "上游返回了空响应，通常意味着 API 配置错误"——
把一次上游故障说成了用户自己的 base URL / 凭证问题，把人引向完全错误的排查方向。

这个 bug 之所以难以发现：**供应商模型列表的测试对话框显示同一个错误是正确的**——
那条路径（`POST /api/settings/test-model`）读的是抛出错误的 `message`，不解析流，
因此从不依赖那个判别字段。

反向风险同样被显式钉住：按内容识别若过宽，会把正常内容帧误判成失败，
那比原 bug 更糟（杀掉一个健康的轮次）。因此 `parseUpstreamErrorEnvelope` 要求
**必须有人类可读文本**，且需要一个佐证信号（存在 `error` 字段 / `type==="error"` /
字符串 `code` / 数值 `status`）；单独一个 `message` 或 `code: 200` 都不算错误——
有些供应商在成功帧上就带 `code: 200`。

### `response.failed` / `response.incomplete` 必须让调用方知道原因

`parseResponsesAPIEvent` 已经把这两个 chunk 转成带上游 code/message 的 `invalidState`
事件，agent loop 依此区分"可重试的 server_error"、"终端 refusal"和"上下文溢出"。
旧实现直接 `return`，把一次失败的响应呈现为**一次成功的空轮次**——于是一个瞬时上游错误
看起来像模型选择了什么都不说。

## 测试

### 单元测试

```bash
bun test server/lib/agent/__tests__/codex-websocket.test.ts
bun test server/lib/agent/__tests__/codex-websocket-handshake.test.ts
bun test server/lib/agent/__tests__/codex-websocket-recovery.test.ts
```

上游错误信封识别（SSE + WS 共用）：

```bash
bun test server/lib/agent/__tests__/upstream-error-envelope.test.ts
```

三个文件的分工：`codex-websocket.test.ts` 钉住分类器与请求构造，
`codex-websocket-handshake.test.ts` 钉住握手头，
`codex-websocket-recovery.test.ts` 用一个本机真实 WebSocket 服务器钉住传输层**实际行为**
（重连、全量重发、turn state 回放、截断 close 帧恢复、预算耗尽后的错误类型）。
这个区分是必要的：本节记录的每个 bug 都是接线 bug 而非分类 bug ——
检测器判断正确，但恢复路径重发了过期的 delta、复用了被污染的 accumulator，
或者在明明还有既定恢复手段时就放弃了。

## 说明

WebSocket 模式目前仍标记为实验性；如果服务器、代理或网络环境不支持 Responses WebSocket，NarraFork 会自动回退到 HTTP。

回退（`CodexWebSocketFallbackError`）与重试（`CodexWebSocketRetryableError`）是两种不同的信号，
不要混用：前者表示"这个环境用不了 WS，改走 HTTP"，后者表示"WS 可用，但这条连接用完了，
重来一次"。把后者当成前者会让每次撞到 60 分钟上限就永久退回 HTTP，
白白丢掉 WS 的 prompt cache 收益。
