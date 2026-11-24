---
id: agent.model-catalog
title: 模型目录与来源
summary: 模型卡的分层解析（目录、网关发现、本地覆盖）与来源组、auto 模型列表的总览：两个下级怎么配合、各管什么。
anchors:
  - server/lib/model-catalog/index.ts
  - server/lib/sourcing/source-groups.ts
keywords:
  - 模型目录
  - 上下文窗口
  - auto:
  - auto 模型
  - 模型覆盖
  - model-catalog
  - /api/model-catalog
  - local-connection
  - preset-model
  - modelProtocols
  - catalog.json
status: draft
verified_at: 776dbf07e
---
# 模型目录与来源

回答两个问题：一是「这个 `provider:model` 的上下文窗口、输出上限、推理档位、输入模态、价格是多少」；二是「有哪些连接（来源）、`auto:` 模型从哪些来源出」。凭证怎么选见 [凭证池与存储](../credentials.md)，额度见 [供应商余额与额度](../provider-quota.md)。

## 由哪几部分组成
- 模型目录：分层的模型卡（内置目录、网关/列表发现、本地覆盖），目录更新与快照，请求内冻结。在 [模型目录](catalog.md)。
- 来源组与模型列表：把设置里的连接派生成来源组，读各连接缓存的模型列表，`auto:` 路由排序与列表，NUG 模型缓存与可用性，迁移服务。在 [来源组与模型列表](sourcing.md)。

## 怎么配合
1. 来源组（`sourcing/source-groups.ts`）回答「有哪些连接」，各连接的发现元数据由各提供商路由缓存（见 [模型提供商](../providers/index.md)）。
2. 模型卡解析（`shared/model-catalog/resolve.ts`）把目录值、发现值和本地覆盖按层合并，`server/lib/model-catalog/index.ts` 的 `queryForModel` 把完整模型值映射成查询。
3. 适配器按模型卡限制输出上限、输入预算和输入模态（`provider-model-metadata.ts`）。
4. `auto:` 模型在来源组上做路由排序，排序规则见下级节点。

## 该读哪个下级
- 窗口、价格、推理档位、覆盖、目录更新失败：[模型目录](catalog.md)。
- 模型列表为空或不对、`auto:` 选了哪个来源、NUG 模型下线与刷新、前缀迁移与 broken model：[来源组与模型列表](sourcing.md)。

## 从哪读起
- `server/lib/model-catalog/index.ts`：`getEffectiveModelCard`、`setModelOverride`、更新函数。
- `server/lib/sourcing/source-groups.ts`：来源组视图。

## 改它时
- 跨两部分的改动（例如新增一类来源并让它带模型卡字段）：先看来源组再看模型卡，分别遵循下级节点的「改它时」。

## 相关
- [凭证池与存储](../credentials.md)
- [供应商余额与额度](../provider-quota.md)
- [模型提供商](../providers/index.md)
- [用量与费用](../usage.md)

## 下面有什么

- [模型目录](catalog.md)：模型卡的分层解析、目录更新与快照、本地覆盖。
- [来源组与模型列表](sourcing.md)：来源组与模板、模型列表读取器、auto 模型路由与列表、NUG 模型缓存、迁移。
