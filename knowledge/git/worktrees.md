---
id: git.worktrees
title: 会话 worktree
summary: worktree 资源、创建与删除（唯一删除通道）、叙事线遗留目录。
anchors:
  - server/services/narrator-worktree-service.ts
  - server/services/narrator-worktree-resources.ts
  - server/services/narrator-worktree-resource-store.ts
  - server/services/narrator-worktree-retirement.ts
  - server/services/narrator-worktree-journal.ts
  - server/lib/agent/tools/worktree.ts
  - server/routes/narrator-worktrees.ts
  - server/lib/validators/narrator-worktrees.ts
  - server/services/legacy-chapter-resource-cleanup.ts
  - server/services/narrator-worktree-runtime.ts
  - server/services/resource-protection-index.ts
  - server/services/worktree-lifecycle-guard.ts
  - server/services/worktree-resource-metadata-store.ts
  - server/services/worktree-resource-owner.ts
  - shared/fork-worktree-source.ts
  - shared/narrator-worktrees.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 会话 worktree

为叙述者创建关联的 git linked worktree，并把它登记为持久「资源」；删除要经过一套带保护检查的流程。HTTP 路由和 Agent 工具共用同一个 `NarratorWorktreeService`（授权、修订号校验、仓库锁、回执一致）。

## 关键规则
- 资源表 `narrator_worktree_resources`：以 `(device_id, worktree_path)` 唯一，状态 `preparing/ready/unknown`，`create_request_id` 记录创建请求；`owner_narrator_id` 在叙述者删除后置空，资源仍保留（`server/db/schema.ts`）。作用域 `scope_kind` 为 unknown/standalone/project，项目被删后 `scope_project_id` 置空而不降级，缺证据就拒绝。PostgreSQL 后端暂无适配，注册表直接抛 503 `WORKTREE_RESOURCE_BACKEND_UNAVAILABLE`（`narrator-worktree-resources.ts`）。
- 路由挂在 `/api/narrators/:id/git/worktrees`（请求体上限 16 KiB）：`POST prepare`、`POST reconcile`、`GET`（列表，游标带 HMAC 签名，快照缓存 60 秒/16 MiB/16 份）、`POST removal/plan`、`POST removal`、`POST`（创建）（`routes/narrator-worktrees.ts`）。
- 创建：先 `prepare` 取得工作区修订，再带唯一 `requestId` 创建；同一 requestId 加同一提案可在断线后重试，结果为 `unknown` 不代表失败，不得换 ID 盲目重试；分支已存在报 `WORKTREE_BRANCH_EXISTS`。未指定目标路径时默认落在仓库根的 `.worktrees/<名>`（该目录是符号链接则拒绝，目录不存在则落在仓库根下的 `nf-worktree-<名>`）（`narrator-worktree-service.ts`，约 1840–1870 行）。创建超时 120 秒，不对创建本身加固，保留仓库自己的检出钩子。
- 工具：现用的是 `ListWorktrees`、`CreateWorktree`、`AttachWorktree`、`GetWorktreeOperation`；旧的 `Worktree` 工具 `isAvailable: () => false`。工具声明远程执行、删除和 prune 均不支持（`lib/agent/tools/worktree.ts`）。
- 删除只有一条通道：`NarratorWorktreeService.remove` → `applyGuardedRemoval` 里的 `git worktree remove`，在整个 `server/` 非测试代码中没有其他调用点。先 `removal/plan` 预检，列出阻塞项（主工作区、已锁定、有容器或卷快照在用、依赖会话在运行、依赖无处迁移、依赖枚举无界等，错误码形如 `WORKTREE_REMOVAL_*`）。
- 保护声明是 `narrators.cwd` / `workspace_context.cwd`，不是状态：归档的会话仍占着目录，所以移除时要把它们迁到别处（`relocate`）；终端先于所有者行关闭（`onDelete: restrict`），后台任务先取消并确认停止才动 git（`narrator-worktree-retirement.ts` 文件头）。
- 删除执行前在保护预留里重新检查所有声明，重新被占用的目录会被拒绝而不是被删；一旦分发，客户端断开不会中断 git（用独立的超时信号）。重试是幂等的，已不存在的目录走 `already_absent`。
- 既不在 git 列表、也没有登记过的路径，只有位于 `<仓库根>/.worktrees/` 下才能进入删除流程，否则 `WORKTREE_REMOVAL_UNKNOWN_PATH`（`narrator-worktree-service.ts` 约 1360–1380 行）。叙事线时代遗留在 `.worktrees/` 下的目录没有记录；任何自动清理逻辑都不应删除它们，状态/树快照也把 `.worktrees` 排除在外（`worktree-tree-snapshot.ts:WORKTREES_DIR_NAME`）。本节后半「不应自动清理」来自项目约定，代码里只确认了删除必须由显式请求触发。
- 需要隔离的 git 命令都带加固配置，见 [外部进程加固](../security/hardening.md)；`hardenedConfig` 对除 `worktree add` 外的命令生效。
- 创建回执用 journal 持久化，单条记录上限 32 KiB；未知、畸形或矛盾的证据一律按「有资源效果」保护（`narrator-worktree-journal.ts:worktreeReceiptHasResourceEffect`）。

## 从哪读起
- `server/services/narrator-worktree-service.ts:NarratorWorktreeService`：create / remove / planRemoval / list。
- `server/services/narrator-worktree-retirement.ts`：移除时对会话、终端、容器的副作用。
- 测试：`narrator-worktree-service.test.ts`、`narrator-worktree-resources.test.ts`、`narrator-worktree-storage.test.ts`。

## 相关
- [git 服务与状态](service-status.md)
- [访问控制](../security/acl.md)
