---
id: automation.plugins.permissions-secrets
title: 插件授权与密钥
summary: 能力代理、授权存储、密钥保管、签名与加固。
anchors:
  - server/services/plugin-capability-broker.ts
  - server/services/plugin-permission-store.ts
  - server/services/plugin-secret-vault.ts
  - server/services/plugin-secret-broker.ts
  - server/services/plugin-signature.ts
  - server/services/plugin-hardening.ts
  - server/services/plugin-manager.ts
  - server/lib/plugins/permissions.ts
  - server/routes/plugins.ts
  - server/lib/plugin-credentials.ts
  - server/scripts/repair-plugin-authority.ts
  - server/services/plugin-command-secret-writes.ts
  - server/services/plugin-host-dispatcher.ts
  - server/services/plugin-host-services.ts
  - server/services/plugin-integration-authority-service.ts
  - server/services/plugin-lifecycle-revoke-coordinator.ts
  - server/services/plugin-sbom.ts
keywords:
  - CapabilityBroker
  - permissions.json
  - secrets.json
  - credentials.json
  - SCOPE_ESCALATION
  - PLUGIN_TRUST_CONFIGURATION_MISSING
  - NF_PLUGIN_TRUST_ENFORCED
  - NF_PLUGIN_REQUIRE_SIGNATURE
  - NF_PLUGIN_REQUIRE_SBOM
  - secretWrites
  - installationId
  - repair-plugin-authority
  - SBOM
  - 授权
  - 密钥
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 插件授权与密钥

插件对宿主的每次调用先过能力代理；授权状态存在宿主一侧的文件里；插件的密钥值另存一处，不跟配置、日志混在一起。

## 关键规则
- 没有信任分级：安装由管理员完成就是信任决定（`lib/plugins/permissions.ts` 头注释已写明移除 T0–T3，运行时代码里也没有对应判断）。能力名是开放字符串，`CAPABILITIES` 只是已知名单，不做准入。
- 安装时 `seedGrantsFromManifest` 把清单 `permissions.host` 里有规范适配器的能力写成初始授权；已有授权列表（含撤销）不再被改写。升级时新清单多出的能力不会自动授予，而是排成待审批请求（`requestUndeclaredManifestCapabilities`），旧授权继续有效。
- `CapabilityBroker.authorize` 的判定顺序：上下文与绑定身份 → 生命周期（未启用 409、不兼容 409、`quarantine` 423、运行时非 active/degraded 503，`validateLifecycle`）→ 期限 → 插件被撤销 → 调用域（用户调用不得越权到别的 userId，`SCOPE_ESCALATION`）→ 授权列表里须有该能力的授权（没有就拒绝，并触发待审批请求；缺授权被当作“被收回”的状态信号）→ 过期与约束（路径、方法、字节数、速率）→ 内核授权（单例以 `kernelEnforcement: true` 构造）。`effectiveCapabilities` 只是报告，不再参与放行；结果缓存 1s，审计保留最近 1000 条。
- 授权存储（`PluginPermissionStore`，`<narrafork-home>/plugins/permissions.json`）：按 pluginId + installationId（稳定 UUID，升级不变）存授权、待审批请求、永久拒绝；文件上限 4MiB，每安装各类条目 ≤512，每插件最多 32 个安装，待审批默认 ≤20；已决请求只留最近 100 条，防止触顶——加载时超限的文件会被当作损坏重置，连授权一并清空。
- 管理面（`routes/plugins.ts`，均要求管理员）：读写授权、撤销、待审批列表与批准/拒绝、永久拒绝移除、授权检查/修复/重置；安装与生命周期接口在插件系统关闭时返回 503 `PLUGINS_DISABLED`。
- 密钥值保管（`PluginSecretVault`）：`<narrafork-home>/plugins/secrets.json`，创建即 0600、临时文件加 rename 原子写、不加密；值不进日志和错误；读失败当作“无密钥”。提供商声明过的密钥字段改存 `credentials.json`（见 [提供商插件](providers.md)）。
- `PluginSecretBroker`（租约制：默认 30s、最长 5 分钟，绑定运行时代际与请求期限）在平台服务里以无 provider、无授权回调的方式构造，仓库内没有非测试代码调用 `acquireLease/readLease`，生产里只用到 `revokePlugin/restorePlugin`；也就是说租约读值路径目前未接线。
- 签名与 SBOM 只在设置环境变量 `NF_PLUGIN_TRUST_ENFORCED`、`NF_PLUGIN_REQUIRE_SIGNATURE` 或 `NF_PLUGIN_REQUIRE_SBOM` 之一时启用。强制签名时缺 `signature.json` 报 422；包里带签名则要求配置信任密钥环，而环境变量路径不构造密钥环，所以会报 503 `PLUGIN_TRUST_CONFIGURATION_MISSING`（`plugin-manager.ts:assertPackageTrust`、`pluginTrustPolicyFromEnvironment`）。校验算法为 ed25519（`plugin-signature.ts`）。
- `plugin-hardening.ts` 只是一组再导出（health、podman、process、sbom、signature、upgrade），本身没有逻辑。

- 宿主 RPC 面（`plugin-host-services.ts` 注册、`plugin-host-dispatcher.ts` 派发）：插件能调的方法有 `queries.execute`、`commands.execute`、`events.subscribe/unsubscribe/poll`、`storage.get/set/delete/list`、`config.get`、`secrets.list/get/set/delete`、`diagnostics.getOwn`；调用方由宿主绑定的主体标识，参数里不带 `pluginId`，所以插件无法指向别人的命名空间；密钥值 ≤64KiB（保管库是主线程同步读写 JSON）。
- 命令返回的 `secretWrites`（`plugin-command-secret-writes.ts`）：键必须是 `provider.<贡献id>.<字段>` 且该贡献确属本插件（“不属于”与“格式不对”报同一条错，防探测），单值 ≤64KiB（`MAX_COMMAND_SECRET_VALUE_BYTES`），超限拒绝而不截断；校验通过后按序应用，**批次不是原子的**，中途 IO 失败会留下已写的条目；值不进日志。对应的非密钥 `configWrites` 见 [提供商插件](providers.md)。
- 规范授权的数据库镜像：`plugin-integration-authority-service.ts` 把插件安装对应成稳定的授权主体（`plugin_installation`，以 `installationId` 为键，旧状态里以包哈希充当安装 ID 的记录据 `isStableInstallationId` 区分并迁移），`server/scripts/repair-plugin-authority.ts` 能从 `permissions.json` 兼容镜像重建并清理旧的包哈希键授权。通用的集成授权/资源绑定/审计/摘要服务（`integration-*.ts`）与 OAuth 共用，归 [OAuth 与对外 API](../../security/oauth-api/index.md) 一侧，见报告。
- 生命周期撤销：`plugin-lifecycle-revoke-coordinator.ts` 把停用/崩溃/隔离/升级/卸载/代际变化/授权修订这些事件，依次派到八层撤销适配器——UI 会话、能力代理、事件网关、调度器、密钥代理、工具注册表、MCP 适配器、提供商注册表。
- SBOM（`plugin-sbom.ts`）：解析与生成 SPDX、CycloneDX，`checkSbomInstallPolicy` 判定安装策略，仅在 `NF_PLUGIN_REQUIRE_SBOM` 启用时生效。
- `lib/plugin-credentials.ts` 把提供商声明的密钥字段映射成凭证库（`credential-store`）里的 `opaque` 凭证条目（`pluginCredentialId`），保管库（`plugin-secret-vault.ts`）与适配器工厂都经它读写。`lib/secret-store.ts` 是通用的“凭证 JSON 默认 AES-256-GCM 加密存放”工具，不是插件专属，归凭证存储一侧，见报告。

## 从哪读起
- `server/services/plugin-capability-broker.ts:CapabilityBroker.authorize`。
- `server/services/plugin-permission-store.ts`：授权文件。
- `server/services/plugin-manager.ts`：授权的播种、升级时的待审批请求。

## 改它时
- 加一个能力名：能力是开放字符串，`CAPABILITIES` 只是名单；要被自动授予需在清单 `permissions.host` 里有规范适配器（`seedGrantsFromManifest`）。`plugin-seed-grants.test.ts`、`plugin-integration-authority-service.test.ts`、`plugin-signature.test.ts`、`plugin-sbom.test.ts` 在 `server/services/__tests__/`。
- 加一个宿主 RPC 方法：`plugin-host-services.ts` 注册（schema、副作用级别、所需能力）、`plugin-host-dispatcher.ts` 的授权决定、`lib/plugins/protocol.ts` 的参数类型一起改；参数里不得带 `pluginId`。
- 改授权文件格式或上限：`plugin-permission-store.ts`；超限会把文件当损坏重置并清空授权，所以改上限前先看已决请求保留数。
- 改撤销层：`PLUGIN_LIFECYCLE_REVOKE_LAYERS` 与各层适配器注册一起；漏层意味着停用后仍有旧授权在用。
- 不变量：缺授权必须拒绝并触发待审批；用户调用不得越权到别的 userId；值永不进日志。

## 相关
- [插件系统](index.md)
- [插件运行时](runtime.md)
