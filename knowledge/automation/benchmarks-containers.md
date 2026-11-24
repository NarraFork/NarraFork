---
id: automation.benchmarks-containers
title: 基准测试与容器
summary: 基准测试服务、Podman 容器。
anchors:
  - server/routes/runtime.ts
  - frontend/components/settings/RuntimeSection.tsx
  - server/services/benchmark-service.ts
  - server/services/benchmark-container.ts
  - server/services/benchmark-limits.ts
  - server/services/benchmark-evaluators/
  - server/services/container-service.ts
  - server/routes/benchmarks.ts
  - server/routes/containers.ts
  - frontend/components/container/
  - frontend/components/settings/DependencyInstallTerminal.tsx
  - frontend/components/settings/DependencyStatus.tsx
  - frontend/components/settings/WorkspaceContainersSection.tsx
  - frontend/components/settings/dependency-install-progress.ts
  - frontend/lib/api/containers.ts
  - frontend/routes/admin/containers.tsx
  - server/services/benchmark-read.ts
  - server/services/benchmark-suite-stream.ts
  - server/services/runtime-service.ts
keywords:
  - /api/benchmarks
  - /api/containers
  - /api/runtime
  - benchmark_runs
  - humaneval
  - swe-bench
  - agencybench
  - BENCHMARK_READ_BUDGET
  - CONTAINERS_UNSUPPORTED
  - podman
  - nf-bench
  - SWE-bench
  - 容器
  - 基准测试
  - compose
  - rootless
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 基准测试与容器

基准测试把一组任务（suite）交给 Agent 一次性作答，再用评测器打分；SWE-bench 类任务在 Podman 容器里隔离执行。`container-service` 只负责检测/安装 Podman 与解析 compose 文件。

## 关键规则
- 流程：`createSuite` → `createRun`（状态 `pending`）→ `startRun` 用 SQL `UPDATE ... WHERE status='pending'` 原子认领后在后台执行；任务在一个 run 内**顺序**执行，可由 `cancelRun` 中止（`benchmark-service.ts:claimRun/executeClaimedRun`）。
- 评测器注册表只有三个：`humaneval`、`swe-bench`、`agencybench`，按 suite 名选取；接口为 `evaluate(task, agentOutput, workDir) → {passed, score, maxScore, details}`（`benchmark-evaluators/types.ts`）。
- 每个任务在 `tmpdir()/nf-bench-<taskId>-*` 的临时目录里工作，可从 `metadata.sourcePath` 复制源码；叙述者会话由 narrator-service/session 创建并等待空闲（`executeTask`、`waitForNarratorIdle`）。
- swe-bench 且元数据含 `repo` 与 `baseCommit` 时：拉镜像、创建容器（工作目录绑定到 `/testbed`，内存上限 4g），在容器里 clone 并 reset 到基线提交后安装依赖（`executeTask`、`benchmark-container.ts`）。容器直接调用 `podman` CLI，单次 exec 默认超时 10 分钟。
- 进程启动时清理遗留的 `nf-bench-*` 临时目录；SQLite 后端下把上次遗留的 `running` 任务标 `error`、run 标 `failed`（“Interrupted by server restart”）；PostgreSQL 后端不做这一步（`reconcileStaleBenchmarkRuns`）。
- 读取有预算：suite 最多 1000 个任务，suite JSON 20M 字符，响应 64MiB，最多 10000 行，读超时 30s，并发流 4，对比最多 32 个 run；超限抛 `BENCHMARK_READ_BUDGET`（`benchmark-limits.ts`、`benchmark-suite-stream.ts`）。
- `/api/benchmarks` 整体要求管理员（`routes/benchmarks.ts`：suites、runs、`/start`、`/cancel`、`/results`、`/summary`、`/compare`）。
- `/api/containers`：`GET /setup`（Podman、compose、passt、rootless 网络是否就绪）、`GET /podman/status`、`POST /podman/install`（管理员）。平台不支持容器时返回 `CONTAINERS_UNSUPPORTED`（`container-service.ts:getContainerSetupStatus`、`lib/platform.ts:supportsContainers`）。
- 在无 systemd cgroup 委派的环境，会写用户级 `~/.config/containers/containers.conf` 切到 cgroupfs，已有文件不覆盖（`ensureRootlessEnv`）。
- 本模块的容器用途之外，插件也有自己的 Podman 运行器，见[插件系统](plugins/index.md)。

- 设置页的安装体验：`WorkspaceContainersSection.tsx`（设置页“工作区与容器”）、`DependencyStatus.tsx`（检测结果）、`DependencyInstallTerminal.tsx` + `dependency-install-progress.ts`（在 xterm 终端里发安装命令，靠提示符规则判断何时发送；漏掉第一个提示符会留下空白终端，所以规则抽成了可单测的纯函数）；API 在 `frontend/lib/api/containers.ts`，管理页 `frontend/routes/admin/containers.tsx`。
- `benchmark-read.ts` 与 `benchmark-suite-stream.ts`：结果读取走预算（见上），不在主线程一次读完大 suite。
- 运行时扫描：`runtime-service.ts` 对应 `/api/runtime/scan`、`/cached`（管理员），汇总终端（运行/已退出/孤儿 socket）、容器（按 `containerInstances` 与 `podman --version` 探测）、浏览器进程与会话数，并支持按目标清理；它不是基准测试的一部分，只是与容器检测放在同一管理页。

## 从哪读起
- `server/services/benchmark-service.ts`：run 生命周期与任务执行。
- `server/services/benchmark-container.ts`：podman 封装（create/exec/destroy）。
- `server/services/container-service.ts`：Podman 检测、安装、compose 解析。

## 改它时
- 加一个评测器：在 `benchmark-evaluators/` 实现 `evaluate(task, agentOutput, workDir)` 并登记到注册表（按 suite 名选取），`benchmark-evaluators.test.ts` 会断言各评测器行为；评分结果结构（`passed/score/maxScore/details`）被结果读取与前端对比页消费。
- 改 run 状态机或启动清理：`benchmark-service.ts` 的原子认领（`UPDATE ... WHERE status='pending'`）与 `reconcileStaleBenchmarkRuns`（SQLite 才做）；读取侧预算改动要同步 `benchmark-limits.ts` 并看 `benchmark-worker-reads.test.ts`。
- 改容器检测/安装：`container-service.ts`、`routes/containers.ts` 与设置页组件一起；不变量是平台不支持容器时返回 `CONTAINERS_UNSUPPORTED`，且不得自动改写已有的 `containers.conf`。
- 基准测试路由整体要求管理员，新增路由不要漏掉 `requireAdmin`。

## 相关
- [插件系统](plugins/index.md)
