---
id: automation.plugins
title: 插件系统
summary: 插件包、运行时、能力代理、提供商插件、UI 插件。
anchors:
  - server/services/plugin-manager.ts
  - server/services/plugin-runtime.ts
  - server/services/plugin-catalog.ts
  - server/services/plugin-package-store.ts
  - server/services/plugin-capability-broker.ts
  - server/services/plugin-permission-store.ts
  - server/services/plugin-podman-runner.ts
  - server/services/plugin-process-runner.ts
  - server/services/plugin-provider-registry.ts
  - server/services/plugin-ui-host.ts
  - server/services/plugin-scheduler.ts
  - server/lib/plugins/manifest.ts
  - server/builtin-plugins/
  - server/plugin-runtime-worker.ts
  - server/routes/plugins.ts
  - server/routes/plugin-ui.ts
status: stub
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 插件系统

插件是带 `manifest.json` 的包，作为独立子进程与宿主用 stdio RPC（`narrafork.rpc/1`）通信，通过“贡献点”扩展宿主，每项能力都要经能力代理授权。

## 关键规则
- 清单（`lib/plugins/manifest.ts`，zod `.strict()`）：`engine.runner` 为 `local-process`（默认）或 `podman`；`contributes` 可含 `providers、searchProviders、tools、commands、events、views、themes、configuration`，每类数量有上限。内置样例 `server/builtin-plugins/apikey-quota`（`com.narrafork.apikey-quota`，只贡献一个 `query-balance` 命令）。
- 内置插件和普通插件走同一套清单校验与生命周期，只是没有安装步骤；编译后的二进制会先把内置包写回磁盘再读取（`builtin-plugins/registry.ts`、`materialize.ts`）。
- 运行：进程启动超时默认 15s、进程空闲超时默认 5 分钟（`plugin-runtime.ts` 的 `LocalProcessRunner` 启动处，`DEFAULT_SPAWN_TIMEOUT_MS`/`DEFAULT_IDLE_TIMEOUT_MS`）；`PluginRuntime` 构造处的握手 15s、激活 30s、RPC 15s、排空 5s（`options.timeouts` 默认值）。空闲超时具体是否等于“回收插件进程”未核实。编译版用自身二进制加 `--plugin-runtime-worker <入口>` 启动插件，该模式在加载 main 之前分支，不开数据库、不抢实例锁（`plugin-runtime-worker.ts`）。
- `local-process` 不提供网络/文件系统隔离，清单里的 `permissions.network` 等不是沙箱；需要隔离用 Podman 运行器（清单注释，`manifest.ts`）。Podman 运行器要求镜像带 sha256 摘要和绝对路径，默认 1 CPU、pids 128、tmpfs 64MiB，且“绝不回退到本地执行”（`plugin-podman-runner.ts:buildPodmanCommand/PodmanRunner`）。
- 授权：能力经 `CapabilityBroker` 判定；升级时新版本声明的新能力、运行时未授权调用都会产生待审批请求，管理员批准/拒绝；每个安装的授权/待审批/永久拒绝条目各有上限，默认 512（`plugin-permission-store.ts` 的 `DEFAULT_MAX_GRANTS_PER_INSTALLATION`，加载时超限即判损坏）。被隔离（`PLUGIN_QUARANTINED`）或禁用的插件调用返回 423。
- 密钥值存独立文件（0600），与配置状态分离，不进日志与错误（`plugin-secret-vault.ts`、`plugin-secret-broker.ts`）。
- 数据位置：包在 `<narrafork-home>/plugins`，插件存储在 `plugins/storage`（`plugin-package-store.ts`、`plugin-storage.ts`）。签名校验可选，`requireSignature` 默认 false（`plugin-manager.ts`）。
- 提供商插件：通过 `plugin-provider-registry.ts`、`plugin-provider-rpc.ts`、`plugin-provider-adapter-factory.ts` 把插件声明的模型提供商接入 agent；UI 插件由 `plugin-ui-host.ts`/`plugin-ui-assets.ts` 与 `routes/plugin-ui.ts` 提供；“以 iframe 承载”仅见于 `plugin-ui-host.ts` 的注释，渲染方式未核实。
- 开关：设置 `plugins.enabled`（环境变量 `NF_PLUGINS_ENABLED` 优先）；关闭时变更类接口返回 503 `PLUGINS_DISABLED`。生命周期接口（enable/disable/activate/uninstall/retry）、授权、提供商配置均要求管理员（`routes/plugins.ts`）。
- 插件自己的调度器与宿主定时任务无关（`plugin-scheduler.ts`）。

## 从哪读起
- `server/services/plugin-manager.ts`：安装、启停、状态机的总入口。
- `server/lib/plugins/manifest.ts`：清单形状。
- `server/services/plugin-capability-broker.ts`：授权判定。
- `server/services/plugin-runtime.ts`：进程与 RPC 生命周期。
- `server/routes/plugins.ts`：HTTP 面。

## 相关
- [基准测试与容器](benchmarks-containers.md)
- [定时任务](scheduled.md)

## 下面有什么

- [插件运行时](runtime.md)：插件包、进程与 Podman 运行、握手与超时、生命周期与升级。
- [插件授权与密钥](permissions-secrets.md)：能力代理、授权存储、密钥保管、签名与加固。
- [提供商插件](providers.md)：以插件形式接入的模型提供商：清单、注册、凭证、就绪检查。
- [插件贡献点](contributions.md)：插件提供的工具、命令、搜索源、事件、界面与 MCP 适配。
