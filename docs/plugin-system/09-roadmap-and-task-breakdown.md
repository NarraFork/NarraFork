# NarraFork 插件系统：路线图与工程任务分解

> 文档定位：把 `01`、`02`、`04`、`05` 的设计收敛为可执行的阶段 0–4 路线、工程任务、验收标准、依赖关系、发布/回滚策略和风险控制。本文件只描述实施计划，不修改源码、数据库迁移或既有协议实现。
>
> 标记约定：
> - **[事实]**：当前仓库代码或已完成设计文档可直接确认。
> - **[建议]**：本路线图推荐的实现方式、顺序或验收门槛。
> - **[假设]**：为了形成可执行计划而暂时采用的前提。
> - **[待决策]**：需要在实现前由项目负责人、架构评审或安全评审确认。

---

## 1. 交付目标与范围

### 1.1 本轮路线图要交付什么

- **[建议]** 交付一个“核心宿主控制面 + 独立插件运行时 + 版本化公共 API”的插件平台，而不是任意 Bun/Node 模块加载器。
- **[建议]** 阶段 0–4 结束时，管理员应能在不重新编译 NarraFork 的情况下安装、静态检查、授权、启用、禁用、升级、回滚和卸载插件；插件可按需贡献 tool、command、public event/query、provider 和 UI panel。
- **[建议]** 后端第三方代码默认进程外运行；UI 第三方代码默认 sandbox iframe；核心数据库、原始 `eventBus`、JWT、内部 service 和完整 `ToolContext` 永不越过边界。
- **[建议]** 第一条可发布路径优先支持离线包和本地管理员操作，不以插件市场、自动付款或云端分发为前置条件。

### 1.2 明确不在阶段 0–4 的承诺

- **[建议]** 不承诺 Module Federation、运行期把第三方 React/JS import 到主窗口、任意 React component 注入或任意 Hono route/middleware 注入。
- **[建议]** 不承诺 WebAssembly 作为通用插件运行时；WASM 只保留为后续受限计算能力的研究方向。
- **[建议]** 不重写现有 MCP SDK 或 `McpManager`；插件系统只通过受控适配器与 MCP 共存。
- **[建议]** 不允许插件自行修改 NarraFork 核心 schema、核心迁移、核心事务或 SQLite 文件。
- **[建议]** 不提供跨插件原子事务；需要跨边界工作流时使用 operation ID、幂等键、状态查询和补偿命令。

### 1.3 路线图假设

- **[假设]** 首个实现目标是单实例、小团队私有部署，管理员数量少但插件故障和安全边界要求高。
- **[假设]** v1 采用 Content-Length framed JSON-RPC over stdio；协议保持语言中立，首个参考 SDK 可只支持 TypeScript/Bun。
- **[假设]** 一个后端插件一个受监管进程；provider instance 可以在实现阶段单独进程化，不能与不相关插件共享进程。
- **[假设]** 插件包目录不可变，升级通过 staging 与原子 `current` 指针切换；同一插件 v1 不做蓝绿双写。
- **[待决策]** 第三方插件是否默认强制 Podman。路线图按“LocalProcessRunner 可用、PodmanRunner 可选且对 T2 高风险插件推荐”规划。

---

## 2. 当前实现基线

### 2.1 后端与启动

- **[事实]** `server/app.ts` 静态导入并挂载 Hono 路由，`requireAuth` 的全局门禁顺序由核心决定，目前没有第三方任意注册路由或 middleware 的稳定接口。
- **[事实]** 现有优雅退出使用带硬超时的 `shutdownStep()`，并对终端、MCP、浏览器、Codex WebSocket 等子系统逐项清理。
- **[建议]** Plugin Manager 接入同一启动/退出模式，但插件启动失败、超时或崩溃不得阻止核心健康检查、登录和管理页面。

### 2.2 Provider 与 Agent Loop

- **[事实]** `server/lib/agent/provider.ts` 中的 `ProviderAdapter` 是进程内 TypeScript 接口，包含 history 转换、tool 格式化、流式 `chat`、多种 `generate`、usage、reasoning metadata、取消信号等宽协议面。
- **[事实]** `ParsedStreamEvent` 已包含文本、reasoning、tool call chunk、usage、错误状态、Web Search、图片生成和 provider-specific metadata 等字段。
- **[事实]** `getVisibleModels()`、context window、aggregation、sticky provider 和 provider prefix migration 依赖现有 settings/registry 逻辑。
- **[建议]** 插件 provider 不直接进入 Agent Loop；由 `ProviderRegistry` 与 `RemoteProviderAdapter` 在核心侧完成 canonical history、tool schema、`AbortSignal`、事件校验和错误映射。

### 2.3 MCP

- **[事实]** `server/lib/mcp/manager.ts` 已实现 MCP transport 创建、连接/断线重连、工具发现、`tools/list_changed`、工具调用取消、状态和 shutdown。
- **[事实]** MCP 工具变化通过核心 `eventBus` 与 `onToolsChanged` 回调触发工具同步。
- **[建议]** 插件平台不复制这些生命周期；插件若提供 MCP 相关能力，应通过 `McpContributionAdapter` 或受控 `mcp.server` contribution 接入现有管理器与工具注册表。

### 2.4 UI、Dockview 与路由

- **[事实]** `DockviewSurface` 是统一 Dockview wrapper，支持组件注册、拖拽换位/合并/分栏、主题和 `defaultRenderer`。
- **[事实]** `NarratorDock` 与 `DockviewWorkspace` 当前都使用 `defaultRenderer="always"`，用于保持聊天、终端、webview 等组件实例和状态。
- **[事实]** workspace director 是 overlay 状态，当前由 workspace dock store 管理 panel 的挂载/卸载与主面板选择。
- **[事实]** TanStack Router 的 route tree 是构建期生成的静态模块。
- **[建议]** 插件 UI 只通过一个静态 `plugin` component key 映射到宿主 `PluginDockPanel`；iframe、MessageChannel、缺失占位和 director slot 全由宿主控制。

---

## 3. 总体阶段图与依赖关系

### 3.1 阶段定义

| 阶段 | 目标 | 默认产物状态 | 可对外启用的能力 |
|---|---|---|---|
| 0 | 契约冻结、基线、威胁模型和测试夹具 | 设计/测试基础设施 | 无第三方代码执行 |
| 1 | 控制面与运行时骨架 | Alpha | 安装、静态检查、启停、诊断；不开放业务贡献 |
| 2 | 公共 API、权限、存储、tool/command/event、MCP 适配 | Beta | 受授权的后端插件能力 |
| 3 | Provider RPC 与 Agent Loop 接入 | Beta | 受授权的 provider 插件 |
| 4 | UI iframe/Dockview、发布硬化和可选隔离运行器 | RC/GA | 受授权的 UI 面板与完整插件体验 |

### 3.2 依赖图

```text
P0 契约/基线/威胁模型
 ├─> P1 Manifest/Catalog/State Store
 │    ├─> P2 Runtime Supervisor + stdio RPC
 │    │    ├─> P3 Capability Broker + Public API
 │    │    │    ├─> P4 Tool/Command/Event/Storage/MCP
 │    │    │    └─> P5 Provider Registry + RemoteProviderAdapter
 │    │    └─> P6 Upgrade/Rollback/Quarantine
 │    └─> P7 Trust/Signature/Permission policy
 └─> P8 UI contract/fixture
      └─> P9 Asset shell + iframe bridge
           └─> P10 PluginDockPanel + Dockview/director
                └─> P11 UI query/command/event/storage/backend proxy

P3 + P4 + P5 + P10 + P11 ──> P12 发布、迁移、运维和 GA 验收
```

### 3.3 不可逆依赖与并行工作

- **[建议]** Manifest 字段、plugin/contribution ID 规则、权限命名、RPC version 和错误分类必须在阶段 0 冻结；否则阶段 1–3 会产生不可兼容的临时实现。
- **[建议]** 阶段 1 的 Catalog/State Store、阶段 0 的测试夹具、阶段 4 的 UI 设计可并行；但 UI bridge 不能在 Host API/权限名未冻结前开始写业务 API。
- **[建议]** Provider RPC 与 Public Event/Query 可以在阶段 2 后半段并行，但都必须复用同一个 Runtime Supervisor、Capability Broker、request tree、quota 和 diagnostics 模型。
- **[建议]** MCP 适配不得阻塞 provider RPC；MCP 仍由现有 `McpManager` 负责连接与重连。

---

## 4. 工程任务总表

> 任务 ID 是路线图内部编号，不代表当前仓库已有 issue。每项工程任务的“完成”都必须包含代码、测试、诊断和文档/协议 fixture（若该任务改变协议）。

### 4.1 阶段 0 任务

| ID | 任务 | 输出 | 依赖 |
|---|---|---|---|
| P0-01 | 统一术语、ID、状态机和版本层 | `pluginId`、contribution ID、T0–T3、期望/运行状态、Manifest/Host API/RPC 三层版本表 | 无 |
| P0-02 | 盘点当前 provider/MCP/Agent/UI 接口 | 现状矩阵、适配边界、禁止透传清单 | 无 |
| P0-03 | 冻结 Manifest v1 草案 | JSON Schema、贡献类型、activation event、入口和兼容字段 | P0-01 |
| P0-04 | 冻结 capability/permission taxonomy | 权限名、资源 scope、用户/后台 principal、danger reflection 规则 | P0-01 |
| P0-05 | 冻结 RPC/UI envelope | JSON-RPC framing、request tree、cancel、deadline、error、credit、UI handshake | P0-01 |
| P0-06 | 建立参考插件与恶意插件 fixture | good、slow、crash、oversized、malformed、version mismatch、UI hostile fixture | P0-05 |
| P0-07 | 威胁模型与安全评审 | STRIDE/滥用场景、信任等级策略、残余风险清单 | P0-04 |
| P0-08 | 基线性能与回归指标 | 核心启动、API p95、WS、provider 流、Dockview layout 的基线报告 | P0-02 |
| P0-09 | ADR 评审和决策日志 | `10-open-questions-and-decisions.md` 的 ADR 状态初版 | P0-01–P0-07 |

### 4.2 阶段 1 任务

| ID | 任务 | 输出 | 依赖 |
|---|---|---|---|
| P1-01 | Plugin Catalog 与包目录扫描 | 只读扫描、Manifest 校验、包摘要和不可执行检查 | P0-03 |
| P1-02 | Package Store staging/current/旧版本保留 | 不可变版本目录、原子指针、包清理策略 | P1-01 |
| P1-03 | Plugin State Store 与 journal | 安装、期望状态、当前版本、grants、quarantine、升级步骤 | P0-01、P1-02 |
| P1-04 | LocalProcessRunner | 参数数组、环境 allowlist、工作目录、stderr ring、子进程树清理 | P0-07 |
| P1-05 | Framed stdio RPC 基础库 | parser、Content-Length、JSON-RPC request/response/notification、禁止 batch | P0-05 |
| P1-06 | Runtime Supervisor | spawn、握手、generation、heartbeat、健康、取消、kill、退避 | P1-04、P1-05 |
| P1-07 | Plugin Manager 生命周期 | install/enable/disable/activate/deactivate/uninstall 状态机 | P1-03、P1-06 |
| P1-08 | 静态 Contribution Registry | provider/tool/command/event/view 元数据索引，不执行动态代码 | P1-01、P1-07 |
| P1-09 | 管理 API 与诊断页数据 | status、logs 摘要、compatibility、resource/quarantine 信息 | P1-03、P1-07 |
| P1-10 | 失败恢复与 quarantine | 重启预算、旧 generation 丢弃、journal recovery、管理员 retry | P1-06、P1-07 |
| P1-11 | 阶段 1 feature flag 与 kill switch | 全局禁用插件、按插件禁用、启动失败 fail closed | P1-07 |

### 4.3 阶段 2 任务

| ID | 任务 | 输出 | 依赖 |
|---|---|---|---|
| P2-01 | Capability Broker 骨架 | plugin principal、user/background principal、grant 交集、scope 校验、审计 | P1-07、P0-04 |
| P2-02 | Public Query API | 白名单 query、DTO、cursor pagination、摘要/详情分层、输出上限 | P2-01 |
| P2-03 | Public Command API | 业务意图命令、Zod schema、幂等键、结果未知语义、审计 | P2-01 |
| P2-04 | Public Event Gateway | 内部事件映射、脱敏、过滤、异步投递、节流、at-most-once | P2-01 |
| P2-05 | Plugin Storage API | namespaced storage、配额、版本、迁移 journal、purge 语义 | P1-03、P2-01 |
| P2-06 | Tool contribution/proxy | Manifest tool schema、核心权限审批、narrowed context、取消/超时 | P2-01、P2-03 |
| P2-07 | Command contribution | 宿主命令注册表、enablement、后端 handler、幂等和审计 | P2-03 |
| P2-08 | Event subscription contribution | activation filter、队列合并、overflow、恢复后 query 对账 | P2-04 |
| P2-09 | MCP 适配器 | `mcp.server`/`mcp.bridge` 受控映射到 `McpManager`/ToolRegistry | P2-06、现有 MCP |
| P2-10 | Secret Broker v1 | secret field 标记、临时注入、日志脱敏、撤销 | P2-01、P0-07 |
| P2-11 | Scheduler/background 贡献 | 宿主 timer、并发、取消、运行记录、后台 principal | P2-03、P2-04 |
| P2-12 | 阶段 2 端到端插件 | 一个只读查询 + 一个命令 + 一个 tool + 一个 event + storage 示例 | P2-02–P2-08 |

### 4.4 阶段 3 任务

| ID | 任务 | 输出 | 依赖 |
|---|---|---|---|
| P3-01 | Provider Registry | builtin/compatible-api/executable-plugin 统一条目和 prefix 冲突检查 | P1-08、P2-01 |
| P3-02 | Provider describe/config/model catalog RPC | descriptor、validateConfig、listModels、stale cache、分页 | P1-05、P3-01 |
| P3-03 | Canonical history/tools builder | 不暴露 `DbMessage`/JWT/权限字段，映射规范化 content block | P3-01 |
| P3-04 | `RemoteProviderAdapter.chat` | accepted + `provider.event`、seq、tool/reasoning/text/usage/done 映射 | P3-02、P3-03 |
| P3-05 | `generate` 系列映射 | prompt/history 两种模式、无 tool 约束、meta/usage | P3-02、P3-04 |
| P3-06 | Provider cancel/AbortSignal | accepted 前后取消、cancel grace、late event、进程终止 | P3-04 |
| P3-07 | Provider backpressure/limits | event/byte credit、terminal reserve、输出/帧/并发配额 | P3-04 |
| P3-08 | Provider error/diagnostics 映射 | `ApiRequestDiagnostics`、retryability、tool 已暴露后的不重放 | P3-04、P3-06 |
| P3-09 | Settings/model resolution 接入 | `getVisibleModels`、context window、aggregation、disabled provider | P3-01、P3-02 |
| P3-10 | Provider 兼容回归 | 现有 provider resolution/history/abort/reasoning/error 测试全绿 | P3-04–P3-09 |
| P3-11 | Provider sample + compatibility test kit | 可运行参考 provider、跨语言 framing/stream fixture | P3-02、P3-07 |

### 4.5 阶段 4 任务

| ID | 任务 | 输出 | 依赖 |
|---|---|---|---|
| P4-01 | Host-controlled plugin asset shell | 版本/hash 资源路径、CSP、MIME、无用户数据静态资源 | P1-01、P0-07 |
| P4-02 | UI iframe sandbox | `sandbox="allow-scripts"`、不注入 JWT/Cookie、加载错误和资源回收 | P4-01 |
| P4-03 | MessageChannel UI bridge | nonce、session binding、handshake、UI RPC、cancel、heartbeat | P4-02、P0-05 |
| P4-04 | 静态 `PluginDockPanel` | 一个 component key、params schema、missing/disabled/denied/incompatible/error placeholder | P4-03 |
| P4-05 | Focus Dockview 接入 | narrator live context、布局恢复、panel singleton、多实例和 viewState | P4-04 |
| P4-06 | Workspace/Director 接入 | ownerNarratorId、workspace scope、稳定 iframe slot、top-level layer 或明确降级 | P4-04、P4-05 |
| P4-07 | UI Query/Command/Event/Storage API | UI 复用 Public API 和 Capability Broker，不开放任意 fetch | P2-02–P2-08、P4-03 |
| P4-08 | UI backend proxy | `backend.call` 只访问当前插件后端，服务端再次鉴权 | P2-01、P2-03、P4-03 |
| P4-09 | UI settings/command palette/toolbar contributions | 预置 route、声明式菜单、纯文本 chrome、enablement | P4-04、P4-07 |
| P4-10 | PodmanRunner（可选但推荐） | T2 高风险插件文件/网络/CPU/内存隔离 profile | P1-04、P0-07 |
| P4-11 | 发布硬化与运维 | 签名校验、SBOM、升级/回滚演练、指标/告警、运维手册 | P1-02、P1-10、P2-10、P4-01 |
| P4-12 | GA 验收插件和跨平台矩阵 | provider + tool + event + UI + storage + MCP 样例 | P2-12、P3-11、P4-09 |

---

## 5. 阶段 0：契约冻结与可测基线

### 5.1 输入

- **[事实]** 已有 `01-requirements-and-boundaries.md`、`02-host-architecture.md`、`04-server-rpc-and-provider.md`、`05-ui-bridge-and-dockview.md`。
- **[事实]** 当前 provider、MCP、Hono、Agent Loop、Dockview 和 settings 实现如第 2 节所述。
- **[建议]** 输入还应包括一次干净启动/退出、provider 回归、MCP 连接、focus/workspace layout 的基线测试报告。

### 5.2 输出

- **[建议]** Manifest v1 JSON Schema 与字段冻结表。
- **[建议]** Host API v1、RPC protocol v1、UI protocol v1 的兼容策略和错误码表。
- **[建议]** capability/permission registry、资源 scope 语义、T0–T3 信任等级政策。
- **[建议]** 参考插件、恶意 fixture、跨平台 framing fixture 和性能基线。
- **[建议]** ADR 初版：进程模型、RPC、iframe、MCP、Module Federation、WASM、storage、trust、release。

### 5.2.1 当前实现入口、文件与命令

阶段 0 的静态契约入口已经落在以下文件；这些文件只负责解析、校验和契约导出，不启动第三方代码、不创建插件 runtime，也不修改数据库：

| 责任 | 实际入口/文件 | 冻结内容 |
|---|---|---|
| 统一导出 | `server/lib/plugins/index.ts` | re-export `manifest.ts`、`permissions.ts`、`protocol.ts` |
| Manifest v1 | `server/lib/plugins/manifest.ts` | `manifestV1Schema`/`manifestSchema`、`parseManifest`/`safeParseManifest`、ID/path/URL/permission helper、默认值、严格未知字段拒绝和贡献引用校验 |
| 权限与信任 | `server/lib/plugins/permissions.ts` | `TRUST_TIERS`、scope schemas、`CAPABILITIES`、`HIGH_RISK_CAPABILITIES`、grant/effective permission schemas、七层 permission source |
| RPC/UI/Public Event | `server/lib/plugins/protocol.ts` | `narrafork.rpc/1`、provider `1.0`、`narrafork.ui/1`、JSON-RPC/UI/PublicEvent envelope、numeric/string error code、topic/filter schema |
| JSON Schema 契约 | `docs/plugin-system/contracts/manifest-v1.schema.json` | 与 `manifestV1Schema` 字段、默认值和 strict object 边界对应的 JSON Schema 2020-12 子集 |
| 权限契约 | `docs/plugin-system/contracts/permission-taxonomy.md` | capability、scope、T0–T3、effective intersection、fail closed、错误码和安全禁止项 |
| 契约测试 | `tests/server/lib/plugins/contracts.test.ts` | Manifest fixture、ID/path/URL、RPC/provider/UI/PublicEvent、trust/scope/effective permission 回归 |
| Manifest fixture | `tests/fixtures/plugins/*.json` | valid、UI-only、非法 ID/路径/权限/重复贡献/activation event/远程入口样例 |

阶段 0 的最小验证命令：

```sh
bun test tests/server/lib/plugins/contracts.test.ts
bunx tsgo --noEmit
bunx @biomejs/biome check server/lib/plugins tests/server/lib/plugins/contracts.test.ts
bun -e 'JSON.parse(await Bun.file("docs/plugin-system/contracts/manifest-v1.schema.json").text()); console.log("manifest-v1.schema.json: valid JSON")'
```

文档契约的 fenced code 配对检查使用仓库外部无副作用脚本完成；提交前应检查 `docs/plugin-system/00-overview.md`、`03-manifest-and-packaging.md`、`06-events-query-and-permissions.md`、`07-security-and-sandbox.md`、`09-roadmap-and-task-breakdown.md`、`10-open-questions-and-decisions.md` 及 `contracts/*.md` 的围栏数量均为偶数。阶段 0 不要求运行 `bun run db:generate`、`bun run db:migrate`，也不允许修改 `server` 运行时代码、测试契约以外的测试、`drizzle/` 或生产默认行为。

### 5.3 阶段验收

- **[建议] S0-F01** 每个 contribution 都能映射到唯一的 `pluginId/contributionId`，没有 `pluginId:providerId` 与 `pluginId/providerId` 混用。
- **[建议] S0-F02** Manifest、Host API、RPC 三层版本能独立表达兼容/不兼容，且未知必需字段会拒绝。
- **[建议] S0-S01** 权限列表明确区分只读 query、业务 command、文件/网络/进程、secret、后台运行、UI 和 MCP；默认 deny。
- **[建议] S0-S02** 威胁模型明确处理路径穿越、超大 frame、无限流、恶意 stderr、secret 外传、UI parent 访问、重放命令和事件风暴。
- **[建议] S0-R01** 参考测试能模拟进程崩溃、迟到事件、取消不响应、seq 错误、credit 超额和 UI reload。
- **[建议] S0-O01** 所有待实现接口都拥有可诊断的错误码、correlation/diagnostic ID 和预计回滚动作。

### 5.4 测试策略

- **[建议]** 单元测试：Manifest schema、ID、权限交集、状态转换、版本协商、cursor/filter schema。
- **[建议]** 属性/模糊测试：Content-Length 拆包、UTF-8 bytes、JSON-RPC parser、未知字段、嵌套 JSON 深度和异常 frame。
- **[建议]** 安全测试：恶意 Manifest、路径穿越入口、`javascript:`/`data:`/远程 URL、伪造 user/principal、权限降级。
- **[建议]** 基线测试：记录核心进程在插件全部禁用时的启动、API p95、WS 延迟和内存曲线，后续阶段不得无解释地回退。

### 5.5 迁移、发布与回滚

- **[建议]** 阶段 0 不做数据库迁移，不安装第三方包，不改变生产默认行为。
- **[建议]** 以文档、schema fixture 和测试 fixture 作为可回滚产物；删除实验 fixture 不影响用户数据。
- **[待决策]** 是否把插件 ID/权限 registry 纳入核心版本发布，还是单独维护兼容包。推荐随核心发布并由 Host API major 保护。

---

## 6. 阶段 1：控制面与运行时骨架

### 6.1 输入

- **[建议]** 阶段 0 冻结的 Manifest、RPC、信任等级、包布局、错误码和资源基线。
- **[事实]** 当前 `server/main.ts` 已有异步子系统初始化和有硬超时 shutdown，可复用其组合根接入位置。
- **[事实]** 当前 Hono 路由是静态挂载，因此只新增核心拥有的插件管理路由，不让插件注册路由。

### 6.2 输出

- **[建议]** `PluginCatalog`、`PackageStore`、`PluginStateStore`、`CompatibilityChecker`、`ActivationIndex`。
- **[建议]** `LocalProcessRunner`、Content-Length stdio RPC client/server、`RuntimeSupervisor`、generation/lease/health。
- **[建议]** `PluginManager` 生命周期和持久化 journal；安装但不执行代码，启用但按 activation event 激活。
- **[建议]** 管理 API/诊断数据：版本、签名、兼容性、期望状态、运行状态、崩溃次数、队列和最近错误。

### 6.2.1 阶段 1 的实际切入点评估

**[当前事实]** 阶段 1 不需要先改造 Agent Loop 或 UI。当前仓库已有四个可复用切入点：

| 现有能力 | 事实依据 | 阶段 1 复用方式 | 不能直接复用的部分 |
|---|---|---|---|
| 进程启动与输出排水 | `server/lib/spawn.ts` 的 `safeSpawn`：参数数组、stdout/stderr draining、timeout、AbortSignal、watchdog、进程树清理 | 提取/复用参数数组和清理原则，封装 `LocalProcessRunner` | `safeSpawn` 返回完整字符串结果，不适合作为长连接 RPC；插件需要 streaming framing、stderr ring 和 credit window |
| 组合根与优雅退出 | `server/main.ts` 的异步初始化和 `shutdownStep()` 硬超时 | 在核心初始化完成后恢复 Plugin Manager；退出时先 drain/cancel/deactivate，再按硬超时 kill | 不把插件激活设为 HTTP/WS 启动前置条件 |
| 外部连接生命周期 | `server/lib/mcp/manager.ts` 的 connect/disconnect/reconnect/shutdown、状态和 `Promise.allSettled` | 借鉴状态机、重连预算、独立连接记录和 shutdown 编排 | 不复用 MCP transport 或工具协议；插件 RPC 需要 runtime generation、握手和公共 API capability 检查 |
| keyed 并发控制 | `server/lib/async-mutex.ts` 的 `AsyncMutex` | 以 `pluginId` 为 key 串行化 install/enable/disable/upgrade/uninstall | 不使用全局锁；不同插件必须能够并行恢复 |

**[建议]** 阶段 1 的最小新增文件顺序：

1. `server/services/plugin-package-store.ts`：staging、hash、包目录 containment 和 current 指针；
2. `server/services/plugin-catalog.ts`：只读 Manifest 扫描和静态贡献索引；
3. `server/services/plugin-runtime.ts`：`LocalProcessRunner`、stdio framing、stderr ring、generation 和健康状态；
4. `server/services/plugin-manager.ts`：per-plugin mutex、期望/运行状态、journal、退避和 quarantine；
5. `server/routes/plugins.ts`：仅核心拥有的管理/诊断路由；
6. `server/main.ts`：以现有异步子系统模式接入恢复和 shutdown；
7. 阶段 1 测试：先使用 crash/slow/malformed fixture，再接入真实贡献。

**[建议]** 阶段 1 第一条可执行 vertical slice 应是：安装一个只含 Manifest 的包 → 静态扫描 → enable → activation 时启动一个无业务插件 → hello/版本校验 → health → disable/drain/kill → 诊断状态可查询。Provider、Public API、UI 和数据库迁移继续留到后续阶段。

**[已实现]** 当前 vertical slice 已落在以下真实入口：

- `server/services/plugin-package-store.ts`：staging、包目录 containment、不可变 hash 目录、current 指针原子更新和安装期 Manifest 校验；
- `server/services/plugin-catalog.ts`：current/包目录扫描、兼容性诊断、贡献摘要、损坏/缺失包状态；
- `server/services/plugin-runtime.ts`：Content-Length framing、LocalProcessRunner、PluginRuntime 和 RuntimeSupervisor；
- `tests/server/services/plugin-package-store.test.ts`、`plugin-catalog.test.ts`、`plugin-runtime.test.ts`：共覆盖 9 + 2 + 13 项阶段 1 回归测试；
- `server/services/plugin-state-store.ts`：受限 JSON state/journal、原子写入、损坏恢复和 fail-closed 诊断；
- `server/services/plugin-manager.ts`：per-plugin lifecycle mutex、install/enable/disable/activate/deactivate/uninstall、恢复和 quarantine；
- `server/services/plugin-contribution-registry.ts`：静态 Contribution Registry 与 ActivationIndex；
- `server/routes/plugins.ts`：核心拥有的管理/诊断 API，列表摘要脱敏和管理员写操作门禁；
- `server/app.ts`、`server/main.ts`：静态路由挂载、异步恢复、feature flag 和优雅关闭接入；
- `tests/fixtures/plugins/runtime/fixture.ts`：normal、notify、slow、crash、malformed 运行时 fixture。

**[边界]** 阶段 1 使用宿主管理的受限 JSON state/journal，不新增 SQLite 表；Provider/Public API、Secret、Storage、UI 和 Podman runner 继续由阶段 2–4 完成。

### 6.3 阶段验收

- **[建议] S1-F01** 安装包只完成路径/摘要/签名/Manifest/兼容检查；未启用或未激活前不会执行插件入口。
- **[建议] S1-F02** 同一插件的 install/enable/disable/activate/deactivate/uninstall 幂等；并发控制是 per-plugin，不使用全局锁阻塞其他插件。
- **[建议] S1-F03** Manifest ID、运行时 `hello` ID、包摘要和版本不一致时 fail closed。
- **[建议] S1-R01** 参考插件崩溃、stdout 混入日志、错误 frame、超时和拒绝取消时，核心 API/WS/SQLite 仍可用。
- **[建议] S1-R02** 迟到旧 generation 消息不会影响新运行时；重启使用抖动退避和 quarantine。
- **[建议] S1-P01** 单插件的 frame、stderr、在途请求、队列和重启次数均有硬上限；所有上限触发都能快速失败。
- **[建议] S1-S01** 运行时环境不含 JWT、数据库路径、settings 文件、完整环境变量和 provider secret；stdout 只允许协议，日志走 stderr。
- **[建议] S1-O01** NarraFork 在所有插件 disabled、incompatible、quarantine 或包损坏时仍能启动并打开管理页面。
- **[建议] S1-O02** 重启后可从 journal 恢复到“已安装/已启用/升级中/卸载中”之一，不依赖内存猜测磁盘状态。

### 6.4 测试策略

- **[建议]** RPC 契约测试：逐字节拆包、单 chunk 多 frame、超长 header/body、非法 JSON、未知 method、notification 与 response 交错。
- **[建议]** 进程测试：spawn 超时、握手超时、退出码、signal、孤儿子进程、Windows 进程树清理、stderr ring。
- **[建议]** 状态机测试：重复 enable/disable、升级中重启、卸载中断、quarantine retry、旧 generation late message。
- **[建议]** 混沌测试：随机 kill 插件、暂停 stdout、制造大输出、损坏包目录、在 journal 每一步强制重启。
- **[建议]** 负载测试：多个插件并行冷启动，验证控制面取消/健康检查不被数据面队列饿死。

### 6.5 迁移风险

- **[建议]** Plugin Manager 元数据可采用核心 SQLite 中的新增表或独立 metadata file；路线图要求通过抽象 `PluginStateStore` 隔离选择，不能让插件直接访问。
- **[待决策]** 若选择核心 SQLite，必须遵循 `schema.ts → bun run db:generate → bun run db:migrate`，不得手改 `drizzle/`；迁移应只做 additive tables/columns。
- **[建议]** journal 必须支持“旧版本核心不认识新状态”时的安全降级：保留包但不激活，不删除用户数据。

### 6.6 发布与回滚

- **[建议]** 以隐藏 feature flag 发布；默认 `plugins.enabled=false` 或仅启用内置测试插件。
- **[建议]** 发布前做“核心启动 + 插件全部损坏”演练；发布后只对内部管理员启用。
- **[建议]** 回滚核心版本时先停用插件；保留包与 journal，旧核心只读取它能识别的状态，未知插件显示为不可用，不自动执行。
- **[建议]** 回滚插件包使用旧 `current` 指针和旧授权快照；不能原地覆盖版本目录。

---

## 7. 阶段 2：公共 API、权限、存储、Tool/Command/Event 与 MCP

### 7.1 输入

- **[事实]** 当前数据库和 service 边界较宽，查询中存在大字段和主线程性能约束；插件不可直接拿 DB/Drizzle/service。
- **[事实]** 内部 `eventBus` 是服务解耦机制，但不是稳定公共协议。
- **[事实]** MCP 已有连接、工具发现、调用取消和重连实现。
- **[建议]** 阶段 1 的 Runtime Supervisor、Capability Broker 身份绑定、审计和限额已经稳定。

### 7.2 输出

- **[建议]** Query/Command/Event/Storage/Config/Secret/Log/Scheduler 公共 Host API 的最小 v1 子集。
- **[建议]** `ToolRegistry`、`CommandRegistry`、`PublicEventGateway`、`PluginStorage`、`SecretBroker`。
- **[建议]** 插件工具经过核心 schema/权限/设备/超时/审计；插件命令表达业务意图而不是 service method。
- **[建议]** 公共事件默认 at-most-once 在线投递，事件丢失后通过 cursor query/状态对账恢复。
- **[建议]** MCP 适配：插件可以声明 MCP bridge/server 贡献，但连接、重连、工具列表变化和取消仍归 `McpManager` 或宿主代理。

### 7.3 阶段验收

- **[建议] S2-F01** 插件可执行一个白名单 Query、一个白名单 Command、一个 Tool、一个 Event subscription 和一个 Storage CRUD；每个贡献可独立启用/禁用/授权。
- **[建议] S2-F02** Query 使用 cursor + `LIMIT n + 1` 语义，列表默认不读取 `raw_dump_json`、`output_json`、`content_json` 等大字段；详情/文件读取有独立上限。
- **[建议] S2-F03** Command 经过 Zod 参数校验、用户/后台 principal 绑定、resource scope、幂等键和审计；超时返回“结果未知”而不是自动重放。
- **[建议] S2-F04** Event Gateway 不把内部事件对象或同步 listener 暴露给插件；高频事件可合并/采样/丢弃，并发送 overflow/diagnostic。
- **[建议] S2-F05** storage namespace 固定为 plugin/user/scope resource 组合；配额、版本、迁移和 purge 均由宿主执行。
- **[建议] S2-S01** 权限有效集合遵循 `manifestRequested ∩ installationGrants ∩ hostPolicy ∩ currentUserAuthority ∩ currentInvocationScope`；任何一层不可用都 fail closed。
- **[建议] S2-S02** secret 只能通过 Secret Broker/临时注入获得，不能写入日志、UI storage、命令行或持久化插件配置明文。
- **[建议] S2-S03** Tool 插件无法改变核心权限决定、工具 schema、目标设备或调用者身份。
- **[建议] S2-P01** Event、日志、scheduler 和 storage 均有 per-plugin/per-user 配额；事件投递不阻塞核心事件发布线程。
- **[建议] S2-M01** MCP server 断线、tool list changed、call cancellation 和权限拒绝仍符合现有 MCP 语义；插件崩溃不会导致全部 MCP server 下线。

### 7.4 Public Event/Query 最小契约

- **[建议]** Query ID 使用稳定命名空间，例如 `narrafork.narrators.list`、`narrafork.chapters.getSummary`；不开放任意 SQL、service 名称或 route path。
- **[建议]** Command ID 使用 `narrafork.*` 或 `plugin.<pluginId>.*`；核心命令负责事务和事件发布，插件只获得 DTO。
- **[建议]** Event topic 使用 `narrafork.<domain>.<event>`；字段带 `schemaVersion`、时间、correlation ID 和资源摘要；不透传完整消息内容、JWT、secret 或 raw eventBus payload。
- **[建议]** 可靠消费场景采用 Query cursor、updatedAt 或任务资源对账；不要把 at-most-once event 假设成永久队列。
- **[建议]** UI bridge 的 subscribe 只是公共事件投递适配器，权限和 schema 仍由服务端/Capability Broker 二次检查。

### 7.5 MCP 适配边界

- **[建议]** 第一版只支持两种受控形式：
  1. `mcp.bridge`：把插件已声明的工具以 MCP-compatible descriptor 暴露给现有 `ToolRegistry`；
  2. `mcp.server`：由宿主按 Manifest 生成受监管的 MCP server 配置并交给 `McpManager` 管理。
- **[建议]** 插件不得直接持有核心 `McpManager`、MCP transport、原始 `eventBus` 或其他插件的 MCP server identity。
- **[建议]** MCP tool input/output 仍需要宿主 schema、字节、超时、取消和审计限制；MCP 本身不替代 NarraFork capability grants。
- **[待决策]** 是否允许插件声明远端 MCP URL。推荐阶段 2 仅允许宿主管理员配置的远端/本地目标，插件 Manifest 不得偷偷引入任意网络目标。

### 7.6 测试策略

- **[建议]** Query/Command contract tests：权限交集、分页边界、大字段摘要、幂等键、用户权限变更、结果未知。
- **[建议]** Event tests：过滤、去重、合并、背压、overflow、订阅撤销、插件禁用、用户退出、重启后 cursor 对账。
- **[建议]** Storage tests：scope 隔离、配额、并发写、版本迁移、升级失败、卸载保留与 purge；验证无法构造其他 pluginId namespace。
- **[建议]** Secret tests：日志扫描、错误/trace 脱敏、UI/iframe 不可见、撤销后旧句柄失效。
- **[建议]** MCP integration tests：连接/断线/重连、tool list changed、call cancel、超大结果、插件重启和现有 `syncMcpTools()` 回归。

### 7.7 迁移风险

- **[建议]** 插件元数据和 storage 表必须采用独立命名空间；不得把插件 JSON 直接塞入核心 `contentJson`、`outputJson` 或其他大字段。
- **[建议]** 核心 schema 迁移只做新增表/列；所有迁移前后应有备份、journal 和 smoke test。严格遵循仓库数据库迁移规则，不删除用户数据库或 `drizzle/`。
- **[建议]** 公共 Query DTO 不应暴露现有内部 row 形状，避免未来表迁移把插件协议绑死。
- **[待决策]** 插件 storage 采用核心 SQLite 分区表还是每插件独立 SQLite/文件存储。推荐首版使用宿主管理的核心存储抽象，后续可替换实现而不改插件 API。

### 7.8 发布与回滚

- **[建议]** Beta 默认只开放只读 Query、无 secret 的 Tool 和低风险 Event；Command、后台和文件/网络能力按管理员显式开启。
- **[建议]** 迁移前自动备份插件 metadata/storage；失败时回滚 journal，不回滚已经成功执行且有副作用的 Command。
- **[建议]** 插件升级时先撤销新版本 grant，旧版本继续保持可回滚；只有新版本 health check 通过后才提交。
- **[建议]** MCP 适配失败只标记对应 contribution unavailable，不影响现有 MCP server 和核心 Agent Loop。

---

## 8. 阶段 3：Provider RPC 与 Agent Loop 接入

### 8.1 输入

- **[事实]** `ProviderAdapter` 的历史、工具、流、usage、reasoning、生成和取消语义已在当前代码存在。
- **[事实]** `04-server-rpc-and-provider.md` 已细化 `provider.describe`、`validateConfig`、`listModels`、`provider.chat`、`provider.generate`、`provider.event`、`provider.cancel`、credit/ACK 和错误映射。
- **[建议]** 阶段 1 的 stdio RPC、阶段 2 的审计/权限/资源限制可复用，不再为 provider 另造一套进程监管。

### 8.2 输出

- **[建议]** Provider Registry 把 builtin、compatible API 和 executable plugin 统一到一个解析入口。
- **[建议]** `RemoteProviderAdapter` 在核心构造 canonical history/tools，插件只接收规范化 DTO。
- **[建议]** Provider RPC v1 支持 text/reasoning/tool/usage/error/done、取消、deadline、credit window 和 last-known-good model catalog。
- **[建议]** provider plugin 的工具调用始终回到核心 Agent Loop，插件不能自行执行 NarraFork tool。

### 8.3 阶段验收

- **[建议] S3-F01** `describe`、config validation、model list、chat、generate、cancel 的 happy path 和错误 path 均有契约测试。
- **[建议] S3-F02** `RemoteProviderAdapter` 能映射现有 `ProviderAdapter` 方法，Agent Loop 无需知道插件 RPC 细节。
- **[建议] S3-F03** 同一 operation 的 event `seq` 严格递增，`done` 是最后一个事件且只能出现一次；done 后事件被丢弃并记录违规。
- **[建议] S3-F04** 工具参数跨 chunk、JSON escape 跨 chunk、reasoning continuation、usage snapshot 和 stopReason 均能正确处理。
- **[建议] S3-R01** `AbortSignal` 在请求前、accepted 前、`request_started` 前、流中和 shutdown 时都可取消；插件不响应时按宽限期 kill。
- **[建议] S3-R02** credit 耗尽会暂停插件输出；terminal reserve 保证 error/done 可到达；超 credit 的插件被终止/隔离。
- **[建议] S3-R03** provider 进程在 tool call 已暴露后崩溃，不自动重放整个请求；Agent Loop 保留部分结果并给出结构化 diagnostics。
- **[建议] S3-P01** provider 流不会把累计全文逐 chunk 广播；有单事件、单 operation、frame、并发、总时长和 stderr 上限。
- **[建议] S3-S01** provider 插件收不到 JWT、数据库 ID、权限审批者、完整 cwd、完整 `ToolContext` 或其他 provider instance secret。
- **[建议] S3-O01** 现有 builtin/compatible API provider resolution、aggregation、history、reasoning、abort 和错误测试保持通过，插件 provider 不改变默认优先级。

### 8.4 Provider 关键实现顺序

1. **[建议]** 先实现 frame parser、RPC client、credit window 和 operation registry。
2. **[建议]** 再实现 `describe`/`validateConfig`/`listModels` 与缓存，不先改 Agent Loop。
3. **[建议]** 实现 canonical history/tools builder，建立 provider mock fixture。
4. **[建议]** 实现 `RemoteProviderAdapter.generate`，用它验证 unary/stream/usage/error 基础。
5. **[建议]** 实现 `chat`、tool call、reasoning metadata、done/late event。
6. **[建议]** 最后接入 Provider Registry、settings resolution、UI model list 和生产 feature flag。

### 8.5 测试策略

- **[建议]** 复用现有 provider mock 测试风格，覆盖文本、reasoning、工具调用、usage、空响应、max output、错误和 provider switch。
- **[建议]** 取消与超时测试：cancel response/done 乱序、signal 已 aborted、首事件超时、空闲超时、强制 kill、旧 operation late event。
- **[建议]** 背压/上限测试：event/byte credit、terminal reserve、frame/参数/累计文本上限、高频小 delta 合并。
- **[建议]** 故障测试：工具调用前后进程退出、协议错误熔断、重启后的 runtime generation、重复 provider prefix。
- **[建议]** 回归测试：所有现有 provider resolution、custom API migration、aggregation、history、abort、reasoning、error handling。

### 8.6 迁移风险

- **[建议]** Provider Registry 引入时不得直接删除 `createProviderByName()`；先以 adapter/registry 兼容层并行，验证后再逐步收敛。
- **[建议]** provider prefix 不允许“后注册覆盖”；内置、兼容 API 和插件共用唯一命名空间，避免设置/历史/aggregation 引用歧义。
- **[建议]** `ReasoningProviderMetadata` 如需通用 plugin continuation 字段，先做兼容的可选字段；旧消息读取必须忽略未知字段。
- **[建议]** model catalog 采用异步缓存，不在同步 `getVisibleModels()` 请求路径 spawn 插件或访问网络。

### 8.7 发布与回滚

- **[建议]** Provider plugin 默认关闭；可按 provider instance 灰度，允许保留 builtin/compatible fallback。
- **[建议]** model list 失败时显示 last-known-good/stale catalog，但实际 chat 前必须确认运行时和配置可用。
- **[建议]** provider plugin 失败时只回滚该 provider registry entry，不回滚全部 Agent Loop 或其他 provider。
- **[建议]** provider 包升级采用 staging → describe/health → 切换；新包未通过 health 时恢复旧包和旧 model catalog。

---

## 9. 阶段 4：UI iframe、Dockview 与发布硬化

### 9.1 输入

- **[事实]** `DockviewSurface`、`NarratorDock`、`DockviewWorkspace` 已使用 `defaultRenderer="always"`，并且 workspace director 是 overlay。
- **[事实]** `05-ui-bridge-and-dockview.md` 已定义 sandbox iframe、MessageChannel、`PluginDockPanelParams`、focus/workspace binding、缺失占位和静态 route 边界。
- **[建议]** 阶段 2 的 Public Query/Command/Event/Storage 和 Capability Broker 已能被 UI bridge 复用。

### 9.2 输出

- **[建议]** host-controlled shell、版本/hash asset route、严格 CSP 和 sandbox iframe。
- **[建议]** 每 panel instance 一个 `MessageChannel`、nonce、session binding、UI protocol、取消、heartbeat 和有界事件队列。
- **[建议]** focus/workspace 的静态 `PluginDockPanel`、layout persistence、missing/disabled/denied/incompatible/crashed placeholder。
- **[建议]** director 复用同一个 iframe：优先实现 `PluginUiLayer`/slot；若延期，必须明确 grid-only 降级。
- **[建议]** settings section、command palette、toolbar 等声明式 contribution；不开放 React、DOM、CSS、Route 或 Module Federation 注入。
- **[建议]** 可选 `PodmanRunner`、签名/SBOM、跨平台发布、回滚和运维指标。

### 9.3 阶段验收

- **[建议] S4-F01** focus panel 拖动、tab 隐藏、split/swap/merge 后 iframe、port、panel session 不重建；context/visibility 只发事件。
- **[建议] S4-F02** workspace 中 narrator A/B 的 panel 使用独立 `ownerNarratorId`、context、storage namespace 和 event filter，不串号。
- **[建议] S4-F03** 缺失、禁用、权限撤销、contribution rename、协议不兼容、iframe crash 和 viewState migration failure 均保留布局并显示可恢复占位。
- **[建议] S4-F04** director 进入/退出不双挂载 iframe；若使用降级方案，点击插件 panel 会明确回到 grid，不丢失 session/state。
- **[建议] S4-S01** hostile iframe 无法读取 JWT/localStorage/parent DOM、直接 fetch 受保护 API、访问 `DockviewApi`/Router/QueryClient 或注册 React/route。
- **[建议] S4-S02** 静态资源无用户数据，entry/style 只来自安装包相对路径，禁止 `data:`、`file:`、`javascript:`、远程 CDN 和动态远程 script。
- **[建议] S4-P01** UI RPC/request/response/event 有 byte、timeout、queue、iframe count 和 notification 速率上限；不可见 panel 默认暂停非关键事件。
- **[建议] S4-P02** iframe reload、route unmount、panel remove、插件 disable/uninstall、用户退出均释放 port、请求、订阅、通知、observer 和资源。
- **[建议] S4-O01** static TanStack route tree 不变；所有插件入口通过预置 route/`PluginDockPanel`/settings route，不动态写入 `frontend/routes`。
- **[建议] S4-O02** `bun run build`、生产静态服务、PWA/缓存和版本升级不会把旧插件资源误当成新版本资源。

### 9.4 UI 实现顺序

1. **[建议]** 先注册静态 `plugin` component 与 params schema，完成 missing placeholder 和布局恢复。
2. **[建议]** 再做 host-controlled shell、sandbox/CSP、asset route 和最小 handshake。
3. **[建议]** 实现 panel/context/lifecycle、storage session/device、notifications。
4. **[建议]** 接入 Public Query/Command/Event 和 backend proxy 的服务端二次鉴权。
5. **[建议]** 接入 focus/workspace singleton、多 narrator binding 和 `panels.open`。
6. **[建议]** 实现 director `PluginUiLayer`；若验证失败，保留明确 grid-only feature flag。
7. **[建议]** 最后开放 settings/command palette/toolbar contribution 与跨平台发布硬化。

### 9.5 测试策略

- **[建议]** 浏览器安全测试：sandbox flags、CSP、opaque origin、parent DOM、token/localStorage、直接 fetch、postMessage nonce/source 校验。
- **[建议]** Dockview E2E：拖拽、隐藏、split/swap/merge、director、workspace reload、layout corruption、plugin missing/reinstall/rename。
- **[建议]** 多 narrator E2E：focus current narrator、workspace narrator-scoped、global/workspace aggregate query/event。
- **[建议]** 生命周期测试：iframe reload、port messageerror、heartbeat、RPC timeout/cancel、event overflow、plugin disable/uninstall。
- **[建议]** 资源测试：大量 panel、visibility pause、`ResizeObserver`/animation-frame 合并、layout/viewState 上限、旧资源回收。
- **[建议]** 跨平台测试：Windows/macOS/Linux 的 asset path、LocalProcessRunner、Podman 可用/不可用、开发代理和生产静态服务。

### 9.6 迁移风险

- **[建议]** `WorkspacePanelParams` 增加 plugin union 时使用静态 component key；不能让未知 component 使 Dockview `fromJSON()` 整体失败。
- **[建议]** focus layout 仍以 live narrator context 为身份真值，不持久化 focus narratorId/chapterId；workspace narrator panel 持久化 `ownerNarratorId`。
- **[建议]** viewState 采用有版本、小字节、JSON-only、可恢复副本；迁移失败显示 placeholder，不阻塞 workspace。
- **[待决策]** workspace envelope 是否因 plugin union/恢复索引升级版本；推荐只要 outer schema 改变就显式升级，否则保持向后兼容并增加校验。
- **[建议]** UI asset cache 以 plugin/version/content hash 命名空间隔离，卸载/回滚时清理对应缓存，不清空全局 PWA 缓存。

### 9.7 发布与回滚

- **[建议]** UI contribution 默认只在 desktop Dockview surface 展示；移动端没有对应 surface 时隐藏入口，不生成不可达 route。
- **[建议]** 首次发布以内部测试插件和只读 UI API 灰度；写 Command、backend.call、secret 和外部网络能力单独开关。
- **[建议]** UI 包升级先保留旧 asset/current 指针；新 iframe handshake、CSP 和 viewState migration 健康后才提交。
- **[建议]** UI 回滚优先恢复旧 version/hash 与旧 layout alias；无法恢复时保留缺失占位和原始 viewState recovery copy。
- **[建议]** Podman 不可用时不静默降级为“安全沙箱”；明确显示 LocalProcessRunner 是故障隔离而非强安全隔离。

---

## 10. 横向验收门槛

### 10.1 功能门槛

- **[建议] G-F01** 管理员可安装、检查、启用、禁用、升级、回滚、卸载；所有操作幂等并可诊断。
- **[建议] G-F02** provider、tool、command、event、view、storage、MCP contribution 可独立发现、授权和禁用。
- **[建议] G-F03** 插件可通过 Public Query/Command/Event/Storage 完成示例工作流，不导入 `server/*` 内部模块。
- **[建议] G-F04** UI 可通过 iframe bridge 打开/恢复 panel，缺失插件不会破坏 Dockview layout。

### 10.2 性能与主线程门槛

- **[建议] G-P01** 插件代码、JSON 大对象转换、文件/网络长任务不在 Bun 核心主线程同步执行。
- **[建议] G-P02** 所有跨进程/iframe 请求有 timeout、cancel、byte/frame/queue/concurrency/output 限制。
- **[建议] G-P03** 事件和 provider stream 不广播累计全文；高频 delta 必须合并/节流并处理 backpressure。
- **[建议] G-P04** Query/列表默认分页、摘要优先、无无界 `.all()`；大字段需详情或流式接口。
- **[建议] G-P05** 插件全部禁用时核心基线性能无显著回退；启用插件的额外 p95、RSS、队列和事件循环 stall 有指标。

### 10.3 安全门槛

- **[建议] G-S01** 第三方后端默认进程外；高风险 T2 支持/推荐 Podman；本地子进程明确标示弱隔离。
- **[建议] G-S02** 插件不获得 DB、Drizzle、SQLite path、raw eventBus、JWT、内部 service、完整 ToolContext 或任意 API fetch。
- **[建议] G-S03** Manifest requested capability 永远不能绕过 installation grant、host policy、user authority 或 invocation scope。
- **[建议] G-S04** UI iframe 为 `sandbox="allow-scripts"` 基线，不含 `allow-same-origin`、JWT、Cookie、secret 或 parent DOM 能力。
- **[建议] G-S05** 所有高风险调用可审计，日志和 diagnostics 深度脱敏；secret 不进入参数 dump、stderr、storage 或通知。

### 10.4 可靠性与运维门槛

- **[建议] G-R01** 单插件崩溃、协议错误、资源超限和 UI crash 不会导致核心退出或全局 API 无响应。
- **[建议] G-R02** 升级采用 staging/health/atomic switch/rollback；存储迁移有 journal、备份和不可逆提示。
- **[建议] G-R03** quarantine、重启预算、旧版本、授权快照和诊断信息可由管理员查看和操作。
- **[建议] G-R04** 核心启动不等待非关键插件；优雅退出对插件 drain/deactivate/shutdown 有硬超时。
- **[建议] G-R05** 发布支持 kill switch、按插件回滚、按 contribution 禁用和全部插件 emergency disable。

---

## 11. 测试金字塔与验收样例

### 11.1 测试层级

1. **[建议] Schema/静态层**：Manifest、ID、权限、版本、资源路径、viewState、query/command/event DTO。
2. **[建议] 协议层**：framing、JSON-RPC、UI bridge、provider event、cancel、credit、error。
3. **[建议] 宿主单元层**：状态机、registry、capability broker、storage、event gateway、adapter mapping。
4. **[建议] 进程/浏览器集成层**：真实子进程、iframe、Dockview、MCP、provider mock、升级 journal。
5. **[建议] E2E/混沌层**：管理员安装到业务调用全链路、崩溃、网络断开、权限撤销、回滚和恢复。
6. **[建议] 性能/安全层**：多插件并发、事件风暴、超大 payload、恶意 UI、主线程 stall、资源泄漏。

### 11.2 最小验收插件矩阵

| Fixture | 用途 | 必须覆盖 |
|---|---|---|
| `hello-tool` | 最小 tool/command/event/storage | 阶段 2 happy path |
| `slow-plugin` | timeout/cancel/backpressure | 阶段 1–4 资源边界 |
| `crash-plugin` | exit/restart/quarantine | 阶段 1/发布回滚 |
| `malformed-plugin` | Manifest/RPC/seq/credit 错误 | 安全与协议 |
| `provider-echo` | text/tool/reasoning/usage/done | 阶段 3 adapter |
| `provider-stateful` | sticky session/cancel/no replay | 阶段 3 Agent Loop |
| `mcp-bridge` | tool list changed/call cancel | 阶段 2 MCP |
| `ui-panel` | iframe/bridge/Dockview/director | 阶段 4 UI |
| `hostile-ui` | token/DOM/fetch/CSP 攻击 | 阶段 4 安全 |
| `migration-plugin` | storage/viewState upgrade/rollback | 阶段 2/4 发布 |

### 11.3 验收证据

- **[建议]** 每个阶段以测试报告、诊断截图/fixture 日志、性能对比、失败注入结果和回滚演练记录作为证据，而非只以“代码已合并”作为完成条件。
- **[建议]** 任何 protected/高风险任务只有在成功执行对应失败路径和回滚路径后才能标记完成。
- **[待决策]** GA 是否要求至少 Windows + Linux + macOS 三平台全通过。推荐至少 Windows/Linux 为阻塞平台，macOS 为发布前验证平台。

---

## 12. 迁移与兼容总策略

### 12.1 核心数据库

- **[事实]** 仓库严格要求数据库结构修改走 `server/db/schema.ts` → `bun run db:generate` → `bun run db:migrate`，禁止手改 `drizzle/`，禁止自行删除用户数据库。
- **[建议]** 插件阶段新增核心表时只做 additive migration；迁移失败要修复顺序/约束并保留用户数据，不能通过删除数据库解决。
- **[建议]** 插件数据迁移具有独立 `pluginStorageSchemaVersion` 与 journal；核心迁移和插件迁移不能混在一个不可恢复的大事务中执行第三方代码。

### 12.2 API/协议

- **[建议]** Manifest、Host API、RPC、UI 各自有 major/minor；同一 major 只增加可选字段和能力，破坏语义升 major。
- **[建议]** 新核心至少保留一个旧 Host API/RPC major 的兼容窗口；不兼容插件可安装保留但不可激活。
- **[建议]** contribution rename 使用 alias/migration 表；静态 ID 不因显示名改变。

### 12.3 配置与模型引用

- **[建议]** provider prefix、model catalog、settings、aggregation 和历史引用迁移必须复用现有 provider prefix migration 机制，不能让插件通过“后注册覆盖”解决冲突。
- **[建议]** provider 不可用时保留 last-known-good catalog 和配置引用，UI 显示 disabled/unavailable，而不是静默改写用户模型选择。

### 12.4 Dockview/layout

- **[建议]** 未知插件 panel 使用静态 `plugin` component 和 placeholder；绝不因插件缺失让 `fromJSON()` 整体失败或静默丢 panel。
- **[建议]** viewState 小、JSON-only、有版本和 recovery copy；插件卸载默认保留布局引用与 storage，purge 必须显式确认。

---

## 13. 发布列车与回滚 Runbook

### 13.1 发布前清单

- **[建议]** Manifest/schema/RPC/UI protocol fixtures 全绿。
- **[建议]** 核心 provider/MCP/Agent Loop/Dockview 回归全绿。
- **[建议]** 失败注入：插件 kill、超时、超 credit、权限撤销、secret 错误、UI crash、数据库迁移中断。
- **[建议]** 生成 SBOM、包摘要/签名验证、安装目录权限检查、资源配额和默认 runner 检查。
- **[建议]** 完成一次升级→health→回滚，及核心版本回滚→插件不可用占位演练。

### 13.2 灰度顺序

1. **[建议]** 核心内部环境：全部插件 disabled，仅验证启动和管理 API。
2. **[建议]** 内部管理员：`hello-tool`、`crash-plugin`、只读 UI。
3. **[建议]** Beta：低风险 Query/Event/Tool，明确不授予 secret、网络、文件和后台权限。
4. **[建议]** Provider Beta：单 provider instance、保留 builtin fallback。
5. **[建议]** RC：UI Dockview/director、storage migration、MCP bridge、Podman profile。
6. **[建议]** GA：默认仍 deny 高风险能力，管理员按插件/贡献逐项授权。

### 13.3 回滚级别

| 级别 | 操作 | 适用情况 |
|---|---|---|
| L0 | 禁用单 contribution | 单个 tool/provider/view 故障 |
| L1 | quarantine 单插件并恢复旧包 | 插件崩溃/协议错误/资源超限 |
| L2 | 全局 kill switch | 插件平台造成核心性能/安全异常 |
| L3 | 回滚插件 metadata/storage migration | 插件数据迁移失败 |
| L4 | 回滚核心版本，保留插件包但禁止激活 | Host API/核心集成回归 |
| L5 | 恢复备份并人工处置 | 仅在迁移/存储损坏且有明确备份证据时 |

- **[建议]** L5 不得自动触发，不删除用户数据库，不删除 `drizzle/`。
- **[建议]** 所有回滚动作必须写诊断事件、保留 correlation ID，并明确“副作用结果未知”的 Command 不自动重放。

---

## 14. 阶段完成定义（Definition of Done）

一个阶段只有同时满足以下条件才算完成：

1. **[建议]** 设计协议、Manifest、权限和状态与 `10-open-questions-and-decisions.md` 的 accepted/proposed ADR 一致。
2. **[建议]** 代码具备对应单元、契约、集成、失败注入和回归测试；高风险阶段还有安全和性能证据。
3. **[建议]** 具备 feature flag、诊断、kill switch 和至少一条可验证回滚路径。
4. **[建议]** 不违反核心主线程性能规则，不暴露 DB/raw eventBus/JWT，不手改 drizzle，不把第三方代码放进核心事务。
5. **[建议]** 文档、fixture、迁移说明、发布清单和运维 runbook 可由未参与实现的维护者复现。
6. **[待决策]** 是否要求每阶段由独立安全评审签字。推荐阶段 1、2、4 必须，阶段 3 provider RPC 至少进行专门协议/secret 评审。

---

## 15. 与其他设计文档的交叉引用与冲突处理

- **[建议]** `01` 定义边界与可信等级，`02` 定义宿主/生命周期，`04` 定义 Provider RPC，`05` 定义 UI iframe/Dockview；本文件不重新发明字段，只将它们排入阶段和验收。
- **[建议]** 如果 Manifest 文档、权限文档、事件/数据模型文档后续与本路线图冲突，以最终整合文档和 `10` 中 accepted ADR 为准，并在本文件更新任务依赖。
- **[待决策]** 目前缺少已完成的 `03`、`06`、`07`、`08` 文档，因此权限最终命名、数据表名、事件 topic 和签名根仍不能视为冻结；阶段 0 的 P0-03/P0-04/P0-09 是阻塞任务。
- **[建议]** 任何实现 PR 都应在描述中引用对应任务 ID、验收 ID、测试证据和回滚级别；未满足依赖的任务不得通过临时兼容代码“提前完成”。
