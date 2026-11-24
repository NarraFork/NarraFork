---
id: security.hardening
title: 外部进程加固
summary: git 执行加固、子进程统一封装（safeSpawn）。
anchors:
  - server/lib/git-exec-hardening.ts
  - server/lib/spawn.ts
  - server/services/narrator-worktree-service.ts
  - server/services/teams/team-git.ts
  - server/lib/win-handle-guard.ts
keywords:
  - GIT_NO_EXEC_CONFIG
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
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 外部进程加固

服务端在 agent 可写的检出里跑 git 时，要避免执行没人批准过的代码。这里是这一处的具体防线，加上子进程统一封装。终端的访问控制（谁能进哪个终端）不在这里，见 [访问控制](acl.md)。

## 关键规则
- 只读/维护类 git 命令（status、rev-list、diff --name-only、worktree list/remove）带命令级配置覆盖 `GIT_NO_EXEC_CONFIG`：`core.hooksPath` 指向空设备、关闭 fsmonitor 与 untrackedCache、清空 `diff.external`、`core.sshCommand`、`credential.helper`、`core.askPass`；同时设 `GIT_OPTIONAL_LOCKS=0` 避免状态查询写索引（`lib/git-exec-hardening.ts:gitConfigEnv`）。
- 读工作树的命令（`status`、`worktree remove`）额外把配置里所有 filter 的 clean/smudge/process 清空，并按名字禁用配置定义的 hook；名字来自先跑一次只读的 `git config --get-regexp`（`PROGRAM_CONFIG_QUERY`、`untrustedProgramOverrides`，`narrator-worktree-service.ts:hardenedConfig`）。读不出来就失败（`WORKTREE_GIT_CONFIG_UNREADABLE`），不降级。
- `worktree add` 不加固，保留仓库自己的检出 hook 与 filter（`hardenedConfig` 开头）。
- git 低于 2.31 会静默忽略 `GIT_CONFIG_COUNT`，所以每进程探测一次哨兵配置，不通过就拒绝并报 `GIT_TOO_OLD_FOR_HARDENING`（409，失败不缓存）（`ensureConfigOverridesHonored`）。团队 worktree 的 git 同样套用（`services/teams/team-git.ts`）。
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
