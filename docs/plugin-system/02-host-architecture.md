# NarraFork 插件系统：宿主架构

> 文档定位：在《01-requirements-and-boundaries.md》的边界内，定义核心宿主、Plugin Manager、独立进程、生命周期、激活、兼容、故障恢复、背压以及升级/卸载的总体架构。字段级 Manifest、JSON-RPC、权限、UI 和数据表细节由后续专题文档展开。

## 标记约定

- **[当前事实]**：可由当前仓库代码或现有设计文档直接确认。
- **[设计建议]**：本轮建议采用的目标架构或约束。
- **[假设]**：为了形成可执行设计而暂时采用、但尚未正式确认的前提。
- **[待决策]**：需要后续 ADR 或整合阶段明确的事项。

## 1. 架构定位

- **[当前事实]** `server/main.ts` 已承担组合根和运行时监管职责：启动 HTTP/WS 后，再异步初始化 MCP、恢复任务、Gateway、调度器和容器代理；退出时对多个子系统逐项设置硬超时。
- **[当前事实]** `server/app.ts` 通过静态路由挂载保持认证顺序和全局错误处理可审计。
- **[当前事实]** 现有 `McpManager` 证明“连接状态 + 工具发现 + 断线重连 + shutdown”可以在核心管理器中实现，但其重连次数、工具模型和协议均是 MCP 专用。
- **[当前事实]** 内置 provider 适配器运行在核心进程并暴露较宽的进程内接口，不适合作为第三方插件模板。
- **[设计建议]** 插件架构应增加一个宿主控制面，而不是把动态加载逻辑散落到 `main.ts`、provider resolution、工具注册、路由和各 service 中。

## 2. 总体结构

### 2.1 分层图

**[设计建议]** 采用“核心主进程控制面 + 独立插件运行时 + 公共 API 门面”的结构：

```text
┌──────────────────────────────── NarraFork Core Process ────────────────────────────────┐
│                                                                                         │
│  server/main.ts                  server/app.ts                 Agent / Core Services     │
│  ┌────────────────┐             ┌────────────────┐            ┌──────────────────────┐  │
│  │ Composition    │             │ Static Plugin  │            │ Narrator / Chapter / │  │
│  │ Root           │             │ Management API │            │ Provider / Tool Core │  │
│  └───────┬────────┘             └───────┬────────┘            └──────────┬───────────┘  │
│          │                              │                                │              │
│  ┌───────▼──────────────────────────────▼────────────────────────────────▼───────────┐  │
│  │                              Plugin Manager                                      │  │
│  │ Catalog │ Package Store │ State │ Activation Index │ Upgrade/Uninstall Coordinator│  │
│  └───────┬──────────────────────────────┬───────────────────────────────┬────────────┘  │
│          │                              │                               │               │
│  ┌───────▼────────┐          ┌──────────▼──────────┐         ┌──────────▼───────────┐   │
│  │ Runtime        │          │ Contribution       │         │ Capability Broker /  │   │
│  │ Supervisor     │          │ Registries         │         │ Public Host API      │   │
│  │ spawn/restart  │          │ provider/tool/view │         │ query/cmd/event/...  │   │
│  └───────┬────────┘          └──────────┬──────────┘         └──────────┬───────────┘   │
│          │ JSON-RPC/stdio               │ host-owned proxies                       │    │
└──────────┼───────────────────────────────┼───────────────────────────────────────────┼────┘
           │                               │                                           │
   ┌───────▼────────┐              ┌───────▼────────┐                         ┌────────▼───────┐
   │ Plugin A       │              │ Plugin B       │                         │ UI iframe      │
   │ isolated proc  │              │ isolated proc  │                         │ MessageChannel │
   └────────────────┘              └────────────────┘                         └────────────────┘
```

### 2.2 控制面与数据面

- **[设计建议] 控制面** 包括安装、签名/兼容检查、授权、启停、状态机、激活、监管、升级、回滚和卸载。只有 Plugin Manager 可以改变插件期望状态。
- **[设计建议] 数据面** 包括 provider 流、工具执行、查询、命令、事件、日志和 UI Bridge 调用。所有数据面请求都通过 Capability Broker 和有界 RPC 通道。
- **[设计建议]** 控制面故障不能静默放宽数据面权限；无法加载授权或身份时应 fail closed。
- **[设计建议]** 数据面拥塞不能阻塞控制面取消、停止和健康检查；协议实现应为控制消息预留队列/优先级。

## 3. 核心宿主组件

### 3.1 Core Host

- **[设计建议]** Core Host 不是一个可被插件 import 的对象，而是一组仅在核心进程组装的门面和注册表。
- **[设计建议]** Core Host 持有内部 service、数据库、事件总线和认证实现，并将其映射为版本化 DTO。
- **[设计建议]** Core Host 负责最终校验和副作用。插件只能请求“做什么”，不能决定“以谁的身份”“绕过哪条权限”“在哪个事务里做”。

### 3.2 Plugin Manager

**[设计建议]** Plugin Manager 是唯一插件控制面入口，职责拆分如下：

| 子组件 | 职责 | 不负责 |
|---|---|---|
| `PluginCatalog` | 扫描已安装包、读取 Manifest、形成插件/贡献索引 | 不执行插件代码 |
| `PackageStore` | staging、校验、版本目录、原子切换、旧包保留 | 不管理运行时调用 |
| `PluginStateStore` | 期望状态、授权、当前版本、崩溃预算、升级 journal | 不存放明文 secret |
| `CompatibilityChecker` | 检查 manifest、Host API、RPC、平台/架构 | 不通过动态执行探测兼容性 |
| `ActivationIndex` | 将 activation event 映射到插件和贡献 | 不直接 spawn 进程 |
| `ContributionRegistry` | 注册静态贡献并创建宿主代理 | 不信任插件覆盖核心 ID |
| `RuntimeSupervisor` | spawn、握手、健康、取消、重启、终止 | 不授予 capability |
| `CapabilityBroker` | 鉴权、作用域、限流、审计和 DTO 转换 | 不暴露内部对象 |
| `UpgradeCoordinator` | drain、切换、健康检查、回滚 | 不允许无 journal 的原地覆盖 |
| `Diagnostics` | 状态、错误、资源、队列、版本协商和审计摘要 | 不把 secret/敏感 payload 写日志 |

- **[设计建议]** Plugin Manager 对外提供方法应围绕控制面意图，例如 `install()`、`enable()`、`activate()`、`disable()`、`upgrade()`、`uninstall()`、`getStatus()`，而不是公开内部 Map。
- **[设计建议]** 同一插件的生命周期变更使用 per-plugin 异步互斥；不同插件可并行，避免全局锁拖慢启动和管理操作。
- **[设计建议]** 安装/升级/卸载使用持久化 journal，使主机在任一步骤崩溃后能判断继续、回滚或隔离，而不是猜测磁盘状态。

### 3.3 Contribution Registry

- **[设计建议]** contribution 按类型进入宿主持有的注册表：`ProviderRegistry`、`ToolRegistry`、`CommandRegistry`、`EventSubscriptionRegistry`、`ViewRegistry`。
- **[设计建议]** 注册表条目只保存静态元数据、插件 ID、贡献 ID、版本和一个宿主代理，不保存插件导出的函数对象。
- **[设计建议]** 插件未激活时，注册表仍可根据 Manifest 展示贡献；第一次调用代理时由 Activation Index 激活运行时。
- **[设计建议]** 插件失效或禁用时，注册表保留“不可用原因”而不是立即让引用消失，以便模型选择器、工作区布局和配置页面给出诊断。

### 3.4 Capability Broker 与 Public Host API

- **[设计建议]** Capability Broker 是所有“插件调用宿主”请求的单一入口，执行以下顺序：

```text
解析 plugin/runtime 身份
→ 校验协议与 request ID
→ 查 installation grants
→ 绑定当前用户/调用上下文
→ 校验 capability 与资源 scope
→ 校验参数、分页、字节和并发限制
→ 调用核心 Query/Command/Event/Storage/Secret 门面
→ 脱敏与限量结果
→ 写审计摘要
```

- **[设计建议]** 公共 API 分为 Query、Command、Event、Storage、Config、Secret、Log、Scheduler 等命名空间，每个命名空间独立版本化。
- **[设计建议]** Query 不直接返回 ORM row；Command 不直接映射任意 service 方法；Event 不透传内部事件对象。
- **[设计建议]** 所有 API 都支持 correlation ID；有副作用的 Command 支持幂等键或明确声明不可重试。

## 4. 与当前启动架构的集成

### 4.1 启动阶段

**[设计建议]** 不让第三方插件成为核心启动的前置条件，建议顺序如下：

1. **核心初始化**：保持数据库、settings、Git 状态、恢复 journal 等核心步骤先完成。
2. **Plugin Manager 恢复**：读取安装记录与未完成的安装/升级/卸载 journal。
3. **静态扫描**：只读取和校验 Manifest，构建兼容性、授权和 Activation Index，不执行插件代码。
4. **发布静态贡献**：向 provider/tool/view 等注册表加入宿主代理和不可用状态。
5. **绑定 HTTP/WS**：核心服务先可用；插件损坏不得阻止健康检查、登录或管理页面。
6. **异步启动激活**：仅对已启用且声明 `onStartup` 的插件执行激活，使用并发上限与独立超时。
7. **运行期懒激活**：provider/tool/command/view/event 第一次使用时按需启动。

- **[当前事实]** 当前 `main.ts` 已在 HTTP server 启动后异步初始化 MCP、恢复叙述者和其他非关键子系统，因此“先提供核心服务，再异步激活插件”与现有启动风格一致。
- **[设计建议]** `server/app.ts` 只需静态挂载宿主拥有的 `/api/plugins` 管理路由和可能的统一桥接路由；不动态执行插件路由注册。

### 4.2 优雅退出

- **[当前事实]** 当前优雅退出使用 `shutdownStep()` 给子系统硬超时，并继续后续退出步骤。
- **[设计建议]** Plugin Manager 应接入同一模式：停止接收激活和新调用 → 广播 drain → 取消可取消请求 → `deactivate` → `shutdown` → 超时后 kill。
- **[设计建议]** 插件退出失败只影响插件自身清理状态，不能阻止核心关闭 HTTP server、释放实例锁或写入数据库 clean marker。
- **[设计建议]** 下次启动根据 runtime lease/journal 将上次 active 进程视为已丢失，不假定插件完成了 deactivate。

## 5. 独立进程模型

### 5.1 默认进程单位

- **[设计建议]** 默认“一插件一后端进程”。一个插件的多个 contribution 共享该进程，但不同插件不得共享进程。
- **[设计建议]** UI iframe 与后端进程分别启停；纯 UI 插件可以没有后端进程，纯 provider 插件可以没有 UI。
- **[设计建议]** 不使用 Worker Thread 承载第三方代码，因为 Worker 与主进程共享更近的运行时和资源边界，无法满足最小故障隔离目标。
- **[假设]** 首个运行器使用 Bun/Node 可执行命令 + JSON-RPC over stdio；协议保持语言中立，未来可提供 Python/Rust SDK。

### 5.2 启动环境

- **[设计建议]** Runtime Supervisor 使用参数数组启动进程，不经 shell；工作目录、PATH 和环境变量采用 allowlist。
- **[设计建议]** 插件包目录只读，私有数据、缓存和临时目录分离，均由宿主提供明确路径与配额。
- **[设计建议]** 不把 JWT、数据库路径、核心 settings 文件或全部进程环境传给插件。运行时身份通过已绑定该子进程的 RPC 连接建立，不使用可复制的普通用户 token。
- **[设计建议]** stdout 专用于帧协议，stderr 进入限速日志采集；协议解析失败达到阈值后终止并隔离运行时。
- **[设计建议]** Runtime Supervisor 必须递归清理插件创建的子进程，尤其考虑 Windows 句柄继承和孤儿进程问题。
- **[待决策]** Podman 是否是第三方插件的默认运行器。建议实现统一 `PluginRunner` 接口，先有 `LocalProcessRunner`，再增加 `PodmanRunner`。

### 5.3 连接与握手

**[设计建议]** 连接由宿主发起并绑定插件安装记录，握手至少包含：

1. 进程启动并建立 framing。
2. 插件发送 `hello`：插件 ID、包版本、RPC protocol、SDK、运行平台摘要。
3. 宿主核对 Manifest 与实际身份，返回 `initialize`：Host API 版本、已授予 capability、实例 ID、限制和 feature flags。
4. 插件返回 `initialized`，不得在该步骤自行追加未声明的高风险贡献。
5. 宿主发送 `activate` 及触发原因。
6. 插件返回 `activated` 与动态健康信息；静态贡献仍以 Manifest 为准。

- **[设计建议]** Manifest ID、运行时 `hello` ID 或包摘要不一致时立即 fail closed。
- **[设计建议]** 握手前只接受有限消息类型和较小帧，避免未认证子进程先发送大流量。
- **[设计建议]** 动态贡献若未来允许，只能是 Manifest 已声明模板的实例化结果，并受数量上限约束。

## 6. 生命周期状态机

### 6.1 持久化期望状态

**[设计建议]** 将“管理员希望的状态”和“当前运行状态”分离：

```text
未安装
  └─ install ─> installed-disabled
                    └─ enable ─> installed-enabled
                    └─ uninstall ─> uninstalling ─> 未安装

installed-enabled
  └─ disable ─> installed-disabled
  └─ upgrade ─> upgrading ─> installed-enabled | rollback | incompatible
```

- **[设计建议]** 期望状态至少包含 `disabled`、`enabled`、`uninstalling`；`incompatible` 是兼容检查结果，不应伪装成管理员主动禁用。

### 6.2 运行状态

```text
inactive
  └─ activation event ─> starting ─> handshaking ─> activating ─> active
                                      │                │          │
                                      └──── failed <───┴──────────┘
                                               │
                                               ├─ backoff ─> starting
                                               └─ quarantine

active ─> draining ─> deactivating ─> stopped/inactive
active ─> crashed ─> backoff/quarantine
```

- **[设计建议]** 状态转换由 Plugin Manager 单线程化到单个插件；每次转换记录 reason、时间和 generation。
- **[设计建议]** 每次重新 spawn 增加 runtime generation。迟到的旧进程消息若 generation 不匹配，一律丢弃。
- **[设计建议]** `degraded` 可作为 active 的健康标志，用于部分 contribution 不可用，但不能替代明确的 failed/quarantine。
- **[设计建议]** disabled、incompatible、quarantine 状态不响应自动激活事件；管理员显式“测试/重试”可以创建一次受限运行。

## 7. 激活事件与懒加载

### 7.1 事件族

**[设计建议]** 概念上支持以下激活事件；最终字符串和 Manifest 字段由打包文档统一：

| 事件族 | 示例语义 | 说明 |
|---|---|---|
| 宿主启动 | `onStartup` | 高成本、需特殊授权或官方策略 |
| Provider | `onProvider:<contributionId>` | 选择模型、列模型或首次聊天时激活 |
| Tool | `onTool:<contributionId>` | 工具定义可静态展示，执行前激活 |
| Command | `onCommand:<contributionId>` | 用户、例程或其他允许主体调用时激活 |
| View | `onView:<contributionId>` | 打开插件面板时激活后端；纯静态 UI 可不启动后端 |
| Public Event | `onEvent:<eventType>` | 仅允许白名单事件与静态过滤条件 |
| Schedule | `onSchedule:<contributionId>` | 由宿主调度器触发，不由插件自行常驻计时 |

### 7.2 激活流程

```text
调用贡献
→ Contribution Registry 查静态元数据
→ Activation Index 找到插件
→ Plugin Manager single-flight activate(pluginId)
→ 调用进入 bounded cold-start queue
→ active 后交给宿主代理执行
→ 激活失败时队列统一失败并携带诊断 ID
```

- **[设计建议]** 插件处于 active 时重复激活只增加 usage/lease，不再次发送 activate。
- **[设计建议]** cold-start queue 按调用类型设置数量与字节双上限；超过上限快速返回 `PLUGIN_BUSY`，不无限等待。
- **[设计建议]** provider/tool 定义必须可从 Manifest 静态注册，否则模型请求前无法稳定构建工具列表和模型选择器。
- **[设计建议]** event 激活使用事件摘要而不是内部完整 payload。进程启动期间同类高频事件可按 key 合并，只保留最新状态或计数。
- **[设计建议]** 插件可在无活动 lease 且无在途请求时进入 idle stop；provider 会话等需要粘性的贡献可以持有有期限 lease。
- **[待决策]** 默认 idle stop 时间和哪些 contribution 自动持有 lease。建议 provider 活跃会话期间不回收，普通命令/工具完成后按短空闲窗口回收。

## 8. 版本与能力协商

### 8.1 三层版本

| 版本层 | 用途 | 不兼容处理 |
|---|---|---|
| Manifest schema | 宿主能否安全读取包清单 | 安装检查失败，不执行代码 |
| Host API | 插件可调用哪些公共 API | 选择兼容 major/minor；无交集则 incompatible |
| RPC protocol | framing、请求/响应、流、取消、错误 | major 不同拒绝握手；minor/feature 协商 |

- **[设计建议]** 插件自身 package version 只表示发布版本，不替代上述三个版本。
- **[设计建议]** 握手返回 capability feature 集，例如流控、binary attachment、provider usage v2；插件只能使用双方交集。
- **[设计建议]** 每个公共 DTO 含稳定 `type`，必要时含 `schemaVersion`；接收方忽略未知可选字段，但拒绝未知必需语义。
- **[设计建议]** Host API 在同一 major 内只增加可选字段/能力；删除字段或改变语义必须升 major。
- **[设计建议]** 核心注册表代理负责把协商后的插件协议映射到当前内部接口。例如 provider 插件由 `RemoteProviderAdapter` 转成 `AsyncGenerator<ParsedStreamEvent>`，而不是要求 Agent Loop 理解插件 RPC。

### 8.2 Provider 兼容层

- **[当前事实]** `ProviderAdapter` 包含历史格式转换、system prompt 注入、工具格式化、chat 流、工具结果和生成助手等能力，不是一个最小网络协议。
- **[设计建议]** 核心保留历史存储和 Agent Loop 控制，provider 插件只实现稳定的 provider RPC capability；`RemoteProviderAdapter` 在核心进程完成 DTO 映射、AbortSignal、usage 和错误类型转换。
- **[设计建议]** provider 插件不得返回任意 `AgentEvent`；只能返回 provider 协议允许的流事件，宿主验证顺序、大小、ID 和终止状态后再映射。
- **[设计建议]** provider 插件不可直接调用工具。模型产生的 tool use 回到核心 Agent Loop，由核心工具权限和执行框架处理。

## 9. 超时、取消与背压

### 9.1 超时层次

- **[设计建议]** 所有 timeout 由宿主设置并下传 deadline，插件只能请求更短时间，不能延长宿主硬上限。
- **[设计建议]** 至少区分：spawn timeout、handshake timeout、activation timeout、普通 RPC timeout、provider 首事件 timeout、stream idle timeout、总时长、drain timeout、shutdown timeout。
- **[假设]** 可先采用以下保守默认值作为实现基线，后续专题文档可调整：spawn/handshake 15 秒、activate 30 秒、普通 query 15 秒、普通 command 60 秒、deactivate/shutdown 各 5 秒。provider 首事件沿用 Agent 配置，长流另设 idle 和总量限制。
- **[设计建议]** 超时结果必须区分“未开始”“执行中被取消”“结果未知”，尤其对有副作用命令不能统一伪装成可安全重试。

### 9.2 取消

```text
Core AbortSignal aborted
→ RPC client 标记 request cancelled
→ 高优先级发送 cancel(requestId, reason)
→ 停止向上游消费者转发后续流
→ 等待短取消宽限期
→ 插件未停止则关闭该请求；必要时终止失控运行时
```

- **[设计建议]** 宿主取消后忽略迟到 response/event，但仍可记录“插件未遵守取消”的诊断。
- **[设计建议]** 插件调用宿主 API 时也使用同一 request tree；父调用取消应级联取消该插件发起的子查询/命令。
- **[设计建议]** shutdown 和 upgrade 先取消无副作用请求；有副作用请求按 API 声明选择 drain、取消或标记结果未知。

### 9.3 背压

- **[设计建议]** 每个运行时维护独立的入站/出站字节计数、请求数、流数和日志速率，防止一个插件占满全局内存。
- **[设计建议]** 流协议采用 credit/window 或显式 ACK；发送方只能在窗口内发送事件，消费者处理后返还额度。
- **[设计建议]** 单帧和单事件有硬上限；大文件、图片或 raw dump 使用受控附件/文件句柄传输，不塞入无限 JSON/base64。
- **[设计建议]** 队列达到高水位时暂停读取或不给新 credit；达到硬上限时失败当前请求，持续违规则重启/隔离插件。
- **[设计建议]** 进度和日志可以合并/采样；最终 response、error、cancel ack 和流结束帧使用控制优先级，不能被普通流量饿死。
- **[假设]** 初始实现可将单帧上限设为 1 MiB、单运行时排队上限设为 8 MiB、最大在途 RPC 设为 16；这些是安全基线，不是最终产品承诺。

## 10. 崩溃恢复与熔断

### 10.1 崩溃处理

- **[设计建议]** 进程异常退出时立即使所有在途请求失败，错误包含插件 ID、runtime generation、是否可能有副作用和诊断 ID。
- **[设计建议]** Registry 不删除贡献，而是将其标记为 temporarily unavailable，保留 UI/配置引用。
- **[设计建议]** Runtime Supervisor 记录退出码、signal、最后心跳、最近协议错误、stderr 摘要和资源峰值，日志内容有长度和敏感信息过滤。
- **[设计建议]** 自动重启采用带抖动指数退避，并以滑动窗口重启预算控制；成功稳定运行一段时间后才清零失败计数。
- **[假设]** 可参考“1 分钟内最多 3 次、15 分钟内最多 10 次”的初始预算；超过预算进入 quarantine。

### 10.2 恢复语义

- **[设计建议]** 激活和注册必须幂等。重启后宿主重新发送完整授权、限制和激活原因，插件不得依赖只存在内存的宿主状态。
- **[设计建议]** 只读查询可由调用方重新发起；provider 请求是否重试由现有 Agent retry 策略决定，插件管理器本身不偷偷重放。
- **[设计建议]** 有副作用命令默认不自动重放。若 Command API 支持幂等键，重试由核心命令服务判断并返回同一 operation 结果。
- **[设计建议]** 公共事件默认不补发。需要恢复的插件在启动后用 Query API 按 cursor/updatedAt 对账。
- **[设计建议]** 插件持续输出错误协议帧、拒绝取消、超过资源上限或握手身份不一致时直接 quarantine，不进入无限重启。

### 10.3 心跳与健康

- **[设计建议]** “进程存在”不等于健康。Supervisor 应检测协议心跳、事件循环响应、队列积压和贡献自检结果。
- **[设计建议]** 心跳只用于检测连接活性，不能替代具体调用 timeout。
- **[设计建议]** 插件可报告 degraded 原因，但最终健康状态由宿主结合调用错误和资源指标判定。

## 11. 升级、回滚与卸载

### 11.1 升级流程

```text
下载/导入新包到 staging
→ 校验路径、摘要、签名、Manifest、平台与版本兼容
→ 读取升级声明和存储迁移需求
→ 将插件置为 upgrading，阻止新调用
→ drain/cancel 旧 runtime
→ 停止旧 runtime
→ 原子切换 current 指针到新版本
→ 启动一次受限 health activation
→ 成功：提交 journal、保留旧包用于回滚
→ 失败：恢复旧指针、旧授权和旧 runtime；记录升级失败
```

- **[设计建议]** 不覆盖正在使用的版本目录；每个版本使用不可变目录，`current` 只做原子引用切换。
- **[设计建议]** 升级期间不并行运行两个可写版本。未来若做蓝绿，需要独立存储版本和流量路由设计。
- **[设计建议]** 存储迁移由宿主提供受限 migration API，并要求版本号和 journal；插件不能执行任意 SQL。
- **[设计建议]** 不可逆迁移必须在切换前生成备份或明确放弃自动回滚，管理界面需要突出提示。

### 11.2 卸载流程

```text
标记 uninstalling
→ 从 Activation Index 移除，拒绝新调用
→ drain/cancel + deactivate + shutdown
→ 撤销 provider/tool/command/event/view 的活动代理
→ 撤销 grants、runtime identity 和 secret access
→ 删除可执行包与缓存
→ 默认保留 namespaced storage/用户引用占位
→ 可选显式 purge data
→ 完成 journal
```

- **[设计建议]** secret grant 在卸载时立即撤销；即使保留插件数据，也不保留可继续使用的凭据句柄。
- **[设计建议]** 工作区布局、例程、模型配置或自动化中引用已卸载贡献时，核心保留缺失引用和原插件 ID，允许重新安装后恢复。
- **[设计建议]** 强制卸载只跳过插件自己的 deactivate，不跳过宿主撤销授权、终止进程和清理注册表。

## 12. 与内部服务的边界映射

| 当前内部能力 | 插件可见替代 | 关键约束 |
|---|---|---|
| `db` / Drizzle / SQLite | Query API、Command API、Plugin Storage | 无 SQL、分页限量、核心事务不执行插件代码 |
| 原始 `eventBus` | Public Event Gateway | 白名单、脱敏、异步、有界、默认不可靠补发 |
| `ProviderAdapter` 实例 | `RemoteProviderAdapter` + Provider RPC | 核心保留 Agent Loop、历史和工具执行 |
| `ToolDefinition.execute` / `ToolContext` | `PluginToolProxy` + narrowed invocation context | 核心 schema、权限、设备目标、取消和审计 |
| 内部 services | 业务 Query/Command DTO | 不暴露方法表，不允许任意 service name 调用 |
| `settings` 单例 | 插件 Config API | 只能访问自身配置和获准的公共设置快照 |
| provider/第三方密钥 | Secret Broker | 句柄化、按 capability/调用注入、日志脱敏 |
| Hono `app` | 静态 `/api/plugins` 管理 API；可选统一代理 | 无任意 middleware/route 注入 |
| Narrator WebSocket | Event/UI Bridge | 不给 JWT，不给原始 socket，不承诺逐 chunk 无界转发 |
| logger | Structured Plugin Log API / stderr collector | 速率和字节限制、字段过滤、关联 plugin/runtime/request |
| scheduler | Scheduler contribution | 宿主拥有 timer、并发、取消和运行记录 |
| 文件/命令执行后端 | 明确 capability 的受控 API | 路径 scope、目标设备冻结、权限审批，不传完整 backend 对象 |

### 12.1 核心调用插件

- **[设计建议]** 核心只通过宿主代理调用插件，内部 service 不持有 RPC client。
- **[设计建议]** provider resolution、工具注册等现有入口只认识 Registry/Proxy；插件进程管理细节集中在 Plugin Manager。
- **[设计建议]** 这样可在插件禁用、崩溃、升级时由代理统一返回状态，而不需要所有业务 service 自行处理子进程。

### 12.2 插件调用核心

- **[设计建议]** 每个调用包含宿主生成的 `runtimeId`、`requestId`、`pluginId` 和 invocation scope。
- **[设计建议]** 用户触发的调用可携带不可伪造的内部 user context 引用，但不传 JWT；后台激活没有用户权限时只能使用安装级后台 grant。
- **[设计建议]** 后台 grant 与“代表当前用户”必须是不同 capability，避免插件在无用户参与时继承最近一次用户权限。

## 13. 关键调用序列

### 13.1 Provider 首次调用

```text
Narrator Session
  → ProviderRegistry.resolve(providerId)
  → RemoteProviderAdapter.chat(params, AbortSignal)
  → Plugin Manager.activate(pluginId, onProvider)
  → Runtime Supervisor handshake/activate（如未运行）
  → Provider RPC stream
  → 校验并映射为 ParsedStreamEvent
  → Agent Loop 处理 tool use / usage / error
  → AbortSignal 时发送 cancel，并停止消费迟到事件
```

- **[设计建议]** 插件只生成 provider 事件；Agent Tool 的执行仍回到核心工具框架。

### 13.2 插件响应公共事件

```text
Internal service emits eventBus event
  → Public Event Gateway 映射、脱敏、过滤
  → Activation Index 判断是否需启动插件
  → 有界队列/合并
  → 插件 event handler
  → 插件如需副作用，另行调用 Command API
```

- **[设计建议]** event handler 的返回值不影响内部事件是否成立，避免第三方代码进入核心同步控制流。

## 14. 可观测性与审计

- **[设计建议]** 每个插件状态页至少展示：安装版本、Manifest/Host API/RPC 协商结果、grants、runtime PID/runner、generation、激活原因、在途请求、队列字节、最近退出和 quarantine 原因。
- **[设计建议]** 每次跨边界调用记录结构化摘要：plugin、contribution、capability、user/background principal、resource scope、duration、result、bytes、cancel/timeout；敏感参数只记录摘要或哈希。
- **[设计建议]** 慢调用、首次事件超时、背压触发、取消不响应和重启预算应有独立指标，便于区分“插件慢”和“核心慢”。
- **[设计建议]** 插件日志与核心日志分流但共享 correlation ID；下载完整日志时仍需大小上限和分页/流式读取。

## 15. 实现切分建议

- **[设计建议] 第一阶段**：Catalog、Manifest 静态检查、Plugin Manager 状态机、LocalProcessRunner、stdio RPC 基础、Capability Broker 骨架、诊断与 enable/disable。
- **[设计建议] 第二阶段**：Tool/Command/Event contribution、namespaced storage、取消/超时/背压、崩溃预算和升级 journal。
- **[设计建议] 第三阶段**：ProviderRegistry + `RemoteProviderAdapter`，完整流式 RPC、usage/error 映射和模型发现。
- **[设计建议] 第四阶段**：UI iframe Bridge、ViewRegistry、缺失面板恢复、Secret Broker 和 PodmanRunner。
- **[设计建议]** 每个阶段都应先提供宿主代理和失败语义，再接入具体业务入口，避免 provider/tool/service 各自发明生命周期处理。

## 16. 假设与待决策汇总

### 16.1 假设

- **[假设]** 初版使用 JSON-RPC over stdio，一插件一进程，包目录不可变。
- **[假设]** 插件静态贡献由 Manifest 声明，运行时不能任意添加新类型或覆盖核心贡献。
- **[假设]** 核心 HTTP/WS 在非关键插件激活完成前即可提供服务。
- **[假设]** namespaced storage 默认保留，purge 是显式破坏性操作。

### 16.2 待决策

- **[待决策]** Plugin Manager 状态持久化放入核心 SQLite 还是独立插件元数据文件；无论选择哪种，都不得让插件直接访问该存储。
- **[待决策]** LocalProcessRunner 与 PodmanRunner 的默认策略、支持平台和资源限制实现方式。
- **[待决策]** idle stop、重启预算、帧/队列/并发配额的最终默认值及管理员可配置范围。
- **[待决策]** Host API 首个 major 的兼容窗口，以及是否在 0.x 期间允许快速破坏性演进。
- **[待决策]** 第一阶段是否包含 provider；若不包含，Registry 和 RPC 仍应保留流、取消和 capability negotiation 的架构位置，避免后续返工。
