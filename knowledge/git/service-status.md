---
id: git.service-status
title: git 服务与状态
summary: git 调用封装、状态缓存与分页、差异视图。
anchors:
  - server/services/git-service.ts
  - server/services/git-status-query.ts
  - server/services/git-status-cache.ts
  - server/services/git-status-stream.ts
  - server/services/git-status-page.ts
  - server/services/git-status-page-worker.ts
  - server/services/git-discovery-cache.ts
  - server/services/git-current-diff-view.ts
  - server/routes/git.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# git 服务与状态

服务端对叙述者工作区的 git 读写都经 `gitService` 派生子进程完成；状态查询被合并、缓存并有严格上限，大列表分页读取，避免拖住主线程。

## 关键规则
- 路由挂在叙述者下的 `/:id/git/*`（`routes/git.ts:createGitRoutes`）：工作区路径由服务端按叙述者解析，客户端传入的文件路径只当作 git 根相对路径校验；请求体上限 1 MiB。
- 只读 git 命令超时 60 秒、保留输出 1 MB（`git-service.ts:READ_TIMEOUT_MS`、`READ_MAX_OUTPUT_BYTES`）；写操作（commit、stash、reset）不设硬超时。结果可带 `truncated`，会解析输出的调用方必须检查。提交类命令可带 `identity` 环境变量按操作人署名（见 [分支与引用](refs.md)）；推送/拉取恢复用户代理环境并设 `GIT_TERMINAL_PROMPT=0`。
- 状态摘要 `getStatusSummary` 走 `coordinateGitStatusQuery`：同一目标单飞，结果有界（最多 128 项，`GIT_QUERY_CACHE_MAX_ENTRIES`），默认 TTL 3 秒，失效后只做一次尾随刷新（`git-status-query.ts`）。每次查询总超时 30 秒（`GIT_STATUS_TIMEOUT_MS`）。
- 状态以 porcelain `-z` 流式解析，细节文件最多 200 个、记录最多 10000、字节最多 1 MiB，超出则 `truncated`，`totalFilesExact` 为 false（`git-status-stream.ts`）。慢于 1 秒记 warn。
- 缓存失效入口在 `git-status-cache.ts`：`markStatusDirty`（工具可能写了文件）只标脏并让行统计、发现缓存失效；`invalidateStatus` 再发 `git:workspace_invalidated` 事件；`dropStatus` 在 worktree 销毁时丢弃结果。`peekStatusSummary` 只读上次结果，不触发工作。
- 状态分页（`git-status-page.ts`）由独立 Worker 处理：并发 2、排队上限 16（`git-status-page-protocol.ts`）；每页默认 100、最多 200（`shared/git-status-page.ts`）。按仓库规则，Worker 不可用时不回退到主线程执行，而是报 `GitStatusPageError`（具体各故障路径的错误码未逐一核实）。统计（行数）是单独的请求。
- 仓库发现结果缓存 30 秒、最多 128 项，只存文件系统事实，不存授权（`git-discovery-cache.ts`）。
- 当前差异视图 `getGitCurrentDiffView`：把工作区/索引与记录的文件变更证据对照，只给出「与某个 actor 的变更后状态匹配」，明确不是 blame 或所有权；整体 12 秒超时，最多 200 个路径，只支持本地设备，其他设备返回 `unsupported`（`git-current-diff-view.ts`）。
- 远程设备走 `remote-git-service`，由 `git-workspace.ts` 在后端为 remote 且支持时选择。

## 从哪读起
- `server/services/git-service.ts:getStatusSummary`：状态查询全流程。
- `server/services/git-status-query.ts:GitStatusQueryCoordinator`：单飞与缓存。
- `server/routes/git.ts`：对外接口一览（status、status-files、status-page-stats、diff、log、commits、stash、reset、branches、checkout、push、fetch 等）。
- 测试：`git-status-query.test.ts`、`git-status-page*.test.ts`、`git-status-stream.test.ts`。

## 相关
- [暂存与变更列表](staging.md)
- [分支与引用查询](refs.md)
- [外部进程加固](../security/hardening.md)
