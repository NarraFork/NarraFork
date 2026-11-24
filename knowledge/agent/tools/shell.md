---
id: agent.tools.shell
title: 命令与终端工具
summary: Bash、后台任务、Watch、Stop、Terminal 工具（Await 已退役）。
anchors:
  - server/routes/narrator-manual-resources.ts
  - server/lib/agent/tools/bash.ts
  - server/lib/agent/tools/await.ts
  - server/lib/agent/tools/terminal.ts
  - server/lib/agent/tools/watch.ts
  - server/lib/agent/tools/stop.ts
  - server/services/background-bash-lifecycle.ts
  - server/services/watch-observation.ts
  - server/lib/agent/bash-analyze.ts
  - server/lib/agent/shell.ts
  - server/lib/agent/tools/pipeline.ts
  - server/lib/agent/tools/terminal-escapes.ts
  - server/services/await-agent-resolution.ts
  - server/services/background-bash-result.ts
  - server/services/background-occupancy-index.ts
  - server/services/background-occupancy-startup.ts
  - server/services/background-occupancy-store.ts
  - server/services/background-task-service.ts
  - server/services/bg-completion-queue.ts
  - server/services/manual-background-task.ts
  - server/services/stop-task-policy.ts
  - server/services/terminal-watch-constants.ts
  - server/services/terminal-watch-service.ts
  - server/services/watch-service.ts
  - server/services/watch-restart.ts
  - server/services/watch-source.ts
  - shared/background-task-list.ts
  - shared/watch-command.ts
keywords:
  - Bash
  - run_in_background
  - background_kind
  - Watch
  - Stop
  - Terminal
  - Await 已退役
  - 后台任务
  - background_tasks
  - notify_on
  - TeamStatus
  - StartPipeline
  - ExtractPipeline
  - bash-analyze
  - processTerminalEscapes
  - terminal watch
  - [watch]
status: draft
verified_at: 2e6441ad0
---
# 命令与终端工具

执行命令有两条路：Bash（一次性命令，可转后台）和 Terminal（持久交互式 PTY）。等待结果的方式不是阻塞，而是 Watch 观察 + 邮箱通知；旧的 Await 已退役。

## 关键规则
- Bash 在所有平台都叫 `Bash`（`tool-name.ts`）。前台默认超时 120000ms，上限 86,400,000ms；后台默认 5 小时，传 0 表示无墙钟限制（`bash.ts:resolveBashTimeoutMs`）。内存中输出上限 10MB，实时输出推送限 100000 字符、约每 250ms 一次（`bash.ts` 顶部常量）。工具描述里写的“最多 600000ms”与 `resolveBashTimeoutMs` 的实际上限不一致，以代码为准。
- 并行：同一轮里 Bash 默认串行，仅 `parallel: true` 且未设 `strict_serial` 才能与同组并发（`shared/tool-parallel-groups.ts:isBashParallelOptIn`）。
- 后台：`run_in_background: true`；`background_kind` 为 `task`（默认，构建/测试）或 `service`（dev/preview/watch 服务，必须配合后台运行；service 不关闭超时，非请求的退出——即使退出码 0——算失败）。取消用 `Stop({type:"bash", id})`，Bash 只负责启动。运行中可更新超时（`updateBashTimeout`，钳到 1000ms 以上）。
- `BackgroundBashLifecycle` 管后台 Bash 的收集器与终态写入：`stop()` 后拒绝新准入；`preserveProcesses` 时已启动进程被保留，尚在准备阶段的任务仍需把任务行结算（`services/background-bash-lifecycle.ts`）。
- Await：工具已退役，执行器（`tool-executor.ts`）与 `tools/await.ts` 都只返回「Await is retired」错误，提示改用 Watch；它不在 `tools/index.ts` 的注册清单中，`listRunningAwaits` 恒返回空。`services/await-agent-resolution.ts` 仍被 `narrator-messages.ts` 引用，用于解析历史里仍在运行的 `Await({type:"agent"})` 调用的目标（只服务旧数据，不要给新功能用）。
- Watch：对 terminal / 后台 bash / agent 注册非阻塞观察，立即返回句柄；匹配文本、完成或超时通过邮箱送达。默认超时 600000ms，最大 86,400,000ms（`watch-observation.ts`）。超时只结束观察，不停止目标；已结束的目标立即返回保存的结果；agent 观察不支持 `pattern`；`start_at` 只用于 terminal。
- Stop：只取消本叙述者拥有的后台 bash 或 agent，不能停服务器或任意 PID；取消前重新校验 OAuth 工具能力。
- 后台任务服务（`background-task-service.ts`，很大）：后台 Bash、Watch 观察行和子代理共用 `background_tasks` 表，`BackgroundTaskEffectiveStatus` 还会按叙述者状态派生 `continued` / `child_running`；任务列表是游标分页加增量推送（默认页 30、上限 50，首页进行中任务按「工作」与「服务」各最多 200 条并带 `activeTruncated`，列表行的 `output` 有字符上限），不再整表轮询（`shared/background-task-list.ts`）。占用索引只读小列、不含消息/输出/标题（`background-occupancy-index.ts`、`-store.ts`），启动时初始化且关停中的进程不被辅助恢复拖住（`background-occupancy-startup.ts`）。
- 后台 Bash 结果：输出超过 5120 字节溢出到磁盘、预览 1024 字节、采集上限 10MB，写盘超时 2s（`background-bash-result.ts`）；后台 agent 完成通知只是显示格式与调度提示，持久意图在结果事务里，由 `agent-runtime/publication.ts` 转入唯一邮箱（`bg-completion-queue.ts`）。
- 用户手动起的后台命令（`manual-background-task.ts`）：代理环境变量只转发主机后缀和全局通配规则，不把精确的正则/URL/端口豁免放宽成更宽的主机名豁免；经 `resolveBackend` 选后端，并受最终更新的互斥控制。
- Stop 的授权以被跟踪的任务为准，而不是入参里的 `device` 或会话目录：先解别名，任务必须存在、属于本叙述者、类型相符（`stop-task-policy.ts:resolveOwnedStopTask`）。
- Watch 的实现：`watch-service.ts:watchTask` 注册观察，终端观察是一条后台 `bash` 任务（复用任务行、TeamStatus 列表、Stop 取消、完成通知），匹配渲染后的终端文本而不是原始 PTY 字节，起点是 xterm marker，输出只把观察标脏、最多每 250ms 读一次文本；终态为 `completed` / `timeout` / `failed` / `cancelled`（`terminal-watch-service.ts`）；同一被观察条件只有一个等待者，多个观察共享（`watch-source.ts`）；Watch 行的命令前缀 `[watch]`、`[terminal watch]` 让服务端拒绝把它们当 Watch 目标、任务面板默认过滤（`shared/watch-command.ts`、`terminal-watch-constants.ts`）。
- Watch 的重启恢复：重启时遗留的 running Watch 行，只有同时满足以下条件才保留并重新挂接，否则以重启通知结束（`watch-restart.ts:restartResumableWatch`）：
  - 无 `pattern`（只观察生命周期；文本观察看不到停机期间的输出，仍结束为 interrupted）。
  - 命令里有 `timeoutMs`。
  - bash / agent 目标有 `runId` 绑定；terminal 目标自带绑定（重启不复用终端 id）。
  - 原始截止时间（`createdAt + timeoutMs`）尚未过。
- 重新挂接的流程（`background-task-service.ts:resumeDeferredWatches`、`watch-service.ts:resumeWatchAfterRestart`）：
  - 截止时间沿用原绝对时间，只给剩余时长；重复 Watch 延长的截止时间由 `extendWatchDeadline` 写回运行中行的 `timeout`。
  - 授权身份取行上持久化的 `principal_json`（登记者 `userId`）；没有记录（旧行或格式不对）则不挂接，按 interrupted 结束；不借用后来协作者的策略。
  - bash：目标任务必须仍 running、属于同一叙述者、`logicalRunId` 与 runId 一致。
  - agent：叙述者 `logicalRunId` 一致、仍是团队成员、快照状态为 running。
  - terminal：先等 `terminalService.whenStartupRecoverySettled()`，在后台挂接，不拖慢叙述者恢复；终端已退出或已脱离，由 Watch 自己报告。
  - 挂接复用原行 id 与精确句柄（`restoreTaskAlias`）；重复遗留行并入先挂接的观察时，只有持有活观察的那一行算挂接成功。
  - 挂接失败：行被标为失败并带 `TERMINAL_WATCH_RESTART_NOTICE`（只声称 Watch 没有停止目标，重启本身可能已停止）。
- Terminal（可选工具）：动作 `create` / `rename` / `read` / `write` / `list`。`read` 默认增量，只给上次读/写之后的新输出，`last_n_lines` 覆盖增量；`write` 的 `notify_on` 在发送前先建立 Watch 并排除输入回显。终端是不受逐行检查的 shell，是否可用由会话权限模式整体决定。Terminal 不做一次性命令。
- Terminal 的输入转义：模型把回车写成字面 `\n`、控制键写成 `\x03`，`terminal-escapes.ts:processTerminalEscapes` 转成发给 PTY 的字节。
- `tools/pipeline.ts` 的 `StartPipeline` / `ExtractPipeline`（可选工具）：开启后，后续可能很长的工具输出按短别名（p1、p2…）捕获，模型只收到 ≤100 字符预览；`ExtractPipeline` 用受限的类 shell 规则（`from`、`cat`、`grep`、`head`、`tail`、`sort`、`uniq`、`cut`）反复查询同一批捕获，连续若干次未使用的工具调用后捕获自动清除。规则引擎见 [Agent Loop](../loop.md) 的流水线一条。
- Bash 命令的自动放行判断由 `bash-analyze.ts` 完成：用 tree-sitter bash 语法解析出子命令与文件路径，再按白名单加危险模式检测决定。杀进程树见 `shell.ts:killTree`（Unix 先对进程组发 SIGTERM，稍后升级 SIGKILL；Windows 用 taskkill 兜底）。

## 从哪读起
- `server/lib/agent/tools/bash.ts:bashTool`
- `server/lib/agent/tools/watch.ts`、`server/services/watch-observation.ts`
- `server/lib/agent/tools/terminal.ts`
- 测试：`tools/__tests__/bash-stop-teamstatus.test.ts`、`bash-workspace-activity.test.ts`；`agent/__tests__/bash-analyze.test.ts`、`execution-timeout.test.ts`

## 改它时
- 改 Bash 超时或输出上限：`bash.ts` 顶部常量、`resolveBashTimeoutMs`、`background-bash-result.ts` 的采集上限（注释要求与 `MAX_OUTPUT_BYTES` 一致）要一起改；工具描述里写的上限与代码不一致时以代码为准并顺手改描述。
- 改 Bash 并行规则：单一来源是 `shared/tool-parallel-groups.ts`（`tool-execution-groups.test.ts`）。
- 改自动放行（`bash-analyze.ts`）会影响权限判定，跑 `agent/__tests__/bash-analyze.test.ts`，并看 [工具调用审批](../../security/tool-permissions/index.md)。
- 新增后台任务种类要同步任务列表分页与占用索引（`shared/background-task-list.ts`、`background-occupancy-*.ts`），列表读取不得带出消息或输出大字段。
- 改重启恢复：`watch-restart.ts` 的资格判断、`background-task-service.ts` 的扫描与 `resumeDeferredWatches`、`watch-service.ts:resumeWatchAfterRestart` 要一起看；登记者新增写入点要传 `principal`（`background_tasks.principal_json`）。`terminalLifecycleReader`（`terminal-watch-service.ts`）由 Terminal 工具和重启挂接共用。
- Watch/Stop 新增目标类型要同时改 `watch-observation.ts` 的校验、`stop-task-policy.ts` 的授权与 `shared/watch-command.ts` 的前缀过滤；Watch 观察超时只结束观察，不停止目标。
- 测试：`tools/__tests__/bash-stop-teamstatus.test.ts`、`bash-workspace-activity.test.ts`、`terminal-watch-tool.test.ts`、`pipeline*.test.ts`，`agent/__tests__/execution-timeout.test.ts`。

## 相关
- [执行后端](../execution.md)
- [工具体系](index.md)
