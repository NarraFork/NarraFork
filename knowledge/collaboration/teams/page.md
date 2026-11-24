---
id: collaboration.teams.page
title: 团队页与审批
summary: 看板、活动、待批抽屉、谁批的记录、暂停全部与团队页前端。
anchors:
  - server/services/teams/team-board.ts
  - server/services/teams/team-decisions.ts
  - frontend/components/teams/
  - frontend/hooks/team-onlooker-refresh.ts
  - frontend/hooks/useTeams.ts
  - frontend/lib/api/teams.ts
  - frontend/routes/projects/$projectId_.teams.$teamId.tsx
keywords:
  - TeamPageView
  - TeamWorkspace
  - TeamBoard
  - TeamActivity
  - TeamTopBar
  - team-page-model
  - pauseOrder
  - 全部暂停
  - 待批抽屉
  - teamOnlooker
  - narrator_access_changed
  - project_access_changed
  - /teams/:teamId/board
  - /teams/:teamId/approvals
  - permission_decided_by
status: draft
verified_at: 776dbf07e
---
# 团队页与审批

团队页是团队的读模型和操作面：看板、动态、待批抽屉、成员、运行中会话，外加「全部暂停」。

## 关键规则
读模型与路由（`teams/team-board.ts`、`server/routes/project-teams.ts`）：
- 路由挂在 `/api/projects/:projectId/teams...`：列表/创建/详情/修改/归档/取消归档、`summary`、`board`（每列每页 50）、`events`、`approvals`、`members`、`running`。
- 每条读都是带 LIMIT 的主键/索引读。

谁批的（`teams/team-decisions.ts`）：
- 任何成员都可对团队树里的待决调用批准/拒绝/回答，经普通 HTTP 路由与 WebSocket 帧；决定前再按调用所属会话检查写权限（子代理取协调者的访问）。
- 工具调用行只记「人批的」（`permission_decided_by = 'user'`），具体是谁另记为团队事件，`actor_id` 为该用户。
- best-effort：决定之后、事务之外写，写失败只记日志，决定仍生效。
- 不在团队里的调用不处理；PG 上不记录。IM 网关永远不能做这种决定。

前端：
- 团队页路由 `frontend/routes/projects/$projectId_.teams.$teamId.tsx`（不嵌在项目页下，占满外壳内容区）→ `components/teams/TeamPageView.tsx`。
- `TeamWorkspace.tsx` 按自身宽度选三栏（团队列表 / 协调者对话 / 看板与动态）、两栏或标签页；对话用普通叙述者面板。
- `TeamTopBar.tsx` 含待批抽屉和「全部暂停」：协调者排在最前，先于工作者停下（`pauseOrder`），一次最多读 500 个运行中会话，结果分 paused / pausedSomeIdle / pausePartial / pauseNothing / pauseMore（`team-page-model.ts`）。
- `team-page-model.ts` 是纯规则：状态图标、轮询退避、套接字推送合并（400ms 去抖、最长 2s）、暂停顺序。
- `hooks/useTeams.ts`：摘要在叙述者 socket 的相关帧上合并重取，同时带退避轮询（变化后 4s，翻倍到 60s，标签页隐藏时暂停）；看板、动态、审批各自按变化重取。`lib/api/teams.ts` 是客户端。
- `hooks/team-onlooker-refresh.ts`：访问权限变化（`narrator_access_changed`、`project_access_changed`）时刷新最近标签页的 `teamOnlooker` 标记，该标记让只读旁观者不收「等待」提醒（见[通知与注意力](../notifications.md)、[最近标签页](../recent-tabs.md)）。

## 从哪读起
- `team-board.ts`：看板、动态、审批的读模型；`team-decisions.ts`：决定记录。
- `frontend/components/teams/TeamPageView.tsx`，再到 `TeamWorkspace.tsx`、`TeamBoard.tsx`、`TeamActivity.tsx`、`TeamMembers.tsx`。
- 测试：`team-page-model.test.ts`、`team-page-components.test.tsx`、`team-page.browser.test.ts`。

## 改它时
- 加看板列或状态：`TEAM_BOARD_COLUMN_STATES`、`team-board.ts` 与 `TeamBoard.tsx` 一起改；页大小保持 50。
- 加事件种类：`TeamActivity.tsx` 与 `team-page-model.ts` 的文案、`en` 与 `zh-CN` 的 `teams` 语言文件同步。
- 新增审批类型：`teamApprovalKind`（`shared/project-teams.ts`）与 `teams.approvals.kinds.*` 文案。
- 新读接口必须带 LIMIT、走索引，并保持 SQLite 专用。

## 相关
- [团队与成员](records.md)：成员列表的来源。
- [协调者](coordinator.md)：活动里的超限事件与状态行。
