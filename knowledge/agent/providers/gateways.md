---
id: agent.providers.gateways
title: 网关类提供商
summary: NUG、TokenDance、CommandCode 与 OpenCode 等经网关或中转接入的提供商：适配器委托、图片去重、出口中继、路由与恢复动作。
anchors:
  - server/lib/agent/nug-provider.ts
  - server/lib/agent/nug-image-dedup.ts
  - server/lib/agent/nug-delegate-config.ts
  - server/lib/agent/gateway-events.ts
  - server/lib/nug-relay/
  - server/routes/nug.ts
  - server/lib/agent/tokendance-provider.ts
  - server/lib/tokendance-runtime.ts
  - server/services/tokendance-service.ts
  - server/routes/tokendance.ts
  - shared/tokendance.ts
  - frontend/lib/api/tokendance.ts
  - frontend/lib/tokendance-recovery.ts
  - frontend/components/providers/tokendance-flow.ts
  - frontend/components/settings/TokenDanceRechargeDialog.tsx
  - frontend/components/settings/TokenDanceRecoveryHost.tsx
  - frontend/routes/settings/providers.tokendance.callback.tsx
  - frontend/lib/qr.ts
  - server/lib/agent/commandcode-provider.ts
  - server/lib/commandcode-manager.ts
  - server/lib/commandcode-models.ts
  - server/lib/commandcode-protocol.ts
  - server/routes/commandcode.ts
  - frontend/lib/api/commandcode.ts
  - server/lib/agent/opencode-session.ts
  - shared/opencode-go-endpoint.ts
  - frontend/components/providers/channel-health.ts
keywords:
  - NugProvider
  - NUG
  - TokenDance
  - TokenDanceProvider
  - CommandCode
  - OpenCode Go
  - nug-relay
  - /v1/relay
  - /api/nug
  - /api/tokendance
  - /api/commandcode
  - x-opencode-session
  - imageRef
  - top_up_balance
  - reauthorize_api_key
  - api_key_quota
  - ~/.commandcode/auth.json
  - 渠道健康
  - relay-status
status: draft
verified_at: 776dbf07e
---
# 网关类提供商

这几类不自己实现完整线协议，而是委托通用适配器并经网关或中转出站：NUG（统一网关）、TokenDance、CommandCode，以及按主机识别的 OpenCode 网关。

## 关键规则
- `NugProvider` 内部委托 Anthropic/OpenAI 并走 NUG 网关；`TokenDanceProvider` 按所选协议委托 Anthropic/Gemini/OpenAI；CommandCode 不写新适配器，按模型选 Anthropic 或 OpenAI 适配器（`commandcode-protocol.ts`、`commandcode-models.ts`）。
- NUG 图片去重：每张图带内容哈希 `imageRef`，网关确认缓存后才去掉内联数据只发引用，请求结束（成败皆然）必须还原；网关 409 缓存未命中则丢弃该确认并内联重发（`nug-image-dedup.ts`）。该逻辑只在 NUG 路径使用。
- NUG 客户端出口中继（`server/lib/nug-relay/`）：出口模式为本地直连/代理的 NUG 提供商，保持一条到网关 `/v1/relay` 的 WSS 连接，按严格白名单（默认只有 `chatgpt.com`）响应拨号请求；客户端随 `NugProvider` 构造惰性创建。
- NUG 路由 `/api/nug`：模型列表与 `/relay-status`、渠道健康、账单订单、登录与 OAuth（`routes/nug.ts`）；网关事件在 `gateway-events.ts`。NUG 模型缓存与刷新见 [模型目录与来源](../model-catalog/sourcing.md)。
- TokenDance：`/api/tokendance/*`（OAuth 开始/完成/取消/恢复、连接、模型刷新、支付会话、余额）；恢复动作 `top_up_balance` / `reauthorize_api_key` / `api_key_quota` 由前端 `tokendance-recovery.ts` 转成对话框事件，只认自家诊断（`shared/tokendance.ts`、`services/tokendance-service.ts`）。
- CommandCode：`/api/commandcode/{status,usage,models/refresh}`；凭据取设置页 API key，缺省回退 CLI 的 `~/.commandcode/auth.json`（`commandcode-manager.ts`）；按模型选 Anthropic 或 OpenAI 端点。
- OpenCode Go 的 `x-opencode-session` 路由头让同一会话落到同一上游以命中缓存，按主机判断是否 OpenCode 网关（`opencode-session.ts`）。
- 逐模型协议切换集合里 tokendance 取目录声明、CommandCode 除 `gemini-compatible` 外全部、NUG 不可切换，见 [适配器与历史构造](adapters.md)。

## 从哪读起
- `server/lib/agent/nug-provider.ts`、`tokendance-provider.ts`、`commandcode-provider.ts`：三个适配器。
- `server/routes/nug.ts`、`tokendance.ts`、`commandcode.ts`：对应路由。
- 设置页区块 `NUGProvidersSection`、`TokenDanceSection`、`CommandCodeSection` 见 [设置页与路由](settings-ui.md)。
- 测试：`agent/__tests__/nug-*.test.ts`、`tokendance-provider.test.ts`、`opencode-session.test.ts`、`gateway-events.test.ts`；`routes/__tests__/commandcode-routes.test.ts`。

## 改它时
- 改 NUG 图片去重要保证「请求结束（成败皆然）必须还原内联数据」，见 `nug-image-dedup.test.ts`、`nug-tool-images.test.ts`。
- 改出口中继：`nug-proxy.test.ts`、`nug-anonymous-protocol.test.ts`；白名单默认只有 `chatgpt.com`，加主机前先确认安全。
- 新增 TokenDance 恢复动作：`shared/tokendance.ts`、`tokendance-recovery.ts`、`TokenDanceRecoveryHost` 一起改，`tokendance-provider.test.ts` 回归。
- 改 CommandCode 端点选择：`commandcode-protocol.ts` 与 `commandcode-routes.test.ts`。
- 新增会拉取或展示额度的网关，额度部分放 [供应商余额与额度](../provider-quota.md)，不要放进适配器。

## 相关
- [模型提供商](index.md)
- [适配器与历史构造](adapters.md)
- [设置页与路由](settings-ui.md)
- [供应商余额与额度](../provider-quota.md)
