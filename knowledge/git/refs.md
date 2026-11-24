---
id: git.refs
title: 分支与引用查询
summary: 引用解析、合并基、祖先、领先落后、身份。
anchors:
  - server/services/git-ref-queries.ts
  - server/services/git-branch-listing.ts
  - server/services/git-identities.ts
  - server/lib/git-identity.ts
  - shared/git-branches.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 分支与引用查询

一组只读的引用问题（这个引用是哪个提交、两个提交的合并基、领先落后多少、有多少未提交改动）和分支列表解析，加上提交署名身份的维护。查询函数不自己启动 git，由调用方传入 runner，所以 `gitService` 与 worktree 服务各自保留自己的超时与输出上限。

## 关键规则
- `GitQueryRunner` 注入：`gitService` 用 `execRead`（60 秒、1 MB），worktree 服务用本地后端 runner（10 秒、杀进程树）（`git-ref-queries.ts` 文件头）。函数只读，输出是少量 SHA 和计数；输出被截断一律当失败，不去解析。
- 引用先解析再使用：`resolveCommit` 用 `rev-parse --verify --quiet --end-of-options <ref>^{commit}` 得到完整 SHA，后续命令只吃完整 SHA（`mergeBase`、`isAncestor`、`aheadBehind` 等都 `assertSha`），用户给的 ref 不会被当作选项、区间或路径（`assertQueryRef`：不能为空、超 256 字符、以 `-` 开头、含 `..` 或空白/控制字符）。
- 无此提交返回 null（exit 1 且无 stderr）；无公共祖先的 `mergeBase` 同样返回 null；其他失败抛 `GitError`。
- `aheadBehind` 用 `rev-list --left-right --count base...ref`，输出为常量大小。`countCommitsNotIn` 为 0 表示分支提交都已包含在基或上游中，删除不会丢历史；`countCommitsOnlyReachableFrom` 统计只有该提交可达、不被任何本地分支、远端跟踪引用或标签包含的提交，用于判断删除游离检出会丢什么。
- `uncommittedChanges` 逐个列出未跟踪文件（`-uall`），不计忽略文件；列表超过 256 KiB 时 `exact=false`，计数只是下界；对 `--skip-worktree`/`--assume-unchanged` 的编辑是盲区（`git-ref-queries.ts` 注释，git 自身行为）。
- 分支列表：`for-each-ref` 以 NUL 分隔的记录输出（分隔符写作 `%00`，不是 `%x00`），`refname:lstrip=2` 得到 `main`、`origin/main` 这样的短名；`%(symref)` 区分 `origin/HEAD` 与真分支；`parseGitBranches` 是本地与远程后端共用的唯一解析器，不缓存；上限 300 条（`shared/git-branches.ts:GIT_BRANCH_LIST_LIMIT`）；默认远程优先取 `origin`，否则仅有一个远程时取它（`git-branch-listing.ts`）；`matchingRemoteName` 在 shared 中按最长前缀匹配上游所属远程。
- 提交身份：谁触发这一轮，提交就署谁的名，而不是宿主机的全局配置，通过 `GIT_AUTHOR_*`/`GIT_COMMITTER_*` 环境变量传入。解析顺序：触发用户对该叙述者的选择 → 该用户的默认身份 → 无（继承宿主配置）（`lib/git-identity.ts` 文件头，`resolveNarratorGitIdentityEnv`）。触发用户没配置身份时不会回退到叙述者 owner 名下。无触发用户（后台延续、定时任务）才用 owner。
- 身份存储：`user_git_identities`（每人多条，恰有一条默认）、`narrator_git_identity_bindings`、`folder_git_identity_bindings`；选择按（用户 × 叙述者）保存，两个人驱动同一叙述者互不覆盖。姓名最多 100 字符、邮箱最多 254（`git-identities.ts`）。写入后使缓存失效。
- 工作树快照提交是 NarraFork 自己的记账，不使用用户身份，用固定的合成身份（`lib/git-identity.ts` 文件头）。
- 对外接口：`/api/auth/git-identities` 增删改查（`routes/auth.ts`）；提交与暂存提交调用 `resolveUserGitIdentityEnv`（`routes/git.ts`）。

## 从哪读起
- `server/services/git-ref-queries.ts`：全部查询函数，短小。
- `server/lib/git-identity.ts:resolveGitIdentityForTurn`：署名决策。
- 测试：`server/services/__tests__/git-branch-listing.test.ts`、`git-identities.test.ts`。

## 相关
- [git 服务与状态](service-status.md)
- [会话 worktree](worktrees.md)：删除检查用到领先落后与未提交计数。
