---
id: platform.workers
title: Worker 隔离
summary: 哪些工作放 Worker/子进程，Worker 故障时不得回退主线程的规则。
anchors:
  - server/lib/worker-runtime/
  - server/lib/db-worker/
  - server/lib/fs-scan-worker/
  - server/db/worker-read.ts
  - server/lib/fs-scan-worker/__tests__/client-failures.test.ts
  - server/db/worker-read-adapter.ts
  - server/lib/compiled-worker.ts
  - server/lib/db-reader-readiness.ts
  - server/lib/db-reader-startup.ts
  - server/lib/compiled-worker.guard.test.ts
  - tests/worker-main-thread-fallback.guard.test.ts
  - server/lib/__tests__/db-reader-readiness.test.ts
  - server/lib/__tests__/db-reader-startup.test.ts
keywords:
  - WorkerPool
  - WorkerHandle
  - TaskQueue
  - TASK_QUEUE_FULL
  - WorkersUnavailableError
  - DB_READ_UNSUPPORTED
  - DB_READERS_UNAVAILABLE
  - DB_READERS_TIMEOUT
  - DATABASE_READ_UNAVAILABLE
  - NARRAFORK_DB_WORKER
  - NARRAFORK_DB_WORKER_CONCURRENCY
  - readQuery
  - FsScanWorkerUnavailableError
  - COMPILED_WORKER_ENTRIES
  - inlineFallback
  - Worker 隔离不可降级
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# Worker 隔离

重活（数据库读、目录扫描、编译、diff 等）交给 Worker 线程或子进程；任务一旦交给 Worker，Worker 出故障时任务失败，不会回到主线程重跑。

## 关键规则
- 共享运行时 `server/lib/worker-runtime/`：`WorkerHandle` 管资源所有权，`close()` 幂等，成功关闭意味着真正观察到退出（`lifecycle.ts`）；`TaskQueue` 做有界准入（总数/字节/每键配额，`short`/`normal` 两类），队列满、超时、关闭分别以 `TASK_QUEUE_FULL/TIMEOUT/CLOSED` 拒绝（`queue.ts`）；`WorkerPool` 在队列之上做 Worker 复用（默认空闲 60 秒）、取消与耗时统计（`pool.ts`）。
- 数据库读：`readQuery`（`server/db/worker-read.ts`）把 Drizzle 查询交给 `lib/db-worker/` 的只读池执行。注释与实现一致：任务派发之后失败就向上抛，不会在主连接上重跑同一查询。
- 派发前才判断「兼容」：内存库、事务内（需要看到未提交数据）等来源在 `executionPolicy: "compatible"` 下仍用主连接；`"worker-required"` 遇到这些来源直接抛 `DB_READ_UNSUPPORTED`（`worker-read.ts:inlineReason/requireSupported`）。需要隔离的调用点应使用 `worker-required`，如 `http-dispatcher.ts` 的 WS 升级读用户。
- Worker 池被禁用（`NARRAFORK_DB_WORKER=off`、并发为 0、池正在关闭/升级）时 `workersDisabled` 给出原因，调用方得到 `WorkersUnavailableError`；多个服务用它拒绝而非本地执行（如 `services/narrator-messages.ts`、`tool-edit-preview.ts`）。默认并发为 CPU 数夹在 2–4，可由 `NARRAFORK_DB_WORKER_CONCURRENCY` 覆盖（`db-worker/pool.ts:getConfiguredConcurrency`）。
- 目录扫描：`lib/fs-scan-worker/client.ts` 并发 4、就绪超时 5 秒、总超时 15 分钟；Worker 不可用时抛 `FsScanWorkerUnavailableError` 并进入 5 秒冷却，冷却内的请求同样失败，绝不在服务线程遍历目录。编译产物会依次尝试候选入口，但已派发的扫描不会换入口重放。测试 `client-failures.test.ts` 覆盖创建失败、运行失败、冷却、取消、队列满。
- 读 Worker 就绪门（`lib/db-reader-readiness.ts`）：认证读只走短读 Worker 池、不回主线程，所以启动时探测池一次（超时 30 秒，失败码 `DB_READERS_UNAVAILABLE`/`DB_READERS_TIMEOUT`）；之后 `requiresDatabaseReaders` 判定的路径（`/api`、`/ws`，但 `/api/health`、`/api/gracefully_shutdown` 和少数只读的品牌/许可证 GET 除外）在池不可用时返回 503 `DATABASE_READ_UNAVAILABLE` + `Retry-After: 5`，而不是让每个请求各自失败；PostgreSQL 后端恒为 `not-required`（`http-dispatcher.ts`）。`createDatabaseReaderStartup`（`db-reader-startup.ts`）在就绪前每 5 秒重试，就绪后才执行 `initialize`（`main.ts` 把数据库启动任务挂在它上面）。
- `/api/health` 带出 `databaseReaders` 状态，读者不可用时返回 503 且 `status: "not_ready"`，所以监控能区分“进程活着”和“读池坏了”（`http-dispatcher.ts`）。
- 编译产物里的 Worker：入口必须登记在 `COMPILED_WORKER_ENTRIES`（相对 `server/`，当前 22 个），构建脚本展开它作为额外入口；`new Worker` 的路径不会被打包器跟踪，漏登记就进不了二进制。`compiledWorkerSpecifiers` 依次尝试 `./<路径>.js`、`./server/<路径>.js`、`./<文件名>.js`，源码运行只有相对 `import.meta.url` 的一个候选；Windows 的 `~BUN` 虚拟根要用正斜杠字符串而不是 URL（`lib/compiled-worker.ts`）。
- 守卫测试 `tests/worker-main-thread-fallback.guard.test.ts` 用 AST 扫描 `server/frontend/shared/scripts` 等目录（跳过测试文件）：已退役的 `inlineFallback` 等标识不得回到生产代码；Worker 客户端不得 import 或调用重活实现；ORM Worker 错误路径不得执行原查询；大纲 Worker 的 catch 里不得调用 `inlineValues`；脑图冷缓存只用占位而不在 UI 线程测量；Monaco 在暴露编辑器服务前装上严格失败边界；并检查 CLAUDE.md 里该规则的措辞仍在。
- 其他使用 `WorkerPool` 的地方：gen-ui 编译、git 行统计、大纲文本编辑、编辑器文档任务、前缀快照、历史重写、token 重算等（`grep WorkerPool server`）。
- 其他隔离形态：只读完整性探测与快照构建用独立子进程，在 `server/index.ts` 中于 `./main` 之前分流；启动状态页用 Worker 线程。

## 从哪读起
- `server/lib/worker-runtime/pool.ts`、`queue.ts`、`lifecycle.ts`：通用运行时。
- `server/db/worker-read.ts` 与 `server/lib/db-worker/pool.ts`：数据库读路径。
- `server/lib/fs-scan-worker/client.ts`：「失败即失败」的客户端范例及其测试。

## 改它时
- 新增 Worker：入口文件登记进 `COMPILED_WORKER_ENTRIES`，spawn 走 `compiledWorkerSpecifiers` 与 `WorkerHandle`（原生构造器只允许在 Handle 内）；`server/lib/compiled-worker.guard.test.ts` 钉着条目数（`toHaveLength(22)`，增删要同步）、条目文件存在、构建脚本展开注册表、不得在别处直接构造 Worker。
- 新增 Worker 客户端：失败要明确抛错或进入冷却，不得在 catch 里调用原任务实现；`tests/worker-main-thread-fallback.guard.test.ts` 会扫描并拦下退役的回退标识；还要像 `fs-scan-worker/__tests__/client-failures.test.ts` 那样补创建/运行/超时/禁用的故障注入测试，并断言原任务没在主线程跑（CLAUDE.md 要求）。
- 新增数据库读任务：走 `readQuery` 或 `lib/db-worker/` 的域任务注册；需要隔离的调用点传 `executionPolicy: "worker-required"`；不要在 `worker-read-adapter.ts` 之外碰 Drizzle 私有字段。
- 改读池就绪逻辑：`db-reader-readiness.test.ts`、`db-reader-startup.test.ts`；`requiresDatabaseReaders` 的放行名单变动要同步 `http-dispatcher.ts` 的行为。

## 相关
- [主线程性能规则](main-thread.md)
- [启动与进程](boot.md)
- [HTTP 路由与 WebSocket](http-ws.md)：读池不可用时的 503。
