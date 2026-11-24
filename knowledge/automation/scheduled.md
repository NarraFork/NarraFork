---
id: automation.scheduled
title: 定时任务
summary: 定时任务的存储、触发与运行记录。
anchors:
  - server/services/scheduled-task-service.ts
  - server/services/scheduled-task-scheduler.ts
  - server/services/scheduled-task-cleanup.ts
  - server/routes/scheduled-tasks.ts
  - server/db/schema.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 定时任务

按 cron 表达式周期性地启动（或复用）一个叙述者并注入提示词，无人值守运行。任务存在 `scheduled_tasks` 表，每次运行写一行 `scheduled_task_runs`。

## 关键规则
- 存储：cron（5 或 6 段）、可选 IANA 时区（空则服务器本地时间）、`prompt`/`systemPrompt`/`model`、`permissionMode`（默认 `bypassPermissions`）、`runContext`（`standalone | project`）、`narratorMode`（`new | reuse`）、`cleanupPolicy`（默认 `{mode:"none"}`）、`lastStatus`（`success | failed | skipped`）（`schema.ts:scheduledTasks`）。
- 调度器每 30s 轮询一次到期任务（`enabled` 且 `nextRunAt <= now`），并发触发各任务；上一轮未结束或关机围栏生效时跳过本轮（`scheduled-task-scheduler.ts:tick`）。
- 启动时只重新计算下次触发时间，不补跑错过的任务（`recoverOnStartup`）。
- `runTask` 按任务 id 加锁；先把 `nextRunAt` 重新排好（失败也不会卡住计划），手动触发不改动 cron 节奏（`runTask`）。
- “成功”仅表示已派发，不代表 loop 结束；目标叙述者已在运行则记 `skipped`；project 模式缺 projectId 或项目不存在也是 `skipped`（`launchNarrator`）。
- 断路器：同一任务连续失败 5 次自动置 `enabled=false`；计数在内存中，重启清零（`CIRCUIT_BREAKER_THRESHOLD`）。
- 运行身份是创建者，按其当前角色实时判定权限；无创建者则按最小权限（`principalForTask`）。reuse 模式只在叙述者对该身份可写且未归档时复用，否则新建。
- 运行历史按 `createdAt` 游标分页（`LIMIT n+1`，不做 COUNT）；列表最多 500 条（`listRuns`、`LIST_MAX`）。
- 清理策略是任务级、需显式开启的破坏性保留；每次运行结束后尝试清理，失败只告警；设置 `cleanupPolicy` 与手动 `POST /:id/cleanup` 仅限创建者或管理员（`routes/scheduled-tasks.ts`、`scheduled-task-cleanup.ts`，每次扫描根上限 `TASK_CLEANUP_ROOT_LIMIT=10`）。
- 路由 `/api/scheduled-tasks`：列表、读取、创建、更新、`/toggle`、`/run`、`/runs`、`/cleanup`、删除。

## 从哪读起
- `server/services/scheduled-task-service.ts`：`scheduledTaskService`（CRUD、`runTask`、`launchNarrator`）。
- `server/services/scheduled-task-scheduler.ts`：轮询器。
- `server/services/scheduled-task-cleanup.ts`：任务产出叙述者的保留与清理。

## 相关
- 插件有自己的调度（`server/services/plugin-scheduler.ts`），见[插件系统](plugins.md)；不要与这里混淆。
