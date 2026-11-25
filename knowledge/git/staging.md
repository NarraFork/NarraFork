---
id: git.staging
title: 暂存与变更列表
summary: 暂存列表、变更列表归属与提交。
anchors:
  - server/services/git-staging-lists-service.ts
  - server/services/git-staging-kernel.ts
  - server/services/git-staging-worker.ts
  - server/services/git-staging-observation.ts
  - server/services/git-staging-files.ts
  - server/services/git-changelist-store.ts
  - server/services/git-changelist-ownership.ts
  - server/services/git-changelist-observer.ts
  - server/services/git-changelist-commit.ts
  - shared/git-staging-lists.ts
  - frontend/components/git/GitChangesTab.tsx
  - frontend/components/git/GitStagingDiffPreview.tsx
  - frontend/components/git/GitStagingLists.tsx
  - frontend/components/git/GitStagingRows.tsx
  - frontend/components/git/GitTreeRow.tsx
  - frontend/components/git/git-changes-list-client.ts
  - frontend/components/git/git-changes-list-model.ts
  - frontend/components/git/git-changes-list-test-fixture.ts
  - frontend/components/git/git-changes-list-worker-protocol.ts
  - frontend/components/git/git-changes-list.worker.ts
  - frontend/components/git/git-changes.browser-fixture.assets.ts
  - frontend/components/git/git-changes.browser-fixture.tsx
  - frontend/components/git/git-changes.browser-network.ts
  - frontend/components/git/git-file-status.ts
  - frontend/components/git/git-file-tree.ts
  - frontend/components/git/git-folder-prefs.ts
  - frontend/components/git/git-staging-diff-mappings.ts
  - frontend/components/git/git-staging-list-display.ts
  - frontend/components/git/git-status-counts.ts
  - frontend/components/git/git-status-filter.ts
  - frontend/components/git/git-view-prefs.ts
  - frontend/components/git/useGitChangesList.ts
  - frontend/hooks/useGitFolderPrefs.ts
  - frontend/hooks/useGitStagingFolderPrefs.ts
  - frontend/hooks/useGitStagingLists.ts
  - frontend/hooks/useGitStatusFilter.ts
  - frontend/hooks/useGitViewMode.ts
  - server/services/git-changelist-cli.ts
  - server/services/git-staging-process.ts
  - server/services/git-staging-stats.ts
  - server/services/git-staging-unit-diff.ts
keywords:
  - 变更列表
  - changelist
  - /api/narrators/:id/git/staging-lists
  - GIT_STAGING_BUSY
  - GIT_STAGING_WORKER_UNAVAILABLE
  - GIT_STAGING_STORAGE_UNSAFE
  - GIT_STAGING_LIMIT
  - NARRAFORK_DISABLE_GIT_STAGING_WORKER
  - changelists.sqlite
  - commit_operations
  - git:staging_lists_changed
  - 未分配
  - 按列表提交
  - 暂存列表
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 暂存与变更列表

在一个工作区里把未提交的改动分成多个命名的「变更列表」（changelist），每处改动恰属于一个列表，按列表单独提交。粒度到文本变更单元（unit），不只是文件。

## 关键规则
- 数据模型（`shared/git-staging-lists.ts`）：每个单元由且仅由一个列表拥有，被保守地判不清的改动归入固定的「未分配」列表（`GIT_STAGING_UNASSIGNED_LIST_ID`）。有一个活动列表。摘要状态为 uninitialized/ready/stale/incomplete/conflict/recovering。
- 动作集合 `GitStagingAction`：`init`、`sync`、`create`、`rename`、`activate`、`delete`、`move`（按单元、路径、范围或 `all`）、`commit`、`recover`。除 init/sync 外都带期望版本（generation + observationId），版本不符即失败。授权由路由负责，DTO 本身不含授权。
- 存储：每个仓库在 `<gitDir>/narrafork/changelists/changelists.sqlite`（WAL、`synchronous=FULL`），打开时检查目录和文件是真实路径、不跟随符号链接，否则 `GIT_STAGING_STORAGE_UNSAFE`（`git-changelist-store.ts`）。内部目录 `.narrafork/git-staging` 在状态与暂存中被排除（`git-staging-files.ts:isGitStagingInternalPath`）。
- 所有工作在 Worker 里做：一次请求就是一个 Worker 任务，注释明示没有内联执行路径；环境变量 `NARRAFORK_DISABLE_GIT_STAGING_WORKER=1` 时返回 503 `GIT_STAGING_WORKER_UNAVAILABLE`，不回退主线程；并发 4，不排队，满了返回 409 `GIT_STAGING_BUSY`（`git-staging-lists-service.ts:executeGitStagingWork`）。读超时 15 秒、写超时 120 秒。
- 硬上限（`GIT_STAGING_LIMITS`）：单次操作 1000 文件/5000 单元，单列表 5000 行，每页最多 200 行/256 KiB，单个单元 diff 256 KiB，列表名 120 字符，请求体 1 MiB。
- 文本归属按行做差异（`git-changelist-ownership.ts`）：只处理可逆解码的文本，二进制与 gitlink 只计数不计行；与多个所有者重叠、上下文有歧义或 HEAD 变化的单元标 `needsReview`。
- 提交（`git-changelist-commit.ts:commitChangelist`）：消息必须非空、不含 NUL、不超过 64 KiB；署名的 name/email 不能含 NUL/换行/尖括号。提交过程写 `commit_operations` 记录，失败或中断后用 `recover` 按 operationId 恢复；`outcome` 可为 `applied` 或 `partial`。
- 观察与写入串行：`git-staging-observation.ts` 对每个工作区做观察合并并串行化写入，写入后发布新的 generation；写入前会重新校验授权路径集（`authorizedPaths`）。
- 路由在 `routes/git.ts` 的 `/:id/git/staging-lists`、`/staging-lists/:listId/files`、`/diff`、`POST /staging-lists/action`；提交署名取当前用户的 git 身份（见 [分支与引用](refs.md)）。

- 子进程（`git-staging-process.ts:stagingGit`）：直接用 `child_process.spawn`，不经 `safeSpawn`；先清掉继承的 `GIT_DIR`、`GIT_INDEX_FILE`、`GIT_CONFIG_COUNT` 等环境变量，设 `GIT_OPTIONAL_LOCKS=0`、`GIT_NO_REPLACE_OBJECTS=1`，命令带 `--no-optional-locks`、`core.splitIndex=false`、`core.fsmonitor=false`、`diff.autoRefreshIndex=false`；输出预算默认一页上限，可被调用方放宽。该文件没有引用 `git-exec-hardening.ts` 的 `GIT_NO_EXEC_CONFIG`。
- 统计与单元 diff 是纯函数：`git-staging-stats.ts` 解析 raw/numstat 并投影分页（错误码 `GIT_STAGING_INVALID`/`GIT_STAGING_LIMIT`），`git-staging-unit-diff.ts` 把 hunk 映射到单元（文本 2 MiB、10 万行、2 万变更行、100 毫秒预算，超出即无映射，前端 `git-staging-diff-mappings.ts` 对不完整映射失败关闭，不允许动作落在未唯一映射的单元上）。
- 命令行入口：`bun server/index.ts changelists ...`（`server/index.ts` 在 `argv[2] === "changelists"` 时转入 `git-changelist-cli.ts`），输入文件或 stdin 同样受请求字节上限限制，走同一个 `executeGitStagingWork`。
- 前端：`useGitStagingLists` 调用 staging-lists 接口；变更列表的树/分组/状态筛选在浏览器 Worker 里计算（`git-changes-list-model.ts` 模型、`git-changes-list.worker.ts`、`git-changes-list-client.ts`、协议文件 `git-changes-list-worker-protocol.ts`，客户端里的测试工厂只服务 DOM 夹具，不是生产回退），`useGitChangesList.ts` 把分页数据喂进去；界面为 `GitChangesTab`、`GitStagingLists`、`GitStagingRows`、`GitTreeRow`、`GitStagingDiffPreview`。偏好存浏览器：视图模式 `git-view-prefs.ts`、文件夹展开 `git-folder-prefs.ts`/`useGitStagingFolderPrefs.ts`（键 `narrafork_git_staging_expansion`）、状态筛选 `git-status-filter.ts`；`git-file-status.ts` 决定每节显示的状态字母，`git-status-counts.ts` 按「已暂存/未暂存」分节计数。`git-changes.browser-*` 与 `git-changes-list-test-fixture.ts` 是浏览器测试夹具。

## 从哪读起
- `server/services/git-staging-lists-service.ts`：对外服务与 Worker 调度。
- `server/services/git-staging-kernel.ts:IndependentGitStagingKernel`：动作的实际实现。
- 测试：`git-staging-kernel.test.ts`、`git-changelist-*.test.ts`、`git-staging-lists-service.test.ts`。

## 改它时
- 加一个动作：`shared/git-staging-lists.ts:GitStagingAction`、`lib/validators/git.ts` 的 zod schema、`git-staging-kernel.ts` 实现、`git-staging-lists-service.ts`（读写超时与并发）、路由 `POST /staging-lists/action`、前端 `useGitStagingLists.ts` 同步改；非 init/sync 动作要带期望版本。测试 `git-staging-kernel.test.ts`、`git-staging-lists.test.ts`、`git-staging-lists-service.test.ts`、`git-staging-lists-guard.test.ts`（守着普通 add/unstage/commit/stash 独立于列表元数据与锁，且保留旧元数据）。
- 改上限：只改 `shared/git-staging-lists.ts:GIT_STAGING_LIMITS`，服务端、CLI、前端共用这一份。
- 改存储结构：`git-changelist-store.ts` 里 `CHANGELIST_APPLICATION_ID`/`CHANGELIST_SCHEMA_VERSION` 要同步，`git-staging-worker.ts` 采样元数据时同样引用这两个常量；测试 `git-changelist-store.test.ts`。
- 任何新的暂存读写都必须在 Worker 任务内执行；Worker 不可用时返回 503，不得回退主线程。
- 内部目录 `.narrafork/git-staging` 必须一直被状态与暂存排除（`isGitStagingInternalPath`，测试 `git-staging-internal-path.test.ts`）。

## 相关
- [git 服务与状态](service-status.md)
- [外部进程加固](../security/hardening.md)：暂存子进程不使用那里的 `GIT_NO_EXEC_CONFIG`，见上文子进程一条。
