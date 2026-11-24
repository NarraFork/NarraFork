---
id: agent.credentials-models
title: 凭证池与模型目录
summary: 凭证池、模型目录、模型来源。
anchors:
  - server/lib/agent/credential-pool.ts
  - server/lib/agent/pooled-provider.ts
  - server/lib/model-catalog/
  - server/lib/sourcing/
  - server/lib/model-sourcing/
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 凭证池与模型目录

三件事：多个凭证之间怎么选（凭证池）、一个模型的元数据怎么解析（模型目录）、连接/来源怎么组织与展示（sourcing）。

## 关键规则
- 选择算法在 `agent/credential-pool.ts:selectPoolEntry`，Codex 账号池与自定义提供商多密钥共用：过滤 disabled/archived/exclude，再排除冷却中的；会话粘性条目优先；模式 `priority` / `balanced` / `tier-balanced`。密钥池传 `fallbackToCooling`，全部冷却时选最早恢复的，Codex 不这样做。
- 多密钥提供商由 `agent/pooled-provider.ts` 包装（`provider.ts:registerCredentialProviderSource` 在密钥多于一个、或唯一密钥带独立网络身份时使用，NUG 不走池）。密钥故障分类 `classifyKeyFault`：401 标记 invalid；402 冷却 30 分钟（quota）；403 冷却 10 分钟；429 若是硬性额度文本冷却 30 分钟，否则取 Retry-After（上限 60 分钟）或默认 60 秒。其他错误不归咎密钥。冷却只在内存，仅 invalid 落盘。
- 会话粘性：同一会话沿用上次的密钥（`SessionAffinity`，最多 5000 条），除非它冷却或被禁用。
- 模型目录（`model-catalog/index.ts`）：内置目录 `@shared/model-catalog/dist/catalog.json` 为基线；状态文件在 `~/.narrafork/model-catalog/` 下的 `catalog.json`、`pending.json`、`status.json`、`overrides.json`。解析顺序是目录卡 + 网关发现的元数据 + 用户覆盖（模型级与连接级，`getModelOverride`），结果为 `getEffectiveModelCard`。
- 目录更新：`checkModelCatalogUpdate` 先取远端分支 revision（带 ETag，限 1MB），版本变化才下载归档（上限 16MB）；`autoUpdate` 开启则直接激活，否则存为 pending 等 `applyModelCatalogUpdate`。每小时检查一次是否满 24 小时（`startModelCatalogDailyCheck`）。`restoreBuiltinModelCatalog` 回到内置版。
- 请求期间用 `withModelMetadataSnapshot(Iterator)` 固定元数据快照，`agentLoop` 即包在其中。
- 来源组（`sourcing/source-groups.ts`）是从旧的 settings 数组派生的只读视图：每个现有连接（自定义 API、NUG、TokenDance、Command Code、Codex、插件提供商）就是一个来源组；`allocate-group.ts` 在导入时统一分配 id 与前缀，避免与宿主保留前缀及其他来源冲突（冲突时前缀追加 `-2`、`-3`）。
- `sourcing/quota-store.ts`：按凭证身份保存额度快照，身份（密钥、端点等）变化后读不到旧账号的数字；`templates.ts` 为各上游服务的额度探测等行为模板；`presets.ts` 是添加提供商的预设目录。
- `model-sourcing/auto-models.ts:listAutoModels`：为 `auto:` 模型列出按当前路由顺序排列的来源，上限 500 个逻辑模型。

## 从哪读起
- `server/lib/agent/credential-pool.ts`、`pooled-provider.ts`
- `server/lib/model-catalog/index.ts`：`getEffectiveModelCard`、`setModelOverride`、更新函数
- `server/lib/sourcing/source-groups.ts`
- 测试：`agent/__tests__/credential-pool.test.ts`、`sourcing/*.test.ts`

## 相关
- [模型提供商](providers.md)
- [用量与费用](usage.md)
