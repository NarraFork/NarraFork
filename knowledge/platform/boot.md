---
id: platform.boot
title: 启动与进程
summary: 入口、启动顺序、迁移、关闭；manager 进程与运行时。
anchors:
  - server/index.ts
  - server/main.ts
  - server/serve.ts
  - server/app.ts
  - server/manager/
  - server/lib/startup-status/
  - server/dev-all.ts
  - server/db/index.ts
  - frontend/components/SystemMaintenanceBadge.tsx
  - frontend/components/settings/RuntimeSection.tsx
  - frontend/components/settings/SystemShutdownCard.tsx
  - server/lib/db-reader-readiness.ts
  - server/lib/db-reader-startup.ts
  - server/lib/http-listener-rebind.ts
  - server/lib/logger.ts
  - server/lib/manager-control-server.ts
  - server/lib/open-frontend.ts
  - server/lib/platform.ts
  - server/lib/startup-readiness.ts
  - server/lib/windows-excluded-ports.ts
  - server/routes/dependencies.ts
  - server/routes/diagnostics.ts
  - server/routes/runtime.ts
  - server/services/dependency-service.ts
  - server/services/system-lifecycle-service.ts
  - shared/server-host.ts
  - shared/startup-status.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 启动与进程

后端是一个 Bun 进程，入口 `server/index.ts` 按命令行标志分流到不同角色；服务角色经 `serve.ts` 动态加载 `main.ts` 完成启动。

## 关键规则
- 入口先中和环境里的 HTTP(S)_PROXY、把管理器令牌吸入内存，再分流（`server/index.ts`）。离线 `changelists`、`narrafork://` 激活客户端、数据库完整性探测/快照构建子进程、文件变更审计、watcher、插件运行时等分支都在 `./main` 之前处理，否则会以读写方式打开数据库并占用实例锁（`server/index.ts` 各分支）。
- 是否进入图形化管理器：平台为 win32，无 `--serve`，且（有 `--manager` 或是编译产物）（`server/manager/launch-mode.ts:shouldRunManager`）。其余情况（含源码 `bun run dev`、管理器拉起的 `--serve` 子进程）走服务模式。管理器服务由 `manager/backend-process.ts` 作为子进程拉起并做健康轮询。
- 服务模式先 `waitForPreviousServerShutdown`（重启交接），失败则以启动问题退出，不在旧服务仍在时抢启动（`server/index.ts:runServer`）。
- `serve()` 先加载 settings，在配置地址上起「启动状态页」worker（迁移期间展示进度或失败原因），然后才 `import("./main")`；失败走 `exitWithStartupProblem`：写日志、在状态页展示、最多等 30 秒让页面读取，再 `exit(1)`（`server/serve.ts`、`lib/startup-status/index.ts:PROBLEM_LINGER_MS`）。
- 实例锁冲突（锁本身的判定见 [实例锁、完整性与重启恢复](instance-recovery.md)）时，仅「编译产物、非本地运行时、非管理器托管」才会探测 `/api/health` 并打开已在运行的实例，否则照常报冲突（`serve.ts:openRunning`、`isNarraForkHealth`）。
- `main.ts` 依赖 `./db` 的顶层 await：迁移、FTS 在首个查询前完成。PostgreSQL 后端须显式选择，失败即中止启动，不回退 SQLite（`server/db/index.ts` 文件头说明）。
- 端口：启动状态页在 `Bun.serve` 之前关闭；显式指定端口则绑定失败直接报错，否则最多重试 `MAX_PORT_RETRIES` 次顺延下一个端口，并跳过 Windows 保留段（`main.ts` 中 `startServerWithHostFallback` 附近的循环）。`maxRequestBodySize` 取导入上限 `MAX_IMPORT_BYTES`（Bun 只有一个全局上限）；普通请求另由 `http-dispatcher.ts:limitOrdinaryRequestBody` 限制到 `MAX_ORDINARY_BODY_BYTES`（128 MiB，`shared/storage-transfer.ts`）：
  - 声明的 `content-length` 超限：直接 413。
  - 未声明或偏小的长度：读流时累计，超限则让流报错。
  - 豁免：存储导入上传（`isStorageImportUpload`）；流式附件上传（`isStreamingAttachmentUpload`，在暂存层按实际字节执行 1 GiB 上限）；无正文方法 GET/HEAD/OPTIONS。
- 数据库完整性检查在端口绑定后后台执行，细节见 [实例锁、完整性与重启恢复](instance-recovery.md)。
- 关闭：SIGINT/SIGTERM/SIGHUP 与 `exit` 钩子在 `main.ts` 末尾注册，`hotOnce` 防热重载重复注册；`performGracefulShutdown` 先 `httpLifecycle.stopAccepting()`，再逐步停各生产者。干净关闭标记与锁释放见 [实例锁、完整性与重启恢复](instance-recovery.md)。

## 从哪读起
- `server/index.ts`：角色分流。
- `server/serve.ts`：状态页 + 加载 main + 启动失败处理。
- `server/main.ts`：监听、`initializeDatabaseStartup`、`performGracefulShutdown`。
- `server/dev-all.ts`：`bun run start` / `dev:all` 的父进程，只管理自己启动的子进程。
- `server/manager/main.ts`：Windows 管理器面板。

## 相关
- [实例锁、完整性与重启恢复](instance-recovery.md)
- [设置与数据目录](settings.md)
- [HTTP 路由与 WebSocket](http-ws.md)
- [Worker 隔离](workers.md)
