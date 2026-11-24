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
  - frontend/hooks/team-onlooker-refresh.ts
  - frontend/hooks/useTeams.ts
  - frontend/lib/api/teams.ts
  - frontend/routes/projects/$projectId_.teams.$teamId.tsx
  - server/lib/coordinator-outputs-path.ts
  - server/lib/validators/project-teams.ts
keywords:
  - project_teams
  - team_work_items
  - team_work_events
  - /api/projects/:projectId/teams
  - /api/projects/:projectId/team-overlaps
  - team-locks/release
  - Team 工具
  - 协调者
  - coordinator
  - 工作项
  - 独占路径
  - exclusive_key
  - 团队页
  - 团队状态
  - team_status
  - POSTGRES_UNSUPPORTED
  - TEAM_TRAIT
status: stub
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 团队

项目团队 = 一个带 `team` trait（`TEAM_TRAIT`）的协调者叙述者 + 它在 `project_teams` 表里的一行；协调者派出的子代理做具体工作，每个工作项对应一条分支和一个 worktree。仅 SQLite：`/api/projects/:projectId/teams*`、`team-overlaps`、`team-locks/*` 在 PostgreSQL 上经 `requireSqliteProjectMutation` 返回 503 `POSTGRES_UNSUPPORTED`（`project-teams.ts`）。注意：`server/lib/agent/tools/team-status.ts` 的 `TeamStatus` 工具与项目团队无关，它查询的是当前会话的子代理和后台 bash 任务（见子代理节点）。

## 关键规则
身份、访问与成员：
- 团队 id 就是协调者的 narrator id，团队名是其标题；访问只看协调者的叙述者 ACL——读即读团队（onlooker），写即成员；无读权限返回 404，只读者改动返回 403（`teams/team-service.ts:loadTeamForAccess`）。
- 创建要求项目写权限；项目必须有 git 仓库目录（`gitPath`），已归档项目不能新建团队（409 `PROJECT_ARCHIVED`）；协调者叙述者与团队行在同一事务内创建，基线分支默认取项目 `defaultBranch`，再缺省 `main`（`createTeam`）。
- 没有独立的团队成员表：成员列表由协调者 owner、协调者上的显式授权、协调者最近 500 条消息里的发言者、以及（协调者属于项目且受众为 project/public 时）项目 owner 与授权拼出，逐个按叙述者 ACL 批量判定，上限 `TEAM_MEMBERS_LIST_LIMIT` = 100，`more` 标记被截断；授权与撤销走普通叙述者分享服务，不在这里（`teams/team-members.ts`）。
- 哪个会话属于团队：协调者本身，或 ACL 根是协调者的子代理（`team-membership.ts:teamIdOfNarrator`）；`team-session-memo.ts` 缓存这个判断（IM 网关用），数据导入/清空后整体失效。团队自己的 worktree 内写文件和委派不需要人批准（`teamWorktreePathsForNarrator`，上限 64 个，超出退回询问人；`.git` 控制目录除外），由 `narrator-permission.ts` 使用。

生命周期：
- 归档协调者即归档团队，`project_teams.status` 镜像协调者状态（`startTeamStatusSync`）；已归档团队不能改（409 `TEAM_ARCHIVED`）。
- 删除协调者前检查：还有「未收尾，或已收尾但仍记录着 worktree」的工作项就拒绝（`teams/team-records.ts:assertTeamRemovable`），否则在同一事务内连带删除团队行（`deleteTeamOfNarratorInTransaction`）。团队行 RESTRICT 叙述者与项目删除，删团队级联删工作项与事件（`team-tables-contract.test.ts`）。
- 数据导入/导出：三张团队表不导出，导入后会话的 `team` trait 以本机有没有团队行为准（`data-portability.ts:reconcileImportedTeamTraits`）。

工作项（`teams/work-items.ts`，`team_work_items`）：
- 状态：queued / in_progress / in_review / ready / merged / cancelled（`shared/project-teams.ts:TEAM_WORK_ITEM_STATES`）；看板五列：queued、in_progress、review（含 in_review 与 ready）、done（merged）、cancelled。
- `work.create`：先经现有 narrator worktree 创建通道建分支 `team/<标题 slug>-<id 哈希 8 位>` 与 worktree，再写行与 `work.created` 事件，初始 `queued`；`Agent({ isolation: "worktree" })` 建的是 kind=`isolated` 的项，初始 `in_progress`，子代理结束时若没有提交也没有未提交改动，就清理 worktree 并取消该项（`settleIsolatedWorkItem`）。第一层子代理经 `attachWorker` 记为工作者，queued 的项随之开始。
- `work.review`：blocker 把项退回 `in_progress`，clear 留在 `in_review`；`work.ready` 需要最新一轮评审为 clear（否则 409 `TEAM_WORK_ITEM_NOT_REVIEWED`）且 worktree 无未提交改动（409 `TEAM_WORK_ITEM_DIRTY`）；评审之后的新提交不拦，只在结果里计数。
- `work.sync`：服务端从不合并；基线已在分支内就返回 up_to_date，否则把一条确定性的 `git merge --no-ff <基线提交>` 指令交给工作者，投递结果分 started / queued / blocked / wake_failed / failed / none。
- 服务端从不删分支、不自己跑 `git worktree`：创建与清理都走现有 worktree 服务（`work-item-ports.ts`）；`cleanup` 只能用于 merged 或 cancelled 的项，丢未提交文件或未合并提交时必须带人确认过的损失（`force` + `confirmedLoss`），分支保留；`Team` 的 `cleanup` 每次都等人批准。
- 工作项更新是乐观并发：按「状态 + `updated_at`」条件更新，对不上就 409 `TEAM_WORK_ITEM_CHANGED`；进入 merged/cancelled 时同事务释放独占锁并记 `work.exclusive_released`。
- `merged` 只由祖先检测自动判定：`ready` 项的记录 head 已在基线分支内（squash/rebase 合并检测不到），事务内核对状态、head、`updated_at` 一致才写入，之后不可逆。
- 每次状态变更、评审、同步、清理、check-in、决策都追加一行 `team_work_events`（`recordWorkEvent`，actor 为 person / agent / system，详情上限 8KB）；check-in 是一个团队只保留一个的定时唤醒（5 分钟到 1 天），记为 `team.checkin` 事件，重启与取消归档时重新装填。
- 服务端读 git 只经 `teams/team-git.ts`：禁用 hook、fsmonitor、外部 diff/textconv、写 index，读上限沿用 `gitService`（60s、1MB）；`changedPaths` 只比较两个提交，不读工作区。

重叠与独占路径（`teams/team-overlap.ts`）：
- 后台每两分钟分批（每批 50 项）刷新活动工作项相对基线的改动路径（每项上限 2000 条或 128KiB，超出退化为顶层目录，目录以 `/` 结尾），按项目比较重叠；卡住的项会被跳过若干轮。
- 独占路径来自项目设置（`projects.chapterSettings` 里的独占路径 glob，最多 50 条、每条 ≤200 字符、不接受匹配全部的 glob）；工作项 `ready` 时若改动命中，就在该项上记 `exclusive_key`（唯一部分索引 `uq_team_work_items_exclusive` 保证项目内同时只有一个持有者），别的项再要 ready 会得到 409 `TEAM_EXCLUSIVE_LOCK_HELD`；merged/cancelled 释放。强制释放要项目 manage 权限（`POST /api/projects/:projectId/team-locks/release`）。
- 路径无法读出且项目设有独占路径时，`work.ready` 拒绝（409 `TEAM_CHANGED_PATHS_UNAVAILABLE`）。

协调者约束与状态（`coordinator-limits.ts`、`coordinator-outputs.ts`、`team-status.ts`）：
- 软限制：编辑行数 30、新文件 60、每轮文件数 3、读 300 行、搜索 100 行、Bash 输出 8KB（`DEFAULT_COORDINATOR_LIMITS`，可被团队设置覆盖）超出时只给结果追加提醒行并写 `coordinator.overrun.*` 事件，不拒绝；读/搜索/Bash 的超大输出整份存到 `~/.narrafork/coordinator-outputs/<narratorId>/`（内容哈希命名、按部分分块、每个协调者 200MB，旧文件先淘汰），只对协调者本身（主叙述者且有 team trait）生效，子代理不受影响。
- 团队状态：系统在运行开始、压缩/清空上下文后、长运行的工具边界（至少相隔 10 分钟且文本有变）把一行 `team_status` 系统行写进协调者历史，不进系统提示词；文本确定、≤6KB，含团队简介（≤4KB，子代理也会拿到）、本周超限计数、待批准调用、工作项、成员（最多列 12 人）、重叠与独占锁、最近决策。
- 任何成员都可对团队树里的待决调用批准/拒绝/回答；工具调用行只记「人批的」，具体是谁另记为团队事件（`team-decisions.ts`，best-effort，写失败不影响决定）。IM 网关永远不能做这种决定。

`Team` 工具与路由：
- 协调者用 `Team` 工具（仅 team trait 会话提供，`server/lib/agent/tools/team.ts`）：work.list/create/review/ready/sync/cancel、brief、checkin、cleanup、decision；`work.list` 最多 30 项；权限逐动作判定（`narrator-permission.ts`：记账类与团队自己的 worktree 创建/同步在只读之外也允许，`cleanup` 总要人批准）。
- 路由挂在 `/api/projects/:projectId/teams...`：列表/创建/详情/修改/归档/取消归档、`summary`、`board`（每列每页 50）、`events`、`approvals`、`members`、`running`，以及 `team-overlaps`、`team-locks/release`（`server/routes/project-teams.ts`，读模型在 `teams/team-board.ts`，每条都是带 LIMIT 的主键/索引读）。

## 前端
- 团队页路由 `frontend/routes/projects/$projectId_.teams.$teamId.tsx`（不嵌在项目页下，占满外壳内容区）→ `components/teams/TeamPageView.tsx`；`TeamWorkspace.tsx` 按自身宽度选三栏（团队列表 / 协调者对话 / 看板与动态）、两栏或标签页；对话用普通叙述者面板。`team-page-model.ts` 是纯规则（状态图标、轮询退避、「全部暂停」顺序）。
- `hooks/useTeams.ts`：摘要在叙述者 socket 的相关帧上合并重取，同时带退避轮询（变化后 4s，翻倍到 60s，标签页隐藏时暂停）；看板、动态、审批各自按变化重取。`lib/api/teams.ts` 是客户端。
- `hooks/team-onlooker-refresh.ts`：访问权限变化（`narrator_access_changed`、`project_access_changed`）时刷新最近标签页的 `teamOnlooker` 标记，该标记让只读旁观者不收「等待」提醒（见[通知与注意力](../notifications.md)、[最近标签页](../recent-tabs.md)）。

## 从哪读起
- `server/services/teams/team-service.ts`：团队创建与读取。
- `server/services/teams/work-items.ts`：工作项生命周期与 check-in。
- `server/services/teams/team-overlap.ts`：改动路径与独占锁。
- `server/services/teams/team-status.ts`、`team-board.ts`：团队状态注入与团队页读模型。
- `shared/project-teams.ts`：状态、上限、事件种类、`Team` 动作表，前后端共用。
- 测试：`server/services/teams/__tests__/`（`team-tables-contract.test.ts` 在 SQLite 与 PG 上对同一组约束；`work-item-lifecycle.test.ts`、`team-overlap.test.ts`、`coordinator-limits.test.ts`）。

## 改它时
- 加一个 `Team` 工具动作：`shared/project-teams.ts:TEAM_TOOL_ACTIONS`、`tools/team.ts` 的参数与分发、`narrator-permission.ts` 的逐动作分类（`isTeamReadAction`/`isTeamCleanupCall`，漏了会被当成写动作或绕过批准）、`team-status.ts` 与前端 `team-page-model.ts` 里对事件种类的文案。
- 加工作项状态或事件种类：`TEAM_WORK_ITEM_STATES`/`TeamWorkEventKind`、表上的 check 约束（SQLite 与 `drizzle-postgres` 两边，`team-tables-contract.test.ts` 会失败）、看板列映射 `TEAM_BOARD_COLUMN_STATES`。
- 动团队三张表：`server/db/schema.ts` 与 `postgres-schema.ts` 同步；它们不在数据导出清单里，保持 `reconcileImportedTeamTraits` 与清空会话时先删团队表的顺序（团队行 RESTRICT 叙述者删除）。
- 不变量：成员关系永远取自协调者的叙述者 ACL，不要加团队成员表；服务端不合并、不删分支、不直接跑 `git worktree`；所有团队读取必须带 LIMIT 并且 SQLite 专用；IM 网关不得驱动团队会话（见 [IM 网关](../gateway.md)）。
- 新增团队写路由：沿用文件顶部的 `requireSqliteProjectMutation` 中间件，再做 `loadTeamForAccess` 访问判定。

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
