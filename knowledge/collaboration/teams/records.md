---
id: collaboration.teams.records
title: 团队与成员
summary: 团队即协调者会话：创建、名称、访问控制与成员、生命周期、IM 拒绝。
anchors:
  - server/services/teams/team-members.ts
  - server/services/teams/team-membership.ts
  - server/services/teams/team-session-memo.ts
  - server/services/teams/team-records.ts
  - server/db/schema.ts
  - server/lib/validators/project-teams.ts
  - server/services/teams/__tests__/team-tables-contract.test.ts
  - server/services/teams/__tests__/team-status-members.test.ts
keywords:
  - 团队成员
  - onlooker
  - 旁观者
  - loadTeamForAccess
  - createTeam
  - TEAM_ARCHIVED
  - PROJECT_ARCHIVED
  - TEAM_MEMBERS_LIST_LIMIT
  - teamIdOfNarrator
  - assertTeamRemovable
  - deleteTeamOfNarratorInTransaction
  - startTeamStatusSync
  - reconcileImportedTeamTraits
  - teamWorktreePathsForNarrator
  - 归档团队
status: draft
verified_at: 2e6441ad0
---
# 团队与成员

团队没有独立的身份体系：团队 id 就是协调者的叙述者 id，团队名是其标题，成员关系完全由协调者的叙述者 ACL 决定。

## 关键规则
身份、访问与成员：
- 访问只看协调者的叙述者 ACL：读即读团队（onlooker），写即成员。
  - 无读权限：404。
  - 只读者改动：403（`teams/team-service.ts:loadTeamForAccess`）。
- 创建要求项目写权限；项目必须有 git 仓库目录（`gitPath`）。
- 已归档项目不能新建团队（409 `PROJECT_ARCHIVED`）。
- 协调者叙述者与团队行在同一事务内创建，基线分支默认取项目 `defaultBranch`，再缺省 `main`（`createTeam`）。
- 没有独立的团队成员表。成员列表由四路拼出：协调者 owner、协调者上的显式授权、协调者最近 500 条消息里的发言者、以及（协调者属于项目且受众为 project/public 时）项目 owner 与授权。
  - 逐个按叙述者 ACL 批量判定，上限 `TEAM_MEMBERS_LIST_LIMIT` = 100，`more` 标记被截断。
  - 授权与撤销走普通叙述者分享服务，不在这里（`teams/team-members.ts`）。
- 哪个会话属于团队：协调者本身，或 ACL 根是协调者的子代理（`team-membership.ts:teamIdOfNarrator`）。
- `team-session-memo.ts` 缓存这个判断（IM 网关用），数据导入/清空后整体失效。
- 团队自己的 worktree 内写文件和委派不需要人批准（`teamWorktreePathsForNarrator`）。上限 64 个，超出退回询问人；`.git` 控制目录除外。由 `narrator-permission.ts` 使用。

生命周期：
- 归档协调者即归档团队，`project_teams.status` 镜像协调者状态（`startTeamStatusSync`）；已归档团队不能改（409 `TEAM_ARCHIVED`）。
- 删除协调者前检查（`teams/team-records.ts:assertTeamRemovable`）：
  - 还有「未收尾，或已收尾但仍记录着 worktree」的工作项就拒绝；
  - 否则在同一事务内连带删除团队行（`deleteTeamOfNarratorInTransaction`）。
- 团队行 RESTRICT 叙述者与项目删除，删团队级联删工作项与事件（`team-tables-contract.test.ts`）。
- 数据导入/导出：三张团队表不导出，导入后会话的 `team` trait 以本机有没有团队行为准（`data-portability.ts:reconcileImportedTeamTraits`）。
- IM 网关永远不能驱动团队会话，也不能做团队树里的批准决定。

## 从哪读起
- `server/services/teams/team-service.ts`：团队创建、读取、访问判定（本节点的入口，锚在总览）。
- `team-members.ts`：成员拼装；`team-membership.ts`：会话归属；`team-records.ts`：删除前检查。
- `server/lib/validators/project-teams.ts`：团队路由的 Zod 校验。
- `server/db/schema.ts`：`project_teams`、`team_work_items`、`team_work_events` 三张表。

## 改它时
- 动团队三张表：`server/db/schema.ts` 与 `postgres-schema.ts` 同步，再按流程生成 SQLite 与 PG 迁移；`team-tables-contract.test.ts` 在两边对同一组约束，漏一边会失败。
- 它们不在数据导出清单里：保持 `reconcileImportedTeamTraits` 与清空会话时先删团队表的顺序（团队行 RESTRICT 叙述者删除）。
- 不要加团队成员表；成员判定变化要同步 `team-members.ts` 的拼装来源与 `team-status-members.test.ts`。
- 改团队路由入参：`validators/project-teams.ts` 与前端 `lib/api/teams.ts` 一起改。
- IM 网关不得驱动团队会话（见 [IM 网关](../gateway.md)）。

## 相关
- [工作项](work-items.md)：删除前检查依据的「未收尾」定义。
- [团队页与审批](page.md)：成员列表的前端展示。
