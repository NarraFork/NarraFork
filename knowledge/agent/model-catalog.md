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
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 模型目录与来源

回答「这个 `provider:model` 的上下文窗口、输出上限、推理档位、输入模态、价格是多少」，以及「有哪些连接（来源）、`auto:` 模型从哪些来源出」。凭证怎么选见 [凭证池与模型目录](credentials.md)。

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
- `model-sourcing/auto-models.ts:listAutoModels` 为 `GET /api/model-catalog/auto` 列出 `auto:` 模型及按当前路由顺序排列的来源，最多 500 个逻辑模型。

## 从哪读起
- `server/lib/model-catalog/index.ts`：`getEffectiveModelCard`、`setModelOverride`、更新函数。
- `shared/model-catalog/resolve.ts`：分层合并。
- `server/lib/sourcing/source-groups.ts`

## 相关
- [凭证池与模型目录](credentials.md)
- [模型提供商](providers.md)
- [用量与费用](usage.md)
