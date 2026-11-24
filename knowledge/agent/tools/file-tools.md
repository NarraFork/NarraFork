---
id: agent.tools.file-tools
title: 文件工具
summary: Read / Write / Edit / Glob / Grep / 结构化编辑。
anchors:
  - shared/streaming-edit-origin.ts
  - frontend/routes/settings/grammars.tsx
  - frontend/lib/api/grammars.ts
  - server/lib/agent/tools/read.ts
  - server/lib/agent/tools/write.ts
  - server/lib/agent/tools/edit.ts
  - server/lib/agent/tools/glob.ts
  - server/lib/agent/tools/grep.ts
  - server/lib/agent/tools/struct-view/
  - server/lib/agent/tools/struct-sed/
  - server/lib/agent/structural/
  - server/services/file-change-runtime.ts
  - frontend/components/settings/StructuralGrammarsSection.tsx
  - server/lib/agent/tools/encoding-core.ts
  - server/lib/agent/tools/encoding.ts
  - server/lib/agent/tools/file-diff-stats.ts
  - server/lib/ripgrep.ts
  - server/lib/vfs-grep.ts
  - server/routes/grammars.ts
keywords:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - StructView
  - StructSed
  - spec://
  - ripgrep
  - replace_all
  - file_busy
  - queue_full
  - legacyEncoding
  - /api/grammars
  - tree-sitter 语法
  - 结构化编辑
  - line-endings
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 文件工具

读、写、改、找文件的内置工具。它们都不直接碰磁盘，而是经执行后端（本地或远程设备，见 [执行后端](../execution.md)）；除 Glob 外，路径可以是 `spec://` 动态规格虚拟文件。大文件优先使用结构化工具 StructView / StructSed。

## 关键规则
- 所有文件工具的参数 schema 都经 `withDeviceParam` 增加可选的 `device` 字段，由 `getToolBackend(ctx, device)` 选出后端；相对路径按后端基准目录解析（`read.ts`、`glob.ts`）。
- Read：`offset` 从 1 开始，`limit` 为 -1 表示读到文件尾，此时输出上限约 100000 字符；长于 2000 字符的行被截断；超过 5MB 的文本文件不整文件读入，改走流式；未给范围的大文件默认只显示 2000 行。支持图片（上限 5MB）、音视频原生媒体（上限 `MAX_MEDIA_FILE_SIZE`）、PDF（`pages`）、ipynb（`read.ts` 顶部常量）。
- Write：整文件覆盖；换行风格和文本编码沿用原文件（`detectLineEnding`、`decodeFileBytes`），二进制文件不计行统计；`spec://` 路径走 `specVfsService.writeSpecFile`，`spec://behavior_fence` 需要一次性授权。工具描述要求改已有文件前先 Read，但我在 `write.ts` 中未找到对应的强制检查（未核实是否在别处强制）。
- Edit：按“替换器链”依次尝试匹配：精确、按行去空白、块首尾锚点、空白归一、缩进宽松、转义归一、边界去空白、上下文感知、多次出现（`edit.ts:REPLACERS`）。非 `replace_all` 时，某个替换器给出的匹配不唯一就换下一个；所有替换器都不唯一则报“找到多个匹配”，都找不到报“old_string not found”；`old_string` 与 `new_string` 相同直接拒绝。统计行数用实际被替换的文本，而非模型给的 `old_string`（`ReplaceResult.matchedText`）。
- 写入落盘由 `file-change-runtime.ts:executeLocalFileChange` 统一处理（构造前后字节、行统计、历史证据），同一文件的写入经 `file-write-queue.ts` 排队：等待默认 30s，每文件最多 64 个等待者，总共 1024；超出分别报 `file_busy` / `queue_full`。Write/Edit/StructSed 之后调用 `trackFileChange` 记录归因，并可附带与其他会话任务重叠的提示。
- Glob：最多 500 条结果，按修改时间排序，`dot` 默认 false；对平台密钥目录拒绝枚举（`isSecretPlatformPath`）；不枚举 `spec://`。
- Grep：基于 ripgrep，输出模式 `content` / `files_with_matches`（默认）/ `count`，`head_limit` + `offset` 分页，原始输出上限 10MB 后截断并提示收窄范围；`path` 为 `spec://` 时搜索规格虚拟文件。
- StructView（`struct-view/`）：只读结构视图，模式有 outline、extract、print、enclosing、api、imports、tree、refs、calls、report、landmarks、interface、usages、find、stash；只有 `find` 是仓库级（`REPO_MODES`），其他需要 `file_path`。文件上限 4MB、输出上限 60000 字符（`constants.ts`）。
- StructSed（`struct-sed/`）：按符号（`Class.method`、`name#2`）或行/正则地址做 replace / substitute / delete / insert / append / copy / move；可经 stash 跨文件搬运代码而不经过对话，`delete` 可用 `from_stash` 作范围；文件上限 2,000,000 字节，预览最多 80 行（`commands.ts`）。
- 结构解析内核 `structural/`：先注册 tree-sitter 提供者，再注册启发式提供者作为兜底，`resolveProvider` 按注册顺序选择（`structural/index.ts`）；tree-sitter 语法包按需下载（`grammar-store.ts`）。

## 从哪读起
- `server/lib/agent/tools/edit.ts:findReplaceMatch`、`replace`
- `server/services/file-change-runtime.ts:executeLocalFileChange`
- `server/lib/agent/tools/struct-sed/tool.ts`、`struct-view/tool.ts`
- 测试：`tools/__tests__/struct-sed*.test.ts`、`struct-view-*.test.ts`、`line-endings.test.ts`、`encoding.test.ts`、`read-media.test.ts`；`structural/__tests__/`
- 编码：默认按 UTF-8 读；`settings.agent.legacyEncoding` 打开时检测编码（GBK、Shift_JIS 等，置信度阈值 70）并按原编码写回（`tools/encoding.ts`，不依赖设置的字符集原语在 `encoding-core.ts`，编辑器文档工作线程只用后者）。
- 行数统计：Write/Edit 结果附带的 `+N -N` 由服务端算（`tools/file-diff-stats.ts`），因为客户端只拿到被截断的前缀；算不出时返回 null 且两个键都省略，`{added:0, removed:0}` 只表示确实没改任何行；整文件统计有 64000 字符上限。
- `server/lib/vfs-grep.ts`：对内存文件列表的极简 grep，供 `spec://` 虚拟路径用（JS 正则、三种输出模式、路径前缀与简单 glob、分页；不支持上下文行、文件类型过滤和编码检测，这些只在 ripgrep 路径）。
- 语法包管理：StructView 从不在工具调用中下载 tree-sitter 语法，设置页 `StructuralGrammarsSection.tsx` 是唯一安装入口，对应 `/api/grammars`（`routes/grammars.ts`：列出、`POST /:lang/download`、`DELETE /:lang`）。
- `server/services/file-read-snapshots.ts` 只是对 `lib/db-worker/file-read-snapshots` 里编辑器/回退读取快照类型的再导出。

## 改它时
- 加一个文件工具：参数 schema 套 `withDeviceParam`，通过 `getToolBackend` 取后端，写盘走 `file-change-runtime.ts:executeLocalFileChange` 与 `file-write-queue.ts`（不要自己写盘），并在写后调用 `trackFileChange` 记录归因；工具要加进 `tools/index.ts`，并按 [工具体系](index.md) 的清单同步权限分类与并行规则。
- 改 Edit 的替换器链顺序要保证「不唯一就换下一个、都不唯一才报多个匹配」，跑 `edit` 相关用例与 `write-serialization.test.ts`；改 Read 的上限同步工具描述（以代码常量为准）。
- 改结构解析：新语言要经 `structural/` 的提供者注册（tree-sitter 在前、启发式兜底），语法包按需下载；`struct-view-*.test.ts`、`struct-sed*.test.ts` 与 `structural/__tests__/` 覆盖。
- Write/Edit 返回的行数统计必须保持「未知即省略」，别用 0 代替。
- 编码相关改动跑 `tools/__tests__/encoding.test.ts`、`line-endings.test.ts`；Glob 对平台密钥目录拒绝枚举的规则不要放宽。

## 相关
- [执行后端](../execution.md)
- [工具体系](index.md)
