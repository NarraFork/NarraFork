---
id: files.editor
title: 编辑器文档
summary: 编辑器文档服务、Worker、远程持久化、前端文本文档视图与文件变更订阅。
keywords:
  - /api/narrators/editor
  - EditorDocumentService
  - EDITOR_BUSY
  - STALE_WRITE
  - NEEDS_CONFIRMATION
  - WRITE_RECONCILE_REQUIRED
  - editor_file_subscribe
  - editor_file_changed
  - 草稿锚点
  - draft-anchors
  - 文件编辑器
  - text-document
  - 保存冲突
  - notifyAgent
anchors:
  - server/lib/watcher/
  - server/services/editor-document-service.ts
  - server/services/editor-document-jobs.ts
  - server/services/editor-document-worker.ts
  - server/services/editor-document-streams.ts
  - server/services/editor-document-runtime.ts
  - server/services/editor-file-atomic-io.ts
  - server/services/editor-draft-anchor-store.ts
  - server/routes/editor-documents.ts
  - shared/editor-document.ts
  - frontend/hooks/useTextDocumentView.ts
  - frontend/lib/api/editor-documents.ts
  - frontend/lib/editor-file-subscription.ts
  - frontend/lib/text-document-pure-core.ts
  - frontend/lib/text-document-store.ts
  - frontend/lib/text-document-view-session.ts
  - frontend/lib/text-document-worker-client.ts
  - frontend/lib/text-document-worker-core.ts
  - frontend/lib/text-document-worker-protocol.ts
  - frontend/lib/text-document.worker.ts
  - server/websocket/editor-file-ws.ts
  - server/lib/validators/editor-documents.ts
  - server/routes/editor-cache-browser-acceptance.ts
  - server/routes/editor-draft-browser-acceptance.ts
  - server/routes/editor-host-cold-browser-acceptance.ts
  - server/routes/editor-native-fixture.ts
  - server/routes/editor-native-rpc-fixture.ts
  - server/routes/editor-remote-browser-acceptance.ts
  - server/services/editor-document-panel.ts
  - server/services/editor-document-stream-worker.ts
  - server/services/editor-file-subscription.ts
  - server/services/editor-source-path.ts
  - server/services/file-edit-interject.ts
  - shared/editor-file-events.ts
  - shared/editor-provider-contracts.ts
  - shared/editor-stream-codec.ts
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
- 原始读取走流：`editor-document-streams.ts` 的两个按亲和性绑定的源 Worker 做读窗口，远程设备掉线 3s 内重连会重试；窗口 256KiB、最多 8 条原始流（`EDITOR_RAW_WINDOW_BYTES`、`EDITOR_RAW_MAX_STREAMS`）；编码嗅探与 BOM 在 `shared/editor-stream-codec.ts`（只做保守嗅探，旧编码需显式提示）。`editor-document-worker.ts` 的动作是 `metadata | content | disk-state | seal | raw-seal | prepare | recovery | cleanup`。
- 文件变更提示：WS 消息 `editor_file_subscribe/unsubscribe` → `editor_file_subscribed/changed/error`，只是提示，不授予访问权；服务端 `EditorFileSubscriptions` 是轮询适配器（单个 15s 定时器、4 个并发鉴权、最多 128 个被授权资源、每组 16 个引用、无文件正文）；前端同名类按“每个可见资源一个订阅”（`shared/editor-file-events.ts`、`server/websocket/editor-file-ws.ts`、`frontend/lib/editor-file-subscription.ts`）。
- 保存后通知叙述者：保存请求带 `notifyAgent` 时，`file-edit-interject.ts` 对运行中的叙述者以插话消息送达，空闲的叙述者不唤醒、只写一条 `schedule: "none"` 的注入；同一叙述者连续保存合并为一条（`/api/fs/write` 与编辑器文档提交两处都会调用）。
- 前端文本文档视图：主线程只读/绘制有界的原始窗口，两个独立 Worker 泵做 CPU 工作（`useTextDocumentView.ts`、`text-document-view-session.ts`、`text-document.worker.ts`、`text-document-worker-client/core/protocol.ts`、`text-document-pure-core.ts`）；文档缓存 32MiB、导入 8MiB、空闲上限 128、读超时 10s（`text-document-store.ts`）；Worker 看门狗 60s、派生缓存 64MiB（`text-document-worker-protocol.ts`）。Worker 不可用时前端怎么降级：未核实。
- `*-browser-acceptance.ts`、`editor-native-fixture.ts`、`editor-native-rpc-fixture.ts` 是浏览器验收/原生 RPC 的测试夹具路由，不是产品路径。
- `shared/editor-provider-contracts.ts` 描述提供者能力与第 6–9 阶段的冻结线协议；能力只描述、不授权，每次操作都在宿主重新鉴权，未实现的阶段标志保持 false。
- `editor-document-panel.ts` 是旧文件面板的读取适配（`readLegacyFilePanel`、`listLegacyArchive`、`readLegacyArchiveEntry`，压缩包最多列 10000 项），复用引用服务的分页与授权。

## 从哪读起
- `server/services/editor-document-service.ts`：会话、上传、提交的状态机。
- `server/services/editor-document-runtime.ts`：把服务接到工作区上下文、文件变更运行时和远程设备。
- `server/services/editor-document-jobs.ts`：Worker 池与背压。

## 改它时
- 加或改编辑器路由：`routes/editor-documents.ts` + `validators/editor-documents.ts` + `frontend/lib/api/editor-documents.ts` 三处一起；线协议类型在 `shared/editor-document.ts`、`shared/editor-provider-contracts.ts`，前端与远程设备端（device 协议特性 `EDITOR_TARGET_QUEUE_FEATURE`）都读它。
- 改限额常量（`shared/editor-document.ts`、`EDITOR_DRAFT_ANCHOR_LIMITS`）：`editor-document-service.test.ts`、`editor-draft-anchor-store.test.ts` 等会断言数字；Worker 池和流 Worker 必须保持“不可用就报错、不回退主线程”。
- 改保存冲突语义（`STALE_WRITE`、`NEEDS_CONFIRMATION`、`WRITE_RECONCILE_REQUIRED`）：同时改 `routes/fs.ts` 的 `/write`（同一套语义）和前端冲突处理。
- 保存必须经 `executeEditorFileChange`；本机编辑不产生 blob，远程编辑才发布证据（见 [文件写入与变更记录](write-queue.md)）。
- 新增 WS 消息：`shared/editor-file-events.ts` 与服务端、前端订阅类三处一起改。

## 相关
- [文件写入与变更记录](write-queue.md)
- [文件引用与附件](references.md)：编辑器复用其授权函数
- [文件变更证据](change-evidence.md)：远程编辑才发布 blob
