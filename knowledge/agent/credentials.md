---
id: agent.credentials-models
title: 凭证池与额度
summary: 多凭证之间怎么选与降级（凭证池）、额度快照；模型目录与来源见模型目录节点。
anchors:
  - server/lib/agent/credential-pool.ts
  - server/lib/agent/pooled-provider.ts
  - server/lib/sourcing/quota-store.ts
  - frontend/components/providers/CodexUsageDisplay.tsx
  - frontend/components/providers/CredentialMigrationAlert.tsx
  - frontend/components/providers/CredentialNetworkEditor.tsx
  - frontend/components/providers/ProviderKeysPanel.tsx
  - frontend/components/providers/channel-health.ts
  - frontend/components/providers/credential-page-selection.ts
  - frontend/components/settings/CredentialTransferCard.tsx
  - frontend/hooks/useOpencodeUsage.ts
  - frontend/lib/api/commandcode.ts
  - frontend/lib/api/credential-transfer.ts
  - frontend/lib/api/provider-import.ts
  - frontend/lib/api/provider-keys.ts
  - frontend/lib/api/tokendance.ts
  - frontend/lib/codex-credits.ts
  - frontend/lib/codex-tiers.ts
  - frontend/lib/codex-usage-windows.ts
  - frontend/lib/tokendance-recovery.ts
  - frontend/routes/admin/providers.tsx
  - frontend/routes/settings/providers.add.tsx
  - frontend/routes/settings/providers.tokendance.callback.tsx
  - frontend/routes/settings/providers.tsx
  - server/lib/agent/credential-report.ts
  - server/lib/codex-agent-identity.ts
  - server/lib/codex-auth.ts
  - server/lib/codex-manager.ts
  - server/lib/codex-pat.ts
  - server/lib/codex-usage-queue.ts
  - server/lib/codex-usage-summary.ts
  - server/lib/codex-usage.ts
  - server/lib/commandcode-manager.ts
  - server/lib/commandcode-usage.ts
  - server/lib/credential-backup.ts
  - server/lib/credential-display-name.ts
  - server/lib/credential-migration.ts
  - server/lib/credential-state.ts
  - server/lib/credential-store.ts
  - server/lib/credential-transfer/
  - server/lib/kimi-usage-cache.ts
  - server/lib/opencode-usage-cache.ts
  - server/lib/persisted-credential-cache.ts
  - server/lib/provider-availability-error.ts
  - server/lib/provider-key-subjects.ts
  - server/lib/provider-keys.ts
  - server/routes/codex.ts
  - server/routes/commandcode.ts
  - server/routes/credential-transfer.ts
  - server/routes/deepseek.ts
  - server/routes/kimi.ts
  - server/routes/nug.ts
  - server/routes/opencode.ts
  - server/routes/provider-keys.ts
  - server/routes/tokendance.ts
  - server/services/credential-usage-totals.ts
  - server/services/tokendance-service.ts
  - shared/credential-network.ts
  - shared/tokendance.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 凭证池与额度

两件事：同一连接下有多个凭证时怎么选、坏了怎么降级（凭证池），以及额度快照怎么存。模型元数据、目录更新、来源组与 `auto:` 模型列表见 [模型目录与来源](model-catalog.md)。

## 关键规则
- 选择算法在 `agent/credential-pool.ts:selectPoolEntry`，Codex 账号池与自定义提供商多密钥共用：过滤 disabled/archived/exclude，再排除冷却中的；会话粘性条目优先；模式 `priority` / `balanced` / `tier-balanced`。密钥池传 `fallbackToCooling`，全部冷却时选最早恢复的，Codex 不这样做。
- 多密钥提供商由 `agent/pooled-provider.ts` 包装。`provider.ts:registerCredentialProviderSource` 里直连（`plain`）与走池的判定如下：
  - NUG：永远不走池，按直连。
  - 可用密钥为 0 个：直连。
  - 可用密钥恰好 1 个，且其 `apiKey` 等于 `config.apiKey`、且没有独立网络身份（`network`）：直连。
  - 可用密钥多于 1 个：走池。
  - 可用密钥恰好 1 个，但其 `apiKey` 不等于 `config.apiKey`：走池。
  - 可用密钥恰好 1 个，但带独立网络身份：走池。密钥故障分类 `classifyKeyFault`：401 标记 invalid；402 冷却 30 分钟（quota）；403 冷却 10 分钟；429 若是硬性额度文本冷却 30 分钟，否则取 Retry-After（上限 60 分钟）或默认 60 秒。其他错误不归咎密钥。冷却只在内存，仅 invalid 落盘。
- 会话粘性：同一会话沿用上次的密钥（`SessionAffinity`，最多 5000 条），除非它冷却或被禁用。
- `sourcing/quota-store.ts`：按凭证身份保存额度快照，身份（密钥、端点等）变化后读不到旧账号的数字；各额度来源自己管调度，只读写这里的快照。密钥池用 `registerKeyQuotaProbe` 从这里判断某把密钥是否仍在额度耗尽期内。

## 从哪读起
- `server/lib/agent/credential-pool.ts`、`pooled-provider.ts`
- `server/lib/sourcing/quota-store.ts`
- 测试：`agent/__tests__/credential-pool.test.ts`

## 相关
- [模型目录与来源](model-catalog.md)
- [模型提供商](providers.md)
- [用量与费用](usage.md)
