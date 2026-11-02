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

## 安装与启用

1. 静态 + 运行时校验（仓库内）：

   ```bash
   bun scripts/validate-plugin-release.ts "$(pwd)/plugins" --runtime
   ```

2. 打包成 `.zip` 或 `.nfplugin`（目录根需直接含 `manifest.json`）：

   ```bash
   cd plugins/apikey-quota
   zip -r ../apikey-quota-1.0.0.nfplugin . -x '*/.*'
   ```

3. 安装（管理员）：`POST /api/plugins/install`（multipart，字段 `archive`），
   或把包放进 `~/.narrafork/plugin-imports/` 后在安装弹窗里选择。
4. 启用 + 激活该插件。之后每次额度查询都会走插件进程。

**不安装也完全可用**：宿主自动使用内置适配器，行为与抽取前一致。

## 回退语义

| 情形 | 结果 |
|---|---|
| 插件 `status: "ok"` | 直接采用（宿主内置路径不执行） |
| 插件 `status: "unsupported"` | 视为权威结论，不探测内置路径 |
| 插件 `status: "failed"` | 按既有的 `request_failed` 语义记录 |
| 插件未安装 / 未启用 / 未激活 / 输出非法 | 回退内置适配器 |

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
