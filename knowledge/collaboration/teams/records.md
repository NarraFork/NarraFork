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
  - frontend/components/narrator/CreateTeamFromDirectory.tsx
  - frontend/components/narrator/create-narrator-team.ts
  - frontend/components/narrator/create-narrator-team.test.ts
  - frontend/components/narrator/create-team-start.browser-fixture.tsx
  - frontend/components/narrator/create-team-start.browser.test.ts
  - shared/project-team-draft.ts
  - frontend/components/teams/team-draft.ts
  - frontend/components/teams/team-draft.test.ts
  - server/services/teams/__tests__/team-repo.fixture.ts
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
  - 以团队开始
  - start as a team
  - CreateTeamFromDirectory
  - teamStartEligibility
  - TEAM_PROJECT_NOT_GIT
  - TEAM_BASE_BRANCH_UNRESOLVED
  - checkTeamDraft
  - teamBaseBranchSchema
status: draft
verified_at: a5b512406
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
- `createTeam` 在写任何东西之前做两项 git 检查，所有创建路径都经过它：
  - 项目目录必须是本地 git 工作树（`team-git.ts:isGitWorkTree`，`rev-parse --is-inside-work-tree`，禁用仓库配置里的程序，10s 超时；目录不存在、bare 仓库、失败都算否），否则 409 `TEAM_PROJECT_NOT_GIT`。项目可以关联任意已有文件夹，所以只有 `gitPath` 不够。
  - 基线分支（给定的，或项目 `defaultBranch`，再缺省 `main`）必须解析到提交（`teamGit(gitPath).resolveCommit`，即工作项建 worktree 时用的同一个 `rev-parse --verify ...^{commit}`），否则 409 `TEAM_BASE_BRANCH_UNRESOLVED`，消息里带分支名；git 读不成单个修订的项目默认值同样按这个码拒绝。
  - 测试：`projects-resolve-directory.test.ts`（拒绝后叙述者与团队行数不变）；其他团队测试用 `__tests__/team-repo.fixture.ts:initTeamRepo` 给项目目录建真实仓库。
- 协调者的 cwd 永远是项目的 `gitPath`，不是用户选的子目录（`createTeam`）。

两个创建入口，都调同一条 `POST /api/projects/:projectId/teams`，字段都来自 `components/teams/TeamCreateFields.tsx`（名称、基线分支、说明）：
- 名称、基线分支、说明的 Zod 规则只有一份，在 `shared/project-team-draft.ts`（`teamNameSchema`、`teamBaseBranchSchema`、`teamBriefSchema`，`gitBranchName` 也在这里，`validators/common.ts` 转出）；路由校验器 `validators/project-teams.ts` 与前端 `teams/team-draft.ts:checkTeamDraft` 都用它。`useTeamDraft().submit()` 在草稿不合规时返回 null 并在对应字段显示错误，两个入口都因此不发请求。
- 项目页团队区块的「新建团队」弹窗（`ProjectTeamsList.tsx:CreateTeamModal`）。
- 新建会话弹窗的「会话 / 以团队开始」切换（`narrator/CreateNarratorModal.tsx`）：
  - 选目录与建会话完全一样；`create-narrator-team.ts:useTeamStartEligibility` 防抖 300ms 后用 `resolve-directory`（`create: false`，见[项目](../projects.md)）查目录，不写库。
  - 选项始终可见；不可用时禁用并写明原因（`teamStartEligibility`），每个原因一行：
    - 远程执行设备 → `remoteDevice`；
    - 未选目录 → `chooseDirectory`；
    - 正在检查、答复对应的目录已改、答复形状不对 → `checking`；
    - 查询 503（PG） → `postgres`；其他查询失败 → `lookupFailed`；
    - `not_directory` → `notDirectory`；
    - `not_git` → `notGit`（读不到的项目也是这个答复，弹窗无从区分，文案保持"不在 git 仓库"）；
    - 项目已归档 → `archived`；
    - 项目 `gitWorkTree` 不为 true → `projectNotGit`；
    - 只读 → `readOnly`。
  - 选中后右侧换成懒加载的 `CreateTeamFromDirectory.tsx`：提交时先在客户端按共享规则校验草稿（不合规就不发任何请求，也就不会为它建项目），再 `resolve-directory`（`create: true`，没有项目的仓库此时才建项目），再按结果复判一次，然后建团队，关闭弹窗并打开团队页 `/projects/$projectId/teams/$teamId`（调用方给了 `onTeamCreated` 时改为回调，浏览器测试夹具用它）。
  - 客户端校验之后团队路由仍可能失败（如 `TEAM_BASE_BRANCH_UNRESOLVED`）；这时已建的项目留下，与在该目录开一个会话的结果相同。
- 协调者叙述者与团队行在同一事务内创建，基线分支默认取项目 `defaultBranch`，再缺省 `main`（`createTeam`）；自动建的项目 `defaultBranch` 取仓库检出的分支（见[项目](../projects.md)）。
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
- 改团队路由入参：`validators/project-teams.ts` 与前端 `lib/api/teams.ts` 一起改；两个创建入口共用 `TeamCreateFields.tsx`，新字段加在那里。人填的字段规则改在 `shared/project-team-draft.ts`，不要在前端另写一份正则（`team-draft.test.ts` 用路由校验器对照）。
- `createTeam` 的 git 检查必须在 `narratorService.create` 之前；新增创建入口也只能经 `createTeam`。
- 新建会话弹窗的团队部分：`CreateNarratorModal` 的测试大量 `mock.module` 了 `@mantine/core`、`@tanstack/react-query`、`@tanstack/react-router`，弹窗静态导入链里只能用这些 mock 已提供的导出；所以 `create-narrator-team.ts` 不导入路由与 `useTeams`，用到路由的 `CreateTeamFromDirectory.tsx` 懒加载。测试：`create-narrator-team.test.ts`（各原因）、`create-team-start.browser.test.ts`（Chromium，真实路由）。
- IM 网关不得驱动团队会话（见 [IM 网关](../gateway.md)）。

## 相关
- [工作项](work-items.md)：删除前检查依据的「未收尾」定义。
- [团队页与审批](page.md)：成员列表的前端展示。
