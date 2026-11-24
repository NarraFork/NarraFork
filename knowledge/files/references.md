---
id: files.references
title: 文件引用与附件
summary: 会话里引用文件、上传附件与媒体、文件预览与下载（/api/fs 读侧）。
keywords:
  - /api/narrator-attachments
  - /api/fs/document-preview
  - /api/fs/download-ticket
  - /api/fs/edit-source
  - /api/uploads
  - x-attachment-filename
  - FileReferenceService
  - 文件引用
  - 附件
  - 暂存
  - 媒体上传
  - MAX_MEDIA_FILE_SIZE
  - nf-doc-asset
  - .narrafork/attached
  - chat_attachments
anchors:
  - server/lib/svg-sanitize.ts
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
  - server/lib/file-reference-input.ts
  - server/lib/fs-download-ticket.ts
  - server/lib/legacy-file-attachments.ts
  - server/lib/media-uploads.ts
  - server/lib/uploads.ts
  - server/lib/validators/file-references.ts
  - server/routes/fs.ts
  - server/services/file-reference-context.ts
  - server/services/narrator-media-access.ts
  - shared/document-file-extensions.ts
  - shared/file-reference-context.ts
  - shared/file-reference-display.ts
  - shared/file-reference-image.ts
  - shared/media-attachments.ts
  - server/lib/document-preview/
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

- 引用快照在模型侧的投影：`file-reference-projection.ts` 冻结并解析消息里的引用快照、投影为模型文本；`file-reference-input.ts` 解析请求里的引用输入；`file-reference-context.ts`（服务端）与 `shared/file-reference-context.ts` 决定引用相对哪个设备/cwd 解析，远程设备且无已知 cwd 时不拿宿主 cwd 凑数。
- 图片引用：图片类引用单独限 25MiB 与固定的 MIME 白名单（`shared/file-reference-image.ts`，`previewFileReferenceImage`）。
- 附件提示文本：`attached-files.ts` 生成“已附文件”提示（`buildAttachedFilesHint`，旧格式只为识别已持久化消息）；旧版叙述者附件放在 worktree 的 `.narrafork/attached/`，`legacy-file-attachments.ts` 负责把旧文件复制回 worktree（拒绝符号链接和超限文件）。
- 音视频媒体：`media-uploads.ts` 按魔数/扩展名/MP4 结构校验（`validateMediaBytes`，单文件上限 `MAX_MEDIA_FILE_SIZE` 100MiB，前端上传校验上限 128MiB 在 `frontend/lib/api/media-upload-validation.ts`），存到叙述者上传目录；`narrator-media-access.ts` 证明“某叙述者历史确实引用了这个上传”（分叉/COW 副本据此让读者看到源叙述者的上传），查询有 SQL 预筛、墙钟和行数上限、按用户的并发闸门，超限一律拒绝。
- 聊天房间附件（`chat-attachments.ts`，表 `chat_attachments`）用独立目录，不随叙述者清理；归属聊天协作，见 [聊天](../collaboration/chat.md)。
- 文件预览与下载（`routes/fs.ts`）：`GET /api/fs/preview`、`GET /document-preview`、`GET /document-asset`（docx/markdown/zip 在 Worker 里解析，文档 25MiB、内嵌图片 20MiB，SVG/EMF/WMF 不下发；`server/lib/document-preview/`；资源 URL 方案 `nf-doc-asset:` 与扩展名判断在 `shared/document-file-extensions.ts`）。`POST /download-ticket` 签发一次性下载票据：URL 里不出现路径，HMAC 绑定路径+过期+nonce，有效 60s，最多领取 3 次，之后 `already_used`（`fs-download-ticket.ts`）。
- `POST /api/fs/copy-file-to-clipboard` 调系统剪贴板命令（`file-clipboard.ts`，按平台拼命令，出错抛 `ClipboardCopyError`）。

## 从哪读起
- `server/routes/narrator-file-references.ts`：HTTP 路由（search/resolve/info/page/preview），由 `routes/narrators.ts` 挂载。
- `server/services/file-reference-service.ts`：`createFileReferenceService`，实际读取与限流。
- `server/lib/attachment-staging.ts`：附件流式落盘与限额。

## 改它时
- 加或改引用上限：`shared/file-reference.ts` 同时被服务端校验（`validators/file-references.ts`）和前端用，改数字要两侧一起看。
- 加附件/媒体类型：`shared/media-attachments.ts`（MIME→扩展名）、`media-uploads.ts` 的校验、前端 `media-upload-validation.ts`、`routes/uploads.ts` 读取路由一起改；类型识别必须按内容，不信声明的 MIME。
- 改附件暂存限额（32 个、2GiB、1GiB、TTL 6h）：`attachment-staging.ts` 和 `shared/text-file-types.ts` 一起；改完检查叙述者删除/孤儿清理没有误删被消息引用的上传。
- 改 `/api/fs` 读侧路由：路径授权都要过 `fs-secret-paths` 一类的拒绝名单与叙述者访问检查；写侧另有允许名单，见 [文件写入与变更记录](write-queue.md)。
- 不变量：引用快照是写入时冻结的文本，不随文件后续变化；读策略 deny/allow 优先于模式。

## 相关
- [编辑器文档](editor.md)
- [文件写入与变更记录](write-queue.md)：`/api/fs/write` 写侧
