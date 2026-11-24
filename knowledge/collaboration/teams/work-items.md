---
id: collaboration.teams.work-items
title: 工作项
summary: 工作项状态机、Team 工具、worktree 端口、检查提醒、合并判定与清理。
anchors:
  - server/services/teams/work-items.ts
  - server/services/teams/work-item-ports.ts
  - server/services/teams/team-git.ts
  - server/lib/agent/tools/team.ts
  - server/services/teams/__tests__/work-item-lifecycle.test.ts
  - server/services/teams/__tests__/team-checkin-brief.test.ts
keywords:
  - team_work_items
  - team_work_events
  - work.create
  - work.review
  - work.ready
  - work.sync
  - work.list
  - TEAM_WORK_ITEM_CHANGED
  - TEAM_WORK_ITEM_NOT_REVIEWED
  - TEAM_WORK_ITEM_DIRTY
  - TEAM_WORK_ITEM_STATES
  - attachWorker
  - settleIsolatedWorkItem
  - recordWorkEvent
  - confirmedLoss
  - team.checkin
  - Team 工具
  - Agent isolation worktree
status: draft
verified_at: 776dbf07e
---
# 工作项

工作项（`team_work_items`）是团队里的一个交付单位：一条分支、一个 worktree、一个状态。协调者经 `Team` 工具推进它，服务端只记录和校验，从不替人合并。

## 关键规则
状态与创建（`teams/work-items.ts`）：
- 状态：queued / in_progress / in_review / ready / merged / cancelled（`shared/project-teams.ts:TEAM_WORK_ITEM_STATES`）。
- 看板五列：queued、in_progress、review（含 in_review 与 ready）、done（merged）、cancelled。
- `work.create`：
  - 先经现有 narrator worktree 创建通道建分支 `team/<标题 slug>-<id 哈希 8 位>` 与 worktree；
  - 再写行与 `work.created` 事件，初始 `queued`。
- `Agent({ isolation: "worktree" })` 建的是 kind=`isolated` 的项，初始 `in_progress`。子代理结束时若没有提交也没有未提交改动，就清理 worktree 并取消该项（`settleIsolatedWorkItem`）。
- 第一层子代理经 `attachWorker` 记为工作者，queued 的项随之开始。

评审与就绪：
- `work.review`：blocker 把项退回 `in_progress`，clear 留在 `in_review`。
- `work.ready` 需要最新一轮评审为 clear，否则 409 `TEAM_WORK_ITEM_NOT_REVIEWED`。
- `work.ready` 还要 worktree 无未提交改动，否则 409 `TEAM_WORK_ITEM_DIRTY`。
- 评审之后的新提交不拦，只在结果里计数。
- 独占路径与路径不可读的拒绝见 [重叠与独占路径](overlap.md)。

同步、清理、并发：
- `work.sync`：服务端从不合并。基线已在分支内就返回 up_to_date，否则把一条确定性的 `git merge --no-ff <基线提交>` 指令交给工作者。
- 投递结果分 started / queued / blocked / wake_failed / failed / none 六种。
- 服务端从不删分支、不自己跑 `git worktree`：创建与清理都走现有 worktree 服务（`work-item-ports.ts`）。
- `cleanup` 只能用于 merged 或 cancelled 的项。丢未提交文件或未合并提交时必须带人确认过的损失（`force` + `confirmedLoss`），分支保留。`Team` 的 `cleanup` 每次都等人批准。
- 更新是乐观并发：按「状态 + `updated_at`」条件更新，对不上就 409 `TEAM_WORK_ITEM_CHANGED`。
- 进入 merged/cancelled 时同事务释放独占锁并记 `work.exclusive_released`。
- `merged` 只由祖先检测自动判定：`ready` 项的记录 head 已在基线分支内（squash/rebase 合并检测不到）。事务内核对状态、head、`updated_at` 一致才写入，之后不可逆。

事件与 check-in：
- 每次状态变更、评审、同步、清理、check-in、决策都追加一行 `team_work_events`（`recordWorkEvent`）。actor 为 person / agent / system，详情上限 8KB。
- check-in 是一个团队只保留一个的定时唤醒（5 分钟到 1 天），记为 `team.checkin` 事件，重启与取消归档时重新装填。
- 服务端读 git 只经 `teams/team-git.ts`：禁用 hook、fsmonitor、外部 diff/textconv、写 index，读上限沿用 `gitService`（60s、1MB）。`changedPaths` 只比较两个提交，不读工作区。

`Team` 工具（`server/lib/agent/tools/team.ts`，仅 team trait 会话提供）：
- 动作：work.list/create/review/ready/sync/cancel、brief、checkin、cleanup、decision；`work.list` 最多 30 项。
- 权限逐动作判定（`narrator-permission.ts`）：记账类与团队自己的 worktree 创建/同步在只读之外也允许，`cleanup` 总要人批准。

## 从哪读起
- `teams/work-items.ts`：生命周期、check-in、合并判定。
- `teams/work-item-ports.ts`：与 worktree 服务的端口；`teams/team-git.ts`：只读 git。
- 测试：`work-item-lifecycle.test.ts`、`team-checkin-brief.test.ts`。

## 改它时
- 加一个 `Team` 工具动作：`shared/project-teams.ts:TEAM_TOOL_ACTIONS`、`tools/team.ts` 的参数与分发、`narrator-permission.ts` 的逐动作分类（`isTeamReadAction`/`isTeamCleanupCall`，漏了会被当成写动作或绕过批准）、`team-status.ts` 与前端 `team-page-model.ts` 里对事件种类的文案。
- 加工作项状态或事件种类：`TEAM_WORK_ITEM_STATES`/`TeamWorkEventKind`、表上的 check 约束（SQLite 与 `drizzle-postgres` 两边，`team-tables-contract.test.ts` 会失败）、看板列映射 `TEAM_BOARD_COLUMN_STATES`。
- 不变量：服务端不合并、不删分支、不直接跑 `git worktree`；读 git 只经 `team-git.ts`；状态更新必须带「状态 + `updated_at`」条件。

## 相关
- [团队与成员](records.md)：删除团队前对未收尾工作项的检查。
- [协调者](coordinator.md)：`team_status` 行里的工作项摘要。
