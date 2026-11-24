---
id: files
title: 文件与编辑
summary: 受控文件写入、变更记录与回退、文件引用、编辑器文档、工作区布局。
keywords:
  - withFileWrite
  - 文件写入
  - 文件历史
  - 回退
  - 编辑器保存
  - 文件引用
  - historyStatus
  - 写队列
anchors:
  - server/services/file-write-queue.ts
  - server/services/file-change-runtime.ts
  - server/services/revert-transaction-service.ts
  - server/services/editor-document-service.ts
  - server/services/workspace-panel-service.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 文件与编辑

文件相关能力围绕一条主线：**任何改文件的动作都先过同一个进程内单文件写队列，再由文件变更运行时记录“实际发生了什么”**。

- 写入侧：工具（Write/Edit 等）、编辑器保存、回退执行和技能创建都用 `withFileWrite` 串行化同一文件；变更运行时把磁盘结果、历史可用性和证据分开记录（证据怎么存见[文件变更证据](change-evidence.md)）。本机后端写入不保留文件历史（只留身份与真实 IO 元数据），远程设备的工具写入由 `ensureFileSnapshot` 存写前快照，只有编辑器保存到远程设备才发布 blob 证据（逐条见[文件写入与变更记录](write-queue.md)）。
- 回退侧：回退读取上述证据生成预览，用户确认后按文件逐项恢复，部分成功保留，历史改写在文件全部校验后再提交。整树的 [Tree 快照](tree-snapshots.md)是另一套机制，目前不再产生新快照。
- 读取/交互侧：文件引用与附件把文件内容带进会话；编辑器文档提供前端编辑与分块保存，最终回到写入侧；工作区布局是独立的面板成员与 dockview 排布，与文件写入无直接耦合。

## 下面有什么

- [文件写入与变更记录](write-queue.md)：单文件写队列、写入结果与历史可用性、本机/远程两条写入分支。
- [回退与文件历史](revert.md)：逐项恢复、部分成功保留、消息 COW，以及远程设备的首次写前快照与回放。
- [文件引用与附件](references.md)：会话里引用文件、上传附件与媒体、文件预览与下载（/api/fs 读侧）。
- [编辑器文档](editor.md)：编辑器文档服务、Worker、远程持久化、前端文本文档视图与文件变更订阅。
- [文件变更证据](change-evidence.md)：写入证据的存储：blob 存储与目录、物理审计、保留清单、改动归属视图。证据只在编辑器保存到远程设备时才带 blob。
- [Tree 快照](tree-snapshots.md)：worktree 的树快照：Bash 观测、编辑预览、快照回退、写入认领；当前不再产生新快照。
