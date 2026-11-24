---
id: files.references
title: 文件引用与附件
summary: 会话里引用文件、上传附件。
anchors:
  - server/services/file-reference-service.ts
  - server/routes/narrator-file-references.ts
  - shared/file-reference.ts
  - server/routes/narrator-attachments.ts
  - server/lib/attachment-staging.ts
  - server/routes/uploads.ts
  - shared/text-file-types.ts
  - frontend/lib/api/file-references.ts
  - frontend/lib/api/media-upload-validation.ts
  - server/lib/agent/file-reference-projection.ts
  - server/lib/attached-files.ts
  - server/lib/chat-attachments.ts
  - server/lib/file-reference-input.ts
  - server/lib/fs-download-ticket.ts
  - server/lib/legacy-file-attachments.ts
  - server/lib/media-uploads.ts
  - server/lib/uploads.ts
  - server/lib/validators/file-references.ts
  - server/routes/fs.ts
  - server/services/file-clipboard.ts
  - server/services/file-reference-context.ts
  - server/services/narrator-media-access.ts
  - shared/document-file-extensions.ts
  - shared/file-reference-context.ts
  - shared/file-reference-display.ts
  - shared/file-reference-image.ts
  - shared/media-attachments.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 文件引用与附件

两条独立的路径：文件引用（在输入框里 @ 某个文件，服务端读取并快照其内容）和附件（用户上传的文件先暂存，发送消息时再取用）。

## 关键规则
- 引用服务提供 `filePanelInfo / filePanelPage / captureFileReferences / resolveFileReferences / previewFileReference / previewFileReferenceImage / searchFileReferences`，都要 `narratorId + userId`（`file-reference-service.ts:FileReferenceService`）。
- 读取受执行策略约束：策略显式 deny/allow 直接生效；`dontAsk` 拒绝，`bypassPermissions` 放行，叙述者工作目录内放行，否则 `readOnly` 拒绝、其余需询问（`evaluateFileReferenceReadPolicy`）。带 OAuth 运行时策略时还要求允许 `Read` 工具且设备级别至少 readOnly。
- 上限（`shared/file-reference.ts`）：单次最多 16 个引用，路径 4096 字符，源文件 1MiB，单个引用文本 32KiB、合计 128KiB，搜索最多 50 条/128KiB，搜索超时 2s，读取超时 10s，读取并发 2；文件面板分页 256KiB、总上限 1GiB。
- 引用快照保存解码文本的 sha256，同时是 `/fs/edit-source` 的乐观锁令牌（`hashFileReferenceText`）。
- 编辑器也复用这里的授权（`authorizeEditorReferenceContext/Target`、`authorizeEditorOperationDevice`）。
- 附件上传 `POST /api/narrator-attachments/:narratorId`：要求叙述者写权限，Content-Type 必须是 `application/octet-stream`（否则 415），文件名走 `x-attachment-filename` 头（百分号编码），返回 `uploadId`；`DELETE .../:uploadId` 丢弃暂存（`narrator-attachments.ts`）。
- 暂存限额：每个叙述者最多 32 个待发附件、合计 2GiB、单文件 1GiB，上传超时 30 分钟，暂存 TTL 6 小时（`attachment-staging.ts`、`shared/text-file-types.ts`）。
- `/api/uploads` 只负责读取：头像（登录用户都可读）、叙述者图片与媒体（按叙述者访问权限校验）（`routes/uploads.ts`）。

## 从哪读起
- `server/routes/narrator-file-references.ts`：HTTP 路由（search/resolve/info/page/preview），由 `routes/narrators.ts` 挂载。
- `server/services/file-reference-service.ts`：`createFileReferenceService`，实际读取与限流。
- `server/lib/attachment-staging.ts`：附件流式落盘与限额。

## 相关
- [编辑器文档](editor.md)
