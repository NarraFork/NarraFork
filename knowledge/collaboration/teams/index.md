---
id: collaboration.teams
title: 团队
summary: 协调者 + 子代理树、工作项、跨团队重叠、团队页、多人使用。
anchors:
  - server/routes/project-teams.ts
  - shared/project-teams.ts
  - server/services/teams/team-service.ts
keywords:
  - project_teams
  - /api/projects/:projectId/teams
  - POSTGRES_UNSUPPORTED
  - TEAM_TRAIT
  - 项目团队
  - requireSqliteProjectMutation
  - TeamStatus
status: draft
verified_at: 776dbf07e
---
# 团队

项目团队 = 一个带 `team` trait（`TEAM_TRAIT`）的协调者叙述者 + 它在 `project_teams` 表里的一行。协调者自己只做统筹，具体工作由它派出的子代理完成；每个工作项对应一条分支和一个 worktree，由评审、同步、合并判定推进到收尾。团队页把这一切放在一个页面里给多人看和批。

仅 SQLite：`/api/projects/:projectId/teams*`、`team-overlaps`、`team-locks/*` 在 PostgreSQL 上经 `requireSqliteProjectMutation` 返回 503 `POSTGRES_UNSUPPORTED`（`server/routes/project-teams.ts` 文件顶部的四个 `use`）。

注意：`server/lib/agent/tools/team-status.ts` 的 `TeamStatus` 工具与项目团队无关，它查询的是当前会话的子代理和后台 bash 任务（见子代理节点）；团队的 `team_status` 是写进协调者历史的系统行，见协调者子节点。

## 几部分怎么配合
1. 先有团队：创建时同事务建协调者叙述者和 `project_teams` 行；成员不另存，全部取自协调者的叙述者 ACL（团队与成员）。
2. 协调者用 `Team` 工具建工作项；工作项有自己的分支与 worktree，子代理（工作者）在里面干活，经评审、`ready`、合并判定走完状态机（工作项）。
3. 活动工作项的改动路径被后台定期刷新，跨团队比较重叠；项目设了独占路径时，`ready` 要抢独占锁（重叠与独占路径）。
4. 协调者被软限制约束，超大输出落盘，`team_status` 行把团队全貌注入它的历史（协调者）。
5. 看板、活动、待批抽屉、成员、「全部暂停」都由团队页读模型和前端提供；任何成员可批团队树里的待决调用（团队页与审批）。

## 读哪个子节点
- 谁能看、谁算成员、创建/归档/删除、数据导入怎么处理团队行 → [团队与成员](records.md)。
- 工作项状态、`Team` 工具动作、`work.sync`、cleanup、check-in → [工作项](work-items.md)。
- 改动路径、重叠提醒、`exclusive_key`、`TEAM_EXCLUSIVE_LOCK_HELD`、强制释放 → [重叠与独占路径](overlap.md)。
- 协调者超限提醒、`coordinator-outputs/`、`team_status` 行 → [协调者](coordinator.md)。
- 看板、动态、审批、谁批的、暂停全部、前端组件与轮询 → [团队页与审批](page.md)。

## 从哪读起
- `server/routes/project-teams.ts`：所有团队路由，每条都先过 SQLite 守卫；读模型在 `teams/team-board.ts`。
- `server/services/teams/team-service.ts`：团队创建与读取，`loadTeamForAccess` 是访问判定入口。
- `shared/project-teams.ts`：状态、上限、事件种类、`Team` 动作表，前后端共用。
- 测试目录 `server/services/teams/__tests__/`，其中 `team-tables-contract.test.ts` 在 SQLite 与 PG 上对同一组约束。

## 改它时
- 团队三张表（`project_teams`、`team_work_items`、`team_work_events`）改动要同步 SQLite 与 PG schema，细节见团队与成员、工作项。
- 新增团队写路由：沿用 `project-teams.ts` 顶部的 `requireSqliteProjectMutation`，再做 `loadTeamForAccess` 访问判定。
- 不变量：成员关系永远取自协调者的叙述者 ACL，不要加团队成员表；服务端不合并、不删分支、不直接跑 `git worktree`；所有团队读取必须带 LIMIT 并且 SQLite 专用；IM 网关不得驱动团队会话（见 [IM 网关](../gateway.md)）。

## 相关
- [项目](../projects.md)
- [聊天与站内消息](../chat.md)
- [IM 网关](../gateway.md)：团队会话不能从 IM 驱动。
- [通知与注意力](../notifications.md)：团队的「等待成员」提醒。
- [大纲](../../kb/outline.md)：任务来源（`task-source`）与任务看板的锚点已移到大纲节点。

## 下面有什么

- [团队与成员](records.md)：团队即协调者会话：创建、名称、访问控制与成员、生命周期、IM 拒绝。
- [工作项](work-items.md)：工作项状态机、Team 工具、worktree 端口、检查提醒、合并判定与清理。
- [重叠与独占路径](overlap.md)：工作项的改动路径、跨团队重叠提醒、独占路径锁与强制释放。
- [协调者](coordinator.md)：协调者的软限制、保存的输出、团队状态行与提示词。
- [团队页与审批](page.md)：看板、活动、待批抽屉、谁批的记录、暂停全部与团队页前端。
