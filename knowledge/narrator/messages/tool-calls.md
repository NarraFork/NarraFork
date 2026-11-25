---
id: narrator.messages.tool-calls
title: 工具调用记录
summary: narrator_tool_calls 行：输入输出、执行与审批状态字段、耗时与成本。
anchors:
  - server/services/narrator-tool-detail.ts
  - server/services/narrator-surface-reads.ts
keywords:
  - narrator_tool_calls
  - /api/narrators/:id/tool-calls/:toolUseId
  - TOOL_CALL_DETAIL_TOO_LARGE
  - TOOL_CALL_DETAIL_SELECTION_REQUIRED
  - toolUseId
  - modelRevision
  - executionAttempt
  - executionDeviceId
  - executionCwd
  - permissionDecidedBy
  - isFileHistoryCheckpoint
  - treeHashBefore
  - ownedPathsJson
  - costStatus
  - startedAt
  - isInternal
  - readCommittedToolDetail
  - 工具调用详情
status: draft
verified_at: 776dbf07e
---
# 工具调用记录

`narrator_tool_calls` 每次工具调用一行，同时承担权限审批状态，没有独立的权限请求表。一个 `toolUseId` 可有多次执行尝试（`executionAttempt`）。

## 关键规则
- 身份与载荷：`toolUseId`、`toolName`、`inputJson` / `outputJson` 及字符数 `inputChars` / `outputChars`；`modelRevision` 在输入/输出/状态/尝试顺序变化时事务内递增（`schema.ts:narratorToolCalls`）。
- 执行目标：`executionDeviceId`（`local` 或 remote_devices.id，旧行为 null）、`executionCwd`、`executionPathFlavor`（posix/windows/spec）在权限与执行前冻结；`executionTargetsJson` 存完整执行计划，`deviceSelectionSource` 为 explicit / session_default / local_default；`resolvedFilePath` 是兼容投影，`canonicalFilePath` 才是规范身份。
- 状态：`status` 为 initializing（默认）/ pending / running / success / fail。审批字段：`permissionDecidedBy`、`permissionDecidedAt`、`permissionDenyMessage`、`permissionDecisionReason`、`permissionSuggestions`。
- 耗时：`streamStartedAt`、`streamCompletedAt`、`permissionStartedAt`、`executionStartedAt`、`completedAt`、`durationMs`；`startedAt` 是虚拟生成列，取 `execution_started_at → permission_started_at → stream_started_at → created_at` 中第一个非空值，供全局执行日志用 `(startedAt, id)` 键集分页（`idx_toolcalls_started_at`）。
- 成本：各类 token 数与 `inputCost` / `outputCost` / `cacheCreationCost` / `cacheReadCost` / `totalCost`（USD），`costStatus` 为 complete / partial / unknown，缺失字段记在 `costMissingFields`；`provider`、`model` 记来源。
- 其他列：`isBackground`；`executionIdentityVersion` 为 0 表示旧行/未验证；`executionOriginToolCallId` 标记 COW 历史克隆（不是可执行尝试）；`fileChangeOperationId` 关联文件变更操作；`isFileHistoryCheckpoint` 标记隐藏的文件历史检查点克隆；`treeHashBefore` / `treeHashAfter` 是调用前后工作树哈希（非 git、远程设备或旧行为 null）；`ownedPathsJson` 是本调用被证明自己改动的路径（null 表示旧行，空数组表示确实什么都没改）；`resultMessageId` 绑定子代理结果消息；`blockId` 指向它执行的工具块（新的非内部行必填，旧行 null），`isInternal`（`internal_read_` 一类）从不成块。
- 详情接口：`GET /api/narrators/:id/tool-calls/:toolUseId` 经 worker 读快照；引用必须是 ≤128 字符的 ID，选择有歧义 `TOOL_CALL_DETAIL_SELECTION_REQUIRED`（409），超过载荷上限 `TOOL_CALL_DETAIL_TOO_LARGE`（413）；读后重新鉴权并核对仍是当前版本（`narrator-tool-detail.ts:readCommittedToolDetail`）。
- 面板类读取共用 `narrator-surface-reads.ts` 的预算：最长 30 秒、必须 worker 执行。
- 列表/摘要不读 `inputJson` / `outputJson`；上下文分页的索引（`idx_toolcalls_context_id`）刻意带上字符数列，避免为取长度打开大 JSON。

## 从哪读起
- `server/db/schema.ts:narratorToolCalls`（列与索引注释）。
- `server/services/narrator-tool-detail.ts`（详情读取与校验）。
- 测试：`tool-call-detail-safety.test.ts`、`tool-call-binding.test.ts`、`tool-call-payload-retention.test.ts`（均在 `server/services/__tests__/`）。

## 改它时
- 新增列：改 `schema.ts` 后生成迁移，并同步 `data-portability.ts`（`narrator_tool_calls` 在导入拷贝范围内，NOT NULL 无默认值的列会让旧快照导入失败）。
- 改详情读取：保持 ID 长度、选择歧义、载荷上限与读后重新鉴权；`tool-call-detail-safety.test.ts` 会拦。
- 改块绑定（`blockId`）：`tool-call-binding.test.ts`；COW/分叉克隆时要重映射到克隆出的块。
- 改载荷保留：`tool-call-payload-retention.test.ts`。
- 写工具调用行：只能经 `narratorStore.settleTool` 等写入口，见 [消息与引用](refs-paging.md)。

## 相关
- [消息存储](index.md)
- [块存储](blocks.md)
