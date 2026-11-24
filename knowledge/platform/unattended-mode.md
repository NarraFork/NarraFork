---
id: platform.unattended-mode
title: 无人值守模式
summary: 管理员布防后，所有叙述者和任务持续空闲到阈值，就走管理员关闭流程停掉 NarraFork，并在关闭完成后关机；任何不确定都按“有活”处理。
anchors:
  - frontend/components/UnattendedModeBanner.tsx
  - frontend/components/settings/UnattendedModeCard.tsx
  - frontend/lib/api/unattended.ts
  - server/lib/validators/unattended.ts
  - server/routes/unattended.ts
  - server/services/unattended-mode.ts
  - server/services/unattended-probe.ts
  - shared/unattended.ts
  - server/services/__tests__/unattended-mode.test.ts
  - server/services/__tests__/unattended-probe.test.ts
  - server/routes/__tests__/unattended.test.ts
keywords:
  - 无人值守
  - unattended
  - /api/system/unattended
  - unattended_idle
  - system:unattended_changed
  - unattended_mode_changed
  - quietSeconds
  - armDelaySeconds
  - powerOffCommand
  - 空闲关机
  - 取消关机
  - fenceUnattendedShutdown
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---

# 无人值守模式

长任务跑完后自动关机的开关：布防后，实例持续安静够久，就优雅关闭 NarraFork，再让操作系统关机。布防状态只在内存里，不落盘。

## 关键规则
- 状态机 `off → waiting → quiet → shutting_down`（`UnattendedPhase`）；`createUnattendedMode(deps)` 是可注入依赖的工厂，`unattendedMode` 是用 `hotSafe` 钉住的单例（`services/unattended-mode.ts`）。
- 不持久化：重启后一定是关闭状态，避免“启动、无活、关机、重启”的循环（文件头设计约束 1）。
- 两个独立等待：布防后至少等 `armDelaySeconds`（撤销窗口，默认下限 `MIN_UNATTENDED_ARM_DELAY_SECONDS` = 70 秒，上限 3600），并且持续安静满 `quietSeconds`（默认 120，范围 10–86400）；关机时刻是两者的较大值（`tick` 中 `readyAt`）。每 5 秒评估一次。
- 阻塞判定 `isBlocked`（`unattended-probe.ts`），任一成立即阻塞并把安静计时清零：
  - 运行时忙碌的叙述者（`listRuntimeBusyNarratorIds`，含待审批、无循环的运行时占用、准入租约）；数据库里的 `working/waiting` 行只记 `dbWorkingNarrators` 供诊断，不参与判定。
  - 进行中的压缩（`compactLocks`）。
  - 更新协调器的计数：后台 bash、普通执行、响应、预准入、工具启动授权、暂停工具；以及已排定的更新/重启/关闭（`maintenance`）。
  - 排队投递：`narrator_buffered_messages` 里 `queued/claimed` 且 `kind` 为 `user_input`/`agent_message`、会话未归档的行；`task_notice`、`failed`、归档会话的残留不算。
  - `background_tasks` 里 `running/paused`。
  - 在安静窗口内到期的启用的定时任务（`scheduled_tasks.next_run_at`）。
  - `runtime_publication_outbox` 的待发布只作信息，不阻塞。
  - 探测抛错（数据库或运行时）或 PostgreSQL 运行时未连接：`unknown: true`，视为阻塞；探测永不抛出。
- 触发：`trigger` 把阶段置 `shutting_down` 并调用 `scheduleOperatorShutdown({ reason: "unattended_idle" })`；返回 false（无处理器或已有关闭挂起）则退回 `waiting` 并标 `lastError: "shutdown_unavailable"`，下个 tick 重试，不会在没关闭 NarraFork 的情况下关机。
- 模式自己不关机：关机命令由 `power-off.ts` 经关闭后钩子执行，且钩子只在关闭原因为 `unattended_idle`、已布防、阶段为 `shutting_down` 时动手；`powerOff: false` 则只停服务（见 [操作系统集成](os-integration.md)）。
- 关闭前的最后一道门：`main.ts` 的管理员关闭处理器对该原因调用 `fenceUnattendedShutdown`——先拉起“围栏”，若此刻有在途请求/WS 处理器/定时任务 tick，或重新探测（2 秒内）不再空闲，则放弃并 `deferShutdown` 回到 `waiting`；围栏生效期间：HTTP 不再接受新请求（`http-request-lifecycle.ts`）、WS 新连接以 1012 关闭、WS 消息以 1013 关闭、定时任务 tick 跳过、没有活跃工作的叙述者准入返回 503 `SERVER_SHUTTING_DOWN`（`shutdown-activity.ts:isUnattendedShutdownFenced`；`ws-handler.ts`、`scheduled-task-scheduler.ts`、`narrator-session-state.ts`）。
- HTTP（`/api/system/unattended`，`routes/unattended.ts`，均需登录）：
  - `GET /`：管理员得到完整状态，其他用户得到脱敏视图（阶段、阻塞摘要计数，不含叙述者 id、命令、错误文本）；`no-store`。
  - `POST /`（仅管理员）：`unattendedOptionsSchema`（`.strict()`，越界拒绝而非夹取）；`enabled: true` 布防，若已在 `shutting_down` 返回 409；`enabled: false` 撤防。
  - `POST /cancel`：任何已登录用户都能撤防（安全阀），无参数；已开始关闭则 409；响应按调用者角色决定完整或脱敏。
- 状态变化经事件总线 `system:unattended_changed` → `narrator-ws.ts` 广播 `unattended_mode_changed`；前端横幅收到后重新拉取，并按 5 秒（布防时）/ 60 秒轮询兜底。
- 前端：`UnattendedModeBanner` 在 `AuthenticatedAppLayout` 与 `StandaloneWindowLayout` 里常驻，布防时显示倒计时或第一个阻塞原因，任何用户可点取消；`UnattendedModeCard` 在设置页服务器系统分区，只对管理员渲染。

## 从哪读起
- `server/services/unattended-mode.ts:createUnattendedMode`：`tick`、`trigger`、`enable/disable`。
- `server/services/unattended-probe.ts:probeUnattendedIdle`：判定来源。
- `server/main.ts` 搜 `UNATTENDED_SHUTDOWN_REASON`：与关闭流程的衔接。

## 改它时
- 新增一种“还有活”的来源：加进 `UnattendedBlockers`、`emptyUnattendedBlockers`、`isBlocked`，并把摘要字段同步到 `UnattendedBlockerSummary`（服务）、`frontend/lib/api/unattended.ts` 和横幅的 `BLOCKER_KEYS`，再补 `settings` 命名空间两种语言的 `unattendedBlocked*` 文案；`unattended-probe.test.ts` 是对应测试。
- 改选项范围：`validators/unattended.ts` 与服务内 `normalizeOptions` 必须一致，`shared/unattended.ts` 的 `MIN_UNATTENDED_ARM_DELAY_SECONDS` 同时被两者和前端用；`unattended.test.ts`（路由）钉着越界被拒。
- 不变量：不持久化；探测失败即阻塞；撤防不得要求管理员；脱敏视图不得带 id、命令或错误文本；`unattended-mode.test.ts` 覆盖状态机。
- 查询的列名必须同时适用 SQLite 与 PostgreSQL（探测用一份 SQL 文本、`?` 占位符）。

## 相关
- [操作系统集成](os-integration.md)：关机命令与关闭后钩子。
- [启动与进程](boot.md)：优雅关闭流程。
- [实例锁、完整性与重启恢复](instance-recovery.md)
