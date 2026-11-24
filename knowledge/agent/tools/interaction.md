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
  - frontend/components/gen-ui/
  - server/routes/gen-ui.ts
  - server/services/agent-communication.ts
  - server/services/gen-ui/
  - server/services/legacy-send-await.ts
  - shared/communication-tool.ts
  - shared/gen-ui-files.ts
  - shared/gen-ui-kit.ts
  - shared/gen-ui-markup.ts
  - shared/gen-ui-preview-shell.ts
  - shared/gen-ui-public.ts
  - shared/gen-ui-tool-policy.ts
keywords:
  - Send
  - Notification
  - ShareFile
  - GenUI
  - Bot 聊天
  - Send({ user })
  - sendAsBot
  - show_to_user
  - 钉钉
  - 飞书
  - 临时下载链接
  - kit.json
  - .narrafork/gen_ui
  - render
  - kit_build
  - parent 选择器
  - send_await
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
- `server/services/agent-communication.ts`：给子代理发消息的服务端实现（`resolveSubagentTargets` 解析 `id/ids/name/names` 与别名，`sendSubagentMessageDetailed` 投递并返回每个目标的送达结果）；父级选择器 `parent`、`main`、`@parent`、`@main`（不区分大小写、先于同级别名解析）在 `shared/communication-tool.ts`，同一文件的 `isCommunicationTool` 把 `Send` 与 `TeamStatus` 的 `send`/`broadcast` 动作认作「通信」，供送达回执与交接去重使用。文件里的 `awaitAgentResultDetailed` / `waitForSubagentResult` 现在由 Watch 的 agent 观察使用（`watch-service.ts`）。
- `server/services/legacy-send-await.ts`：已退役的 `Send({ await: true })`。Send 不再等待，对方用自己的 Send 回复，作为普通消息唤醒请求者；旧进程在计划内更新时可能留下 `send_await` 检查点，恢复只按检查点记录的结果收尾，不重新发送消息。
- GenUI 共享约定（`shared/gen-ui-*.ts`）：UI 源文件是普通工作区文件，目录 `.narrafork/gen_ui`，入口 `App.tsx`（`gen-ui-files.ts`）；组件库 kit 在 `.narrafork/gen_ui/kit`，由 `kit.json` 声明、宿主生成入口与 Vite 配置并构建，浏览器只看到宿主签收过的 `dist/`（`gen-ui-kit.ts`，清单 ≤256KiB、组件 ≤200）；`render` 的标记是数据而非代码（`gen-ui-markup.ts`）；预览壳（`gen-ui-preview-shell.ts`）；公开转录与可移植导出里 GenUI 卡片是静态的，预览引用不授予对活资源的访问（`gen-ui-public.ts`）；权限闸用无依赖的动作表（`gen-ui-tool-policy.ts`）。

## 改它时
- 给 Send 加目标选择方式：改 `send.ts` 的参数与 `agent-communication.ts:resolveSubagentTargets`；`user` 模式只给 Bot 叙述者，不能与代理目标、`resume`、`model` 同用，要保持。新增通信类工具/动作要加进 `isCommunicationTool`，否则送达回执与交接去重会漏。
- 改 Notification：渠道发送失败不得改投其他渠道，错误统一返回通用文案；校验在工具层与 `notification-service.ts`，见 `tests/server/services/notification-tool-registration.test.ts`。
- 改 ShareFile：归档子进程保持 5 分钟硬超时与 stderr 上限，分享前的隐私扫描不能去掉；测试 `share-file-archiver.test.ts`。
- 改 GenUI：新增动作要同时改 `gen-ui-tool-policy.ts` 的动作表（权限闸只依赖它）、`gen-ui.ts` 的参数组合校验与 `routes/gen-ui.ts`；公开转录里卡片必须保持静态。
- 测试：`tools/__tests__/send-navigation.test.ts`、`send-*`、`services/gen-ui/` 下的单测。

## 相关
- [子代理](../subagents.md)
- [工具体系](index.md)
