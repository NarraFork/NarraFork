---
id: collaboration.teams.pull-requests
title: GitHub PR 流程
summary: origin 在 GitHub 上时，成员把可合并的工作项推送到 GitHub、发起 PR、在 GitHub 上合并（主机上 gh 的账号）；gh 的隔离、推送的隔离、状态读取与转变事件。
anchors:
  - server/services/teams/team-merge-pr.ts
  - server/services/teams/team-gh.ts
  - server/services/teams/team-pr-state.ts
  - server/services/teams/team-github-pin.ts
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
  - TEAM_PR_TARGET_UNCONFIRMED
  - teams.github
  - team-github
  - 确认 GitHub 仓库
  - github_unconfirmed
  - github_target_changed
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
  - splitUrlCredentials
  - readAuthStatusText
  - prClosedForItem
  - currentPullRequest
  - resolveRemoteArgument
status: draft
verified_at: 330e310b25cd687f6bdafe382da17a2ac91da559
---
# GitHub PR 流程

origin 在 GitHub 上（`team-hosting.ts`：github.com，或 gh 认识的 GitHub Enterprise 主机）时，可合并的工作项走 PR：成员点「发起 PR」，NarraFork 把 ready 时钉住的 head 推到它的分支、发起或复用 PR；成员点「合并 PR」时在 GitHub 上合并。PR 的作者与合并者都是主机上 gh 的账号，PR 正文写明是哪位 NarraFork 用户发起的。gh 不能用时（没装、没登录、没写权限、仓库归档、读不到）按钮禁用并说明原因，绝不退回本地合并。

## 关键规则
确认的仓库（`team-github-pin.ts`）：
- origin 的地址在仓库自己的配置里，agent 能改，所以只是提议。项目第一次走 PR 时，「发起 PR」先弹确认框「将推送到 host/owner/repo 并在那里开 PR」，只有项目管理员（manage）能确认；没确认时非管理员的按钮禁用（`github_unconfirmed`），请求 409 `TEAM_PR_TARGET_UNCONFIRMED`。
- 确认结果存在项目 `chapter_settings.teams.github = {host, owner, repo, confirmedBy, confirmedAt}`，只由 `GET/PUT/DELETE /api/projects/:projectId/team-github` 读写（PUT 与 DELETE 要项目管理权限，读者 403、陌生人 404；`target` 必须是 `host/owner/repo`，否则 400）；项目 PATCH 永远不写它，带来的 `teams.github` 换回已存的值（`keepPinnedGithubTarget`），`teams` 被整个替换时也保留。项目设置「工作区与容器 → 团队默认设置」显示它与 origin 现在的去向，管理员可改成当前的或清除（`ProjectGithubTarget`）。
- 之后 origin 解析到的仓库与确认的不同：按钮禁用（`github_target_changed`，下面给项目设置的链接），请求、任务（`jobFacts`）与每次 gh 读取（`refreshNow`）都拒绝 `TEAM_PR_REMOTE_CHANGED`，什么都不推送、不调 gh。按钮上写着 `owner/repo`（`pullRequestRepo`）。

origin 从原始配置读（`team-git-write.ts:originTarget`，见[合并](merge.md)的 hosting）：推送的 URL 是配置的 `remote.origin.url`，只套主机自己的 `pushInsteadOf`/`insteadOf`；配了任何 `remote.origin.pushurl`、origin 有多个 URL、或仓库自己的 `insteadOf`/`pushInsteadOf` 改写 origin 的 URL，都拒绝 `TEAM_REMOTE_CONFIG_UNSAFE`（hosting 为 `unsafe`，禁用原因 `remote_config_unsafe`），从不用 git 的 `get-url --push`。

请求（`team-merge.ts`，权限同本地合并：协调者写 + 项目写，旁观者 403、陌生人 404）：
- `POST …/work/:itemId/merge`：GitHub 模式下是 PR 任务（job `pull_request`，`work.merge_requested {job, mode: "github"}`），gh 不可用时 409：`TEAM_PR_GH_MISSING`、`TEAM_PR_GH_LOGGED_OUT`、`TEAM_PR_GH_NO_PERMISSION`、`TEAM_PR_REPO_ARCHIVED`、`TEAM_PR_GH_UNAVAILABLE`（`ghRefusal`）；hosting 还没读出时仍按本地任务排队，任务里读到 GitHub 就转去 PR（`runMerge` 开头）。
- `POST …/work/:itemId/pr/merge`（`{ method? }`，Zod `mergeTeamPullRequestSchema`，不合法 400）：job `pr_merge`；不在 GitHub 上 `TEAM_PR_NOT_GITHUB`，方式不被仓库允许 `TEAM_PR_METHOD_NOT_ALLOWED`，省略时用仓库默认（`methods[0]`）。
- `POST …/work/:itemId/pr/refresh`：抽屉打开时读 PR（20 秒内读过就不读），202 `{ itemId, refreshing }`；没有 PR 409 `TEAM_PR_NONE`，不是 ready 409 `TEAM_WORK_ITEM_NOT_READY`；工作者在跑也可以读。
- 两个任务都占合并守卫、走每项目一把锁、10 分钟总期限，失败记 `work.merge_failed {code, message, job}`（同本地合并，见[合并](merge.md)）。

「发起 PR」（`team-merge-pr.ts:runPullRequest`）：
- 复核同本地合并的 `jobFacts`（团队活跃、ready、工作者没在跑、分支尖端仍是 ready 时的 head，否则 `TEAM_WORK_ITEM_HEAD_MOVED`）；只推真实完整的历史（`assertTrueHistory`、`assertNoReplacedHistory`）。
- 推送前重读 origin（`readOriginTarget`，与 hosting 同一来源），解析出的主机/owner/repo 必须正是确认过、gh 用的那个，否则 `TEAM_PR_REMOTE_CHANGED`，什么都不推（`pushUrlFor`）；推到配置的 origin URL 本身。
- `team-git-write.ts:pushBranch`：`git push --porcelain --no-verify --no-signed --no-recurse-submodules --no-follow-tags --receive-pack=git-receive-pack <URL> <head>:refs/heads/<分支>`，不带 `+`、不带 lease，120 秒、64KB。origin 的 URL 带密码（`https://user:token@host/…`）时，密码永不进任何命令行（git 也把 URL 当参数交给 `git-remote-https`，而 argv 谁都能读）：`splitUrlCredentials` 按 git 的 `credential_from_url` 拆出登录（第一个 `/` 前的第一个 `@`，它前面的第一个 `:`；`%XX` 解码），推送用去掉整个登录的 URL（不留用户名：否则 curl 先拿用户名配空密码试一次，多一次 401、算进锁定次数）；`credentialFromEnvironment` 在命令范围把凭据助手列表清空、先放一个只从环境变量 `NARRAFORK_PUSH_*` 读的助手（只回答协议与主机都对上的 `get`，不 store/erase），再按原顺序加回主机自己的助手——第一次 401 就带上用户名与密码，登录仍优先于主机助手，与写在 URL 里时一样；只有用户名、没有密码的 URL 原样不动，照旧由主机助手回答。有意的代价：URL 带密码时整个登录都拿掉，主机上按用户名写的 `http.https://user@host/.*` 设置（`sslCert`、`proxy`、`extraHeader` 等）对团队的推送和拉取不再生效（换来不多一次空密码的 401）。推送同样带上主机（不取仓库的）`remote.origin.proxy`/`proxyAuthMethod`（`hostOriginTransport`，经环境变量，与拉取一致），只能经这个代理到 GitHub 的主机上「发起 PR」也能推。推到哪里按[合并](merge.md)里「改写只有一条规则」解析（`resolveRemoteArgument`，推送先 `pushInsteadOf` 再 `insteadOf`，对配置的 URL 只做一次，git 不再改写交给它的参数，否则拒绝），所以 `originTarget().resolved`、比对确认的仓库与 git 推到的地方是同一个。非 http(s) 的 URL 带密码、或密码里有换行/NUL，直接失败不推送。远端分支有 head 没有的提交 → `TEAM_PR_PUSH_REJECTED`（抽屉给「退回给工作者」，理由预填 `pushRejectedReason`）；其他失败 `TEAM_PR_PUSH_FAILED`（消息去掉 URL 里的 userinfo，`redactUserinfo`）；分支真的动了才记 `work.pr_pushed {head, branch, repository}`。
- `gh pr list -R … --head=<分支> --state=all --limit=5`，只认本仓库同名分支（`isCrossRepository` 为真的 fork 分支不算）：有 OPEN 的就复用（基线不同 `TEAM_PR_BASE_MISMATCH`）；没有 OPEN、但有在这个 head 上、合进这个基线的 MERGED 的，直接记合并（是发现的，actor 为 system）；否则 `gh pr create -R … --head=<分支> --base=<基线> --title=<标题> --body-file=-`（不是草稿），失败 `TEAM_PR_OPEN_FAILED`。PR 的基线是 `baseBranchOf(基线).branch`：团队基线写成 `origin/main` 时 PR 指向 `main`。
- `work.pr_opened {pr, url, repository: host/owner/repo, base, head, created}` 只在新建、换了一个 PR、或找到的 OPEN PR 正是已被当作关闭的那个时记（「重新发起 PR」时 `reopened: true`，时间排在那条关闭之后）；PR 号与 URL 只存在这里（没有新列，`team-pr-state.ts:latestPullRequest`）。
- PR 由仓库加号码一起确定（`PrRef`）：项的 PR 是现在 origin 解析到（也就是确认过）的仓库里最新的 `work.pr_opened`（`latestPullRequest(itemId, target)`，最多看最新 20 条）；管理员改确认到别的仓库后，旧仓库的 PR 不再是这一项的，摘要 `pr` 为 null、按钮回到「发起 PR」，「合并 PR」409 `TEAM_PR_NONE`。状态缓存、`work.pr_closed`/`work.pr_checks`/`work.pr_queued` 都按仓库加号码匹配（事件 detail 带 `repository`，旧事件从 `url` 的 host（含端口）推出），新仓库同号的 PR 继承不到旧的读取或关闭。摘要多了 `pr.repository`，`team-page-model.ts:currentPullRequest` 只认仓库与确认的（或 origin 的）一致的 PR。
- 正文（`pullRequestBody`）：发起人（「由 NarraFork 用户 X 发起」/ `Opened by NarraFork user X`，按发起人语言）、大小（最近 `work.ready` 的 `diffStat`）、评审轮次（结论、评审者、发现数、意见原文）与退回理由；任何人或 agent 写的文字都放进代码块（多行的进围栏代码块，单行的进行内代码，`inlineCode`：分隔符比文字里最长的反引号串多一个，以反引号或空格开头结尾时两边各加一个空格），并把 `@`、`#` 换成全角、`GH-<数字>` 的连字符换掉、`://` 中间插入 U+2060，提及不到人、关不了 issue；栅栏比文字里最长的反引号串长；总长 ≤16KB，放不下时保留最新的轮次并说明。标题同样处理（`pullRequestTitle`）。

「合并 PR」（`runPrMerge`）：
- 先读 PR（`gh pr view`）：已 MERGED → 按下面「合并落地」的规则判断（点之前就合并了，记为 system）；基线不是这一项的基线 → `TEAM_PR_BASE_MISMATCH`，不合并；CLOSED → `TEAM_PR_CLOSED`；PR 上的 head 不是 ready 的 head → `TEAM_PR_HEAD_STALE`（先「更新 PR」）；草稿 → `TEAM_PR_DRAFT`；`BLOCKED` → `TEAM_PR_BLOCKED`；`BEHIND` → `TEAM_PR_BEHIND`；`UNKNOWN` 或空 → `TEAM_PR_STATE_UNKNOWN`；`DIRTY` → 冲突（见下）；只有 `CLEAN`、`HAS_HOOKS`、`UNSTABLE` 才合并。消息都带 PR 链接。
- PR 只在当前仓库里找（见上），找不到 `TEAM_PR_NONE`。
- `gh pr merge N -R … --<merge|squash|rebase> --match-head-commit=<head>`，从不带 `--delete-branch`（会删本地分支）、`--admin`、`--auto`；gh 说 head 变了 → `TEAM_PR_HEAD_STALE`，其他失败 `TEAM_PR_MERGE_FAILED`。
- 合并后再读：MERGED → 记合并；仍 OPEN（合并队列或自动合并接手）→ `work.pr_queued {pr, url, repository, method, head}`，界面显示「已加入合并队列」。「已加入」只认比这个 PR 最新的 `work.pr_opened`/`work.pr_closed` 更新的 `work.pr_queued`（关闭再重新打开就离开了队列，`team-pr-state.ts:prQueued`），GitHub 上的自动合并（`autoMergeRequest`）照样算。
- 冲突（`recordConflict`）：同一 PR 同一 head 已记过、又不是成员点的（后台一轮）就直接返回，不拉取也不算；否则先尽力拉取 `origin/<基线>`（`fetchBaseFromOrigin`，只动远程跟踪 ref），再用加固的 `merge-tree` 算 head 与它的冲突文件（git ≥2.38，最多 50），冲突列表按（仓库、head、基线提交）缓存，最多 200 条；记 `work.merge_failed {code: "conflict", job: "pr_merge", pr, url, repository, conflicts, more, base, head}`；「已记过」按仓库加号码加 head 比对（`aboutPullRequest`，旧事件的仓库从 URL 推出，含端口），别的仓库同号的冲突不算；同一 PR 同一 head 只通知协调者一次（`pullRequestConflictNote`），成员再点「合并 PR」仍记一条结果。

合并落地先判断这次合并是不是这一项的（`mergedPullRequest`）：PR 合进的基线必须是这一项的基线；GitHub 合并的 head 正是 ready 的 head，或 ready 的 head 在它里面（`gh api --hostname=H --method=GET repos/<o>/<r>/compare/<ready head>...<PR head>?per_page=1 --jq=.status` 为 `ahead`/`identical`，64KB 以内、Zod 校验；GitHub 上没有 ready 的 head 时 404，算不在）。不是的——在旧 head 上合并的（这一项退回后重新 ready 了）或合进别的基线的——记 `work.pr_closed {pr, url, repository, merged: true, reason: "older_head" | "other_base", head, base}`（已当作关闭时不再记），项仍 ready，摘要把这个 PR 当作已关闭，按钮是「重新发起 PR」，再发起时为新 head 开新的 PR（`pr list` 里旧的 MERGED 不在新 head 上，不复用）。OPEN 的 PR 被改了基线同样记 `work.pr_closed {reason: "other_base"}`。

「当作关闭」看这个 PR 最新的 `work.pr_opened` 与 `work.pr_closed` 谁更新（`team-pr-state.ts:prClosedForItem`）：在 GitHub 上重新打开、或改回这一项的基线后，读取发现它 OPEN 在这一项的基线上，就记 `work.pr_opened {…, created: false, reopened: true}`（时间排在关闭之后，`timeAfter`），它恢复为这一项的 PR；之后再关闭会再记一条 `work.pr_closed`。合并了的（`merged: true`）是终态，不会恢复。

是的才记合并（`landed`，唯一写入者 `work-items.ts:markMergedByPullRequest` → `markMerged`，事务内复核 ready、head、`updated_at`）：
- `work.merged {detectedBy: "pull_request", pr, url, mergeCommit, method, headMatches, baseBranch}`，squash、rebase 也认；成员合并时 actor 是那个人，读取发现的是 system，`method` 为 null。
- 之后后台尽力拉取 `origin/<基线>`（不动本地分支或任何工作区）再 `reconcileUnblocks({projectId})`；依赖可达也认 PR 的合并提交（`work-item-dependencies.ts:unreachedDependencies` 读最近 `work.merged` 的 `mergeCommit`），所以 squash 合并的依赖拉取后能解锁。
- 只在这次真的记下时通知协调者（`pullRequestMergedNote`：成员合并写「X merged it from the team page」，否则「It was merged on GitHub」）。worktree 由已有的人批准清理处理。

读取与转变（`refreshPullRequest`，不在任何 SQLite 事务里跑 gh）：
- 每项一次只读一个，结果缓存 20 秒（`team-pr-state.ts`，内存，按仓库加号码，最多 500 项）；后台一轮对已当作关闭的 PR 每 5 分钟才读一次（`CLOSED_RECHECK_MS`，看它是否被重新打开或改回基线），在旧 head 上合并了的永不再读；全进程最多 2 个读同时跑（`withReadSlot`：放出的名额直接交给下一个等待者，计数不变，中间插不进新来的）。`gh pr view N --json …`（64KB）；OPEN 时再 `gh pr checks N --json name,bucket,state,link,workflow`（256KB，退出码 1、8 仍带 JSON，没有检查算空），汇总为各桶计数与最多 10 个失败（名字与 http(s) 链接，`summarizeChecks`）。
- 合并任务持有该项时不读、不写事件。只在转变时写：MERGED → 记合并；CLOSED → `work.pr_closed`（已当作关闭时不再记）；当作关闭后又 OPEN 在这一项的基线上 → 再记 `work.pr_opened {reopened: true}`；OPEN 且是 ready 的 head 时，`DIRTY` → 冲突（同上，只一次），检查变成 failing/passing 或评审变成 `CHANGES_REQUESTED`/`APPROVED` → `work.pr_checks {pr, url, repository, head, checks, review, failed, failures}`，其中变成 failing 或要求修改时通知协调者（`pullRequestBlockedNote`）。
- 读、读出的冲突拉取与合并后的拉取都带后台一轮的 `AbortController`；停下时先 abort（gh 与 git 进程树被杀），再最多等 5 秒（`STOP_WAIT_MS`）。抽屉的读取同样只给有项目写权限的成员（`pr.canRefresh`），团队归档时 `pr/refresh` 409 `TEAM_ARCHIVED`。
- 主机是 github.com 之外的、以及 gh 登录状态：`ghAuthStatus` 先用 `gh auth status --hostname=H --json hosts`；老版本 gh 没有这个 `--json`（`unknown flag: --json`，如 2.72）时改跑 `gh auth status --hostname=H`，从文本（新版写 stdout、旧版写 stderr，两个都读）里认：单独一行是主机名 → gh 认识它，`Logged in to H` → 登录了，`Failed to log in to H`/`Timeout trying to log in to H` → 认识但没登录；退出码 0 又认不出任何一行也算登录（主机没有能用的账号时 gh 退出 1）。真正的关卡仍是 `gh repo view` 的写权限（`readAuthStatusText`）。
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
- 测试：`team-merge-pr.test.ts`（裸仓库当作 GitHub：hosting 经测试接缝读成 `https://github.com/acme/app.git`，主机自己的 `insteadOf` 把它指向裸仓库，推送是真的；假 gh 回放 JSON）、`team-hosting.test.ts`、`fake-gh.fixture.ts`（记录 argv、目录、环境、stdin；`rejects` 模拟不认识某个参数的老 gh，`olderGh`）。假 gh 只往 PATH 前面加，「完全没有 gh」把含 gh 的目录换成去掉 gh 的镜像目录——直接删掉那个目录会把同目录的 git 一起删掉（CI 上 gh 与 git 都在 `/usr/bin`）。

## 改它时
- 加 gh 子命令：只进 `team-gh.ts`，带超时、输出上限、Zod；先用 PATH 垫片或 `GH_DEBUG` 确认它不推送、不碰本地仓库。
- 加拒绝码：`team-merge.ts`/`team-merge-pr.ts`、`team-page-model.ts:MERGE_ERROR_CODES` 与两种语言的 `teams.page.merge.errors.*`。加 PR 的禁用原因：`shared/project-teams.ts:TEAM_PR_MERGE_BLOCKERS` 与 `teams.page.merge.prBlocker.*`（`team-page-model.test.ts` 核对两种语言）。
- 新事件种类：`TEAM_WORK_EVENT_KINDS`、`team-page-model.ts:eventNote`、两种语言的 `teams.event.*`/`teams.eventNote.*`；会改变「最新结果」的还要进 `team-merge.ts:OUTCOME_KINDS`。
- 不变量：GitHub origin 永不本地合并；只推送到、只用 gh 读写管理员确认过的仓库；gh 永不在仓库里跑；推送永不带 `+`；PR 信息只在事件里（确认的仓库在项目设置里）。
- 已知局限：NarraFork 只中和自己写的 PR 正文；工作者的提交信息原样进入 GitHub，合并（尤其 squash 时进默认分支的提交信息）后其中的 `Closes #n`、`@name` 和交叉引用照样生效。

## 相关
- [合并工作项与基线配置](merge.md)：hosting 判定、任务表与守卫、本地合并。
- [团队页与审批](page.md)：按钮、标签与抽屉。
- [外部进程加固](../../security/hardening.md)：推送的隔离、gh 的环境。
- [工作项](work-items.md)：`markMerged` 与依赖解锁。
