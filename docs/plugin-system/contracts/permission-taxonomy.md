# NarraFork 插件权限分类契约（v1）

> 状态：阶段 0 契约冻结。
>
> 本文冻结插件权限的 capability、scope、信任等级和失败语义。名称以当前实现 `server/lib/plugins/permissions.ts`、`server/lib/plugins/protocol.ts` 的实际导出为准；Manifest 中的 `permissions.host` 仍只是请求上限，不能替代安装授权、宿主策略、用户权限或 runner 强制策略。

## 1. 规范来源与基本原则

### 1.1 实际导出

- `SCOPE_TYPES`：`global`、`session`、`user`、`project`、`workspace`、`chapter`、`narrator`、`provider`、`device`。
- `INVOCATION_SCOPE_TYPES`：`global`、`user`、`project`、`workspace`、`chapter`、`narrator`、`provider`、`device`。
- `CAPABILITIES`：本文第 2 节的完整白名单。
- `PERMISSION_SOURCES`：`manifestRequested`、`installationGrants`、`hostPolicy`、`currentUserAuthority`、`currentInvocationScope`、`contributionPolicy`、`runnerEnforcement`。
- `HIGH_RISK_CAPABILITIES` 与 `DEFAULT_DENIED_CAPABILITIES` 相同，见第 3 节。
- `WIDE_PERMISSION_TOKENS`：`*`、`all`、`admin`、`host.internal`、`filesystem.full`、`network.any`、`process.shell`；任何以 `.*` 结尾的权限也属于宽权限。

### 1.2 不可替代关系

1. **Manifest 请求不是授权**：未在 Manifest 请求的 capability，即使管理员想授予也不能补齐。
2. **信任等级不是授权**：签名、来源和 T0–T3 只影响可申请能力与 runner 策略，不能跳过 grant、用户 ACL、scope、审计或沙箱。
3. **scope 不是 capability**：capability 表示允许哪一类宿主 API；scope、字段、topic、路径、provider instance、速率和字节上限负责收窄资源范围。
4. **后台主体不继承用户主体**：`plugin_background` 不得继承最近一次 UI 用户的私有项目、章节、叙述者、消息或 secret 权限。
5. **宿主重新绑定身份**：`pluginId`、user、project、chapter、workspace、narrator、device、provider instance 和 secret ID 由宿主连接/调用上下文绑定，不能相信插件参数中的同名字段。

## 2. Capability 白名单

Capability ID 必须来自以下固定集合；不接受运行时自定义 capability、通配符或别名。`CAPABILITY_TAXONOMY` 按命名空间分组如下。

| 命名空间 | v1 capability |
|---|---|
| `plugin` | `plugin.install`、`plugin.enable`、`plugin.disable`、`plugin.upgrade`、`plugin.uninstall`、`plugin.grant` |
| `query` | `query.read.projects`、`query.read.chapters`、`query.read.narrators`、`query.read.message_summary`、`query.read.message_content`、`query.read.audit_self`、`query.read.audit_all`、`query.read.host_settings` |
| `event` | `event.subscribe.chapter`、`event.subscribe.narrator`、`event.subscribe.permission`、`event.subscribe.provider` |
| `command` | `command.narrator.send_message`、`command.narrator.interrupt`、`command.permission.decide`、`command.chapter.write`、`command.chapter.merge`、`command.review.write`、`command.routine.write` |
| `provider` | `provider.register`、`provider.use`、`provider.refresh_catalog` |
| `config` | `config.read_self`、`config.write_self` |
| `secret` | `secret.use_self` |
| `storage` | `storage.read_self`、`storage.write_self`、`storage.purge_self` |
| `device` | `device.read`、`device.command` |
| `ui` | `ui.panel`、`ui.notification`、`ui.open_external`、`ui.theme` |
| `network` | `network.egress.allowlist` |
| `filesystem` | `filesystem.workspace.read`、`filesystem.workspace.write` |
| `process` | `process.spawn.allowlist` |
| `schedule` | `schedule.register` |
| `diagnostics` | `diagnostics.readOwnLogs` |

### 2.1 高风险与默认拒绝

以下集合由 `HIGH_RISK_CAPABILITIES` 导出，并由 `DEFAULT_DENIED_CAPABILITIES` 直接复用。默认拒绝不因 T1、签名、安装成功或 UI 发起调用而改变；需要逐项管理员授权、明确资源 scope、风险提示和审计。

- `query.read.message_content`
- `query.read.audit_all`
- `command.permission.decide`
- `command.chapter.merge`
- `command.chapter.write`
- `secret.use_self`
- `device.command`
- `filesystem.workspace.write`
- `network.egress.allowlist`
- `process.spawn.allowlist`

只读 Query、摘要型 Event、插件自身的 config/storage 和受限 UI 也必须经过交集计算；“低风险”不等于绕过 Broker。

> `ui.theme` **不属于**高风险。主题贡献是纯声明式设计 token（颜色/主色/圆角/间距/字号），由宿主 `theme-compiler.ts` 严格校验（颜色正则、盒模型范围钳制、拒绝 `url()`/`@import`/`expression()`）后编译成作用域化的 Mantine CSS 变量覆盖，**零 JS、零代码执行**，风险与内置 OLED 模式同级。theme-only 插件（无 server、无 view）因此免管理员、免 grant；换肤的可见性由 per-user 启用状态控制，而不是能力授权。详见 3 号（Manifest，tier 分级）与 8 号（contribution point）文档。

### 2.2 Grant 约束

`permissionGrantSchema` 是严格对象，字段为：

- `capability`：上述 capability 之一；
- `scope`：第 3 节的 `PermissionScope`；
- `constraints`（可选）：`topics`、`resourceIds`、`fields`、`methods`、`paths`、`providerInstanceIds`、`maxRatePerSecond`、`maxBytes`；
- `expiresAt`、`grantId`、`grantedBy`（可选）。

约束只能收窄权限，不能扩大 capability、scope 或 runner 能力。过期、撤销、无法解析或版本不匹配均按未授予处理。

## 3. Scope 分类

### 3.1 Permission scope

`PermissionScope` 的形状是严格对象：

```ts
{
  type: "global" | "session" | "user" | "project" | "workspace" |
    "chapter" | "narrator" | "provider" | "device";
  id?: string;
}
```

- `global` **不得**携带 `id`。
- 除 `global` 外的所有 scope **必须**携带非空 `id`，长度上限 128。
- `session` 是存储/授权可用的 scope；它不属于 `INVOCATION_SCOPE_TYPES`，不能被伪装成稳定的用户或资源授权。
- scope 只能向下收窄：不能把一个具体 project/chapter/narrator scope 改写成 global，也不能用数组或模糊表达式扩展到全部资源。

### 3.2 Invocation scope

`InvocationScope` 是宿主绑定的调用上下文，字段均可选，但每个存在的值必须是长度 1–128 的非空 ID：

```ts
{
  userId?: string;
  projectId?: string;
  chapterId?: string;
  workspaceId?: string;
  narratorId?: string;
  deviceId?: string;
  providerInstanceId?: string;
}
```

它对应 `global`、`user`、`project`、`workspace`、`chapter`、`narrator`、`provider`、`device` 八类 invocation scope。插件提供的 `scope` 只能从宿主当前上下文收窄，不能切换到另一个用户或资源。

## 4. 信任等级（已撤销）

**[已撤销]** 原条款规定 `TRUST_TIERS` 四个规范值（`T0` core-compiled / `T1` official-or-organization-trusted / `T2` administrator-approved-third-party / `T3` unapproved-or-unknown），并把可执行性绑定到等级。该轴已随「安装即信任」原则移除，理由见 `../11-capability-policy.md` §3.7。

要点：一根有序轴同时编码了来源可信度、隔离强度和授权宽度三件互不相关的事，而这三者分别由签名验证、manifest 的 `engine.runner` 和 grant ∩ canonical adapter 决定。四级中 `T0` 不可达（核心代码不作为插件安装），`T1` 需要生产环境从未配置的 trust keyring；剩下 `T2`/`T3` 只是复述 admin-only 安装路由已经做过的决定。

现存的边界见 `../11-capability-policy.md` §4：管理员安装门槛、canonical adapter 门禁、grant 列表即撤销状态、manifest 声明的 runner、B 类存活限制。

## 5. Effective intersection

### 5.1 固定公式

每次 Query、Command、Event delivery、Storage、Config、Secret、Provider、Tool 或 UI bridge 调用都必须计算有效权限：

```text
manifestRequested
∩ installationGrants
∩ hostPolicy
∩ currentUserAuthority
∩ currentInvocationScope
∩ contributionPolicy
∩ runnerEnforcement
= effectiveCapabilities
```

`PERMISSION_SOURCES` 的七个名称是协议字段/审计名称，不得改用同义词。`installationGrants` 是 grant 对 capability 与 scope 的解析结果；`currentInvocationScope` 是上下文约束，不是插件可提交的 capability 列表。

### 5.2 状态门槛

交集非空仍不足以执行。至少同时满足：

- 插件 desired state 为 `enabled`；
- compatibility state 为 `compatible`；
- runtime 未处于 `failed`、`crashed` 或 `quarantine`；
- 当前 runtime generation、RPC/UI session、用户主体和资源 scope 仍有效；
- grant 未过期或撤销，runner 仍满足宿主安全策略。

`effectivePermissionSchema` 对交集成员、禁用/卸载状态和失败/崩溃/quarantine runtime 提供结构校验；宿主执行器还必须把兼容性、授权撤销和连接 generation 作为调用时门槛。

### 5.3 重新检查时机

权限不能只在安装、enable 或 session 建立时检查。宿主至少在以下边界重新检查：

- 每个 Query/Command/Tool/Secret 解析请求；
- 每个 Public Event 投递和 snapshot/live 对账页；
- 每次 UI bridge 请求、通知和 backend proxy 调用；
- 用户 logout、grant revoke、插件 disable、资源删除、scope 变化、runtime generation 变化；
- timeout/cancel、升级、回滚、卸载和 quarantine。

## 6. Fail closed 语义

无法证明“允许”时一律拒绝，不尝试更宽的 fallback、缓存旧 grant、直连网络、home 目录或内部 API。

| 情况 | 固定行为 | 对外错误 |
|---|---|---|
| capability 未在 Manifest 请求 | 拒绝调用，不用相近 capability 替代 | `PERMISSION_DENIED` |
| Grant 缺失、过期、撤销或解析失败 | 拒绝；不使用旧缓存授权 | `PERMISSION_DENIED` |
| 用户 authority、资源归属或 invocation scope 不明 | 拒绝；必要时用统一 not-found 语义避免枚举 | `NOT_FOUND_OR_DENIED` 或 `PERMISSION_DENIED` |
| 插件 disabled/uninstalling、runtime failed/crashed/quarantine | 拒绝新调用并撤销 session/handle | `PLUGIN_DISABLED` 或 `PLUGIN_UNAVAILABLE` |
| Host API / RPC / Manifest 不兼容 | 不执行；保留可诊断的 incompatible 状态 | `INCOMPATIBLE` 或 `PROTOCOL_VERSION_UNSUPPORTED` |
| runner 不满足要求、Podman 不可用但策略要求隔离 | 不降级执行；等待管理员修复或改选策略 | `HOST_UNAVAILABLE` 或 `PLUGIN_UNAVAILABLE` |
| scope、filter、字段、路径、topic 或约束无法判定 | 拒绝，不猜测归属或扩大范围 | `INVALID_FILTER`、`INVALID_PARAMS` 或 `PERMISSION_DENIED` |
| path realpath/containment、DNS/IP allowlist 或 redirect 无法确认 | 拒绝连接/文件操作，不回退到 home/direct | `PERMISSION_DENIED` 或 `HOST_UNAVAILABLE` |
| timeout/cancel 后副作用结果未知 | 标记 unknown，不自动重放 | `UNKNOWN_RESULT` |
| frame、payload、队列或输出超过上限 | 失败当前请求；持续违规终止 runtime | `PAYLOAD_TOO_LARGE`、`PLUGIN_BUSY` 或 `PROTOCOL_ERROR` |
| UI nonce、port、session 或 generation 不匹配 | 丢弃消息，撤销/重建 session，记录有界诊断 | `CONTEXT_UNAVAILABLE` |

错误消息只提供稳定 code、诊断 ID、有限原因和可操作建议，不泄露内部路径、堆栈、secret、其他用户或“资源存在但无权访问”的细节。

## 7. 错误码冻结

### 7.1 JSON-RPC 数字错误码

以下是 `JSON_RPC_ERROR_CODES` 的完整导出。它们描述 transport/JSON-RPC 层；业务权限与生命周期优先使用第 7.2 节的字符串 code。

| 数字 | 名称 | 典型语义 |
|---:|---|---|
| `-32700` | `PARSE_ERROR` | JSON 或 Content-Length body 无法解析 |
| `-32600` | `INVALID_REQUEST` | JSON-RPC envelope 非法 |
| `-32601` | `METHOD_NOT_FOUND` | 方法不在宿主/贡献白名单 |
| `-32602` | `INVALID_PARAMS` | 参数 schema、类型或约束失败 |
| `-32603` | `INTERNAL_ERROR` | 宿主未分类内部错误 |
| `-32001` | `PROTOCOL_VERSION_UNSUPPORTED` | RPC major/version 不兼容 |
| `-32002` | `PROVIDER_NOT_INITIALIZED` | provider 尚未完成初始化 |
| `-32003` | `CONFIG_INVALID` | provider/plugin 配置无效 |
| `-32004` | `MODEL_UNAVAILABLE` | 请求模型不可用 |
| `-32005` | `PLUGIN_BUSY` | 激活、并发或队列达到上限 |
| `-32006` | `OPERATION_ID_CONFLICT` | operation/idempotency 标识冲突 |
| `-32007` | `PAYLOAD_TOO_LARGE` | frame、参数或结果超过上限 |
| `-32008` | `PERMISSION_DENIED` | capability、grant、authority 或 scope 拒绝 |
| `-32009` | `PLUGIN_UNAVAILABLE` | 插件 runtime 当前不可用 |

### 7.2 Public/plugin 字符串错误码

以下集合同时对应 `PLUGIN_ERROR_CODES` 的值和 `PUBLIC_ERROR_CODES` 的完整顺序；字符串是跨 RPC、Query、Command、Event Gateway 和诊断的稳定业务 code：

`METHOD_NOT_FOUND`、`INVALID_PARAMS`、`INVALID_FILTER`、`PERMISSION_DENIED`、`CONTEXT_UNAVAILABLE`、`NOT_FOUND`、`NOT_FOUND_OR_DENIED`、`CONFLICT`、`RATE_LIMITED`、`PAYLOAD_TOO_LARGE`、`TIMEOUT`、`CANCELLED`、`PLUGIN_DISABLED`、`HOST_UNAVAILABLE`、`INTERNAL_ERROR`、`UNKNOWN_RESULT`、`PLUGIN_BUSY`、`PROTOCOL_ERROR`、`INCOMPATIBLE`、`CONFIG_CONFLICT`、`STORAGE_CONFLICT`。

其中：

- `NOT_FOUND_OR_DENIED` 用于不应暴露资源存在性的读取场景；
- `UNKNOWN_RESULT` 表示可能已经发生副作用，禁止宿主擅自重放；
- `PLUGIN_BUSY`、`RATE_LIMITED`、`TIMEOUT`、`HOST_UNAVAILABLE` 是否可重试必须由调用方结合 idempotency 和 deadline 判断；
- `PERMISSION_DENIED` 不允许通过错误文本提示如何扩大权限。

### 7.3 UI RPC 错误码子集

`UI_RPC_ERROR_CODES` 仅允许：

`METHOD_NOT_FOUND`、`INVALID_PARAMS`、`PERMISSION_DENIED`、`CONTEXT_UNAVAILABLE`、`NOT_FOUND`、`CONFLICT`、`RATE_LIMITED`、`PAYLOAD_TOO_LARGE`、`TIMEOUT`、`CANCELLED`、`PLUGIN_DISABLED`、`HOST_UNAVAILABLE`、`INTERNAL_ERROR`。

UI bridge 不把数据库、provider secret、内部 RPC 数字错误、完整栈或任意 `/api` 响应透传到 iframe。

## 8. 安全禁止项

以下行为是 v1 的硬禁止，不得通过签名、T1 信任、管理员 convenience flag、错误 fallback 或“仅内部使用”绕过：

### 8.1 权限与身份

- 声明或授予 `*`、`all`、`admin`、`host.internal`、`filesystem.full`、`network.any`、`process.shell` 或任何 `namespace.*`。
- 通过 Manifest、RPC/UI 参数、事件 payload 或错误响应伪造 `pluginId`、user、scope、permission decision、provider identity、device 或 secret ID。
- 让后台 principal 继承最近一次用户的私有 authority，或把具体 scope 升级为 global。
- 把 trust tier、签名、包来源、runner 标签当作 capability grant 的替代物。

### 8.2 核心实现与数据

- 直接 import `server/*`、调用内部 service、访问 SQLite/Drizzle、读取 DB 文件、使用原始 `eventBus`、Hono handler、JWT、完整 `ToolContext` 或核心 settings。
- 通过 Query/Event 返回 ORM row、`contentJson`、raw dump、完整 tool input/output、终端输出、完整 diff、绝对路径、cookie、Authorization、provider request secret 或其他插件 data。
- 在核心事务中执行第三方代码、让插件注册任意 route/middleware、动态覆盖核心 ID 或自行发布 `narrafork.*` 核心事件。

### 8.3 文件、网络与进程

- 使用绝对路径、`..`、符号链接/junction/reparse point、`file:`、`data:`、`javascript:`、localhost、云 metadata、Unix socket、Podman/Docker socket 或代理环境变量绕过 scope。
- 没有 `network.egress.allowlist` 时直连；无法确认 DNS 解析、IP、redirect、scheme、port 或代理策略时自动降级为 direct。
- 没有 `filesystem.workspace.*` 时访问 workspace；直接访问 `.git`、`.narrafork`、settings、数据库、credentials、uploads、shares、其他插件目录或用户 home。
- 没有 `process.spawn.allowlist` 时创建子进程；即使已授权也禁止 shell 拼接、`/bin/sh -c`、`cmd /c`、PowerShell 任意命令和不受监管 daemon/cron/systemd。
- 用 LocalProcessRunner 伪装为强安全沙箱；需要强边界却没有 Podman/OS 强制能力时必须拒绝激活。

### 8.4 Secret 与 UI

- 将 secret 写入 Manifest、命令行、普通环境变量、普通配置、storage、日志、stderr、request dump、错误详情、审计正文、UI bootstrap 或 iframe storage。
- 让 UI iframe 获得 JWT、Cookie、refresh token、provider secret、真实内部路径、宿主 DOM、React/Router/QueryClient 或任意 API fetch。
- 去掉 `sandbox="allow-scripts"` 基线，启用 `allow-same-origin`、forms、popups、downloads、top navigation、camera/microphone，或通过远程 CDN、动态脚本、Service Worker、`eval`/`new Function` 绕过宿主 CSP。

## 9. 实现与测试要求

阶段 0 只冻结契约，不开放第三方代码执行。后续实现必须至少覆盖：

- capability 白名单、宽权限和重复 grant；
- global/non-global scope 的 `id` 规则及 scope 只能收窄；
- 七层 intersection、禁用/不兼容/quarantine、撤销和 runtime generation；
- `NOT_FOUND_OR_DENIED` 的枚举防护、`UNKNOWN_RESULT` 不重放、deadline/cancel；
- path traversal、symlink/junction、DNS/IP/redirect、shell/子进程、secret 泄漏和 hostile iframe；
- frame/payload/queue/output 上限、backpressure、UI reload 和事件 overflow。

契约测试应直接引用 `server/lib/plugins/permissions.ts` 与 `server/lib/plugins/protocol.ts` 的导出，避免测试另维护一份 capability、scope 或 error code 常量。
