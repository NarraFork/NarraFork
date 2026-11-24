---
id: files.workspaces
title: 工作区布局
summary: 多叙述者面板布局的保存与恢复。
anchors:
  - server/services/workspace-panel-service.ts
  - server/services/workspace-title.ts
  - server/routes/workspaces.ts
  - shared/workspace-panels.ts
  - frontend/components/dockview/
  - server/services/workspace-context-service.ts
  - server/services/workspace-modification-view.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 工作区布局

“工作区”是用户自己拼出来的面板集合（`workspaces` 表，归属某个用户）。成员关系和排布分开存：成员是 `workspace_panels` 表的行，排布是 `workspaces.tree` 里序列化的 dockview 布局。另有同名前缀 `workspace-context-*` 的服务，处理的是叙述者的工作目录上下文，不是这里的面板布局（见下）。

## 关键规则
- 成员面板种类：`narrator | terminal | webview | outline`（`shared/workspace-panels.ts:WORKSPACE_PANEL_KINDS`）。`narrator-tool/subagent/file/knowledge/plugin` 面板是某成员的资源，不是成员，只存在于布局 blob 里。
- 上限：每个工作区最多 64 个成员（`WORKSPACE_PANEL_MAX`），面板配置 16KiB，布局 `tree` 2MiB；路由用 `bodyLimit` 在解析前拦截，超限 413（`routes/workspaces.ts`、`lib/validators/workspaces.ts`）。列表接口最多 200 条，且不返回 `tree`，只返回 `treeBytes`，完整布局只在 `GET /:id` 读取。
- 布局保存是乐观并发：`PUT /:id/layout` 带 `expectedRevision`，用 `UPDATE ... WHERE layout_revision = ?` 守卫，失败抛 409 `WORKSPACE_LAYOUT_CONFLICT` 并带当前版本号；丢失一次布局写入只丢面板位置，不丢成员（`workspace-panel-service.ts:saveWorkspaceLayout`）。
- 布局保存成功后向该用户广播 workspace 变更（`broadcastWorkspaceChanged`）；成员增删、配置更新会触发标题输入变更（`workspaceTitleInputsChanged`）。叙述者面板没有 config，更新它报 `WORKSPACE_PANEL_NOT_CONFIGURABLE`。
- 所有操作先校验工作区归属当前用户（`requireOwnedWorkspace`）。
- 标题：`titleSource` 为 `default | auto | manual`；成员变化触发防抖（750ms）后调用摘要模型自动命名，最多取 32 个面板、输入 8KiB、超时 30s；URL 只保留主机名；手动命名不会被自动覆盖（`workspace-title.ts`）。
- 前端 `frontend/components/dockview/` 是共享的 Dockview 外壳与拖拽语义（交换/合并/拆分三区落点），不含持久化逻辑。
- 容易混淆的两个同前缀服务：`workspace-context-service.ts` 管叙述者切换工作目录/设备目录映射（带修订号与忙碌检查），`workspace-modification-view.ts` 汇总工作区内文件修改的归因视图；二者都不读写 `workspaces` 表。

## 从哪读起
- `server/routes/workspaces.ts`：`/api/workspaces` 路由（列表、CRUD、`/panels`、`/layout`、`/generate-title`）。
- `server/services/workspace-panel-service.ts`：成员与布局的读写。
- `shared/workspace-panels.ts`：成员种类与上限，前后端共用。

## 相关
- [文件写入与变更记录](write-queue.md)
