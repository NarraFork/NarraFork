---
id: collaboration.projects
title: 项目
summary: 会话按工作目录自动归入项目、项目链接索引、项目页。
anchors:
  - server/services/project-index.ts
  - server/services/project-acl.ts
  - server/services/project-membership.ts
  - server/services/narrator-project.ts
  - server/routes/projects.ts
  - frontend/components/project/
  - frontend/components/settings/ProjectDirChooser.tsx
  - frontend/hooks/useFavoriteDirectories.ts
  - frontend/hooks/useProjectDirStatus.ts
  - frontend/hooks/useProjects.ts
  - frontend/lib/api/projects.ts
  - frontend/routes/chapters/$chapterId.tsx
  - frontend/routes/projects/$projectId.tsx
  - frontend/routes/projects/index.tsx
  - frontend/routes/settings/chapters.tsx
  - server/lib/narrator-project-sql.ts
  - server/lib/validators/projects.ts
  - server/routes/favorites.ts
  - server/services/project-dir.ts
  - server/services/read/
keywords:
  - /api/projects
  - /api/projects/hidden-existence
  - /api/favorites
  - /api/fs/project-dir
  - narrator_project_links
  - uq_narrator_project_links_primary
  - contextProjectId
  - projects.rootKey
  - acl_grants
  - POSTGRES_UNSUPPORTED
  - paths.defaultProjectDir
  - 默认项目目录
  - 收藏目录
  - 项目页
  - X-Next-Cursor
  - 章节
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 项目

项目是轻量单元：会话在 git 仓库里工作，就自动归入该仓库的项目，不需要手建。归属结果存在 `narrator_project_links` 表，使项目页和权限检查是索引查询，不用每次做路径运算。

## 关键规则
- 目录归属顺序：先取包含该目录的最长已有项目根（按路径段边界、归档项目也参与）；否则取该目录 git 仓库的主仓库根（linked worktree 归主仓库）并就地建项目（公开，owner 为会话所有者）；非 git 目录不属于任何项目（`project-index.ts:resolveDirectoryProject`）。
- 只索引本地目录；远程设备的 cwd 不参与（`isLocalDevice`、`deriveLinks`）。
- 主链接：有 `contextProjectId` 时它是 primary（source=explicit），cwd 推导出的其他项目是 additional；否则 cwd 推导的是 primary（`deriveLinks`）。每个会话至多一条 primary（表上的唯一部分索引 `uq_narrator_project_links_primary`）。
- 会话属于哪个项目只经 `narrator-project.ts:resolveNarratorProjectId`（SQL 侧 `narratorProjectIdColumn`）：`contextProjectId` 优先，否则读 primary 链接；additional 不参与。PG 后端上没有链接表，只认 `contextProjectId`。
- 索引不是事实来源，可整表重建：`scheduleProjectIndexRebuild` 后台分页执行，运行中再次请求只合并为多跑一轮；非 SQLite 后端直接跳过；启动时由 `server/main.ts` 触发。单会话变更用 `syncNarratorProjectLinksSafely`。
- git 探测有超时（2s）、输出上限（8KB）和 30s 缓存。
- `projects.rootKey`（realpath 规范化）是匹配键，局部唯一；被更早项目占用目录的项目 rootKey 永久为 null、不参与匹配。
- 访问控制：admin、owner、`visibility=public`（所有登录用户可读）、`acl_grants` 的 read/write/manage，write/manage 隐含 read；owner 为 null 表示由 admin 管理（`project-acl.ts`）。进入项目是必要不充分条件，项目内会话/知识仍受自身 ACL。
- 成员变更（设置成员、移除、转让 owner、可见性）只有 owner/admin/manage 能做，且有审计与通知（`project-membership.ts`）。
- 路由层：项目不可见与不存在都返回 NotFound，防止探测；`GET /api/projects/hidden-existence` 只返回是否存在不可见项目（`limit 1` 的有界探测，不泄露名称、id 或数量）；修改设置要 manage。
- 列表 `GET /api/projects`：按 `updatedAt` 降序，返回裸数组；不带 `limit`/`cursor` 时返回调用者可读的全部项目（`collectAllPages` 逐页有界地走，单页 200，总量上限 2000）；带 `limit`/`cursor` 才是单页，续页游标在响应头 `X-Next-Cursor`，被截断时 `X-Read-Truncated: 1`（`routes/projects.ts`、`services/read/`）。读取经 `projectReadAdapter()`：默认 SQLite 适配器，PG 模式必须显式注入 PG 适配器，不会静默回落。
- PG 模式下创建、更新、删除、改可见性、成员变更、转让 owner 一律返回 503 `POSTGRES_UNSUPPORTED`（`requireSqliteProjectMutation`，在权限检查之前）；读取仍可用。
- 手动指定项目目录会认领 rootKey 并在后台重推全部会话链接（`indexNewProjectRoot`）。
- 默认项目目录（与项目归属无关的邻近功能）：`settings.paths.defaultProjectDir` 初始不设置、服务端不再创建；`project-dir.ts:getProjectDirStatus` 判 `valid/unset/missing/not_directory`，`/api/fs/project-dir[/candidates]` 暴露，候选扫描有上限（主目录 500 项、最多扫 60 个目录、每目录 200 子项、每候选最多数 50 个仓库、返回 8 个）；设置页 `ProjectDirChooser` 只能从已存在目录里选，前端用 `useProjectDirStatus` 判断是否可用。
- 收藏目录：`/api/favorites` 的 GET/POST/PATCH/DELETE/PUT reorder 管每个用户自己的目录收藏（`user_favorite_directories`），供目录选择器使用，与项目归属无关。
- 旧"章节"路由只剩跳转：`/chapters/$chapterId` 跳 `/projects`，`/settings/chapters` 跳 `/settings/workspace`。

## 前端
- `frontend/routes/projects/index.tsx`（项目列表）、`$projectId.tsx`（项目页：目录与会话列表，`components/project/ProjectSessionList.tsx`）；设置/权限在 `ProjectSettingsPanel`、`ProjectAccessPanel`、`ProjectSkillsManager`、`ProjectRoutinesModal`、`ProjectCommandsModal`。
- `frontend/hooks/useProjects.ts` + `lib/api/projects.ts`：React Query 与客户端；团队页路由 `$projectId_.teams.$teamId.tsx` 属于[团队](teams/index.md)。

## 从哪读起
- `server/services/project-index.ts`：目录到项目的推导、链接同步与重建。
- `server/services/narrator-project.ts`：唯一的"会话属于哪个项目"入口。
- `server/services/project-acl.ts`、`project-membership.ts`：访问判定与成员管理。
- `server/routes/projects.ts`：项目 CRUD、成员、可见性、转让 owner。
- `server/services/read/`：项目列表读适配器（`acl-sql.ts` 是 ACL 与 `narratorProjectIdText` 的 SQL 片段，`read-collect.ts`/`read-cursor.ts` 是分页）。
- `server/lib/narrator-project-sql.ts`：另一份 SQL 侧会话到项目的表达式（`narratorProjectIdSql`）。
- 测试：`server/services/__tests__/project-index.test.ts`、`project-acl.test.ts`、`project-membership-authority.test.ts`。

## 改它时
- 会话属于哪个项目的判定有三处 SQL/代码出口要一致：`narrator-project.ts`（`resolveNarratorProjectId`、`narratorProjectIdColumn`）、`services/read/acl-sql.ts`（`narratorProjectIdText`）、`lib/narrator-project-sql.ts`（`narratorProjectIdSql`）；改归属规则要同时改并跑 `narrator-project.test.ts`、`narrator-project-gate.test.ts`、`project-index.test.ts`。
- 改链接表 `narrator_project_links`：SQLite 与 PG schema 两边；索引要保持"可整表重建"（`project-index-rebuild-scale.test.ts`），不得把它当事实来源。
- 改项目 ACL：`project-acl.ts` 是唯一判定入口，大纲 `outline/access.ts` 与 `narrator-acl.ts` 依赖它的语义（`outline/__tests__/access-parity.test.ts`）；成员变更必须保留审计与通知（`project-membership-authority.test.ts`）。
- 新增项目写路由：先调 `requireSqliteProjectMutation`（PG 返回 503），再做权限检查；不存在与不可见都抛 NotFound。
- 列表接口形状是契约（裸数组、`updatedAt` 降序、无参返回全部），改成分页信封会破坏现有调用方。

## 相关
- [团队](teams/index.md)
