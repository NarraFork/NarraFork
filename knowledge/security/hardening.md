---
id: security.hardening
title: 外部进程加固
summary: git 执行加固、子进程统一封装（safeSpawn）。
anchors:
  - server/lib/git-exec-hardening.ts
  - server/services/teams/team-gh.ts
  - server/lib/spawn.ts
  - server/services/narrator-worktree-service.ts
  - server/services/teams/team-git.ts
  - server/lib/win-handle-guard.ts
keywords:
  - GIT_NO_EXEC_CONFIG
  - gh
  - pushBranch
  - borrowingRepository
  - GIT_CONFIG_COUNT
  - GIT_OPTIONAL_LOCKS
  - GIT_TOO_OLD_FOR_HARDENING
  - WORKTREE_GIT_CONFIG_UNREADABLE
  - safeSpawn
  - maxOutputBytes
  - core.hooksPath
  - fsmonitor
  - --no-ext-diff
  - 子进程超时
  - 输出上限
status: draft
verified_at: ddc6b6a25ee0907d09b3af062d68f5ce3ee7b31e
---
# 外部进程加固

服务端在 agent 可写的检出里跑 git 时，要避免执行没人批准过的代码。这里是这一处的具体防线，加上子进程统一封装。终端的访问控制（谁能进哪个终端）不在这里，见 [访问控制](acl.md)。

## 关键规则
- 只读/维护类 git 命令（status、rev-list、diff --name-only、worktree list/remove）带命令级配置覆盖 `GIT_NO_EXEC_CONFIG`：`core.hooksPath` 指向空设备、关闭 fsmonitor 与 untrackedCache、清空 `diff.external`、`core.sshCommand`、`credential.helper`、`core.askPass`、`core.alternateRefsCommand`（有 alternates 时 fetch 会跑它），`maintenance.auto=false`、`gc.auto=0`（不起后台维护）；同时设 `GIT_OPTIONAL_LOCKS=0` 避免状态查询写索引、`GIT_NO_LAZY_FETCH=1`（部分克隆缺对象时不经仓库配的 promisor remote 去拉，那会运行它的 upload-pack；git 2.45 起才认它，是否认按行为探测——在临时目录里建一个缺 blob 的部分克隆，带它必须失败、不带（显式去掉）必须拉到；结果三态 supported / unsupported / inconclusive，只缓存前两者，临时目录建不出、git 出错等算 inconclusive，退避 30 秒后重探，从不缓存拒绝；未确认 supported 前配置查询里看到 `extensions.partialClone`、任何 `remote.*.promisor` 或 `remote.*.partialCloneFilter` 就拒绝，`GIT_TOO_OLD_FOR_PARTIAL_CLONE`，普通仓库照常；`probeLazyFetch`）（`lib/git-exec-hardening.ts:gitConfigEnv`）。
- 团队 git 的闸门 `team-git.ts:prepareTeamRepo(dir)`：`spawnGit` 与 team-git-write 的 `run()` 每条命令先等它——确认覆盖被认、懒拉取结论已定；若本机 git 未确认支持 `GIT_NO_LAZY_FETCH`（`lazyFetchPrevented()` 为假），先只读配置（`configuredPrograms`，不读任何对象）并按 `untrustedProgramOverrides` 拒绝部分克隆/promisor，`GIT_TOO_OLD_FOR_PARTIAL_CLONE`。所以 `assertNoReplacedHistory`、`assertTrueHistory`、各读取器、合并、快进与工作起点在读对象（如替换引用指向的缺失对象）之前都已过闸，缺对象不会经仓库配置的 remote 被懒拉取。支持时不多花一次调用。只有两条只读元数据、不读对象的命令可以不过这道部分克隆检查（`spawnGit` 的 `metadataOnly`，限于 `METADATA_ONLY_COMMANDS`，别的命令带它直接报错）：`rev-parse --is-inside-work-tree`（`isGitWorkTree`：部分克隆仍是工作树，建团队时才在解析基线处以 `GIT_TOO_OLD_FOR_PARTIAL_CLONE` 拒绝，而不是误报 `TEAM_PROJECT_NOT_GIT`）和闸门自己读的配置查询。`GIT_TOO_OLD_FOR_PARTIAL_CLONE` 走错误目录（`shared/error-catalog.ts`，`catalogError`），en/zh-CN 文案在 `errors.json`。
- 加固过的 git 子进程都从 `cleanGitEnv()` 起环境：去掉服务进程自身继承的 `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`/`GIT_INDEX_FILE`/`GIT_OBJECT_DIRECTORY`/`GIT_ALTERNATE_OBJECT_DIRECTORIES`/`GIT_NAMESPACE`/`GIT_CEILING_DIRECTORIES`/`GIT_TEMPLATE_DIR`/`GIT_CONFIG`/`GIT_CONFIG_PARAMETERS`/`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`VALUE_n`/`GIT_EXTERNAL_DIFF`/`GIT_NO_LAZY_FETCH` 等改路由、对象库、模板或加配置的变量，保留运维的 `GIT_CONFIG_GLOBAL`/`SYSTEM`/`NOSYSTEM`；懒拉取探测连这些也去掉，用自己的空配置（team-git、team-git-write、narrator-worktree-service 都用它）。
- 团队 git 只按真实对象回答历史（`TRUE_HISTORY_ENV`，由 team-git 的读、team-git-write 的 `run()` 与两个探测自己加，不看宿主环境）：`GIT_NO_REPLACE_OBJECTS=1` 忽略 `refs/replace/*`（仓库内容，agent 可写；否则能让 `merge-base --is-ancestor` 把工作项说成已在基线里），`GIT_GRAFT_FILE` 指向不存在的 `<DEV_NULL>/no-grafts`（`GIT_NO_REPLACE_OBJECTS` 不关 `info/grafts`；指 `/dev/null` 会读它并打 deprecation 提示），去掉继承的 `GIT_REPLACE_REF_BASE`/`GIT_SHALLOW_FILE`。`cleanGitEnv` 与 `gitConfigEnv` 不带它：叙述者 worktree 的创建等仍按 git 默认读历史，否则从被替换的提交建出的 worktree 索引是真实树、而人自己的 git 看替换后的树，`git status` 会出现没人做过的暂存改动。浅克隆、graft 文件与影响基线/工作项的替换引用另由团队拒绝（`assertTrueHistory`、`assertNoReplacedHistory`），见 collaboration/teams/merge。
- 读工作树的命令（`status`、`worktree remove`）额外把配置里所有 filter 的 clean/smudge/process 清空，并按名字禁用配置定义的 hook、清空自定义合并驱动（`merge.<名>.driver` 置空：git 不运行任何程序，那个文件按冲突算）；名字来自先跑一次只读的 `git config --get-regexp`（`PROGRAM_CONFIG_QUERY`、`untrustedProgramOverrides`，`narrator-worktree-service.ts:hardenedConfig`）。
- 团队合并与起点拉取的 git（`services/teams/team-git-write.ts`）多一条规则：仓库自己的配置（local/worktree，agent 可写）不能运行程序，也不能选凭证、传输或身份。敏感键用 `git config --show-scope` 读（`scopedConfig`），只认 system/global，仓库值在命令级改回主机值或中性值，没有中性值就拒绝。落到：凭证助手、askpass、http 与代理、ssh 命令（`networkOverrides`、`sshSettings`）；签名程序与 `commit.gpgsign`（`signingConfig`）；提交身份（`hostIdentity`）；`fetch .` 只许本地传输（`ext::` 的 insteadOf 跑不起来）；在人的检出里快进时关 autostash、签名校验、子模块递归。可运行程序的配置（filter、配置 hook、合并驱动）在每条可能运行它们的命令前重读。见[合并工作项与基线配置](../collaboration/teams/merge.md)。
- 团队 PR 流程的推送（`team-git-write.ts:pushBranch`）连仓库自己的配置都不读：git 推到一个 URL 时，若某个配置的 remote 的推送 URL 正是它，会按那个 remote 的 fetch refspec 更新"跟踪"ref（agent 能把它指到被检出的基线上），还会用那个 remote 的设置。所以推送从 NarraFork 自己的一次性裸仓库（`<home>/run/push-*`，同对象格式，只经 `objects/info/alternates` 借用项目的对象库，没有 remote、hook 和别的配置，用完删掉，`borrowingRepository`）里跑，只读主机配置与命令级覆盖，项目的任何 ref 都不动。推之前仍按拉取的规则检查项目的配置（`networkOverrides`：仓库的 `core.gitProxy`、`remote.origin.vcs`、改写 origin 的 `insteadOf`、无中性值的 `http.*` 照样拒绝 `TEAM_REMOTE_CONFIG_UNSAFE`），另外仓库的 `url.*.insteadOf` / `url.*.pushInsteadOf` 前缀命中推送 URL、或有以该 URL 为名的 `remote.<URL>.*` 也拒绝（`assertPushUrlUntouched`）。命令带 `--no-verify --no-signed --no-recurse-submodules --no-follow-tags --receive-pack=git-receive-pack`，命令级 `push.gpgSign=false`、`push.recurseSubmodules=no`、`push.followTags=false`、`push.negotiate=false`、`push.autoSetupRemote=false`、`push.pushOption=`（清空），协议同拉取（`ext::` 永不），120 秒、64KB；出错消息去掉 URL 的 userinfo（`redactUserinfo`）。见 [GitHub PR 流程](../collaboration/teams/pull-requests.md)。
- GitHub CLI（`gh`，`teams/team-gh.ts`）是团队唯一会跑的另一个外部程序：从 NarraFork 的空目录 `<home>/run/gh` 运行，总带 `-R host/owner/repo`，`GIT_DIR` 指向不存在的路径、`GIT_CEILING_DIRECTORIES` 为该目录（gh 会自己跑 `git remote -v`）；环境从 `cleanGitEnv` 起，`GH_*`/`GITHUB_*` 只留令牌、`GH_HOST`、`GH_CONFIG_DIR`，去掉编辑器、浏览器、分页器、调试、`GIT_SSH*`，关提示、更新提醒、颜色与分页；不用会推送或碰本地仓库的子命令与参数（`pr create` 总带 `--head`，`pr merge` 不带 `--delete-branch`/`--admin`，不用 `pr checkout`）；参数按严格模式校验，正文经 stdin；每次都有超时、输出上限、中止时杀进程树，JSON 经 Zod。测试用 PATH 上的假 gh 记录 argv、目录与环境（`fake-gh.fixture.ts`）。
- `worktree add` 不加固，保留仓库自己的检出 hook 与 filter（`hardenedConfig` 开头）。
- git 低于 2.31 会静默忽略 `GIT_CONFIG_COUNT`，所以每进程探测一次哨兵配置，不通过就拒绝并报 `GIT_TOO_OLD_FOR_HARDENING`（409，失败不缓存）（`ensureConfigOverridesHonored`）。团队 worktree 的 git 同样套用（`services/teams/team-git.ts`，含建团队前对项目目录的 `isGitWorkTree` 与基线分支解析；它读 blob 用 `cat-file blob`，不走 filter 与 textconv，经 `safeSpawn` 的 `stdoutStream` 按 blob 大小 +1 字节限额；团队页读单个文件的 diff 同样用 `stdoutStream` 读到 64KB+1 字节即停，`diff --numstat` 输出上限 512KB）。
- `diff` 用 `noExternalDiffArgs` 加 `--no-ext-diff --no-textconv`。
- `safeSpawn` 在每次启动子进程和 `killWindowsProcessTree` 前调用 `win-handle-guard.ts:clearInheritableHandlesBeforeSpawn`（仅 Windows）：清掉可继承句柄，免得子进程带走服务端的句柄；非 Windows 为空操作。
- 子进程统一走 `lib/spawn.ts:safeSpawn`：可选硬超时、`maxOutputBytes`（默认 10 MB，stderr 可单独限额）、中止信号、watchdog，终止原因记录为 timeout/abort/watchdog/output-limit。调用方应显式给超时与输出上限（如上面探测的 10 秒、4096 字节）。

## 从哪读起
- `server/lib/git-exec-hardening.ts`：文件头注释列出了被禁掉的程序入口，测试在 `server/lib/__tests__/git-exec-hardening.test.ts`。
- `server/services/narrator-worktree-service.ts:hardenedConfig`：实际使用点。

## 改它时
- 新增一处在 agent 可写检出里跑 git 的调用：要带 `gitConfigEnv(...)`（或沿用 `narrator-worktree-service.ts:hardenedConfig`），并经 `ensureConfigOverridesHonored`；`worktree add` 是唯一有意不加固的命令。守卫测试：`server/lib/__tests__/git-exec-hardening.test.ts`。
- 想放开某项被清空的程序入口，要同时改 `GIT_NO_EXEC_CONFIG` / `untrustedProgramOverrides`，团队 worktree 的 git（`services/teams/team-git.ts`）共用同一份，改一处两边生效。
- 新增子进程调用必须给 `timeout` 与 `maxOutputBytes`，不要绕开 `safeSpawn`；输出被截断时调用方按失败处理，不解析半截输出（见 [分支与引用查询](../git/refs.md)）。
- 版本探测失败不缓存（`ensureConfigOverridesHonored`），不要为「老 git 也能用」降级成不加固。

## 相关
- [访问控制](acl.md)：终端访问控制（`terminal-access.ts`）在那里。
- [会话 worktree](../git/worktrees.md)
- [工具调用审批](tool-permissions/index.md)
