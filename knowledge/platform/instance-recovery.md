---
id: platform.instance-recovery
title: 实例锁、完整性与重启恢复
summary: 单实例锁、正常关闭标记、SQLite 完整性检查与修复、进程重启和更新后的恢复。
anchors:
  - server/services/recovery-observation.ts
  - server/services/recovery-handoff.ts
  - server/services/tool-continuation-service.ts
  - server/lib/windows-process-identity.ts
  - server/lib/instance-lock.ts
  - server/db/backend/sqlite-lifecycle.ts
  - server/db/integrity-check.ts
  - server/db/integrity-state.ts
  - server/services/restart-recovery-service.ts
  - server/services/update-recovery-service.ts
  - server/services/update-coordinator.ts
  - tests/server/lib/instance-lock.test.ts
  - server/db/backend/__tests__/sqlite-lifecycle.test.ts
  - frontend/components/StartupRecoveryAlert.tsx
  - frontend/hooks/useSystemLifecycleStatus.ts
  - frontend/lib/api/system-lifecycle.ts
  - server/db/integrity-probe-worker.ts
  - server/db/integrity-protocol.ts
  - server/lib/db-resilience.ts
  - server/lib/instance-process-identity.ts
  - server/lib/replacement-launch.ts
  - server/lib/restart-handoff.ts
  - server/lib/server-restart.ts
  - server/lib/shutdown-activity.ts
  - server/lib/system-lifecycle.ts
  - server/lib/windows-replacement-process.ts
  - server/routes/system-lifecycle.ts
  - server/services/system-lifecycle-service.ts
  - frontend/components/SystemMaintenanceBadge.tsx
  - frontend/components/settings/SystemShutdownCard.tsx
  - server/lib/__tests__/restart-handoff.test.ts
  - server/lib/__tests__/replacement-lifecycle.test.ts
  - server/lib/__tests__/replacement-launch.test.ts
  - server/lib/__tests__/server-restart.test.ts
  - server/lib/__tests__/windows-replacement-process.test.ts
  - server/services/__tests__/restart-recovery-service.test.ts
  - server/services/__tests__/update-recovery-service.test.ts
keywords:
  - narrafork.lock
  - InstanceLockedError
  - NARRAFORK_ALLOW_MULTIPLE
  - NARRAFORK_FORCE_UNLOCK
  - NARRAFORK_DB_INTEGRITY_CHECK
  - restart-recovery.json
  - db-integrity-state.json
  - fts-repair.json
  - planned-update-recovery.json
  - --no-auto-resume
  - 系统维护
  - 准备关机
  - /api/system/lifecycle
  - system_prepared_shutdown
  - NARRAFORK_GRACEFUL_RESTART_URL
  - 更新交接
  - 异常关闭
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 实例锁、完整性与重启恢复

进程起来时先抢数据目录的锁、判断上次是不是正常关闭、必要时修库；起来之后再把被打断的叙述者接着跑。

## 关键规则
- 单实例锁：`narrafork.lock` 在数据库同目录，文件存在即占用；只有**确证**持有者仍存活且是同一进程才拒绝启动，其余（进程不存在、pid 被复用、启动时间不符、跨重启、僵尸、无法判定）一律当作陈旧锁清掉（`instance-lock.ts:classifyLockHolder`、`acquireInstanceLock`）。无法判定时清锁但记 error 日志。
- 身份依据是 `(bootId, pid, 内核进程启动时刻)`，不是裸 pid；非 Linux 的 bootId 由 `Date.now()-uptime()` 推出，比较带 600s 容差（`bootSessionsDiffer`）。同 pid 同 boot 视为自己（热重载复用）。
- 环境变量 `NARRAFORK_ALLOW_MULTIPLE=1` 跳过加锁，`NARRAFORK_FORCE_UNLOCK=1` 强制接管存活持有者；冲突时抛 `InstanceLockedError`。释放只删 token 与 pid 都匹配的锁文件，进程 `exit` 时也会释放。
- 「维护权」比启动更严：`getInstanceMaintenanceAuthority` 只在锁是全新获得（或已验证接管）且 token 仍属本进程时允许，覆盖变量、未验证复用、清锁后获得一律拒绝；冷启动接管续接记录前由 `tool-continuation-service.ts:assertColdInstanceAuthority` 检查。
- 正常关闭标记：`finishCleanly` 把 SQLite `application_id` 写成 `NFRC` 标记（`fts.ts:markCleanShutdown`），下次启动 `consumeCleanShutdownState` 读出后立即清零，所以启动途中崩溃下次仍算非正常。非正常关闭会让 `ensureFts` 重建全文索引（热重载除外）。`abandonWithoutCleanMarker` 只释放锁。
- 启动不扫描库：`sqlite-lifecycle.ts:start` 只读修复标记文件。完整性检查在端口绑定后由 `scheduleBackgroundIntegrityCheck` 延迟 30s 起只读子进程（上次干净关闭、热重载、已有待修复标记时跳过；`NARRAFORK_DB_INTEGRITY_CHECK=off|full|always`），默认 quick，超时 10 分钟，输出上限 256KB，超限视为 `unavailable` 而非 ok（`integrity-check.ts`，仅 SQLite 后端）。
- 检查结果落盘而非当场修：仅 FTS 索引损坏写 `fts-repair.json`，下次启动重建；库损坏写 `db-integrity-state.json`（`pending`），重复发现不重置次数。下次启动 `runPendingRepair` 先记一次尝试再执行：WAL checkpoint，不行则 `sqlite3 .recover`；上限 `MAX_AUTOMATIC_REPAIR_ATTEMPTS = 2`，用尽转 `manual` 并照常启动；后续通过的检查会清除旧标记（`integrity-state.ts`）。
- 普通重启：收到信号时 `prepareSignalRestartRecovery` 把仍在 `working/waiting` 的叙述者写入 `restart-recovery.json`（≤1000 目标、≤256KB，原子换名）；下次启动 `prepareOrdinaryRestartRecovery` 读它并按工具状态落成续接记录：已开始执行或有文件变更操作的工具直接标失败并说明结果未知、不重试（`restartToolDisposition`），待审批的保留为待审批。带 `--no-auto-resume` 时只保护事实，用户点“继续”才恢复（`manuallyResumeRestartRecovery`）。
- 更新后恢复：`update-recovery-service.ts` 读取 `updates/planned-update-recovery.json`；`classifyRecoveryManifestOwnership` 判定清单仅为证据、本进程不是接班进程或交接标记不匹配时就丢弃清单，避免每次启动重放。恢复项带 5 分钟租约、30 秒续租；非幂等的延迟工具/待审批工具租约过期后标为「执行结果未知」，不重跑。
- 系统准备关机/维护（`lib/system-lifecycle.ts`，由 `services/system-lifecycle-service.ts` 接上更新协调器）：阶段 `idle → preparing → prepared → shutting_down`，失败为 `failed`。`prepare` 先经更新协调器排一个 `system_shutdown` 更新并关闭工具准入，等后台 bash 与普通工具排空，再把恢复快照写成 `resumeOnNextStartup: true`；`shutdown` = 准备完成后以原因 `system_prepared_shutdown` 请求管理员关闭（该原因与 `replacement_started` 一样保留有检查点的进程和浏览器会话，`preservesRecoveryOnShutdown`）。取消或失败会走清理回滚；清理自己失败则停在 `failed` 并保留 epoch，等取消重试，不会回到 `idle`。
- HTTP（`/api/system/lifecycle`，`routes/system-lifecycle.ts`）：`GET /notice` 任何登录用户只得 `phase` 和 `shutdownRequested`；`GET /status`、`POST /prepare`、`/shutdown`、`/cancel` 仅管理员（成功 202，冲突 409）；管理器面板用的 `POST /shutdown` 与 `POST /signal`（原因 `signal`，等同 Ctrl+C 的完整优雅退出）挂在全局会话认证之前，凭回环 + 管理器令牌或管理员会话。前端：`SystemMaintenanceBadge` 在维护期显示不可关闭的黄色徽标，`SystemShutdownCard` 是设置里的管理员入口（准备/关闭/取消，关闭要二次确认）。
- 更新交接（无缝更新）：新进程带 `NARRAFORK_GRACEFUL_RESTART_*` 环境变量启动，在加载 `./main` 之前由 `waitForPreviousServerShutdown` 凭一次性令牌请求旧进程关闭，并等到端口被释放（总等待 60 秒，单次请求 30 秒）才继续绑定（`lib/restart-handoff.ts`）。Windows 管理器托管时，替换进程以 `--manager` 而不是 `--serve` 启动，让新管理器接手并终止旧管理器，否则旧 exe 会被一直锁住（`lib/replacement-launch.ts:replacementLaunchArgs`）；后继进程必须比旧服务和管理器都活得久，Windows 用 `CreateProcessW`、其他平台 `detached` + `unref`（`spawnReplacementProcess`、`windows-replacement-process.ts`）。
- 冷启动续接的严格身份：`instance-process-identity.ts` 为冷续接提供「同一实例」证据（machine/boot/pid 与时间命名空间），探测有 1.5 秒、64KB 上限，与启动时放行式的锁判定分开。
- 数据库层韧性（`lib/db-resilience.ts`）：`checkIntegrity`/`quickCheck`、`tryWalRecovery`、`recoverWithCli`（`sqlite3 .recover`）以及每 5 分钟的 WAL 检查点与每第六次附带的 `PRAGMA optimize`（`createWalUpkeepTick`，由 `sqlite-lifecycle.ts` 启动）。
- 顺序（`main.ts`）：先读更新清单与普通重启清单，再做通用叙述者恢复，随后装载续接队列；两条路径共用同一套续接队列。

## 从哪读起
- `server/lib/instance-lock.ts:acquireInstanceLock`；`server/db/backend/sqlite-lifecycle.ts:start`。
- `server/db/integrity-check.ts:scheduleBackgroundIntegrityCheck`。
- `server/services/restart-recovery-service.ts`、`update-recovery-service.ts:restoreNarratorsAfterPlannedUpdate`。

## 改它时
- 新增关闭原因：要决定它是否应保留检查点进程（`shutdown-activity.ts:preservesRecoveryOnShutdown`）、是否允许跑关闭后钩子（`canRunCleanShutdownHooks` 要求结果 `clean` 且原因一致）；`shutdown-activity.test.ts` 钉着这些规则。
- 改实例锁判定：`tests/server/lib/instance-lock.test.ts`；原则是只有确证存活且同一进程才拒绝，其余当陈旧锁清掉。
- 改普通重启或更新后的恢复记录：`restart-recovery-service.test.ts`、`update-recovery-service.test.ts`；不变量：已开始执行或有文件变更的工具标记为结果未知、不自动重跑；两条路径共用同一套续接队列。
- 改更新交接或替换进程：`restart-handoff.test.ts`、`replacement-lifecycle.test.ts`、`replacement-launch.test.ts`、`windows-replacement-process.test.ts`；`server/index.ts` 必须在加载 `./main` 之前完成交接。
- 改系统准备关机：协调器是唯一的闸门，`system-lifecycle.ts` 只选退出动作；前端 `useSystemLifecycleStatus`、`lib/api/system-lifecycle.ts` 与路由返回形状要一起改。

## 相关
- [启动与进程](boot.md)
- [中断与恢复](../narrator/recovery.md)：恢复后的半截输出清理、子代理接续。
