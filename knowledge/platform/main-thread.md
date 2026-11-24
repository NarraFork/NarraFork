---
id: platform.main-thread
title: 主线程性能规则
summary: SQLite、JSON、同步 IO 都在主线程；列表不读大字段、游标分页、子进程限流、WebSocket 节流。
anchors:
  - server/lib/db-worker/
  - server/services/cpu-profiler.ts
  - server/db/connection.ts
  - server/lib/event-loop-monitor.ts
  - server/lib/spawn.ts
  - server/websocket/git-workspace-ws.ts
  - server/lib/read-fanout-diagnostics.ts
  - server/lib/read-file-capped.ts
  - server/lib/sql-trace.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 主线程性能规则

HTTP/WS、`bun:sqlite`、JSON 序列化与同步 IO 共用一个 JS 线程，任何长同步工作都表现为全部请求无响应。这页记录代码里为此设下的约束和观测手段；规则来源之一是 CLAUDE.md，这里只列在实现中能看到的部分。

## 关键规则
- SQLite 锁等待很短：主库连接 `busy_timeout = 250`（毫秒），注释写明理由是同步执行会卡住整个服务；`SQLITE_BUSY` 由应用层 `withDbRetry` 异步退避处理（`server/db/connection.ts`）。若干辅助库更短（`git-changelist-store.ts` 与 `git-staging-worker.ts` 为 20ms，`tool-input-stream-source-worker.ts` 为 0）。
- 大范围读走 Worker：`readQuery` 把查询交给只读 Worker 池，并有行数/字节预算（`server/db/worker-read.ts`、`lib/db-worker/read-budget.ts`、`protocol.ts` 的 `SELECT_ROWS_MAX_*`），详见 [Worker 隔离](workers.md)。
- 完整性检查（`quick_check`/`integrity_check`）不在启动同步路径：由只读子进程在端口绑定后执行（`server/main.ts:initializeDatabaseStartup`、`db/integrity-probe-worker.ts`）。
- 子进程统一走 `safeSpawn`：默认输出上限 `DEFAULT_MAX_OUTPUT_BYTES`（10 MiB，stdout/stderr 可分别设预算），可设硬超时、看门狗和 AbortSignal，终止原因记录在 `terminationReason`（`server/lib/spawn.ts`）。
- WebSocket 背压：部分通道在 `getBufferedAmount()` 超阈值时关闭连接让客户端重连并重新快照，而不是继续堆积（`git-workspace-ws.ts` 256KiB、`outline-page-ws.ts`、`oauth-connection-registry.ts`，关闭码 1013）。叙述者流式输出的合并节流在 `narrator-ws.ts`，本页未逐项核实。
- 请求体：普通请求 128MiB 上限（见 [HTTP 路由与 WebSocket](http-ws.md)）。
- 观测：`startEventLoopMonitor` 每 50ms 采样延迟，滞后 ≥ 1s 时（30s 节流）记警告并附带当时在途请求；保留最近 256 个停顿区间（`lib/event-loop-monitor.ts`）。管理员可调用 `POST /api/diagnostics/cpu-profile` 抓 CPU profile（默认 15s、上限 30s，同一时刻仅一个，`services/cpu-profiler.ts`、`routes/diagnostics.ts`）。
- 管理员确认的 VACUUM 是受控维护窗口，走单独路由 `POST /api/storage/database/vacuum`（`routes/storage.ts`），不是普通 CRUD 路径。

## 从哪读起
- `server/db/connection.ts`：连接与 PRAGMA。
- `server/lib/spawn.ts`：子进程限流。
- `server/lib/event-loop-monitor.ts`、`server/services/cpu-profiler.ts`：诊断。

## 相关
- [Worker 隔离](workers.md)
- [启动与进程](boot.md)
