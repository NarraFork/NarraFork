---
id: platform.terminal
title: 终端运行时
summary: PTY 抽象（Bun.Terminal / bun-pty）、dtach、终端生命周期。
anchors:
  - server/services/terminal-view-service.ts
  - server/terminal/
  - server/routes/terminals.ts
  - server/services/terminal-service.ts
  - server/websocket/terminal-ws.ts
  - frontend/hooks/useTerminals.ts
  - server/services/narrator-ui-summary.ts
  - frontend/hooks/useNarratorUiSummary.ts
  - frontend/lib/api/terminals.ts
  - frontend/routes/admin/terminals.tsx
  - frontend/routes/settings/terminals.tsx
  - server/lib/validators/terminals.ts
  - server/services/__tests__/terminal-startup-recovery.test.ts
  - server/websocket/__tests__/terminal-session-revalidation.test.ts
  - server/services/__tests__/terminal-executor-session.test.ts
keywords:
  - 终端
  - /ws/terminal
  - /api/terminals
  - TerminalRuntime
  - Bun.Terminal
  - bun-pty
  - dtach
  - BufferManager
  - scrollback
  - recoverOnStartup
  - shutdownAll
  - terminalWsMessageSchema
  - pty.ready-stream.v1
  - session.durable.v1
  - executor_session_id
  - executor_session_cleanups
  - streamSeq
  - 孤儿终端
  - /api/admin/terminals
status: draft
verified_at: 2c639f086aef21d60357f1e002e62767938833e8
---
# 终端运行时

交互式终端：服务端持有 PTY，经 `/ws/terminal` 与浏览器双向传输，滚动缓冲落盘，可在 dtach 下跨服务重启存活。

## 关键规则
- 统一接口 `TerminalRuntime`（`write/resize/close/kill/pid/exited/ready?`），`terminal-service` 不直接碰平台 PTY API（`server/terminal/runtime.ts`）。
- 创建时的后端选择顺序（`services/terminal-service.ts` 创建函数）：带 `deviceId` 走远程设备（需设备支持 `pty.ready-stream.v1`，先完成全部授权/能力检查再产生副作用）——设备还声明 `session.durable.v1` 时走执行器会话（`remote-session.ts:spawnRemoteSession`），否则走旧的 `pty.open`（`runtime-remote.ts`）；否则本机装有 dtach 就走 dtach；否则直连——win32 用 `bun-pty`（`runtime-pty.ts:spawnPortablePty`），Unix 用 `Bun.Terminal`（`runtime-bun.ts`），`Bun.Terminal` 创建失败时回退到 `bun-pty`。
- 执行器会话终端：会话 ID 固定为 `nf-term-<终端id>`（`remote-session.ts:terminalSessionId`），存进 `terminals.executor_session_id`（旧 `pty.open` 远程终端和本地终端为 NULL）。shell 属于执行器进程，不随连接或 NarraFork 进程结束：
  - 设备断线（`DeviceOfflineError` / `DeviceConnectionChangedError`）时运行时等 `device:status` 上线事件，再以已消费的字节数 `session.attach { since }` 续读；其他错误（会话不存在、执行器缺特性、序号越界）和 `device:revoked` 结束终端。
  - 输入按顺序逐条发送，每条带固定 `writeId`，断线重发由执行器去重；设备不在时排队，上限 1 MiB，超出的输入丢弃并记警告。
  - 停止和释放执行器会话不是运行时的事（运行时的 `kill()` 只停止读取），由 `terminal-service` 从持久记录做：终端关闭（`kill`）时在拆除缓冲、标记已退出之前，shell 自然退出（`monitorShellExit`）时在最终缓冲和退出码落盘之后，往 `executor_session_cleanups`（`device_id`+`session_id`）写一行，再发 `session.kill { release: true }`；执行器确认或回复 "session not found" 才删这行，其他错误（离线、断线、缺特性）保留。每次 `device:status` 上线按设备分页（每页 100）重试。这张表与终端行无关，删终端行、重启、设备离线都不会丢掉停止。
  - 新建时 `session.open` 的回复因断线丢失：等设备回来（最多 15 秒）重发，执行器回 "already exists" 就接管；仍不确定时创建失败并写清理记录（`RemoteSessionOpenUnknownError`）。
  - 执行器报告的缺口（`session.gap`）：先调 `interruptTextWatchesForGap`，期间这个终端后续输出（含缺口提示）暂存在 `heldOutput`，所以提示和缺口后的输出不会参与缺口前的匹配；然后在终端里显示一行"N bytes of output were not retained"，不静默跳过。暂存期间 shell 退出时，`monitorShellExit` 先等暂存输出写回缓冲（`drainHeldOutput`）再落盘；`kill` 删除缓冲时丢弃暂存。
- `BufferManager.append(data, streamSeq?)`：带编号的来源（执行器会话）在 xterm 解析完一批后记下位置，落盘快照写 `streamSeq`，`loadFromDisk` 读回为 `restoredStreamSeq`；不带编号的来源不写这个字段（`buffer-manager.ts`）。
- dtach 仅限非 Windows：`dtachService.isAvailable()` 在 win32 恒为 false，其余平台用 `which dtach` 检测并缓存（`terminal/dtach-service.ts`）。dtach 会话以 `terminal-<id>.sock` 存放；服务端只持有 attach 进程。
- 关闭服务时（`shutdownAll`）：dtach 终端保存缓冲、关闭 attach 进程但不杀会话，数据库状态保持 `running`；执行器会话终端保存带 `streamSeq` 的缓冲、停止读取但不杀会话，状态同样保持 `running`；直连终端和旧 `pty.open` 远程终端被杀并标记已退出（退出码 -1）。启动时 `recoverOnStartup`：
  - 有 `deviceId` 且有 `executor_session_id` 的 `running` 行：从快照的 `restoredStreamSeq` 续读（`resumeExecutorSession`）；快照没有这个字段时丢弃快照、从 0 重放设备保留的输出；设备不在线也照样恢复为已附着，等设备上线。
  - 其余行按 dtach 处理：探测 socket 并重新 attach，探测失败则保留状态而不是删除；没有 dtach socket 的（含旧 `pty.open` 远程终端）标记已退出（`terminal-service.ts`、`dtach-recovery-probe.ts`）。`terminalService.whenStartupRecoverySettled()` 在最近一次启动恢复结束（成败皆算，无恢复则立即）后 resolve；`watch-service.ts` 靠它在 dtach 恢复完成后再重新挂接终端 Watch。
- 因此「生命周期绑定服务器进程」只对直连终端和旧 `pty.open` 远程终端成立；dtach 终端和执行器会话终端可存活于重启。
- 滚动缓冲由 `BufferManager` 维护（默认 80x24、scrollback 5000 行），周期性落盘，订阅时以 `scrollback` 消息回放，并有读取游标/布局快照的数量与字节上限（`terminal/buffer-manager.ts` 顶部常量如 `MAX_BUFFER_READ_CURSORS`、`MAX_LAYOUT_SNAPSHOT_BYTES`）。
- WebSocket 协议：客户端 `subscribe/unsubscribe/input/resize/create/kill/rename`，服务端 `output/exit/error/scrollback/bufferState/created/killed/renamed`，消息体经 `terminalWsMessageSchema` 校验，订阅和创建都要通过 `terminal-access` 的权限判断（`websocket/terminal-ws.ts`）。
- 谁能使用某个终端（跟随叙述者 ACL、独立终端只属创建者与管理员）由 `terminal-access.ts` 判断，规则见 [访问控制](../security/acl.md)。
- 终端的 REST 管理在 `routes/terminals.ts`（列表、树、创建、改名、删除、进程列表、视图状态）。
- 用户终端的 shell 环境会恢复被 NarraFork 清空的环境代理变量（`envWithAmbientProxy`）。

- 前端：`useCanOpenTerminals` 复用会话 ui-summary 的 `canWrite`，不为首屏额外读 `/access`；未知/失败不允许打开。`useNarratorTerminals` 只有真实可见、document 可见且写权限已知为 true 才拉实体，key 包含 narrator/user/token，AbortSignal 贯通（单次 512 KiB，30 秒 stale/60 秒 GC）；`useTreeTerminals` 仍为详情树按需读取。ui-summary 与 WS `terminal_count_changed`、普通终端实体列表统一排除 `worktreeResourceId` 非空的资源终端。管理员页 `/settings/terminals`（`routes/settings/terminals.tsx`）管理全部终端与孤儿 dtach socket（`/api/admin/terminals/*`：列表、终止、批量终止、`kill-orphan`、`reattach-orphan`），`/admin/terminals` 只是重定向到它。

## 从哪读起
- `server/services/terminal-service.ts`：创建、恢复、关闭、清理。
- `server/terminal/runtime*.ts`、`remote-session.ts`、`dtach-service.ts`：各后端。
- `server/websocket/terminal-ws.ts`：浏览器通道。

## 改它时
- 新增 WS 消息类型：`validators/websocket.ts` 的 `terminalWsMessageSchema`、`websocket/terminal-ws.ts` 的分派、前端终端组件；`terminal-session-revalidation.test.ts` 钉着会话变化后连接的复核。
- 新增 PTY 后端：实现 `TerminalRuntime`，并在 `terminal-service.ts` 的创建顺序里决定位置；远程设备要先过授权/能力检查再有副作用（`runtime-remote.test.ts`）。
- 改 dtach 恢复或关闭语义：`dtach-recovery-probe.test.ts`、`services/__tests__/terminal-startup-recovery.test.ts`；不变量：dtach 终端关闭服务时不杀会话、DB 状态保持 `running`，恢复探测失败保留状态而不是删除。
- 改缓冲：`buffer-manager.test.ts`；订阅回放的读取游标和布局快照有数量/字节上限，别去掉。`streamSeq` 只能记 xterm 已解析的位置，否则重启续读会重复或漏掉输出。
- 改执行器会话终端：`remote-session.test.ts`（断线续读、输入只执行一次、缺口先于提示、打开回复丢失后接管）、`terminal-executor-session.test.ts`（启动续读、关闭只脱离、离线停止的持久化与重试、退出先落盘再释放、缺口暂存输出在退出前写回、关闭先记停止再标记退出、创建分支）；不变量：执行器会话只在本地最终状态落盘后才释放，清理记录只在执行器确认后删除。协议两端要和 `remote-executor/internal/session/` 一致，见 [设备与远程执行](../remote/devices.md)。
- 新增终端 REST 路由要经 `terminal-access.ts` 判断权限，不要只看登录。

## 相关
- [访问控制](../security/acl.md)：终端访问控制。
- [HTTP 路由与 WebSocket](http-ws.md)
- [启动与进程](boot.md)
