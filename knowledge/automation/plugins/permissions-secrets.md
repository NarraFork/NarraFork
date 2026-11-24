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
  - server/lib/secret-store.ts
  - server/scripts/repair-plugin-authority.ts
  - server/services/integration-audit-service.ts
  - server/services/integration-authority-invalidation.ts
  - server/services/integration-authority-service.ts
  - server/services/integration-authorization-service.ts
  - server/services/integration-resource-binding-service.ts
  - server/services/integration-resource-service.ts
  - server/services/integration-summary-service.ts
  - server/services/plugin-command-config-writes.ts
  - server/services/plugin-command-secret-writes.ts
  - server/services/plugin-host-dispatcher.ts
  - server/services/plugin-host-services.ts
  - server/services/plugin-integration-authority-service.ts
  - server/services/plugin-lifecycle-revoke-coordinator.ts
  - server/services/plugin-sbom.ts
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

## 从哪读起
- `server/services/plugin-capability-broker.ts:CapabilityBroker.authorize`。
- `server/services/plugin-permission-store.ts`：授权文件。
- `server/services/plugin-manager.ts`：授权的播种、升级时的待审批请求。

## 相关
- [插件系统](index.md)
- [插件运行时](runtime.md)
