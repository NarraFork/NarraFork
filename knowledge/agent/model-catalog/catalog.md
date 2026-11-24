---
id: agent.model-catalog.catalog
title: 模型目录
summary: 模型卡的分层解析、内置目录与更新快照、本地覆盖、用法限制与覆盖编辑界面。
anchors:
  - server/lib/model-catalog/describe.ts
  - server/lib/model-catalog/error-text.ts
  - server/lib/model-catalog/legacy-v1.ts
  - server/lib/model-catalog/source.ts
  - shared/model-catalog/
  - shared/model-context-window.ts
  - shared/model-id.ts
  - server/lib/agent/provider-model-metadata.ts
  - server/routes/model-catalog.ts
  - frontend/lib/api/model-catalog.ts
  - frontend/hooks/useModelCatalog.ts
  - frontend/components/settings/ModelCatalogSection.tsx
  - frontend/components/settings/ModelOverrideEditor.tsx
  - frontend/components/providers/ContextWindowField.tsx
  - frontend/components/providers/ModelOverviewTab.tsx
  - frontend/components/providers/ModelTestDialog.tsx
  - frontend/lib/constants.ts
keywords:
  - 模型卡
  - resolveModelCard
  - getEffectiveModelCard
  - setModelOverride
  - queryForModel
  - checkModelCatalogUpdate
  - applyModelCatalogUpdate
  - restoreBuiltinModelCatalog
  - withModelMetadataSnapshot
  - assertModelInputModalities
  - validateRawMetadata
  - registerListingWindows
  - preset-variant
  - overrides.json
  - pending.json
  - /api/model-catalog/overrides
  - /api/model-catalog/card
  - 输入模态
  - 推理档位
status: draft
verified_at: 776dbf07e
---
# 模型目录

回答「这个 `provider:model` 的上下文窗口、输出上限、推理档位、输入模态、价格是多少」。凭证怎么选见 [凭证池与存储](../credentials.md)，额度见 [供应商余额与额度](../provider-quota.md)。

## 关键规则
- 模型卡按层合并，后者覆盖前者：目录模型（`preset-model`）、目录变体（`preset-variant`）、网关/列表发现的元数据（`discovered`）、模型级本地覆盖（`local-model`）、连接级覆盖（`local-connection`）；每个字段记录来源层（`shared/model-catalog/resolve.ts:resolveModelCard`）。与目录自相矛盾的发现值（输出上限大于总窗口）整体忽略；用户的输出上限超过总窗口时被截到总窗口。
- 弱匹配（前缀等）只借用允许的字段，模型级覆盖不对弱匹配生效（`resolveModelCard` 的 `borrowable`、`wide`）。
- 完整模型值到查询的映射在 `model-catalog/index.ts:queryForModel`：按连接前缀剥出上游模型 ID；codex/anthropic/openai/gemini 前缀同时是目录的渠道键；NUG 连接用网关缓存的渠道与模型卡作为发现元数据，无缓存的旧网关退回不透明的上游 ID；`registerListingWindows` 为无网关元数据通道的提供商（如 Gemini）补输入窗口。发现的元数据先过 `validateRawMetadata`，非法的丢弃并只警告一次。
- 基线是二进制内置的 `shared/model-catalog/dist/catalog.json`（`source.ts:decodeBundledCatalog`，进程内解码一次）。状态文件在 `~/.narrafork/model-catalog/`：`catalog.json`、`pending.json`、`status.json`、`overrides.json`，写入走临时文件再 rename，权限 0600。存储的目录无法解码时回退内置并记入 `lastError`。
- 更新：`checkModelCatalogUpdate` 取分支 revision（带 ETag，上限 1MB），目录版本变了才下载归档（上限 16MB，15s 超时，禁止重定向）；`autoUpdate` 默认 true，开启直接激活，否则存 `pending` 等 `applyModelCatalogUpdate`；`restoreBuiltinModelCatalog` 删除下载文件回到内置。`settings/index.ts` 在非测试环境启动 `startModelCatalogDailyCheck`：每小时检查，距上次检查满 24 小时才真正请求。
- 覆盖：`setModelOverride(scope, key, input)`，`model` 级 key 必须是目录模型 ID，`connection` 级必须是 `provider:model`；只覆盖默认推理档位时，校验它在继承来的档位列表里。每次提交 `revision` 加一，状态对象不可变。写入口 `PUT /api/model-catalog/overrides` 与更新类接口要求管理员；`GET /card`、`/status`、`/auto` 只需登录。
- 请求快照：`withModelMetadataSnapshot(Iterator)` 冻结目录与覆盖，`agentLoop` 整个包在其中（`agent/loop.ts`），同一请求内每个模型只解析一次。
- 用法限制在 `agent/provider-model-metadata.ts`：输出上限取请求值与卡上限的较小者；输入预算取工作窗口、输入上限、总窗口减预留输出三者最小；显式声明的空档位列表表示「不可选推理强度」，此时丢弃 effort；`assertModelInputModalities` 在模型不支持图/音/视频输入时直接抛错。Anthropic、Gemini 等适配器调用这些函数。

## 从哪读起
- `shared/model-catalog/resolve.ts`：分层合并。
- `server/lib/model-catalog/index.ts`：`getEffectiveModelCard`、`setModelOverride`、更新函数（入口，锚在总览节点）。
- 前端：设置页 `ModelCatalogSection`（目录更新）、`ModelOverrideEditor`（覆盖，字段来源徽标）；`ContextWindowField`（范围见 `shared/model-context-window.ts`）；`ModelOverviewTab`、`ModelTestDialog`（诊断）；hooks `useModelCatalog.ts`。

## 改它时
- 加模型卡字段：改 `shared/model-catalog/` 的 schema 与 `resolveModelCard`（每个字段都要有来源层），再改 `provider-model-metadata.ts` 的使用点和覆盖编辑器（`ModelOverrideEditor.tsx`）；基线 `dist/catalog.json` 是构建产物，不要手改。
- 覆盖写入口与更新类接口要管理员，`GET /card`、`/status`、`/auto` 只需登录；覆盖每次提交 `revision` 加一，状态对象不可变。
- 改更新流程：保持上限（revision 1MB、归档 16MB、15s、禁重定向）与「写临时文件再 rename」。
- 相关测试：`shared/model-catalog/resolve.test.ts`、`card.test.ts`，`server/lib/agent/__tests__/provider-model-metadata.test.ts`。

## 相关
- [模型目录与来源](index.md)
- [来源组与模型列表](sourcing.md)
- [模型提供商](../providers/index.md)
- [用量与费用](../usage.md)
