---
id: frontend.narrator-ui.file-panels
title: 文件面板
summary: 文件树、文件查看（预览/节点/归档）与基于 Monaco + Worker 的文件编辑器面板。
anchors:
  - frontend/components/narrator/file-editor/[a-lA-L]*
  - frontend/components/narrator/file-editor/[m-zM-Z]*
  - frontend/components/narrator/file-tree/
  - frontend/components/narrator/file-viewer/
  - frontend/components/narrator/file-panel/
  - shared/editor-document.ts
  - frontend/hooks/useGenUI.ts
  - frontend/lib/reveal-directory.ts
keywords:
  - FileEditorContent
  - MonacoEditor
  - FilePanelContent
  - LargeFileGate
  - 文件树
  - 草稿恢复
  - 保存冲突
  - 磁盘变更
  - EDITOR_FILE_MAX_BYTES
  - /api/fs/browse
  - /api/fs/preview
  - 归档浏览
  - 节点视图
  - tree-patch
  - editor-draft-store
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 文件面板

会话旁边的文件相关面板：左侧文件树、点击文件后在 dock 里打开的文件面板（文本走编辑器，其他走查看器），以及工具调用“查看此文件”的预览弹窗。文件面板由 dock 打开（见[会话外框](session-chrome.md)），路由入口 `file-panel/FilePanelContent.tsx`。

## 关键规则
- 面板路由（`FilePanelContent.tsx:FilePanelBody`），按分支：
  - 本地设备、有 narratorId、无行选择、且是 zip 族归档（`archive-viewable.ts`）：只读归档浏览器 `ArchiveViewerContent`。
  - 文本文件（`getFilePreviewType === "text"`）：`LargeFileGate` 包住 `FileEditorContent`，外层 `EditorRecoveryBoundary`。
  - 其余（二进制/图片等）：`FileViewerContent`。
  - 三者都是 `lazy()` 懒加载；面板从未可见过不渲染内容（`displayed` ref）。远程设备不回退到本地读取。
- 大文件闸门（`LargeFileGate.tsx:filePanelLoadPolicy`）：>`MAX_FILE_PANEL_BYTES`（1GiB，`shared/file-reference.ts`）`blocked`；>1MiB（`FILE_PANEL_AUTO_LOAD_BYTES`）`confirm`；否则 `auto`。分页读取单页 `FILE_PANEL_PAGE_BYTES`=256KiB。
- 查看器（`file-viewer/`）三种模式 `preview | node | raw`；markdown 才有 preview，json/toml/ini 才有 node，yaml 不做 node 视图（`structured-parse.ts`：任何不完全理解的结构整体解析失败，回落 raw；节点数与深度有上限）。`FileViewerContent` 经 `/api/fs/preview` 流式读取并按字符数封顶；`FilePreviewModal` 文本上限 `MAX_FILE_PREVIEW_TEXT_CHARS`=120000，图片/PDF blob 上限 25MiB。
- 文件树（`file-tree/`）按目录层级懒加载（`/api/fs/browse`），每个已加载目录一条缓存（`tree-store.ts`）；`.git` 目录被过滤（`omitGitDirectory`，其他点文件保留）；重新校验并发 3（`REVALIDATE_CONCURRENCY`）。
- 文件变更事件转为目录补丁（`tree-patch.ts:computeTreePatch`）：
  - 普通变更：只让**父目录**失效，且仅限已加载目录；未加载的不抓取。
  - 删除：已加载的被删目录及其后代整体丢弃（`drop`），其父目录失效；删除文件只让父目录失效。
  - `truncated`（监视器截断批次）：不应用任何子集，`revalidateAll`，但删除照常丢弃。
  - 失效不是驱逐：旧行保留并标 `stale`，新列表到达再替换。
- 文件树剪贴板只有一格、页面级（`file-clipboard.ts`）：复制/剪切只记意图，粘贴时才调服务端；右键菜单项按前置条件出现（引用到输入框需要 `FileReferenceScope`；“在文件管理器中显示”仅限服务器本机浏览器）。
- 编辑器（`file-editor/`）全部重活在 Worker 里：`editor-worker-client.ts`、`editor-save-client.ts`（保存编码 Worker 同时最多 2 个，`editorSaveDiagnostics().limit`）、`monaco.worker.ts`。`monaco-worker-policy.ts` 只支持 Monaco 0.56.0，把 Monaco 的同步主线程回退 `_createFallbackLocalWorker` 替换成直接抛错，并给握手 15s、请求 30s、挂起请求 256 的预算；版本不符直接拒绝运行。
- 容量上限（`shared/editor-document.ts`）：文件 20MiB、文档 20Mi 字符、传输分块 64KiB、上传分块 256KiB、单次 IO 超时 30s。超限以 `EDITOR_TEXT_LIMIT` 等错误明确失败。
- 保存状态机（`save-state.ts`，纯函数）：
  - 冲突（磁盘内容已变）：保留用户缓冲区不替换，展示对方版本；冲突不阻止再次保存，保存针对新的 hash。
  - 写到工作区之外：服务端拒绝并返回解析后的物理路径，进入 `confirmation`（不是错误）；确认只能点显式按钮，Ctrl+S 不算；任何击键都会清除已有确认。
  - 正在保存时不能重复保存。
- 草稿：编辑器草稿与尝试数据存浏览器（`editor-draft-store.ts`、`editor-draft-checkpoint.ts` 全域单一调度队列、`editor-attempt-spool.ts` TTL 10 分钟），崩溃/刷新后经 `EditorDraftRecovery` 恢复。
- 外部磁盘变化探测（`editor-disk-state.ts`）：只比对身份/基线 hash，不读文本；每个工作副本一条、仅可见副本探测，全域同时最多 2 个探测；触发源含可见/聚焦/WS 重连/`workspace_paths_changed` 提示/15 秒可见兜底。

## 从哪读起
- `file-panel/FilePanelContent.tsx`：路由；`file-editor/FileEditorContent.tsx`（约 1700 行）：编辑器面板。
- `file-editor/editor-working-copy.ts`、`editor-document-registry.ts`：工作副本与引用租约。
- `file-tree/useFileTree.ts`、`tree-store.ts`、`tree-patch.ts`。

## 改它时
- 编辑器/Monaco 相关改动遵守 Worker 隔离：不得给 Worker 失败加主线程回退；`monaco-worker-policy.test.ts`、`editor-worker-client.test.ts`、`editor-worker-pool.test.ts` 覆盖故障路径。
- 升级 Monaco 版本必须同步 `MONACO_WORKER_POLICY_VERSION` 与私有 API 适配，否则编辑器拒绝启动。
- 改 `shared/editor-document.ts` 限额要同步服务端编辑会话路由（未核实具体路径）。
- 文件树事件语义改动要同步 `tree-patch.test.ts`、`tree-store.test.ts`。

## 相关
- [会话外框](session-chrome.md)：dock 与工作区
- [工具卡片](tool-cards.md)：工具编辑差异与文件目标
- [消息列表](message-list.md)：`content/` 文档查看器
