---
id: agent.credentials-models
title: 凭证池与存储
summary: 模型凭证的存放、多凭证之间怎么选与降级（Codex 账号池、自定义 API 多密钥）、冷却、credentials.json 与跨实例搬运；额度另见供应商额度节点。
anchors:
  - server/lib/secret-store.ts
  - server/lib/agent/credential-pool.ts
  - server/lib/agent/pooled-provider.ts
  - frontend/components/providers/CredentialMigrationAlert.tsx
  - frontend/components/providers/CredentialNetworkEditor.tsx
  - frontend/components/providers/ProviderKeysPanel.tsx
  - frontend/components/providers/credential-page-selection.ts
  - frontend/components/settings/CredentialTransferCard.tsx
  - frontend/lib/api/credential-transfer.ts
  - frontend/lib/api/provider-keys.ts
  - server/lib/agent/credential-report.ts
  - server/lib/codex-agent-identity.ts
  - server/lib/codex-auth.ts
  - server/lib/codex-manager.ts
  - server/lib/codex-pat.ts
  - server/lib/credential-backup.ts
  - server/lib/credential-display-name.ts
  - server/lib/credential-migration.ts
  - server/lib/credential-state.ts
  - server/lib/credential-store.ts
  - server/lib/credential-transfer/
  - server/lib/provider-key-subjects.ts
  - server/lib/provider-keys.ts
  - server/routes/codex.ts
  - server/routes/credential-transfer.ts
  - server/routes/provider-keys.ts
  - shared/credential-network.ts
  - server/lib/agent/session-affinity.ts
  - server/lib/codex-network.ts
  - frontend/lib/codex-use-credit-quota.ts
  - server/lib/agent/codex-errors.ts
keywords:
  - 凭证池
  - 密钥池
  - 多密钥
  - 冷却
  - 会话粘性
  - selectPoolEntry
  - PooledProvider
  - credentials.json
  - credential-state.json
  - codex-credentials.json
  - provider-keys.json
  - Codex 账号
  - 负载均衡
  - load-balancing-mode
  - tier-balanced
  - useCreditQuota
  - codex_quota_failover_rebuild
  - 凭证迁移
  - 凭证导出
  - credential-transfer
  - /api/provider-keys
  - /api/codex
  - /api/credential-transfer
  - step-up
  - disabledReason
  - agent_identity
  - Codex PAT
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---

# 凭证池与存储

模型凭证的存放、选择与降级：同一连接下有多个凭证（Codex 账号、自定义 API 的多把密钥）时怎么选、坏了怎么冷却、凭证存在哪、怎么搬到另一个实例。余额与套餐额度的查询、缓存、展示见 [供应商余额与额度](provider-quota.md)；模型元数据、目录更新、来源组与 `auto:` 模型列表见 [模型目录与来源](model-catalog/index.md)。

## 关键规则
- 选择算法在 `agent/credential-pool.ts:selectPoolEntry`，Codex 账号池与自定义提供商多密钥共用：过滤 disabled/archived/exclude，再排除冷却中的；会话粘性条目优先；模式 `priority`（取优先级数值最小）/ `balanced`（随机）/ `tier-balanced`（先取最优档位再随机）。密钥池传 `fallbackToCooling`，全部冷却时选最早恢复的，Codex 不这样做，没有可用条目就返回空。
- 多密钥提供商由 `agent/pooled-provider.ts` 包装。`provider.ts:registerCredentialProviderSource` 里直连（`plain`）与走池的判定，每个分支一行：
  - NUG：永远不走池，按直连。
  - 可用密钥为 0 个：直连。
  - 可用密钥恰好 1 个，且其 `apiKey` 等于 `config.apiKey`、且没有独立网络身份（`network`）：直连。
  - 可用密钥多于 1 个：走池。
  - 可用密钥恰好 1 个，但其 `apiKey` 不等于 `config.apiKey`：走池。
  - 可用密钥恰好 1 个，但带独立网络身份：走池。
- 密钥故障分类 `classifyKeyFault`（只对 `ApiError`，其他错误不归咎密钥）：
  - 401：标记 invalid，把密钥写成 disabled（`disabledReason: "invalid"`）；密钥文件不可读时改为内存冷却 10 分钟。
  - 402：冷却 30 分钟（quota）。
  - 403：冷却 10 分钟（forbidden）。
  - 429 且文本是硬性额度：冷却 30 分钟（quota）。
  - 其他 429：取 Retry-After（上限 60 分钟），没有则 60 秒（rate_limited）。
  - 冷却只在内存，仅 invalid 落盘；`keyCooldown` 还会合并额度快照的耗尽时刻（`provider-key-quota.ts` 的探针，由额度仓库注册），取较晚者。
- 会话粘性：同一会话沿用上次的密钥（`SessionAffinity`，密钥池最多 5000 条），除非它冷却或被禁用；Codex 账号池另有自己的实例（最多 2000 条，TTL 6 小时，`codex-manager.ts`），账号被停用或额度耗尽时淘汰其会话。
- Codex 账号状态：停用原因 `manual` / `too_many_failures` / `quota_exhausted` / `banned`；系统阻断（`too_many_failures`、`quota_exhausted`）与最近的用量快照、历史、请求计数一起存在 `credential-state.json`，写入防抖 2 秒，不进加密凭证文件，文件不可读则从空开始（`credential-state.ts`）。`useCreditQuota` 为真且还有可花的点数时，窗口用尽不会把账号标为额度耗尽（`codex-manager.ts:applyCachedQuotaStates`）；前端从关到开要先确认（`frontend/lib/codex-use-credit-quota.ts`）。
- Codex 额度故障转移：上游在已有输出后才报 `usage_limit_reached` 时，`CodexRebuildHistoryRetryError`（`codex_quota_failover_rebuild`）让外层先落盘部分回合、用新历史换下一个账号重试（`agent/codex-errors.ts`）。
- Codex 凭证种类（`credential-store.ts:CredentialAuth`）：`oauth`（浏览器 PKCE 或设备码，`codex-auth.ts`）、`pat`（`at-` 前缀静态令牌，经 whoami 校验，`codex-pat.ts`）、`agent_identity`（Ed25519 签名的 `AgentAssertion`，`codex-agent-identity.ts`）、`api_key`、`opaque`。出站网络身份（代理、UA、设备 id）逐凭证解析，缺省取 `settings.codex`；刷新令牌、读用量、发模型请求用同一身份（`codex-network.ts`）。
- 存储：所有模型凭证在一个加密文件 `credentials.json`（`credential-store.ts`）。三个持有者各管一部分：`CodexManager`、提供商密钥库（`provider-keys.ts`）、插件密钥库；该文件存在即切换开关，没有它时仍用旧的 `codex-credentials.json` 与 `provider-keys.json`。搜索密钥始终留在 `provider-keys.json`。`credential-migration.ts` 在首次加载设置时一次性迁移：先备份（`credential-backup.ts`），再原子写新文件；旧文件读不了或两个凭证同 id 时整体不迁移、下次启动重试。
- 设置里每个提供商的 `apiKey` 是它第一把密钥的投影，写它就是改第一把密钥；运行时选择在 `pooled-provider.ts`（`provider-keys.ts` 头注释，投影实现在 `settings/provider-keys-projection.ts`）。
- 跨实例搬运（`credential-transfer/`）：导出把所选凭证封成口令加密包（scrypt N=2^16 派生 AES-256-GCM，口令 ≥10 字符，包 ≤8MiB，实例密钥 `secret.key` 不出服务器）；导出要先通过二次验证（step-up，purpose `credentials.export`）；导入先预览哪些已存在，再逐项 add / replace / skip（`routes/credential-transfer.ts`，全部管理员）。目前只有一种 `credential` 类型，与数据导出共用凭证格式。
- 请求记账时让只跑在一个凭证上的适配器在每条路径上都报同一个凭证 id（`agent/credential-report.ts:reportCredentialId`）；`credential-display-name.ts` 把凭证 id 解析成人能认的名字（Codex 取显示名/邮箱/账号 id）。

## 从哪读起
- `server/lib/agent/credential-pool.ts`、`pooled-provider.ts`
- `server/lib/codex-manager.ts`：Codex 账号池（很大，入口 `acquireContext`（选账号）、`reportSuccess`/`reportFailure`/`reportQuotaExhausted`、`snapshot`）。
- `server/lib/credential-store.ts`、`provider-keys.ts`、`credential-state.ts`
- 路由：`/api/codex/*`（`routes/codex.ts`：账号增删改、启停、归档、`load-balancing-mode`、`tier-order`、`fingerprint`、`import`，除 `/quota-overview` 外全是管理员）、`/api/provider-keys/*`（`routes/provider-keys.ts`：某提供商的密钥增删改排序、用量刷新）、`/api/credential-transfer/*`。
- 前端：`ProviderKeysPanel.tsx`（密钥列表与每把密钥的代理/UA/用量）、`CredentialNetworkEditor.tsx`、`CredentialMigrationAlert.tsx`、`credential-page-selection.ts`、设置页 `CredentialTransferCard.tsx`；`lib/api/provider-keys.ts`、`lib/api/credential-transfer.ts`；`shared/credential-network.ts` 是逐凭证网络身份的校验与形状。
- 测试：`agent/__tests__/credential-pool.test.ts`、`pooled-provider*.test.ts`；`server/lib/__tests__/credential-store.test.ts`、`credential-migration*.test.ts`、`credential-state.test.ts`、`credential-transfer*.test.ts`、`codex-manager-*.test.ts`、`provider-keys.test.ts`。

## 改它时
- 加一种选择模式：改 `PoolSelectionMode`（`credential-pool.ts`），`routes/codex.ts` 的 `isCodexLoadBalancingMode` 校验与前端 Codex 设置要一起改；Codex 与密钥池共用这一个函数，别在调用方各写一份。
- 加一类凭证：`CredentialAuth` 加分支，`credential-migration.ts` 与 `credential-transfer/kinds.ts` 的导出/匹配/导入要覆盖，否则搬运包里会漏；`persisted-credential-cache` 里的身份也要纳入新字段。
- 改 `credentials.json` 结构要保持「文件存在即模式开关」与迁移失败不动旧文件的语义，并同步数据导入导出（见仓库 `docs/DATA_PORTABILITY.md` 所列，`data-portability*.test.ts`）。
- 故障分类、冷却时长与「不回退」规则写在 `pooled-provider.ts`；新增上游错误码先看 `classifyKeyFault`，别让非密钥错误冷却密钥。
- 凭证密钥不得出现在日志、快照或前端投影里；`credential-transfer` 与 `provider-keys` 路由都是管理员且返回的投影不含密钥值。

## 相关
- [供应商余额与额度](provider-quota.md)
- [模型目录与来源](model-catalog/index.md)
- [模型提供商](providers/index.md)
- [用量与费用](usage.md)
