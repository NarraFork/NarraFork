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
  - server/services/plugin-command-config-writes.ts
  - server/main.ts
  - server/lib/agent/remote-provider-adapter.ts
  - server/services/plugin-provider-model-source.ts
  - server/services/plugin-provider-rpc.ts
  - shared/apikey-quota-plugin.ts
keywords:
  - executable-plugin
  - provider.describe
  - provider.listModels
  - PROVIDER_CONFLICT
  - HOST_RESERVED_PREFIXES
  - RemoteProviderAdapter
  - __narrafork_secret_set__
  - x-narrafork-secret
  - hostHints
  - network.egress.allowlist
  - configWrites
  - apikey-quota
  - 模型提供商插件
status: draft
verified_at: 2e6441ad0
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

- 命令返回的 `configWrites`（`plugin-command-config-writes.ts`）：键同为 `provider.<贡献id>.<字段>` 且属本插件；字段必须在该贡献的 `configSchema` 里声明，**声明为密钥的字段被拒绝**（两条通道必须不相交，否则凭证会进明文配置并经 `config.get` 回显）；单值序列化后 ≤16KiB（`MAX_COMMAND_CONFIG_VALUE_BYTES`）；写入是合并到已存配置之上再整体走同一套 schema 校验，不是替换。
- 模型来源与 RPC：`plugin-provider-model-source.ts` 让模型目录能枚举插件提供商而不让通用代码依赖插件平台；`plugin-provider-rpc.ts` 是调用 `provider.*` 的传输封装；`lib/agent/remote-provider-adapter.ts` 是宿主侧的聊天适配器，`shared/apikey-quota-plugin.ts` 是内置 `apikey-quota` 插件与前端共享的类型。
- 就绪检查的实现在 `plugin-provider-readiness.ts`；凭证合并在 `plugin-provider-credential-resolver.ts`（每次请求现解，不缓存）。

## 从哪读起
- `server/services/plugin-provider-registry.ts`：`PluginProviderRegistry`。
- `server/services/plugin-provider-adapter-factory.ts`：适配器与激活时机。
- `server/services/plugin-provider-config-service.ts`：配置/密钥的分流。

## 改它时
- 新增提供商相关的清单字段：`plugin-provider-manifest.ts:providerRegistrationsFromManifest` 与 `lib/plugins/manifest.ts` 一起改；实例 ID 含版本与哈希，升级会得到新实例，别假设目录继承。
- 新增保留前缀：`HOST_RESERVED_PREFIXES`（`auto/default/summary/codex` 等）；前缀冲突报 `PROVIDER_CONFLICT`。
- 改密钥字段判定（`format: "password"`、`writeOnly`、`x-narrafork-secret`）：`plugin-provider-config-service.ts:secretFieldsOf` 同时被 `configWrites` 校验引用，两边要一致。
- 改就绪检查预算（并发 4、1.5s、1000 个）：`plugin-provider-readiness.test.ts`（`server/services/`）断言。
- 不变量：登记只看清单、不启动进程；出站代理是宿主策略，不进插件 config；读密钥失败按“无凭证”处理。

## 相关
- [插件系统](index.md)
- [插件授权与密钥](permissions-secrets.md)
- [模型提供商](../../agent/providers/index.md)
