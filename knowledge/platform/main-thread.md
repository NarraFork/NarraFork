---
id: platform.main-thread
title: 主线程性能规则
summary: SQLite、JSON、同步 IO 都在主线程；列表不读大字段、游标分页、子进程限流、WebSocket 节流。
anchors:
  - server/lib/validators/diagnostics.ts
  - server/lib/db-worker/
  - server/services/cpu-profiler.ts
  - server/db/connection.ts
  - server/lib/event-loop-monitor.ts
  - server/lib/spawn.ts
  - server/websocket/git-workspace-ws.ts
  - server/lib/read-fanout-diagnostics.ts
  - server/lib/read-file-capped.ts
  - server/lib/sql-trace.ts
  - server/routes/diagnostics.ts
  - server/lib/db-resilience.ts
  - server/lib/event-loop-monitor.test.ts
  - server/services/__tests__/cpu-profiler.test.ts
  - server/lib/read-fanout-diagnostics.test.ts
keywords:
  - 主线程阻塞
  - busy_timeout
  - withDbRetry
  - safeSpawn
  - DEFAULT_MAX_OUTPUT_BYTES
  - startEventLoopMonitor
  - /api/diagnostics/cpu-profile
  - NF_SQL_TRACE
  - sql:report
  - readFileCapped
  - 背压
  - getBufferedAmount
  - MAX_ORDINARY_BODY_BYTES
  - /api/storage/database/vacuum
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 主线程性能规则

HTTP/WS、`bun:sqlite`、JSON 序列化与同步 IO 共用一个 JS 线程，任何长同步工作都表现为全部请求无响应。这页记录代码里为此设下的约束和观测手段；规则来源之一是 CLAUDE.md，这里只列在实现中能看到的部分。

## 关键规则
- SQLite 锁等待很短：主库连接 `busy_timeout = 250`（毫秒），注释写明理由是同步执行会卡住整个服务；`SQLITE_BUSY` 由应用层 `withDbRetry` 异步退避处理（`server/db/connection.ts`；`withDbRetry` 在 `lib/db-resilience.ts`，默认共 3 次尝试、200ms 起指数退避，只重试锁冲突类错误）。若干辅助库更短（`git-changelist-store.ts` 与 `git-staging-worker.ts` 为 20ms，`tool-input-stream-source-worker.ts` 为 0）。
- 大范围读走 Worker：`readQuery` 把查询交给只读 Worker 池，并有行数/字节预算（`server/db/worker-read.ts`、`lib/db-worker/read-budget.ts`、`protocol.ts` 的 `SELECT_ROWS_MAX_*`），详见 [Worker 隔离](workers.md)。
- 完整性检查（`quick_check`/`integrity_check`）不在启动同步路径：由只读子进程在端口绑定后执行（`server/main.ts:initializeDatabaseStartup`、`db/integrity-probe-worker.ts`）。
- 子进程统一走 `safeSpawn`：默认输出上限 `DEFAULT_MAX_OUTPUT_BYTES`（10 MiB，stdout/stderr 可分别设预算），可设硬超时、看门狗和 AbortSignal，终止原因记录在 `terminationReason`（`server/lib/spawn.ts`）。
- WebSocket 背压：部分通道在 `getBufferedAmount()` 超阈值时关闭连接让客户端重连并重新快照，而不是继续堆积（`git-workspace-ws.ts` 256KiB、`outline-page-ws.ts`、`oauth-connection-registry.ts`，关闭码 1013）。叙述者流式输出的合并节流在 `narrator-ws.ts`，本页未逐项核实。
- 请求体：普通请求 128MiB 上限（见 [HTTP 路由与 WebSocket](http-ws.md)）。
- 观测：`startEventLoopMonitor` 每 50ms 采样延迟，滞后 ≥ 1s 时（30s 节流）记警告并附带当时在途请求；保留最近 256 个停顿区间（`lib/event-loop-monitor.ts`）。管理员可调用 `POST /api/diagnostics/cpu-profile` 抓 CPU profile（默认 15s、上限 30s，同一时刻仅一个，`services/cpu-profiler.ts`、`routes/diagnostics.ts`）。
- SQL 追踪：`NF_SQL_TRACE=summary|full` 时每条经 `instrumentSqliteConnection` 包装的语句按所属跨度（HTTP/WS/agent/tool/worker/job）计时，写 `~/.narrafork/sql-trace/*.ndjson`，不记录绑定参数，缓冲有上限、超限丢弃并计数；`bun run sql:report` 汇总；`dev-all.ts` 默认给后端设 `summary`（`lib/sql-trace.ts`、`app.ts` 的请求跨度）。
- 读 Worker 扇出观测：`readFanoutHttpMiddleware` 挂在 `/api/*` 上，仅在采集激活（`startReadFanoutCapture`，默认 30 秒）时按路由模板和 WS 消息类型归类读请求；不保留绑定参数和调用方标签，路径只取已注册的路由模板、不用真实 URL（`lib/read-fanout-diagnostics.ts`）。当前只有测试会调用 `startReadFanoutCapture`，生产路径没有触发入口（未找到路由或消息处理器调用它）。
- 有上限的文件读取：`readFileCapped(path, maxBytes)` 只分配并读取上限字节，按 UTF-8 边界截断不留替换字符，不存在返回 `null`（`lib/read-file-capped.ts`）；项目指令文件 `MAX_PROJECT_INSTRUCTIONS_BYTES = 200_000`，调用方有 `instruction-file-cache.ts` 和 `routes/fs.ts`。
- 管理员确认的 VACUUM 是受控维护窗口，走单独路由 `POST /api/storage/database/vacuum`（`routes/storage.ts`），不是普通 CRUD 路径。

## 从哪读起
- `server/db/connection.ts`：连接与 PRAGMA。
- `server/lib/spawn.ts`：子进程限流。
- `server/lib/event-loop-monitor.ts`、`server/services/cpu-profiler.ts`：诊断。

## 改它时
- 新增长耗时能力前先定输入/输出字节上限、超时、取消和分页方式（CLAUDE.md 的要求）；子进程一律走 `safeSpawn` 并设输出预算，不要自行收集完整 stdout 再截断（相关测试：`server/lib/spawn-stream.test.ts`、`spawn-kill.test.ts`）。
- 新增高频 WebSocket 输出：参照 `git-workspace-ws.ts` 的 `getBufferedAmount` 阈值 + 关闭码 1013 做背压，不要每个 chunk 广播累计字符串。
- 调整 SQLite 锁等待：`connection.ts` 的 `busy_timeout` 不要提到秒级，冲突用应用层 `withDbRetry`；注意辅助库各有自己的值。
- 改诊断入口：`diagnostics.test.ts`（路由）、`cpu-profiler.test.ts`、`event-loop-monitor.test.ts`；`/api/diagnostics/cpu-profile` 在 `http-dispatcher.ts` 里被特判为关闭 Bun 请求超时，路径变了要同步。
- Worker 失败不得回退主线程的守卫见 [Worker 隔离](workers.md)。

## 相关
- [Worker 隔离](workers.md)
- [启动与进程](boot.md)
