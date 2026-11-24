---
id: narrator.lifecycle
title: 会话生命周期
summary: 创建、运行、停止、归档；narrator-service 的拆分（session/executor/subagent/context/prompt/title/recovery/event-handler）。
anchors:
  - server/services/narrator-service.ts
  - server/services/narrator-session.ts
  - server/services/narrator-executor.ts
  - server/services/narrator-control.ts
  - server/services/narrator-archive.ts
  - server/services/narrator-session-state.ts
  - server/services/narrator-event-handler.ts
  - server/services/narrator-subagent.ts
  - server/services/workspace-context-service.ts
  - server/db/schema.ts
  - frontend/hooks/useNamedNarrator.ts
  - frontend/hooks/useNarrator.ts
  - frontend/hooks/useNarratorReadable.ts
  - frontend/hooks/useWorkspaceContext.ts
  - frontend/lib/agent-reference-store.ts
  - frontend/lib/api/narrators.ts
  - frontend/lib/api/workspace-context.ts
  - frontend/routes/narrators/
  - frontend/types/narrator.ts
  - server/lib/narrator-utils.ts
  - server/lib/validators/manual-narrator-resources.ts
  - server/lib/validators/narrators.ts
  - server/services/command-service.ts
  - server/services/narrator-composer-document.ts
  - server/services/narrator-cwd.ts
  - server/services/narrator-draft-service.ts
  - server/services/narrator-fast-mode.ts
  - server/services/narrator-navigation-summary.ts
  - server/services/narrator-panel-state.ts
  - server/services/narrator-title.ts
  - server/services/standalone-narrator-cwd.ts
  - shared/narrator-handle.ts
  - shared/narrator-limits.ts
  - server/routes/narrator-workspace-context.ts
  - shared/workspace-context.ts
  - shared/workspace-directories.ts
keywords:
  - narrators
  - narrators.status
  - idle working waiting archived
  - acceptUserMessage
  - ActiveNarrator
  - block_complete
  - persistContentCheckpoint
  - WORKSPACE_CONTEXT_CONFLICT
  - WORKSPACE_CONTEXT_BUSY
  - /api/narrators/:id/panel-state
  - /api/narrators/:id/draft
  - /api/narrators/:id/handle
  - /api/narrators/:id/fast-mode
  - /api/narrators/:id/background-tasks
  - narrator_drafts
  - 命名叙述者
  - "@handle"
  - 快速模式
  - 会话标题
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 会话生命周期

叙述者一行记录在 `narrators` 表；状态只有四种：`idle / working / waiting / archived`（`server/db/schema.ts` narrators.status 枚举）。创建、状态写入在 `narrator-service`，运行一轮在 `narrator-session`，单次 agent loop 的事件消费在 `narrator-executor`。

## 关键规则
- 创建：`narratorService.create` 先 `prepareNarratorCreation` 组装行（校验 handle、项目、工作区、traits，`kind` 为 knowledge/setup/bot 时预装对应工具/提示词），再由 `createPreparedNarratorInTransaction` 在同一事务里同步断言并插入，提交后 `publishNarratorCreated` 做事件副作用（`narrator-service.ts`）。
- 运行入口 `narrator-session.ts:acceptUserMessage`：先在 `withNarratorStartAdmission`（按叙述者串行）内把输入写进缓冲邮箱 `enqueueBufferedMessage`（满则 `ValidationError("Message queue is full")`）；空闲则 `claimInboxHead` 认领并 `feedMessageUnlocked` 立即起跑，忙则按 `queueMode`（turn / tool / interrupt）排队、软停或紧急插入。
- `feedMessageUnlocked` 把状态置为 `working`（`updateStatus(..., "working", { setTurnStart })`），`ensureNarrator` 懒创建内存中的 `ActiveNarrator`（`activeNarrators` 表），同一叙述者的重建用 `narratorCreationLocks` 去重。
- 一轮执行：`runAgentLoop` → `narrator-executor.ts:executeAgentLoop`，它把 `agentLoop` 事件交给 `narrator-event-handler.ts:processEvent` 落库/广播，并把结果归类（上下文超长、可重试错误、余额不足、模型不可用、中断、最大轮数等）返回给 session 层决定重试、压缩或收尾。`executeAgentLoop` 的调用点在 `agent-runtime/orchestrator.ts:runAgentLoopUnlocked`，位于 `while (active.alive && owner.isCurrent())` 循环内（已核对）；子代理是否只跑一次、走不走这条路径：未核实。
- 运行失败兜底：仍处 working/waiting 的叙述者被置回 `idle` 并带 `substatus: ["error"]`（`reportUnsettledRunLoopError`）。
- 控制：叙述者对另一叙述者的 stop / steer / archive 必须持有目标登记的 controller 授权，且调用方上限允许编排、未到最大委派深度、其执行用户当前对目标有写权限；用户正接管（run hold）时 stop/archive 被拒（`narrator-control.ts:authorizeAgentControl`）。人通过 HTTP 的操作走普通写 ACL，不经此处。
- 归档：`narrator-archive.ts:transitionNarratorArchiveGroup` 对父会话和满足条件的“顺带提问”子会话（`isAskInPassing`，最多 200 个，超出报错）成组切换 `archived` / `idle`。先做运行时取消（`prepareNarratorArchive`），再在单个事务内改状态，仅提交后才发 `narrator:status_changed` 和 WS `status_change`；归档子会话记 `archivedWithNarratorId`，只有它们会随父会话一起恢复。
- 工作目录上下文：`workspaceContextService`（`workspace-context-service.ts`）管叙述者的工作目录与设备目录映射，修订号存 `narrators.workspaceRevision`；`withRevision` 在变更准入内比对修订号，变了报 `WORKSPACE_CONTEXT_CONFLICT`，忙碌报 `WORKSPACE_CONTEXT_BUSY`；`switch` 仅限 primary 且无 `background` 特征、非知识管家的叙述者，HTTP 来源在运行/等待中被拒，agent 来源不受此限（`supportsDirectorySwitch`、`switch`）。它不读写 `workspaces` 面板表，面板见[工作区布局](workspaces.md)。
- 文本/推理块的落库点是 `block_complete`，不是流式增量：`narrator-event-handler.ts:processEvent` 的 `stream_text` 分支只更新内存快照并广播 `stream_event`；`block_complete` 分支先 `openStep` 保证存在部分消息，再经 `persistContentCheckpoint`（调用 `narratorStore.writeStepItem`）写入 text / reasoning 块。`narrator-executor.ts:executeAgentLoop` 里“文本块不在流式期间增量落库、只在内存里等到回合末”的注释已过时，以此为准。
- 中断后的排空：`config.signal` 已 abort 时，executor 仍继续处理 `tool_result`、`block_complete`、`error` 三类事件，其余事件丢弃（`narrator-executor.ts:executeAgentLoop`）；`block_complete` / `assistant_message` 处理抛错则升级为 `CriticalEventPersistenceError` 中止循环，其他事件只记日志（`tool_result` 失败另向前端发 `warning`）。
- 标题：首条用户消息先 `setProvisionalTitleFromUserMessage`（首句，超过 50 字符截成 49 加 `…`）写占位标题；再由摘要模型 `generateQuickTitle`（输入截 500 字符）或 `generateTitle`（首 1 条加末 6 条消息）生成，各 30 秒超时，引号去掉、超 80 字符截 50；均经 `persistTitle` 写库并发 WS `title_updated` 和事件 `narrator:title_updated`。生成失败只记日志不抛（`narrator-title.ts`）。
- 命名叙述者 handle：2–32 个码点，Unicode 字母/数字/`_`/`-`，首字符须是字母或数字；保留输入大小写，唯一性与匹配用 `foldHandle`（NFC + 小写）（`shared/narrator-handle.ts`、`validators/narrators.ts:narratorHandleSchema`）。路由 `GET /api/narrators/named`、`GET /by-handle/:handle`、`PATCH /:id/handle`；前端 `useNamedNarrators`、`useUpdateNarratorHandle`。
- 工作目录解析：`resolveNarratorSessionCwd` 取 `narrator.cwd`，缺则项目 git 路径，再缺则调用方给的兜底；无目录且无 `standalone` 特征的旧“章节会话”由 `isFormerChapterSessionWithoutDirectory` 识别，调用方须让用户选目录（`WORKSPACE_DIRECTORY_REQUIRED`），不得静默落到 home（`narrator-cwd.ts`）。独立会话创建没传目录时，只在 `settings.paths.defaultProjectDir` 指向已存在目录时采用，否则返回 `required`，不创建目录（`standalone-narrator-cwd.ts`）。
- 快速模式：`narrators.fastModeOverride` 三态 inherit / on / off；`inherit` 时子代理跟随根 primary，primary 取当前执行主体或持久化主体的 `userPreferences.fastModeDefault`；结果带 `fastModeSource`（override / primary / user-default / unavailable）。解析器带有界缓存，依赖变化即作废重算，超时 30 秒（`narrator-fast-mode.ts:createNarratorFastModeResolver`；`PATCH /api/narrators/:id/fast-mode`）。
- 面板状态与草稿：`GET /:id/panel-state` 返回待决权限、缓冲邮箱与草稿元数据，权限页/缓冲页用 cursor，整体 4 MiB 字节预算，超过 250ms 记慢日志（`narrator-panel-state.ts:getNarratorPanelState`）。草稿按（用户, 叙述者）一行存 `narrator_drafts`，后写者胜；被覆盖的上一版放进单个撤销槽，`restoreNarratorDraftPrevious` 与当前版对调（`narrator-draft-service.ts`；`GET/PUT /:id/draft`、`POST /:id/draft/restore`；文本上限 `shared/narrator-limits.ts:MAX_NARRATOR_DRAFT_CHARS` = 200000）。历史消息的撰写文档由 `readCommittedComposerDocument` 经读 worker 读取，且须校验消息仍是该叙述者当前用户消息的当前修订（`GET /:id/messages/:mid/composer-document`）。
- 导航摘要 `getNarratorNavigationSummary`：子代理/`modeltrace` 会话回溯父会话，只在调用者有读权限时返回父标题，并给出可读的项目 ID，要求 worker 读（`narrator-navigation-summary.ts`）。
- 手动资源：`POST /api/narrators/:id/background-tasks`（command ≤ 8192 字符、timeoutMs ≤ 24h）与 `/browser-sessions`（仅 http(s)、不含内嵌凭据、ttlMs ≤ 24h）；请求体上限 64 KiB（`validators/manual-narrator-resources.ts`、`routes/narrator-manual-resources.ts`）。
- 工作目录上下文的接口与类型：`GET /api/narrators/:id/workspace-context`、`POST /:id/workspace-context/switch`（请求体 ≤ 16 KiB，带 `expectedRevision`、`requestId`、`target: {deviceId, cwd}`），旧的 `PATCH /:id/cwd` 走同一条准入/比对/安装路径；目标设备必须是 `local` 或该叙述者工具实际被授权的设备，slug 先解析为规范设备 ID 再保存（`routes/narrator-workspace-context.ts`）。叙述者每台执行设备各记一个目录（`deviceId → {cwd, pathFlavor}`，路径语法按记录时的 flavor 判断，不按宿主 OS 推断），`narrators.cwd`/`defaultDeviceId` 仍表示当前生效值；这些类型前后端共用，不依赖 `node:path`（`shared/workspace-context.ts`、`shared/workspace-directories.ts`）。注意它与界面面板布局的“工作区”无关，事件也不同（`workspace_context_changed` 对 `workspace_changed`）。
- 所属项目、权限等不在此展开，见各自节点。

## 从哪读起
- `server/services/narrator-service.ts:narratorService`（CRUD 与状态）、`prepareNarratorCreation`。
- `server/services/narrator-session.ts:acceptUserMessage`、`feedMessageUnlocked`、`ensureNarrator`。
- `server/services/narrator-executor.ts:executeAgentLoop`。
- 测试：`server/services/__tests__/narrator-session-loop.test.ts`、`narrator-executor.test.ts`。

- 前端：`hooks/useNarrator.ts`（列表/分页/详情及文件树状态、回退预览等 hooks）、`lib/api/narrators.ts`（API 客户端）、`routes/narrators/`（`$narratorId`、`archived`、`index`、`workspace`）、`types/narrator.ts`（待决权限与异步提问类型）、`lib/agent-reference-store.ts`（按 WS 订阅的 agent 引用状态 unknown/unavailable/ready）、`hooks/useNarratorReadable.ts`（能否打开某会话，沿用 `useNarrator` 的请求与缓存）。
- `narrator-session-state.ts`：`ActiveNarrator` 与缓冲邮箱/待决权限等内存状态类型；`narrator-subagent.ts` 只是子代理模块（alias/team/executor/runner/tools）的再导出桶。

## 改它时
- 新增 `narrators.status` 取值：`server/db/schema.ts` 枚举、`frontend/types/narrator.ts`、状态广播与前端筛选都要同步；改 schema 另须按 CLAUDE.md 生成迁移并核对 `data-portability` 导入导出。
- 新增 HTTP 控制面（stop/steer/archive 等）：人走普通写 ACL，agent 间调用必须经 `narrator-control.ts:authorizeAgentControl`，不要绕过 controller 授权。
- 改落库时机（`processEvent` 的 `block_complete` 分支）：`narrator-history-writers.guard.test.ts` 要求只有登记过的模块能直接写历史表，事件流的写入须经 store；`narrator-interrupt-task-guard.test.ts` 与 `streamed-content-publication.test.ts` 覆盖中断后的内容保留与发布。
- 改归档/工作目录上下文：`workspace-context-persistence.test.ts` 覆盖修订号与冲突；归档事件只在事务提交后发。
- 其他：先读 `narrator-session-loop.test.ts`、`narrator-executor.test.ts`。

## 相关
- [消息存储](messages.md)
- [中断与恢复](recovery.md)
- [提示词与注入](prompts.md)
- [会话运行时](runtime/index.md)：`agent-runtime/` 的调度、收件箱、发布与模型历史
