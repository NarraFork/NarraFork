---
id: platform.terminal
title: 终端运行时
summary: PTY 抽象（Bun.Terminal / bun-pty）、dtach、终端生命周期。
anchors:
  - server/terminal/
  - server/routes/terminals.ts
  - server/services/terminal-service.ts
  - server/websocket/terminal-ws.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 终端运行时

交互式终端：服务端持有 PTY，经 `/ws/terminal` 与浏览器双向传输，滚动缓冲落盘，可在 dtach 下跨服务重启存活。

## 关键规则
- 统一接口 `TerminalRuntime`（`write/resize/close/kill/pid/exited/ready?`），`terminal-service` 不直接碰平台 PTY API（`server/terminal/runtime.ts`）。
- 创建时的后端选择顺序（`services/terminal-service.ts` 创建函数）：带 `deviceId` 走远程设备 PTY（`runtime-remote.ts`，需设备支持 `pty.ready-stream.v1`，先完成全部授权/能力检查再产生副作用）；否则本机装有 dtach 就走 dtach；否则直连——win32 用 `bun-pty`（`runtime-pty.ts:spawnPortablePty`），Unix 用 `Bun.Terminal`（`runtime-bun.ts`），`Bun.Terminal` 创建失败时回退到 `bun-pty`。
- dtach 仅限非 Windows：`dtachService.isAvailable()` 在 win32 恒为 false，其余平台用 `which dtach` 检测并缓存（`terminal/dtach-service.ts`）。dtach 会话以 `terminal-<id>.sock` 存放；服务端只持有 attach 进程。
- 关闭服务时（`shutdownAll`）：dtach 终端保存缓冲、关闭 attach 进程但不杀会话，数据库状态保持 `running`；直连终端被杀并标记已退出（退出码 -1）。启动时 `recoverOnStartup` 对 `running` 的 dtach 终端探测 socket 并重新 attach，探测失败则保留状态而不是删除（`terminal-service.ts`、`dtach-recovery-probe.ts`）。
- 因此「生命周期绑定服务器进程」只对直连/远程终端成立；dtach 终端可存活于重启。
- 滚动缓冲由 `BufferManager` 维护（默认 80x24、scrollback 5000 行），周期性落盘，订阅时以 `scrollback` 消息回放，并有读取游标/布局快照的数量与字节上限（`terminal/buffer-manager.ts` 顶部常量如 `MAX_BUFFER_READ_CURSORS`、`MAX_LAYOUT_SNAPSHOT_BYTES`）。
- WebSocket 协议：客户端 `subscribe/unsubscribe/input/resize/create/kill/rename`，服务端 `output/exit/error/scrollback/bufferState/created/killed/renamed`，消息体经 `terminalWsMessageSchema` 校验，订阅和创建都要通过 `terminal-access` 的权限判断（`websocket/terminal-ws.ts`）。
- 谁能使用某个终端（跟随叙述者 ACL、独立终端只属创建者与管理员）由 `terminal-access.ts` 判断，规则见 [访问控制](../security/acl.md)。
- 终端的 REST 管理在 `routes/terminals.ts`（列表、树、创建、改名、删除、进程列表、视图状态）。
- 用户终端的 shell 环境会恢复被 NarraFork 清空的环境代理变量（`envWithAmbientProxy`）。

## 从哪读起
- `server/services/terminal-service.ts`：创建、恢复、关闭、清理。
- `server/terminal/runtime*.ts`、`dtach-service.ts`：各后端。
- `server/websocket/terminal-ws.ts`：浏览器通道。

## 相关
- [访问控制](../security/acl.md)：终端访问控制。
- [HTTP 路由与 WebSocket](http-ws.md)
- [启动与进程](boot.md)
