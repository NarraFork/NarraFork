---
id: automation.hooks
title: 钩子
summary: 钩子配置与触发。
anchors:
  - server/services/hook-service.ts
  - server/services/attention-hook-bridge.ts
  - server/routes/hooks.ts
  - server/services/agent-runtime/orchestrator.ts
  - frontend/hooks/useHooks.ts
  - server/lib/validators/hooks.ts
keywords:
  - /api/hooks
  - PreToolUse
  - PostToolUse
  - Stop
  - Attention
  - AttentionResolved
  - hook:executed
  - hooks 表
  - matcher
  - hookHandler
  - stopHooks
  - 钩子
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 钩子

用户配置的命令或 HTTP 回调，在叙述者运行的固定事件点被触发；`PreToolUse` 的钩子可以阻止工具调用。配置存在 `hooks` 表。

## 关键规则
- 事件五种：`PreToolUse | PostToolUse | Stop | Attention | AttentionResolved`；类型两种：`command`、`http`（`hook-service.ts:HookEvent`、`hookService.create`）。
- 匹配：事件相同且 `enabled`；钩子带 `projectId` 时只匹配该项目，`projectId` 为空的是全局钩子；`matcher` 非空时必须与工具名全等（Attention 类事件把原因 `waiting_permission|done|error` 当作匹配键）（`getMatchingHooks`、`attention-hook-bridge.ts`）。按 `sortOrder`、`createdAt` 顺序串行执行。
- 只有 `PreToolUse` 可阻塞：一旦某个钩子返回 `blocked` 就立即返回；其它事件的 `blocked` 被忽略，`error` 只记录告警、不中断，最后返回最后一个 error 或 success（`runHooks`）。
- command 钩子：固定 `spawn("bash", ["-c", …])`，没有任何回退到其他 shell 的逻辑；Windows 上没有 bash 时 spawn 触发 `error` 事件，钩子返回 `error`（原因为系统错误信息），`error` 不会阻塞。输入的 JSON 通过 stdin 传入，cwd 为叙述者目录，默认超时 30s；退出码 0 成功，2 为阻塞（原因取 stderr 否则 stdout），其它为 error；stdout/stderr 各最多保留 64KiB（`executeCommandHook`）。
- http 钩子：POST JSON，可带自定义头和代理覆盖；响应非 2xx 为 error；响应体 `decision: "block"` 为阻塞（`executeHttpHook`）。
- 每次执行发 `hook:executed` 事件（含结果与耗时），并写调试日志。
- 触发点：工具循环的 `hookHandler`（受运行时策略 `capabilities.stopHooks` 约束，关闭时直接返回 success）、回合结束的 `Stop`、注意力事件桥接（`orchestrator.ts`、`attention-hook-bridge.ts`）。
- 路由 `/api/hooks` 整体要求管理员（`routes/hooks.ts`：`requireAdmin`），含列表、`/all`、读取、创建、更新、删除。

- 前端：`useHooks.ts` 经 `api.listHooks/createHook/updateHook/deleteHook` 调 `/api/hooks`，可带 `projectId` 过滤；校验在 `validators/hooks.ts`。

## 从哪读起
- `server/services/hook-service.ts`：配置 CRUD、匹配、两种执行器。
- `server/services/attention-hook-bridge.ts`：事件总线的 attention 意图转成钩子调用。

## 改它时
- 加一种事件：`hook-service.ts:HookEvent`、`validators/hooks.ts` 的枚举、触发点（工具循环 `orchestrator.ts` 的 `hookHandler`、`attention-hook-bridge.ts`）和前端 `useHooks.ts` 的表单选项一起改；只有 `PreToolUse` 能阻塞，别让别的事件的 `blocked` 生效。
- 加执行器类型（现有 `command`/`http`）：`executeCommandHook`/`executeHttpHook` 分支、校验器和 `hook:executed` 事件的结果结构一起改。
- 不变量：钩子串行按 `sortOrder`、`createdAt`；非阻塞错误只告警；command 钩子的输出各限 64KiB、默认超时 30s。
- 本节点相关的专属守卫测试：`attention-hook-bridge.test.ts`（桥接规则）；改桥接前先读它。

## 相关
- [通知与注意力](../collaboration/notifications.md)：`Attention` / `AttentionResolved` 钩子与外部 IM 提醒消费同一组事件总线意图（`narrator:attention` / `narrator:attention_resolved`），桥接在 `server/services/attention-hook-bridge.ts`：它按叙述者解析项目后调用 `hookService.runHooks`，以注意力原因（`waiting_permission|done|error`）作匹配键。钩子收到所有注意力事件，包括通知渠道因后台工作仍在跑而压制的那些（输入里带 `background_work_active`）；外部提醒的收件人规则见该节点。
