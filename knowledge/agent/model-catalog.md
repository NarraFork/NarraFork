---
id: agent.model-catalog
title: 模型目录与来源
summary: 模型卡的分层解析（目录、网关发现、本地覆盖）、目录更新与快照、来源组与 auto 模型列表。
anchors:
  - server/lib/model-catalog/
  - server/lib/sourcing/
  - server/lib/model-sourcing/
  - server/lib/agent/provider-model-metadata.ts
  - server/routes/model-catalog.ts
  - server/routes/sourcing.ts
  - shared/model-catalog/resolve.ts
  - frontend/components/providers/AutoParticipationSwitch.tsx
  - frontend/components/providers/ContextWindowField.tsx
  - frontend/components/providers/InlineCustomModels.tsx
  - frontend/components/providers/ModelList.tsx
  - frontend/components/providers/ModelOverviewTab.tsx
  - frontend/components/providers/ModelProtocolSelect.tsx
  - frontend/components/providers/ModelRow.tsx
  - frontend/components/providers/ModelTestDialog.tsx
  - frontend/components/providers/auto-participation.ts
  - frontend/components/settings/BrokenModelMigrationHost.tsx
  - frontend/components/settings/BrokenModelMigrationModal.tsx
  - frontend/components/settings/ModelAggregationsSection.tsx
  - frontend/components/settings/ModelCatalogSection.tsx
  - frontend/components/settings/ModelOverrideEditor.tsx
  - frontend/components/settings/ModelsSection.tsx
  - frontend/components/settings/broken-model-selection.ts
  - frontend/hooks/useModelCatalog.ts
  - frontend/hooks/useModels.ts
  - frontend/lib/api/model-catalog.ts
  - frontend/lib/api/sourcing.ts
  - frontend/lib/model-network-error.ts
  - frontend/lib/model-search.ts
  - frontend/lib/nug-model-refresh.ts
  - frontend/routes/settings/models.tsx
  - server/lib/agent/auto-route-signals.ts
  - server/lib/nug-availability-poller.ts
  - server/lib/nug-model-availability.ts
  - server/lib/nug-model-cache.ts
  - server/lib/nug-model-refresh-coordinator.ts
  - server/lib/nug-model-sync.ts
  - server/services/aggregation-migration-service.ts
  - server/services/auto-sticky-source.ts
  - server/services/broken-model-migration-service.ts
  - server/services/provider-prefix-migration-service.ts
  - shared/auto-model.ts
  - shared/auto-route-strategy.ts
  - shared/model-catalog/
  - shared/model-context-window.ts
  - shared/model-id.ts
  - shared/sourcing/
keywords:
  - 模型目录
  - 模型卡
  - 上下文窗口
  - auto:
  - auto 模型
  - 来源组
  - 模型覆盖
  - model-catalog
  - /api/model-catalog
  - /api/sourcing/templates
  - preset-model
  - local-connection
  - NUG 模型缓存
  - nug-model-cache
  - 模型不可用
  - broken model
  - 聚合迁移
  - __agg__
  - modelProtocols
  - catalog.json
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 模型目录与来源

回答「这个 `provider:model` 的上下文窗口、输出上限、推理档位、输入模态、价格是多少」，以及「有哪些连接（来源）、`auto:` 模型从哪些来源出」。凭证怎么选见 [凭证池与存储](credentials.md)，额度见 [供应商余额与额度](provider-quota.md)。

## 关键规则
- 模型卡按层合并，后者覆盖前者：目录模型（`preset-model`）、目录变体（`preset-variant`）、网关/列表发现的元数据（`discovered`）、模型级本地覆盖（`local-model`）、连接级覆盖（`local-connection`）；每个字段记录来源层（`shared/model-catalog/resolve.ts:resolveModelCard`）。与目录自相矛盾的发现值（输出上限大于总窗口）整体忽略；用户的输出上限超过总窗口时被截到总窗口。
- 弱匹配（前缀等）只借用允许的字段，模型级覆盖不对弱匹配生效（`resolveModelCard` 的 `borrowable`、`wide`）。
- 完整模型值到查询的映射在 `model-catalog/index.ts:queryForModel`：按连接前缀剥出上游模型 ID；codex/anthropic/openai/gemini 前缀同时是目录的渠道键；NUG 连接用网关缓存的渠道与模型卡作为发现元数据，无缓存的旧网关退回不透明的上游 ID；`registerListingWindows` 为无网关元数据通道的提供商（如 Gemini）补输入窗口。发现的元数据先过 `validateRawMetadata`，非法的丢弃并只警告一次。
- 基线是二进制内置的 `shared/model-catalog/dist/catalog.json`（`source.ts:decodeBundledCatalog`，进程内解码一次）。状态文件在 `~/.narrafork/model-catalog/`：`catalog.json`、`pending.json`、`status.json`、`overrides.json`，写入走临时文件再 rename，权限 0600。存储的目录无法解码时回退内置并记入 `lastError`。
- 更新：`checkModelCatalogUpdate` 取分支 revision（带 ETag，上限 1MB），目录版本变了才下载归档（上限 16MB，15s 超时，禁止重定向）；`autoUpdate` 默认 true，开启直接激活，否则存 `pending` 等 `applyModelCatalogUpdate`；`restoreBuiltinModelCatalog` 删除下载文件回到内置。`settings/index.ts` 在非测试环境启动 `startModelCatalogDailyCheck`：每小时检查，距上次检查满 24 小时才真正请求。
- 覆盖：`setModelOverride(scope, key, input)`，`model` 级 key 必须是目录模型 ID，`connection` 级必须是 `provider:model`；只覆盖默认推理档位时，校验它在继承来的档位列表里。每次提交 `revision` 加一，状态对象不可变。写入口 `PUT /api/model-catalog/overrides` 与更新类接口要求管理员；`GET /card`、`/status`、`/auto` 只需登录。
- 请求快照：`withModelMetadataSnapshot(Iterator)` 冻结目录与覆盖，`agentLoop` 整个包在其中（`agent/loop.ts`），同一请求内每个模型只解析一次。
- 用法限制在 `agent/provider-model-metadata.ts`：输出上限取请求值与卡上限的较小者；输入预算取工作窗口、输入上限、总窗口减预留输出三者最小；显式声明的空档位列表表示「不可选推理强度」，此时丢弃 effort；`assertModelInputModalities` 在模型不支持图/音/视频输入时直接抛错。Anthropic、Gemini 等适配器调用这些函数。
- 来源组（`sourcing/source-groups.ts`）是旧 settings 数组派生的只读视图：Codex、TokenDance、Command Code 三个单例，加自定义 API、NUG 与可执行插件提供商；settings 或插件注册表修订号变化才重建；重复 id/前缀保留先出现者。
- `sourcing/allocate-group.ts:createGroupAllocator` 在数据导入与凭证导入时统一分配 id 和前缀，避开宿主保留前缀，冲突时前缀加 `-2`、`-3`。
- `sourcing/templates.ts` 描述一类上游（`known`/`api`、官方端点、是否多凭证、是否订阅），来源组与预设都从它取类型和端点；`presets.ts` 经 `GET /api/sourcing/templates` 提供添加提供商的预设目录。模板上的额度探测函数（`probeQuota`）在运行时代码里没有调用方，只有测试用到（未核实是否仍在接入中）。
- `auto:` 路由排序（`shared/auto-route-strategy.ts:orderAutoCandidates`），依次：不可用的排最后；订阅制（Codex、Kimi Code、OpenCode Go）先于按量付费；同组内参考价低者先、未知价排在已知价之后；其余保持提供商原顺序。可用性的实时事实在 `agent/auto-route-signals.ts`（全部读内存，不碰网络和数据库）：Codex 看是否有未停在已用尽窗口上的启用账号；自定义 API 看是否有既未额度耗尽也未因 403 休息的启用密钥（短 429 休息不算）；NUG 在网关模型被记为下线时不可用；其余恒可用。会话已有回复后沿用上次出回复的提供商（`services/auto-sticky-source.ts:lastServedProvider`，compact 之后重新选）。
- NUG 模型缓存（`nug-model-cache.ts`）保存网关发现的模型、渠道与思考档位（`[]` 表示明确没有，缺省表示网关没报）；模型选择器打开时机会式刷新，冷却 60 秒在服务端统一管（`nug-model-refresh-coordinator.ts`，冷却在尝试开始时消耗，并发调用共享同一个进行中的请求），前端 `nug-model-refresh.ts` 只是少发一次无意义请求的标签页内守卫。模型整池不可用时循环挂起，共享轮询器每 15 秒（首次 3 秒）只拉 `/v1/models` 等其恢复（`nug-availability-poller.ts`）；已知下线的模型在首个请求前就进入同一等待路径（`nug-model-availability.ts`）。
- `model-sourcing/auto-models.ts:listAutoModels` 为 `GET /api/model-catalog/auto` 列出 `auto:` 模型及按当前路由顺序排列的来源，最多 500 个逻辑模型。

## 从哪读起
- 前端：设置页 `routes/settings/models.tsx` 由 `ModelsSection`、`ModelCatalogSection`（目录更新）、`ModelOverrideEditor`（覆盖，字段来源徽标）、`ModelAggregationsSection`（只读，旧聚合）组成；提供商页里的模型行 `ModelRow`/`ModelList`/`ModelOverviewTab`、上下文窗口 `ContextWindowField`（范围见 `shared/model-context-window.ts`）、逐模型协议 `ModelProtocolSelect`（写 `settings.agent.modelProtocols`）、`AutoParticipationSwitch`（是否参与 `auto:` 路由）、`ModelTestDialog`（诊断）；hooks `useModelCatalog.ts`、`useModels.ts`，`lib/model-search.ts` 是所有模型选择器共用的搜索规则。
- 迁移：改前缀 `provider-prefix-migration-service.ts`、旧 `__agg__:` 聚合值 `aggregation-migration-service.ts`（启动时后台运行一次）、模型已不可用的叙述者批量修复 `broken-model-migration-service.ts`（`provider_missing` 默认勾选，`model_not_listed` 默认不勾，规则在前端 `broken-model-selection.ts`）。
- `server/lib/model-catalog/index.ts`：`getEffectiveModelCard`、`setModelOverride`、更新函数。
- `shared/model-catalog/resolve.ts`：分层合并。
- `server/lib/sourcing/source-groups.ts`

## 改它时
- 加模型卡字段：改 `shared/model-catalog/` 的 schema 与 `resolveModelCard`（每个字段都要有来源层），再改 `provider-model-metadata.ts` 的使用点和覆盖编辑器（`ModelOverrideEditor.tsx`）；基线 `dist/catalog.json` 是构建产物，不要手改。
- 加一类来源：`sourcing/templates.ts` 描述它，`source-groups.ts` 派生视图，`presets.ts` 经 `GET /api/sourcing/templates` 给前端；设置或插件注册表修订号变化才重建来源组。
- 改 `auto:` 排序或可用性：`auto-route-strategy.ts` 与 `auto-route-signals.ts` 一起看，`routes/model-catalog.ts` 的 `GET /auto` 最多 500 个逻辑模型。
- 覆盖写入口与更新类接口要管理员，`GET /card`、`/status`、`/auto` 只需登录；覆盖每次提交 `revision` 加一，状态对象不可变。
- 相关测试：`shared/model-catalog/resolve.test.ts`、`card.test.ts`，`server/lib/sourcing/*.test.ts`（`templates`、`presets`、`source-groups`、`allocate-group`），`server/lib/agent/__tests__/provider-model-metadata.test.ts`。

## 相关
- [凭证池与存储](credentials.md)
- [供应商余额与额度](provider-quota.md)
- [模型提供商](providers.md)
- [用量与费用](usage.md)
