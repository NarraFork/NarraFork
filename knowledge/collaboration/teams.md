---
id: collaboration.teams
title: 团队
summary: 协调者 + 子代理树、工作项、跨团队重叠、团队页、多人使用。
anchors:
  - server/services/teams/
  - server/routes/project-teams.ts
  - server/lib/agent/tools/team.ts
  - frontend/components/teams/
  - shared/project-teams.ts
  - server/db/schema.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 团队

项目团队 = 一个带 `team` trait 的协调者叙述者 + 它在 `project_teams` 表里的一行；协调者派出的子代理做具体工作，每个工作项对应一条分支和一个 worktree。仅 SQLite：路由在 PostgreSQL 上返回 503（`project-teams.ts` 的 `requireSqliteProjectMutation` 中间件）。

## 关键规则
- 身份与访问：团队 id 就是协调者的 narrator id，团队名是其标题；访问只看协调者的叙述者 ACL——读即读团队，写即成员；无读权限返回 404，只读者改动返回 403（`teams/team-service.ts` 头注释与实现）。
- 没有独立的团队成员表：成员列表由协调者 owner、协调者上的显式授权、近期发言者、以及（协调者属于项目且受众为 project/public 时）项目 owner 与授权拼出，逐个按叙述者 ACL 判定，有条数上限，`more` 标记被截断（`teams/team-members.ts`）。授权通过普通叙述者分享服务，不在这里。
- 生命周期：与协调者原子创建；归档协调者即归档团队，`project_teams.status` 镜像协调者状态（`startTeamStatusSync`）；删除协调者前检查团队是否还有未收尾的工作项，有则拒绝（`teams/team-records.ts:assertTeamRemovable`），无则在同一事务内连带删除团队行（`deleteTeamOfNarratorInTransaction`）。
- 工作项（`team_work_items`）状态：queued / in_progress / in_review / ready / merged / cancelled（`shared/project-teams.ts:TEAM_WORK_ITEM_STATES`）。创建 worktree 与清理走现有 narrator worktree 创建/移除通道，本模块不自己跑 `git worktree`、不删分支；每次状态变更、评审结论、同步、清理、check-in、决策都追加一行 `team_work_events`（`teams/work-items.ts`）。
- 服务端读 git 只经 `teams/team-git.ts`（禁用 hook、外部 diff、写 index 等）；基线同步是工作者的事。
- 重叠与独占路径：后台每两分钟分批刷新活动工作项相对基线的改动路径（上限 2000 条/128KiB，超出退化为顶层目录），按项目比较重叠；`ready` 且其 head 已在基线分支内的工作项被自动判为 `merged`（祖先检测，squash/rebase 合并检测不到）；独占锁在 `team_work_items` 上由 `(project_id, exclusive_key)` 局部唯一索引保证（`teams/team-overlap.ts`）。
- 协调者软限制：编辑行数、读/搜索行数、Bash 输出等超过团队设定建议值时，只追加提醒行并写 `coordinator.overrun.*` 事件，不拒绝调用；超大输出整份存盘并给出路径（`teams/coordinator-limits.ts`、`coordinator-outputs.ts`）。
- 协调者用 `Team` 工具操作：work.list/create/review/ready/sync/cancel、brief、checkin、cleanup、decision（`server/lib/agent/tools/team.ts`）。
- 路由挂在 `/api/projects/:projectId/teams...`：列表/创建/详情/修改/归档/取消归档、summary、board、events、approvals、members、running，以及 `team-overlaps`；强制释放独占锁要项目 manage 权限（`server/routes/project-teams.ts`）。

## 从哪读起
- `server/services/teams/team-service.ts`：团队创建与读取。
- `server/services/teams/work-items.ts`：工作项生命周期。
- `server/services/teams/team-status.ts`、`team-board.ts`：团队状态与看板。
- `frontend/components/teams/`：团队页（`team-page-model.ts` 是页面模型，附带测试）。
- 测试：`server/services/teams/__tests__/`（含 `team-tables-contract.test.ts`、`work-item-lifecycle.test.ts`）。

## 相关
- [项目](projects.md)
- [聊天与站内消息](chat.md)
