---
id: files.workspaces
title: 工作区布局
summary: 工作区面板布局的服务端存储：成员（workspace_panels）、布局 blob、版本号与 409 冲突规则。
anchors:
  - server/services/workspace-panel-service.ts
  - server/services/workspace-title.ts
  - server/routes/workspaces.ts
  - shared/workspace-panels.ts
  - frontend/components/dockview/
  - frontend/components/nav/WorkspaceSwitcher.tsx
  - frontend/hooks/useWorkspace.ts
  - frontend/routes/narrators/workspace/$workspaceId.tsx
  - frontend/routes/windows/workspaces/$workspaceId.tsx
  - server/lib/validators/workspaces.ts
  - server/routes/narrator-workspace-context.ts
  - shared/workspace-context.ts
  - shared/workspace-directories.ts
  - shared/workspace-events.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 工作区布局

本节点是工作区面板布局的服务端存储与保存规则（成员、版本号、409）。客户端的防抖、重试与界面行为见 [面板与布局](../frontend/panels.md)。

“工作区”是用户自己拼出来的面板集合（`workspaces` 表，归属某个用户）。成员关系和排布分开存：成员是 `workspace_panels` 表的行，排布是 `workspaces.tree` 里序列化的 dockview 布局。

## 关键规则
- 成员面板种类：`narrator | terminal | webview | outline`（`shared/workspace-panels.ts:WORKSPACE_PANEL_KINDS`）。`narrator-tool/subagent/file/knowledge/plugin` 面板是某成员的资源，不是成员，只存在于布局 blob 里。
- 上限：每个工作区最多 64 个成员（`WORKSPACE_PANEL_MAX`），面板配置 16KiB，布局 `tree` 2MiB；路由用 `bodyLimit` 在解析前拦截，超限 413（`routes/workspaces.ts`、`lib/validators/workspaces.ts`）。列表接口最多 200 条，且不返回 `tree`，只返回 `treeBytes`，完整布局只在 `GET /:id` 读取。
- 布局保存是乐观并发：`PUT /:id/layout` 带 `expectedRevision`，用 `UPDATE ... WHERE layout_revision = ?` 守卫，失败抛 409 `WORKSPACE_LAYOUT_CONFLICT` 并带当前版本号；丢失一次布局写入只丢面板位置，不丢成员（`workspace-panel-service.ts:saveWorkspaceLayout`）。
- 布局保存成功后向该用户广播 workspace 变更（`broadcastWorkspaceChanged`）；成员新增、移除、配置更新（`addWorkspacePanel`、`removeWorkspacePanel`、`updateWorkspacePanelConfig`）都会调用 `workspaceTitleInputsChanged(…, "membership")`；成员增删是否也广播 workspace 变更未核实。叙述者面板没有 config，更新它报 `WORKSPACE_PANEL_NOT_CONFIGURABLE`。
- 所有操作先校验工作区归属当前用户（`requireOwnedWorkspace`）。
- 标题：`titleSource` 为 `default | auto | manual`；成员变化触发防抖（750ms）后调用摘要模型自动命名，最多取 32 个面板、输入 8KiB、超时 30s；URL 只保留主机名；手动命名不会被自动覆盖（`workspace-title.ts`）。
- 成员与布局分离的后果：布局里出现的非成员条目、或布局没放置的成员，由客户端在读取时对账（见 [面板与布局](../frontend/panels.md)）；服务端只保证成员行与布局版本各自一致。
- 前端 `frontend/components/dockview/` 是共享的 Dockview 外壳与拖拽语义，不含持久化逻辑。

## 从哪读起
- `server/routes/workspaces.ts`：`/api/workspaces` 路由（列表、CRUD、`/panels`、`/layout`、`/generate-title`）。
- `server/services/workspace-panel-service.ts`：成员与布局的读写。
- `shared/workspace-panels.ts`：成员种类与上限，前后端共用。

## 相关
- [面板与布局](../frontend/panels.md)：客户端保存（防抖、重试）、对账与拖放。
- 叙述者的工作目录上下文不属于面板布局，见[会话生命周期](../narrator/lifecycle.md)；改动归属视图见[文件变更证据](../files/change-evidence.md)。
