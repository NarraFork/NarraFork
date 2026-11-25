---
id: flows.file-change
title: 一次文件修改与回退
summary: 工具写文件、写队列与变更证据、在界面里看到改动、回退时怎么恢复。
anchors:
  - server/lib/agent/tools/write.ts
  - server/lib/agent/tools/edit.ts
  - server/lib/agent/tools/track-file-change.ts
  - server/services/file-change-runtime.ts
  - server/services/file-write-queue.ts
  - server/services/file-attribution-service.ts
  - server/services/narrator-scoped-revert.ts
  - server/services/revert-planner-local-access.ts
  - server/services/revert-transaction-service.ts
  - server/routes/git.ts
keywords:
  - 改动归属
  - 回退文件
  - revert-plans
  - file_busy
  - queue_full
  - historyStatus
  - fileChangeEvidence
  - 撤销修改
  - modifications
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 一次文件修改与回退

Write / Edit 等工具改文件，写入被记录为"实际发生了什么"，界面能看到改动，用户之后可以预览并回退。工具调用本身的前半段见 [一次工具调用](tool-call.md)。

## 路径
1. 工具入口：`tools/write.ts` / `tools/edit.ts` 的 `execute`：`getToolBackend` 选后端，解析路径（`spec://` 虚拟文件走 `specVfsService.writeSpecFile`，不在本流程内）。见 [文件工具](../agent/tools/file-tools.md)。
2. 分支，本机后端：`file-change-runtime.ts:executeLocalFileChange` → `LocalFileChangeRuntime.execute`，校验工具调用绑定（重放同一调用抛 `FileRequestReplayError`），解析目标身份。见 [文件写入与变更记录](../files/write-queue.md)。
3. 分支，远程设备：`executeLocalFileChange` 对非本机后端返回 `undefined`，工具回到自己的路径：`withFileWrite` 排队 → 读旧内容 → `ensureFileSnapshot`（有界的历史快照，失败不挡写）→ `backend.mkdirp` 与写 → 结果带 `historyStatus`。这条路不写证据和 effect 行，历史只有 `file-snapshot-service.ts:ensureFileSnapshot` 写的 `narrator_file_snapshots` 一行，`fileChangeEvidence.grade` 为 `legacy_unverified`；之后跳过步骤 4–6。
4. 进写队列：运行时在 `withFileWrite({ deviceId, pathFlavor, canonicalPath })` 内串行同一文件；等待超时报 `file_busy`，等待者过多报 `queue_full`。
5. 队列内：`assertBinding`（重新校验授权与最终执行权限）→ 采集写入足迹 → 读写前状态 → 工具给的 `construct(before)` 算出新字节与行统计 → `applyLocalFileChange` 落盘，写后再读状态；落盘结果为 `applied | not_applied | conflict | unknown`。
6. 队列释放后记证据（只有本机后端走到这里）：`FileChangeEvidenceService` 的 `beginOperation` → `recordEffect` → `finishOperation`，写的是 scope / operation / effect 元数据行，前后内容记为 `unknown/history_unavailable`，**不发布内容 blob**（`historyEnabled=false`；`file-change-runtime.test.ts` 有对应测试）。历史状态为 `disabled`，历史准备超过 1500ms 只会让历史变 `unavailable`，不影响写入结果。内容 blob 只在远程设备的编辑器保存（`executeEditorFileChange` 且 `request.remote`）时发布。见 [文件变更证据](../files/change-evidence.md)。
7. 归因：工具调用 `track-file-change.ts:trackFileChange`，子代理记团队改动、查询与其他会话任务的重叠并把提示附在结果后；证据已记录则不重复记归因，否则 `recordAttribution` 写 `file_attributions`。该步失败不让写入失败。
8. 结果：工具把 `linesAdded / linesRemoved` 放进结果 metadata，随 `tool_result` 落库并广播（[一次工具调用](tool-call.md) 步骤 12）。
9. 界面里看到：工具卡片按 metadata 显示差异；Git 面板经 `routes/git.ts` 的 `/modifications` 读归属视图 `getWorkspaceModificationView`（历史观测，不是净差异）。见 [工具卡片](../frontend/narrator-ui/tool-cards.md)。
10. 回退预览：前端调 `POST /api/narrators/:id/revert-action-preview` 或 `/revert-plans`，`revert-planner-local-access.ts` 生成并持久化计划，返回受影响文件；计划 10 分钟过期。见 [回退与文件历史](../files/revert.md)。
11. 回退确认：`POST /:id/revert-plans/:planId/apply` → `applyLocalRevertPlan`：校验计划与动作一致，`acquireNarratorRevertAdmission`（有运行中的工具调用等会阻塞），再交 `RevertTransactionService.execute`。
12. 逐文件恢复：事务逐文件在 `withFileWrite` 里恢复，结果 `applied | unchanged | conflict | failed | unknown | not_attempted`，部分成功保留，不整体回滚。
13. 分支，全部文件校验通过：`commitHistory` 改写消息历史（写时复制），路由返回结果；分支，未全部通过：历史不提交，路由对未 `committed` 的结果返回 409 `REVERT_APPLY_NOT_COMMITTED`，已测得的文件结果保留。
14. 分支，设备未启用文件历史：只能改消息（`skipRevert`），显式要求恢复文件报 409 `FILE_HISTORY_DISABLED`。

## 改它时
- 新增一个会写文件的工具：同一个工具两条路都要有，像 `write.ts`、`edit.ts`、StructSed 一样——本机走 `executeLocalFileChange`，远程走 `withFileWrite` + `ensureFileSnapshot`；不能直接 `fs` 写；还要 `trackFileChange`、结果 metadata 里放行统计、权限分类里把它放进写工具集合（见 [一次工具调用](tool-call.md)）、前端卡片的差异展示，以及 `FileChangeToolName` 类型。
- 改写入结果或历史状态的枚举：`shared/file-change-protocol.ts`、`file-change-apply-result.ts`、证据表、回退对 `unknown` 的处理要一起看。
- 改队列限额：`file-write-queue.ts` 的限额也被回退事务与编辑器保存共用。
- 改回退的范围或动作：`narrator-scoped-revert.ts`（选择）、`revert-plan-service.ts`（计划）、`revert-transaction-service.ts`（执行）、`revert-history-commit.ts`（消息改写）与前端回退预览一起改。
- 编辑器保存走 `executeEditorFileChange`（入口有分块上传提交，也有 `/api/fs/write` 路由），同样经过写队列与证据：本机只写元数据、不存内容；远程设备才发布内容 blob。见 [编辑器文档](../files/editor.md)。

## 相关
- [文件与编辑](../files/index.md)
- [一次工具调用](tool-call.md)
- 「未核实」：步骤 9 中前端工具卡片读取行统计 metadata 的具体组件没有逐个追到；Git 面板读取 `/modifications` 的前端组件也未追到。
