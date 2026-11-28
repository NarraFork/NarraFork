# API Key Quota Probe（`com.narrafork.apikey-quota`）

把「APIKey 额度查询」从主项目里解耦出来的独立插件：在**独立进程**中向中转站查询某个 API Key
的剩余额度，返回与 NarraFork 现有 DTO 完全一致的归一化结果。

宿主（NarraFork 核心）保留配置来源、凭据、调度/节流/缓存/持久化、HTTP 路由、DTO 和前端展示；
插件只负责「怎么问、怎么解析」。

**2026-11-25 实现说明**：宿主统一 quota-snapshots 与来源 owner 生命周期已接通；
合并和发布结果以对应 PR / CI 为准。下面的插件输入 / 输出、`commands.invoke` 协议、授权、
启停与失败回退契约不变。

## 边界

| 关注点 | 归属 |
|---|---|
| provider 非机密配置 | 宿主（`settings.customApiProviders`；S2 不新增 `sourceGroups[]`） |
| API Key / 组秘密存储 | 宿主统一文件 `credentials.json`；`ProviderKeyStore` 与 settings Key 字段只是兼容视图，不把秘密写回 settings |
| 队列、并发上限、手动节流、stale 刷新、generation | 原源模块 owner（[provider-balance-cache.ts](../../lib/provider-balance-cache.ts) 等），不搬进插件或统一 API |
| 额度快照持久化 | 宿主 [QuotaStore](../../lib/sourcing/quota-store.ts)，以凭据身份指纹存取 |
| `GET /api/quota-snapshots`、`POST /api/quota-snapshots/refresh` | 宿主统一读取 / 刷新；显式管理员 `POST /api/provider-balances/:id/probe` 诊断仍保留 |
| 前端徽章 / 设置页展示 | 宿主 |
| **端点探测路径、HTTP 请求、响应归一化（sub2api / new-api）** | **本插件** |

插件不读写宿主的 storage / secret / config，也不注册 UI。它是一次调用的纯函数进程。

## 宿主统一读取与刷新

- [统一路由](../../routes/quota-snapshots.ts)：`GET /api/quota-snapshots` 返回按来源组 / 凭据区分的
  `entries`；`POST /api/quota-snapshots/refresh` 可带 `{ groupId?, credentialId? }`，仍经原鉴权与节流。
  管理员的 `POST /api/provider-balances/:id/probe` 用于显式重新诊断端点，不因统一展示而删除。
- [模板](../../lib/sourcing/templates.ts) 的 `probeQuota(group, credentialId)` 委托原 owner，沿用它的队列、
  TTL、并发去重、退避及晚到结果身份核对；Codex 只投影已有 usage，不新起一套探测。
- 每个 Key 的额度只关联自己的身份。直接 probe 与 STREAM 的 `quota_balance` 是独立来源，
  不能互相覆盖；未知 / 失败 / 不支持不是零，`expiresAt` 不是窗口 `resetsAt`，uncapped 不伪造 0 限额。
  [公开投影](../../lib/sourcing/quota-snapshots.ts) 不输出 `detail`、原始错误或私密身份。
- [API 包装](../../../frontend/lib/api/quota-snapshots.ts) 只转发请求；共享缓存、取消、失效、重取与 GC
  由 [React Query hook](../../../frontend/hooks/useQuotaSnapshots.ts) 管，不在 API 层再维护 pending 表。
  隐藏 / 取消视图不能改写源 owner 的调度或越权取消共享后台探测。
- [NUG 轻量头部](../../../frontend/components/narrator/model/use-nug-quota.ts) 也使用同一个 API 的标准
  scoped Query：`groupId`、`cachedOnly: true`、`expectedGeneration`；按会话与模型运行时代次隔离，
  保留 **64 KiB / 15s** 读取预算、generation 不匹配拒绝复用、隐藏时停发与不在后台轮询。
  该预算不替换本插件下文的单次出站 **64 KiB / 8s** 约束。
- [CC 模型 owner](../../lib/commandcode-models.ts) 在冷启动 prime 真实目录，订阅 settings / KeyStore
  提交，并原生监听 CLI 认证目录，覆盖后续登录、原子切号与退出；关闭时统一退订，不依赖管理页读取。
  Auto 热路径在 auth / 模型 TTL 之后仍纯读内存，显式刷新和真正请求的 CLI auth 读取保留，不伪造静态目录。
- [NUG relay owner](../../lib/nug-relay/manager.ts) 在启动及 settings / KeyStore 提交后用微任务合并
  reconcile，采用有效启用 Key 与最终 endpoint；关停退订、阻止排队 reconcile 再执行并关闭连接。
  只有 `egressAllowDirectFallback === true` 才允许直连，Auto 只读已有 channel registry。
- [NUG 请求 context](../../lib/nug-payment-context.ts) 以不透明引用绑定实际失败 Key，配置 / 下单核验叙述者
  写权限与 live 身份，不公开 CID / 私有请求身份 / secret；重排仍为原 Key，显式 standalone 才选首个启用项。
  创建后的 [订单 binding](../../routes/nug.ts) 固定用户、订单、CID 与连接身份；付款额度按捕获 CID
  回写 per-Key 快照，不污染重排后的首 Key 摘要。[付款界面](../../../frontend/components/narrator/model/NugRechargeDialog.tsx)
  对瞬时失败有界退避 / 重试，身份或权限失效则停止；该路径不替代普通额度 Query。NUG 全局 `fetchedAt` 仍记最后尝试，carry 数字保留宿主真实观察时间，私有
  `detail._remainingObservedAt` / `_totalObservedAt` 经公开白名单成为 balance 的
  `remainingObservedAt` / `totalObservedAt`。其三态为 number（真实 epoch-ms）、null（从未观察）、
  undefined（按旧 snapshot 合同回退 `fetchedAt`）；非法观察时间省略、不转 null，不信任上游时间。
  legacy / Unified 对同 CID、同单位单 wallet 按字段比较，同毫秒 probe 优先：partial `total=111`
  不遮较新 STREAM `remaining=0`，旧 STREAM total 不盖新 total。metadata-only 不等于显式
  unknown / error / expiry；legacy 可比视图明细缺席才只读回退另一槽，非空 latest 优先、
  `extra: null` 合同不变，Unified 保留 probe 元数据，两个原槽不互写。

## 命令契约

宿主通过共享命令注册表转发 `commands.invoke`（`contributionId: "query-balance"`），
由 `onCommand:query-balance` 按需激活。插件只贡献 `handler: "server"` 的命令，
不贡献 Agent 工具，也不会把额度查询参数放进模型的工具声明。

宿主适配器仍使用 `plugin_background` / `source: "internal"` 身份检查 `provider.use` 授权，
通过后才把本次调用的凭据交给命令；显式撤销授权和停用插件仍然生效。

### 输入

```jsonc
{
  "mode": "probe",              // 或 "refresh"
  "baseUrl": "https://relay.example.com/v1",
  "apiKey": "sk-...",           // 仅本次调用使用，不落盘、不写日志
  "headers": { "X-Tenant": "a" }, // 可选，provider 的 extraHeaders（插件仍会剔除 hop-by-hop）
  "userAgent": "NarraFork/0.9.9",
  "proxy": "http://127.0.0.1:7890",  // 可选
  "tlsRejectUnauthorized": true,      // 可选
  "adapter": "sub2api",         // refresh 时必填
  "root": "https://relay.example.com" // refresh 时必填
}
```

### 输出（`output` 为 JSON 对象）

```jsonc
{ "status": "ok", "adapter": "sub2api", "root": "https://relay.example.com",
  "balance": { "scope": "wallet", "unlimited": false,
               "amounts": [{ "unit": "USD", "remaining": 12.5 }] } }

{ "status": "unsupported" }                          // 该中转站没有额度端点
{ "status": "failed", "kind": "transient" }          // 请求失败（可重试）
{ "status": "failed", "kind": "unsupported" }        // 端点存在但响应无法识别
```

`status` 放在**成功响应**里是有意为之：协议层结论（无端点/请求失败）与「插件没运行」必须能区分开，
后者才是 JSON-RPC 错误。宿主据此决定是采用插件结论、报错，还是回退内置实现。

宿主会用 `shared/apikey-quota-plugin.ts` 严格校验该 JSON；不合法即视为插件无应答。

## 分发与启停

本插件**随应用一起发布**（`server/builtin-plugins/apikey-quota`），由
`server/builtin-plugins/registry.ts` 声明并交给 `PluginCatalog` 读取。它仍是**一个正常插件**：
同一份 `manifest.json`、同一套 manifest 校验、同一个 `PluginRuntime` 生命周期与健康登记、
同一套启用/停用语义。区别只在分发方式。

启用状态存在插件状态表里，与外部插件同一张表、同一套接口：

- UI：设置 → 插件列表中的同一行开关（与外部插件同一套标准）；
- API：`POST /api/plugins/com.narrafork.apikey-quota/{enable,disable}`（需 admin）。

首次启动时状态记录**隐式创建**为 `desiredState: "enabled"`（没有安装动作，所以也不存在
「用户选择启用」这一刻）。管理员的显式停用会被尊重并持久化。

关闭后的行为：该能力归插件所有，因此停用插件即关闭额度查询。宿主公开快照只保留安全码
`error: "plugin_not_enabled"`；[统一额度组件](../../../frontend/components/narrator/model/quota-snapshot-view.ts)
将它本地化为「插件已停用」，不显示旧接口或上游的原始 error 文本。统一 quota-snapshots
不会因此改用过程内的内置适配器回答同一问题。插件重新启用后，按源 owner 原有 TTL / 调度或
显式刷新恢复，不另造一套插件轮询器。

### 与外部插件的标准差异（逐条及理由）

| 标准项 | 内置插件 | 理由 |
|---|---|---|
| 安装步骤 / 包记录（`current.json` 指针） | 无 | 包在应用自己的构建产物里，与应用同版本、同生命周期。伪造一条「已安装」记录会与真实分发状态不符，也会让卸载语义指向不可删除的应用内容。 |
| capability grant 初始建立 | 首次初始化时按 manifest 建立，与外部插件安装使用同一授权机制 | 没有安装动作，因此在首次初始化时建立 `provider.use` 授权；调用仍经过 broker 和 authority 校验。后续显式撤销不会在重启或重新启用时恢复，也不因新版本声明更多能力而自动扩权。 |
| 包签名校验 | 无 | 包与应用同一信任根（同一份构建产物、同一份发布签名）。签名解决的是「第三方包来源不可信」，内置包不存在这个边界。 |
| SBOM / 许可页单独登记 | 随应用 | 已并入应用的 SBOM 与许可清单，单独登记会产生重复条目。 |
| 包目录布局 | 自身即 manifest 根（`<root>/manifest.json`），无 `<id>/<version>/<hash>` 层级 | 分发形态决定的物理布局差异；读取路径仍复用同一套包读取与校验函数，非另一套解析。 |
| 单文件可执行文件中的来源 | 包内容在构建期被嵌入（`server/generated/embedded-builtin-plugins.ts`），启动时物化到 `~/.narrafork/builtin-plugins/<name>/<version>/`，再交给同一个包读取器 | 编译产物没有 `server/builtin-plugins/` 目录，`import.meta.dir` 指向 `$bunfs`。物化而不是新增一条内存读取路径，是为了让两种分发共用同一份校验；写入应用自己的 home 而非临时目录，避免被同机其他用户预置。 |

其余全部一致，且由测试守护：

- **manifest 校验**：`PluginCatalog` 用与已安装包相同的读取器（大小上限、JSON 解析、
  `safeParseManifest`、entry 存在性、兼容性、symlink 与路径逃逸检查）。
- **运行时生命周期**：进程由 `PluginRuntimeSupervisor` 启动、回收与重启，本插件不自行
  `new PluginRuntime`。
- **调用通道**：宿主以后台身份完成能力校验后经 `pluginCommandRegistry.invoke` 调用，
  使用既有 `commands.invoke` RPC，不进入 Agent 工具目录。
- **健康检查**：调用结果进入 `pluginHealthRegistry`，与外部插件同一份指标
  （`requests` / `successes` / `failures` / `lastSuccessAt` / `lastFailureAt`）。
- **启用/停用语义**：与外部插件同一张状态表、同一组接口。

## 校验

```bash
bun scripts/validate-plugin-release.ts "$(pwd)/server/builtin-plugins" --runtime
```

该命令会把包按 `local-process` runner 真正启动一次，校验 hello / initialize / activate / health。

## 回退语义

| 情形 | 结果 |
|---|---|
| 插件 `status: "ok"` | 直接采用（宿主内置路径不执行） |
| 插件 `status: "unsupported"` | 视为权威结论，不探测内置路径 |
| 插件 `status: "failed"` | 按既有的 `request_failed` 语义记录 |
| 插件被停用（`PLUGIN_NOT_ENABLED` / `PLUGIN_DISABLED`） | 不回落：公开快照仅留安全码 `plugin_not_enabled`，统一组件本地化提示；重新启用后按原 owner 调度或显式刷新恢复 |
| 包缺失 / 进程启动失败 / 进程崩溃 / 输出非法 | 回退内置适配器（不向用户报错） |

> 该能力归插件所有：停用插件等于关闭额度查询，因此不会静默改用过程内的内置适配器。
> 只有「插件已启用但自身故障」才回退内置适配器，避免插件故障拖垮整个功能。

## 宿主侧位置

- 决策表与 DTO 映射：`server/services/apikey-quota-plugin-engine.ts`（模块级单例
  `builtinApikeyQuotaEngine`，`app.ts` 安装并注入激活钩子）。进程本身由插件运行时监督器托管，
  引擎不再自持 runtime。
- 内置包声明：`server/builtin-plugins/registry.ts` → `PluginCatalog({ builtinRoots })`。
- 引擎接缝：`server/lib/provider-balance-engine.ts`。
- 线上契约（宿主校验）：`shared/apikey-quota-plugin.ts`。
- 契约测试：`tests/server/plugins/apikey-quota-plugin-contract.test.ts`（含原
  `examples/plugins` 扫描所覆盖的 manifest 一致性规则）。

## 安全说明

- `apiKey` 每次调用由宿主传入插件进程，插件不得持久化或记录它。
- manifest 里的 `permissions.network` 目前只是**声明**：`local-process` runner 不按它过滤出站流量
  （见 `server/lib/plugins/manifest.ts` 中 `networkPermissionSchema` 的注释）。
  真正的网络隔离需要 Podman runner。这一点不假装是沙箱。
- 传输层保留宿主原本的全部约束：单 origin、无 query/hash、`redirect: "error"`、
  响应体上限 64 KiB、`Content-Type` 必须是 JSON、单请求 8s 超时。

## 维护

- 协议知识在本目录 `server/index.js` 中自包含（不 import 宿主代码）。
  修改解析规则时，同步更新 `shared/apikey-quota-plugin.ts`（宿主校验 schema）与
  `tests/server/services/apikey-quota-plugin-engine.test.ts`。
- 新增中转站协议：在 `probeProviderBalance` 的 adapter 列表里加一项，
  并扩展 `shared/apikey-quota-plugin.ts` 的 `adapter` 枚举。
