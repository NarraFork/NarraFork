---
id: platform.boot
title: 启动与进程
summary: 入口、启动顺序、迁移、关闭；manager 进程与运行时。
anchors:
  - server/lib/runtime-target.ts
  - server/index.ts
  - server/main.ts
  - server/serve.ts
  - server/app.ts
  - server/manager/
  - server/lib/startup-status/
  - server/dev-all.ts
  - server/db/index.ts
  - server/lib/http-listener-rebind.ts
  - server/lib/logger.ts
  - server/lib/manager-control-server.ts
  - server/lib/open-frontend.ts
  - server/lib/platform.ts
  - server/lib/startup-readiness.ts
  - server/lib/windows-excluded-ports.ts
  - server/routes/dependencies.ts
  - server/services/dependency-service.ts
  - shared/server-host.ts
  - shared/startup-status.ts
  - server/lib/__tests__/startup-readiness.test.ts
  - server/lib/__tests__/http-listener-rebind.test.ts
  - server/lib/__tests__/manager-control-server.test.ts
keywords:
  - 启动状态页
  - 端口被占用
  - 管理器
  - manager
  - NARRAFORK_MANAGER_MANAGED
  - /api/health
  - /api/dependencies
  - 依赖检测
  - git rg dtach
  - server.log
  - NARRAFORK_LOG_LEVEL
  - openBrowser
  - startupReadiness
  - x-narrafork-starting
  - netsh excluded port
  - IS_WINDOWS
status: draft
verified_at: 2e6441ad0
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
- 启动就绪门 `createStartupReadinessGate`（`lib/startup-readiness.ts`）：端口先绑定，叙述者续接恢复在后台进行；状态 `recovering/ready/failed`，`barrier` 在恢复到达终态时解开且永不 reject。`/api/health` 把状态并入负载（`status`、`readiness`、失败时 `recoveryError`），恢复失败只标失败而保持请求面开放，让用户还能进设置修复坏提供商（`main.ts` 里 `markReady/markFailed/settle`）。数据库读 Worker 的就绪门另见 [Worker 隔离](workers.md)。
- 监听地址热重绑：`createManagerRebindCoordinator` 保证只有最新一次请求能在异步 DNS 之后提交；`rebindHttpListener` 同步摘掉旧监听器（不 await Bun 的 `stop()` Promise，因其依赖可能卡住的 WebSocket 计数），绑定失败回滚旧监听器，回滚也失败则抛错（`lib/http-listener-rebind.ts`、`lib/manager-control-server.ts`）。`preserveResponse` 时旧监听器延迟 200ms 才强停，让触发重绑的响应能发完。
- 管理器托管时（有管理器令牌且监听地址有回环伙伴），`startManagerListenerGroup` 在同端口的回环地址再绑一个控制监听器，只放行四个端点：`GET /api/update/check`、`POST /api/update/download`、`POST /api/update/apply`、`POST /api/system/lifecycle/signal`，其余一律 404，带 `upgrade` 头也 404，通过的请求还要校验管理器令牌与对端地址（401），没有会话回退、页面或 WebSocket；控制侧绑定失败会连同公共监听器一起停掉，不留半启动状态（`manager-control-server.ts`）。
- Windows 保留端口：启动时用带超时的 `netsh` 读取排除段（`lib/windows-excluded-ports.ts`），选端口时整段跳过而不是逐个探测；读取失败按「未知」放行。
- 自动打开浏览器 `openFrontendOnce(url)`（`lib/open-frontend.ts`）：管理器托管（`NARRAFORK_MANAGER_MANAGED=1`）的服务不打开；`server.openBrowser` 为 `off` 时只在用户显式请求时打开；同一地址每进程只开一次，换了地址（端口被占或局域网回落）会再开新地址；`app` 模式以应用窗口打开。
- 启动状态页的响应头 `x-narrafork-starting`、日志标记 `STARTUP_PAGE_LOG`（`shared/startup-status.ts`）：页面靠响应头消失知道服务已起来，Windows 管理器靠日志标记提前打开页面。
- 日志（`lib/logger.ts`）：写 `NARRAFORK_HOME/server.log`，JSON 行；`NARRAFORK_LOG_LEVEL` 选级别（默认 info），`NARRAFORK_LOG_MAX_BYTES`（默认 50 MiB）、`NARRAFORK_LOG_MAX_FILES`（默认 5）控制轮转。
- 平台标志集中在 `lib/platform.ts`（`IS_WINDOWS/IS_MACOS/IS_LINUX`、`IS_ANDROID`、`IS_PROOT`、`DEV_NULL`、`supportsDtach/supportsContainers`、`--wsl=` 标志），业务代码不要自己写 `process.platform` 判断。
- 依赖检测 `GET /api/dependencies` 刻意挂在会话认证之前（缺 git 时登录前也要能看到状态）；`POST /api/dependencies/:name/install` 仅管理员，名称只允许 `git`、`rg`、`dtach`；检测与按包管理器安装在 `services/dependency-service.ts`，缺 sudo 密码不算服务端故障（`routes/dependencies.ts`）。
- 数据库启动后段（`main.ts:initializeDatabaseStartup`）：恢复发现结束后，仅在 `automaticResumeEnabled()` 时先挂载叙述者续接恢复，再后台调用 `wakeQueuedTaskNoticeRecipientsOnStartup` 补唤醒收件箱里已入队、但唤醒丢失的任务通知（见 [收件箱与唤醒](../narrator/runtime/mailbox.md)）；失败只记警告。
- 数据库完整性检查在端口绑定后后台执行，细节见 [实例锁、完整性与重启恢复](instance-recovery.md)。
- 关闭：SIGINT/SIGTERM/SIGHUP 与 `exit` 钩子在 `main.ts` 末尾注册，`hotOnce` 防热重载重复注册；`performGracefulShutdown` 先 `httpLifecycle.stopAccepting()`，再逐步停各生产者。干净关闭标记与锁释放见 [实例锁、完整性与重启恢复](instance-recovery.md)。

## 从哪读起
- `server/index.ts`：角色分流。
- `server/serve.ts`：状态页 + 加载 main + 启动失败处理。
- `server/main.ts`：监听、`initializeDatabaseStartup`、`performGracefulShutdown`。
- `server/dev-all.ts`：`bun run start` / `dev:all` 的父进程，只管理自己启动的子进程。
- `server/manager/main.ts`：Windows 管理器面板。

## 改它时
- 新增启动前分流的子进程入口：在 `server/index.ts` 的 `./main` 之前加分支，否则会以读写方式打开数据库并占实例锁；`server/services/file-change-physical-audit.test.ts` 里有一份入口白名单正则，新增或改名入口要同步。
- 改监听/重绑逻辑：`http-listener-rebind.test.ts`、`manager-control-server.test.ts` 钉着回滚、最新请求胜出和控制监听器的拒绝规则。
- 改就绪门或健康负载：`startup-readiness.test.ts`；`/api/health` 的合并在 `http-dispatcher.ts`，两处要一起看。
- 新增依赖项：`dependency-service.ts` 的检测表与 `routes/dependencies.ts` 的名称白名单要同时改。

## 相关
- [实例锁、完整性与重启恢复](instance-recovery.md)
- [设置与数据目录](settings.md)
- [HTTP 路由与 WebSocket](http-ws.md)
- [Worker 隔离](workers.md)
- [出站网络与代理](network.md)：入口最先中和环境代理变量。
- [操作系统集成](os-integration.md)：关闭后钩子。
