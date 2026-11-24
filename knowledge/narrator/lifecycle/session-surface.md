---
id: narrator.lifecycle.session-surface
title: 会话外观与状态
summary: 标题、别名、快捷模式、草稿与输入框文档、面板状态、手动资源。
anchors:
  - server/services/narrator-title.ts
  - server/services/narrator-fast-mode.ts
  - server/services/narrator-draft-service.ts
  - server/services/narrator-composer-document.ts
  - server/services/narrator-panel-state.ts
  - server/services/narrator-navigation-summary.ts
  - server/lib/validators/manual-narrator-resources.ts
  - server/lib/validators/narrators.ts
  - shared/narrator-handle.ts
  - shared/narrator-limits.ts
  - frontend/hooks/useNamedNarrator.ts
  - server/routes/narrator-manual-resources.ts
keywords:
  - /api/narrators/:id/panel-state
  - /api/narrators/:id/draft
  - /api/narrators/:id/handle
  - /api/narrators/:id/fast-mode
  - /api/narrators/:id/background-tasks
  - /api/narrators/:id/browser-sessions
  - /api/narrators/named
  - narrator_drafts
  - 命名叙述者
  - "@handle"
  - foldHandle
  - narratorHandleSchema
  - 快速模式
  - fastModeOverride
  - fastModeSource
  - 会话标题
  - title_updated
  - generateQuickTitle
  - setProvisionalTitleFromUserMessage
  - MAX_NARRATOR_DRAFT_CHARS
  - getNarratorNavigationSummary
status: draft
verified_at: 878917e97
---
# 会话外观与状态

不影响一轮怎么跑、但用户天天看到的会话属性：标题、`@handle`、快速模式、输入框草稿与撰写文档、面板状态、导航摘要，以及手动创建的后台任务/浏览器会话。

## 关键规则
- 标题：首条用户消息先 `setProvisionalTitleFromUserMessage`（首句，超过 50 字符截成 49 加 `…`）写占位标题；再由摘要模型 `generateQuickTitle`（输入截 500 字符）或 `generateTitle`（首 1 条加末 6 条消息）生成，各 30 秒超时，引号去掉、超 80 字符截 50；均经 `persistTitle` 写库并发 WS `title_updated` 和事件 `narrator:title_updated`。生成失败只记日志不抛（`narrator-title.ts`）。
- 命名叙述者 handle：2–32 个码点，Unicode 字母/数字/`_`/`-`，首字符须是字母或数字；保留输入大小写，唯一性与匹配用 `foldHandle`（NFC + 小写）（`shared/narrator-handle.ts`、`validators/narrators.ts:narratorHandleSchema`）。路由 `GET /api/narrators/named`、`GET /by-handle/:handle`、`PATCH /:id/handle`；前端 `useNamedNarrators`、`useUpdateNarratorHandle`。
- 快速模式：`narrators.fastModeOverride` 三态 inherit / on / off；`inherit` 时子代理跟随根 primary，primary 取当前执行主体或持久化主体的 `userPreferences.fastModeDefault`；结果带 `fastModeSource`（override / primary / user-default / unavailable）。解析器带有界缓存，依赖变化即作废重算，超时 30 秒（`narrator-fast-mode.ts:createNarratorFastModeResolver`；`PATCH /api/narrators/:id/fast-mode`）。
- 面板状态：`GET /:id/panel-state` 返回待决权限、缓冲邮箱与草稿元数据，权限页/缓冲页用 cursor，整体 4 MiB 字节预算，ExitPlanMode 的待决权限项带 `planReflectionAvailable`（`isPendingPlanReflectionAvailable`，内存态，重启后不存在），超过 250ms 记慢日志（`narrator-panel-state.ts:getNarratorPanelState`）。
- 草稿：按（用户, 叙述者）一行存 `narrator_drafts`，后写者胜；被覆盖的上一版放进单个撤销槽，`restoreNarratorDraftPrevious` 与当前版对调（`narrator-draft-service.ts`；`GET/PUT /:id/draft`、`POST /:id/draft/restore`；文本上限 `shared/narrator-limits.ts:MAX_NARRATOR_DRAFT_CHARS` = 200000）。
- 撰写文档：历史消息的撰写文档由 `readCommittedComposerDocument` 经读 worker 读取，且须校验消息仍是该叙述者当前用户消息的当前修订（`GET /:id/messages/:mid/composer-document`）。
- 导航摘要 `getNarratorNavigationSummary`：子代理/`modeltrace` 会话回溯父会话，只在调用者有读权限时返回父标题，并给出可读的项目 ID，要求 worker 读（`narrator-navigation-summary.ts`）。
- 手动资源：`POST /api/narrators/:id/background-tasks`（command ≤ 8192 字符、timeoutMs ≤ 24h）与 `/browser-sessions`（仅 http(s)、不含内嵌凭据、ttlMs ≤ 24h）；请求体上限 64 KiB（`validators/manual-narrator-resources.ts`、`routes/narrator-manual-resources.ts`）。

## 从哪读起
- `narrator-title.ts`（标题生成与持久化）、`narrator-draft-service.ts`、`narrator-panel-state.ts`。
- `narrator-fast-mode.ts:createNarratorFastModeResolver`。
- 测试：`server/services/__tests__/narrator-drafts.test.ts`、`server/routes/narrator-manual-resources.test.ts`、`narrator-panel-state.test.ts`、`narrator-fast-mode.test.ts`（另有 `-events`、`-principal-pg`、`-publication-pg` 变体）。

## 改它时
- 改 handle 规则：`shared/narrator-handle.ts` 与 `validators/narrators.ts` 的 schema 须一致；唯一性比较一律用 `foldHandle`，不要直接比原文。
- 改快速模式来源：`fastModeSource` 取值前端有对应展示；`narrator-fast-mode*.test.ts` 覆盖事件与 PG 下的主体解析。
- 改草稿/面板状态的读取：保持字节预算与 worker 读取（后端主线程性能规则）；`narrator-drafts.test.ts`、`narrator-panel-state.test.ts` 会拦。
- 新增手动资源类型：同改校验器的上限（命令长度、超时、TTL）与路由请求体 64 KiB 限制。
- 改标题策略：占位与最终标题的写入都要经 `persistTitle`，才会发 `title_updated`。

## 相关
- [会话生命周期](index.md)
- [执行工作区](workspace-context.md)
