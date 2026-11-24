---
id: files.editor
title: 编辑器文档
summary: 编辑器文档服务、Worker、远程持久化。
anchors:
  - server/services/editor-document-service.ts
  - server/services/editor-document-jobs.ts
  - server/services/editor-document-worker.ts
  - server/services/editor-document-streams.ts
  - server/services/editor-document-runtime.ts
  - server/services/editor-file-atomic-io.ts
  - server/services/editor-draft-anchor-store.ts
  - server/routes/editor-documents.ts
  - shared/editor-document.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 编辑器文档

在前端编辑器里打开、修改并保存文件的服务端。文档是“会话”，保存走分块上传 → 封存 → 提交，最终由文件变更运行时落盘，所以和工具写入一样受单文件队列与证据记录约束。

## 关键规则
- 路由挂在 `/api/narrators` 下（`app.ts`）：`/capabilities`、`/info`、`/page`、`/archive`、草稿锚点 `/draft-anchors`、创建文档、`/:docId/raw-reads`、`/content`、`/uploads`（`PUT .../chunks/:seq`、`/seal`、`/commit`、`DELETE`）（`routes/editor-documents.ts`）。
- 编码、解码、哈希在 Worker 线程里做，任务队列满返回 429 `EDITOR_BUSY`，超时 408；Worker 不可用不会回退主线程（`editor-document-jobs.ts` 的 `EditorDocumentJobs`/`admissionError`，另有 `editor-document-stream-worker.ts` 处理原始流）。
- 限额（`shared/editor-document.ts`）：文件 20MiB，传输 64MiB，元数据 32KiB，会话空闲 10 分钟，上传空闲 10s，IO 超时 30s，每会话 32 个上传，全局会话 16384（每用户 4096），并发操作 1024（每用户 128），临时空间每用户 512MiB、全局 2GiB。
- 保存带基线哈希：磁盘内容已变则 409 `STALE_WRITE` 并保留冲突版本；位于可写根之外或需确认时先 409 `NEEDS_CONFIRMATION`，确认令牌 60s 有效（`EditorDocumentService.commitActive`）。
- 写入结果不确定（`EditorFileChangeUncertainError`）时返回 `WRITE_RECONCILE_REQUIRED`，需要对账，不重试写入。
- 保存经 `executeEditorFileChange` 进入文件变更运行时；远程设备走 `editor-file-atomic-io.ts` 的原子 IO（按设备 RPC，带操作命名空间与回执查询），本地走本地 IO（`editor-document-runtime.ts`）。文件历史只对非 `local` 设备记录（`isFileHistoryEnabledForDevice`）。
- 草稿锚点：本地落盘的小日志，最多 128 条/128KiB，暂存 10 分钟，发布后保留 7 天（`EDITOR_DRAFT_ANCHOR_LIMITS`）。
- 路径拒绝符号链接（`editor-source-path.ts:rejectEditorSymlinks`）。

## 从哪读起
- `server/services/editor-document-service.ts`：会话、上传、提交的状态机。
- `server/services/editor-document-runtime.ts`：把服务接到工作区上下文、文件变更运行时和远程设备。
- `server/services/editor-document-jobs.ts`：Worker 池与背压。

## 相关
- [文件写入与变更记录](write-queue.md)
- [文件引用与附件](references.md)：编辑器复用其授权函数
