---
id: narrator.traits
title: 会话特性层
summary: trait 层：会话能力与策略的分层叠加、解析与自定义 trait。
anchors:
  - frontend/components/settings/TraitLayerEditor.tsx
  - frontend/lib/api/trait-layers.ts
  - server/lib/device-injection-trait.ts
  - server/lib/narrator-custom-traits.ts
  - server/lib/runtime-policy-trait.ts
  - server/lib/trait-layers.ts
  - server/lib/trait-resolution.ts
  - server/routes/trait-layers.ts
  - server/services/trait-layer-service.ts
keywords:
  - trait
  - traits
  - /api/trait-layers
  - custom-disabled-tools
  - custom-blocked-skills
  - custom-subagent-models
  - custom-device-injection
  - custom-runtime-policy
  - custom-enforced
  - enforced
  - resolveEffectiveTraits
  - resolveNarratorRuntimePolicy
  - trait-layer:changed
  - 设备注入
  - 禁用工具
  - 屏蔽技能
  - 子代理模型池
  - 能力上限
  - narrators.traits
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 会话特性层

Trait 是叙述者身上的字符串标签（`narrators.traits`，JSON 数组）。两类：身份/状态标签（`standalone`、`bot`、`team`、`plan`、`background`、`imported` 等，`narrator-utils.ts:NarratorTrait`），和带前缀的编码型策略 trait（`custom-*:` 后接 base64url JSON）。策略 trait 可以写在四层上，运行时合并成一份有效 trait 再被各处消费。

## 关键规则
- 四层，优先级从低到高：`user`（`user_preferences.traits`）→ `project`（`projects.traits`）→ `source`（登记的“策略来源”叙述者的有效 trait，可以是任意叙述者）→ `narrator`（自身）（`lib/trait-layers.ts:TRAIT_LAYERS`）。
- 三种合并类型，每种 trait 声明自己属于哪一种：
  - `restriction`（禁用工具、屏蔽技能）：累加并集；非 enforced 的高层声明按自己给的完整集合替换，但低层标 enforced 的条目一律保留（`mergeRestrictionTrait`）。
  - `grant`（子代理模型池）：白名单只能向上收窄，高层声明与累计上界取交集，enforced 层把上界钉住（`mergeGrantTrait`）。
  - `preference`（设备注入等）：最近的显式值胜出，`inherit` 向下穿透（`mergeToggleTrait`、`mergeValueTrait`、`mergeToggleMapTrait`）。
- enforced 标记以单独的 `custom-enforced:` trait 存（按 trait key：`disabledTools` / `blockedSkills` / `subagentModels`），不改变三种载荷格式；`source` 层没有自己的标记，它的限制与授权一律视为边界（`lib/trait-resolution.ts`）。
- 解析结果是“拍平”的 traits 数组：已有调用点仍把 `narrator.traits` 换成 `resolved.traits` 传给 `getDisabledToolSet` / `getBlockedSkills` / `resolveEffectiveSubagentModelPolicy`，上层为空时与叙述者自身 trait 逐字节一致；enforced 信息随 `enforced` 字段另给，写路径据此提前拒绝无效编辑（`canRelaxRestriction`、`canExtendGrant`）。
- 加载与缓存：`trait-layer-service.ts:resolveEffectiveTraits` 并行读项目层、用户层与策略来源；项目层/用户层读失败时降级为只用叙述者自身 trait（记 debug），策略来源层永远严格——读不到、成环（`Policy source cycle detected`）或链过深（`MAX_POLICY_SOURCE_DEPTH`）都抛错而不是丢掉边界。两个上层各有 5 秒 TTL 缓存（最多 500 项），写入会显式失效。
- 能力上限 `custom-runtime-policy:`：不在 trait 合并里处理，各层条目原样带过，由 `resolveNarratorRuntimePolicy` / `resolveNarratorCapabilities`（严格模式，任何一层读不到就失败，绝不当作“没有上限”）交给 `agent-runtime/policy.ts` 做保序无关的只收窄合并。载荷字段（`version: 1`）：`tools`、`mcp`（none / readOnly / nonDenied）、`mcpNames`、`readOnly`、`searchOnly`、`readOnlyGitShell`、`deny`（`spawnAgent`、`watchAgent`、`awaitAgent`、`askUserQuestion`、`planApproval`、`stopHooks`、`switchWorkingDirectory`；旧的 `sendAwait` 读后丢弃）、`delegationDepth`（1–16，取最深）、`continuation`（`promoteTodo`、`maxPasses`）。无法解析的条目抛错，不静默当作没有（`lib/runtime-policy-trait.ts`）。
- 设备注入是偏好型：模式 `none` / `private` / `global`（默认）/ `all` 加逐设备 `on` / `off` 覆盖（最多 200 项，设备 ID ≤ 64 字符）；授权与注入是两件事——最终注入集合永远是授权集合的子集，且设备必须在线；显式 `on`/`off` 双向压过模式；无范围信息的旧设备按项目范围处理（`lib/device-injection-trait.ts:resolveInjectedDevices`）。
- 编辑上层：`/api/trait-layers/:layer/:ownerId`（`layer` 只能是 `user` 或 `project`），GET 读取，`PUT`/`DELETE` 分别作用于 `disabled-tools`、`blocked-skills`、`subagent-model-restriction`、`device-injection`；项目层需要管理员，用户层本人或管理员；JSON 体无效返回 400；写入在该层自己的锁内进行，完成后失效缓存并发 `trait-layer:changed` 事件（`routes/trait-layers.ts`、`trait-layer-service.ts:updateLayerTraits`）。叙述者自身层的编辑走 `/api/narrators/:id/custom-traits/*`，用同一套载荷。
- 前端：`TraitLayerEditor` 是项目设置与全局 Agent 设置共用的上层编辑器，enforced 与默认用显式开关区分，设备注入三态（inherit ≠ off）；`lib/api/trait-layers.ts` 是客户端。

## 从哪读起
- `server/lib/trait-layers.ts`：合并代数（纯函数）。
- `server/lib/trait-resolution.ts`：把代数绑定到具体编码 trait，产出拍平数组。
- `server/services/trait-layer-service.ts`：I/O、缓存、策略来源链。
- 测试：`server/lib/__tests__/trait-layers.test.ts`、`trait-resolution.test.ts`、`runtime-policy-trait.test.ts`、`device-injection-trait.test.ts`，`server/services/__tests__/trait-layer-integration.test.ts`，`server/routes/__tests__/trait-layers.test.ts`。

## 改它时
- 新增一种可分层的 trait：先在 `trait-layers.ts` 里选合并类型（restriction / grant / preference），在 `trait-resolution.ts` 的 `LayeredTraitKey`、`parseEnforcedKeys` / `withEnforcedKeys` 与拍平逻辑里登记，`narrator-custom-traits.ts` 加前缀与解析；再补 `routes/trait-layers.ts` 的 PUT/DELETE、叙述者侧 `custom-traits` 路由、前端编辑器与 `lib/api/trait-layers.ts` 类型。
- 新增运行时能力键：加进 `runtime-policy-trait.ts` 的 `CAPABILITY_KEYS`，并在 `agent-runtime/policy.ts` 合并与各消费点（拒绝路径）使用；能力上限读失败必须失败而不是放行。
- 新增身份/状态 trait：加进 `narrator-utils.ts:NarratorTrait`，并检查 `forkTraits`（分叉是否继承）、导入与前端展示。
- 不变量：低层 enforced 的限制高层不能移除；grant 只能收窄；注入不能成为授权的提权通道；策略来源层读不到就失败。
- 守卫：`trait-layers.test.ts`、`trait-resolution.test.ts` 钉住合并语义，`trait-layer-integration.test.ts` 钉住端到端解析，`runtime-policy-trait.test.ts` 钉住载荷校验。

## 相关
- [Bot](bot.md)：`bot` trait 与运行时上限
- [分叉与前缀快照](fork.md)：分叉时的 trait 处理
