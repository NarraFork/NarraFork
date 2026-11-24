---
id: agent.tools.shell
title: 命令与终端工具
summary: Bash、后台任务、Await、Terminal 工具。
anchors:
  - server/lib/agent/tools/bash.ts
  - server/lib/agent/tools/await.ts
  - server/lib/agent/tools/terminal.ts
  - server/lib/agent/tools/watch.ts
  - server/lib/agent/tools/stop.ts
  - server/services/background-bash-lifecycle.ts
  - server/services/watch-observation.ts
  - server/lib/agent/bash-analyze.ts
  - server/lib/agent/shell.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 命令与终端工具

执行命令有两条路：Bash（一次性命令，可转后台）和 Terminal（持久交互式 PTY）。等待结果的方式不是阻塞，而是 Watch 观察 + 邮箱通知；旧的 Await 已退役。

## 关键规则
- Bash 在所有平台都叫 `Bash`（`tool-name.ts`）。前台默认超时 120000ms，上限 86,400,000ms；后台默认 5 小时，传 0 表示无墙钟限制（`bash.ts:resolveBashTimeoutMs`）。内存中输出上限 10MB，实时输出推送限 100000 字符、约每 250ms 一次（`bash.ts` 顶部常量）。工具描述里写的“最多 600000ms”与 `resolveBashTimeoutMs` 的实际上限不一致，以代码为准。
- 并行：同一轮里 Bash 默认串行，仅 `parallel: true` 且未设 `strict_serial` 才能与同组并发（`shared/tool-parallel-groups.ts:isBashParallelOptIn`）。
- 后台：`run_in_background: true`；`background_kind` 为 `task`（默认，构建/测试）或 `service`（dev/preview/watch 服务，必须配合后台运行；service 不关闭超时，非请求的退出——即使退出码 0——算失败）。取消用 `Stop({type:"bash", id})`，Bash 只负责启动。运行中可更新超时（`updateBashTimeout`，钳到 1000ms 以上）。
- `BackgroundBashLifecycle` 管后台 Bash 的收集器与终态写入：`stop()` 后拒绝新准入；`preserveProcesses` 时已启动进程被保留，尚在准备阶段的任务仍需把任务行结算（`services/background-bash-lifecycle.ts`）。
- Await：工具已退役，执行器与工具本身都直接返回错误，提示改用 Watch（`tool-executor.ts`、`tools/await.ts`）；它不在 `tools/index.ts` 的注册清单中。
- Watch：对 terminal / 后台 bash / agent 注册非阻塞观察，立即返回句柄；匹配文本、完成或超时通过邮箱送达。默认超时 600000ms，最大 86,400,000ms（`watch-observation.ts`）。超时只结束观察，不停止目标；已结束的目标立即返回保存的结果；agent 观察不支持 `pattern`；`start_at` 只用于 terminal。
- Stop：只取消本叙述者拥有的后台 bash 或 agent，不能停服务器或任意 PID；取消前重新校验 OAuth 工具能力。
- Terminal（可选工具）：动作 `create` / `rename` / `read` / `write` / `list`。`read` 默认增量，只给上次读/写之后的新输出，`last_n_lines` 覆盖增量；`write` 的 `notify_on` 在发送前先建立 Watch 并排除输入回显。终端是不受逐行检查的 shell，是否可用由会话权限模式整体决定。Terminal 不做一次性命令。
- Bash 命令的自动放行判断由 `bash-analyze.ts` 完成：用 tree-sitter bash 语法解析出子命令与文件路径，再按白名单加危险模式检测决定。杀进程树见 `shell.ts:killTree`（Unix 先对进程组发 SIGTERM，稍后升级 SIGKILL；Windows 用 taskkill 兜底）。

## 从哪读起
- `server/lib/agent/tools/bash.ts:bashTool`
- `server/lib/agent/tools/watch.ts`、`server/services/watch-observation.ts`
- `server/lib/agent/tools/terminal.ts`
- 测试：`tools/__tests__/bash-stop-teamstatus.test.ts`、`bash-workspace-activity.test.ts`；`agent/__tests__/bash-analyze.test.ts`、`execution-timeout.test.ts`

## 相关
- [执行后端](../execution.md)
- [工具体系](index.md)
