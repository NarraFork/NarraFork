---
id: collaboration.teams.merge
title: 合并工作项与基线配置
summary: 成员在团队页把可合并的工作项合回基线（本地合并：对象库里算合并、不碰任何工作区，基线被检出时准备好等人快进）；新工作项从 origin/<基线> 还是本地基线开始。
anchors:
  - server/services/teams/team-merge.ts
  - server/services/teams/team-merge-guard.ts
  - server/services/teams/team-git-write.ts
  - server/services/teams/team-hosting.ts
  - server/services/teams/team-work-start.ts
  - frontend/components/teams/TeamMerge.tsx
  - server/services/teams/__tests__/team-merge-local.test.ts
  - server/services/teams/__tests__/team-git-write.test.ts
  - server/services/teams/__tests__/team-work-start.test.ts
keywords:
  - 合并到
  - 在该目录中快进
  - 重新准备
  - work/:itemId/merge
  - work/:itemId/merge/fast-forward
  - work.merge_requested
  - work.merge_failed
  - work.merge_prepared
  - local_merge
  - refs/narrafork/team-merges
  - TEAM_WORK_ITEM_MERGING
  - TEAM_WORK_ITEM_NOT_READY
  - TEAM_WORK_ITEM_WORKER_RUNNING
  - TEAM_WORK_ITEM_HEAD_UNAVAILABLE
  - TEAM_MERGE_GITHUB_PENDING
  - TEAM_MERGE_BASE_REMOTE
  - TEAM_MERGE_BASE_MOVED
  - TEAM_MERGE_NOT_PREPARED
  - TEAM_MERGE_STALE
  - TEAM_MERGE_CHECKOUT_BLOCKED
  - TEAM_MERGE_CHECKOUT_BUSY
  - TEAM_MERGE_FAST_FORWARD_REFUSED
  - TEAM_MERGE_GIT_TOO_OLD
  - TEAM_MERGE_IDENTITY_UNKNOWN
  - TEAM_WORK_START_UNAVAILABLE
  - team_merge
  - workStart
  - workStartDefault
  - merge-tree
  - GitHub PR 流程即将提供
status: draft
verified_at: 6f73805a43fba25c5ee36fc0c483f8f0e49d75ec
---
# 合并工作项与基线配置

可合并（`ready`）的工作项由成员在团队页点「合并到 {{base}}」合回基线。硬约束：不妨碍任何人的工作——不切分支、不碰任何工作区和 index、不在任何检出里留下合并或冲突状态、不对被检出的基线 `update-ref`、不拿任何锁挡别的会话。origin 在 GitHub 上时走 PR 流程（下一个 PR），现在按钮禁用（`github_pending`）。

## 关键规则
请求（`server/routes/project-teams.ts`，`team-work-view.ts:requestMergeAsPerson`/`requestFastForwardAsPerson`，`team-merge.ts`）：
- `POST …/work/:itemId/merge` 与 `…/merge/fast-forward`：权限同退回（`loadTeamForAccess(…, "write")`，旁观者 403、陌生人 404）；只做便宜的检查，记 `work.merge_requested`（`detail.job` = `merge` / `fast_forward`），202 返回 `{ itemId, job, phase: "queued" }`。
- 请求就拒的情形（409）：团队归档 `TEAM_ARCHIVED`；不是 ready `TEAM_WORK_ITEM_NOT_READY`；已有任务在跑 `TEAM_WORK_ITEM_MERGING`；工作者 working/waiting `TEAM_WORK_ITEM_WORKER_RUNNING`；缓存的 hosting 是 GitHub `TEAM_MERGE_GITHUB_PENDING`；基线像远程跟踪分支（`origin/`、`remotes/`、`refs/remotes/` 开头）`TEAM_MERGE_BASE_REMOTE`；快进时最近结果不是 prepared `TEAM_MERGE_NOT_PREPARED`。
- 任务表在内存（`hotSafe`）：阶段 queued → checking → merging → updating（合并）或 fast_forwarding（快进）。每项一个任务（`team-merge-guard.ts:claimMerging`），每项目一把 `AsyncMutex` 串行（只挡同项目的合并），10 分钟总期限，git 各有超时。不在任何 SQLite 事务里跑 git。
- 守卫：任务持有期间，退回、协调者的 review / ready / sync / cancel 都 409 `TEAM_WORK_ITEM_MERGING`（`work-items.ts` 各入口 `assertNotMerging`），后台祖先检测跳过它（`team-overlap.ts:mergeIfLanded`）。重启后守卫随任务消失，不留状态列。

本地合并（`runMerge`，git 都经 `team-git-write.ts`，在项目 `gitPath` 里跑）：
- 先复核：团队活跃、项 ready、有记录的分支与 head（否则 `TEAM_WORK_ITEM_HEAD_UNAVAILABLE`）、工作者没在跑、hosting 不是 GitHub、git ≥ 2.38（`TEAM_MERGE_GIT_TOO_OLD`）、`refs/heads/<基线>` 存在、分支尖端仍是 ready 时的 head（否则 `TEAM_WORK_ITEM_HEAD_MOVED`）。不重跑知识检查。
- OLD = 基线；head 已在 OLD 里就直接记合并（`alreadyInBase: true`，`mergeCommit: null`）。
- `merge-tree --write-tree -z --name-only --no-messages OLD head`（120s、1MB）：冲突 → `work.merge_failed {code: "conflict", conflicts ≤50, more}`，给协调者 `mergeConflictNote`，什么都没写。
- `commit-tree T -p OLD -p head`（永远是合并提交，消息 `Merge team work item: <标题> (<分支>)`）：身份取点击者的 NarraFork git 身份（`resolveUserGitIdentityEnv`），没有就用主机的；都没有 → `TEAM_MERGE_IDENTITY_UNKNOWN`。`commit.gpgsign` 为真时带 `-S`；签名程序（`gpg.program`、`gpg.*.program`、`gpg.ssh.defaultkeycommand`）只用 system/global 配置的，仓库自己（local/worktree）配的改回主机值或 git 默认值（`signingConfig`）。
- `update-ref refs/narrafork/team-merges/<id> M <读到的旧值或空>` 存住 M（不进 `git branch`，防 gc）。
- `git fetch --no-write-fetch-head --no-tags --no-recurse-submodules --no-auto-maintenance . M:refs/heads/<基线>`：
  - 成功：复核基线 = M（或包含 M），`markMergedByLocalMerge` 记 `work.merged {detectedBy: "local_merge", mergeCommit}`（actor 为点击者，同事务解锁依赖），删私有 ref，给协调者 `mergedNote`；
  - 非快进（基线在算的时候动了）：从 OLD 重来一次，再不行 `TEAM_MERGE_BASE_MOVED`；
  - 基线在某个 worktree 被检出（git 拒绝）：记 `work.merge_prepared {mergeCommit, baseSha: OLD, checkedOutAt, head}`，不通知协调者，那个检出原样不动。
- 失败统一记 `work.merge_failed {code, message}`（不是 `AppError` 的记 `TEAM_MERGE_FAILED`）；结果事件的时间戳严格晚于请求事件，`readMergeOutcome` 按时间取最新一条（快进请求不覆盖 prepared）。

「在该目录中快进」（`runFastForward`）：
- 私有 ref 仍是 prepared 的 M；基线已含 M（人自己跑了命令）就直接记合并（`fastForwarded: "outside"`）。
- 检出前提（`team-git-write.ts:inspectCheckout`，只读）：HEAD 在基线上（`not_on_base`）、基线仍是 OLD（否则 `TEAM_MERGE_STALE`，要「重新准备」）、没有进行中的 merge/rebase/cherry-pick/revert/bisect、没有 `index.lock`、检出自己的 local/worktree 配置里没有 filter 和 `core.hooksPath`（`local_config`，只给命令）；不满足 → `TEAM_MERGE_CHECKOUT_BLOCKED`（`detail.blocker`）。那个目录（不含其 `.worktrees/`）里有 working/waiting 或运行时忙的会话、或有后台任务 → `TEAM_MERGE_CHECKOUT_BUSY`；开着的 NarraFork 终端只提醒。
- 在 `worktreeLock.tryAcquire(目录, 500ms)` 里跑 `git merge --ff-only --no-edit <私有 ref>`，所有 hook 关掉（`core.hooksPath`、按名禁用配置 hook），主机自己的 filter 照常（如 LFS）；拿不到锁 `GIT_WORKSPACE_BUSY`；git 拒绝（本地改动会被覆盖）→ `TEAM_MERGE_FAST_FORWARD_REFUSED`，列出文件，什么都没改。成功后记 `work.merged {fastForwarded: "checkout", checkedOutAt}`。
- 抽屉另给可复制的命令 `git -C <目录> merge --ff-only refs/narrafork/team-merges/<id>`（`fastForwardCommand`，路径按需单引号）；人自己跑后祖先检测会标为已合并。

崩溃与清理：
- 基线已动、合并没记下：后台祖先检测（`mergeIfLanded`）或下一次请求（head 已在基线里）补记。
- 私有 ref：每个任务结束后清本项目的、启动 30 秒后清所有有团队的项目的（`pruneStaleMergeRefs`，最多 200 个项目，`main.ts` 的 `startTeamDatabaseMaintenance("merge")`）：项不存在或不再 ready、且不在合并中的就按读到的值删。

读模型（`mergeSummaryOf`、`mergeViewOf`）：
- 看板卡片（`team-board.ts:withMerge`，含项目页的 `readReadyItems`）的 ready 项带 `merge: {mode, phase, job, outcome, canMerge, disabledReason}`：不跑 git，读任务表、一条最新结果事件、缓存的 hosting 与 git 版本。
- 抽屉 `work/:itemId` 的 ready 项带 `merge`（再加 `detail` 与 prepared 时的 `fastForward: {available, blocker, runningSessions, terminals, command}`，检出检查缓存 15 秒）。
- 禁用原因按序：`not_ready`、`team_archived`、`merging`、`worker_running`、`checking`（hosting 还在读）、`github_pending`、`base_remote`、`git_too_old`；`canMerge` 还要求调用者是成员。

基线与新工作的起点（W，`team-work-start.ts`、`team-hosting.ts`）：
- 基线分支按团队存（`project_teams.base_branch`），新团队取项目 `projects.default_branch`（项目设置页「工作区与容器」组的「团队默认设置」可改），再缺省 `main`。
- 起点模式（`TeamWorkStart`）：团队 `settings.workStart`（团队设置里改），否则项目 `chapter_settings.teams.workStart`，否则 origin 在 github.com 上为 `remote`、其余为 `local`。`TeamDetail.workStartDefault` 是团队不设时的值（hosting 未读出时 null）。没有新列。
- `remote`：`git fetch … origin +refs/heads/<基线>:refs/remotes/origin/<基线>`（只动远程跟踪 ref；保留主机的 credential helper 与 ssh 命令，`GIT_TERMINAL_PROMPT=0`，没配 ssh 命令时 `ssh -o BatchMode=yes`，禁 `ext::`、本地 upload-pack 与 git proxy，120s），再以读到的提交建 worktree（传 SHA，不给分支设上游）；拉取失败但远程跟踪 ref 在就用它（事件 `fetched: false`），没有就 409 `TEAM_WORK_START_UNAVAILABLE`，绝不悄悄改用本地基线。`work.created` 记 `startFrom`。
- `work.sync` 同样按起点模式取要合进来的基线（`origin/<基线>` 或本地基线），指令里写的就是它。
- hosting：`git remote get-url --push origin`（应用 pushurl 与 insteadOf），解析 scp / ssh / https（去掉 userinfo，不记日志），主机小写，路径必须正好 owner/repo；只有 github.com（含 ssh.github.com）算 GitHub，GHE 要等 PR 流程的 gh 探测。缓存按仓库：成功 5 分钟、失败 60 秒（失败当作非 GitHub），单飞，请求只读缓存（`peekHosting`）。

前端（`TeamMerge.tsx`，抽屉底栏与「等你处理」卡片共用）：`MergeButton`（合并到 {{base}} → 正在合并… / 正在快进…，prepared 后是「重新准备」，禁用时 tooltip 说原因）；`MergeOutcome`（冲突文件列表与「退回给工作者」，退回理由预填冲突文件最多 20 个；失败原因；prepared 的说明、「在该目录中快进」确认框列出改动文件、可复制命令）。合并任务在跑时抽屉每 1.5 秒重读。

## 从哪读起
- `team-merge.ts`：请求、任务、两条流程、读模型、清理；`team-git-write.ts`：所有写 git 与检出检查。
- `team-work-start.ts` 与 `team-hosting.ts`：起点模式与 origin 判定。
- 测试：`team-git-write.test.ts`（真实仓库：干净合并、冲突上限、合并驱动与 hook 不运行、被检出时拒绝、非快进、签名与身份、只拉远程跟踪 ref）、`team-merge-local.test.ts`（落地、prepared 时人的检出逐字节不变、快进前提、冲突、并发两个合并、工作者提交竞态、守卫、GitHub 拒绝、git 太旧、崩溃按祖先自愈与清理）、`team-work-start.test.ts`、`project-teams-work.test.ts` 的 merge 段。

## 改它时
- 加合并的拒绝码：`team-merge.ts`、`team-page-model.ts:MERGE_ERROR_CODES` 与 en / zh-CN 的 `teams.page.merge.errors.*`（模型测试核对每个原因与阻碍都有文案）。
- 加禁用原因或快进阻碍：`shared/project-teams.ts` 的 `TEAM_MERGE_DISABLED_REASONS` / `TEAM_FAST_FORWARD_BLOCKERS` 与两种语言的文案。
- 新的写 git 只进 `team-git-write.ts`，带超时与输出上限，用 `git-exec-hardening.ts` 的覆盖；不能在任何人的检出里写，除了显式的快进。
- PR 流程（下一个 PR）接在 `requestMerge` 的 `github` 分支与 `mergeSummaryOf` 的 `github_pending` 上，结果同样记事件，`work.merged.detectedBy` 加 `pull_request`。

## 相关
- [工作项](work-items.md)：状态机、`markMerged` 唯一写入者、守卫的各入口。
- [团队页与审批](page.md)：抽屉与「等你处理」。
- [外部进程加固](../../security/hardening.md)：合并驱动、hook 与签名程序的覆盖。
