# API Key Quota Probe（`com.narrafork.apikey-quota`）

把「APIKey 额度查询」从主项目里解耦出来的独立插件：在**独立进程**中向中转站查询某个 API Key
的剩余额度，返回与 NarraFork 现有 DTO 完全一致的归一化结果。

宿主（NarraFork 核心）保留配置来源、凭据、调度/节流/缓存/持久化、HTTP 路由、DTO 和前端展示；
插件只负责「怎么问、怎么解析」。

## 边界

| 关注点 | 归属 |
|---|---|
| provider 配置、APIKey 存储 | 宿主（`settings.customApiProviders`） |
| 队列、并发上限、手动节流、stale 刷新、generation、落盘 | 宿主（`provider-balance-cache.ts`） |
| `GET /api/provider-balances`、`POST /api/provider-balances/:id/{probe,refresh}` | 宿主 |
| 前端徽章 / 设置页展示 | 宿主 |
| **端点探测路径、HTTP 请求、响应归一化（sub2api / new-api）** | **本插件** |

插件不读写宿主的 storage / secret / config，也不注册 UI。它是一次调用的纯函数进程。

## 工具契约

宿主通过 `tools.invoke`（`contributionId: "query-balance"`，`invocation.kind = "plugin_background"`，
`source = "internal"`）调用；工具在 manifest 中声明 `allowBackground: true`，
插件声明 `permissions.host: ["provider.use"]`（工具调用所需的默认授权能力）。

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

### 输出（`output` 为 JSON 字符串）

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

- UI：设置 → 插件 → 「内置插件」区块的开关；
- API：`POST /api/plugins/com.narrafork.apikey-quota/{enable,disable}`（需 admin）。

首次启动时状态记录**隐式创建**为 `desiredState: "enabled"`（没有安装动作，所以也不存在
「用户选择启用」这一刻）。管理员的显式停用会被尊重并持久化。

关闭后的行为：宿主停用该插件，额度查询回退到内置 `provider-balance` 适配器。返回的 DTO、
路由、前端展示完全不变，也不会向用户报错。

### 与外部插件的标准差异（逐条及理由）

| 标准项 | 内置插件 | 理由 |
|---|---|---|
| 安装步骤 / 包记录（`current.json` 指针） | 无 | 包在应用自己的构建产物里，与应用同版本、同生命周期。伪造一条「已安装」记录会与真实分发状态不符，也会让卸载语义指向不可删除的应用内容。 |
| capability grant 审批 | 无（manifest 声明的 `provider.use` 直接生效） | 没有安装动作就没有审批时机。权限仍然只来自 manifest 的显式声明，并且整个插件可被停用，不是绕过授权模型。 |
| 包签名校验 | 无 | 包与应用同一信任根（同一份构建产物、同一份发布签名）。签名解决的是「第三方包来源不可信」，内置包不存在这个边界。 |
| SBOM / 许可页单独登记 | 随应用 | 已并入应用的 SBOM 与许可清单，单独登记会产生重复条目。 |
| 包目录布局 | 自身即 manifest 根（`<root>/manifest.json`），无 `<id>/<version>/<hash>` 层级 | 分发形态决定的物理布局差异；读取路径仍复用同一套包读取与校验函数，非另一套解析。 |

其余全部一致，且由测试守护：

- **manifest 校验**：`PluginCatalog` 用与已安装包相同的读取器（大小上限、JSON 解析、
  `safeParseManifest`、entry 存在性、兼容性、symlink 与路径逃逸检查）。
- **运行时生命周期**：进程由 `PluginRuntimeSupervisor` 启动、回收与重启，本插件不自行
  `new PluginRuntime`。
- **调用通道**：宿主经 `pluginToolRegistry.invoke(..., { invocation: { kind: "plugin_background",
  source: "internal" } })` 调用，`allowBackground` 与能力校验照常生效。
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
| 插件被停用（状态表 `desiredState: disabled`） | 停用插件进程，回退内置适配器 |
| 包缺失 / 进程启动失败 / 进程崩溃 / 输出非法 | 回退内置适配器（不向用户报错） |

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
