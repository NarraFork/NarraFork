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
  - frontend/hooks/useScheduledTasks.ts
  - frontend/lib/api/scheduled-tasks.ts
  - frontend/lib/cron-presets.ts
  - frontend/routes/scheduled-tasks/$taskId.tsx
  - frontend/routes/scheduled-tasks/index.tsx
  - server/lib/cron.ts
  - server/lib/validators/scheduled-tasks.ts
  - shared/scheduled-task-cleanup.ts
  - shared/scheduled-task-run-context.ts
keywords:
  - /api/scheduled-tasks
  - scheduled_tasks
  - scheduled_task_runs
  - cron
  - cleanupPolicy
  - narratorMode
  - permissionMode
  - circuit breaker
  - 断路器
  - ScheduledTask 工具
  - runContext
  - 定时
status: draft
verified_at: 2e6441ad0
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

- 前端：`useScheduledTasks.ts` 与 `lib/api/scheduled-tasks.ts` 调 `/api/scheduled-tasks`；列表页与 `$taskId` 详情页在 `frontend/routes/scheduled-tasks/`；`cron-presets.ts` 把“每 N 分钟/每小时/每天/每周/自定义”与 cron 互转（`presetToCron`、`cronToPreset`）。
- 运行上下文：`shared/scheduled-task-run-context.ts:normalizeRunContext` 把非 `standalone` 的旧值（含已移除的 `chapter`）一律当 `project`。
- 叙述者也能通过 `ScheduledTask` 工具（`server/lib/agent/tools/scheduled-task.ts`，归 [流程与协作工具](../agent/tools/workflow.md)）管理任务。

## 从哪读起
- `server/services/scheduled-task-service.ts`：`scheduledTaskService`（CRUD、`runTask`、`launchNarrator`）。
- `server/services/scheduled-task-scheduler.ts`：轮询器。
- `server/services/scheduled-task-cleanup.ts`：任务产出叙述者的保留与清理。

## 改它时
- 加任务字段：`schema.ts:scheduledTasks` → `bun run db:generate`，`validators/scheduled-tasks.ts`、`routes/scheduled-tasks.ts`、前端 `lib/api/scheduled-tasks.ts` 与创建/详情页一起改；表要进数据导入导出时看 `data-portability.ts`（是否包含这两张表：未核实）。
- 改调度节奏（30s 轮询）、断路器阈值（5 次）或启动恢复：`scheduled-task-scheduler.ts`、`scheduled-task-service.ts`；`scheduled-task-principal.test.ts`、`scheduled-task-cleanup.test.ts`、`scheduled-task-list-cap.test.ts` 会断言身份判定、清理和列表上限。
- 不变量：错过的任务启动时不补跑；`runTask` 按任务 id 加锁；“成功”只代表已派发；清理策略默认 `none`，只有创建者或管理员能设。

## 相关
- 插件有自己的调度（`server/services/plugin-scheduler.ts`），见[插件系统](plugins/index.md)；不要与这里混淆。
