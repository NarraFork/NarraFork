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

## 从哪读起
- `server/services/git-staging-lists-service.ts`：对外服务与 Worker 调度。
- `server/services/git-staging-kernel.ts:IndependentGitStagingKernel`：动作的实际实现。
- 测试：`git-staging-kernel.test.ts`、`git-changelist-*.test.ts`、`git-staging-lists-service.test.ts`。

## 相关
- [git 服务与状态](service-status.md)
- [外部进程加固](../security/hardening.md)
