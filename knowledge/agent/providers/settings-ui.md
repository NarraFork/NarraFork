---
id: agent.providers.settings-ui
title: 设置页与路由
summary: 提供商设置页的组件分工与草稿保存、anthropic/openai/gemini 路由与模型列表缓存、本机导入。
anchors:
  - frontend/components/providers/AddProviderPage.tsx
  - frontend/components/providers/AnthropicProvidersSection.tsx
  - frontend/components/providers/ClientFingerprintFields.tsx
  - frontend/components/providers/CommandCodeSection.tsx
  - frontend/components/providers/CustomApiProviderSection.tsx
  - frontend/components/providers/GeminiSection.tsx
  - frontend/components/providers/LocalProviderImport.tsx
  - frontend/components/providers/NUGProvidersSection.tsx
  - frontend/components/providers/OpenAIProvidersSection.tsx
  - frontend/components/providers/PluginProviderSection.tsx
  - frontend/components/providers/ProviderCard.tsx
  - frontend/components/providers/ProviderConfigView.tsx
  - frontend/components/providers/ProviderDetailPanel.tsx
  - frontend/components/providers/ProviderOverviewView.tsx
  - frontend/components/providers/ProviderStatusBadge.tsx
  - frontend/components/providers/TokenDanceSection.tsx
  - frontend/components/providers/provider-add-context.ts
  - frontend/components/providers/provider-add-draft.ts
  - frontend/components/providers/provider-catalog.ts
  - frontend/components/providers/provider-create-flow.ts
  - frontend/components/providers/provider-settings-rebase.ts
  - frontend/components/providers/provider-settings-save.ts
  - frontend/components/providers/providers-reducer.ts
  - frontend/components/providers/types.ts
  - frontend/components/settings/ProviderBaseUrlFixHost.tsx
  - frontend/lib/api/provider-import.ts
  - frontend/routes/admin/providers.tsx
  - frontend/routes/settings/providers.add.tsx
  - frontend/routes/settings/providers.tsx
  - server/routes/anthropic.ts
  - server/routes/gemini.ts
  - server/routes/openai.ts
  - server/routes/provider-import.ts
  - server/services/local-provider-import.ts
  - shared/local-provider-import.ts
keywords:
  - 添加提供商
  - AddProviderPage
  - provider-catalog
  - /api/anthropic
  - /api/openai
  - /api/gemini
  - /api/provider-import
  - /api/provider-import/local
  - registerModelListReader
  - listCachedTemplateModels
  - 本机导入
  - 草稿重放
  - ProviderBaseUrlFixHost
  - CustomApiProviderSection
  - /providers/:id/models
status: draft
verified_at: 776dbf07e
---
# 设置页与路由

提供商设置页（前端 `frontend/components/providers/`）和支撑它的后端路由：添加连接、列出与刷新模型、本机配置导入。

## 关键规则
- 建立连接：`AddProviderPage` + `provider-catalog.ts`（预设取自 `GET /api/sourcing/templates`）。
- 排布与状态：`ProviderOverviewView` + `ProviderConfigView` 排布，`ProviderCard`、`ProviderStatusBadge` 显示状态。
- 协议族区块：`CustomApiProviderSection`（Anthropic/OpenAI/Gemini 等都是它的协议选项）、`NUGProvidersSection`、`CodexSection`、`CommandCodeSection`、`TokenDanceSection`、`PluginProviderSection`。
- 已退役：`AnthropicProvidersSection.tsx`、`GeminiSection.tsx`、`OpenAIProvidersSection.tsx`、`ProviderDetailPanel.tsx` 的文件内容为空导出。
- 草稿重放与保存见 `provider-settings-rebase.ts`、`provider-settings-save.ts`、`provider-create-flow.ts`。
- 本机导入：`/api/provider-import/local/{detect,scan,resolve}`（管理员）扫描本机 claude、codex、opencode、deepseek-harness 的配置，`resolve` 一次最多 32 个 id（`local-provider-import.ts`、`shared/local-provider-import.ts`、`LocalProviderImport.tsx`）。
- 模型列表路由：`/api/anthropic|openai|gemini|nug/models` 与 `/providers/:id/models(/refresh)` 缓存各连接发现的模型；其中 `GET /providers/:id/models` 经来源模板过滤缓存（`listCachedTemplateModels`，细节见 [模型目录与来源](../model-catalog/sourcing.md)），各路由文件在加载时用 `registerModelListReader` 登记自己的缓存读取器。NUG 另有的端点见 [网关类提供商](gateways.md)。

## 从哪读起
- 前端设置页入口：`frontend/routes/settings/providers.tsx`、`providers.add.tsx`、`routes/admin/providers.tsx`（TokenDance 回调路由 `providers.tokendance.callback.tsx` 见网关节点）。
- API 客户端：`frontend/lib/api/provider-import.ts`（`tokendance.ts`、`commandcode.ts` 见网关节点）。
- 后端：`server/routes/anthropic.ts`、`openai.ts`、`gemini.ts`、`provider-import.ts`。

## 改它时
- 加一种提供商来源后，补 `shared/provider-readiness.ts` 的投影与前端 `provider-catalog.ts`、对应设置区块；来源注册规则见 [模型提供商](index.md)。
- 改路由的模型缓存：保持加载时 `registerModelListReader` 登记，否则模板读不到列表。
- 改草稿保存：`provider-settings-rebase.ts` 与 `provider-settings-save.ts` 配套，同时覆盖新建流 `provider-create-flow.ts`。
- 新增界面文案要同时加 `en` 与 `zh-CN` 的 locales。
- 改本机导入：`resolve` 的 id 上限与管理员要求在 `routes/provider-import.ts`；扫描的新工具要同步 `shared/local-provider-import.ts`。

## 相关
- [模型提供商](index.md)
- [网关类提供商](gateways.md)
- [模型目录与来源](../model-catalog/index.md)
