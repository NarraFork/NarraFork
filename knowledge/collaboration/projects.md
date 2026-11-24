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
- 路由层：项目不可见与不存在都返回 NotFound，防止探测；`GET /api/projects/hidden-existence` 只返回是否存在不可见项目；修改设置要 manage；创建/更新/删除在非 SQLite 后端被拒（`requireSqliteProjectMutation`）。

## 从哪读起
- `server/services/project-index.ts`：目录到项目的推导、链接同步与重建。
- `server/services/narrator-project.ts`：唯一的"会话属于哪个项目"入口。
- `server/services/project-acl.ts`、`project-membership.ts`：访问判定与成员管理。
- `server/routes/projects.ts`：项目 CRUD、成员、可见性、转让 owner。
- 测试：`server/services/__tests__/project-index.test.ts`、`project-acl.test.ts`、`project-membership-authority.test.ts`。

## 相关
- [团队](teams.md)
