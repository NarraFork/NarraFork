---
id: narrator.lifecycle.workspace-context
title: 执行工作区
summary: 会话在哪个目录、哪台设备上执行：工作目录与设备目录上下文、切换。
anchors:
  - server/services/workspace-context-transition.ts
  - server/services/workspace-context-service.ts
  - server/services/narrator-cwd.ts
  - server/services/standalone-narrator-cwd.ts
  - server/routes/narrator-workspace-context.ts
  - shared/workspace-context.ts
  - shared/workspace-directories.ts
  - frontend/hooks/useWorkspaceContext.ts
  - frontend/lib/api/workspace-context.ts
keywords:
  - WORKSPACE_CONTEXT_CONFLICT
  - WORKSPACE_CONTEXT_BUSY
  - WORKSPACE_DIRECTORY_REQUIRED
  - WORKSPACE_CONTEXT_INSTALL_FAILED
  - transitionWorkspaceContext
  - workspaceRevision
  - workspaceContextService
  - withRevision
  - supportsDirectorySwitch
  - expectedRevision
  - /api/narrators/:id/workspace-context
  - /api/narrators/:id/workspace-context/switch
  - /api/narrators/:id/cwd
  - workspace_context_changed
  - defaultDeviceId
  - pathFlavor
  - resolveNarratorSessionCwd
  - defaultProjectDir
status: draft
verified_at: 776dbf07e
---
# 执行工作区

会话在哪个目录、哪台设备上执行。注意它与界面面板布局的“工作区”（`workspaces` 表，见[工作区布局](../workspaces.md)）无关，事件也不同：`workspace_context_changed` 对 `workspace_changed`。

## 关键规则
- 上下文服务：`workspaceContextService`（`workspace-context-service.ts`）管叙述者的工作目录与设备目录映射，修订号存 `narrators.workspaceRevision`；`withRevision` 在变更准入内比对修订号，变了报 `WORKSPACE_CONTEXT_CONFLICT`，忙碌报 `WORKSPACE_CONTEXT_BUSY`。
- 切换范围：`switch` 仅限 primary 且无 `background` 特征、非知识管家的叙述者，HTTP 来源在运行/等待中被拒，agent 来源不受此限（`supportsDirectorySwitch`、`switch`）。它不读写 `workspaces` 面板表。
- 接口：`GET /api/narrators/:id/workspace-context`、`POST /:id/workspace-context/switch`（请求体 ≤ 16 KiB，带 `expectedRevision`、`requestId`、`target: {deviceId, cwd}`），旧的 `PATCH /:id/cwd` 走同一条准入/比对/安装路径；目标设备必须是 `local` 或该叙述者工具实际被授权的设备，slug 先解析为规范设备 ID 再保存（`routes/narrator-workspace-context.ts`）。
- 数据形态：叙述者每台执行设备各记一个目录（`deviceId → {cwd, pathFlavor}`，路径语法按记录时的 flavor 判断，不按宿主 OS 推断），`narrators.cwd`/`defaultDeviceId` 仍表示当前生效值；这些类型前后端共用，不依赖 `node:path`（`shared/workspace-context.ts`、`shared/workspace-directories.ts`）。
- 目录解析：`resolveNarratorSessionCwd` 取 `narrator.cwd`，缺则项目 git 路径，再缺则调用方给的兜底；无目录且无 `standalone` 特征的旧“章节会话”由 `isFormerChapterSessionWithoutDirectory` 识别，调用方须让用户选目录（`WORKSPACE_DIRECTORY_REQUIRED`），不得静默落到 home（`narrator-cwd.ts`）。
- 独立会话：创建没传目录时，只在 `settings.paths.defaultProjectDir` 指向已存在目录时采用，否则返回 `required`，不创建目录（`standalone-narrator-cwd.ts`）。
- 切换流程 `transitionWorkspaceContext`（`workspace-context-transition.ts`）：先在锁外检查准入并读当前上下文、比对 `expectedRevision`（不符报 `WORKSPACE_CONTEXT_CONFLICT`，409）、`prepare`；再在 `admit` 内重查准入与修订，目标上下文与原来相同（`contextKey` 不变）则直接返回 `changed: false`；否则修订号加 1，CAS 提交（`commit`）后 `install`，最后 `publish`。`install` 失败不回滚 cwd，而是 `pause` 运行时并报 `WORKSPACE_CONTEXT_INSTALL_FAILED`（409）。

## 从哪读起
- `server/routes/narrator-workspace-context.ts`：HTTP 入口与校验。
- `server/services/workspace-context-service.ts:workspaceContextService`（`withRevision`、`switch`）。
- 前端：`hooks/useWorkspaceContext.ts`、`lib/api/workspace-context.ts`。
- 测试：`server/services/workspace-context-transition.test.ts`、`workspace-context-service.test.ts`、`workspace-context-persistence.test.ts`、`__tests__/standalone-narrator-cwd.test.ts`。

## 改它时
- 改修订号或冲突语义：`workspace-context-persistence.test.ts`、`workspace-context-transition.test.ts` 覆盖修订号与冲突；所有变更路径（含旧 `PATCH /:id/cwd`）必须仍走同一条准入/比对/安装；`install` 失败必须保持“暂停而非回滚”的语义。
- 新增可切换的设备类型：同改目标设备授权校验与 `shared/workspace-context.ts` 的 flavor 处理；不要用 `node:path` 判断远端路径。
- 改默认目录策略：`standalone-narrator-cwd.test.ts` 守着“不创建目录、只用已存在的 `defaultProjectDir`”；旧章节会话不得静默落到 home。
- 事件：前端据 `workspace_context_changed` 刷新，别与面板的 `workspace_changed` 混用。

## 相关
- [会话生命周期](index.md)
- [运行与停止](run-control.md)
