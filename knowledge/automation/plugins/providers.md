---
id: automation.plugins.providers
title: 提供商插件
summary: 以插件形式接入的模型提供商：清单、注册、凭证、就绪检查。
anchors:
  - server/services/plugin-provider-registry.ts
  - server/services/plugin-provider-manifest.ts
  - server/services/plugin-provider-client.ts
  - server/services/plugin-provider-credential-resolver.ts
  - server/services/plugin-provider-readiness.ts
  - server/services/plugin-provider-adapter-factory.ts
  - server/services/plugin-provider-catalog-refresh.ts
  - server/services/plugin-provider-config-service.ts
  - server/services/plugin-provider-proxy-policy.ts
  - server/main.ts
  - server/lib/agent/remote-provider-adapter.ts
  - server/services/plugin-provider-model-source.ts
  - server/services/plugin-provider-rpc.ts
  - shared/apikey-quota-plugin.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 提供商插件

插件通过 `contributes.providers` 声明模型提供商，宿主把它登记成与内置提供商并列的一种（`kind: "executable-plugin"`），用户用 `<前缀>:<模型>` 选用；真正的聊天请求才去激活插件进程。

## 关键规则
- 登记只看清单，不启动进程：`providerRegistrationsFromManifest` 把能力、限额、配置 schema、默认模型转成注册项；实例 ID 为 `<pluginId>/<contributionId>@<版本:哈希>`，升级会得到新实例而不继承旧目录（`plugin-provider-manifest.ts`）。
- 前缀是全局命名空间：1–32 个可见 ASCII，不含冒号和空白，大小写不敏感；与已有前缀冲突报 `PROVIDER_CONFLICT`，保留前缀（`auto、default、summary、codex` 等 `HOST_RESERVED_PREFIXES`）不可用；清单没写前缀就用贡献 id；管理员可原位改前缀（`setProviderPrefix`，`PUT /:pluginId/providers/prefix`）。
- 接入模型解析：`main.ts` 用 `registerExternalProviderResolver` 把 `pluginProviderRegistry.resolveExternalProvider` 挂到解析链上。
- 适配器懒激活：解析时同步造出 `RemoteProviderAdapter`，首次 `chat/generate` 才激活运行时并做一次 `provider.describe` 握手，客户端池由适配器工厂与目录刷新器共用，同一插件只激活一次（`plugin-provider-adapter-factory.ts`、`plugin-provider-client.ts`）。
- 模型目录：清单只给粗目录，真正的目录靠 `provider.listModels` 拉取，最多翻 10 页、每页 ≤200；失败只把目录标成 stale，保留旧目录；插件成功激活后宿主会顺带刷新仍 stale 的目录，失败仅记日志（`plugin-provider-catalog-refresh.ts`、`plugin-manager.ts:refreshProviderCatalogs`）。
- 配置与凭证：普通字段进注册表和 `state.json`，schema 里标 `format: "password"`、`writeOnly` 或 `x-narrafork-secret` 的字段是密钥，存到密钥库，读接口只返回占位符 `__narrafork_secret_set__` 和“已设置”列表。每次请求由 `PluginProviderCredentialResolver.resolve` 把该提供商自己声明的密钥字段合并进 `config` 发给插件：不缓存，未设置的字段整个省略而不是空串，不记日志，读密钥失败退化为“无凭证”。
- 出站代理是宿主策略，不属于插件 config：解析后的代理 URL 通过 `hostHints` 下发；目标为私网/回环地址时需要插件持有 `network.egress.allowlist` 授权才下发（`plugin-provider-proxy-policy.ts`）。
- 就绪检查 `listPluginProviderReadiness`：只看注册状态、是否有适配器工厂、配置是否齐备，不拉模型、不激活插件；并发 4、总预算 1.5s（超时保留已得结果）、最多 1000 个。
- 管理接口（均要求管理员）：`GET/PUT /:pluginId/providers/config`、`POST .../catalog/refresh`（校验提供商确属该插件）、`PUT .../proxy`、`PUT .../prefix`（`routes/plugins.ts`）。

## 从哪读起
- `server/services/plugin-provider-registry.ts`：`PluginProviderRegistry`。
- `server/services/plugin-provider-adapter-factory.ts`：适配器与激活时机。
- `server/services/plugin-provider-config-service.ts`：配置/密钥的分流。

## 相关
- [插件系统](index.md)
- [插件授权与密钥](permissions-secrets.md)
- [模型提供商](../../agent/providers.md)
