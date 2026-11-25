---
id: agent.model-catalog.sourcing
title: 来源组与模型列表
summary: 来源组与模板、模型列表读取器、auto 模型路由与列表、NUG 模型缓存与可用性、前缀与聚合迁移、模型选择界面。
anchors:
  - server/lib/sourcing/allocate-group.ts
  - server/lib/sourcing/legacy-transfer.ts
  - server/lib/sourcing/model-list-readers.ts
  - server/lib/sourcing/presets.ts
  - server/lib/sourcing/quota-store.ts
  - server/lib/sourcing/templates.ts
  - server/lib/model-sourcing/
  - server/lib/model-options.ts
  - server/lib/model-options-contract.ts
  - server/lib/model-options-index.ts
  - server/lib/model-options-worker.ts
  - server/services/plugin-provider-registry.ts
  - server/routes/model-catalog.ts
  - shared/sourcing/
  - shared/auto-model.ts
  - shared/auto-route-strategy.ts
  - server/lib/agent/auto-route-signals.ts
  - server/services/auto-sticky-source.ts
  - server/lib/nug-availability-poller.ts
  - server/lib/nug-model-availability.ts
  - server/lib/nug-model-cache.ts
  - server/lib/nug-model-refresh-coordinator.ts
  - server/lib/nug-model-sync.ts
  - server/services/aggregation-migration-service.ts
  - server/services/broken-model-migration-service.ts
  - server/services/provider-prefix-migration-service.ts
  - server/routes/sourcing.ts
  - frontend/lib/api/sourcing.ts
  - frontend/lib/model-network-error.ts
  - frontend/lib/model-search.ts
  - frontend/lib/nug-model-refresh.ts
  - frontend/hooks/useModels.ts
  - frontend/hooks/useModelCatalog.ts
  - frontend/components/narrator/model/PaginatedModelMenuItems.tsx
  - server/lib/model-options.test.ts
  - server/lib/model-options-index.test.ts
  - server/lib/model-options-fallback.test.ts
  - frontend/routes/settings/models.tsx
  - frontend/components/providers/AutoParticipationSwitch.tsx
  - frontend/components/providers/InlineCustomModels.tsx
  - frontend/components/providers/ModelList.tsx
  - frontend/components/providers/ModelProtocolSelect.tsx
  - frontend/components/providers/ModelRow.tsx
  - frontend/components/providers/auto-participation.ts
  - frontend/components/settings/BrokenModelMigrationHost.tsx
  - frontend/components/settings/BrokenModelMigrationModal.tsx
  - frontend/components/settings/ModelAggregationsSection.tsx
  - frontend/components/settings/ModelsSection.tsx
  - frontend/components/settings/broken-model-selection.ts
  - frontend/lib/follow-model-label.ts
keywords:
  - 来源组
  - sourceGroupForConnection
  - createGroupAllocator
  - listCachedTemplateModels
  - registerModelListReader
  - readTemplateModelList
  - singletonSources
  - listAutoModels
  - orderAutoCandidates
  - lastServedProvider
  - /api/model-catalog/auto
  - /api/sourcing/templates
  - NUG 模型缓存
  - nug-model-cache
  - 模型不可用
  - broken model
  - provider_missing
  - model_not_listed
  - 聚合迁移
  - __agg__
  - auto 参与
  - settings.agent.modelProtocols
status: draft
verified_at: 9bba5f6cdfe1f1a3602e12806eb8129c34d61716
---
# 来源组与模型列表

回答「有哪些连接（来源）、各来源缓存了哪些模型、`auto:` 模型从哪些来源出」。模型卡本身（窗口、价格）见 [模型目录](catalog.md)。

## 关键规则
- 来源组（`sourcing/source-groups.ts`，入口，锚在总览节点）是旧 settings 数组派生的只读视图：Codex、TokenDance、Command Code 三个单例，加自定义 API、NUG 与可执行插件提供商；settings 或插件注册表修订号变化才重建；重复 id/前缀保留先出现者。
- `sourcing/allocate-group.ts:createGroupAllocator` 在数据导入与凭证导入时统一分配 id 和前缀，避开宿主保留前缀，冲突时前缀加 `-2`、`-3`。
- 缓存模型列表经模板读取（`sourcing/templates.ts:listCachedTemplateModels`，`sourcing/model-list-readers.ts`）：各目录持有者用 `registerModelListReader(来源, 读取函数)` 注册同步读取器（只读已有缓存，不触发刷新、不应用 agent 的隐藏/禁用过滤），重新注册会替换旧读取器，旧持有者的注销函数不会删掉替换者。`readTemplateModelList` 选读取器的分支，每条一行：
  - 模板是 `codex`、`tokendance`、`command-code`、`nug`、`plugin`：用同名单例读取器（`singletonSources`）。
  - 其余：按连接实际协议（`group.endpoint.protocol`）选，缺省 `completions-compatible`；同一已识别服务（如 Kimi）可有多种协议，由协议而非服务决定目录持有者。
  - 没有对应读取器：返回空列表。
  - 注册处：`routes/anthropic.ts`（`anthropic-messages`）、`routes/openai.ts`（`openai-responses`、`completions-compatible`）、`routes/gemini.ts`（`gemini-compatible`）、`routes/nug.ts`（`nug`）、`lib/settings/provider.ts`（codex、tokendance、command-code）、`services/plugin-platform-services.ts`（`plugin`，读插件注册表里 `providerInstanceId` 与组 id 完全相等的实例的全部模型，含已禁用）。
- `GET /api/anthropic|openai|gemini|nug/providers/:id/models` 用 `source-groups.ts:sourceGroupForConnection` 为当前连接（含已禁用、未保存的草稿）构造来源组视图，再由 `listCachedTemplateModels` 按模板读到的 id 过滤该路由自己的缓存模型，保留其完整元数据和顺序，返回 `fromCache: true`；OpenAI 路由的协议由 `customApiProtocolFromOpenAI(config)` 决定，没有配置时按 `completions-compatible`。
- `sourcing/templates.ts` 描述一类上游（`known`/`api`、官方端点、是否多凭证、是否订阅），来源组与预设都从它取类型和端点；`presets.ts` 经 `GET /api/sourcing/templates` 提供添加提供商的预设目录。模板上的额度探测函数（`probeQuota`）在运行时代码里没有调用方，只有测试用到（未核实是否仍在接入中）。
- `auto:` 路由排序（`shared/auto-route-strategy.ts:orderAutoCandidates`），依次：不可用的排最后；订阅制（Codex、Kimi Code、OpenCode Go）先于按量付费；同组内参考价低者先、未知价排在已知价之后；其余保持提供商原顺序。可用性的实时事实在 `agent/auto-route-signals.ts`（全部读内存，不碰网络和数据库）：Codex 看是否有未停在已用尽窗口上的启用账号；自定义 API 看是否有既未额度耗尽也未因 403 休息的启用密钥（短 429 休息不算）；NUG 在网关模型被记为下线时不可用；其余恒可用。会话已有回复后沿用上次出回复的提供商（`services/auto-sticky-source.ts:lastServedProvider`，compact 之后重新选）。
- NUG 模型缓存（`nug-model-cache.ts`）保存网关发现的模型、渠道与思考档位（`[]` 表示明确没有，缺省表示网关没报）；模型选择器打开时机会式刷新，冷却 60 秒在服务端统一管（`nug-model-refresh-coordinator.ts`，冷却在尝试开始时消耗，并发调用共享同一个进行中的请求），前端 `nug-model-refresh.ts` 只是少发一次无意义请求的标签页内守卫。模型整池不可用时循环挂起，共享轮询器每 15 秒（首次 3 秒）只拉 `/v1/models` 等其恢复（`nug-availability-poller.ts`）；已知下线的模型在首个请求前就进入同一等待路径（`nug-model-availability.ts`）。
- `model-sourcing/auto-models.ts:listAutoModels` 为兼容管理接口 `GET /api/model-catalog/auto` 列出 `auto:` 模型及按当前路由顺序排列的来源，最多 500 个逻辑模型。
- 选择菜单用 `GET /api/model-catalog/options`，只有实际请求才启动单个专用 Worker；`scope=all|auto|concrete`、q 最多 100 字符、limit 默认 40/最大 100、cursor 最多 2KiB，返回 `revision/items/nextCursor/hasMore`。静态索引最多当前与在建两代；来源组只读插件 registry 的小型 owner 投影，不克隆 configSchema。缓存 owner 的 capture 固定数组引用，先 slice 再仅投影 value/label/provider/identity 小字段，逐批最多 128 行/64KiB 且等待 ACK；筛选配置也按相同批预算传输。总输入最多 20,000 模型行/8MiB，队列合计最多 8 请求，构建 10s、查询 2s、含排队冷请求 12s；未就绪、崩溃、预算超限明确可重试错误，无主线程计算兜底。
- options Worker 自行加载与核对当前 catalog 版本，构建 identity/去重与 modelId→provider 最佳候选反向索引并排序，不调用全量 legacy auto/readAll/card 函数。每个 auto 行仅给 sourceCount；展开用同接口 `sourceModelId` 只处理该模型最多 256 个候选，动态 available/subscription/referencePrice 排序先于分页，不携带账号 label/email。游标绑定 revision/搜索/scope/来源模型及来源排序事实；变化返回 409。settings/plugin/catalog/cache publication 的代际只在需求时检查，关闭菜单不主动扫描或预构建；额度与 availability 不主动重建静态索引。
- 配置 fallback 只补冷目录：某来源发现缓存为空、来源启用且凭据已配置时，加入其 provider default 与属于该前缀的全局 default/summary 两个 pin，标 `auto:false`，不合成 auto 来源。NUG 还要求 baseUrl；发现缓存非空时它是权威，不能把已下架的缺失 default/pin 补回来。显式/发现声明优先于 fallback 去重（`captureModelOptionsSnapshot`、`model-options-fallback.test.ts`）。
- Codex 目录看纯启用凭据 presence（`availableCount > 0`），无凭据不 seed Codex 目录，聚合中显式 Codex pin 标不可用；这个 boolean 进入索引代际，不能用额度/cooldown 瞬态或正数凭据个数波动制造代际抖动。
- 聚合成员按需展开：主 options 页只有 `aggregationId/memberCount`，不带成员明细；点击后用互斥于 sourceModelId 的 `aggregationId` 查询，仅物化该组 ≤20 个配置成员，保留 `__agg__:id:member` 的 pin 值。cursor 绑定组 id、revision、搜索/scope，跨组/代际失效返回 409，不能把聚合展开做成全目录加载（`model-options-index.ts:query`）。
- 「跟随默认 / 跟随摘要」选项（`hooks/useModels.ts:useAllModels` 的 `buildFollowOption`）的标签是目标模型的标签，再退到目标值；目标为空（还没配置默认或摘要模型）时显示 `followDefaultUnset` / `followSummaryUnset`（「默认模型（未配置）」），从不显示 `__default__` 这类哨兵值（`lib/follow-model-label.ts`）。Default / Summary / Aggregations 分组标题走 `narrator` 命名空间翻译。状态栏、模型菜单触发器与列表卡片的「默认（模型）」都经 `followDefaultLabel`，未配置时同样显示未配置文案。

## 从哪读起
- `server/lib/sourcing/source-groups.ts`、`model-list-readers.ts`、`templates.ts`。
- 前端：设置页 `routes/settings/models.tsx` 由 `ModelsSection`、`ModelAggregationsSection`（只读，旧聚合）等组成（目录更新与覆盖见 [模型目录](catalog.md)）；提供商页里的模型行 `ModelRow`/`ModelList`、逐模型协议 `ModelProtocolSelect`（写 `settings.agent.modelProtocols`）、`AutoParticipationSwitch`（是否参与 `auto:` 路由）；hooks `useModels.ts`，`lib/model-search.ts` 是所有模型选择器共用的搜索规则。
- 迁移：改前缀 `provider-prefix-migration-service.ts`、旧 `__agg__:` 聚合值 `aggregation-migration-service.ts`（启动时后台运行一次）、模型已不可用的叙述者批量修复 `broken-model-migration-service.ts`（`provider_missing` 默认勾选，`model_not_listed` 默认不勾，规则在前端 `broken-model-selection.ts`）。

## 改它时
- 加一类来源：`sourcing/templates.ts` 描述它（每个模板都带 `listModels`，由 `byId` 统一补上），目录持有者要 `registerModelListReader` 注册读取器，`source-groups.ts` 派生视图，`presets.ts` 经 `GET /api/sourcing/templates` 给前端；设置或插件注册表修订号变化才重建来源组。
- 改 `auto:` 排序或可用性：`auto-route-strategy.ts` 与 `auto-route-signals.ts` 一起看，可用性函数只能读内存；`routes/model-catalog.ts` 的 `GET /auto` 最多 500 个逻辑模型。
- 改 NUG 模型刷新：冷却由服务端协调器统一管，前端守卫只是优化，不能代替。
- 改 broken model 迁移默认勾选：服务端分类与前端 `broken-model-selection.ts` 一起改。
- 相关测试：`server/lib/sourcing/*.test.ts`（`templates`、`presets`、`source-groups`、`allocate-group`、`model-list-readers`）。

## 相关
- [模型目录与来源](index.md)
- [模型目录](catalog.md)
- [模型提供商](../providers/index.md)
- [凭证池与存储](../credentials.md)
