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
  - assertTeamProjectUsable
  - TEAM_PROJECT_CHANGED
  - other-repository
  - managesInTransaction
  - teamConversionTestHooks
  - checkTeamDraft
  - teamBaseBranchSchema
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
verified_at: 1f8e28731
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
- 新团队在写任何东西之前做两项 git 检查（`team-service.ts:assertTeamProjectUsable`，异步 git，在同步事务之外），`createTeam` 与「升级为团队」（下文）都调它：
  - 项目目录必须是本地 git 工作树（`team-git.ts:isGitWorkTree`，`rev-parse --is-inside-work-tree`，禁用仓库配置里的程序，10s 超时；目录不存在、bare 仓库、失败都算否），否则 409 `TEAM_PROJECT_NOT_GIT`。项目可以关联任意已有文件夹，所以只有 `gitPath` 不够。
  - 基线分支（给定的，或项目 `defaultBranch`，再缺省 `main`）必须解析到提交（`teamGit(gitPath).resolveCommit`，即工作项建 worktree 时用的同一个 `rev-parse --verify ...^{commit}`），否则 409 `TEAM_BASE_BRANCH_UNRESOLVED`，消息里带分支名；git 读不成单个修订的项目默认值同样按这个码拒绝。
  - 测试：`projects-resolve-directory.test.ts`（拒绝后叙述者与团队行数不变）；其他团队测试用 `__tests__/team-repo.fixture.ts:initTeamRepo` 给项目目录建真实仓库。
- 协调者的 cwd 永远是项目的 `gitPath`，不是用户选的子目录（`createTeam`）。

两个创建入口，都调同一条 `POST /api/projects/:projectId/teams`，字段都来自 `components/teams/TeamCreateFields.tsx`（名称、基线分支、说明；「升级为团队」的对话框也用它，见[团队页](page.md)）：
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
  - 工作目录的仓库不是项目的仓库 → 409 `TEAM_WORKSPACE_UNAVAILABLE`，`details.reason: "other-repository"`（`prepareUpgrade`）：项目索引按路径前缀匹配，项目目录下的嵌套仓库或没登记的 submodule 会被当成本项目，工作项却会从别的仓库开分支。比较的是仓库身份（`probeLocalGitWorkspace(gitPath)` 的公共 git 目录经 `gitWorkspaceIdentity`，对上工作区的 `git.repositoryKey`），不是检出根，所以 linked worktree 仍可升级。工作目录被索引到别的项目时先回 `TEAM_SESSION_OTHER_PROJECT`（事务外先查一次 `workingDirectoryElsewhere`）。
  - 没给 `name` 而标题为空或超过 120 → 400 `TEAM_NAME_INVALID`。
  - 项目的两项 git 检查（与 `createTeam` 同一个 `assertTeamProjectUsable`，基线分支取给定的、项目 `defaultBranch`、再缺省 `main`）→ 409 `TEAM_PROJECT_NOT_GIT` / `TEAM_BASE_BRANCH_UNRESOLVED`。排在会话检查之后（别的项目的会话先得到 `TEAM_SESSION_OTHER_PROJECT`）、工作区检查之前。
- 写入：`narratorTraitsLock` 内一个同步事务，重读会话与项目、重查上面的拒绝；owner/管理员也按重读的行再判一次（`managesInTransaction`，同 `canManageNarratorAcl` 对 primary 的规则），事务外检查之后所有权被转走 → 403，什么都不写（git 检查不在事务里重跑：项目的 `gitPath`，或没给 `baseBranch` 时的 `defaultBranch`，与检查时不同 → 409 `TEAM_PROJECT_CHANGED`），然后追加 `team` trait、把 `contextProjectId` 钉成这个项目、改名时写标题、插团队行、记 `team.created` 事件（`detail: { baseBranch, fromSession: true }`）。插行失败则 trait 也不写。
- 提交后：`forgetTeamSessions()`；广播 `custom_traits_changed`（改名时加 `title_updated` 与 `narrator:title_updated`）；重算项目链接；`announceTeamChange` 通知最近标签页持有者（见访问控制）；写一条 `team_upgrade` 说明（`schedule: "none"`，不唤醒，人发下一条消息才开始第一轮协调；这条说明不算对话末尾，发送按钮不会因它变成「继续」，`team_disband` 同理，见[恢复](../../narrator/recovery.md)）；`replace_tools` epoch 上写重建基线的 `tool_loaded` 通知（`tool-loading-service.ts:requestToolDeclarationRebaseline`），下一次请求开新 epoch 声明 `Team`。已经派出的子代理随 ACL 根立即算进团队。
- 测试接缝 `teamConversionTestHooks.beforeTransaction`：事务外检查都做完、拿锁之前调用，测试用它在两次检查之间改行（如转移所有权）；生产不设。
- 说明与重建基线通知都不是谁的回合：重试会保留它们，「继续」与重试目标都跳过它们（见[中断与恢复](../../narrator/recovery.md)）。
- 说明的消息 id 由（会话、种类、团队行 `createdAt`）派生，写过就不再写；正文给出团队名、谁升级的、实际工作目录以及它是否在主检出里（`lib/prompts/team-lead.ts:teamUpgradeNote`）。

解散团队、保留会话（`disbandTeam`，`POST /api/projects/:projectId/teams/:teamId/disband`）：
- 谁能解散：项目写权限 + 会话 owner 或管理员。读不到 → 404；能写不能管 → 403。
- 拒绝：协调者已归档 → 409 `TEAM_ARCHIVED`（先取消归档）；`working`/`waiting` 或持有执行权 → 409 `NARRATOR_EXECUTION_BUSY`；还有未收尾或仍记录 worktree 的工作项 → 409 `TEAM_HAS_LIVE_WORK`。
- 写入：`narratorTraitsLock` 内一个事务，先按重读的协调者行再判 owner/管理员（`managesInTransaction`，否则 403），再 `deleteTeamOfNarratorInTransaction` 删团队行（工作项与事件级联删除），去掉 `team` trait。标题、受众、消息和钉住的 `contextProjectId` 都不动。
- 提交后：`forgetTeamSessions()`、`forgetTeamStatus`、`forgetCoordinatorRun`、`cancelCheckin`、异步删 `coordinator-outputs/<id>`；广播 `custom_traits_changed` 与 `announceTeamChange`；写一条 `team_disband` 说明（同样的确定 id 规则）；`removeTabFromAllUsers("team", id)` 移除所有人侧栏里的团队标签（会话自己的标签保留，失败只记日志）。`Team` 工具由运行时的卸载对账从下一次请求里去掉，不需要重建基线。

生命周期：
- 归档协调者即归档团队，`project_teams.status` 镜像协调者状态（`startTeamStatusSync`）；已归档团队不能改（409 `TEAM_ARCHIVED`）。
- 删除协调者前检查（`teams/team-records.ts:assertTeamRemovable`）：
  - 还有「未收尾，或已收尾但仍记录着 worktree」的工作项就拒绝；
  - 否则在同一事务内连带删除团队行（`deleteTeamOfNarratorInTransaction`）。
- 团队行 RESTRICT 叙述者与项目删除，删团队级联删工作项与事件（`team-tables-contract.test.ts`）。
- 侧栏的团队标签（`team:<id>`）跟着生命周期走：归档时 `startTeamStatusSync` 从所有持有者的侧栏移除（取消归档不放回），删除协调者或解散团队时一并移除，失去协调者读权限的持有者也会被移除（见[最近标签页](../recent-tabs.md)）。
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
- `createTeam` 的 git 检查必须在 `narratorService.create` 之前；新增从零创建团队的入口也只能经 `createTeam`。「升级为团队」（`team-conversion.ts:upgradeSessionToTeam`）是另一条路径，不经过 `createTeam`，但调同一个 `assertTeamProjectUsable`；新增别的建团队路径同样要调它，并在事务里复核检查所依据的项目字段。`project-teams-upgrade.test.ts` 覆盖两个拒绝码（不写 trait、团队行、事件和说明）与 `TEAM_PROJECT_CHANGED`，以及 submodule 会话被拒、linked worktree 通过、检查后所有权转移时升级/解散都 403；重试跨过升级/解散保留说明与通知、重试后的模型输入里原提示只出现一次（`buildRuntimeHistory`）、「继续」看过说明。
- 新建会话弹窗的团队部分：`CreateNarratorModal` 的测试大量 `mock.module` 了 `@mantine/core`、`@tanstack/react-query`、`@tanstack/react-router`，弹窗静态导入链里只能用这些 mock 已提供的导出；所以 `create-narrator-team.ts` 不导入路由与 `useTeams`，用到路由的 `CreateTeamFromDirectory.tsx` 懒加载。测试：`create-narrator-team.test.ts`（各原因）、`create-team-start.browser.test.ts`（Chromium，真实路由）。
- 改升级/解散：`team` trait 与团队行必须在同一事务、同一 `narratorTraitsLock` 下一起变；提交后清 `team-session-memo` 的缓存；`project-teams-upgrade.test.ts` 覆盖每个拒绝码、事务原子性、并发 trait 写入、说明只写一次与「升级→解散→再升级」。
- IM 网关不得驱动团队会话（见 [IM 网关](../gateway.md)）。

## 相关
- [工作项](work-items.md)：删除前检查依据的「未收尾」定义。
- [团队页与审批](page.md)：成员列表的前端展示。
