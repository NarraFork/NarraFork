---
id: collaboration.teams.pull-requests
title: GitHub PR 流程
summary: origin 在 GitHub 上时，成员把可合并的工作项推送到 GitHub、发起 PR、在 GitHub 上合并（主机上 gh 的账号）；gh 的隔离、推送的隔离、状态读取与转变事件。
anchors:
  - server/services/teams/team-merge-pr.ts
  - server/services/teams/team-gh.ts
  - server/services/teams/team-pr-state.ts
  - server/services/teams/__tests__/team-merge-pr.test.ts
  - server/services/teams/__tests__/team-hosting.test.ts
  - server/services/teams/__tests__/fake-gh.fixture.ts
keywords:
  - 发起 PR
  - 更新 PR
  - 重新发起 PR
  - 查看 PR
  - 合并 PR
  - 已加入合并队列
  - gh auth login
  - work/:itemId/pr/merge
  - work/:itemId/pr/refresh
  - work.pr_pushed
  - work.pr_opened
  - work.pr_checks
  - work.pr_closed
  - work.pr_queued
  - pull_request
  - pr_merge
  - --match-head-commit
  - markMergedByPullRequest
  - mergeStateStatus
  - viewerDefaultMergeMethod
  - TEAM_PR_GH_MISSING
  - TEAM_PR_GH_LOGGED_OUT
  - TEAM_PR_GH_NO_PERMISSION
  - TEAM_PR_REPO_ARCHIVED
  - TEAM_PR_GH_UNAVAILABLE
  - TEAM_PR_NOT_GITHUB
  - TEAM_PR_REMOTE_CHANGED
  - TEAM_PR_PUSH_REJECTED
  - TEAM_PR_PUSH_FAILED
  - TEAM_PR_BASE_MISMATCH
  - TEAM_PR_OPEN_FAILED
  - TEAM_PR_NONE
  - TEAM_PR_CLOSED
  - TEAM_PR_HEAD_STALE
  - TEAM_PR_DRAFT
  - TEAM_PR_BLOCKED
  - TEAM_PR_BEHIND
  - TEAM_PR_STATE_UNKNOWN
  - TEAM_PR_METHOD_NOT_ALLOWED
  - TEAM_PR_MERGE_FAILED
  - GH_PROMPT_DISABLED
  - setGhProbeForTests
status: draft
verified_at: ddc6b6a25ee0907d09b3af062d68f5ce3ee7b31e
---
# GitHub PR 流程

origin 在 GitHub 上（`team-hosting.ts`：github.com，或 gh 认识的 GitHub Enterprise 主机）时，可合并的工作项走 PR：成员点「发起 PR」，NarraFork 把 ready 时钉住的 head 推到它的分支、发起或复用 PR；成员点「合并 PR」时在 GitHub 上合并。PR 的作者与合并者都是主机上 gh 的账号，PR 正文写明是哪位 NarraFork 用户发起的。gh 不能用时（没装、没登录、没写权限、仓库归档、读不到）按钮禁用并说明原因，绝不退回本地合并。

## 关键规则
请求（`team-merge.ts`，权限同本地合并：协调者写 + 项目写，旁观者 403、陌生人 404）：
- `POST …/work/:itemId/merge`：GitHub 模式下是 PR 任务（job `pull_request`，`work.merge_requested {job, mode: "github"}`），gh 不可用时 409：`TEAM_PR_GH_MISSING`、`TEAM_PR_GH_LOGGED_OUT`、`TEAM_PR_GH_NO_PERMISSION`、`TEAM_PR_REPO_ARCHIVED`、`TEAM_PR_GH_UNAVAILABLE`（`ghRefusal`）；hosting 还没读出时仍按本地任务排队，任务里读到 GitHub 就转去 PR（`runMerge` 开头）。
- `POST …/work/:itemId/pr/merge`（`{ method? }`，Zod `mergeTeamPullRequestSchema`，不合法 400）：job `pr_merge`；不在 GitHub 上 `TEAM_PR_NOT_GITHUB`，方式不被仓库允许 `TEAM_PR_METHOD_NOT_ALLOWED`，省略时用仓库默认（`methods[0]`）。
- `POST …/work/:itemId/pr/refresh`：抽屉打开时读 PR（20 秒内读过就不读），202 `{ itemId, refreshing }`；没有 PR 409 `TEAM_PR_NONE`，不是 ready 409 `TEAM_WORK_ITEM_NOT_READY`；工作者在跑也可以读。
- 两个任务都占合并守卫、走每项目一把锁、10 分钟总期限，失败记 `work.merge_failed {code, message, job}`（同本地合并，见[合并](merge.md)）。

「发起 PR」（`team-merge-pr.ts:runPullRequest`）：
- 复核同本地合并的 `jobFacts`（团队活跃、ready、工作者没在跑、分支尖端仍是 ready 时的 head，否则 `TEAM_WORK_ITEM_HEAD_MOVED`）；只推真实完整的历史（`assertTrueHistory`、`assertNoReplacedHistory`）。
- 推送前重读 origin 的推送 URL（`readOriginPushUrl`，与 hosting 同一来源），解析出的主机/owner/repo 必须正是 gh 用的那个，否则 `TEAM_PR_REMOTE_CHANGED`，什么都不推（`pushUrlFor`）。
- `team-git-write.ts:pushBranch`：`git push --porcelain --no-verify --no-signed --no-recurse-submodules --no-follow-tags --receive-pack=git-receive-pack <URL> <head>:refs/heads/<分支>`，不带 `+`、不带 lease，120 秒、64KB。远端分支有 head 没有的提交 → `TEAM_PR_PUSH_REJECTED`（抽屉给「退回给工作者」，理由预填 `pushRejectedReason`）；其他失败 `TEAM_PR_PUSH_FAILED`（消息去掉 URL 里的 userinfo，`redactUserinfo`）；分支真的动了才记 `work.pr_pushed {head, branch, repository}`。
- `gh pr list -R … --head=<分支> --state=all --limit=5`，只认本仓库同名分支（`isCrossRepository` 为真的 fork 分支不算）：有 OPEN 的就复用（基线不同 `TEAM_PR_BASE_MISMATCH`）；没有 OPEN、但有在这个 head 上 MERGED 的，直接记合并；否则 `gh pr create -R … --head=<分支> --base=<基线> --title=<标题> --body-file=-`（不是草稿），失败 `TEAM_PR_OPEN_FAILED`。PR 的基线是 `baseBranchOf(基线).branch`：团队基线写成 `origin/main` 时 PR 指向 `main`。
- `work.pr_opened {pr, url, repository: host/owner/repo, base, head, created}` 只在新建或换了一个 PR 时记；PR 号与 URL 只存在这里（没有新列，`team-pr-state.ts:latestPullRequest`）。
- 正文（`pullRequestBody`）：发起人（「由 NarraFork 用户 X 发起」/ `Opened by NarraFork user X`，按发起人语言）、大小（最近 `work.ready` 的 `diffStat`）、评审轮次（结论、评审者、发现数、意见原文）与退回理由；任何人或 agent 写的文字都放进代码块，并把 `@`、`#` 换成全角、`GH-<数字>` 的连字符换掉、`://` 中间插入 U+2060，提及不到人、关不了 issue；栅栏比文字里最长的反引号串长；总长 ≤16KB，放不下时保留最新的轮次并说明。标题同样处理（`pullRequestTitle`）。

「合并 PR」（`runPrMerge`）：
- 先读 PR（`gh pr view`）：已 MERGED → 记合并；CLOSED → `TEAM_PR_CLOSED`；PR 上的 head 不是 ready 的 head → `TEAM_PR_HEAD_STALE`（先「更新 PR」）；草稿 → `TEAM_PR_DRAFT`；`BLOCKED` → `TEAM_PR_BLOCKED`；`BEHIND` → `TEAM_PR_BEHIND`；`UNKNOWN` 或空 → `TEAM_PR_STATE_UNKNOWN`；`DIRTY` → 冲突（见下）；只有 `CLEAN`、`HAS_HOOKS`、`UNSTABLE` 才合并。消息都带 PR 链接。
- `gh pr merge N -R … --<merge|squash|rebase> --match-head-commit=<head>`，从不带 `--delete-branch`（会删本地分支）、`--admin`、`--auto`；gh 说 head 变了 → `TEAM_PR_HEAD_STALE`，其他失败 `TEAM_PR_MERGE_FAILED`。
- 合并后再读：MERGED → 记合并；仍 OPEN（合并队列或自动合并接手）→ `work.pr_queued {pr, url, method, head}`，界面显示「已加入合并队列」。
- 冲突（`recordConflict`）：先尽力拉取 `origin/<基线>`（`fetchBaseFromOrigin`，只动远程跟踪 ref），再用加固的 `merge-tree` 算 head 与它的冲突文件（git ≥2.38，最多 50），记 `work.merge_failed {code: "conflict", job: "pr_merge", pr, url, conflicts, more, base, head}`；同一 PR 同一 head 只通知协调者一次（`pullRequestConflictNote`），成员再点「合并 PR」仍记一条结果。

合并落地（`landed`，唯一写入者 `work-items.ts:markMergedByPullRequest` → `markMerged`，事务内复核 ready、head、`updated_at`）：
- `work.merged {detectedBy: "pull_request", pr, url, mergeCommit, method, headMatches, baseBranch}`，squash、rebase 也认；成员合并时 actor 是那个人，读取发现的是 system，`method` 为 null。
- 之后后台尽力拉取 `origin/<基线>`（不动本地分支或任何工作区）再 `reconcileUnblocks({projectId})`；依赖可达也认 PR 的合并提交（`work-item-dependencies.ts:unreachedDependencies` 读最近 `work.merged` 的 `mergeCommit`），所以 squash 合并的依赖拉取后能解锁。
- 只在这次真的记下时通知协调者（`pullRequestMergedNote`：成员合并写「X merged it from the team page」，否则「It was merged on GitHub」）。worktree 由已有的人批准清理处理。

读取与转变（`refreshPullRequest`，不在任何 SQLite 事务里跑 gh）：
- 每项一次只读一个，结果缓存 20 秒（`team-pr-state.ts`，内存，最多 500 项）；全进程最多 2 个读同时跑（`withReadSlot`）。`gh pr view N --json …`（64KB）；OPEN 时再 `gh pr checks N --json name,bucket,state,link,workflow`（256KB，退出码 1、8 仍带 JSON，没有检查算空），汇总为各桶计数与最多 10 个失败（名字与 http(s) 链接，`summarizeChecks`）。
- 合并任务持有该项时不读、不写事件。只在转变时写：MERGED → 记合并；CLOSED → `work.pr_closed`（同一 PR 一次）；OPEN 且是 ready 的 head 时，`DIRTY` → 冲突（同上，只一次），检查变成 failing/passing 或评审变成 `CHANGES_REQUESTED`/`APPROVED` → `work.pr_checks {pr, url, head, checks, review, failed, failures}`，其中变成 failing 或要求修改时通知协调者（`pullRequestBlockedNote`）。
- 后台每 60 秒一轮（`startTeamPrPoller`，`main.ts` 的 `startTeamDatabaseMaintenance("pull-requests")`）：最多 200 个有活跃团队的项目、每项目最多 100 个 ready 项，挑出有 `work.pr_opened` 的，每轮从上次之后取 20 个（到头回绕）。
- 手工在 GitHub 上合并的 PR 由这一轮发现；合并提交式的合并也会被本地基线或 `refs/remotes/origin/<基线>` 的祖先检测认出（[工作项](work-items.md)）。

gh 的隔离（`team-gh.ts`）：
- 用 `Bun.which("gh")` 找到的绝对路径，从 NarraFork 自己的空目录 `<home>/run/gh` 运行（里面出现 `.git` 就拒绝），总带 `-R host/owner/repo`（`repo view` 是位置参数）；`GIT_DIR` 指向不存在的 `<目录>/no-repository`、`GIT_CEILING_DIRECTORIES` 为该目录——`gh pr create` 即使带 `-R` 也会跑 `git remote -v`，这样它找不到任何仓库。
- 环境：服务端自己的（恢复环境代理，`cleanGitEnv` 去掉改路由的 `GIT_*`）；`GH_*`/`GITHUB_*` 只留 `GH_TOKEN`、`GITHUB_TOKEN`、`GH_ENTERPRISE_TOKEN`、`GITHUB_ENTERPRISE_TOKEN`、`GH_HOST`、`GH_CONFIG_DIR`；去掉编辑器、浏览器、分页器、调试与 `GIT_SSH*`/askpass；设 `GH_PROMPT_DISABLED`、`GH_NO_UPDATE_NOTIFIER`、`GH_NO_EXTENSION_UPDATE_NOTIFIER`、`GH_SPINNER_DISABLED`、`GH_PAGER=cat`、`NO_COLOR`、`CLICOLOR=0`、`GIT_TERMINAL_PROMPT=0`（`ghEnv`）。
- 参数：主机、owner、repo、分支、PR 号、提交都来自解析，并按严格模式校验后才进 argv（`isGhRepo`、`isGhBranch`、`numberArg`）；标题用 `--title=`，正文经 stdin；没有 shell。
- 输出：每次都有超时（`--version` 5 秒、探测 15 秒、列表/查看 30 秒、发起 60 秒、合并 90 秒）、输出上限和中止信号（杀进程树），超时、被截断、非零退出都算失败；JSON 用 Zod 解析，不认识的值落到安全默认。

## 从哪读起
- `server/services/teams/team-merge-pr.ts`：两个任务、正文、读取与转变、后台一轮。
- `server/services/teams/team-gh.ts`：gh 的唯一入口。
- `server/services/teams/team-pr-state.ts`：PR 记录、状态缓存、卡片的 `pr` 摘要（`pullRequestSummary`、`prMergeBlocker`）。
- 测试：`team-merge-pr.test.ts`（裸仓库当作 GitHub：hosting 经测试接缝读成 `https://github.com/acme/app.git`，主机自己的 `insteadOf` 把它指向裸仓库，推送是真的；假 gh 回放 JSON）、`team-hosting.test.ts`、`fake-gh.fixture.ts`（记录 argv、目录、环境、stdin）。

## 改它时
- 加 gh 子命令：只进 `team-gh.ts`，带超时、输出上限、Zod；先用 PATH 垫片或 `GH_DEBUG` 确认它不推送、不碰本地仓库。
- 加拒绝码：`team-merge.ts`/`team-merge-pr.ts`、`team-page-model.ts:MERGE_ERROR_CODES` 与两种语言的 `teams.page.merge.errors.*`。加 PR 的禁用原因：`shared/project-teams.ts:TEAM_PR_MERGE_BLOCKERS` 与 `teams.page.merge.prBlocker.*`（`team-page-model.test.ts` 核对两种语言）。
- 新事件种类：`TEAM_WORK_EVENT_KINDS`、`team-page-model.ts:eventNote`、两种语言的 `teams.event.*`/`teams.eventNote.*`；会改变「最新结果」的还要进 `team-merge.ts:OUTCOME_KINDS`。
- 不变量：GitHub origin 永不本地合并；gh 永不在仓库里跑；推送永不带 `+`；PR 信息只在事件里。

## 相关
- [合并工作项与基线配置](merge.md)：hosting 判定、任务表与守卫、本地合并。
- [团队页与审批](page.md)：按钮、标签与抽屉。
- [外部进程加固](../../security/hardening.md)：推送的隔离、gh 的环境。
- [工作项](work-items.md)：`markMerged` 与依赖解锁。
