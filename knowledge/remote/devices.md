---
id: remote.devices
title: 设备与远程执行
summary: 设备注册与连接、remote-executor、文件传输。
anchors:
  - server/services/device-service.ts
  - server/services/device-connection-service.ts
  - server/services/device-remote-backend.ts
  - server/services/device-transfer-service.ts
  - server/services/device-transfer-task-store.ts
  - server/routes/devices.ts
  - server/routes/executor-bootstrap.ts
  - server/lib/agent/execution/device-auth.ts
  - server/lib/agent/execution/rpc-types.ts
  - remote-executor/cmd/
  - remote-executor/go.mod
  - remote-executor/internal/session/
  - remote-executor/internal/handlers/session.go
  - remote-executor/internal/handlers/session_unix.go
  - remote-executor/internal/handlers/session_windows.go
  - remote-executor/internal/handlers/session_kill_linux.go
  - remote-executor/internal/handlers/session_kill_other.go
  - remote-executor/internal/transport/session_test.go
  - server/services/executor-session-cleanup.ts
  - server/services/remote-session-exec.ts
  - frontend/components/settings/DevicePathRulesEditor.tsx
  - frontend/components/settings/ExecutorInstallModal.tsx
  - frontend/components/settings/executor-install-command.ts
  - frontend/lib/api/devices.ts
  - frontend/lib/device-config.ts
  - frontend/lib/device-install-url.ts
  - frontend/routes/settings/devices.tsx
  - server/lib/agent/tools/transfer-file.ts
  - server/lib/agent/tools/transfer-progress.ts
  - server/lib/crc32c.ts
  - server/lib/device-url.ts
  - server/lib/executor-binaries.ts
  - server/lib/executor-bootstrap-ticket.ts
  - server/lib/executor-enrollment-policy.ts
  - server/lib/executor-install-ca.ts
  - server/lib/executor-install-script.ts
  - server/lib/helper-binaries.ts
  - server/lib/helper-binary-platform.ts
  - server/lib/helper-distribution-runtime.ts
  - server/lib/validators/devices.ts
  - shared/executor-path-rules.ts
  - shared/remote-executor-manifest.ts
  - shared/remote-executor.ts
  - shared/helper-distribution.ts
  - shared/windows-pe.ts
keywords:
  - 远程设备
  - 设备
  - remote-executor
  - 执行器
  - rdev_
  - remote_devices
  - device_transfer_tasks
  - /api/devices
  - /api/executor
  - /ws/device
  - connectionMode
  - directUrl
  - DeviceScopeError
  - DEVICE_OFFLINE
  - DEVICE_SCOPE_FORBIDDEN
  - DEVICE_PTY_UNAVAILABLE
  - DEVICE_PLATFORM_UNSUPPORTED
  - DEVICE_EXECUTOR_UPGRADE_REQUIRED
  - TransferFile
  - 路径规则
  - 安装脚本
  - executor-bootstrap
  - devices.allowPlaintextEnrollmentOnPrivateNetwork
  - pty.ready-stream.v1
  - session.durable.v1
  - session.exec.v1
  - executor_session_json
  - session.attach
status: draft
verified_at: 8d4bc063
---
# 设备与远程执行

让叙述者的文件与命令工具在另一台机器上执行：该机器运行 Go 写的 `remote-executor`，与服务端建立 WebSocket，服务端经 RPC 调它。设备记录在 `remote_devices` 表。

## 关键规则
- 两种连接方向（`remote_devices.connectionMode`）：`reverse`（默认，执行器拨入服务端 `/ws/device`）和 `direct`（服务端拨向 `directUrl`，断线按 2s 起翻倍、上限 60s 退避重拨，`device-connection-service.ts`）。两种方向共用同一套 RPC 逻辑（`DeviceTransport`）。
- 令牌：`rdev_` 加随机串，库里只存 SHA-256（`tokenHash`），明文只在创建或轮换时返回一次（`device-service.ts:generateDeviceToken`、`rotateDeviceToken`）。
- 握手：服务端与执行器各出 32 字节 nonce，互相发 HMAC 证明（key 由 tokenHash 派生，transcript 含 role），`device-auth.ts` 与 Go 侧共用格式；握手超时 10s；协议版本 `DEVICE_PROTOCOL_VERSION = 1`。`DeviceScopeError` 的码（`device-service.ts:DeviceScopeErrorCode`）：`DEVICE_SCOPE_FORBIDDEN`（`device-service.ts` 的授权检查：设备是别人私有的，或项目范围不匹配，403）；其余在 `terminal-service.ts` 创建远程终端时抛：`DEVICE_OFFLINE`（设备未连接）、`DEVICE_PTY_UNAVAILABLE`（能力未声明 `pty`）、`DEVICE_PLATFORM_UNSUPPORTED`（Windows 设备暂不支持交互终端）、`DEVICE_EXECUTOR_UPGRADE_REQUIRED`（缺 `pty.ready-stream.v1` 特性）。
- 可用性有两条轴：项目轴（`scope: global|project`，project 设备要求项目精确匹配）和用户轴（`ownerScope: private|shared`，private 只有创建者可用）（`isDeviceAuthorized`）。设备管理（改名、轮换、吊销）仅限管理员或创建者（`canManageDevice`）；列表接口对非管理员只返回自己注册的设备。
- RPC 方法集由 `rpc-types.ts:RpcMethod` 定义：`fs.*`、`glob`、`grep`、`exec.*`、`git.*`、`pty.*`、`session.*`、`editor.*`、`transfer.*`。执行器通过握手上报 features，服务端按 `deviceHasFeature` 判断某能力是否可用；只有 `pty.open` 和 `session.attach` 能以长连方式调用（`device-connection-service.ts:LONG_LIVED_RPC_METHODS`，不计超时和短 RPC 并发），单设备长连 RPC 上限 256。
- 持久会话（特性 `session.durable.v1`，执行器在支持 PTY 且未 `--disable-shell` 时声明，`cmd/narrafork-executor/main.go`）：会话管理器在执行器进程里只有一份，所有连接共用（`handlers.go:ConnectionScoped` 传同一个指针），会话不随请求或连接结束，只在 `session.kill` 或执行器退出（`Manager.Shutdown`）时结束。
  - `session.kill` 停止整个 PTY 会话（shell 是会话首进程，会话 ID 即其 pid）：Linux 扫 `/proc/<pid>/stat` 杀掉同一会话里的所有进程，包括交互 shell 为 `cmd &` 作业建的独立进程组（`session_kill_linux.go`）；其他 Unix 先给 shell 进程组发 SIGHUP（交互 shell 会转发给作业），500ms 后 SIGKILL 进程组（`session_kill_other.go`）。自行 `setsid` 的进程已离开终端，不处理。
  - `session.kill { release: true }`：退出记录下来时就把会话从登记表删掉，已退出的会话立即删掉，不会和单独的 `session.release` 竞争（`manager.go:Kill`）。
  - 输出日志的序号等于字节偏移，每会话保留最近 4 MiB；PTY 读线程只追加，不等待读者；读者落后到被淘汰时收到 `session.gap {from,to}`（`internal/session/journal.go`）。
  - `session.attach { since }` 依次发 `session.gap`（可选）、连续的 `session.data`、`session.exit {exitCode,endSeq}`；`since` 超过末尾报错；取消只脱离。
  - `session.write` 在每会话最近 256 个 `writeId` 内去重；会话总数上限 64，已退出的会话 24 小时后自动释放；进程退出后输出最多再排空 2 秒（`internal/session/manager.go:DefaultLimits`）。
  - Windows 不声明此特性（`session_windows.go` 只占位）。
  - `session.open { kind: "exec" }`（特性 `session.exec.v1`，与上面同时声明）：不带终端的命令，用登录 shell 的 `-c` 运行，stdout 和 stderr 写进同一个只有命令持有写端的管道，stdin 是 `/dev/null`（`session.write` 报错）；命令是新会话首进程（setsid），`session.kill` 直接 SIGKILL（Linux 杀整个会话，含换了进程组的子孙；其他 Unix 杀命令的进程组；不先发可被捕获的 SIGHUP，`killExecSession`）；`timeoutMs` 由执行器自己计时并停止命令，不论有没有人附着，并在退出结果（attach 结果与 `session.info`）里带 `timedOut: true`（`session_unix.go:startExecProcess`、`manager.go:DeadlineReporter`）。
  - `session.kill` 碰上还在启动（已占位、进程未起）的会话时不回 "session not found"，而是记下，进程一起来就停（带 `release` 时随后释放，`manager.go:Kill`/`Open`）。
- 远端后台 Bash 走执行器会话（设备同时声明 `session.durable.v1` 和 `session.exec.v1` 时，`device-remote-backend.ts:startBackgroundSession`；否则仍走随请求结束的 `exec.start`，其超时是 RPC 超时，默认 120 秒）：
  - 会话 ID 固定为 `nf-bash-<taskId>`；打开前先把 `{deviceId, sessionId, timeoutMs, startedAt}` 写进 `background_tasks.executor_session_json`（`background-task-service.ts:bindExecutorSession`），打开的回复丢失时**不重发**（执行器若中途重启，重发会把命令再跑一遍）：等设备回来用 `session.info` 对账，存在就接管，不存在就写清理记录并报"启动未确认"（`remote-session.ts:confirmExecOpen`）。
  - 句柄 `remote-session-exec.ts:RemoteSessionExecHandle` 复用 `terminal/remote-session.ts` 的续读（`onBytes` 原样交出字节）；断线只脱离，上线后从已读位置续读；缺口或会话丢失时 `outputIncomplete()` 为真，并在输出里写一行提示。
  - 停止与释放都经共享的持久清理记录（`executor-session-cleanup.ts`，与远程终端共用 `executor_session_cleanups`）：`kill()` 先写记录再停止读取，不等设备确认，但 `session.kill` 要等 open 有了结果才发；自然结束时由 `monitorBackgroundBash` 在任务终态写入成功后调用 `afterTerminalCommitted()` 才释放。
  - 超时以执行器为准：句柄有 `timedOut()` 时，`monitorBackgroundBash` 自己的计时延后 `EXECUTOR_DEADLINE_GRACE_MS`（30 秒）兜底，执行器报 `timedOut` 就按超时结束并保留输出；重启后接管已过期限的任务也先等执行器的结论，按时完成的仍算完成。
  - NarraFork 关机（包括不保留进程的 SIGTERM）只脱离：`registerShutdownDetach` 登记的任务在 `stopBashCollectors` 里调 `detachForShutdown()`、`BackgroundBashLifecycle.preserveTask`，不停止命令也不写终态，行保持 running，下次启动重新附着；显式 Stop 仍会停止。
  - 重启时 `recoverStaleTaskPages` 对带 `executor_session_json` 的 running bash 行（task 和 service 都算）重新附着（`recoverExecutorSessionTask`），从序号 0 重放执行器仍保留的输出，剩余超时按 `startedAt + timeoutMs` 计算；设备不在线也接管并等待；执行器已没有该会话时任务以失败结束并说明原因。
- 执行器二进制分发是来源绑定的：`server/lib/executor-binaries.ts` 取清单并校验，`helper-binaries.ts` / `helper-distribution-runtime.ts` 负责下载缓存（同一套也分发 ripgrep 等 CLI 辅助程序），`shared/helper-distribution.ts` 定义目录与组件版本，`shared/remote-executor-manifest.ts` 校验清单；Windows 二进制用 `shared/windows-pe.ts` 校验 PE 架构。
- 路径守卫规则：`remote_devices` 里存的是期望规则，真正的执行在执行器本机配置里，目的是服务端被攻破也不能扩大执行器权限（schema 注释；`PUT /:id/path-rules` 只是下发期望值）。
- 安装：`POST /api/devices/:id/install-script` 生成一次性短期 ticket 的安装命令（平台为 `linux/darwin/windows` × `amd64/arm64`，`shared/remote-executor.ts:EXECUTOR_PLATFORMS`；ticket 机制见「改它时」）；公开路由 `/api/executor/{install,download,enroll}/:platform` 凭 ticket 工作；`enroll` 兑换 ticket 时轮换设备密钥（旧密钥立即失效），并先检查传输是否安全再消耗 ticket（`executor-bootstrap.ts`）。传输检查三种结果（`executor-enrollment-policy.ts:evaluateEnrollmentTransport`）：https 或回环地址，放行；私网 http，仅当 `settings.devices.allowPlaintextEnrollmentOnPrivateNetwork` 为真才放行（默认 false）；公网 http，永远拒绝。
- 文件传输：控制面走 `transfer.*` RPC，数据面走二进制块帧，按偏移流式读写、写 `.part` 文件、可暂停/恢复/取消；任务持久化在 `device_transfer_tasks`，服务重启时进行中的任务被标记为暂停（`TRANSFER_RESTART_PAUSE_NOTICE`）。路由 `/:id/transfer-tasks*`。

## 从哪读起
- `server/services/device-connection-service.ts`：连接、握手、`sendRpc`。
- `server/services/device-remote-backend.ts`：把工具调用翻译成 RPC，经 `setRemoteBackendResolver` 接入 `lib/agent/execution/registry.ts`。
- `remote-executor/internal/rpc`、`internal/handlers`：Go 侧分发与各方法实现；`remote-executor/README.md` 是安装说明（线索，未逐条核实）。
- `server/routes/devices.ts`：管理 API。
- `server/lib/agent/tools/transfer-file.ts`：`TransferFile` 工具（可后台运行，重启后可恢复）；`transfer-progress.ts` 是进度与完成摘要的纯格式化；`server/lib/crc32c.ts` 与 Go 侧同一 CRC-32C 做分块校验。
- 前端：`frontend/routes/settings/devices.tsx`；`ExecutorInstallModal.tsx` + `executor-install-command.ts` 生成安装命令（默认基址取浏览器当前 origin，可改，`lib/device-install-url.ts`）；`DevicePathRulesEditor.tsx` 编辑路径规则（`shared/executor-path-rules.ts`：有序 allow/deny 目录前缀，最后一条匹配者生效）；`lib/device-config.ts`、`lib/api/devices.ts`。
- `server/lib/device-url.ts:isSecureDirectDeviceUrl`：direct 模式的 `directUrl` 只接受 `wss:`，或回环 IP 字面量（127.x / ::1）的 `ws:`（`device-service.ts` 创建时检查）；`executor-install-ca.ts` 处理安装脚本带的 CA 证书（只读公钥证书路径）。

## 改它时
- 改远端后台 Bash 的会话路径：`device-remote-backend.ts:startBackgroundSession`、`remote-session-exec.ts`、`bash.ts:monitorBackgroundBash` 的 `afterTerminalCommitted` 调用点、`background-task-service.ts:recoverExecutorSessionTask` 要一起看；测试 `services/__tests__/background-bash-executor-session.test.ts`、`terminal/remote-session.test.ts`、Go 侧 `session_exec_unix_test.go`。不变量：会话先绑定到任务行再打开；释放只发生在终态写入之后；停止意图先落库。
- 加一个 RPC 方法：`server/lib/agent/execution/rpc-types.ts:RpcMethod` + Go 侧 `remote-executor/internal/rpc`、`internal/handlers`；新能力要有 `features` 字符串并在服务端用 `deviceHasFeature` 门控，旧执行器才会得到 `DEVICE_EXECUTOR_UPGRADE_REQUIRED` 而不是直接失败（远程终端的 `pty.ready-stream.v1` 是例子，见 `terminal-service.ts`）。
- 改握手或 HMAC 转写格式：`device-auth.ts` 与 Go 侧必须同时改，并升 `DEVICE_PROTOCOL_VERSION`；`server/services/__tests__/device-connection-auth.test.ts`、`device-rpc-lifecycle.test.ts` 会拦。
- 改授权规则：`isDeviceAuthorized` / `canManageDevice`，对应测试 `device-authorization.test.ts`、`device-session-visibility.test.ts`、`routes/__tests__/device-non-admin-authorization.test.ts`。
- 改安装流程：`executor-bootstrap.ts`、`executor-bootstrap-ticket.ts`（ticket 有效 10 分钟、同时最多 200 张、`script`/`binary`/`token` 三种动作分别计次，`token` 只能兑换一次）、`executor-enrollment-policy.ts`；测试 `routes/__tests__/executor-bootstrap.test.ts`、`executor-enroll.test.ts`、`device-install-script-url.test.ts`、`server/lib/__tests__/executor-bootstrap-ticket.test.ts`、`executor-enrollment-policy.test.ts`、`executor-install-script.test.ts`、`tests/executor-bootstrap-e2e.test.ts`。
- 改文件传输：`transfer.*` RPC、`device-transfer-service.ts`、`device-transfer-task-store.ts`、`TransferFile` 工具与 CRC32C 要一起看；测试 `device-transfer-paths.test.ts`、`device-transfer-tasks.test.ts`、`tools/__tests__/transfer-progress.test.ts`。
- 不能破：令牌明文只在创建/轮换时返回一次（库里只有 SHA-256）；路径守卫的真正执行在执行器本机，服务端只下发期望值；安装时 `enroll` 先检查传输安全再消耗 ticket。Go 侧另有 `.github/workflows/remote-executor.yml` 跑执行器测试。

## 相关
- [远程访问](remote-access.md)：浏览器远程访问本服务，与本节点（服务端访问设备）方向相反。
