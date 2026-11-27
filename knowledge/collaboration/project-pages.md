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
  - tests/frontend/projects-page.test.tsx
  - server/services/__tests__/narrator-acl-batch-parity.test.ts
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
  - /api/projects/:id/members/count
  - countProjectMembers
  - N 位成员
  - scanPendingCalls
  - TeamCard
status: draft
verified_at: 29a63ae6cf12cd6b8ac56e38da9fa769d9bc7b23
---
# 项目页、项目列表与项目设置页

项目页是一个仓库的主页：先是「等你处理」，再是团队卡片和会话列表；设置单独一页。项目列表每个项目一张卡片，数字来自一次汇总请求。

## 关键规则
读接口（`server/services/project-overview.ts`，路由在 `server/routes/projects.ts`，形状与上限在 `shared/project-overview.ts`）：
- 三个新接口都先 `requireSqliteProjectMutation`：PG 上 503 `POSTGRES_UNSUPPORTED`，在任何权限检查之前（`project-teams-postgres.test.ts`）。SQL 不用 JSON 函数和 `indexed by`。
- `GET /api/projects/summaries`：调用者可读的前 200 个项目（列表同序：`updated_at` 降序、id 升序；只读 id、owner、可见性、`updated_at` 四列，经读 worker，不读 `chapter_settings`）。正在运行的会话（primary、非隐藏、非协调者、可读，按链接或 `context_project_id` 各读一次）、团队（活跃、协调者可读）、待决调用、ready 工作项，每类最多读 501 行；超出则 `capped`。最近活动：先按 `(variant, updated_at, id)` 取最新 2000 个会话，再查其中可读、属于这些项目的。等待数只在调用者有写权限的项目里读（`projectsWritableBy`，一条授权查询）：待决调用只扫这些项目，ready 项只算活跃且协调者未归档的团队（与「等你处理」同一个 `liveTeam` 条件）里他是成员的；运行中会话数与团队数同样截到 500。
- 三个接口判项目访问都只读项目的 id、owner、可见性三列再走 `assertProjectAccess`（`loadProjectAclRow`），不用读整行的 `loadProjectForAccess`（守卫测试读源码）。
- `GET /api/projects/:id/attention`：读不到项目 404；能读但没有项目写权限 403。待决调用经 `teams/team-board.ts:scanPendingCalls`（团队页同一个 `status` 索引扫描，最多 5 页×100；`acceptPage` 每页一次批量判断：按 ACL 根去重后交给 `narrator-acl.ts:judgeNarratorsWriteForPrincipal`，判断次数随不同会话数增长、不随调用数增长，`overviewAccessStats` 记账，测试断言上限），范围是根会话（子代理取 `acl_root_narrator_id`）链到本项目或 `context_project_id` 是本项目；最多 50 条，再加调用者是成员的团队的 ready 项最多 20 条（`readReadyItems`，`(project_id, state, id)`）。每条带来源：团队（id、名称）或会话（标题、所有者名）。预览同团队页（`pendingApprovalsOf`，输入只读 4KB 前缀）。
- `GET /api/projects/:id/sessions?view=active|all|mine&cursor&limit`：读不到项目 404。primary、非隐藏、未归档、可读、链到项目（任一角色或 `context_project_id`），排除协调者（`project_teams` 主键不存在）。`active` 先 working/waiting 再最近 7 天内更新的其余会话，游标带阶段；`all`/`mine` 按 `(updated_at, id)` 降序。查询从项目自己的会话集合出发（`projectSessionIds`：链接表 `project_id` 索引 ∪ `context_project_id` 索引，`CROSS JOIN narrators` 按主键取行；写成 `IN` 过滤时，没有统计信息的 SQLite 会走整个 `(variant, …)` 索引，20 万会话约 150ms，这样不到 1ms）。首页带三个标签的计数，各数到 1000 为止（子查询 `limit 1000`）。「进行中」拒绝「全部」的游标、反之亦然（400）。运行中的行带最近一次工具调用（每行一次索引探测，紧凑行用），每行还带 `cwd`（截 512 字）与 `substatus`（会话卡片用）。页大小默认 30、最多 100。
- `GET /api/projects/:id/members/count`（`project-membership.ts:countProjectMembers`，形状 `shared/project-overview.ts:ProjectMemberCount`）：能读项目就能读（`requireProjectAccess(read)`，读不到 404），不带名单。owner 加上持有项目授权（`acl_grants` 的 user 主体、`domain_kind is null`）的人，各算一次（同一人多个档位只算一个）；一次 `selectDistinct` 走 `idx_acl_grant_scope`，最多读 `PROJECT_MEMBER_COUNT_LIMIT`+1=1000 个，超出则 `count`=999、`more`。经读 worker（`worker-required`），不是 SQLite 专用。测试在 `server/routes/__tests__/project-membership.test.ts`。
- 团队卡片走已有的 `GET /:projectId/teams?counts=true`（`server/routes/project-teams.ts`）：每页最多 24 个团队，每个团队带 `card`（`teams/team-board.ts:readTeamCards`，计数经读 worker、5s 超时：未结束的状态按 `(team_id, state, id)` 分组精确计数；已合并、已取消每个团队每种各数到 1000（`LIMIT` 子查询，一条 `UNION ALL`），卡片显示「999+」，24 个团队各 5 万条已合并项约 30ms，旧的整段分组计数在主线程约 120ms；协调者行与最近事件一条语句；运行中数最多 21，成员才有待批数）。

前端：
- `routes/projects/$projectId.tsx`：页头（`ProjectHeader`：名称、固定到侧栏、路径尾部（悬停看全路径）、默认分支、「N 位成员」（`useProjectAccess.ts:useProjectMemberCount`，键在 `["projects", id, …]` 下，成员变更与 `project_access_changed` 一起失效；超限写「N+ 位成员」（N 取服务端给的上限 999），读不到就不显示；点击去设置页 `#settings-members`，设置页按 hash 选中并滚到那一组，`ProjectSettingsPage.tsx:groupOfHash`）；「新团队」「新会话」；「…」里有项目设置，大纲开启时还有打开大纲和任务板切换）。手机上页头第一行带 `MobileNavButton`，浮动菜单按钮不再盖住标题。只在 `canWrite` 时读「等你处理」。PG 上团队卡片 503 时不显示「新团队」。
- 「等你处理」复用团队页的 `TeamAttention`（`flush`、`inPage`：桌面上没有内部滚动，多于 3 条折叠；手机上与团队页一样横向滑动加圆点），条目来自 `project-page-model.ts:projectAttentionEntries`，卡片前写团队名、会话卡片后写「谁的会话」；工具调用按工具说成「请求编辑文件 / 运行命令 / 读取文件 / 访问网页 / 使用 X」（`team-page-model.ts:toolVerb`）。决定后刷新 `projectDecisionKeys` 列出的读取：本页等你处理、项目列表汇总、团队卡片、会话列表，来自团队时还有该团队页（审批与摘要）。ready 项和团队名点开团队页。
- 团队卡片（`ProjectTeamCards`，缓存里已归档的团队不显示，`liveTeamCards`）：状态句用团队页的 `statusSentence`（`teamCardStatus`），数字为进行中（排队+进行+评审中）/就绪/完成，成员看到「N 等你」（待批+就绪）；末尾虚线「新团队」卡；没有团队时一行说明加按钮。
- 会话（`ProjectSessions`）：三个标签带计数（`999+`）。「进行中」先是运行中与等待中的会话，用首页的会话卡片（`dashboard/DashboardSessions.tsx:SessionCard`，同样的网格 `SESSION_CARD_GRID_COLS`，`dashboard-sessions.ts:toSession` 叠加实时活动），最近工具调用来自 `useNarratorActivity` 的 activity 订阅；最多 12 张卡片（`PROJECT_RUNNING_CARDS_SHOWN`）再「显示全部」，展开后也不超过首页的订阅上限 40；卡片不再另写「在做什么」。其后是「最近 7 天」的紧凑行（`sessionSections`）；「全部」「我的」都是紧凑行。
- 项目列表（`routes/projects/index.tsx` + `ProjectListCard`）：排序有等你处理的在前，再按最近活动（`sortProjects`）；搜索框常驻。
- 设置页 `/projects/$projectId/settings`（`ProjectSettingsPage`）七组：成员与可见性（`ProjectAccessPanel`）、技能（`ProjectSkillsManager`）、例程（`ProjectRoutinesList`，模式写成「新会话默认加载 / 会话内手动加载」，加项目特质层）、命令（命令编辑器、命令白/黑名单）、工作区与容器（名称、说明、项目目录、团队默认设置 `ProjectTeamDefaults`——新团队的基线分支 `defaultBranch` 离开输入框时存、新工作项的起点 `chapterSettings.teams.workStart` 选「自动 / origin / 本地」即存，只发 `teams` 键并保留独占路径、不回发 `teams.github`，`teamsWithWorkStart`；下面是确认的 GitHub 仓库与 origin 现在的去向，管理员可确认或清除，`ProjectGithubTarget`——目录白/黑名单）、设备、知识库（链接到实例设置）。改动即存（`ProjectSettingsForms`）：名称与说明离开输入框时存；项目目录只在点「保存目录」并确认（说明会话会按目录重新归属）后存，与已存值比较时忽略末尾的 `/`，保存后显示服务端存的解析后路径；保存失败时输入保留并标「未保存」。规则每次增删改只发那一个 `chapterSettings` 键（服务端浅合并）：显示的是这个人最新的列表，直到已存列表越过他开始改时的样子（`useUpdateProject` 成功后把返回的行写进 `["projects", id]` 缓存，再刷新），每次修改都在显示的列表上做，所以连删两条不会把第一条带回来；保存串行，进行中时的修改等它完成后只发最新的一份（排队由 `mutateAsync` 的 promise 推进，不靠单次调用的回调，所以保存中离开设置页，排队的列表仍会发出）；失败则回到已存列表并显示错误。名称与说明每次编辑记一个版本号，旧的保存晚到时只在之后没有再输入才收回草稿。只有核实过的 `canManage` 才可编辑。会话菜单的项目设置弹窗（`ProjectSettingsPanel`）现在只是去设置页的入口。

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
