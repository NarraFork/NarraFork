# NarraFork 插件系统：安全、权限与沙箱隔离

> 本文定义插件后端进程、UI iframe、网络/文件/进程权限、secret、Podman、资源限制、信任级别和审计边界。Manifest 字段和安装流程见 `03-manifest-and-packaging.md`，宿主生命周期见 `02-host-architecture.md`，UI Bridge 的 Dockview 细节见 `05-ui-bridge-and-dockview.md`。
>
> **术语统一：** 持久化、审计和权限策略使用 `T0–T3` 作为规范信任等级；本文的 `trusted`、`restricted`、`sandboxed` 是运行 profile 标签，分别用于描述 T1、T2 弱隔离和 T2 强隔离实现。T3 只表示未批准、不可执行的包。

## 0. 标记约定与安全结论

- **[当前事实]**：可由当前仓库代码或已有设计直接确认。
- **[设计建议]**：本设计建议采用的目标行为。
- **[假设]**：为形成可执行方案而暂时采用，尚未实现或确认。
- **[待决策]**：需要后续 ADR、产品策略或实现阶段确认。

**[设计建议] 核心安全结论：**

1. 第三方后端插件不进入 NarraFork 核心 Bun 进程，不直接 import `server/*`、访问 SQLite、原始 `eventBus`、JWT 或内部 service。
2. 独立本地进程只提供故障隔离，不应被标称为强安全沙箱；需要文件、网络和进程边界时使用 Podman 或更强的 OS/VM 隔离。
3. 第三方 UI 永远使用宿主生成的 sandboxed iframe 和每实例 `MessageChannel`，不把插件 bundle import 到宿主 React tree。
4. Manifest 请求、管理员 Grant、宿主策略、当前用户权限和当前调用 scope 取交集；任何授权加载失败均 fail closed。
5. 签名证明发布者和完整性，不等于信任、启用或权限授权。

## 1. 当前代码事实与边界

### 1.1 核心进程和子进程

- **[当前事实]** `server/lib/mcp/manager.ts` 已实现外部 MCP server 的连接状态、工具发现、断线重连、工具调用取消和 shutdown；MCP 是协议适配器，不是通用安全沙箱。
- **[当前事实]** `server/lib/mcp/transports.ts` 的 stdio transport 当前会把 `process.env` 与配置环境合并传给 MCP 子进程，并使用 `stderr: "pipe"`；插件运行时不应照搬全部环境继承，因为其中可能有 provider key、JWT、代理和本机配置。
- **[当前事实]** `server/lib/spawn.ts` 的 `safeSpawn` 使用参数数组启动进程，支持硬超时、AbortSignal、watchdog、stdout/stderr draining、每流最大捕获字节数和进程树清理；Windows 会使用 `taskkill /T /F`，Unix 可递归终止子进程。
- **[当前事实]** `main.ts` 的 graceful shutdown 对 terminal、Bash、MCP、浏览器等步骤设置硬超时，并在 Windows 退出时清理自己的子进程树；插件 Supervisor 应接入同一退出原则。

### 1.2 配置、密钥与路径

- **[当前事实]** settings 默认存放在 `~/.narrafork/settings.json`，根目录可以通过 `NARRAFORK_HOME` 覆盖；settings 保存时采用临时文件加原子 rename，并使用 `0600` 文件模式。
- **[当前事实]** Agent/Bash/远程执行能力已经有工作目录、超时、输出大小和设备路由约束；项目文档明确说明路径 allowlist 不是 shell/PTY 的 OS sandbox。
- **[设计建议]** 插件只能通过公共 Query/Command/Storage/Config/Secret API 获得脱敏 DTO，不能得到 `db`、Drizzle row、完整 `ToolContext`、内部 service、JWT、用户 Bearer token 或真实凭据文件路径。

### 1.3 Podman 与现有 iframe

- **[当前事实]** `container-service.ts` 通过 rootless Podman/compose 管理章节容器，包含 Podman 检测、rootless 环境、compose 启停、端口分配和代理模式；它的输入是章节 worktree 中的 compose 配置。
- **[当前事实]** `benchmark-container.ts` 另有直接 `podman run -d` 的生命周期，支持 bind mount、memory limit、`exec`、超时和销毁；这说明直接 Podman runner 可行，但该服务不是插件授权/审计实现。
- **[当前事实]** `frontend/components/narrator/WebviewPanel.tsx` 的普通 webview sandbox 使用 `allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox`，并允许用户编辑任意 HTTP(S) URL；它面向用户网页，不能作为第三方插件 iframe 默认策略。
- **[当前事实]** 现有 shares HTML 响应设置了受限 CSP，但包含用户文件分享场景的策略，不能直接代替插件 asset shell 的 CSP。

## 2. 威胁模型

**[假设]** 插件可能是有 bug 的，也可能主动尝试越权。需要防护的行为包括：

- 读取或外传 `settings.json`、SQLite、JWT、provider credentials、其他插件 data 或用户 home 文件。
- 通过 workspace 路径、符号链接、junction、`..`、Windows reparse point 或远程设备路径绕过文件 scope。
- 通过 shell、子进程、Podman socket、Unix socket、localhost、云 metadata 地址、DNS 或代理绕过网络策略。
- 发送超大 JSON、无限 delta、重复重连、协议混帧、高频事件或未消费的日志，拖垮 Bun 主线程或全局内存。
- 伪造 pluginId、userId、workspace/narrator scope、权限结果、provider 身份或审计字段。
- 通过 UI iframe 读取宿主 DOM、localStorage、Cookie、JWT、同源 API，或向宿主注入 React、CSS、route、Service Worker。
- 在升级/卸载/回滚后保留孤儿进程、secret handle、文件锁、网络连接或布局引用。

**[设计建议]** 安全边界的目标不是证明插件代码“无恶意”，而是把可达资源缩小到声明、批准和当前调用所需的最小集合，并让失控插件可停止、可诊断、可审计。

## 3. 信任级别与有效权限

### 3.1 三种运行信任级别

**[设计建议]** 对管理员和 UI 显示使用三种运行信任级别：

| 信任级别 | 来源/含义 | 推荐运行器 | 默认能力 | 安全含义 |
|---|---|---|---|---|
| 可信 `trusted` | 官方或组织签名、来源可验证 | 独立进程；高风险仍可要求 Podman | 可申请较宽 Host API，但仍需 Grant | 信任发布者，不信任运行时行为 |
| 受限 `restricted` | 管理员批准的第三方/本地未签名包 | LocalProcessRunner | 只读 Query、插件存储、受限 UI；网络/文件默认拒绝 | 主要是故障隔离，不是强安全沙箱 |
| 沙箱 `sandboxed` | 不可完全信任、需要文件/网络隔离或管理员要求隔离 | rootless Podman，必要时 VM | deny-by-default，显式 allowlist | 以容器/OS 边界作为主要安全控制 |

- **[设计建议]** 三种级别都不允许第三方代码进入核心进程；`trusted` 不是进程内插件开关。
- **[设计建议]** 未签名/未知包在安装后可作为 `untrusted-pending` 元数据存在，但在管理员选择级别并授予权限前不得执行。
- **[设计建议]** UI 不因 trusted 而去除 iframe sandbox；可信 UI 仍使用同一 host-controlled shell 和 bridge，只能得到较宽的已批准 bridge method。
- **[待决策]** trusted 插件的默认 runner 是否允许 LocalProcessRunner；建议高风险能力仍默认 Podman，只有低风险 provider/tool 才允许本地进程。

### 3.2 有效权限公式

**[设计建议]** 每次调用都重新计算或使用短期缓存的有效权限：

```text
effectiveCapabilities =
  manifestRequested
  ∩ installationGrants
  ∩ hostPolicy
  ∩ currentUserAuthority
  ∩ currentInvocationScope
  ∩ runnerEnforcement
```

- Manifest 未声明的权限不能通过管理员 Grant 补齐。
- Grant 被撤销、用户退出、插件禁用、workspace/narrator 改变或 runner 降级时，已有 session 的权限也必须立即失效。
- 后台任务使用独立 `background principal`，不继承“最近一次用户”的权限；代表用户执行必须有明确的 user-bound invocation。
- pluginId、userId、workspaceId、narratorId、deviceId、secretId 和资源 scope 由宿主绑定，不能相信插件请求参数中的同名字段。

## 4. 权限模型

### 4.1 权限分类

**[设计建议]** Manifest 的 `permissions` 采用命名空间，细粒度权限可以在安装时被宿主展开为资源范围：

| 命名空间 | 示例 | 默认策略 |
|---|---|---|
| `query.*` | `query.chapters.read`、`query.projects.read` | 只读、分页、脱敏 |
| `command.*` | `command.chapters.create`、`command.reviews.create` | 显式授权、参数 schema、审计 |
| `event.*` | `event.subscribe.chapter.changed` | 白名单 topic、过滤、节流 |
| `storage.*` | `storage.workspace.read/write` | 仅自身命名空间、配额 |
| `config.*` | `config.read/write` | 仅自身配置，不含 secret 值 |
| `secret.*` | `secret.use.providerApiKey` | 按 secret ID、scope 和调用目的 |
| `network.*` | `network.egress.allowlist`、`network.proxy` | 默认 none；域名/端口 allowlist |
| `filesystem.*` | `filesystem.workspace.read` | 默认 none；真实路径 containment |
| `process.*` | `process.spawn.allowlist` | 默认 none；禁止 shell |
| `ui.*` | `ui.panel`、`ui.notification`、`ui.openExternal` | 固定 contribution point |
| `schedule.*` | `schedule.register` | 宿主持有 timer、并发和取消 |
| `diagnostics.*` | `diagnostics.readOwnLogs` | 只读自身摘要，脱敏有界 |

**[设计建议]** 不能声明笼统的 `admin`、`all`、`filesystem.full`、`network.any`、`process.shell` 或 `host.internal` 权限。确有高风险需求时，应增加具体资源范围并触发二次确认。

### 4.2 Query、Command 与 Event

- Query 不返回 ORM row、原始 `contentJson`、raw dump 或无限数组；使用 cursor、`LIMIT n + 1`、摘要字段和字节上限。
- Command 表达业务意图，不暴露任意 service 方法、SQL、Hono handler 或函数名。核心负责 Zod 校验、用户授权、事务、幂等和审计。
- Event Gateway 只转发白名单公共事件，先脱敏再过滤；插件 handler 的返回值不能影响核心事件是否成立。
- 工具插件的权限仍由核心 Agent permission handler 决定；插件不得在返回值中声明“已获批准”或绕过用户确认。
- event 默认 at-most-once；需要可靠恢复的插件使用 Query/cursor 对账，不能依赖内存 eventBus 补发。

## 5. 后端进程隔离

### 5.1 LocalProcessRunner：故障隔离而非安全沙箱

**[设计建议]** 本地进程模式的硬边界如下：

- 一插件一进程；不同插件不得共享 JS isolate、全局变量、模块缓存或 stdin/stdout。
- 使用参数数组启动，禁止 `/bin/sh -c`、`cmd /c`、PowerShell 拼接和任意 shell template。
- 环境变量使用 allowlist：只传 `PATH` 的受控子集、locale、运行时版本、逻辑路径、runtime ID、RPC protocol 和必要的非敏感 feature flags。
- 不传 `HOME`、`NARRAFORK_HOME`、`settings.json` 路径、数据库路径、JWT secret、完整 parent env、provider credential path 或用户 Bearer token。
- 包目录只读；插件 data、tmp、logs 分开挂载/映射。插件不能通过 cwd 或相对路径访问另一个插件目录。
- stdout 只承载 framed RPC；stderr 进入限速、脱敏、大小有界的 ring buffer。
- 使用 spawn/handshake/activation/RPC/stream idle/total/drain/shutdown 分层 timeout；插件不能提高宿主硬上限。
- AbortSignal 取消应发送 RPC cancel；不响应时按宽限期关闭请求并终止运行时。
- 递归清理子进程。Unix 使用进程组/子进程遍历，Windows 使用 `/T`；退出和升级时不能留下后台 server、shell 或 helper。

**[当前事实]** `safeSpawn` 已经实现了安全 drain、超时、输出上限、watchdog、AbortSignal 和 Windows/Unix 进程树清理，可复用其原则。**[设计建议]** 插件 Supervisor 不能把完整 stdout 收集到内存后再解析，应使用 streaming framing、credit window 和每帧上限。

### 5.2 RPC 过程边界

- 握手前只接受小型 `hello`，并把 pluginId、版本、包摘要、RPC protocol 与安装记录比对。
- 每个 request 有宿主生成的 `requestId`、`runtimeGeneration`、deadline、取消关系和调用 principal。
- 迟到 response/event、旧 generation 的消息、重复 response 和未知 operation 一律丢弃并限量记诊断。
- 插件进程退出时，在途请求失败；如果副作用 command 的结果未知，不自动重放。
- 运行时只能调用其被授予的 Host API；Host API 端再次检查 pluginId、Grant、当前用户和资源范围，不信任“来自本地 stdin”这一事实。
- stdout/stderr、RPC payload、provider 流和 UI bridge 都使用独立额度，防止一个高频流占满控制面。

### 5.3 运行时健康与恢复

- 心跳只表示 transport 活跃，不替代实际调用 timeout、队列积压和资源检查。
- 进程启动成功但握手失败、协议错误、越权路径、拒绝 cancel、超过资源上限时进入 failed/quarantine，而不是无限重启。
- 建议初始重启预算为 1 分钟最多 3 次、15 分钟最多 10 次；稳定运行一段时间后才清零失败计数。
- 核心重启时根据 runtime lease/generation 回收旧状态；不能假定插件已经执行 deactivate。

## 6. 网络权限

### 6.0 当前实现状态

>
> 强制 allowlist 需要 Linux network namespace（netns + iptables owner-match）或 Podman runner 的 `--network` 隔离。这是独立的大型工程，不应依赖当前字段的存在而假设已有强制。
>
> 代理 URL 的 SSRF 缓解已在 `plugin-provider-proxy-policy.ts` 中实现（拒绝私有/保留地址，可通过 `settings.plugins.allowPrivateProxyTarget` 放行），但这只覆盖宿主主动推送给插件的代理配置，不限制插件自身的出站能力。

### 6.1 默认策略

**[设计建议]** 后端插件和 UI iframe 的默认网络策略都是 `none`：

- UI iframe `connect-src 'none'`，不能 fetch NarraFork API、公网、localhost、Unix socket 或浏览器扩展协议。
- 后端插件没有网络权限时，runner 使用 Podman `--network none` 或本地策略层阻断出站。
- 需要访问供应商时优先使用宿主 Network Proxy/Secret Broker，由宿主应用统一代理、TLS、审计和超时。
- 直接出站必须声明 `network.egress.allowlist`，按 scheme、DNS name、port 和是否允许重定向限制；默认禁止任意 IP、localhost、回环、link-local、云 metadata 和 Unix socket。
- DNS 请求也视为网络能力；不能因 HTTP allowlist 而允许任意 DNS 外传。
- 禁止通过宿主 Podman socket、Docker socket、`/run`、`/var/run`、代理环境变量或 `NARRAFORK_VNET` 旁路获得其他网络。

### 6.2 allowlist 规则

**[设计建议]** 网络范围采用结构化配置，不接受正则或任意命令：

```json
{
  "network": {
    "mode": "allowlist",
    "domains": ["api.example.com"],
    "ports": [443],
    "protocols": ["https"],
    "followRedirects": false,
    "maxConnections": 8
  }
}
```

- DNS 解析后的 IP 需要再次检查，防止域名解析到私网、回环或 metadata 地址。
- redirect 必须重新进行域名、scheme、port 和 IP 检查；默认不跟随跨域 redirect。
- 代理模式下插件只连接宿主分配的 proxy endpoint，不能读取 proxy credentials。
- `settings.proxy` 的全局 direct/system/custom 是宿主出站策略；插件不能自行覆盖宿主安全策略或强制 direct 绕过企业代理。
- **[待决策]** v1 是否实现本地进程的完整出站阻断；若不能可靠实现，应将“需要网络隔离”的插件自动提升到 Podman，而不是仅在 UI 显示警告。

### 6.3 入站监听：已知例外（loopback OAuth 回调）

本节 6.1–6.2 只规范**出站**。`permissions.network` 目前是文档而非强制——`manifest.ts` 的
`uninspectedPermissionSchema` 注释明确记录宿主没有任何 reader，插件进程的网络能力来自操作系统。
因此插件在技术上**可以**监听本机端口，不会被运行时拦截。

`examples/plugins/cline-external` 是第一个真正依赖这一点的插件，如实记录为已知例外：

- **为什么需要**：Cline 的 OAuth 授权流把凭据回传到一个 `callback_url`。该 URL 随授权请求发往
  上游，必须与实际监听的地址端口一致，所以无法用宿主端点代收，也不能静默改端口。
- **风险面收窄**：只绑 `127.0.0.1`（不是 `0.0.0.0`）；只在一次登录进行中开启；单一固定端口
  19876；5 分钟超时后自动关闭；`deactivate` 与 `shutdown` 必须 `server.stop(true)`。
- **不可用时如实上报**：Podman runner 下 loopback 不在宿主命名空间内，浏览器回调打不到。
  插件的 `status` 命令返回三态 `browserAuth: "available" | "port_busy" | "unsupported"`，
  UI 据此隐藏按钮并引导用户改用「粘贴回调 URL」路径——该路径不依赖任何监听端口，
  是远程部署与容器环境下的正式方案，不是降级兜底。
- **端口冲突**：内置 Cline 适配器使用同一端口。冲突时返回明确的 `PORT_IN_USE`，
  不静默换端口。

**这条先例的代价**：后续插件可以引用它申请同类能力。若要真正约束，应当在 runner 层实现
（Podman 网络命名空间已天然阻断），而不是依赖 manifest 声明——与 6.2 末尾那条 [待决策]
是同一个缺口的两个方向。

## 7. 文件系统权限

### 7.1 逻辑范围

**[设计建议]** 文件权限至少拆成以下 scope：

| scope | 访问 | 默认 |
|---|---|---|
| `package` | 插件版本目录 | 只读 |
| `pluginData` | `~/.narrafork/plugins/data/<pluginId>` | 读写，但有配额 |
| `pluginTemp` | 宿主创建的临时目录 | 读写，退出清理 |
| `workspace` | 指定项目/worktree 子路径 | 默认 none |
| `device` | 远程执行设备路径 | 默认 none，必须单独授权 |
| `coreData` | settings、DB、uploads、credentials、其他插件目录 | 永不直接开放 |

- `filesystem.workspace.read`/`write` 必须绑定具体 project/chapter/worktree 和规范化相对路径；不要只授予“用户 home”。
- 路径先 `resolve/realpath`，再做 containment；同时检查父目录、符号链接、junction、reparse point 和路径大小写等价。
- 写入操作应使用宿主文件 API，由宿主检查目标 scope、大小、文件类型、覆盖策略和审计；不把真实 root path 当作权限证明。
- 归档解压、文件预览、哈希、sanitize 和大文件传输需要大小上限或流式路径，不在核心请求路径进行无界同步处理。

### 7.2 workspace 写权限

- 读写 workspace 是高风险能力，应显示具体项目、章节、相对路径、读/写级别和是否允许删除。
- 默认阻止写入 `.git`、`.narrafork`、凭据文件、SSH key、云凭据、系统目录和宿主插件目录。
- `write`、`delete`、`rename` 结果必须带 operation ID；超时后不能假定未发生副作用，不能无条件自动重试。
- 若插件需要执行 Git，使用公共 Git Command API；不要给插件一个可写 worktree 后再允许任意 shell 作为“方便接口”。
- 远程设备路径与本地路径是不同的信任域；必须绑定 `deviceId` 和远端 executor 的 allow-root/权限策略，且明确其不是 OS sandbox。

## 8. 进程和系统能力

- `process.spawn` 默认 `none`；工具、provider 或 UI 插件不能因为拥有网络/文件权限而自动获得子进程权限。
- 若确需启动 helper，Manifest 声明 executable ID、参数 schema、cwd scope、环境 allowlist、并发和 timeout；宿主按固定命令数组启动，不执行 shell。
- 禁止访问 `ptrace`、调试接口、系统服务管理、设备节点、内核模块、setuid、宿主容器 socket、浏览器 profile、其他进程内存和任意 IPC socket。
- Podman runner 内默认 `cap-drop=ALL`、`no-new-privileges`、非 root 用户、只读 rootfs、受限 `/tmp`、pids limit 和无 host PID/network namespace；禁止 `--privileged`。
- 插件不能自行创建不受监管的 daemon、cron、systemd service、登录启动项或持久化进程；定时任务必须通过宿主 Scheduler contribution。
- 进程创建、终止、异常退出、超时、资源违规和 helper 版本都进入审计摘要。

## 9. 资源限制、背压与主线程保护

### 9.1 协议和队列

**[设计建议]** 初始基线与 `02-host-architecture.md` 对齐：

| 资源 | 建议基线 | 处理 |
|---|---:|---|
| 单 RPC frame | 1 MiB | 拒绝并终止协议违规 runtime |
| 单 runtime 排队 | 8 MiB | 背压；超过硬限失败新请求 |
| 最大在途 RPC | 16 | 返回 busy |
| 单 operation 输出 | 按 contribution 设上限 | cancel，不静默截断关键 JSON |
| stderr ring | 1 MiB/进程 | 丢弃最旧内容 |
| UI request/notification | 256 KiB | 返回 `PAYLOAD_TOO_LARGE` |
| UI response | 1 MiB | 要求分页/流式附件 |
| UI event queue | 有界 | 状态事件合并，超限发 overflow |

- 流式 provider/tool 使用 event/byte credit window；控制消息、cancel、error、done 预留 terminal credit。
- 日志、进度和可丢弃通知可采样/合并；最终响应、取消确认、权限结果和生命周期状态不能因普通流量饿死。
- 高频 narrator token、terminal output、完整 diff、raw dump 和大图片不进入通用 event API；使用专用分页/流式/附件协议。
- 请求队列等待时间计入调用 deadline；不能通过无界排队规避 timeout。

### 9.2 CPU、内存和容器额度

**[假设]** Podman runner 可先采用以下保守默认值，最终按部署规模调整：

```text
memory: 512 MiB/plugin runtime
cpus: 1.0
pids-limit: 128
/tmp: 64 MiB tmpfs
max open files: host/runner 可实现时限制
```

- 超额由 runner/宿主记录原因并先取消当前 operation；持续违规终止 runtime 并进入 backoff/quarantine。
- 本地进程在跨平台无法可靠设置硬 cgroup/job object 时，只能提供 RSS/CPU 监测和 best-effort kill，并在 UI 标为“弱隔离”。
- 安装、解压、签名验证、哈希、日志读取和文件预览也要有输入大小、输出大小、超时和取消，不得只限制运行时内存。
- 宿主主线程不运行插件代码、不等待插件同步回调、不执行插件 SQL、不收集无界 stdout/stderr；解析器只做 framing、轻量 schema 校验和路由。

## 10. Podman sandbox 设计

### 10.1 与现有容器服务的关系

- **[当前事实]** 现有 `container-service.ts` 以章节 worktree、compose 文件、端口分配和容器代理为中心；它允许用户 compose 内容参与容器生命周期。
- **[当前事实]** `benchmark-container.ts` 使用 rootless `podman run`、bind mount、memory limit、`exec` 和 destroy，是更接近插件 runner 的直接生命周期参考。
- **[设计建议]** 新增的 `PodmanRunner` 应实现独立的插件容器规格，不直接复用章节 compose，也不允许插件包携带 compose 文件来扩大 host mount、端口或 capability。

### 10.2 推荐容器规格

**[设计建议]** 每次激活使用固定 image digest 和明确参数，概念上类似：

```text
podman run --detach
  --name nf-plugin-<runtimeId>
  --user <non-root>
  --read-only
  --network none
  --cap-drop ALL
  --security-opt no-new-privileges
  --pids-limit 128
  --memory 512m
  --cpus 1
  --tmpfs /tmp:rw,size=64m,noexec,nosuid,nodev
  -v <package>:/plugin:ro
  -v <plugin-data>:/data:rw
  <image>@sha256:<digest>
  <fixed-entrypoint> /plugin/server/index.js
```

- 不使用 `--privileged`、host network、host PID、host IPC、Podman/Docker socket、任意设备映射或隐式 `$HOME` mount。
- package 只读、data 可写、tmpfs 临时；secret 优先使用只读 `/run/secrets/<id>` 或 RPC opaque reference，不能写进 image 或普通环境。
- 默认不映射宿主端口；插件与宿主通过 stdio/受控 socket 通信。需要对外 HTTP 的插件应经宿主反向代理和固定 namespace，v1 可不支持。
- image 必须预拉取、digest pin、静态校验并记录来源；不要在核心请求路径或首次激活时无界 pull。
- rootless Podman 的网络依赖可能需要 pasta/passt；无网络的插件不应因为网络后端缺失而无法运行。需要 egress 的插件先检查 rootless 网络和 allowlist proxy 能力。
- 容器 stop/rm、日志读取和 inspect 都必须有超时和输出上限；不能把无限 `podman logs` 收集到核心内存。
- 容器启动、停止和状态恢复要写 plugin runtime journal；主机重启后把旧 container 视为 stale，按 pluginId/runtimeId 清理或隔离。

### 10.3 Podman 不是唯一边界

- **[设计建议]** rootless Podman 降低宿主权限和文件范围，但依赖内核、用户命名空间、容器配置、镜像供应链和平台实现；不能宣称对内核漏洞、恶意管理员或宿主用户 root 提供绝对隔离。
- **[待决策]** Windows/macOS Podman machine、WSL 和 Linux rootless 的统一支持矩阵、最小版本、网络 allowlist 实现和失败降级策略。
- **[设计建议]** 如果目标平台无法提供可信的容器/OS 隔离，管理员应只能选择 restricted 弱隔离或完全禁用高风险插件，不自动降级为“看似沙箱”的本地进程。

## 11. UI iframe、CSP 与静态资源

### 11.1 iframe sandbox 基线

**[设计建议]** 插件 UI 使用宿主控制的 HTML shell：

```tsx
<iframe
  sandbox="allow-scripts"
  referrerPolicy="no-referrer"
  allow=""
  title={hostResolvedTitle}
/>
```

- 默认只允许 `allow-scripts`；禁止 `allow-same-origin`、`allow-forms`、`allow-popups`、`allow-downloads`、`allow-top-navigation`、`allow-modals`、camera、microphone、geolocation、clipboard、pointer lock 和 presentation。
- 禁止插件控制外层 HTML、sandbox 字符串、CSP、`<base>`、meta refresh、外部 frame、Service Worker 和宿主页面的 `document/window` 引用。
- 外部链接通过 host command（例如 `ui.openExternal`）打开；宿主校验 `http/https`、allowlist、用户确认和审计，不给 iframe `allow-popups`。
- 所有插件 UI 即使 trusted 也不去除 sandbox；信任等级只决定允许的 bridge method 和后端能力。
- 当前普通 `WebviewPanel` 的宽松 sandbox 仅用于用户指定网页；不能复制到插件。

### 11.2 CSP

**[设计建议]** shell 由宿主生成并设置至少以下 CSP；实际 asset origin/version/hash 由资源服务填充：

```text
sandbox allow-scripts;
default-src 'none';
script-src https://<plugin-asset-origin>;
style-src https://<plugin-asset-origin> 'unsafe-inline';
img-src https://<plugin-asset-origin> data: blob:;
font-src https://<plugin-asset-origin>;
connect-src 'none';
frame-src 'none';
child-src 'none';
worker-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
manifest-src 'none';
media-src 'none';
```

- 禁止远程 CDN script、远程 stylesheet、runtime `eval`、`new Function`、inline script 和未声明动态 import。
- asset URL 使用 `<pluginId>/<version>/<contentHash>/...`，响应设置准确 MIME、`X-Content-Type-Options: nosniff`、不可变缓存和路径 containment。
- `connect-src 'none'` 强制 UI 通过 MessagePort；若未来开放 UI 网络，必须单独设计 proxy capability 和 CSP，并默认阻止 localhost/metadata。
- 首版优先 IIFE bundle；ESM/dynamic chunks 在 opaque origin 下需要 CORS、CSP、依赖图校验和缓存回收，不能仅把 entry 扩展名改成 `.mjs`。
- UI static asset 可以在未登录时读取的方案必须保证资源不含用户数据和 secret；如果产品要求隐藏插件清单，使用短期 asset-only capability URL，不把主 JWT 放进 iframe URL。

## 12. MessageChannel 与 UI Bridge

### 12.1 建连和身份绑定

**[设计建议]** 每个 `panelInstanceId` 使用独立 iframe、独立 session、独立 `MessageChannel`、独立取消域和权限快照：

1. 宿主生成至少 128 bit 随机 `connectNonce`、`panelInstanceId`、session generation 和 `MessageChannel`。
2. iframe 加载完成后，宿主只通过一次 `contentWindow.postMessage` 发送 bootstrap，并 transfer `port2`。
3. bootstrap 包含 `protocol`、`hostProtocolRange`、`pluginId`、`contributionId`、`panelInstanceId` 和 nonce 的受控摘要；不要包含 JWT、Cookie、secret 或原始内部路径。
4. 因 `sandbox` iframe 的 `event.origin` 可能是 `"null"`，SDK 必须同时检查 `event.source === window.parent`、消息类型、protocol 和 nonce；不能只依赖 origin。
5. 建连完成后关闭 window-level listener，所有请求只走 `MessagePort`。
6. Host session 绑定 `{ userId, pluginId, contributionId, panelInstanceId, surfaceScope, runtimeGeneration }`；插件不能在 params 中改写这些值。
7. iframe reload、panel remove、route unmount、插件禁用、权限撤销、用户 logout 时关闭 port，取消未完成 RPC，退订事件并清理 session。

### 12.2 JSON-only RPC

**[设计建议]** 即使 `MessagePort` 支持 structured clone，公共协议也只允许 JSON value：

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type UiRpcRequest = {
  protocol: "narrafork.ui/1";
  kind: "request";
  id: string;
  method: string;
  params?: JsonValue;
};

type UiRpcResponse =
  | { protocol: "narrafork.ui/1"; kind: "response"; id: string; result: JsonValue }
  | { protocol: "narrafork.ui/1"; kind: "response"; id: string; error: UiRpcError };
```

- 禁止传函数、DOM node、React element、Error object、AbortSignal、数据库实体、宿主 class 实例和未声明的 `MessagePort`。
- 每个 request 有 request ID、超时、取消关系、最大 params bytes 和方法 allowlist；response 绑定同一个 panel session 和 generation。
- 宿主不接受插件指定的 pluginId、userId、JWT、API path、任意 URL 或其他 panel ID。
- `rpc.cancel` 是高优先级控制消息；取消后迟到 response/event 被丢弃并记录有限诊断。
- 单 request/notification 暂定 256 KiB、单 response 1 MiB；大数据使用分页、cursor 或受控附件，不塞进 Dockview layout 或一次性 JSON。
- 事件队列有界；状态事件合并为最新值，业务事件超限发送 `events.overflow`，插件随后主动 Query 当前状态。

### 12.3 UI API 约束

**[设计建议]** UI Bridge 只暴露高层、声明式 host method：

- `context.get/subscribe`：返回已过滤的 locale、theme、surface、panel、workspace/narrator 摘要；不返回 Router、QueryClient、JWT 或完整 URL state。
- `panel.getState/setTitle/setBadge/setDirty/updateParams/focus/close/open`：标题、badge、dirty 由宿主 chrome 渲染，插件不能提供 HTML/CSS/React node。
- `queries.execute`：调用公共只读 Query；方法和 scope 来自 Manifest/Grant。
- `commands.execute`：调用已声明、当前可见且已授权的 command；不能执行任意 `/api` path。
- `events.subscribe/unsubscribe`：topic、filter 和字段由公共 Event Gateway 校验；不能访问 raw eventBus。
- `storage.get/set/delete/list`：namespace 由 host 强制绑定 `{pluginId,userId,scopeResourceId}`；iframe 不能传入其他 pluginId/userId。
- `backend.call`：只访问当前 pluginId 自己的后端 RPC，不能访问其他插件、localhost、文件 URL、云 metadata 或任意 Hono route。
- `notifications.show/update/dismiss`：纯文本、限速、限长、带插件来源；action 只能指向已声明 command。
- `ui.openExternal`：宿主校验协议、allowlist、用户确认并审计。

iframe 永远不能直接读取 NarraFork API 的 Authorization header、refresh token、response cookie、JWT、provider secret 或 server internal address；即使浏览器同源策略“看起来允许”，也不应把它当作插件 API。

## 13. Secret 与隐私保护

- secret 的定义、required/scope/usage/inject 方式由 Manifest 声明，但值由宿主 Secret Broker 管理。
- secret 不进入进程命令行、普通环境、Manifest、UI bootstrap、日志、错误详情、审计正文、请求 dump 或插件 storage 导出。
- secret 使用按 pluginId、secretId、user/workspace scope、provider instance、requestId 和目的绑定；调用完成或权限撤销后短期句柄失效。
- 只记录 secret ID、是否命中、耗时、结果码和 hash/指纹（如确有诊断需要），不记录值、长度推断或原始 provider response。
- **[已撤销]** 原条款写「provider 插件不能读取任何已存储的 secret 明文」「不能列举宿主 secret」。
  该限制已按"安装即信任"原则撤销，理由与完整清单见
  **[11 号文档](./11-capability-policy.md)**。
  - 插件现在可以对**自己命名空间内**的 secret 执行 `secrets.get`/`set`/`delete`/`list`，
    对照 VS Code 的 `secrets` API（get/store/delete/keys 全开、无声明要求、无门禁）。
  - **唯一保留的隔离是结构性的**：key 由宿主按调用方 pluginId 派生，插件 API 里没有 pluginId
    参数，跨插件访问在结构上不可表达。这与 VS Code 的
    `mainThreadSecretState` 用宿主注入的 `extensionId` 派生 key 是同一机制。
  - 宿主单向注入仍然保留并且是 provider 请求的**首选路径**：宿主在每次
    `provider.chat`/`generate`/`listModels` 前解析该 provider 声明的 secret 字段，随 `config`
    一起下发（见 04 号文档 D-04 与
    `server/services/plugin-provider-credential-resolver.ts`）。值不缓存，撤销或轮换在下一次
    请求即生效。插件因此通常不需要自己读取。
- **[已修订]** provider 插件的 command 返回值可携带 `secretWrites`，请求宿主把凭据写入自身命名空间。
  - **为什么需要**：`provider-settings` iframe 的 CSP 是 `connect-src 'none'`，无法调用宿主
    admin 配置端点，因此插件自带的凭据管理页原本无法保存任何修改。
  - **保留的限制**，见 `server/services/plugin-command-secret-writes.ts`：
    - key 必须是 `provider.<该插件自己的 contributionId>.<field>`；跨插件、跨 contribution
      一律拒绝，且两类越界的错误信息完全相同，避免插件借错误差异探测其他插件的 contribution
      是否存在
    - 单值 ≤ 64 KB；超限报错而非静默截断。**这不是信任限制**：vault 是主线程上的同步 JSON
      读改写，无上限值会阻塞所有请求（见 CLAUDE.md 主线程铁律）
  - **[已撤销]** field 必须在 `configSchema` 声明、单批总量 ≤ 256 KB、条目数 ≤ 50、重复 key
    拒绝、批量原子性。理由见 11 号文档。
    - **代价需明确记录**：批量写入不再原子。写入按顺序应用，中途 I/O 失败会留下已写入的前序
      条目。轮换凭据的插件必须容忍部分应用的批次。
  - 覆盖测试见 `tests/server/services/plugin-command-secret-writes.test.ts`（19 项）。
- **[已撤销]** 原条款写「UI 插件默认永远拿不到 secret」。iframe 现在与插件后端拥有同等的
  secret 读写能力（`secrets.get`/`set`/`delete`/`list` 同时进入
  `PLUGIN_TO_HOST_REQUEST_METHODS` 与 `PLUGIN_UI_BACKEND_METHODS`，两个清单同步添加，
  contract parity 断言保持严格相等未作削弱）。
  - **为什么这不真正扩大攻击面**：一个恶意 UI 插件本来就能通过自己的后端 command 拿到同样的
    值。原限制阻止的只是"设置页显示用户已配置过什么"这一正当功能。
  - key 同样由宿主按 `session.pluginId` 派生，视图无法命名其他插件的 secret。
- **[待决策]** 是否引入系统 keychain/OS credential vault；在未决定前，至少保证插件 data 与核心 settings 分离，且 secret 通过 broker 而不是 JSON 明文复制。

## 14. 审计、诊断与告警

### 14.1 审计事件

**[设计建议]** 审计由核心写入，插件不能伪造或删除。每个跨边界事件至少包含：

```json
{
  "timestamp": "2026-01-01T00:00:00.000Z",
  "operationId": "op_123",
  "pluginId": "com.example.review",
  "pluginVersion": "1.2.3",
  "packageDigest": "sha256:...",
  "trustLevel": "sandboxed",
  "runtimeId": "rt_123",
  "runtimeGeneration": 4,
  "principal": "user:...",
  "contributionId": "review-chapter",
  "capability": "command.reviews.create",
  "resourceScope": { "projectId": "...", "chapterId": "..." },
  "result": "success",
  "durationMs": 184,
  "requestBytes": 1024,
  "responseBytes": 4096
}
```

- 高风险事件：Grant 变更、secret use、workspace write/delete、network allow/deny、process spawn/kill、Podman create/exec/rm、权限拒绝、协议错误、资源超限、quarantine、升级/回滚/卸载。
- 普通参数和结果只记录 schema 名、摘要、长度、hash 或有限脱敏预览；不记录 API key、Authorization、完整 prompt/history、文件内容或 raw response body。
- 审计记录带 user/background principal、当前 scope、runner、版本、摘要和 correlation ID，便于区分“插件行为”和“核心内部调用”。
- 审计写入不能被插件阻塞核心关键路径；可使用有界异步队列，但权限变更、secret use、越权拒绝和 kill/quarantine 等安全事件应确保最终持久化或产生明确丢失告警。

### 14.2 管理员诊断面板

管理员至少可以查看：

- package/Manifest/schema/Host API/RPC 版本、签名 keyId、包摘要和依赖状态。
- trust level、安装 Grant、当前有效权限摘要、runner、Podman image digest、runtime PID/container ID、generation。
- activation reason、启动/握手/激活耗时、在途 RPC、队列 bytes、event overflow、最近 stderr 摘要和资源峰值。
- 最近退出码/signal、重启预算、quarantine 原因、升级 journal、回滚结果和未完成 migration。
- 审计按 cursor 分页；日志和 stderr 采用大小上限和分页读取，不允许管理页一次加载全部历史。

**[设计建议]** 诊断页可以显示“本地进程 = 弱隔离/不防恶意文件网络访问”的明确文案，不能把进程 PID 存在误显示为安全沙箱。

### 14.3 告警

- 第一次授予 workspace write、network allowlist、secret use、process helper 或 background schedule 时提示具体资源范围。
- 重复权限拒绝、路径逃逸尝试、非法 frame、超 credit、取消不响应、stderr 速率过高和容器资源超限触发告警/计数。
- 包摘要改变、签名失效、key 被撤销、运行时 hello 身份不一致时立即禁用或 quarantine，不自动使用旧 Grant 继续运行。
- 告警正文必须脱敏；完整诊断需要管理员显式下载且仍受字节上限、权限和审计控制。

## 15. 生命周期与安全状态转换

### 15.1 disable

```text
期望状态 -> disabled
→ 从 Activation Index 移除
→ 拒绝新调用
→ 取消可取消请求/等待副作用调用短暂 drain
→ 撤销动态事件订阅、UI session、secret handle
→ deactivate/shutdown
→ 超时 kill
→ 保留包、配置、storage 和缺失引用
```

- disable 不能只隐藏 UI；必须阻断后端调用和所有现存 UI bridge session。
- 已经开始的文件写入/核心 command 不能被伪装成“未执行”；结果未知时标记 operation unknown，并由核心业务提供对账。

### 15.2 upgrade/rollback

- 升级先静态校验新包、权限差异、签名、依赖和 migration；新增高风险权限必须重新确认，不能因旧版本已有 Grant 自动批准。
- 新版本只能在旧 runtime drain/stop、旧 secret handle 撤销后启动；新旧版本不能共享可写 storage。
- health activation 运行在受限测试 scope，不应直接接触用户 workspace 或真实 secret，除非健康检查明确声明所需最小 capability。
- 回滚恢复旧包摘要、旧 Grant 和旧 runtime generation；新版本产生的动态 session/handle 全部失效。
- migration 失败、不可逆或 snapshot 缺失时进入人工恢复状态，不强行自动回滚造成二次数据损坏。

### 15.3 uninstall

- uninstall 先隐式 disable，再终止 runtime、撤销 secret、删除贡献和清理 Podman 容器/本地子进程。
- 默认保留 namespaced storage 和布局缺失占位；显式 purge 才删除用户数据，且需要确认、审计和失败重试。
- 卸载完成后，旧 runtime、旧 MessagePort、旧 asset URL 和旧 secret reference 均不可继续工作。
- `current` 指针、journals、quarantine 记录和审计摘要要保留足够时间诊断；不应因删除包而抹掉安全事件。

## 16. 安全失败语义

**[设计建议]** 统一使用 fail closed：

| 情况 | 行为 |
|---|---|
| Manifest/schema 不兼容 | 不执行；标记 incompatible |
| 签名/摘要不一致 | 不执行；进入 quarantine |
| pluginId/version/hello 不一致 | 立即终止 runtime |
| Host API 无权限 | `PERMISSION_DENIED`，不尝试替代路径 |
| 路径无法 realpath/containment 不确定 | 拒绝操作，不回退到 home |
| network allowlist 无法判定 | 拒绝连接，不自动 direct |
| timeout/cancel 后结果未知 | 标记 unknown，不自动重放副作用命令 |
| RPC frame/JSON 超限 | 失败请求；持续违规终止 runtime |
| UI nonce/port/session 不匹配 | 丢弃消息并记录有限告警 |
| Podman 不可用但要求 sandbox | 不降级执行；提示管理员切换 restricted 或修复环境 |
| Grant/secret store 不可用 | 拒绝调用，不使用缓存旧授权 |

- 错误消息向用户提供诊断 ID、可操作修复建议和是否可重试；不泄露内部路径、secret、堆栈或其他用户数据。
- 插件不能通过错误内容让宿主扩大权限、关闭 sandbox、忽略签名或跳过审计。

## 17. 阶段取舍

### 17.1 推荐阶段

1. **阶段一：静态安装安全**
   - Manifest schema、包路径/zip bomb 检查、SHA-256、贡献索引、未知包不执行。
   - LocalProcessRunner 只开放低风险 RPC；固定环境、stdout framing、超时、进程树清理和 quarantine。
2. **阶段二：权限和审计**
   - Capability Broker、Query/Command/Event allowlist、配置 namespace、storage quota、secret declaration/broker、结构化审计。
   - 先实现 deny-by-default，暂不开放 workspace write、任意 network 和 helper process。
3. **阶段三：provider/tool 运行安全**
   - provider 流式背压、cancel、输出限制、工具参数校验、资源计量、重启预算和副作用未知语义。
4. **阶段四：UI sandbox**
   - host-controlled shell、`allow-scripts`、严格 CSP、MessageChannel nonce/port/session、固定 PluginDockPanel、缺失/禁用/权限占位。
5. **阶段五：Podman 强隔离**
   - rootless Podman runner、digest-pinned image、无网络/无特权、cgroup/pids/memory、只读 package、独立 data/tmp 和容器审计。
6. **阶段六：签名与供应链**
   - Ed25519、官方/组织信任根、吊销、离线 key rotation、锁定依赖、私有仓库和自动升级策略。

### 17.2 取舍说明

- **本地进程 vs Podman**：本地进程启动快、跨平台和开发体验好，但不能可靠隔离网络/文件/子进程；Podman 资源和边界更强，但依赖环境、镜像管理和平台差异。建议统一 `PluginRunner` 接口，两者都支持，但不得静默降级。
- **Host proxy vs 插件直连网络**：Host proxy 易审计和统一 secret/TLS，代价是协议适配和吞吐；首版优先 proxy/none，直连 allowlist 后置。
- **IIFE vs ESM UI**：IIFE 便于 opaque-origin CSP 和离线资源校验；ESM/dynamic chunks 更灵活，但会增加 CORS、依赖图、缓存和 CSP 风险。首版建议 IIFE。
- **单插件进程 vs 每 contribution 进程**：单插件进程降低资源和启动成本，但贡献间故障域更大；v1 一插件一进程，provider instance 是否独立进程留待性能验证。
- **强制阻断 vs best effort 监测**：安全边界必须由 runner/OS 强制；仅能监测 RSS、PID、路径或网络日志时，应标注弱隔离并限制可申请权限。
- **审计完整性 vs 主线程性能**：审计应异步、有界、脱敏；高风险安全事件必须可追溯，普通进度/日志可采样和丢弃。

## 18. 待决策项

- **[待决策]** restricted 本地进程是否允许任何 workspace read；建议默认 none，只允许宿主 Query/Command。
- **[待决策]** trusted 插件是否可申请直连网络；建议仍优先 host proxy，直连需显式 allowlist。
- **[待决策]** Podman 最低版本、rootless 网络后端、Windows/macOS/WSL 支持矩阵及无 Podman 时的产品交互。
- **[待决策]** secret 的最终存储后端：文件加密、OS keychain、容器 secret mount 或组合方案。
- **[待决策]** 是否允许插件使用远程设备能力；建议先只支持本地 workspace 公共 API，后续再定义 `device` principal 和 executor 边界。
- **[待决策]** UI asset 是否公开读取、UI-only 插件的最小只读 Query 集合、device storage 的多设备语义。
- **[待决策]** 审计保留期、脱敏规则、管理员导出权限、签名吊销传播和事件丢失告警。
- **[待决策]** resource quota 的最终默认值，以及不同 trust level 是否允许管理员提高上限；建议任何管理员提高都触发审计和风险提示。

## 19. 验收清单

- **[设计建议]** 恶意后端插件无法从环境变量、cwd、文件路径、日志或 RPC 获得 JWT、settings、SQLite、provider secret 或其他插件 data。
- **[设计建议]** 本地插件崩溃、死循环、超时、无限输出、孤儿子进程和拒绝 cancel 不会使核心 HTTP/WS/SQLite 停止响应。
- **[设计建议]** 需要强隔离的插件在 Podman 不可用时不会静默降级为本地执行。
- **[设计建议]** Podman 容器无 host network/PID/IPC、无 privileged、无 socket mount、无任意 host port，package 只读且资源有限。
- **[设计建议]** workspace/file/network/process 权限均按 Manifest、Grant、用户和具体 scope 检查；路径穿越、symlink/junction 和 DNS/IP 旁路测试通过。
- **[设计建议]** UI iframe 无法读取 parent DOM、宿主 localStorage、Cookie、JWT、内部 API 或注册 React/route；只能经 nonce 绑定的 MessagePort 调用声明能力。
- **[设计建议]** CSP 禁止远程脚本、任意 connect、frame、object、form 和 top navigation；UI 超大 payload、overflow、reload、disable、logout 都能清理 session。
- **[设计建议]** secret 不出现在命令行、普通 env、UI bootstrap、日志、审计正文、请求 dump 或插件导出数据中。
- **[设计建议]** 安装、启用、激活、Grant 变更、secret use、网络/文件/进程调用、资源违规、quarantine、升级、回滚和卸载都可由审计按 operation ID 追踪。
