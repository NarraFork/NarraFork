---
id: agent.tools.interaction
title: 与人交互的工具
summary: Notification、Send、ShareFile、GenUI。
anchors:
  - server/lib/agent/tools/notification.ts
  - server/lib/agent/tools/send.ts
  - server/lib/agent/tools/share-file.ts
  - server/lib/agent/tools/gen-ui.ts
  - server/services/notification-service.ts
  - server/services/bot-chat.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 与人交互的工具

让 Agent 把东西递给人：站外通知、给人或子代理发消息、临时下载链接、会话内渲染界面。Send 属于 core，另三个是可选工具（`tools/index.ts:OPTIONAL_TOOLS`：ShareFile、GenUI、Notification）。

## 关键规则
- Send 有两种互斥用法。给子代理发消息（`id/ids/name/names`，子代理可用 `parent` 找父叙述者；`doInterrupt`、`resume`、`model` 仅用于直接子代理）；给人发消息（`user`，仅 Bot 叙述者）。`user` 非空串才进入 Bot 模式，且不能与代理目标、`resume`、`model` 同用（`send.ts:sendToUser`）。
- `sendToUser` 调用 `bot-chat.ts:sendAsBot`：目标叙述者不带 bot trait 则抛 `ValidationError`；收件人按用户名解析（先精确匹配，再唯一的不区分大小写匹配，容忍前导 `@`）；消息写入该人与 Bot 的聊天，不唤醒会话，也没有送达回执；文本最多 32000 字符（描述中的上限，未在此处单独核实实现）。
- `show_to_user` 只改变代理间消息在概览里的展示（折叠成一行 vs 展开），不影响送达与权限；对 `Send({user})` 忽略。
- Notification：`list_channels` 查询某个确切用户的钉钉/飞书渠道状态，`send` 主动发送；必须恰好给 `user_id` 或 `username` 之一，不能枚举用户；`title` ≤120、`message` ≤4000，`channels` 最多 2 个且去重，选中但不可用的渠道不发送也不改投。只读或严格计划模式、或叙述者已不存在时拒绝发送（`NotificationSendForbiddenError`）；其他错误统一返回通用文案，避免泄露查询或 webhook 地址。
- ShareFile：生成临时下载链接，默认有效期取 `settings.shares.defaultExpiryHours`，缺省 24 小时；目录自动打成 .tar.gz，单文件可选 gzip，传路径数组则打成 .zip（最多 128 个来源）。归档子进程有 5 分钟硬超时和 8KB 的 stderr 上限（`share-file.ts:runArchiver`）；分享前对来源做隐私扫描（`assertRecordingShareSource`，5 秒期限）；`preview: true` 让聊天卡片内联预览。链接任何持有 URL 的人都能访问。
- GenUI：动作 `render`（以类 JSX 的“数据”渲染 Mantine/HTML，非代码；`bind` 保存控件状态，`sendPrompt`/`submit`/`openLink` 是唯一的回传手势，`wait:true` 时调用挂起直到用户 submit）、`create` + `show`（完整 React 应用，目录在 `GEN_UI_DIRECTORY`）、`inspect`、`kit_build`、`kit_status`。各动作的参数组合在入参校验里强制（`gen-ui.ts`）。

## 从哪读起
- `server/lib/agent/tools/send.ts`、`server/services/bot-chat.ts`
- `server/services/notification-service.ts`
- `server/lib/agent/tools/share-file.ts`
- `server/lib/agent/tools/gen-ui.ts`
- 测试：`tools/__tests__/send-navigation.test.ts`、`share-file-archiver.test.ts`

## 相关
- [子代理](../subagents.md)
- [工具体系](index.md)
