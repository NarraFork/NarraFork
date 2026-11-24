---
id: git.workspace-watch
title: 工作区归属与监听
summary: git 工作区的访问范围、改动归属、文件监听，以及 git 管理服务。
anchors:
  - server/services/git-workspace.ts
  - server/services/git-workspace-access.ts
  - server/services/git-workspace-access-scan.ts
  - server/services/git-workspace-path-policy.ts
  - server/services/git-workspace-attribution.ts
  - server/services/git-workspace-watch.ts
  - server/services/git-management-service.ts
  - server/websocket/git-workspace-ws.ts
  - server/services/git-workspace-attribution.test.ts
  - server/services/git-workspace-watch.test.ts
  - server/services/git-workspace-access-scan.test.ts
  - frontend/lib/api/git.ts
  - frontend/lib/git-workspace-subscription.ts
  - server/services/narrator-git-summary.ts
  - shared/git-workspace-events.ts
  - shared/git-workspace.ts
keywords:
  - GIT_WORKSPACE_CHANGED
  - GIT_WORKSPACE_ACCESS_CHECK_UNAVAILABLE
  - git_workspace_subscribe
  - git_workspace_snapshot
  - git_workspace_changed
  - git_workspace_refresh
  - /api/narrators/:id/git/workspace
  - /api/narrators/:id/git/summary
  - /api/narrators/:id/git/modifications
  - workspaceKey
  - repositoryKey
  - access_denied
  - git:staging_lists_changed
  - 改动归属
  - file_attributions
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 工作区归属与监听

一个叙述者对应哪个 git 工作树、当前用户能不能读写它、谁改了哪些文件、改动如何推给订阅者。git 命令本身与状态缓存见 [git 服务与状态](service-status.md)。

## 关键规则
- 工作区由叙述者解析，不信任客户端路径：`resolveNarratorGitTarget` 取叙述者的 cwd 与设备，探测 `rev-parse`（超时 10s、输出 32KB），得到 `GitWorkspaceState`（ready / not_git / missing_directory / git_unavailable / access_denied / device_offline / unsupported），并以 `sha256(设备, 根路径)` 算出 `workspaceKey` / `repositoryKey`。裸仓库一律 unsupported（`git-workspace.ts:probeLocalGitWorkspace`）。
- 请求带的 `workspaceKey` 与当前解析结果不符就报 409 `GIT_WORKSPACE_CHANGED`（`assertGitWorkspaceKey`）；`cachedDiscovery` 仅用于展示类读取，写操作始终走未缓存探测。
- 访问判定 `authorizeGitTargetForPrincipal`：总预算 30s，工作区解析后的项目与路径检查再限 5s（`GitAccessScan`，超时报 503 `GIT_WORKSPACE_ACCESS_CHECK_UNAVAILABLE`，即失败关闭）。依次检查叙述者 ACL、上下文项目、远程设备授权、OAuth 运行时策略、执行策略对 cwd/根/仓库路径的读写（`gitPathPolicyAllows`，整树操作不能跳过被禁子目录），并对本地后端拒绝 NarraFork 数据目录与 .ssh/.aws/.gnupg/.kube 等密钥路径。
- 非管理员还要过「相关项目」检查：路径祖先或其子孙登记为别人的项目时，必须对该项目有读权限，写权限取交集；被拒绝时目标被抹掉路径和键，只剩 `access_denied`（`redactDeniedTarget`）。`capabilities.write` 为假时写请求直接 403。
- 改动归属：`collectGitAttributionScopes` 从 `file_attributions` 按设备和工作区路径前缀取候选 cwd（最多 64 个候选、32 个范围），逐个重新探测确认仍属同一工作树（预算 5s，探测结果缓存 30s、256 项），超限则 `truncated`。`redactGitModificationView` 把调用者读不了的叙述者替换为未知角色并去掉工具调用线索，而不是丢弃这些改动。
- 监听池 `GitWorkspaceWatchPool` 按「设备:workspaceKey」去重，有订阅才探测，最多 128 项、并发探测 4。每 3s 取一次指纹（worktree/index/refs/head/stash）；本地用 `git status`、`rev-parse HEAD`、`stash list`、`diff --cached`，每条命令超时 5s、输出 128KB；输出超限或工作树含目录项时标记 uncertain，worktree 不确定时降到 30s 一次；旧版远程设备无 watch 能力时同样 ≥30s。失败按 2 的幂次退避，上限 60s。
- 指纹变化后：HEAD/refs 变化清发现缓存；失效 git 状态缓存并标脏，1s 节流后重取状态、行统计与状态分页，推送带 `revision` 的快照（文件最多 200 个、JSON 约 128KB，超出折半）；此外每 60s 强制复核一次。`git:workspace_invalidated` 事件（本服务写操作也会发）同样触发标脏。
- 暂存列表元数据（SQLite/WAL）在每轮探测前先采样，变化发 `git:staging_lists_changed`；这条链路不依赖 git 命令成功（`probeGitWatch`）。细节见 [暂存与变更列表](staging.md)。
- 推送走叙述者 WebSocket 的 git 订阅（`git-workspace-ws.ts`）：每个订阅先过上面的授权；socket 发送缓冲超过 256KB 就关闭连接（1013）要求重连，不静默丢消息。
- `git-management-service.ts`：`gitManagementService(target)` 本地返回 `gitService`、远程设备返回远程 git 服务；状态分页读取以授权后的 workspaceKey 为界，每页独立授权。

- WebSocket 帧（`shared/git-workspace-events.ts`）：客户端发 `git_workspace_subscribe`/`git_workspace_unsubscribe`/`git_workspace_refresh`；服务端回 `git_workspace_subscribed`、`git_workspace_snapshot`、`git_workspace_changed`、`git_workspace_staging_observation`、`git_workspace_staging_lists_changed`、`git_workspace_error`。视图分 summary 与 details，只有 details 才带文件列表与逐文件行统计。
- 叙述者头部的 Git 摘要走 `GET /:id/git/summary`（`narrator-git-summary.ts:getNarratorGitSummary`）：只做授权后的发现（15 秒上限），不扫状态与 diff；拒绝时返回 `access_denied` 的占位工作区，其他异常返回 null 让前端重试；若发现期间 `workspaceRevision` 已变则返回 null，避免用新事实标注旧详情。
- 前端 `lib/git-workspace-subscription.ts:GitWorkspaceSubscriptions`：每个 QueryClient 一个观察者，同一工作区的事实共享、授权不共享；授权状态 waiting/authorized/paused/refresh_required/denied/workspace_changed；事实缓存键由 `gitFactKey`/`gitSnapshotKey` 生成，summary 与 details 分开；`lib/api/git.ts` 是 HTTP 客户端与 `gitTargetKey`。

## 从哪读起
- `git-workspace.ts:resolveNarratorGitTarget`；`git-workspace-access.ts:authorizeGitTargetWithinBudget`。
- `git-workspace-watch.ts:GitWorkspaceWatchPool.tick`、`probeGitWatch`。
- `git-workspace-attribution.ts:collectGitAttributionScopes`。

## 改它时
- 加一个读取 git 状态的新接口或订阅：必须经 `git-workspace-access.ts:authorizeGitTargetForPrincipal`（内部带预算的 `authorizeGitTargetWithinBudget` 未导出），不得信任客户端路径，写操作还要查 `capabilities.write`；新增路径策略改 `git-workspace-path-policy.ts`（整树操作不能跳过被禁子目录）。测试 `git-workspace.test.ts`、`git-workspace-metadata-access.test.ts`、`git-workspace-access-scan.test.ts`。
- 加一种指纹类别或推送字段：`shared/git-workspace-events.ts` 的类型、`git-workspace-watch.ts` 的探测与 `git-workspace-ws.ts` 的发送、前端 `git-workspace-subscription.ts` 的处理要一起改；测试 `git-workspace-watch.test.ts`、`git-workspace-watch-local.test.ts`、`git-workspace-watch-integration.test.ts`。
- 改归属视图：`git-workspace-attribution.ts` 的候选与范围上限，被读者读不了的叙述者必须脱敏而不是丢弃（`git-workspace-attribution.test.ts`）。
- 不变量：访问检查超时按失败关闭（503）；WebSocket 缓冲超限就断开重连，不静默丢消息；`workspaceKey` 不一致报 409。

## 相关
- [git 服务与状态](service-status.md)
- [暂存与变更列表](staging.md)
- [会话 worktree](worktrees.md)
