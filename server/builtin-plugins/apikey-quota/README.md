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

本插件**随应用一起发布**（`server/builtin-plugins/apikey-quota`），不经插件安装流程：没有包记录、
没有 capability grant、没有管理员安装步骤。因此它默认启用，首次启动即生效。

它唯一的授权来源是宿主设置 `plugins.apikeyQuotaEnabled`（`~/.narrafork/settings.json`），默认 `true`：

```jsonc
{
  "plugins": {
    "enabled": true,            // 插件子系统总开关（与本项相互独立）
    "apikeyQuotaEnabled": true  // 关闭后宿主停止插件进程，改用内置适配器
  }
}
```

关闭方式（任选）：

- 设置页把该项改为 `false`（`PATCH /api/settings` 写入 `plugins.apikeyQuotaEnabled`）；
- 直接编辑 `~/.narrafork/settings.json` 后无需重启，下一次额度查询即按新值生效。

关闭后的行为：宿主停止插件进程，改用内置 `provider-balance` 适配器。返回的 DTO、路由、
前端展示完全不变，也不会向用户报错。

**为什么用配置文件项而不是插件设置项**：插件设置项（manifest `contributes.configuration`）
归属于**已安装**插件的实例配置，需要 installation 记录与配置存储；本插件没有这些记录。
放进 `NarraForkSettings` 里，开关和宿主的其他运行配置一样可热读、随 settings 备份/导出迁移，
也不需要为了一个布尔值引入安装态。

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
| `plugins.apikeyQuotaEnabled = false` | 停止插件进程，回退内置适配器 |
| 包缺失 / 进程启动失败 / 进程崩溃 / 输出非法 | 回退内置适配器（不向用户报错） |

## 宿主侧位置

- 进程托管与决策表：`server/services/apikey-quota-plugin-engine.ts`（模块级单例
  `builtinApikeyQuotaEngine`，`app.ts` 安装，`main.ts` 关停序列里 dispose）。
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
