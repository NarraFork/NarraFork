---
id: collaboration.gateway
title: IM 网关
summary: IM 平台接入（Telegram/Discord/Slack/飞书/微信/QQ/Webhook）、会话映射、命令；钉钉不在网关里。
anchors:
  - server/gateway/
  - server/routes/gateway.ts
  - server/db/schema.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# IM 网关

把 IM 平台和叙述者桥接起来：入站是 IM 消息 → 找到或新建叙述者 → `sendMessage`；出站是监听事件总线上的叙述者事件，流式或整条回发到 IM（`server/gateway/gateway.ts` 头注释与实现）。

## 关键规则
- 平台清单是 `GATEWAY_PLATFORMS`：telegram、discord、slack、feishu、webhook、weixin、qqbot（`server/gateway/types.ts`）。网关目录下没有钉钉实现；钉钉只作为"外部提醒"的 webhook 渠道存在，见 [通知与注意力](notifications.md)。
- 会话映射表 `gateway_session_mappings`：`(platform, chat_id, user_id)` 唯一，指向一个叙述者，可带 `project_id` 与 `app_user_id`；叙述者删除时映射级联删除。
- 入站顺序：按 `platform:userId` 限流 → 解析命令 → 通过引用消息批准/拒绝权限 → 转发给绑定叙述者（`gateway.ts:handleInboundMessage`）。
- 命令：`/new`（`/reset`，删除映射，下条消息新建叙述者）、`/model`、`/status`、`/stop`、`/list`、`/search`、`/switch`、`/approve`、`/deny`、`/help`（`handleCommand`）。
- IM 发送者没有经过验证的 NarraFork 身份：新映射的 `appUserId` 由 `resolveGatewayAppUserId` 自动选取（只有一个用户则取它，多用户优先管理员，否则最早创建的用户）。
- 团队会话不能从 IM 驱动：协调者及其子代理的映射收到消息、命令或批准时一律拒绝并提示去 NarraFork（`refuseTeamSession`、`refuseTeamDecision`），原因是发送者身份不可证，会污染多人共享对话的发言归属。
- 配置来自管理员用户偏好中的网关配置，并与环境变量合并，环境变量优先（`server/gateway/config.ts`）；`reload` 可只重载指定平台。
- 流式回发：`stream-consumer.ts` 监听该叙述者的 WS 广播，累积文本增量，按最小间隔与字符阈值编辑同一条 IM 消息，工具边界处收尾并另起一条，并带限流自适应退避。
- 路由：`/api/gateway` 的 status、reload、sessions（列表与删除）、weixin 扫码登录（qr-start / qr-poll）；webhook 入口 `POST /api/gateway/webhook` 在 `app.ts` 中公开挂载，靠 HMAC 校验而非会话令牌。

## 从哪读起
- `server/gateway/gateway.ts`：单例 `gateway`，启动/停止/重载、入站、命令、出站。
- `server/gateway/base-adapter.ts`、`types.ts`：适配器基类与 `PlatformAdapter` 接口。
- `server/gateway/platforms/`：各平台适配器。
- 测试：`server/gateway/__tests__/`（stream-consumer 中止、worker 准入、微信媒体等）。

## 相关
- [通知与注意力](notifications.md)
- [团队](teams.md)
