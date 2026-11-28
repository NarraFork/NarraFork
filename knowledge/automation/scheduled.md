---
id: automation.scheduled
title: 计划任务
summary: 有限或持续调度、已有会话目标、持久等待与执行跟踪、结果报告及任务访问权限。
anchors:
  - server/services/scheduled-task-*.ts
  - server/services/scheduled-run-registry.ts
  - server/services/narrator-session.ts
  - server/services/narrator-permission.ts
  - server/routes/scheduled-tasks.ts
  - server/db/schema.ts
  - server/lib/schedule-engine.ts
  - server/lib/validators/scheduled-tasks.ts
  - server/lib/agent/tools/scheduled-task*.ts
  - shared/scheduled-task-*.ts
  - frontend/hooks/useScheduledTasks.ts
  - frontend/lib/api/scheduled-tasks.ts
  - frontend/lib/scheduled-task-search.ts
  - frontend/components/scheduled-tasks/**
  - frontend/components/narrator/NarratorPanel.tsx
  - frontend/routes/scheduled-tasks/**
  - frontend/locales/*/scheduledTasks.json
  - server/services/__tests__/scheduled-task-*.test.ts
  - server/lib/__tests__/schedule-engine.test.ts
keywords:
  - /api/scheduled-tasks
  - scheduled_tasks
  - scheduled_task_runs
  - firedCount
  - scheduleCursorAt
  - requireReport
  - targetNarratorId
  - contextPolicy
  - onBusy
  - busyWaitMinutes
  - ScheduledTask
  - ScheduledTaskReport
  - ManagedTaskBanner
  - reportOnly
  - circuit_breaker
  - 定时
status: draft
verified_at: 1f5b09796829c69a6a4f145446bbfc07f6cc5f5d
---
# 计划任务

`scheduled_tasks` 保存调度与执行配置，`scheduled_task_runs` 保存每次触发的等待、执行和结果。任务生命周期、服务端观察到的运行状态、模型自报结果是三个独立概念。

## 关键规则
- 调度为 `at`（最多 50 个定点时间）、`repeat`（分钟/小时/日/周/月规则）或 `cron`；后两者支持 `never`、`count`、`until` 结束条件。日期按任务时区解释，未提供时区时使用服务器时区（`scheduled-task-schedule.ts`、`schedule-engine.ts`）。
- 自动接受一次触发就消耗一次 `firedCount`，即使随后忙碌跳过、访问失败或等待超时；停机漏跑也消耗次数，并用带 `missedCount` 的 `missed` 行按每批最多 128 次聚合记录。手动运行不消耗次数、不推进调度游标（`acceptScheduledTaskRun`、`recordMissed`）。
- 修改实际调度规则或时区会重置次数并增加 `scheduleRevision`；名称等非调度编辑不写旧的游标、计数或下次时间。接受触发时以任务版本、调度修订和到期时间作条件写入，认领失败不创建重复运行（`scheduledTaskService.update`、`acceptScheduledTaskRun`）。
- 暂停的重复规则不消耗暂停期间的次数，恢复从当前时间继续；暂停的 `at` 日期仍会过期并记为漏跑。没有下一次且不存在 `waiting/running/blocked` 运行时才结束任务；`ended` 不表示业务成功，也不允许直接重新启用已耗尽的规则（`setEnabled`、`reconcileCompletion`）。
- 调度器每 30 秒检查到期任务，单批 25 条；运行跟踪每 2 秒执行。启动先归一化旧任务并记录停机漏跑，不重放过去触发；正常轮询对超过 60 秒容差的到期时间记漏跑（`scheduled-task-scheduler.ts`、`runTask`、`recoverOnStartup`）。
- `stopScheduledTaskScheduler` 先停止两套定时器并递增 generation，再等待启动恢复、当前调度和跟踪完成；迟到的恢复不能重新启动已停止的定时器。恢复失败会阻止新派发，运行看门狗仍独立工作。
- 旧行仅在 `schedule` 为空时迁移 `createdBy` 为所有者、补来源快照和结构化调度；游标优先取旧 `nextRunAt - 1ms`，不回退到创建时间重放已派发内容。步进分钟 cron 保留 cron 语义；历史 `success` 继续显示“已派发”，不改成成功完成（`normalizeLegacyTask`、`readTaskSchedule`、`runVerdict`）。
- 运行身份是任务当前所有者，每次重新查用户与角色；现代任务的所有者被清空后不回退到 `createdBy`。所有者或管理员可编辑、运行、删除及读取私有指令/结果；只有管理员可转移所有者，且转移不能发生在活动运行期间（`scheduled-task-acl.ts`、`transfer`）。
- 项目任务另允许项目读者查看调度元数据，隐藏 prompt、系统提示、错误和报告摘要；来源会话链接还需该会话读权限。项目管理者可启停任务，启用还要复核调用者与所有者的项目写权限或已有目标写权限（`decorate`、`detail`、`listRuns`、`setEnabled`）。
- `narratorMode=new` 每次创建任务会话；`reuse` 仅在保留会话未归档、归属不冲突且所有者仍可写时复用，否则新建。项目模式执行前要求所有者仍可写项目（`resolveNarrator`、`acceptScheduledTaskRun`）。
- `existing` 必须指定 `targetNarratorId`，用普通会话写 ACL 拒绝无权或已归档目标；创建、修改、启用与运行前复核目标配置。目标保留自己的目录、项目、系统提示、权限和计划状态，不借任务覆盖其执行权限（`resolveScheduledTaskTarget`、`prepareScheduledTaskSession`）。
- `targets` API/工具按名称或精确 ID 查可写目标，返回有界元数据、默认每页 30 条、最多 100 条和不透明游标；不返回历史或提示词。精确 ID 可发现被普通列表隐藏但仍可写的会话（`scheduled-task-targets.ts`）。
- `contextPolicy=keep` 保留目标上下文；`clear` 只在真正派发前清理一次，补报告与恢复不再次清理。`modelPolicy=follow` 沿用目标模型，`temporary` 使用本次运行覆盖，`sync` 更新并保持目标模型；已有目标默认 `follow`（`scheduled-task-policy.ts`、`narrator-session.ts`、运行注册）。
- `onBusy=skip` 将忙碌触发记为跳过；`wait` 持久保存有固定 `busyDeadlineAt` 的等待；`interrupt` 绑定接受时的逻辑运行和执行 epoch，按正常控制权限中断该次执行，不能在异步等待后改为中断新的执行（`scheduled-task-waiting.ts`）。
- `waiting` 是已接受但未派发，`startedAt/deadlineAt` 为空，不具有运行或报告权限。每任务最多一个等待记录，按目标排队并有队列上限；派发前重新检查所有者、目标、权限与等待期限。暂停、转移或除名称外的配置修改会取消等待，已消费的次数不退还。
- `status` 记录服务端观察到的 `running/blocked/completed/failed/interrupted/timed_out` 等；`outcome` 只接受模型的 `done/partial/blocked/no_change`。`completed + done/no_change` 才显示成功；没有报告时，`requireReport=true` 显示未确认，`false` 显示已结束；两者都不凭空声称成功（`shared/scheduled-task-status.ts:runVerdict`）。
- `ScheduledTaskReport` 由服务端绑定当前运行，不接受 taskId/runId，报告本身不结束运行。正常业务结束且唤醒型后台工作、相关会话收件箱均已收敛后，缺失必需报告最多补发一次 `reportOnly` 提醒；该轮只能调用报告工具，权限检查与最终执行检查都拒绝重新做业务（`pollOne`、`narrator-permission.ts`）。
- `onBlocked=auto` 不等待人工问答、计划审批或工具审批，沿用已有权限决定并记录自动处理，不绕过硬拒绝；`wait` 保留人工等待，受 blocked-wait 上限和总运行 deadline 约束。重启恢复保留原 deadline 与精确运行身份，不能把后来的无关轮次当作该次完成（`scheduled-task-run-tracker.ts`、`scheduled-task-run-service.ts`）。
- 连续执行失败/超时及 ACL 等准入失败持久累计，达到 5 次自动暂停并标 `circuit_breaker`；正常完成清零，忙碌跳过不增加失败计数。通知面向当前所有者，持久唯一记录去重，外部投递前再次核对所有权；不读取或投递指令、模型摘要和错误正文（`finalizeScheduledRun`、`scheduled-task-notify.ts`）。
- 列表最多 500 条，先按 ACL 与筛选条件查询，不选 prompt/systemPrompt；详情按能力返回指令。运行历史按 `(createdAt,id)` 游标与 `LIMIT n+1` 分页，API 最多 200 条；目标、关联、调度与运行跟踪读取使用 `readQuery` 的 `worker-required`，失败不回主线程重查。
- HTTP 入口还包括 `/preview-schedule`、`/targets`、`/for-narrator/:narratorId`、`/:id/toggle`、`/:id/run`、`/:id/runs`、`/:id/cleanup` 与管理员 `/:id/transfer`；叙述者入口为统一 `ScheduledTask`，授权与报告约束见[流程与协作工具](../agent/tools/workflow.md)。
- 前端有列表、新建、任务布局及其详情/编辑子路由；共享表单管理目标、调度预览、运行策略与报告开关。`NarratorPanel` 内的 `ManagedTaskBanner` 动态查询当前目标/复用/创建关系及未结束运行，可显示多个任务与暂停任务；任务结束且无未结束运行后消失，不把历史借用永久当作关联。
- 关联缓存只保存有界 ID，每次返回重新检查 ACL、关系和生命周期；WS 只广播无任务标识的 `scheduled_tasks_changed`。前端在任务变更和重连后重取，项目/会话撤权时先清缓存；banner 读取失败只显示重试，不显示缓存的私有名称、链接或数量。
- 保留清理默认 `none`，手动清理要求编辑权限；每批最多 10 个会话根并检查保护条件。`existing` 目标完全不参与任务产物清理，不删除借用的已有会话（`scheduled-task-cleanup.ts`）。

## 从哪读起
- `scheduled-task-service.ts`、`scheduled-task-schedule-state.ts`：CRUD、有限次数、旧升级与漏跑；`schedule-engine.ts`：时区下的下一次和预览。
- `scheduled-task-waiting.ts`：接受、排队、精确中断和派发；`scheduled-run-registry.ts`、`scheduled-task-run-service.ts`、`scheduled-task-run-tracker.ts`：运行身份、报告与终态。
- `scheduled-task-targets.ts`、`scheduled-task-associations.ts`、`useScheduledTasks.ts`、`ManagedTaskBanner.tsx`：目标发现、动态关联与撤权刷新。

## 改它时
- 改字段或状态时同步 schema、校验器、共享类型、工具 schema、API 和前端表单/状态展示；schema 迁移只能通过生成器。修改调度不得让名称编辑重置计数，修改报告不得把派发或无报告当作成功。
- 调度与升级看 `schedule-engine.test.ts`、`scheduled-task-service.test.ts`、`scheduled-task-upgrade.test.ts`、`scheduled-task-dispatch-claim.test.ts`；停止排空看 `scheduled-task-scheduler.test.ts`。
- 等待/身份/报告看 `scheduled-task-waiting.test.ts`、`scheduled-task-run.test.ts`、`scheduled-task-session.test.ts`、`scheduled-task-unattended.test.ts`；ACL、目标和 UI 看 `scheduled-task-principal.test.ts`、`scheduled-task-associations.test.ts`、工具 `scheduled-task-targets.test.ts` 及 `frontend/components/scheduled-tasks/scheduled-tasks.test.tsx`。子集测试加 `--isolate`。

## 相关
- [通知与注意力](../collaboration/notifications.md)
- 插件有自己的调度，见[插件系统](plugins/index.md)。
