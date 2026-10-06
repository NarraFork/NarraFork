# NarraFork 插件系统：ADR 与未决问题

> 文档定位：记录插件系统的架构决策、决策状态、替代方案、后果和仍需确认的问题。本文与 `09-roadmap-and-task-breakdown.md` 配套：ADR 说明“为什么这样做”，路线图说明“何时实现、如何验收”。
>
> 标记约定：
> - **[事实]**：当前仓库代码或既有设计可直接确认。
> - **[建议]**：推荐作为实现默认值或评审基线。
> - **[假设]**：尚未正式确认、但路线图必须依赖的前提。
> - **[待决策]**：阻塞某阶段或需要明确 owner/证据的选择。
>
> ADR 状态：
> - **Accepted（已接受）**：可直接进入实现，除非有新证据触发重新评审。
> - **Proposed（建议接受）**：路线图按此规划，但实现前需 owner 确认。
> - **Open（未决）**：存在多个可行方案，必须在指定阶段前完成决策。

---

## 1. 决策总览

| ID | 主题 | 状态 | 主要阻塞阶段 |
|---|---|---|---|
| ADR-001 | 第三方后端默认进程外 | Proposed | 1 |
| ADR-002 | Content-Length stdio JSON-RPC | Proposed | 0/1 |
| ADR-003 | Manifest/Host API/RPC 三层版本 | Proposed | 0/1 |
| ADR-004 | Capability Broker 与 Public API 门面 | Proposed | 2 |
| ADR-005 | Public Event 默认 at-most-once + Query 对账 | Proposed | 2 |
| ADR-006 | Permission effective intersection | Proposed | 0/2 |
| ADR-007 | Trust T0–T3 不等于授权 | Proposed | 0/1 |
| ADR-008 | Namespaced Plugin Storage | Open | 2 |
| ADR-009 | Provider Registry + RemoteProviderAdapter | Proposed | 3 |
| ADR-010 | Provider RPC 流、取消、背压与不重放 | Proposed | 3 |
| ADR-011 | MCP 与插件系统共存 | Proposed | 2 |
| ADR-012 | UI sandbox iframe + MessageChannel | Proposed | 4 |
| ADR-013 | Dockview 单一 PluginDockPanel 与稳定 iframe | Proposed | 4 |
| ADR-014 | Module Federation 不进入 v1 | Proposed | 4 |
| ADR-015 | WASM 不作为通用插件运行时 | Proposed | 4/后续 |
| ADR-016 | Manifest 静态贡献与无运行期注入 | Proposed | 0/1/4 |
| ADR-017 | Secret Broker 与不传 JWT | Open | 2/3/4 |
| ADR-018 | Staging/atomic switch/rollback | Proposed | 1/4 |
| ADR-019 | LocalProcessRunner 与 PodmanRunner 分层 | Open | 1/4 |
| ADR-020 | 主线程、配额、背压和故障域 | Proposed | 1–4 |
| ADR-021 | 契约命名与 envelope 冻结 | Accepted | 0 |

---

## 2. ADR-001：第三方后端默认进程外运行

**状态：Proposed**

### 背景

- **[事实]** NarraFork 主进程同时承担 Bun HTTP/WS、SQLite、JSON 序列化、Agent Loop、事件分发和多个后台服务。
- **[事实]** 内置 provider 适配器运行在核心进程，不能作为第三方插件安全模型。
- **[建议]** 第三方插件的崩溃、死循环、内存泄漏、协议错误和恶意同步工作不能直接拖垮核心。

### 决策

- **[建议]** T1/T2/T3 可安装插件默认一插件一受监管进程；T0 才允许随核心编译并进程内运行。
- **[建议]** Runtime Supervisor 负责 spawn、握手、generation、heartbeat、cancel、drain、shutdown、kill、重启预算和 quarantine。
- **[建议]** Worker Thread 不作为默认隔离边界；它与主进程共享更近的运行时和资源边界。

### 后果

- **[建议] 正面**：故障域清晰，核心 API 更容易保持可用，语言 SDK 可扩展到 Python/Rust。
- **[建议] 代价**：需要 framing、进程树清理、版本协商、序列化、冷启动和跨平台 spawn 处理。
- **[假设]** 小团队部署能接受每个活跃插件额外的进程和内存成本；最终资源配额需实测。

### 替代方案

- 进程内动态 import：启动快，但违反边界，放大供应链和崩溃风险，拒绝。
- Worker Thread：比独立进程便宜，但不提供足够的故障/资源/密钥边界，拒绝作为默认。
- 全部 Podman：安全边界更强，但安装和跨平台门槛高，保留为 T2 runner 选项。

### 验证

- **[建议]** 用 crash/slow/malformed fixture 验证核心 API、WS、SQLite 和优雅退出不被拖垮。
- **[待决策]** T2 插件是否强制 Podman，见 ADR-019/OQ-004。

---

## 3. ADR-002：Content-Length framed stdio JSON-RPC

**状态：Proposed**

### 背景

- **[事实]** 设计需要支持 unary request、notification、流式 provider event、取消、credit/ACK 和语言中立 SDK。
- **[事实]** stdout 若混入日志会破坏协议；项目已有大量子进程和跨平台进程管理经验。

### 决策

- **[建议]** v1 使用 `Content-Length: <bytes>\r\n\r\n<UTF-8 JSON>` framing，stdout 只承载协议，stderr 承载限速日志。
- **[建议]** JSON-RPC envelope 使用 2.0 语义，v1 禁止 batch；request/response/notification 分开处理。
- **[建议]** 所有请求带 request ID、deadline、correlation ID、runtime generation 和取消路径。
- **[建议]** 提供官方 TypeScript reference SDK 与跨语言 fixture，避免每个插件自行实现 framing/credit/cancel。

### 后果

- **[建议] 正面**：可流式、可被非 JS 语言实现、易于录制/审计/回放测试。
- **[建议] 代价**：需要严格处理 UTF-8 byte length、拆包、超长 header、body limit、OS pipe backpressure。
- **[建议]** binary/大文件不直接塞无限 base64；未来通过受控 attachment/file handle 扩展。

### 替代方案

- WebSocket/TCP：可远程化，但引入端口、认证、服务发现和部署面，v1 不需要。
- newline-delimited JSON：实现简单，但无法安全表示任意换行/大消息和明确 byte length，拒绝。
- MessagePack/CBOR：更高效，但增加 SDK/调试门槛，保留为后续 binary extension。

### 验证

- **[建议]** 逐字节拆包、单 chunk 多 frame、多字节 UTF-8、非法长度、超长 frame、stdout 混日志和 notification/response 交错测试必须通过。

---

## 4. ADR-003：Manifest、Host API、RPC 三层版本独立演进

**状态：Proposed**

### 背景

- **[事实]** 包清单安全解析、公共宿主 DTO 和进程 framing/流协议的兼容节奏不同。
- **[事实]** Provider RPC 已有独立 protocolVersion、feature/capability negotiation 需求。

### 决策

- **[建议]** 分别维护：`manifestSchemaVersion`、`hostApiRange`、`rpcProtocolRange`；UI 另有 `narrafork.ui/<major>`。
- **[建议]** 安装阶段静态拒绝 Manifest major 不兼容；握手阶段拒绝 RPC major 不兼容；Host API 采用 semver range。
- **[建议]** 同一 major 只增加可选字段/能力；改变必需语义、删除字段或改变错误语义必须升 major。
- **[建议]** 新核心至少保留一个旧 major 的兼容窗口，具体窗口由 OQ-002 决定。

### 后果

- **[建议] 正面**：Provider/UI/Manifest 可独立升级，旧插件能明确显示 incompatible，不必执行探测代码。
- **[建议] 代价**：需要兼容矩阵、弃用期、fixture 和多版本 adapter。
- **[假设]** 0.x 期间可能允许较快演进，但不能以“0.x”作为忽略安全拒绝和升级诊断的理由。

### 验证

- **[建议]** 测试共同最高 minor、major 不兼容、未知可选字段、未知必需字段和 feature intersection。

---

## 5. ADR-004：Capability Broker 与 Public API 门面

**状态：Proposed**

### 背景

- **[事实]** 当前 DB、service、eventBus、Agent ToolContext 和 JWT 都是内部对象，不能暴露给第三方。
- **[事实]** 主线程性能规则要求 Query 有限分页、Command 小事务、事件异步、输出限量。

### 决策

- **[建议]** 所有“插件调用宿主”流量统一经过 Capability Broker：解析身份 → grant → user/background principal → invocation scope → 参数/配额校验 → DTO 门面 → 审计 → 脱敏。
- **[建议]** Public API 只暴露 Query、Command、Event、Storage、Config、Secret、Log、Scheduler 等稳定命名空间。
- **[建议]** Query 返回 DTO/摘要/游标，不返回 ORM row；Command 表达业务意图，不暴露任意 service method；Event 不透传原始 eventBus。
- **[建议]** 插件命令不伪造用户 JWT；宿主绑定 `PluginPrincipal` 与可选的不可伪造用户上下文引用。

### 后果

- **[建议] 正面**：内部服务/数据库可演进，权限、限流、审计和背压有单一入口。
- **[建议] 代价**：需要维护公共 DTO、schema、版本和逐项权限；跨命令工作流必须处理幂等/补偿。
- **[建议]** 核心命令可以在核心侧保持原子性，但不能在核心事务中执行第三方代码。

### 替代方案

- 直接暴露内部 service：短期开发快，但形成不可维护 ABI 和越权风险，拒绝。
- 为每个插件复制 REST API：重复认证/DTO/审计逻辑，拒绝。
- 只给插件数据库只读权限：仍泄漏 schema/大字段/权限边界，拒绝。

### 验证

- **[建议]** 用恶意 pluginId/userId/scope、越权 query/command、超页、超输出、结果未知和审计脱敏 fixture 验证。

---

## 6. ADR-005：Public Event 默认 at-most-once，可靠性由 Query 对账提供

**状态：Proposed**

### 背景

- **[事实]** 内部 eventBus 是进程内同步/异步解耦机制，不是持久化消息队列。
- **[事实]** 高频 narrator/terminal/provider 流若无界广播，会造成主线程和 WebSocket 背压问题。

### 决策

- **[建议]** 公共事件默认在线 at-most-once；宿主不承诺插件重启后补发全部事件。
- **[建议]** Event Gateway 负责白名单映射、脱敏、过滤、合并、采样、队列上限和 overflow 通知。
- **[建议]** 需要可靠消费的插件必须使用 cursor Query、updatedAt、任务资源或审计资源对账。
- **[建议]** UI bridge 的 event subscription 复用同一语义；panel 不可见时默认暂停非关键事件。

### 后果

- **[建议] 正面**：不把核心主线程变成消息队列，不承诺不可实现的永久可靠投递。
- **[建议] 代价**：插件必须实现重连后的对账逻辑；事件 schema 与 Query schema 必须协同设计。
- **[待决策]** 是否未来提供持久化 Public Event log/stream，见 OQ-007；在此之前不能把 event 当审计事实来源。

### 验证

- **[建议]** 测试订阅 overflow、插件断线、重启、权限撤销、合并/采样和 cursor 对账结果。

---

## 7. ADR-006：权限采用多层交集且默认 fail closed

**状态：Proposed**

### 决策

- **[建议]** 有效能力固定为：

```text
manifestRequested
∩ installationGrants
∩ hostPolicy
∩ currentUserAuthority
∩ currentInvocationScope
```

- **[建议]** Manifest 只能申请，不得自动获得；签名/信任只影响可申请能力，不等于授权。
- **[建议]** 用户触发调用与后台调用使用不同 principal/capability；后台不能继承最近一次用户权限。
- **[建议]** 高风险能力说明资源范围，例如 workspace/path/host/domain/command，而不是只显示抽象权限名。
- **[建议]** capability 被撤销后，已存在的 RPC、event subscription、UI session 和 secret handle 在下一次交付/调用时重新检查。

### 后果

- **[建议] 正面**：安装、签名、启用、用户调用、资源 scope 分离，减少“安装即全能”。
- **[建议] 代价**：权限 UI、审计和临时 scope 复杂，需统一命名和可读描述。

### 未决边界

- **[待决策]** 是否支持管理员批准后普通用户调用时再次确认；推荐高风险写操作仍走现有 permission/danger reflection。
- **[待决策]** 文件/网络权限是否允许按单个路径/域名配置；推荐支持有限 allowlist，不支持任意表达式。

---

## 8. ADR-007：T0–T3 信任等级与授权分离

**状态：Proposed**

### 决策

| 等级 | 来源 | 运行位置 | 结论 |
|---|---|---|---|
| T0 | 随核心编译 | 核心进程 | 可访问内部对象，但不属于可安装插件 |
| T1 | 官方/组织签名可信 | 独立进程 | 可申请高风险 capability，仍需 grant/审计 |
| T2 | 第三方、管理员已批准 | 独立进程，建议容器 | 只获得 grant 与 host policy 交集 |
| T3 | 未批准/未知来源 | 不执行 | 只读包元数据/签名/静态清单 |

- **[建议]** 签名证明发布者和包完整性，不证明行为安全，不自动授予权限。
- **[建议]** 官方插件也默认使用 Public Host API，不因来源身份进入数据库或核心进程。
- **[建议]** 没有 Podman/OS sandbox 时，管理界面必须标示 LocalProcessRunner 是故障隔离而非安全沙箱。

### 后果

- **[建议] 正面**：身份、完整性、权限、隔离能力可分别表达，便于私有组织签名根。
- **[建议] 代价**：需要签名根、吊销、安装审批、runner capability 和 UI 解释。

### 未决

- **[待决策]** 官方签名根、组织私有签名根和吊销列表的分发方式，见 OQ-003。
- **[待决策]** T2 默认 runner，见 ADR-019/OQ-004。

---

## 9. ADR-008：插件存储采用宿主管理的 namespaced API

**状态：Open**

### 背景

- **[事实]** 现有核心数据使用 SQLite/Drizzle，核心表不能由插件修改。
- **[事实]** UI 文档已提出 session/device/user/workspace/narrator storage scope、JSON-only 和配额。

### 选项

| 方案 | 优点 | 风险 |
|---|---|---|
| A. 核心 SQLite namespaced tables | 备份/权限/查询一致，部署简单 | 插件写入仍消耗核心 DB；迁移/锁争用需治理 |
| B. 每插件独立 SQLite | 故障域和迁移更独立 | 备份、跨平台路径、并发和管理复杂 |
| C. 文件/JSON KV | 实现快、离线友好 | 并发、损坏恢复、查询和配额更难 |
| D. 仅 UI localStorage | UI 低延迟 | opaque origin、PWA、多设备和安全语义不可靠 |

### 推荐决策

- **[建议]** v1 对插件只暴露抽象 Storage API；实现可先使用核心托管的 namespaced store，但代码不得让插件看到 SQL、表名或文件路径。
- **[建议]** storage value 只允许 JSON，单值、每插件/用户、列表项和总字节有配额；secret 不进入 storage。
- **[建议]** storage migration 使用插件版本和 journal；升级失败保留旧数据/备份，卸载默认保留，purge 显式确认。
- **[待决策]** A/B/C 的最终实现及核心 DB 写入配额必须在阶段 2 P2-05 前由数据库 owner 确认。

### 验收

- **[建议]** 无法伪造 pluginId/userId/scope；并发写、配额、迁移失败、卸载保留和 purge 均有测试。

---

## 10. ADR-009：Provider Registry + `RemoteProviderAdapter`

**状态：Proposed**

### 决策

- **[事实]** 当前 provider resolution 直接创建进程内适配器，存在 builtin、compatible API、Codex/NUG 等多种来源。
- **[建议]** 新增宿主 Provider Registry，统一条目：来源、providerInstanceId、prefix、模型目录、禁用状态、创建 adapter 的宿主代理。
- **[建议]** 可执行插件通过 `RemoteProviderAdapter` 映射当前 `ProviderAdapter`；Agent Loop、历史、工具执行、权限和重试所有权留在核心。
- **[建议]** provider type/contribution ID 使用统一格式，推荐 `${pluginId}/${localProviderId}`；最终以 Manifest 文档冻结为准。
- **[建议]** prefix 全局唯一，禁止“禁用内置后插件占用原 prefix”，避免再次启用时路由不稳定。

### 后果

- **[建议] 正面**：provider 插件不会把 Agent Loop 绑定到 RPC，现有 provider 可渐进迁移。
- **[建议] 代价**：需要异步 model catalog 缓存、settings/aggregation 兼容和 provider-specific reasoning metadata。

### 验证

- **[建议]** 现有 provider resolution、aggregation、history、abort、reasoning、error 测试必须全绿；插件 provider 不能改变 builtin 优先级。

---

## 11. ADR-010：Provider RPC 流、取消、背压与不重放

**状态：Proposed**

### 决策

- **[建议]** `provider.chat`/`provider.generate` 返回 accepted + operation ID，随后通过 `provider.event` 通知流；每 operation seq 从 1 严格递增，`done` 只能一次且必须最后。
- **[建议]** 支持 `request_started`、text/reasoning delta、tool call、usage、error、done；工具 call 只描述模型输出，不能执行核心工具。
- **[建议]** 核心 `AbortSignal` 映射为一次幂等 `provider.cancel`；取消有 grace period，迟到事件丢弃并诊断。
- **[建议]** 使用 normal event/byte credit + terminal reserve；credit 在宿主消费事件后通过 ACK 归还，不在 parser 读到时归还。
- **[建议]** provider 进程在已暴露 tool call 后崩溃不自动重放；无副作用、尚未暴露外部可见事件的重试由 Agent Loop/插件明确负责。
- **[建议]** 宿主设置 spawn/handshake/accepted/首事件/idle/absolute/cancel/shutdown 多层 timeout；插件不能提高硬上限。

### 后果

- **[建议] 正面**：能处理当前 Agent Loop 的 streaming、reasoning、tool trajectory、usage 和取消，不把无限流带入主线程。
- **[建议] 代价**：协议实现和测试量大，需要正确处理部分输出、结果未知和 provider stateful session。

### 关键未决

- **[已决策]** provider secret 的注入通道：选定 **RPC config 按请求注入解析值**（原 ADR-017/OQ-005）。宿主在每次
  `provider.chat`/`generate`/`listModels` 前解析该 provider 自己声明的 secret 字段，随 `config` 下发；插件无任何
  读取/列举/持久化 secret 的方法。实现见 `server/services/plugin-provider-credential-resolver.ts`，
  契约与约束见 04 号文档 D-04。前提条件「日志深度脱敏」已有回归测试覆盖。
- **[待决策]** v1 是否支持 web search/image generation 的完整实时事件；推荐先保留规范化 block，实时扩展后置。
- **[待决策]** 动态 secret key 与前后端方法集拆分。当前插件只能写 `configSchema` 中**声明过**的
  secret 字段，因此「第 N 条凭据的 token」这类可变数量的 secret 只能整体塞进一个 bundle 字段
  （受 64 KB 单值上限约束）。要支持真正的动态 key，需要给
  插件后端开放受限的 `secrets.set`/`delete`，而这要求把 `PLUGIN_TO_HOST_REQUEST_METHODS` 与
  iframe 的 `PLUGIN_UI_BACKEND_METHODS` 拆成两个清单（今天由 contract parity 断言强制相等）。
  在有第二个确实需要的消费方之前不做。
- **[已决策]** 插件声明的 command 通过新增 Host→Plugin 方法 `commands.invoke` 分发；插件 command
  可用 `secretWrites` 请求宿主写入自身命名空间的 secret。契约见 04 号文档 D-04b，安全限制与负向测试
  见 07 号文档 §13。
- **[待决策]** 本地进程插件的出站网络阻断（07 号文档 §6.2 同项）。当前 `permissions.network` 只在 manifest 层校验，
  **没有运行时强制**：声明 `mode: "none"` 的本地进程插件实际仍可发起任意出站请求。
  需要 owner 决定是实现本地策略层，还是把"需要网络隔离"
  的插件强制提升到 Podman。

---

## 12. ADR-011：MCP 与插件系统共存，不互相替代

**状态：Proposed**

### 背景

- **[事实]** `McpManager` 已处理 MCP transport、连接、重连、tool discovery、list changed、tool call、取消和 shutdown。
- **[事实]** MCP 只定义工具协议，不定义 NarraFork 插件安装、权限、UI、provider、存储和升级生命周期。

### 决策

- **[建议]** 保留 `McpManager` 作为 MCP 连接和重连的权威管理器；插件系统不重写 MCP SDK。
- **[建议]** 插件通过受控 `mcp.bridge` 或 `mcp.server` contribution 接入，静态声明工具/transport/权限，运行期仍经过 Capability Broker 和 ToolRegistry。
- **[建议]** MCP tool list changed 只更新宿主注册表；插件不能直接发内部 eventBus 或修改 Agent ToolContext。
- **[建议]** MCP server 的 command/cwd/env/url/header 由宿主校验、allowlist 和审计；不因 Manifest 自动获得任意网络或进程权限。

### 后果

- **[建议] 正面**：复用现有 MCP 能力，避免重复实现；MCP server 可独立于通用插件生命周期运行。
- **[建议] 代价**：需要明确 MCP config 与 plugin Manifest 的双向引用、状态显示和错误映射。

### 未决

- **[待决策]** 插件是否可以声明远端 MCP endpoint、是否允许插件提供 MCP client；阶段 2 先限定为管理员配置的目标。

---

## 13. ADR-012：UI sandbox iframe + MessageChannel

**状态：Proposed**

### 决策

- **[事实]** 当前 UI 是 React 19 + Mantine + TanStack Router + Dockview；route tree 构建期生成。
- **[建议]** 第三方 UI 使用 host-controlled shell + `sandbox="allow-scripts"`，默认不启用 `allow-same-origin`、forms、popups、downloads、clipboard、camera/microphone、geolocation 和网络。
- **[建议]** 宿主通过一次性 nonce 与 `MessageChannel` 建连；sandbox opaque origin 下同时校验 `event.source`、nonce、protocol 和绑定 session，不能只校验 origin。
- **[建议]** UI bridge payload 只允许 JSON value；请求、响应、事件、取消、超时、队列和权限均由宿主控制。
- **[建议]** iframe 永不持有 JWT、Cookie、refresh token、provider secret、后端 secret 或宿主 localStorage；公共 query/command 通过宿主/服务端代理。

### 后果

- **[建议] 正面**：不把第三方代码放入 React tree/主窗口，UI 与后端权限边界一致。
- **[建议] 代价**：需要 asset shell、CSP、opaque origin 资源路由、bridge SDK 和 panel lifecycle。

### 未决

- **[待决策]** UI 首版只支持 IIFE，还是支持 ESM/dynamic chunks。推荐先 IIFE，减少 opaque origin 下 CORS/CSP/离线升级复杂度。
- **[待决策]** 静态 hash asset 是否允许未登录读取。推荐允许无用户数据的 hash asset，避免把 JWT 放 iframe URL。

---

## 14. ADR-013：Dockview 只认识一个 `PluginDockPanel`，真实 iframe 稳定复用

**状态：Proposed**

### 背景

- **[事实]** `NarratorDock` 与 `DockviewWorkspace` 使用 `defaultRenderer="always"` 来保持组件实例。
- **[事实]** workspace director 是 overlay；如果在 grid/director 各创建一个 iframe，会产生重复 session、重复事件和状态竞争。

### 决策

- **[建议]** focus/workspace registry 只注册静态 component key `plugin`，由宿主 `PluginDockPanel` 校验 params、查 registry、渲染 chrome/placeholder 并管理 iframe slot。
- **[建议]** `pluginId`、`contributionId`、`panelInstanceId`、binding 是 host-owned immutable fields；插件只能更新受限 `viewState`。
- **[建议]** Dockview layout 中保存 plugin panel params，但缺失/禁用/权限撤销/协议不兼容时保留 panel 并渲染 placeholder，不能静默删除。
- **[建议]** focus panel 的身份来自 live current narrator；workspace narrator-scoped panel 必须持久化 `ownerNarratorId`，避免多 narrator 串号。
- **[建议]** director 优先使用 top-level `PluginUiLayer`/slot 复用同一个真实 iframe；若实现质量不达标，首版明确 grid-only 降级，不双挂载。

### 后果

- **[建议] 正面**：Dockview component registry 永远存在，插件缺失不会让 `fromJSON()` 失败；iframe/port/session 在拖动和 director 切换时稳定。
- **[建议] 代价**：需要 slot 定位、ResizeObserver、visibility/drag pointer-events、layout migration 和 placeholder 恢复流程。

### 未决

- **[待决策]** 阶段 4 是否必须首版实现 top-level `PluginUiLayer`；推荐实现，否则明确 grid-only。
- **[待决策]** narrator-scoped panel 是否允许用户拖到另一 narrator；推荐只能通过宿主“重新绑定”命令并重新检查权限。

---

## 15. ADR-014：Module Federation 不进入 v1

**状态：Proposed**

### 背景

- **[事实]** 当前前端基于 Vite + TanStack Router，route tree 是构建期生成，Dockview component registry 由宿主静态提供。
- **[事实]** `05-ui-bridge-and-dockview.md` 明确禁止运行期 `import()` 第三方包到主窗口、Module Federation、任意 React/CSS/DOM 注入。

### 决策

- **[建议]** v1 不使用 Module Federation 作为插件 UI 扩展机制；插件 UI 只使用 sandbox iframe + host bridge。
- **[建议]** 不允许插件 bundle 进入宿主 React tree，不共享 React/Mantine/Router/QueryClient 实例，不让插件选择 shared dependency 版本。
- **[建议]** 若未来评估 Module Federation，只能作为 T0/T1 受信任、构建期或独立窗口的性能优化，并需要新的安全模型与回滚设计，不改变第三方默认边界。

### 后果

- **[建议] 正面**：避免 remote module 供应链、shared singleton 污染、React hook/context 破坏、全局 CSS 和 CSP 复杂度。
- **[建议] 代价**：iframe 存在跨上下文通信开销，宿主不能直接复用插件 React 组件。
- **[假设]** 插件面板主要是业务面板而非高频像素级渲染；bridge/iframe 的开销可通过事件合并和分页控制。

### 替代方案

- 允许任意 remote component：体验直观，但无法可靠隔离第三方代码，拒绝。
- 只对官方插件开放 MF：仍会形成两套安全/测试路径，且官方插件不应绕过公共 API，暂不采用。
- 独立浏览器窗口：可作为后续大型 UI 的可选 surface，不替代 Dockview iframe。

### 触发重新评估的证据

- **[待决策]** 只有当 iframe 在有真实插件样本的性能测试中成为主要瓶颈，且能提供构建签名、CSP、依赖锁定、隔离 origin、快速撤销和跨版本测试证据时，才进入新 ADR。

---

## 16. ADR-015：WASM 不作为通用插件运行时

**状态：Proposed**

### 背景

- **[事实]** 插件目标包含 provider、网络、文件、secret、MCP、UI、事件和业务命令，不只是纯计算。
- **[事实]** WASM 适合受限计算，但网络、文件、进程、secret、异步取消和资源配额仍需要宿主 capability layer。

### 决策

- **[建议]** 阶段 0–4 不实现“任意 WASM 插件”。WASM 只作为后续 `compute` capability 的候选实现，不承担 provider/tool/UI/生命周期完整插件角色。
- **[建议]** 未来若支持 WASM，必须以显式 capability imports、fuel/time/memory limit、无默认网络/文件/secret、版本化 ABI、签名和可中止实例为前提。
- **[建议]** WASM 模块仍不能访问 DB/raw eventBus/JWT，也不能因为“沙箱”而绕过 capability broker。

### 后果

- **[建议] 正面**：避免为了一个运行时同时设计完整 WASI/网络/secret/异步/跨平台策略，降低 v1 范围。
- **[建议] 代价**：纯计算插件无法在 v1 享受更轻量的运行时；后续 SDK 需要单独维护。

### 替代方案

- WASI preview/自定义 host imports：可控但标准和跨平台成熟度不足，后置。
- WASM 在 iframe 中运行：只能解决前端计算，不能替代 UI bridge 和后端能力。
- Native helper：能力强但安全边界更弱，仍需独立进程。

### 重新评估条件

- **[待决策]** 当出现明确的 CPU 密集、纯函数、无网络/文件/secret 需求，并且能以独立 ABI 完成超时/取消/内存限制时，再建立 WASM MVP ADR。

---

## 17. ADR-016：Manifest 静态贡献与无运行期注入

**状态：Proposed**

### 决策

- **[建议]** Provider、tool、command、event、view、MCP、storage scope 等贡献尽可能在 Manifest 静态声明；未激活插件也能被列出、授权和诊断。
- **[建议]** 运行时只能返回 Manifest 已声明类型/模板的健康和动态状态，不能任意添加 contribution、覆盖核心 ID 或注册 Hono route。
- **[建议]** activation event 使用白名单和声明式过滤，不执行插件提交的宿主表达式或 JavaScript。
- **[建议]** UI 的 command/menu/toolbar 只声明纯文本、白名单 icon token、group/order、有限 enablement 和 command ID；不注入 JSX/HTML/CSS。

### 后果

- **[建议] 正面**：静态检查、权限预览、兼容性、缺失恢复和安全审计可在不执行代码时完成。
- **[建议] 代价**：插件需要提前设计贡献；动态 UI/动态工具发现需通过有限 schema 扩展而不是任意注册。

### 未决

- **[待决策]** 是否允许动态贡献实例化（例如按远程模型目录生成 provider model）；推荐只允许 Manifest 声明的模板实例化且有数量上限。

---

## 18. ADR-017：Secret Broker 与不传 JWT

**状态：Open**

### 背景

- **[事实]** 当前 provider 配置、Codex/NUG 等集成会处理 API key、access token、credentials path 等敏感数据。
- **[事实]** UI 文档明确 iframe 不得持有 JWT、Cookie、provider secret 或后端 secret；Provider RPC 仍需要一种安全的上游凭据注入方式。

### 选项

1. **每次 RPC 在 config 中发送解析后的 secret**：实现直接，但扩大日志/内存/崩溃 dump 泄漏面。
2. **专用 secret channel/句柄**：RPC 只发送 opaque credential handle，插件在宿主控制下按调用取值。
3. **容器 secret/file descriptor**：隔离较好，但跨平台和 LocalProcessRunner 语义复杂。
4. **插件自行读取用户凭据文件**：拒绝，绕过宿主授权和审计。

### 推荐方向

- **[建议]** UI 永远不接触 secret；后端插件优先使用 Secret Broker + opaque handle。
- **[建议]** v1 可以在受控 provider RPC config 中注入短生命周期值，但必须字段级脱敏、禁止日志/参数 dump、限制内存留存并支持撤销。
- **[建议]** secret grant 与普通 config 读取分离；插件只能得到其 Manifest 声明、管理员授权和当前 provider instance 绑定的 secret。
- **[待决策]** 阶段 2/3 前确认最终注入方式、rotation、撤销、fork/upgrade 行为和容器实现。

### 验收

- **[建议]** 全链路日志、stderr、request dump、UI storage、错误 response 和 crash diagnostics 中扫描不到 secret；撤销后旧 handle 无效。

---

## 19. ADR-018：升级采用 staging、原子切换、健康检查和回滚

**状态：Proposed**

### 决策

```text
导入/下载 staging
→ 路径/摘要/签名/Manifest/兼容校验
→ 读取 storage/viewState migration 需求
→ 标记 upgrading，阻止新调用
→ drain/cancel 旧 runtime
→ 停旧 runtime
→ 原子切换 current 指针
→ 受限 health activation
→ 成功提交 journal；失败恢复旧指针/授权/运行时
```

- **[建议]** 每个版本使用不可变目录，不原地覆盖正在使用的包。
- **[建议]** 同一插件 v1 不允许新旧版本并行写同一 storage；蓝绿运行后置。
- **[建议]** 不可逆 storage migration 必须在切换前备份/确认，并明确自动回滚边界。
- **[建议]** 卸载先撤销贡献/grant/secret，再删除可执行包；namespaced storage 和 UI 缺失引用默认保留。

### 后果

- **[建议] 正面**：升级失败可恢复，旧布局/配置/数据引用可诊断。
- **[建议] 代价**：需要磁盘空间、journal、旧包保留策略、迁移备份和兼容窗口。

### 未决

- **[待决策]** 默认保留多少旧包、storage 保留多久、签名吊销后是否自动禁用，见 OQ-006。

---

## 20. ADR-019：LocalProcessRunner 与 PodmanRunner 分层

**状态：Open**

### 选项

| 方案 | 优点 | 风险 |
|---|---|---|
| LocalProcessRunner 默认 | 兼容性好、启动快、无 Podman 前置 | 不是强安全沙箱，文件/网络隔离弱 |
| Podman 默认 | 文件/网络/资源隔离更强 | Windows/无 Podman 部署门槛、镜像/卷管理复杂 |
| T2 强制 Podman、T1 可选本地 | 风险和运维折中 | 需要可信等级与 runner policy 清晰绑定 |

### 推荐方向

- **[建议]** 实现统一 `PluginRunner` 接口；阶段 1 先实现 LocalProcessRunner，阶段 4 增加 PodmanRunner。
- **[建议]** T2 高风险网络/文件/进程能力推荐或强制 Podman profile；LocalProcessRunner 管理页必须明确“故障隔离，不是安全沙箱”。
- **[建议]** runner 选择不可让插件自行改变；管理员策略和 host policy 决定。
- **[待决策]** 阶段 1 Beta 前确认：无 Podman 时 T2 是拒绝激活、降级弱隔离并再次确认，还是允许管理员显式 override。推荐默认拒绝高风险 T2。

### 验收

- **[建议]** runner policy、资源限制、网络/文件 scope、子进程回收、日志、诊断和 UI 标记有跨平台测试。

---

## 21. ADR-020：主线程、配额、背压和故障域是公共平台约束

**状态：Proposed**

### 决策

- **[事实]** Bun HTTP/WS、SQLite、JSON、同步 FS/crypto/zlib 共享主线程；无界工作会表现为所有请求无响应。
- **[建议]** 每个插件/运行时/operation/session 都拥有独立的 frame、queue、concurrency、output、stderr、log、iframe 和 restart quota。
- **[建议]** 控制面消息（cancel、health、shutdown、permission result、最终状态）优先于普通流/日志/进度消息。
- **[建议]** Query/事件/Provider/UI 都采用分页/流式/合并；不在核心线程收集巨大 stdout/stderr 后再截断。
- **[建议]** timeout、backpressure、cancel violation、event-loop stall、慢调用、queue high-watermark 和资源峰值均进入结构化诊断。

### 后果

- **[建议] 正面**：插件平台不会成为新的主线程阻塞源，能够区分“插件慢”和“核心慢”。
- **[建议] 代价**：所有新贡献都需要明确输入/输出字节、超时、取消、分页和慢操作日志。

### 验证

- **[建议]** 事件风暴、provider 高频 delta、大 stderr、多 UI iframe、多插件冷启动和大 Query 负载下，核心健康/API p95/WS 背压仍在预算内。

---

## 22. ADR-021：契约命名与 envelope 冻结

**状态：Accepted**

### 决策

阶段 0 冻结以下跨文档、跨传输的公共名称和外层 envelope。实现必须使用这些名称，不得以同义词、旧内部类型名或传输专用别名替换：

- 身份：`pluginId`、`contributionId`、完整 contribution ID `${pluginId}/${contributionId}`、`providerTypeId`、`providerInstanceId`、`providerPrefix`、`modelId`。
- 版本：Manifest schema `1`、Host API `1.x`、RPC transport `narrafork.rpc/1`、provider business protocol `1.0`、UI bridge `narrafork.ui/1`。
- Manifest：根对象使用 `schemaVersion: 1`；严格未知字段拒绝；规范 JSON Schema 见 `contracts/manifest-v1.schema.json`，运行时权威校验为 `server/lib/plugins/manifest.ts` 的 `manifestV1Schema`。
- RPC：JSON-RPC `2.0` 的 request/response/notification 单对象 envelope；v1 禁止 batch。Content-Length framing、请求/响应/通知字段和错误码由 `server/lib/plugins/protocol.ts` 导出。
- Public Event：`schema: "narrafork.public-event"`、`schemaVersion: 1`、`eventId`、`topic`、`eventClass`、`occurredAt`、可选 `deliverySeq/resource/actor/resyncHint`、`data` 和 `redaction`。
- Query：`schema: "narrafork.query-result"`、`schemaVersion: 1`、`queryId`、`requestId`、`data`、可选 `page/asOf/stale` 和 `redaction`。
- Command：`narrafork.command-request` 与 `narrafork.command-result` envelope，使用 `requestId`、`correlationId`、`deadlineAt`、可选 `idempotencyKey/expectedVersion/operationId`，结果状态保留 `succeeded/accepted/running/failed/cancelled/unknown`。
- UI RPC：`protocol: "narrafork.ui/1"`，通过 `kind: request|notification|response` 区分 envelope；只允许 JSON value。
- 权限：`manifestRequested`、`installationGrants`、`hostPolicy`、`currentUserAuthority`、`currentInvocationScope`、`contributionPolicy`、`runnerEnforcement` 七个来源名，以及 `effectiveCapabilities` 和 fail-closed 错误 code 名称保持稳定。

### 边界

本 ADR 只接受**名称、schema 标识和 envelope 外形**。它不接受具体 runner 或 secret 存储实现，不承诺 durable event，不改变 UI 首版 bundle 格式，也不替代各 ADR 对权限、错误细节、背压数值和兼容窗口的后续证据要求。

因此以下事项仍明确保持未决：

- Podman 是否对 T2 或高风险 capability 强制，以及无 Podman 时的失败/降级交互（ADR-019、OQ-004）；
- Secret key/Secret Broker 的最终存储、注入、轮换和恢复方式（ADR-017、OQ-005）；
- durable Public Event log、replay 和 at-least-once 是否进入 v1（ADR-005、OQ-007）；
- UI 首版是否只允许 IIFE，还是开放 ESM/dynamic chunks（ADR-012、OQ-018）。

### 验证

- `server/lib/plugins/index.ts` 统一导出 `manifest.ts`、`permissions.ts`、`protocol.ts`；
- `tests/server/lib/plugins/contracts.test.ts` 覆盖 Manifest、RPC/provider、UI/PublicEvent、trust/scope/effective permission envelope；
- `docs/plugin-system/contracts/manifest-v1.schema.json` 与 Zod Manifest v1 的字段、默认值和 strict object 边界对照；
- 契约变更必须同时更新本 ADR、阶段 0 路线图和对应 fixture，不得只修改内部实现类型。

---

## 23. 未决问题清单

> “推荐”不是已接受决策。下表中的问题必须在对应阶段的阻塞任务完成前关闭，或明确记录为延期并降低发布范围。

| ID | 问题 | 推荐方向 | 阻塞阶段 | Owner/证据 |
|---|---|---|---|---|
| OQ-001 | Manifest v1 的最终字段/文件名/入口格式是什么？ | 先冻结最小静态 schema，动态贡献后置 | 0 | 架构 owner + schema fixture |
| OQ-002 | 0.x/1.x 的 Host API/RPC 兼容窗口多大？官方插件是否锁步？ | 至少保留一个旧 major；官方也走公共 API | 0 | 发布 owner + 兼容矩阵 |
| OQ-003 | 官方/组织签名根、私有根、吊销列表如何分发？ | 离线可验证、管理员可查看、签名不等于 grant | 0/1 | 安全 owner + 签名演练 |
| OQ-004 | T2 是否强制 Podman？ | 高风险 T2 默认 Podman；无 Podman 不静默降级 | 1/4 | 安全/运维 owner + 跨平台测试 |
| OQ-005 | secret 用 RPC config、secret channel 还是容器 secret？ | Secret Broker + opaque handle；短期值可受控注入 | 2/3 | 安全 owner + 日志扫描/rotation 测试 |
| OQ-006 | 旧包、storage、layout recovery copy 保留多久？签名吊销是否自动禁用？ | 旧包至少保留一个回滚版本；purge 显式；吊销 fail closed | 1/4 | 发布 owner + 磁盘预算/演练 |
| OQ-007 | 是否提供持久化 Public Event stream？ | v1 不提供，使用 Query/cursor 对账 | 2 | API owner + 可靠消费用例 |
| OQ-008 | Public Query/Command/Event 首批白名单有哪些？ | 只做高价值、DTO 稳定、可限量的资源 | 2 | API/领域 owner + 用例评审 |
| OQ-009 | Command 超时后的“结果未知”如何展示和查询？ | operation resource + idempotency key + status query | 2 | 领域服务 owner + 重试/副作用测试 |
| OQ-010 | 插件 storage 用核心 SQLite、独立 SQLite 还是 KV 文件？ | v1 抽象 API，优先宿主管理 namespaced store | 2 | DB owner + 锁/备份/恢复基准 |
| OQ-011 | storage 的 device scope 如何定义？ | 不把 iframe localStorage 当可靠跨设备存储 | 2/4 | 前端/产品 owner + PWA/多设备测试 |
| OQ-012 | 卸载是否默认删除插件 UI layout/storage？ | 默认保留，purge 单独确认 | 2/4 | 产品/运维 owner + 用户流程评审 |
| OQ-013 | MCP plugin contribution 是否允许远端 URL/插件 MCP client？ | 先只允许管理员配置目标，禁止 Manifest 任意网络 | 2 | MCP owner + SSRF/重连测试 |
| OQ-014 | Provider ID 最终使用 `${pluginId}/${localId}` 还是其他格式？ | `${pluginId}/${localId}` | 0/3 | Provider owner + Manifest/RPC 对照 |
| OQ-015 | Provider plugin 是否每 instance 一个进程？ | v1 每 provider instance 一个进程 | 1/3 | Provider owner + secret/concurrency 评估 |
| OQ-016 | Provider v1 是否覆盖 web search/image generation 实时事件？ | 规范化 block 保留，完整事件后置 | 3 | Agent owner + 真实 provider 用例 |
| OQ-017 | provider absolute timeout 是否可被插件提高？ | 不可提高，只能更短；用户调整宿主 soft limit | 3 | Agent/SRE owner + timeout 测试 |
| OQ-018 | UI bundle 首版 IIFE 还是 ESM/dynamic chunks？ | 首版 IIFE，后续以 CSP/CORS/离线证据评估 | 4 | Frontend owner + 真实浏览器矩阵 |
| OQ-019 | 静态插件 asset 是否未登录公开读取？ | hash asset 可公开，绝不包含用户数据；否则 asset capability URL | 4 | Security/frontend owner + URL/token 测试 |
| OQ-020 | 是否首版实现 top-level PluginUiLayer？ | 推荐实现；否则明确 grid-only | 4 | Frontend owner + director E2E |
| OQ-021 | narrator-scoped panel 是否允许改绑 narrator？ | 只允许显式宿主命令重新绑定 | 4 | UX/frontend owner + 多 narrator E2E |
| OQ-022 | UI-only plugin 是否可直接调用只读 Query？ | 允许最小只读 Query；写操作单独 grant，backend companion 非强制 | 4 | API/frontend owner + threat model |
| OQ-023 | UI/RPC/event/Provider 的最终 payload/queue/timeout 上限是多少？ | 先用 `04`/`05` 建议值，阶段 0 通过基线调整 | 0/3/4 | SRE owner + load report |
| OQ-024 | 是否支持 Module Federation 作为官方插件优化？ | v1 不支持；除非新 ADR 证明隔离和撤销 | 4/后续 | 架构 owner + 性能/供应链证据 |
| OQ-025 | 是否支持 WASM compute/plugin？ | v1 不支持通用 WASM；后续只做 capability-limited compute | 后续 | 架构/security owner + ABI/资源证据 |
| OQ-026 | 插件是否允许固定命名空间 HTTP endpoint？ | v1 不允许，统一 RPC；后续需 auth/body/timeout/SSRF 设计 | 1/2 | API/security owner |
| OQ-027 | scheduler 后台任务的最大运行时间/重试/并发是什么？ | 宿主 timer、硬 timeout、运行记录、无隐式用户权限 | 2 | Scheduler owner + chaos test |
| OQ-028 | 插件跨核心命令是否需要 workflow API？ | v1 不做，使用 operation/status/compensation | 2 | Domain owner + 业务用例 |
| OQ-029 | 核心 SQLite PluginStateStore 与 storage 是否共库？ | 抽象隔离；选择实现前完成锁/备份/迁移评估 | 1/2 | DB owner |
| OQ-030 | GA 要求哪些平台？ | Windows/Linux 阻塞，macOS 发布前验证 | 4 | Release owner + CI matrix |

---

## 24. 冲突与整合规则

- **[建议]** `01` 的能力边界和 T0–T3 是安全上限；本文件不能通过 ADR 允许被明确禁止的 raw DB/eventBus/JWT/任意 DOM 注入。
- **[建议]** `02` 的生命周期、状态机、generation、backoff、quarantine、upgrade journal 是宿主行为基线；Provider/UI 只能复用，不应自行创造第二套状态机。
- **[建议]** `04` 的 Provider RPC 字段、错误、seq、credit、cancel 和 `RemoteProviderAdapter` 映射是 provider 实现基线；本文件只补充其工程依赖和决策理由。
- **[建议]** `05` 的 iframe、MessageChannel、Dockview static component、placeholder、focus/workspace binding 和 director slot 是 UI 实现基线；本文件不允许 Module Federation 作为偷偷的替代路径。
- **[待决策]** 尚未存在的 `03`、`06`、`07`、`08` 文档可能进一步冻结 Manifest、事件/数据模型和安全实现。它们完成后如与本文件冲突，应在此表和 `09` 的依赖段落中显式更新，不能靠口头约定解决。

---

## 25. 决策完成定义

一个 ADR 只有在以下证据齐备后才能从 Proposed/Open 变为 Accepted：

1. **[建议]** 方案、替代方案、边界、失败语义和回滚语义已写明。
2. **[建议]** 至少有一个真实 fixture 或集成测试证明 happy path 与主要 failure path。
3. **[建议]** 安全边界、权限、secret、输出/时间/并发上限经过专项评审。
4. **[建议]** 对主线程、SQLite、WS backpressure、启动/退出和跨平台影响有测量或明确实验计划。
5. **[建议]** 已更新 `09` 的阶段任务、依赖、验收和发布/回滚门槛。
6. **[待决策]** 若 owner 无法在阶段截止前取得证据，必须缩小发布范围（例如禁用 provider/UI/高风险 runner），不能把未决项标成“默认安全”。

---

## 26. 当前推荐结论

- **[建议]** 先做阶段 0/1 的静态契约、进程外运行时、权限和诊断；不要先做 UI 炫技或 Module Federation。
- **[建议]** 阶段 2 先以 Public Query/Command/Event/Storage + 低风险 Tool/MCP adapter 验证平台边界，再接 Provider。
- **[建议]** 阶段 3 通过 `RemoteProviderAdapter` 把现有 ProviderAdapter 语义包在 RPC 外，不让 Agent Loop 被插件协议污染。
- **[建议]** 阶段 4 采用 sandbox iframe + MessageChannel + 单一 `PluginDockPanel`，让 Dockview 缺失恢复、director 和多 narrator context 可诊断、可回滚。
- **[建议]** Module Federation 与通用 WASM 都不进入 v1；它们若未来进入，必须由新 ADR 证明不会削弱默认的进程/iframe/capability 边界。
- **[建议]** 任何默认值都必须允许全局 kill switch、按插件/贡献撤销、旧包回滚和核心无插件启动；“安装成功”不等于“获得权限”或“正在运行”。
