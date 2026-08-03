# 11. 能力策略：安装即信任

本文档记录一次方向性变更：NarraFork 插件系统从「默认不信任插件、逐项授权」转为
**「安装即信任」**，对照 VS Code 的扩展模型。

它同时是一份**取舍记录**：哪些限制被撤销、为什么、代价是什么；哪些限制被保留、为什么不能一起
撤销。后者尤其重要——将来有人想继续放开时，应该先在这里看到代价。

## 1. 为什么改

### VS Code 实证

`../vscode` 源码核实结论：

| 检查项 | 结果 |
|---|---|
| `src/vs/workbench/services/extensions/common/` 下的权限子系统 | **不存在** |
| `package.json` 的 `permissions` 字段 | **不存在** |
| `rpcProtocol.ts` 的权限校验 | **零处** |
| `extHostSecrets.ts` 的 `checkProposedApiEnabled` 门禁 | **零处**，get/store/delete/keys 全开 |
| secret 隔离机制 | `mainThreadSecretState.ts:91`，`JSON.stringify({ extensionId, key })`，extensionId 由宿主注入 |
| 能力裁剪时机 | 每个扩展在 `extHost.api.impl.ts:267` 拿到为其单独构造的 API 对象 |

VS Code 是使用最广的扩展宿主，它的结论是：**装上扩展即拥有宿主进程全部能力**，隔离靠 API
构造期的身份注入，而不是运行期的逐项校验。

### 我们原本的设计问题

原设计有 66 项闭合 capability 枚举（`capabilitySchema = z.enum(CAPABILITIES)`），枚举外的字符串
被 manifest 校验直接拒绝。最直接的证据表明这套分类法未经实践检验：

- `HIGH_RISK_CAPABILITIES` 与 `DEFAULT_DENIED_CAPABILITIES` 两个清单，**除定义处外没有任何运行时
  消费方**。我们在设计一套自己都还没用上的管控。
- `permissions.network` / `filesystem` / `process` 三块声明，**同样零消费方**。插件进程的网络访问
  来自操作系统、文件访问来自 runner，都不读这些字段。校验它们的内容只拒绝了 manifest，从未约束
  过任何运行中的插件。
- 每加一个新集成点都要改宿主枚举——这是「未来无尽不便」的确切来源。

## 2. 关键区分：信任限制 vs 存活限制

这是本次变更最重要的判断。原限制混了两类东西：

**A 类 · 信任限制** —— 源于「不信任插件」假设。**全部撤销。**

**B 类 · 存活限制** —— 源于 CLAUDE.md 的后端性能铁律：Bun HTTP/WS、`bun:sqlite`、JSON 序列化
共用同一个 JS 主线程，任何长时间同步工作都会表现为「所有请求无响应」。**全部保留。**

B 类不是不信任插件，是**保护宿主不被一个写错的插件搞死**。一个 bug（不是恶意）导致的无限输出
就足以让整个 NarraFork 无响应。放开这些会把「插件有 bug」升级为「服务器挂掉」。

## 3. 已撤销的限制

### 3.1 capability 白名单 → 声明开放（授予仍需 canonical adapter）

`server/lib/plugins/permissions.ts`

- `capabilitySchema` 从 `z.enum(CAPABILITIES)` 改为格式化字符串。`*`、`admin`、`network.any`、
  `process.shell`、`com.acme.custom.thing` 全部**可声明**。

> **「可声明」不等于「可用」。** 放开的只是 manifest 解析。一条能力要变成 grant，必须能映射到
> `server/lib/integrations/capability-adapters.ts` 的 `PLUGIN_CAPABILITY_ADAPTER`（约 55 项），
> 因为授权内核以 canonical capability id 为键。声明超出这张表的 token 时：
> `seedGrantsFromManifest()` 会**跳过它并记一条 `logger.warn`**，安装照常成功；运行时
> `CapabilityBroker.authorize()` 同样找不到 adapter，返回 `CAPABILITY_NOT_GRANTED`（fail-closed）。
> 所以声明 `admin` 的插件能装上，但 `admin` 不产生任何 grant、也调不动任何东西——它是一条给
> admin UI 看的描述，不是一把钥匙。
>
> 过滤放在 seed 阶段有具体原因：不过滤时 `PluginIntegrationAuthorityService.toAuthorityGrants()`
> 会对无 adapter 的 capability 抛 `IntegrationAuthorityConflictError`，导致**安装本身**以 409
> 失败（错误文案还是内部术语）。也就是说解析层放开、安装层硬失败，两半不一致。
- `CAPABILITY_TAXONOMY` / `CAPABILITIES` 降级为**文档常量**（宿主已知名称，供编辑器补全与
  admin UI 使用），不再是准入门槛。新增 `KNOWN_CAPABILITIES` 别名以明确这一语义。
- `isWidePermission` 保留但**不再是拒绝路径**，仅供 admin UI 标注「这是一个宽泛请求」。
- `DEFAULT_DENIED_CAPABILITIES` 改为空数组。

**保留的格式校验不是信任门槛**：`^(?:\*|[a-zA-Z][a-zA-Z0-9_]*(\.(?:\*|[a-zA-Z][a-zA-Z0-9_]*))*)$`，
拒绝空值、空格、控制字符，保证名称在审计记录里可读可比较。允许 camelCase，因为宿主自己的分类法
就在用（`diagnostics.readOwnLogs`、`ui.openExternal`）。

**一处实现顺序上的坑**：`normalizeCapabilityName` 现在**先查 legacy 别名表、后做格式校验**。
原顺序（先 canonical 后别名）在闭合枚举下是等价的——别名不可能同时是 canonical。改成开放字符串
后，任何格式合法的别名都会直接通过 canonical 分支，导致别名**静默停止改写**，
`query.chapters.read` 与 `query.read.chapters` 会作为两个不同 capability 并存。

### 3.2 默认拒绝 → 安装时授予

**只放开授权维，不动状态维。** 这个区分决定了 `disable` / `revoke` 是否还能工作。

**放开的（授权维）** —— 五源交集不再作为门禁：
`hostPolicy` / `currentUserAuthority` / `contributionPolicy` / `runnerEnforcement` 在生产中
（`plugin-host-services.ts:448-451`）全部由**同一份 grant 列表**填充，所以交集校验只是把 grant
检查重述了四遍，同时提供了四种误拒的途径。现在 `effectiveCapabilities` 只作**上报**（admin UI 与
`plugin.getEffectivePermissions` 读它），不再门禁当次调用。`capabilityDenialReason()` 保留六种
原因码作为**诊断**，供 admin UI 解释「为什么某能力不在生效集合里」。

**默认放行落在哪里**：`seedGrantsFromManifest()`（`plugin-manager.ts`），在**安装/首次绑定**时
把 manifest 声明的能力写成 grant——**但只写有 canonical adapter 的那些**（见 §3.1 的注记）。无
adapter 的声明被跳过并记 warn，不产生 grant，也不阻断安装。

**为什么不能落在 `authorize()` 里做兜底** —— 这是本次实现中最容易搞错的一处，且已被测试证实：
broker 把 grant 列表当作**活状态**读取。`revoke()` 标记 grantId，
`plugin-lifecycle-revoke-coordinator` 通过**移除能力后重新绑定**来表达撤销。所以「grant 不存在」
是一个**状态信号**（"这个被拿走了"），不是信任信号（"我们不信任你做这个"）。在 `authorize()` 里
兜底放行会让 `disable` 与 `revoke` **静默失效**。

实现过程中确实先写错了一次：在 `authorize()` 加兜底后，
`plugin-registry-revoke.e2e.test.ts` 的 "grant revision invalidates old bindings" 立刻变红
（`expected false, received true`）。这不是测试噪声，是真实功能破坏。

**必须保留的状态维拒绝**（`plugin-capability-broker.ts`，逐行核实）：

| 位置 | 拒绝原因 | 为什么不能放开 |
|---|---|---|
| `:797` | `INVALID_PARAMS` | 请求本身格式错误，放行会把坏数据带进下游 |
| `:805` | `CONTEXT_UNAVAILABLE` | 找不到绑定，无法确定是哪个插件在调用 |
| `:810` | 身份不匹配 | runtime/generation 与绑定不一致，属陈旧调用 |
| `:815` | `validateLifecycle` | **插件已 disable** |
| `:820` | `TIMEOUT` | deadline 已过 |
| `:828` | `GRANT_REVOKED` | **插件级 grant 已撤销** |
| `:835` | `MISSING_SOURCE` | runtime 未就绪（**区别于**「某源不含该能力」：源完全无法解析意味着说不清是谁在请求什么） |
| `:885` | `CAPABILITY_NOT_GRANTED` / `GRANT_REVOKED` | grant 列表即撤销机制，见上文 |
| `:840` | `SCOPE_ESCALATION` | 越权访问其他用户/项目的资源，与信任插件无关 |

> 计划阶段列了七处，实现时核实为九处：`:885` 的 grant 检查与 `:840` 的 scope 校验同样属状态维。

### 3.3 secret 只写不读 → 可读（iframe 读明文限管理员）

新增 `secrets.get` / `secrets.set` / `secrets.delete`（`secrets.list` 原已存在）到**两个方法集**：
`PLUGIN_TO_HOST_REQUEST_METHODS`（后端）与 `PLUGIN_UI_BACKEND_METHODS`（iframe）。两清单同步添加
同样四项，**contract parity 断言保持严格相等、未作任何削弱**（第三份冻结清单
`plugin-contract-parity.test.ts` 的 `expectedSharedMethods` 同步更新）。

**iframe 同样开放**。理由：一个恶意 UI 插件本来就能通过自己的后端 command 拿到同样的值，原限制
阻止的只是「设置页显示用户已配置过什么」这一正当功能。

**但 iframe 的 `secrets.get` 是 admin-only**（`plugin-ui-host.ts` 的 `secretsGet`）。这不是对插件
的不信任，是**调用者维度**的限制：UI session 由 `routes/plugin-ui.ts` 的 `requireSessionAuth`
创建，普通登录用户即可拿到；而 `secret.use_self` 只说明「这个插件可以碰自己的 vault」，说明不了
「哪个用户可以把明文读回来」。宿主自有的凭据路径是 admin-only 且永不回显明文
（`plugin-provider-config-service.ts` 用 `SECRET_PLACEHOLDER` 占位），只按 capability 判定会让
同一批凭据从插件 iframe 走就被普通用户读到，等于绕开 user/admin 边界。

因此只有回显明文的这一个方法加了角色门禁：`secrets.list`（键名 + 已配置标记）与
`secrets.set` / `secrets.delete`（不回显值）对普通用户保持原有访问，非 admin 的设置页仍能看到
配置状态并替换凭据。**后端方法集不受影响**——插件后端的调用主体是插件自己，不是某个登录用户。

**唯一保留的隔离是结构性的**：所有 secret 方法的 `pluginId` 都由宿主从已验证的 principal
（后端）或 session（iframe）取得，**插件 API 里没有 pluginId 参数**，跨插件访问在结构上不可
表达。学 VS Code 的 `JSON.stringify({ extensionId, key })`。

`secrets.list` 仍然只返回键名与已配置状态、不含值——不是限制，而是让「只想知道要不要提示配置」的
插件不必读取凭据。

### 3.4 secretWrites 的限制

`server/services/plugin-command-secret-writes.ts`

**保留**：
- 跨插件 / 跨 contribution 隔离（从 registry 派生，不信任请求），两类越界错误信息完全相同
- 单值 ≤ 64 KB（**B 类**，见下节）

**撤销**：`configSchema` 字段白名单、条目数 ≤ 50、单批总量 ≤ 256 KB、重复 key 拒绝、批量原子性。

字段白名单值得单独说明：它要求每个 key 必须在静态 manifest 的 `configSchema` 里声明为 secret。
但**最需要凭据存储的插件恰恰无法满足**——轮换 token、每个登录账号一条凭据，这些 key 无法预先
枚举。

**代价必须明确记录：批量写入不再原子。** 写入按顺序应用，中途 I/O 失败会留下已写入的前序条目。
原先的「先校验全部再写入」只防住了**策略**失败（现已不存在），从未防住 vault 写入本身失败到
一半。这一行为由
`tests/server/services/plugin-command-secret-writes.test.ts` 中
"a batch is applied incrementally" 显式断言，而不是用测试假装原子性还在。

### 3.5 网络/文件系统/进程声明 → 可选、形状不校验（保留体积上限）

`permissions` 整块及其 `network` / `filesystem` / `process` 三块均改为可选、**内容形状**不校验
（`z.looseObject({})`）。跨字段一致性规则（如 `mode: "none"` 不得同时有 `allow`）一并删除——在
一个没人读的字段上强制整洁毫无意义。

**保留的是体积上限，不是形状校验**：每块序列化后 ≤ 8K 字符
（`MAX_UNINSPECTED_PERMISSION_JSON_CHARS`，`manifest.ts`）。理由属 B 类：解析后的 manifest 常驻
内存并被拷进插件状态文件，而状态持久化是主线程上的同步 JSON 读改写；完全不校验时，manifest 可
借这三个字段把接近整个 `MAX_MANIFEST_BYTES` 的任意 JSON 夹带进每次状态写入，而这个字段没有任何
读者。限制放在序列化长度而不是键数——单个键就能装下一兆字符串，键数约束不了成本。

真正的网络与进程隔离，需要时应由 Podman runner 提供。

### 3.6 tier 分级门槛 → 统一管理员

`server/routes/plugins.ts`

原三级方案（`theme-only` / `frontend` / `backend`）允许任何登录用户安装并启用无 server entry、
无 view 的插件。撤销理由：**分级线画错了位置**——`frontend` 插件在用户自己的会话里执行任意
JavaScript，把它算作比 backend 低风险站不住脚；而且插件仅仅通过「增加一个 view」就会改变风险
等级。

改为：install 与全部 lifecycle 操作统一要求管理员。

**顺带修掉一个真实缺陷**：原流程因为「tier 只能在解析 manifest 后才知道」，必须**先安装、再回滚**
并返回 403，意味着一个未授权请求仍然会落盘。扁平管理员规则可从请求本身判定，未授权请求不再暂存
任何包。

`pluginTier()` / `isThemeOnlyPlugin()` **保留但降级为描述性分类器**，供 admin UI 列表与筛选。

### 3.7 T0–T3 信任等级 → 完全移除

`server/lib/plugins/permissions.ts`（`TRUST_TIERS` / `TrustTier` / `trustTierSchema` /
`TRUST_TIER_DESCRIPTIONS`）及其全部消费方。

这是 §3.6 的同批产物，当时被漏掉——同样是一根有序风险轴，同样按错误的维度分级，只是它藏在
state store 而不是路由层。

**为什么撤销**：一根有序轴同时编码了三件互不相关的事：

| 轴想表达的 | 实际由谁决定 |
|---|---|
| 来源可信度（谁签的） | `plugin-signature.ts` 的 `valid` / `trusted`，算完即丢，不回写任何地方 |
| 隔离强度（进程还是容器） | manifest 的 `engine.runner`，插件作者自己声明 |
| 授权宽度（能调什么） | grant ∩ canonical adapter |

这三者不共线：官方签名的插件可能因为要 shell out 而更需要强隔离；本地未签名的开发插件可能只
贡献一个主题。排成 `T0<T1<T2<T3` 后，任何一档的语义都是三件事的混合体。

**四级中两级不可达**：`T0`（core-compiled）——核心代码不会作为插件被安装，插件管理器永远看不到
这类包；`T1`（official-or-organization-trusted）——依赖签名验证，而
`pluginTrustPolicyFromEnvironment()` 返回的对象里没有 `keyring` 字段，生产环境永远是
`undefined`。剩下 `T2`/`T3` 是个布尔值而非等级，且只是复述 §4.5 的 admin-only 安装决定。

**顺带修掉一个真实缺陷**：`CapabilityBroker.validateLifecycle()` 里有一处**无条件**的 `T3` 拒绝
（423），与 `assertPackageTrust()` 的 `trustPolicy.enabled` 前置条件不同。叠加「安装即写入 `T3`、
没有任何代码路径能提升」后，默认部署下插件能装、能启用、进程能起，但它发起的每个 Host API 调用
都被拒。`plugin-c3-lifecycle.e2e.test.ts` 与 `plugin-manager.test.ts` 需要手写
`stateStore.updateState(pluginId, { trustTier: "T2" })` 才能跑通，正是这个状态的旁证。

**为什么不换成「签名状态 + 隔离方式」两根轴**：规划时考虑过，被否决。仓库里没有任何
`signature.json`、没有签名工具链、没有发布者生态，NarraFork 面向小团队私有化部署。为一个不存在的
生态建管控设施，正是 §1 批评 66 项枚举的同一个错误（"我们在设计一套自己都还没用上的管控"）。
隔离方式本来已经在 `engine.runner` 里工作，不需要新字段。结论是删掉，不替换。

**一处迁移风险**：`plugin-state-store.ts` 的 `parseStateRecord()` 原本对非 `T0`–`T3` 的
`trustTier` **抛 `ValidationError`**，而该解析器的失败路径是把 state.json 移到一边、从空文档重
建。所有升级前写入的 state.json 都带着 `trustTier`，因此该校验必须**删除而非保留**，否则升级会
静默丢掉每个已安装插件的 grant 与 provider config。现在遗留键被直接忽略，下次写入时自然消失
（记录是逐字段重建的，不是 spread 原始输入）。

**保留**：`assertPackageTrust()` 的签名与 SBOM 校验不受影响——它们读包自身的字节，与宿主指派的
等级无关。移除的只是 tier 参数和 `phase` 参数。

### 3.8 `search.provide`：声明性 capability，不设运行时 gate

`contributes.searchProviders`（见 `03-manifest-and-packaging.md` §3.5.7）引入 `search.provide`。它进
`CAPABILITY_TAXONOMY`，并在 `PLUGIN_CAPABILITY_ADAPTER` 里映射到 canonical `provider.search`，所以能正常
seed 成 grant、能在 admin UI 显示。

但 `PluginSearchRegistry.execute()` **不调用 `capabilityBroker.authorize()`**。这与既有 provider 执行路径
一致：`plugin-provider-client.ts` 与 `plugin-provider-adapter-factory.ts` 同样不授权 —— 一个已注册、已启用、
用户已配置凭据的 provider 被调用，是用户配置的结果，不再经过一次能力检查。搜索沿用同一立场，实现时不要单方面
加 gate，也不要以为已有 gate。

**为什么它有自己的 canonical descriptor 而不复用 `provider.use`**：`PLUGIN_CAPABILITY_ADAPTER` 必须保持
一对一可逆（有测试断言），两个协议字符串映射到同一个 descriptor 会直接让该测试失败。风险等级定为 `medium`
（低于 `provider.use` 的 `high`），因为一次搜索调用携带的是查询词，而非完整对话历史。

## 4. 保留的限制（不要在未读本节前撤销）

### 4.1 B 类 · 单线程存活限制

CLAUDE.md 明令：主线程不得阻塞。以下全部保留：

| 限制 | 位置 | 放开的后果 |
|---|---|---|
| `maxStdoutBytes` / `maxBodyBytes` / `maxFrameBytes` | runner / dispatcher | 无上限 stdout 会把巨大字符串收进主线程内存 |
| `spawnTimeoutMs` / `rpcMs` / `idleTimeoutMs` | runner / dispatcher | 挂起的子进程永久占用 in-flight 槽位 |
| `maxInFlight` | dispatcher | 并发无上限 |
| 命令 `maxInputBytes` / `maxOutputBytes` | dispatcher | 同上 |
| `MAX_JSON_DEPTH` / `MAX_JSON_NODES` | `protocol.ts` | JSON 解析炸栈 |
| **单个 secret 值 ≤ 64 KB** | vault / secretWrites / 两个 host | vault 是主线程上的同步 JSON 读改写，无上限值阻塞所有请求 |
| **`permissions.network|filesystem|process` 每块 ≤ 8K 字符** | `manifest.ts` | 无人读的字段可夹带任意 JSON 进每次同步状态写入（见 §3.5） |

### 4.2 结构性隔离

- **secret 命名空间**：pluginId 由宿主注入，插件 API 无此参数。跨插件访问不可表达。
- **secretWrites 的 contribution 归属**：从 registry 派生。
- **canonical adapter 门禁**：能力声明开放，但 grant 与运行时授权都必须能映射到
  `PLUGIN_CAPABILITY_ADAPTER`（约 55 项，`server/lib/integrations/capability-adapters.ts`）。
  这是**真正的能力边界**：`seedGrantsFromManifest()` 跳过无 adapter 的声明（记 warn，不阻断安装），
  `CapabilityBroker.kernelAuthorizationError()` 对无 adapter 的 capability 返回
  `CAPABILITY_NOT_GRANTED`。**放开声明维不等于放开这道门**——要新增一项能力仍需在 adapter 表里
  显式登记，这也是它没有随 §3.1 一起撤销的原因。
- **broker 的单能力约束**：进入授权内核时 `permittedCapabilities: [canonicalCapability]`
  （`plugin-capability-broker.ts`），即一次调用只能凭一条 canonical 能力放行。所以
  `admin` / `*` 这类宽泛 token 即便被写成 grant 也不会横向扩权：内核不接受「一条 grant 覆盖多项
  能力」的表达。

### 4.3 状态维拒绝

见 §3.2 的九行表格。`disable` 与 `revoke` 依赖它们。

### 4.4 iframe 读明文需管理员

`secrets.get` 在 UI host 上要求 `userRole === "admin"`，见 §3.3。这是调用者维度而非插件维度的
限制，不要因为「插件系统已改为安装即信任」就把它一并撤掉：UI session 的创建门槛是普通登录用户，
而宿主自有凭据路径从不向非 admin 回显明文。

### 4.5 管理员安装门槛

装插件 = 给服务器加任意代码，这与「已安装插件能做什么」是两个决策。VS Code 同样是「用户自己决定
装什么」。

## 5. 不可逆性

**放开容易、收回难。** 一旦第三方插件依赖了宽松行为，日后加限制就是破坏性变更。本次选择是
「先放开、再按实际情况管控」，基础设施（capability broker、审计通道）全部保留，未来要管控时
不必重建——但**收回的成本由生态承担**，这一点应在引入第三方插件生态前想清楚。

## 6. 相关文档

- `07-security-and-sandbox.md` §13 —— 已同步标注撤销条款，避免文档说禁止、实现允许
- `04-server-rpc-and-provider.md` D-04b —— `commands.invoke` 与 `secretWrites` 规格
- `06-events-query-and-permissions.md` —— capability 与事件订阅
- `10-open-questions-and-decisions.md` —— 决策记录
