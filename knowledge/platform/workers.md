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
- 其他使用 `WorkerPool` 的地方：gen-ui 编译、git 行统计、大纲文本编辑、编辑器文档任务、前缀快照、历史重写、token 重算等（`grep WorkerPool server`）。
- 其他隔离形态：只读完整性探测与快照构建用独立子进程，在 `server/index.ts` 中于 `./main` 之前分流；启动状态页用 Worker 线程。

## 从哪读起
- `server/lib/worker-runtime/pool.ts`、`queue.ts`、`lifecycle.ts`：通用运行时。
- `server/db/worker-read.ts` 与 `server/lib/db-worker/pool.ts`：数据库读路径。
- `server/lib/fs-scan-worker/client.ts`：「失败即失败」的客户端范例及其测试。

## 相关
- [主线程性能规则](main-thread.md)
- [启动与进程](boot.md)
