---
id: remote.vnet
title: 虚拟网络中转
summary: 基于 WebSocket 中转的虚拟网络（/ws/vnet）：中继 hub、对端寻址、端到端加密、UDP 打洞协助，与 WebRTC 远程访问无关。
anchors:
  - server/lib/vnet/
  - server/routes/vnet.ts
  - server/websocket/vnet-ws.ts
  - server/http-dispatcher.ts
  - tests/server/lib/vnet-relay.test.ts
keywords:
  - vnet
  - 虚拟网络
  - /ws/vnet
  - /api/vnet/status
  - VNetRelayHub
  - VNetNode
  - vnet.enabled
  - vnet.relayToken
  - vnet.allowAnonymousRelay
  - vnet.maxPeersPerNetwork
  - vnet.maxMessageBytes
  - PEER_REPLACED
  - VIRTUAL_IP_IN_USE
  - NETWORK_FULL
  - relay_packet
  - punch_probe
  - UDP 会合
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 虚拟网络中转

vnet 让一组对端（peer）加入同一个"网络"，按虚拟 IP 互相发数据报；本服务充当中继（relay）和可选的 UDP 会合点。它与 `remote-access`（WebRTC）没有代码依赖。

## 关键规则
- 入口 `/ws/vnet`：`vnet.enabled` 为假时升级直接拒绝；认证依次为：token 等于 `vnet.relayToken` → `relay-token`；有效会话令牌 → `session`；否则仅当 `allowAnonymousRelay`（默认关）才放行为 `anonymous`，其余 401（`http-dispatcher.ts:resolveVNetRelayAuth`）。令牌取自 Bearer 头或 `?token=`。
- 中继只转发密文：`VNetRelayHub`（`lib/vnet/relay.ts`）按 `hello` 登记 `networkId` + `peerId` + `virtualIp`，之后 `relay_packet` 按 `toPeerId` 或 `dstIp` 查找目标；服务端不解密。
- 中继校验：同一 peerId 重连会顶掉旧连接（`PEER_REPLACED`）；虚拟 IP 被他人占用拒绝（`VIRTUAL_IP_IN_USE`）；超过 `maxPeersPerNetwork`（默认 64）拒绝（`NETWORK_FULL`）；`srcIp`/`dstIp` 必须与发送方/目标一致。
- 大小限制两层：WS 收到原始帧时先按 `maxMessageBytes`（默认 1 MiB）拒绝，hub 内再按 JSON 字节数检查（`ws-handler.ts`、`relay.ts:handleClientMessage`）。心跳沿用全局 WS 心跳，超时关闭。
- 客户端加密由 `lib/vnet/node.ts:VNetNode` 完成：网络名 + 密钥经 HKDF/HMAC 派生 `networkId`、AES-GCM 包密钥，元数据作为 AAD（`crypto.ts`）。仓库内只见到测试使用 `VNetNode`，生产调用方未核实。
- UDP 会合（`udp-rendezvous.ts`）：`hello` 时按连接随机发放 `sessionId` 与 `udpAuthToken`；UDP 包带 HMAC，验证通过后记录该对端观察到的 UDP 端点并广播 `peer_update`，`punch_probe` 则向目标发 `punch_offer`。启动失败只记日志并回退到中继，不影响 WS。
- 设置：`settings.vnet`（默认启用、UDP 启用、端口 0）。设置变更时 `routes/settings.ts` 关闭所有现有 vnet 连接并重启 UDP 会合；`relayToken` 在读取接口中脱敏，提交脱敏值时保留原值。
- `GET /api/vnet/status` 返回 hub 统计（网络数、对端数、连接数）与 UDP 状态，走普通 `/api/*` 会话鉴权。

## 从哪读起
- `server/lib/vnet/relay.ts`：hub 与消息处理。
- `server/lib/vnet/udp-rendezvous.ts`：UDP 服务与签名。
- `server/websocket/vnet-ws.ts`：连接集合与关闭。
- `server/routes/vnet.ts`：只有 `GET /api/vnet/status`（hub 统计 + UDP 会合状态），挂在 `/api/vnet`；`server/lib/vnet/index.ts` 统一导出。

## 改它时
- 加一种 relay 消息：`server/lib/vnet/protocol.ts`（类型与解析）、`relay.ts:handleClientMessage`、必要时 `types.ts`；密文规范相关改动在 `crypto.ts`（`canonicalJson` 参与 AAD，改它会让两端互不相认）。
- 加设置项：`server/lib/settings/defaults.ts` 与 `types.ts` 的 `vnet.*`，并在 `routes/settings.ts` 里决定变更后是否需要关连接/重启 UDP 会合；`relayToken` 的读取脱敏逻辑也在那里。
- 测试：`tests/server/lib/vnet-relay.test.ts`、`vnet-crypto.test.ts`、`vnet-protocol.test.ts`。没有 `*.guard.test.ts` 专门守这块。
- 不能破：中继只转发密文、不解密；`/ws/vnet` 在 `vnet.enabled` 为假时必须拒绝升级；匿名放行只能由 `allowAnonymousRelay` 显式打开。

## 相关
- [远程访问](remote-access.md)
