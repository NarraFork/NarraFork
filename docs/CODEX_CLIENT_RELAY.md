# Codex 客户端出口中继（Client Egress Relay）设计

> 状态：阶段 1（NUG 侧）、阶段 2（nf 侧 relay client + provider 接线）与阶段 2.5（前端设置 UI 与生命周期，见 §0.2）已实现；阶段 3 部分（egress 落库等）、阶段 4（WS 上游过中继）、阶段 5（多 channel 选择策略、admin 面板）未实现。错误分类提炼已含在阶段 1。
> 涉及仓库：narrafork（请求方 nf）、narrafork-unified-gateway（NUG）

## 0. 阶段 1 实现纪要（与本文其余章节的偏差）

- **开关位置**：`client_relay` 落在 codex 渠道配置（`config/nug.yaml` 的 `providers.codex.client_relay`，分布式 `config/codex.yaml` 同形），**不是** gateway admin settings。app 层据此创建 relay hub 并同时接线到 gateway（`WithRelayHub`）与 codex component（`SetRelayHub`）。hub 是进程内状态，所以阶段 1 **仅支持 monolith 部署**；分布式部署没有 hub，功能在两侧自然关闭。
- **归属校验**：gateway 在构建 `ProxyRequest` 时校验 `X-NUG-Relay-Channel` 头指向的 channel 属于**同一个 API key**（防"把请求嫁祸到别人出口 IP"），校验通过才写入 proto 字段 `client_relay_channel_id = 17`；原始头在 `excludedHeaders` 里被剥离，不会经 `headers` map 漏进渠道。
- **出口可观测**：所有代理响应带 `X-NUG-Egress: client-relay | nug-direct`。
- **WS 上游**：relay 激活的请求强制走 SSE（跳过 `useWebSocket`），WS 过中继留到阶段 4。
- **易错点（已踩过）**：`sharedhttp.ConfigureStreamingTransport` 会**无条件覆盖** `Transport.DialContext`，relay dialer 必须在它之后赋值，否则请求从 NUG 直连、功能静默失效（靠 `TestDoChatWrapsRelayDialError` 钉住）。
- **中继错误分类**：`*relay.Error` 全程可经 `errors.As` 识别。`doProxyWithRetry` 遇到中继错误立即返回——不换凭据、不计失败、不重试；`classifyFinalProxyError` 归为 503 + `client_relay`（新增 incident category），已 Forwarded 时标 `Resumable`。
- **测试**：`internal/relay`（帧编解码、DIAL 时序、窗口背压、FIN/RST、通道死亡、stream 上限、客户端越权 DIAL 断连）+ TLS 端到端集成测试（`nfRelayClient` 是 nf 侧 TypeScript 实现的参考样板）+ codex 分类/拨号包装测试。

## 0.1 阶段 2 实现纪要（nf 侧，narrafork 仓库）

- **新模块 `server/lib/nug-relay/`**：`protocol.ts`（帧编解码，与 Go 侧字节级对齐）、`dialer.ts`（allowlist + HTTP CONNECT 隧道）、`relay-client.ts`（WSS 常驻连接、DIAL 应答、双向 splice、发送窗口、指数退避重连）、`manager.ts`（按 provider id 的注册表，`ensureNugRelayClient` 幂等）。
- **配置**：`NUGProviderConfig` 新增 `egressMode`（`nug` 默认 / `local-direct` / `local-proxy`）、`egressProxyUrl`、`egressAllowDirectFallback`（默认 false：中继掉线时 fail-fast，不静默回退 NUG 直连）。
- **接入**：`NugProvider` 构造时 `ensureNugRelayClient`；codex delegate 通过 `OpenAIProviderConfig.dynamicHeaders`（新增，每请求调用）注入 `X-NUG-Relay-Channel`——channel id 每次重连轮换，静态 extraHeaders 放不下它。`chat()` 在中继离线且未允许回退时直接抛错。
- **allowlist**：默认仅 `chatgpt.com:443`；**IP 字面量一律拒绝**（即使被列入 allowlist），防恶意 NUG 借 nf 扫内网。
- **CONNECT 拨号**：`local-proxy` 模式经 HTTP CONNECT 走 clash，支持 `Proxy-Authorization`；隧道建立后 TLS 由 NUG 侧完成，clash 只见密文。
- **测试**（`server/lib/__tests__/nug-relay.test.ts`，12 个）：编解码、allowlist、CONNECT 隧道、端到端（Bun.serve 模拟 hub + 本地 echo 上游）、3 倍窗口流控、断线重连。
- **已知边界**：Bun socket 无 pause/resume，上游→WS 方向的背压靠窗口 + 4×窗口的内存上限（超限 RST）。

## 0.2 阶段 2.5 实现纪要（nf 设置 UI 与生命周期）

- **前端**（`NUGProvidersSection.tsx`）：每个 NUG provider 卡片新增「上游出口」选择器（NUG 直连 / 本地直连 / 本地代理）、本地代理地址输入（仅 local-proxy）、回退开关（仅 local-*），以及轮询 `GET /api/nug/relay-status` 的中继状态徽章（在线/连接中/离线）。
- **生命周期**：`reconcileNugRelayClients` 在服务器启动（main.ts）与每次设置保存（settings.ts PATCH）后执行；NugProvider 构造时的 ensure 仍是兜底层。
- **配置链路闭合**：zod schema（`nugProviderSchema`）接受三个新字段 → settings.json 持久化 → 前端 reducer `INIT_FROM_SETTINGS` 显式透传。



## 1. 背景与目标

当前 codex 账号共享的链路是纯反代：`nf → NUG → OpenAI`。所有请求从 NUG 的服务器 IP 出网，OpenAI 看到的是"单一机房 IP 承载一个账号的全部流量"，容易被风控判定为账号共享/转售。

本设计引入一条新链路，让**每个用户用自己的 IP（或自己的代理 IP）访问 OpenAI，同时 codex 凭据不离开 NUG、请求方 nf 全程无法读取凭据**：

```
请求: nf(用户) ──明文session──▶ NUG(持凭据) ──TLS密文──▶ nf(用户) ──▶ (clash──▶) OpenAI
响应: OpenAI ──▶ (clash──▶) nf(用户) ──TLS密文──▶ NUG(解密/计量) ──明文──▶ nf(用户)
```

核心机制：**TLS 终点在 NUG，请求方 nf 只做四层字节搬运**。NUG 与 OpenAI 完成 TLS 握手、注入 `Authorization` 等凭据头；nf 在自己的网络里拨通 `chatgpt.com:443`（可经本地 clash），在"nf↔OpenAI TCP 连接"与"nf↔NUG 中继通道"之间原样搬运 TLS 密文。

本质上是 **reverse SOCKS + TLS 终点在服务端**：不是 NUG 去连用户的代理（那要求用户代理公网可达），而是 nf 主动外连、把拨号能力借给 NUG。**NAT 后的用户可用**。

### 1.1 安全性质

| 威胁 | 结论 |
|---|---|
| 用户窃取 codex 凭据 | 不可能。凭据只存在于 NUG↔OpenAI 的 TLS 会话内，nf 只见密文。nf 是用户自己的开源软件也无法破解 TLS。 |
| 用户伪造 OpenAI 服务器骗取 token | 不可能。NUG 的 TLS 握手做证书链 + 主机名校验，假服务器拿不出 chatgpt.com 合法证书。用户最多断流，不能解密。 |
| 恶意/被控 NUG 指使 nf 拨用户内网 | 由 nf 侧**硬白名单**防御：只接受拨号 `chatgpt.com:443`（及显式配置的 OpenAI 域名），其余目标一律拒绝。 |
| 中间人（含用户自己的 clash）嗅探 token | 不可能。clash 是 CONNECT 隧道，只见 `CONNECT chatgpt.com:443` 与 TLS 密文。nf/NUG 必须严格证书校验，禁止信任用户侧 CA、禁止非 TLS 回退。 |
| NUG 运营者看到请求/响应内容 | **可以看到**，与今天纯反代的信任模型一致，不恶化。 |

### 1.2 非目标

- 不消除共享账号的风控：OpenAI 仍看到一个账号从多个固定住宅 IP 使用（形状从"单机房 IP 大并发"变为"每用户固定 IP"，更接近正常多设备），并发额度与行为指纹仍是共享的。
- 不改变 NUG 的计量、计费、凭据池、重试模型——这些全部复用。
- 带外请求（usage 刷新、reset-credits 等，`GetUsage`/`ConsumeResetCredit` 一类）仍从 NUG 直连，不经过用户出口。

## 2. 开关与协商语义

两侧都默认保守，逐层 opt-in。

### 2.1 NUG 侧：`client_relay`（per-channel，默认禁用）

codex 渠道配置新增：

```yaml
codex:
  client_relay:
    enabled: false              # 默认禁用，行为与现状一致
    dial_timeout_ms: 15000      # NUG 请求 nf 拨号的超时
    max_streams_per_channel: 64 # 每条中继通道的最大并发流
```

- 禁用：携带中继意愿的请求照常 NUG 直连，偏好被静默忽略（通过响应头可观测，见 2.4）。
- 启用：携带有效中继通道的请求优先走客户端出口；未携带的请求仍 NUG 直连（**不强制**）。

### 2.2 nf 侧：出口模式（默认关）

NUG 渠道配置新增：

```ts
egress: "nug"            // 默认：现状，NUG 直连
      | "local-direct"   // 本地直连出口：nf 用自己的 IP 拨 chatgpt.com
      | "local-proxy"    // 本地代理出口：nf 经本地 clash 拨 chatgpt.com
localProxyUrl?: string   // 仅 local-proxy，如 "http://127.0.0.1:7890"
allowNugDirectFallback?: boolean // 中继不可用时是否允许回退 NUG 直连，默认 false
```

- `"nug"`：nf 完全不建立中继通道，行为与今天一字不差。
- `"local-direct"` / `"local-proxy"`：nf 向 NUG 发起常驻中继 WebSocket 并宣告能力，之后该渠道的每个请求携带中继通道标识。

### 2.3 组合行为

| NUG `client_relay` | nf egress | 结果 |
|---|---|---|
| 禁用 | nug | NUG 直连（现状） |
| 禁用 | local-* | NUG 直连；nf 渠道状态显示"NUG 未启用客户端出口" |
| 启用 | nug | NUG 直连 |
| 启用 | local-* | **经用户本地出口** |

### 2.4 出口可观测（必须）

响应头 `X-NUG-Egress: client-relay | nug-direct`，nf 在渠道状态里展示"当前实际出口"。没有这个头，"偏好被静默忽略"与"模式生效"在界面上无法区分。

### 2.5 中继掉线策略

nf 已选本地出口但中继通道断开 / NUG 侧 dial 超时：

- 默认**失败并明确报错**（"本地出口不可用"），不静默回退。静默回退会让账号在 OpenAI 侧呈现 IP 跳变，比一直用 NUG 直连更像共享账号。
- `allowNugDirectFallback: true` 时才回退 NUG 直连，由用户自行权衡可用性 vs IP 一致性。

## 3. 中继通道协议（nf ↔ NUG）

### 3.1 通道建立

- nf 发起 `WSS <nug>/v1/relay`，用该渠道的 NUG API key 认证（与 HTTP 请求同一 key，Authorization 头或 `?token=`）。
- NUG 认证通过后返回 `HELLO_ACK { channel_id }`。`channel_id` 由 NUG 生成，绑定 API key，nf 之后每个 codex 请求携带 `X-NUG-Relay-Channel: <channel_id>`。
- NUG 校验：请求头里的 channel 必须属于该请求的 API key，否则 403。一个 key 可有多条在线通道（多台机器），选择策略见 4.3。
- 断线后 nf 以指数退避重连（1s 起，上限 60s，加抖动）；重连成功获得新 `channel_id`，旧 id 立即失效。
- 心跳用 WebSocket 原生 ping/pong，NUG 侧 30s 无 pong 判定死亡。

### 3.2 帧格式

单条 WSS 连接上多路复用 stream。除 WS 原生 ping/pong 外，全部使用**二进制帧**：

```
[1B opcode][8B stream_id (uint64 BE)][4B length (uint32 BE)][payload]
```

| opcode | 名称 | 方向 | payload | 说明 |
|---|---|---|---|---|
| 0x01 | DIAL | NUG→nf | UTF-8 `"host:port"` | 请求 nf 拨号。目标仅限白名单（见 5.2） |
| 0x02 | DIAL_OK | nf→NUG | 空 | 拨号成功，stream 进入数据期 |
| 0x03 | DIAL_ERR | nf→NUG | UTF-8 错误描述 | 拨号失败（含白名单拒绝、clash 不可达） |
| 0x04 | DATA | 双向 | ≤ 64KiB 原始字节 | TLS 密文，原样搬运 |
| 0x05 | FIN | 双向 | 空 | 半关闭：发送方不再写，仍可读 |
| 0x06 | RST | 双向 | UTF-8 原因（可空） | 立即中止 stream，双向丢弃待发送数据 |
| 0x07 | WINDOW_UPDATE | 双向 | 4B uint32 增量 | 流控信用，见 3.3 |

stream_id 由 NUG 分配（奇偶位预留：目前全部 NUG 发起，取单调递增 uint64）。

时序：`DIAL → DIAL_OK → DATA* → (FIN|RST)`。任何一方收到未知 opcode 或非法 stream_id 的帧，回 RST 并记 WARN；协议级错误（如 HELLO 前发数据帧）直接关闭整个通道。

### 3.3 流控与背压

- **per-stream 信用窗口**：初始 256KiB。发送方每发一个 DATA 帧扣减窗口；接收方每消费 N 字节回 `WINDOW_UPDATE(N)`。窗口耗尽则暂停发送。
- 目的：OpenAI 快、nf 慢（或反过来）时，把缓冲压力限制在单 stream 的窗口内，防止 NUG 内存膨胀。中继 WSS 本身的 TCP 背压提供第二道防线。
- 单个 DATA 帧 ≤ 64KiB，接收方可直接 RST 超限帧。

### 3.4 net.Conn shim（NUG 侧）

NUG 把一条 stream 包装成 `net.Conn` 喂给现有上游栈：

- `http.Transport.DialContext`：返回 shim。Transport 在其上完成 TLS 握手（`ServerName: "chatgpt.com"`，标准证书校验），之后 HTTP/1.1 请求响应照常。**协议代码零改动**。
- `websocket.Dialer.NetDial`（codex WS 上游）：同样返回 shim。WS 握手与帧在 TLS 之上，对 shim 透明。
- 必须实现 `SetDeadline/SetReadDeadline/SetWriteDeadline`（`http.Transport` 依赖）：用定时器模拟，到期让在途 Read/Write 返回 timeout 错误，不关闭 stream（由上层决定关）。
- `Close` 发 RST（非优雅）或先发 FIN 再等服务端 FIN（优雅，用于正常响应结束）。

## 4. NUG 侧集成

### 4.1 ProxyConfig 新 mode：`client-relay`

现有代理解析链为 per-credential proxy → per-request `ChannelProxy` → YAML 全局 proxy（`internal/codex/proxy.go` `resolveProxy`）。新增：

```proto
// ProxyConfig.Mode 新增枚举值
client-relay  // 经请求方 nf 的本地出口
```

解析顺序调整为：**per-credential proxy > client-relay（若请求携带有效中继通道且渠道启用）> per-request ChannelProxy > YAML 全局**。即：显式配置了凭据级代理的凭据不受中继影响（运维可钉住特定账号的出口）；其余请求在 relay 可用时走中继。

`client-relay` 不产生 proxy URL，而是让 `APIClient`/`webSocketDialerForProxy` 使用注入了 relay `DialContext` 的 transport/dialer。`ProxyResult.Proxy` 记录为哨兵值 `__nug_client_relay__`，供用量刷新路径识别（带外刷新**不**走中继，见 1.2）。

### 4.2 请求与中继通道的绑定

1. 请求携带 `X-NUG-Relay-Channel: <channel_id>`（由 nf 的 NUG provider 注入）。
2. gateway 在处理链早期解析：渠道 `client_relay.enabled` 且 channel 属于该 API key 且在线 → 构造 relay dialer 放入请求上下文；否则忽略（直连）或按 2.5 报错。
3. dial 时序：NUG 在该 channel 上分配 stream_id → 发 DIAL → 等 DIAL_OK（`dial_timeout_ms`）→ 把 shim 交给 transport。
4. 响应写入 `X-NUG-Egress` 头。

### 4.3 多条在线通道的选择

同一 API key 多条 relay channel 在线时：

- 请求显式携带 channel_id → 用该条（nf 知道自己的 channel_id，天然自选择）。
- **同一 conversation（`conversation_id` / prompt_cache_key 维度）的重试与 failover 必须钉在同一条 channel 上**，否则 OpenAI 看到会话中途 IP 跳变。channel 断开时，在途请求整体失败、不跨 channel 重放。

### 4.4 错误分类（关键）

中继类错误（DIAL_ERR、stream RST、channel 死亡、relay 超时）必须与上游错误区分：

- **不计入凭据健康度**（`pool` 的失败计数、禁用逻辑），不触发换号重试——用户掉线不是账号的问题。
- 映射为独立的 finalProxyErrorClassification（建议 HTTP 503 + `error.type: "client_relay_unavailable"`），消息明确指向"你的本地出口不可用"。
- 中继流在**已有部分输出后**断开：等同上游断流处理（按 Forwarded 语义决定是否可重放），但重放仍钉原 channel（4.3）。

### 4.5 可观测性

- `usage_events` 新增 `egress_mode` 列（`direct | client_relay`），用于面板分组与审计。
- 每 channel 暴露指标：在线时长、活跃 stream 数、dial 成功率、relay RTT（DIAL→DIAL_OK 耗时）、DATA 吞吐量。

## 5. nf 侧集成

### 5.1 relay client

- NUG provider 初始化时，若 `egress != "nug"`：建立 relay WSS，维护 `channel_id`，负责重连与心跳。
- 每个 codex 请求注入 `X-NUG-Relay-Channel`；中继不可用且未开 `allowNugDirectFallback` 时**直接本地失败**，不发出请求（避免 NUG 直连造成意外出口）。
- 渠道状态面板展示：中继在线状态、最近 `X-NUG-Egress` 值、出口模式。

### 5.2 dialer 与白名单（安全关键）

收到 DIAL 后：

1. **白名单校验**：目标必须是 `chatgpt.com:443`（配置里可追加 OpenAI 域名，代码内置禁止内网/环回/链路本地地址，防 NUG 被控后借 nf 扫内网）。拒绝则回 DIAL_ERR。
2. 按出口模式拨号：
   - `local-direct`：`net.dial(host:port)`。
   - `local-proxy`：向 `localProxyUrl` 发 `CONNECT host:port`（HTTP 代理）或 SOCKS5 握手。
3. 拨通后回 DIAL_OK，进入 splice 循环：socket ↔ DATA 帧，双向搬运，任何一侧 EOF/错误按 FIN/RST 语义收尾。
4. 纯四层搬运，**不解析、不记录、不缓存**任何字节。

### 5.3 配置面

设置页 NUG 渠道区块新增：

```
出口模式:  (•) 由 NUG 直连（默认）  ( ) 本地直连  ( ) 本地代理
本地代理地址: [http://127.0.0.1:7890]   （仅本地代理）
中继不可用时回退 NUG 直连: [ ] （默认关）
```

## 6. 分阶段落地

| 阶段 | 内容 | 验收 |
|---|---|---|
| 1 | NUG：relay WSS 通道 + 帧协议 + net.Conn shim + `client-relay` proxy mode（仅 HTTP/SSE 上游，WS 上游强制 `websocket_fallback` 走 SSE）；`client_relay.enabled` 配置 | 单元测试：shim 的 deadline/半关闭/背压；集成测试：内存模拟 nf 拨环回上游，完整跑通 codex SSE |
| 2 | nf：relay client + dialer + 白名单 + 配置面 + `X-NUG-Egress` 展示 | 单用户端到端：`egress=local-direct`，OpenAI 侧日志确认出口 IP 为 nf 所在 IP；凭据不出现在 nf 任何日志/转储 |
| 3 | 错误分类（不计凭据健康度、不换号）、conversation 粘性、`egress_mode` 落库、指标 | 故障注入：拨号失败/RST/通道死亡各自的客户端表现与凭据池状态 |
| 4 | codex WebSocket 上游过中继（`NetDial` 注入） | WS 模式端到端，与 SSE 路径行为对齐 |
| 5 | 多 channel 选择策略打磨、admin 面板（在线 channel 列表、relay RTT）、`local-proxy` 的 clash 联调 | 多用户多机联调 |

## 7. 已知限制

- 首字节延迟多一个 nf↔NUG RTT；SSE 流式起来后影响不大，WS 上行交互较敏感。
- 用户 nf/网络质量直接决定上游连接质量；这是模式的固有耦合。
- 带外请求（usage 刷新等）仍从 NUG 直连，OpenAI 会看到账号同时从 NUG IP 与用户 IP 活动（见 1.2）。
- 用户的 clash 若是 HTTP/SOCKS 代理，nf→clash 段明文（仅 CONNECT 握手，无凭据）；TLS 从 clash 出口之后才建立的说法不成立——TLS 终点在 NUG，但 CONNECT 之后立即是 TLS ClientHello，凭据始终不出现在明文段。
