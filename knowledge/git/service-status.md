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
  - frontend/components/GitMissingAlert.tsx
  - frontend/components/git/GitCommitDetailModal.tsx
  - frontend/components/git/GitCommitFileTree.tsx
  - frontend/components/git/GitCommitGraph.tsx
  - frontend/components/git/GitCommitPreview.tsx
  - frontend/components/git/GitCommitPreviewPage.tsx
  - frontend/components/git/GitCommitsTab.tsx
  - frontend/components/git/GitFileDiff.tsx
  - frontend/components/git/GitPanel.tsx
  - frontend/components/git/GitPatchView.tsx
  - frontend/components/git/GitSplitDiff.tsx
  - frontend/components/git/GitStashTab.tsx
  - frontend/components/git/git-graph-layout.ts
  - frontend/components/git/split-diff.ts
  - frontend/hooks/useGit.ts
  - frontend/hooks/useGitStatusPageStats.ts
  - frontend/hooks/useGitStatusPages.ts
  - frontend/lib/git-commit-preview-navigation.ts
  - frontend/routes/git/narrators/$narratorId/commits/$sha.tsx
  - frontend/routes/windows/git/narrators/$narratorId/commits/$sha.tsx
  - server/lib/git-merge-limiter.ts
  - server/lib/git-status.ts
  - server/lib/validators/git.ts
  - server/services/git-current-baseline-session.ts
  - server/services/git-current-baseline-worker.ts
  - server/services/git-current-baseline.ts
  - server/services/git-line-stats-cache.ts
  - server/services/git-line-stats.ts
  - server/services/git-status-page-engine.ts
  - server/services/git-status-page-parser.ts
  - server/services/git-status-page-process.ts
  - server/services/git-status-page-protocol.ts
  - server/services/git-status-page-stats.ts
  - server/services/git-tool-refresh-policy.ts
  - server/services/git-untracked-line-worker.ts
  - server/services/remote-git-service.ts
  - server/services/git-commit-boundary-cache.ts
  - server/services/git-commit-preview-parse.ts
  - shared/git-commit-preview.ts
  - shared/git-line-stats.ts
  - shared/git-status-page.ts
  - frontend/components/git/GitLineStatsSummary.tsx
  - frontend/hooks/useGitGraphCollapsed.ts
  - frontend/hooks/useGitGraphHeight.ts
keywords:
  - /api/narrators/:id/git/status
  - /api/narrators/:id/git/status-files
  - /api/narrators/:id/git/line-stats
  - /api/narrators/:id/git/commits/:sha
  - git:workspace_invalidated
  - GitStatusPageError
  - GIT_STATUS_PAGE
  - getStatusSummary
  - gitAvailable
  - Git 面板
  - 提交预览
  - 提交图
  - 行统计
  - 暂存区 diff
  - git-commit-boundary
  - remote-git-service
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# git 服务与状态

服务端对叙述者工作区的 git 读写都经 `gitService` 派生子进程完成；状态查询被合并、缓存并有严格上限，大列表分页读取，避免拖住主线程。

## 关键规则
- 路由挂在叙述者下的 `/:id/git/*`（`routes/git.ts:createGitRoutes`）：工作区路径由服务端按叙述者解析（解析与授权见 [工作区归属与监听](workspace-watch.md)），客户端传入的文件路径只当作 git 根相对路径校验；请求体上限 1 MiB。
- 只读 git 命令超时 60 秒、保留输出 1 MB（`git-service.ts:READ_TIMEOUT_MS`、`READ_MAX_OUTPUT_BYTES`）；写操作（commit、stash、reset）不设硬超时。结果可带 `truncated`，会解析输出的调用方必须检查。提交类命令可带 `identity` 环境变量按操作人署名（见 [分支与引用](refs.md)）；推送/拉取恢复用户代理环境并设 `GIT_TERMINAL_PROMPT=0`。
- 状态摘要 `getStatusSummary` 走 `coordinateGitStatusQuery`：同一目标单飞，结果有界（最多 128 项，`GIT_QUERY_CACHE_MAX_ENTRIES`），默认 TTL 3 秒，失效后只做一次尾随刷新（`git-status-query.ts`）。每次查询总超时 30 秒（`GIT_STATUS_TIMEOUT_MS`）。
- 状态以 porcelain `-z` 流式解析，细节文件最多 200 个、记录最多 10000、字节最多 1 MiB，超出则 `truncated`，`totalFilesExact` 为 false（`git-status-stream.ts`）。慢于 1 秒记 warn。
- 缓存失效入口在 `git-status-cache.ts`：`markStatusDirty`（工具可能写了文件）只标脏并让行统计、发现缓存失效；`invalidateStatus` 再发 `git:workspace_invalidated` 事件；`dropStatus` 在 worktree 销毁时丢弃结果。`peekStatusSummary` 只读上次结果，不触发工作。
- 状态分页（`git-status-page.ts`）由独立 Worker 处理：并发 2、排队上限 16（`git-status-page-protocol.ts`）；每页默认 100、最多 200（`shared/git-status-page.ts`）。按仓库规则，Worker 不可用时不回退到主线程执行，而是报 `GitStatusPageError`（具体各故障路径的错误码未逐一核实）。统计（行数）是单独的请求。
- 仓库发现结果缓存 30 秒、最多 128 项，只存文件系统事实，不存授权（`git-discovery-cache.ts`）。
- 当前差异视图 `getGitCurrentDiffView`：把工作区/索引与记录的文件变更证据对照，只给出「与某个 actor 的变更后状态匹配」，明确不是 blame 或所有权；整体 12 秒超时，最多 200 个路径，只支持本地设备，其他设备返回 `unsupported`（`git-current-diff-view.ts`）。
- 状态分页引擎（`git-status-page-engine.ts`）：快照缓存最多 8 份、64 MiB、空闲 120 秒；分页游标用实例密钥做 HMAC 签名。`git-status-page-process.ts` 负责 Worker 子进程的终止清理（含 Windows 进程树）。
- 行统计与当前基线各有独立 Worker：`git-line-stats.ts` 输出上限 1 MiB、结果缓存 5 秒（`git-line-stats-cache.ts:GIT_LINE_STATS_TTL_MS`）；未跟踪文件由 `git-untracked-line-worker.ts` 按批读取，单批最多 200 个文件、总字节 20,000,000，超时 30 秒；当前基线 `git-current-baseline.ts`（并发 2、不排队）单文件 4 MiB、总 64 MiB、最多 200 个路径，超限返回未知而不是部分哈希。行统计是独立请求，永远不是轻量状态扫描的一部分，未知与失败不得显示为 0（`GitLineStatsSummary.tsx`）。
- 提交预览：`GET .../git/commits/:sha`（元数据与文件列表）与 `.../commits/:sha/diff`（按文件取补丁）；解析用 NUL 分隔输出，被预算截断的记录会被丢弃而不是显示成幽灵文件（`git-commit-preview-parse.ts`，本地与远程两个后端共用）；提交号需匹配 40 或 64 位十六进制（`shared/git-commit-preview.ts:GIT_COMMIT_SHA_PATTERN`）。
- 每文件最近提交边界（`git-commit-boundary-cache.ts`）：键含 HEAD SHA，所以提交即失效；TTL 5 分钟、最多 32 项、LRU，并有同键并发去重。
- 远程设备：`remote-git-service.ts` 在后端声明 `supportsGitWorkspace` 时提供与本地同一契约的状态/差异/行统计；远程写操作限于固定的一组（discard、stashPush/Pop/Drop、reset、checkout、push、fetch 等）。
- 工具写入后的刷新：`git-tool-refresh-policy.ts:classifyGitToolRefresh` 按意图而非退出码判断（Bash 全只读为 none，含 git 命令为 git-write，其他或无法解析为 write；非本地设备不刷新），orchestrator 用 `GitToolRefreshQueue` 刷新并推送状态摘要。
- git 可用性：`lib/git-status.ts` 记录启动时探测的 `gitAvailable`/`gitVersion`，`recheckGit` 可重查（会先刷新 Windows PATH）；前端 `GitMissingAlert` 在健康检查报告 git 不可用时提示。
- `lib/git-merge-limiter.ts`（有界 FIFO）目前除自身测试外没有生产调用点。
- 前端：`components/git/GitPanel.tsx` 是面板入口，标签页 `GitCommitsTab`（含 `GitCommitGraph`、`git-graph-layout`）、`GitStashTab`、变更页（见 [暂存与变更列表](staging.md)）；差异显示 `GitFileDiff`/`GitPatchView`/`GitSplitDiff`（`split-diff.ts`）；提交详情弹窗与独立页 `routes/git/narrators/$narratorId/commits/$sha.tsx`、`routes/windows/...`；数据钩子 `hooks/useGit.ts`、`useGitStatusPages.ts`、`useGitStatusPageStats.ts`，提交图折叠/高度偏好 `useGitGraphCollapsed`/`useGitGraphHeight`。
- 远程设备的选择与监听推送见 [工作区归属与监听](workspace-watch.md)。

## 从哪读起
- `server/services/git-service.ts:getStatusSummary`：状态查询全流程。
- `server/services/git-status-query.ts:GitStatusQueryCoordinator`：单飞与缓存。
- `server/routes/git.ts`：对外接口一览（status、status-files、status-page-stats、diff、log、commits、stash、reset、branches、checkout、push、fetch 等）。
- 测试：`git-status-query.test.ts`、`git-status-page*.test.ts`、`git-status-stream.test.ts`。

## 改它时
- 加一个 git 路由：在 `routes/git.ts` 的 `createGitRoutes` 里经 `access(c)` 取服务端解析的目标并授权，客户端路径只做 git 根相对校验；请求体/查询校验加到 `lib/validators/git.ts`；前端 `lib/api/git.ts` 与 `hooks/useGit.ts` 同步；本地与远程后端（`git-service.ts` 与 `remote-git-service.ts`）都要实现或明确返回 unsupported。
- 加一种会写工作区的工具：要让 `git-tool-refresh-policy.ts` 把它归为 write，否则状态不刷新；测试 `git-tool-refresh-policy.test.ts`。
- 改状态/分页：上限常量在 `git-status-stream.ts`、`git-status-page-protocol.ts`、`shared/git-status-page.ts`，Worker 故障必须报错而不是回退主线程（`tests/worker-main-thread-fallback.guard.test.ts` 扫描全仓，禁止故障转内联的开关，也禁止 Worker 客户端在主机上调用重任务实现）；相关测试 `git-status-query.test.ts`、`git-status-page*.test.ts`、`git-status-stream.test.ts`、`git-line-stats*.test.ts`。
- 不变量：只读 git 超时 60 秒与 1 MB 输出上限；截断输出调用方要检查 `truncated`；缓存只存文件系统事实不存授权。

## 相关
- [工作区归属与监听](workspace-watch.md)
- [暂存与变更列表](staging.md)
- [分支与引用查询](refs.md)
- [外部进程加固](../security/hardening.md)
