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
  - shared/narrator-worktrees.ts
  - server/db/resource-protection-index.ts
keywords:
  - narrator_worktree_resources
  - /api/narrators/:id/git/worktrees
  - CreateWorktree
  - AttachWorktree
  - ListWorktrees
  - GetWorktreeOperation
  - WORKTREE_BRANCH_EXISTS
  - WORKTREE_REMOVAL_UNKNOWN_PATH
  - WORKTREE_RESOURCE_BACKEND_UNAVAILABLE
  - RESOURCE_PROTECTED
  - RESOURCE_PROTECTION_UNAVAILABLE
  - git worktree remove
  - linked worktree
  - .worktrees
  - 叙事线遗留
  - worktree 删除
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

- 资源 id 是 `sha256(JSON[deviceId, worktreePath])`（`narrator-worktree-resource-store.ts:worktreeResourceId`）；注册表经注入的 admission 提交，生产环境必须提供生命周期准入，没有隐式清理接口。`worktree-resource-owner.ts:resolveWorktreeResourceOwner` 把所有者选择器解析为 worktreeResource / legacyNarrator / legacyStandalone，缺失或混用选择器（`OWNER_SELECTOR_INVALID`/`OWNER_SELECTOR_MIXED`）一律报错，不退回旧所有者；终端服务按它判断归属。
- 生命周期保护（`worktree-lifecycle-guard.ts`）：删除前预留目标，同时检查新工作目录的准入声明；声明冲突报 409 `RESOURCE_PROTECTED`，无法完整验证报 409 `RESOURCE_PROTECTION_UNAVAILABLE`，不放行。检查预算 256 KiB、5 秒、128 个目标；删除只在被删目录包含声明时才冲突，新 cwd 在被删目录之上不算被删。声明索引在 `resource-protection-index.ts`（SQLite 索引加回执目录，启动时 `startProtectionIndexMaintenance` 后台维护，`db/resource-protection-index.ts` 负责启动期初始化）。
- 运行时装配：`narrator-worktree-runtime.ts` 导出带主体授权的 `narratorWorktreeService` 单例与 `narratorWorktreePrincipalForTool`，HTTP 路由与 Agent 工具共用；跨设备目标要求运行时代数一致。
- 叙事线遗留：`legacy-chapter-resource-cleanup.ts:retireLegacyChapterResources` 启动时后台一次（`main.ts`），按 200 条一批停掉无 worktree 资源归属的容器、释放端口、删除无人可达的终端布局与卷快照应用行；它清理的是运行时行，不碰 `.worktrees/` 下的目录。
- `worktree-resource-metadata-store.ts`（配置、终端、容器、端口、布局五类动作，请求 16 KiB、摘要 256 KiB、每页 128）目前只有测试引用，没有生产调用点。
- 分叉：`shared/fork-worktree-source.ts` 定义 `workspace`/`commit` 两种来源，`fork-narrator` 工具把它作为参数枚举。

## 从哪读起
- `server/services/narrator-worktree-service.ts:NarratorWorktreeService`：create / remove / planRemoval / list。
- `server/services/narrator-worktree-retirement.ts`：移除时对会话、终端、容器的副作用。
- 测试：`narrator-worktree-service.test.ts`、`narrator-worktree-resources.test.ts`、`narrator-worktree-storage.test.ts`。

## 改它时
- 加一种声明 worktree/目录的新资源（容器、终端、任务会话等）：必须进 `worktree-lifecycle-guard.ts` 的声明检查与 `resource-protection-index.ts` 的来源表，否则删除流程看不到它；测试 `worktree-lifecycle-guard.test.ts`、`worktree-lifecycle-guard.integration.test.ts`、`narrator-worktree-removal.test.ts`。
- 新增删除入口不被允许：`git worktree remove` 只能出现在 `applyGuardedRemoval`，改动前先搜全仓；测试 `narrator-worktree-service.test.ts`、`narrator-worktree-storage.test.ts`。
- 加一种阻塞项：错误码用 `WORKTREE_REMOVAL_*` 前缀并同时进 `removal/plan` 与真正执行的复核；加路由要同步 `lib/validators/narrator-worktrees.ts`、`shared/narrator-worktrees.ts` 与 Agent 工具 `lib/agent/tools/worktree.ts`。
- 不变量：叙事线遗留目录不得被任何自动清理删除；缺证据一律保护；创建回执未知不等于失败。

## 相关
- [git 服务与状态](service-status.md)
- [访问控制](../security/acl.md)
