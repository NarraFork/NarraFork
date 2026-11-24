---
id: collaboration.gateway
title: IM 网关
summary: IM 平台接入（Telegram/Discord/Slack/飞书/微信/QQ/Webhook）、会话映射、命令；钉钉不在网关里。
anchors:
  - server/gateway/
  - server/routes/gateway.ts
  - server/db/schema.ts
  - frontend/components/settings/GatewaySection.tsx
  - frontend/routes/settings/gateway.tsx
keywords:
  - /api/gateway
  - /api/gateway/webhook
  - gateway_session_mappings
  - gateway_config
  - GATEWAY_ENABLED
  - GATEWAY_RATE_LIMIT_PER_MINUTE
  - GATEWAY_SESSION_IDLE_MINUTES
  - GATEWAY_STREAMING
  - GATEWAY_WEBHOOK_SECRET
  - TELEGRAM_BOT_TOKEN
  - 网关
  - IM 接入
  - 微信扫码登录
  - /new
  - /approve
status: draft
verified_at: 2e6441ad0
---
# IM 网关

把 IM 平台和叙述者桥接起来：入站是 IM 消息 → 找到或新建叙述者 → `sendMessage`；出站是监听事件总线上的叙述者事件，流式或整条回发到 IM（`server/gateway/gateway.ts` 头注释与实现）。

## 关键规则
- 平台清单是 `GATEWAY_PLATFORMS`：telegram、discord、slack、feishu、webhook、weixin、qqbot（`server/gateway/types.ts`）。网关目录下没有钉钉实现；钉钉只作为"外部提醒"的 webhook 渠道存在，见 [通知与注意力](notifications.md)。
- 会话映射表 `gateway_session_mappings`：`(platform, chat_id, user_id)` 唯一，指向一个叙述者（叙述者删除时级联删除映射），可带 `project_id`、`app_user_id`（两者在项目/用户删除时置空）；还有 `last_message_at`。
- 入站顺序（`gateway.ts:handleInboundMessage`）：按 `platform:userId` 限流（默认每分钟 20 条，`rateLimitPerMinute` 配成 0 则不限；超限回一句提示后丢弃）→ 解析命令 → 通过引用消息批准/拒绝权限（`handlePermissionByQuote`）→ 转发给绑定叙述者（`forwardToNarrator`）。
- 空闲重置：`sessionIdleMinutes`（默认 0 即关闭）大于 0 时，映射超过该时长没有新消息就删除并新建，回复一句"会话已过期"（`getOrCreateMapping`）。
- 命令（`handleCommand`）：`/new`（同 `/reset`，删除映射，下条消息新建叙述者）、`/model`、`/status`、`/stop`、`/list`、`/search`、`/switch`、`/approve`、`/deny`、`/help`。
- IM 发送者没有经过验证的 NarraFork 身份：新映射的 `appUserId` 由 `resolveGatewayAppUserId` 取用户表中最早创建的 5 个用户：只有一个就用它；多个时取其中第一个管理员，其中没有管理员则取最早创建的。该 id 会成为该轮对话读知识库的 ACL 主体，不只是显示用。
- 团队会话不能从 IM 驱动（原因：发送者身份不可证，会污染多人共享对话的发言归属），逐分支：
  - 普通消息：映射指向团队叙述者（协调者或其子代理）时不转发，回复"请去 NarraFork"（`forwardToNarrator` 里的 `refuseTeamSession`）。
  - `/model`、`/status`、`/stop`、`/approve`、`/deny`：映射指向团队叙述者时同样拒绝，`/status` 也不透露任何状态。
  - 引用消息批准/拒绝：被等待的是团队叙述者的调用时拒绝（`refuseTeamDecision`）。
  - `/switch`：先过项目检查，再拒绝切到团队会话（先检查项目是为了不让发送者借此探测别的项目里哪些 id 是团队）。
  - `/new`、`/reset`、`/list`、`/search`：不受此限制。
  - 出站：团队会话的流式回复、工具/权限消息、错误和最近标签页状态提醒一律不发（`isTeamSession`）；唯一例外是 `notification-service.ts` 的"等待成员"提醒（见[通知与注意力](notifications.md)）。
- 配置：来自第一个管理员用户的偏好 `user_preferences.gateway_config`，与环境变量合并，环境变量优先（`server/gateway/config.ts`：各平台 `TELEGRAM_BOT_TOKEN`、`DISCORD_BOT_TOKEN`、`SLACK_BOT_TOKEN`+`SLACK_APP_TOKEN`、`FEISHU_APP_ID/SECRET`、`GATEWAY_WEBHOOK_SECRET`、`WEIXIN_TOKEN`、`QQ_APP_ID` 等，以及 `GATEWAY_ENABLED`、`GATEWAY_RATE_LIMIT_PER_MINUTE`、`GATEWAY_SESSION_IDLE_MINUTES`、`GATEWAY_STREAMING`、`GATEWAY_DEFAULT_PERMISSION_MODE`、`GATEWAY_DEFAULT_PROJECT_ID`）；`reload` 可只重载指定平台。
- 流式回发：`stream-consumer.ts` 监听该叙述者的 `narrator:ws_broadcast` 事件，累积文本增量，周期性编辑同一条 IM 消息，工具边界处收尾并另起一条，带限流自适应退避；只在 `streaming` 不为 false（默认开）且平台适配器支持编辑（`supportsEdit`）时启用。
- 路由：`/api/gateway` 的 `status`、`reload`、`sessions`（GET 列表、DELETE `:id`）、`weixin/qr-start`、`weixin/qr-poll`；webhook 入口 `POST /api/gateway/webhook` 在 `app.ts` 中公开挂载，靠 HMAC-SHA256 签名校验而非会话令牌（`platforms/webhook.ts`）。路由文件内没有单独的管理员检查：是否需要登录取决于 `app.ts` 的全局挂载（未逐项核实）。

## 从哪读起
- `server/gateway/gateway.ts`：单例 `gateway`，启动/停止/重载、入站、命令、出站。
- `server/gateway/base-adapter.ts`、`types.ts`：适配器基类与 `PlatformAdapter` 接口。
- `server/gateway/platforms/`：各平台适配器。
- 测试：`server/gateway/__tests__/`（stream-consumer 中止、worker 准入、微信媒体等）。

## 前端
- `frontend/routes/settings/gateway.tsx` + `components/settings/GatewaySection.tsx`：网关设置页（平台开关、凭据、重载、微信扫码），读写用户偏好里的网关配置。
- `frontend/routes/settings/integrations.tsx` 与 `frontend/lib/api/integrations.ts` 是"集成"汇总页（OAuth 应用、插件、设备），其中没有网关内容，不属于本节点。

## 改它时
- 加一个 IM 平台：`server/gateway/types.ts` 的 `GATEWAY_PLATFORMS` 与配置类型、`config.ts` 的环境变量读取、`gateway.ts` 里创建适配器的 `switch`（约 348 行起）、`platforms/` 下继承 `BaseAdapter` 的适配器；`routes/gateway.ts` 的 reload 用 `GATEWAY_PLATFORMS` 过滤平台名。
- 加一条命令：`handleCommand` 的分支与 `/help` 文本、`server/lib/i18n.ts` 里 `gateway.*` 文案；凡会驱动或透露会话状态的命令都要先过 `refuseTeamSession`，否则破坏"团队会话不受 IM 驱动"。
- 加出站通知类型：必须先判断 `isTeamSession`；测试 `server/gateway/__tests__/recent-tabs-consumers.test.ts`、`stream-consumer-abort.test.ts`、`worker-admission.test.ts`。
- 改 `gateway_session_mappings`：`server/db/schema.ts` 与 `postgres-schema.ts` 两处；该表不在 `snapshot-protocol.ts` 的导出清单里，不随数据导出。

## 相关
- [通知与注意力](notifications.md)
- [团队](teams/index.md)
