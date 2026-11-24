---
id: security.hardening
title: 外部进程加固
summary: git 执行加固、终端访问控制、子进程限制。
anchors:
  - server/lib/git-exec-hardening.ts
  - server/services/terminal-access.ts
  - server/lib/spawn.ts
  - server/services/narrator-worktree-service.ts
  - server/services/teams/team-git.ts
  - server/websocket/terminal-ws.ts
  - server/routes/terminals.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 外部进程加固

服务端在 agent 可写的检出里跑 git、给用户开终端时，要避免执行没人批准过的代码，并避免越权进入别人的 shell。这里是这两处的具体防线，加上子进程统一封装。

## 关键规则
- 只读/维护类 git 命令（status、rev-list、diff --name-only、worktree list/remove）带命令级配置覆盖 `GIT_NO_EXEC_CONFIG`：`core.hooksPath` 指向空设备、关闭 fsmonitor 与 untrackedCache、清空 `diff.external`、`core.sshCommand`、`credential.helper`、`core.askPass`；同时设 `GIT_OPTIONAL_LOCKS=0` 避免状态查询写索引（`lib/git-exec-hardening.ts:gitConfigEnv`）。
- 读工作树的命令（`status`、`worktree remove`）额外把配置里所有 filter 的 clean/smudge/process 清空，并按名字禁用配置定义的 hook；名字来自先跑一次只读的 `git config --get-regexp`（`PROGRAM_CONFIG_QUERY`、`untrustedProgramOverrides`，`narrator-worktree-service.ts:hardenedConfig`）。读不出来就失败（`WORKTREE_GIT_CONFIG_UNREADABLE`），不降级。
- `worktree add` 不加固，保留仓库自己的检出 hook 与 filter（`hardenedConfig` 开头）。
- git 低于 2.31 会静默忽略 `GIT_CONFIG_COUNT`，所以每进程探测一次哨兵配置，不通过就拒绝并报 `GIT_TOO_OLD_FOR_HARDENING`（409，失败不缓存）（`ensureConfigOverridesHonored`）。团队 worktree 的 git 同样套用（`services/teams/team-git.ts`）。
- `diff` 用 `noExternalDiffArgs` 加 `--no-ext-diff --no-textconv`。
- 终端权限（`services/terminal-access.ts`）：叙述者的终端跟随该叙述者 ACL，子代理用其根叙述者；`read` 只看元数据，`write` 覆盖开启、看输出和滚动缓冲、输入、改名、关闭、读进程列表，因为终端等同于在会话工作区的 shell。
- 无叙述者的独立终端只属于创建者加管理员；创建者只记在内存里（上限 1000 条，超出丢最旧），重启后只有管理员可用。未知 id 与被拒绝给同样答案，防止探测 id。
- REST（`routes/terminals.ts`）与终端 WebSocket（`websocket/terminal-ws.ts`）都调 `terminalAccessAllowed`；WebSocket 在连接期间还会重新校验。
- 子进程统一走 `lib/spawn.ts:safeSpawn`：可选硬超时、`maxOutputBytes`（默认 10 MB，stderr 可单独限额）、中止信号、watchdog，终止原因记录为 timeout/abort/watchdog/output-limit。调用方应显式给超时与输出上限（如上面探测的 10 秒、4096 字节）。

## 从哪读起
- `server/lib/git-exec-hardening.ts`：文件头注释列出了被禁掉的程序入口，测试在 `server/lib/__tests__/git-exec-hardening.test.ts`。
- `server/services/narrator-worktree-service.ts:hardenedConfig`：实际使用点。
- `server/services/terminal-access.ts`。

## 相关
- [访问控制](acl.md)
- [会话 worktree](../git/worktrees.md)
- [工具调用审批](tool-permissions.md)
