---
id: automation.plugins.runtime
title: 插件运行时
summary: 插件包、进程与 Podman 运行、握手与超时、生命周期与升级。
anchors:
  - server/services/plugin-runtime.ts
  - server/services/plugin-process-runner.ts
  - server/services/plugin-podman-runner.ts
  - server/services/plugin-package-store.ts
  - server/services/plugin-upgrade-coordinator.ts
  - server/plugin-runtime-worker.ts
  - server/services/plugin-manager.ts
  - server/builtin-plugins/registry.ts
  - server/lib/plugins/manifest.ts
  - server/lib/plugins/index.ts
  - server/lib/plugins/protocol.ts
  - server/lib/plugins/windows-plugin-job.ts
  - server/lib/plugins/windows-plugin-launcher.ts
  - server/lib/plugins/windows-plugin-process.ts
  - server/services/plugin-health.ts
  - server/services/plugin-rpc-connection.ts
  - server/services/plugin-state-store.ts
  - server/services/plugin-storage.ts
keywords:
  - manifest.json
  - narrafork.rpc/1
  - LocalProcessRunner
  - PodmanRunner
  - RuntimeSupervisor
  - quarantine
  - IDLE_TIMEOUT
  - NF_PLUGIN_PODMAN_IMAGE
  - PLUGIN_PODMAN_CONFIGURATION_MISSING
  - current.json
  - state.json
  - .nfplugin
  - --plugin-runtime-worker
  - --windows-plugin-launcher
  - plugin-storage
  - Job Object
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 插件运行时

把一个插件包装进磁盘、起成独立子进程、通过 stdio RPC 与宿主握手，并在崩溃时有界重启或隔离。授权与贡献点不在这里。

## 关键规则
- 包存储（`PluginPackageStore`）：根目录 `<narrafork-home>/plugins`，含 `staging/`、`packages/`、`current.json`（指针 `{version, hash}`）。只收 `.zip`/`.nfplugin`；上限为压缩包 100MiB、解压 500MiB、单文件 50MiB、清单 1MiB、1 万个文件，整体操作 60s；含符号链接或特殊条目即拒绝。路由上传另限 100MiB。
- 安装只落盘并登记，不启动：`finishInstalledPackage` 把 `desiredState` 置为 `disabled`，之后需 enable/activate。同一 `pluginId` 装入不同哈希即视为升级：先撤销旧授权、停旧运行时，再校验信任策略（`plugin-manager.ts`）。
- 内置插件同走清单校验与生命周期，只是没有安装步骤，首次初始化时默认 `enabled`，之后显式 disable 保持有效；编译版先把内置包写回磁盘再读（`builtin-plugins/registry.ts`、`materialize.ts`）。
- 清单：`engine.runtime` 为 bun/node/python/binary，`engine.runner` 为 `local-process`（默认）或 `podman`；`server` 声明入口、stdio 传输、`narrafork.rpc/1`，`startupTimeoutMs`（默认 15s）与 `activationTimeoutMs`（默认 30s）被映射为运行时的握手与激活超时（`manifest.ts`、`plugin-manager.ts:defaultRuntimeOptions`）。
- 本地运行器：子进程只继承白名单环境变量（PATH、LANG 与若干 `NF_PLUGIN_*`）；POSIX 上用 `/bin/sh ulimit` 套 CPU 300s、虚拟内存 1GiB，Windows 无此限制（manager 对 win32 显式放行无限制运行）。进程启动超时 15s，空闲超时 5 分钟（`LocalProcessRunner`），RPC 15s、排空 5s、关停 5s（`PluginRuntime` 默认）。空闲超时到期后的链路（`PluginRuntime.timeout("idle")`、`RuntimeSupervisor.handleFailure`）：
  - 先 `emitError`（错误码 `IDLE_TIMEOUT`，`phase: "idle"`，`retryable`），再 `kill`。
  - 该错误经 `onError` 到 `handleProcessError`，状态变为 `failed`。
  - `IDLE_TIMEOUT` 不属于隔离（quarantine）条件（隔离只看 stdout 阶段错误、`HELLO_*`、`STDOUT_LIMIT`、`INVALID_JSON_RPC`、`PROCESS_EXIT`），所以监督者按退避排定重启。
  - 这次重启计入重启预算（窗口内次数与总次数上限）；预算耗尽才隔离（`restart budget exhausted`）。
- `local-process` 不提供网络或文件系统隔离；清单里的 `permissions.network/filesystem/process` 在宿主代码里没有任何读取方，只是声明，不是沙箱（`manifest.ts` 注释，全仓搜索确认）。需要隔离用下面的 Podman 运行器。
- 编译版没有系统 Bun：用自身可执行文件加 `--plugin-runtime-worker <入口>` 启动插件，该模式在加载 main 之前分支，不开数据库、不抢实例锁（`plugin-runtime-worker.ts`）；源码运行直接 `bun <入口>`。
- 监督（`RuntimeSupervisor`）：崩溃/失败后指数退避重启（100ms 起，上限 30s，±10% 抖动）；60s 窗口内超过 3 次或 15 分钟内超过 10 次进入 `quarantine`；stdout 协议错误（`INVALID_JSON_RPC`、`STDOUT_LIMIT`、握手类错误、`PROCESS_EXIT`）直接隔离。隔离后的调用见[授权与密钥](permissions-secrets.md)。
- Podman 运行器只在清单声明 `podman` 时用，且需要环境变量 `NF_PLUGIN_PODMAN_IMAGE` 与 `NF_PLUGIN_PODMAN_IMAGE_DIGEST`，缺失则 503 `PLUGIN_PODMAN_CONFIGURATION_MISSING`。命令带 `--read-only`、`--network none`、`--cap-drop ALL`、`no-new-privileges`，默认 512MiB 内存、1 CPU、pids 128、tmpfs 64MiB，包以只读挂 `/plugin`、数据目录读写挂 `/data`；镜像必须带 `sha256:` 摘要；Podman 不可用就报错，不回退到本地执行（`buildPodmanCommand`、`PodmanRunner.start`）。
- `PluginUpgradeCoordinator`（暂存新包 → CAS 改指针 → 健康检查 → 起新进程，失败补偿回滚）和 `PluginProcessRunner` 在仓库里只被测试和 `plugin-hardening.ts` 的再导出引用，`PluginManager` 的安装路径并不经过它们。

- Windows 本地运行：插件进程被放进插件私有的 Job Object（带 `KILL_ON_JOB_CLOSE`），经内部启动器 `--windows-plugin-launcher <jobName> <命令…>` 先加入作业再起目标；根 PID 消失不算整树退出的确认（`lib/plugins/windows-plugin-job.ts`、`windows-plugin-launcher.ts`、`windows-plugin-process.ts`，由 `plugin-runtime.ts` 调用）。这只提供整树终止，不提供 CPU/内存限额。
- RPC 连接（`plugin-rpc-connection.ts`）：每个运行时代际一条，两个方向的请求分开登记；写队列有界（默认 16 个在途、8MiB、1024 条消息），并给控制帧预留 256KiB/32 条，保证取消与关停不被普通帧淹没。
- 健康与断路（`plugin-health.ts`）：按插件与面（`runtime/provider/tool/event`）统计请求、失败、耗时，状态 `closed/open/half-open`；管理器与事件网关使用。
- 状态与存储：`plugin-state-store.ts` 写 `state.json`（原子写 + 日志 + 损坏恢复，默认状态文件 ≤1MiB、日志 ≤4MiB、JSON 深度 ≤12，含提供商配置，以贡献 id 为键以便升级后不丢）；`plugin-storage.ts` 是插件的键值缓存（单值 ≤64KiB、每作用域 ≤1MiB/1000 项、每插件 ≤8MiB）。
- 协议常量与 RPC/提供商限额在 `lib/plugins/protocol.ts`（`narrafork.rpc/1`、提供商请求体上限 64MiB），`lib/plugins/index.ts` 只是再导出。`plugin-spec-compat*.ts`（把旧 Dynamic Spec 插件命令转换到大纲会话任务，并按小时记告警）不属于运行时，见报告说明。

## 从哪读起
- `server/services/plugin-manager.ts`：安装、启停、状态机总入口。
- `server/services/plugin-runtime.ts`：`LocalProcessRunner`、`PluginRuntime`、`RuntimeSupervisor`。
- `server/services/plugin-package-store.ts`：包与 `current.json`。

## 改它时
- 改清单 `engine`/`server` 字段：`lib/plugins/manifest.ts`（zod `.strict()`，加字段要同步所有消费方）、`plugin-manager.ts:defaultRuntimeOptions`、内置包 `builtin-plugins/registry.ts` 的清单一起；协议版本改动要同步 `lib/plugins/protocol.ts`。
- 改超时/重启预算：`plugin-runtime.ts` 的 `PluginRuntime` 默认值与 `RuntimeSupervisor` 参数；`plugin-health.test.ts`、`plugin-process-runner.test.ts`、`plugin-podman-runner.test.ts`、`plugin-upgrade-coordinator.test.ts`（`server/services/__tests__/`）断言具体行为；Windows 启动器有 `windows-plugin-launcher.compiled.test.ts`。
- 改 Podman 参数：只读根、`--network none`、`--cap-drop ALL`、`no-new-privileges` 与摘要必填是安全不变量，不能回退到本地执行。
- 不变量：安装只落盘、不启动；编译版插件用自身可执行文件启动且不开数据库；`IDLE_TIMEOUT` 走重启预算而不是直接隔离。

## 相关
- [插件系统](index.md)
- [插件授权与密钥](permissions-secrets.md)
- [基准测试与容器](../benchmarks-containers.md)
