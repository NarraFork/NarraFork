---
id: collaboration.project-pages
title: 项目页、项目列表与项目设置页
summary: 重设计后的项目页（等你处理、团队卡片、会话三视图）、项目列表的卡片数字与排序、/projects/:id/settings 七组设置，以及它们背后的有界读接口。
anchors:
  - server/services/project-overview.ts
  - shared/project-overview.ts
  - frontend/hooks/useProjectOverview.ts
  - frontend/components/project/project-page-model.ts
  - frontend/components/project/ProjectHeader.tsx
  - frontend/components/project/ProjectAttention.tsx
  - frontend/components/project/ProjectTeamCards.tsx
  - frontend/components/project/ProjectSessions.tsx
  - frontend/components/project/ProjectListCard.tsx
  - frontend/components/project/ProjectSettingsPage.tsx
  - frontend/components/project/ProjectSettingsForms.tsx
  - frontend/components/project/ProjectRoutinesList.tsx
  - frontend/components/project/ProjectSettingsPanel.tsx
  - frontend/routes/projects/$projectId.tsx
  - frontend/routes/projects/$projectId_.settings.tsx
  - frontend/routes/projects/index.tsx
  - server/routes/__tests__/projects-overview.test.ts
keywords:
  - /api/projects/summaries
  - /api/projects/:id/attention
  - /api/projects/:id/sessions
  - counts=true
  - 等你处理
  - 项目设置
  - 新团队
  - 新会话
  - 进行中
  - 最近 7 天
  - readProjectSummaries
  - readProjectAttention
  - readProjectSessions
  - scanPendingCalls
  - TeamCard
status: draft
verified_at: ef28ecaaf
---
# 项目页、项目列表与项目设置页

项目页是一个仓库的主页：先是「等你处理」，再是团队卡片和会话列表；设置单独一页。项目列表每个项目一张卡片，数字来自一次汇总请求。

## 关键规则
读接口（`server/services/project-overview.ts`，路由在 `server/routes/projects.ts`，形状与上限在 `shared/project-overview.ts`）：
- 三个新接口都先 `requireSqliteProjectMutation`：PG 上 503 `POSTGRES_UNSUPPORTED`，在任何权限检查之前（`project-teams-postgres.test.ts`）。SQL 不用 JSON 函数和 `indexed by`。
- `GET /api/projects/summaries`：调用者可读的前 200 个项目（列表同序）。正在运行的会话（primary、非隐藏、非协调者、可读，按链接或 `context_project_id` 各读一次）、团队（活跃、协调者可读）、待决调用、ready 工作项，每类最多读 501 行；超出则 `capped`。最近活动：先按 `(variant, updated_at, id)` 取最新 2000 个会话，再查其中可读、属于这些项目的。`waitingCount` 只算调用者能决定的调用（`canWriteNarrator`）和他是成员的团队的 ready 项，且只在调用者对项目有写权限时给。
- `GET /api/projects/:id/attention`：读不到项目 404；能读但没有项目写权限 403。待决调用经 `teams/team-board.ts:scanPendingCalls`（团队页同一个 `status` 索引扫描，最多 5 页×100，`accept` 跳过不能决定的调用），范围是根会话（子代理取 `acl_root_narrator_id`）链到本项目或 `context_project_id` 是本项目；最多 50 条，再加调用者是成员的团队的 ready 项最多 20 条（`readReadyItems`，`(project_id, state, id)`）。每条带来源：团队（id、名称）或会话（标题、所有者名）。预览同团队页（`pendingApprovalsOf`，输入只读 4KB 前缀）。
- `GET /api/projects/:id/sessions?view=active|all|mine&cursor&limit`：读不到项目 404。primary、非隐藏、未归档、可读、链到项目（任一角色或 `context_project_id`），排除协调者（`project_teams` 主键不存在）。`active` 先 working/waiting 再最近 7 天内更新的其余会话，游标带阶段；`all`/`mine` 按 `(updated_at, id)` 降序。首页带三个标签的计数，各数到 1000 为止（子查询 `limit 1000`）。运行中的行带最近一次工具调用（每行一次索引探测）。页大小默认 30、最多 100。
- 团队卡片走已有的 `GET /:projectId/teams?counts=true`（`server/routes/project-teams.ts`）：每页最多 24 个团队，每个团队带 `card`（`teams/team-board.ts:readTeamCards`：按状态分组计数一次读完，运行中数最多 21，成员才有待批数，最近事件一行）。

前端：
- `routes/projects/$projectId.tsx`：页头（`ProjectHeader`：名称、固定到侧栏、路径尾部（悬停看全路径）、默认分支；「新团队」「新会话」；「…」里有项目设置，大纲开启时还有打开大纲和任务板切换）。手机上页头第一行带 `MobileNavButton`，浮动菜单按钮不再盖住标题。只在 `canWrite` 时读「等你处理」。PG 上团队卡片 503 时不显示「新团队」。
- 「等你处理」复用团队页的 `TeamAttention`（`flush`、手机 `compact`），条目来自 `project-page-model.ts:projectAttentionEntries`，卡片前写团队名、会话卡片后写「谁的会话」；决定后刷新项目的读取。ready 项和团队名点开团队页。
- 团队卡片（`ProjectTeamCards`）：状态句用团队页的 `statusSentence`（`teamCardStatus`），数字为进行中（排队+进行+评审中）/就绪/完成，成员看到「N 等你」（待批+就绪）；末尾虚线「新团队」卡；没有团队时一行说明加按钮。
- 会话（`ProjectSessions`）：三个标签带计数（`999+`），「进行中」分运行中与「最近 7 天」两段（`sessionSections`）。
- 项目列表（`routes/projects/index.tsx` + `ProjectListCard`）：排序有等你处理的在前，再按最近活动（`sortProjects`）；搜索框常驻。
- 设置页 `/projects/$projectId/settings`（`ProjectSettingsPage`）七组：成员与可见性（`ProjectAccessPanel`）、技能（`ProjectSkillsManager`）、例程（`ProjectRoutinesList`，模式写成「新会话默认加载 / 会话内手动加载」，加项目特质层）、命令（命令编辑器、命令白/黑名单）、工作区与容器（名称、说明、项目目录、目录白/黑名单）、设备、知识库（链接到实例设置）。改动即存（`ProjectSettingsForms`：文本框离开时存、规则每次增删改都只发那一个 `chapterSettings` 键，服务端浅合并）。只有核实过的 `canManage` 才可编辑。会话菜单的项目设置弹窗（`ProjectSettingsPanel`）现在只是去设置页的入口。

## 从哪读起
- `server/services/project-overview.ts`，再到 `teams/team-board.ts` 的 `scanPendingCalls`、`pendingApprovalsOf`、`readTeamCards`。
- `frontend/routes/projects/$projectId.tsx`、`frontend/components/project/project-page-model.ts`。

## 改它时
- 新读接口要先 503（PG），读不到项目 404；「等你处理」读者 403。路由测试 `server/routes/__tests__/projects-overview.test.ts` 覆盖读者、非成员、私有项目和公开项目。
- 改团队页的待批扫描（`team-board.ts`）会同时改项目页、项目列表和侧栏团队标签的数字。
- 模型与组件测试：`project-page-model.test.ts`、`project-components.test.tsx`、`project-page.test.tsx`、`project-forms.test.tsx`、`ProjectSettingsPanel.test.tsx`；新加的 `projects` 文案两种语言都要有（`project-components.test.tsx` 逐个核对）。
- 远程构建（`frontend/remote/route-tree.tsx`）仍用旧的 `ProjectSummaryCard` 与 `ProjectSessionList`，不经这些接口。

## 相关
- [项目](projects.md)
- [团队页与审批](teams/page.md)
- [最近标签页](recent-tabs.md)
