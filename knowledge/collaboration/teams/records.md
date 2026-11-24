---
id: collaboration.teams.records
title: 团队与成员
summary: 团队即协调者会话：创建、把已有会话升级为团队、解散并保留会话、名称、访问控制与成员、生命周期、IM 拒绝。
anchors:
  - server/services/teams/team-conversion.ts
  - server/routes/__tests__/project-teams-upgrade.test.ts
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
  - 升级为团队
  - 解散团队
  - fromNarratorId
  - upgradeSessionToTeam
  - disbandTeam
  - /teams/:teamId/disband
  - TEAM_ALREADY
  - TEAM_SESSION_KIND_UNSUPPORTED
  - TEAM_SESSION_ARCHIVED
  - TEAM_SESSION_OTHER_PROJECT
  - TEAM_NAME_INVALID
  - TEAM_HAS_LIVE_WORK
  - team_upgrade
  - team_disband
status: draft
verified_at: 9400a828b
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
- `team-session-memo.ts` 缓存这个判断（IM 网关用）：叙述者删除时删掉这一项；升级、解散、数据导入/清空之后整体清空（`forgetTeamSessions()`）。
- 团队自己的 worktree 内写文件和委派不需要人批准（`teamWorktreePathsForNarrator`）。上限 64 个，超出退回询问人；`.git` 控制目录除外。由 `narrator-permission.ts` 使用。

把已有会话升级为团队（`teams/team-conversion.ts:upgradeSessionToTeam`，`POST /api/projects/:projectId/teams` 带 `fromNarratorId`）：
- 请求体有 `fromNarratorId` 就走单独的严格 schema（`upgradeProjectTeamSchema`：`name?`、`baseBranch?`、`brief?`、`settings?`），带 `visibility`/`writeAudience` 或未知字段 → 400。受众不变，只能经分享路由改。
- 谁能升级：项目写权限（路由）+ 会话 owner 或管理员（`canManageNarratorAcl`）。读不到会话 → 404；能读但不是 owner/管理员 → 403。
- 拒绝，依次检查：
  - 项目已归档 → 409 `PROJECT_ARCHIVED`；项目没有 `gitPath` → 400。
  - 会话的主项目（`contextProjectId`，否则项目索引的 primary 链接）不是这个项目 → 409 `TEAM_SESSION_OTHER_PROJECT`；事务内还拒绝工作目录被索引到别的项目（`source: "cwd"` 链接指向别处）的会话，同一个码。
  - 已有 `team` trait 或团队行 → 409 `TEAM_ALREADY`。
  - 不是 primary（子代理）、带 `bot`/`knowledge-steward`/`setup`/`modeltrace`/`ask-in-passing`/`scheduled` trait、有 `scheduledTaskId`、ModelTrace 舱（`modeltraceKey`/`hiddenFromLists`）、OAuth 会话（有快照，或 `resolveOAuthNarratorRuntimePolicy` 非空或读失败）→ 409 `TEAM_SESSION_KIND_UNSUPPORTED`，`details.reason` 写原因。
  - 能力上限不让它派子代理（`isRuntimeToolAllowed(policy, "Agent")` 为假）→ 同一个码，`reason: "cannot-start-subagents"`。
  - 已归档 → 409 `TEAM_SESSION_ARCHIVED`。
  - `working`/`waiting` 或持有执行权 → 409 `NARRATOR_EXECUTION_BUSY`。
  - 工作目录不是本机 Git 检出（`workspaceContextService.get` 读不到、设备不是 local、没有 `git.workspaceKey`）→ 409 `TEAM_WORKSPACE_UNAVAILABLE`；项目的任何检出都行，包括 linked worktree。事务内工作区 revision 变了也回这个码。
  - 没给 `name` 而标题为空或超过 120 → 400 `TEAM_NAME_INVALID`。
- 写入：`narratorTraitsLock` 内一个同步事务，重读会话与项目、重查上面的拒绝，然后追加 `team` trait、把 `contextProjectId` 钉成这个项目、改名时写标题、插团队行、记 `team.created` 事件（`detail: { baseBranch, fromSession: true }`）。插行失败则 trait 也不写。
- 提交后：`forgetTeamSessions()`；广播 `custom_traits_changed`（改名时加 `title_updated` 与 `narrator:title_updated`）；重算项目链接；`announceTeamChange` 通知最近标签页持有者（见访问控制）；写一条 `team_upgrade` 说明（`schedule: "none"`，不唤醒，人发下一条消息才开始第一轮协调）；`replace_tools` epoch 上写重建基线的 `tool_loaded` 通知（`tool-loading-service.ts:requestToolDeclarationRebaseline`），下一次请求开新 epoch 声明 `Team`。已经派出的子代理随 ACL 根立即算进团队。
- 说明的消息 id 由（会话、种类、团队行 `createdAt`）派生，写过就不再写；正文给出团队名、谁升级的、实际工作目录以及它是否在主检出里（`lib/prompts/team-lead.ts:teamUpgradeNote`）。

解散团队、保留会话（`disbandTeam`，`POST /api/projects/:projectId/teams/:teamId/disband`）：
- 谁能解散：项目写权限 + 会话 owner 或管理员。读不到 → 404；能写不能管 → 403。
- 拒绝：协调者已归档 → 409 `TEAM_ARCHIVED`（先取消归档）；`working`/`waiting` 或持有执行权 → 409 `NARRATOR_EXECUTION_BUSY`；还有未收尾或仍记录 worktree 的工作项 → 409 `TEAM_HAS_LIVE_WORK`。
- 写入：`narratorTraitsLock` 内一个事务，`deleteTeamOfNarratorInTransaction` 删团队行（工作项与事件级联删除），去掉 `team` trait。标题、受众、消息和钉住的 `contextProjectId` 都不动。
- 提交后：`forgetTeamSessions()`、`forgetTeamStatus`、`forgetCoordinatorRun`、`cancelCheckin`、异步删 `coordinator-outputs/<id>`；广播 `custom_traits_changed` 与 `announceTeamChange`；写一条 `team_disband` 说明（同样的确定 id 规则）。`Team` 工具由运行时的卸载对账从下一次请求里去掉，不需要重建基线。

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
- 改升级/解散：`team` trait 与团队行必须在同一事务、同一 `narratorTraitsLock` 下一起变；提交后清 `team-session-memo` 的缓存；`project-teams-upgrade.test.ts` 覆盖每个拒绝码、事务原子性、并发 trait 写入、说明只写一次与「升级→解散→再升级」。
- IM 网关不得驱动团队会话（见 [IM 网关](../gateway.md)）。

## 相关
- [工作项](work-items.md)：删除前检查依据的「未收尾」定义。
- [团队页与审批](page.md)：成员列表的前端展示。
