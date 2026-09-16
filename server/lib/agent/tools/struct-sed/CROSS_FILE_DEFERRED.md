# 跨文件能力：调查结论与搁置原因

记录 StructSed **跨文件 copy/move**、**AST rename**、**update_imports** 三项的调查结果。
它们都卡在同一个根因，已明确搁置。放在源码树里而非 `.narrafork/`，是为了进 git 管理、
重启这块工作时一眼可见。

## 根因：写入管线没有跨文件设计

`executeLocalFileChange`（`server/services/file-change-runtime.ts`）是**单文件**原语：

- `validateCall`（约 L378-427）硬性校验 `request.filePath` 必须 resolve 到工具调用**冻结的
  单一** `executionTarget.lexicalPath`。用另一个路径再调一次会抛
  `Tool input changed its frozen path`。
- `executionTarget` 在工具分发时绑定一次，对应 `file_path` 这一个文件。
- 因此**从一次 StructSed 调用里对第二个文件发起合法写入是不可能的**，"两次顺序写入"方案
  在现有管线里走不通。

多 endpoint 机制存在（`ToolExecutionRouting` 的 `kind: "multi"`，`server/lib/agent/types.ts`），
但唯一使用者是 `transfer-file.ts`，语义是**跨设备**分发同一逻辑操作，不是"一次调用写两个
本地文件"。把 StructSed 改成 multi 路由需要让写入管线支持多目标租约，那会触碰
`workspace-write-coordinator.ts` 的 durable-lease 核心——本会话已两次因进程崩溃留下未回收
租约、堵死所有写入并需要人工清理，风险等级高。

## 回退（revert）可行性：两条机制的结论

1. **Tree 快照（首选路径）——支持跨文件。**
   `narrator-tree-snapshot-hooks.ts` 的 `declaredWorktreePaths` 已能声明两个路径（读
   `args.file_path` 和 `args.to_file`）。它基于真实字节 diff，天然支持"一个工具改两个
   文件"：只要两个路径都声明了，两边的 tree delta 都会被捕获和回退。

2. **逐文件重放（回落路径）——不支持跨文件。**
   `file-state-rebuild.ts` 的 `groupByDeviceFile` 按单文件分组，一个工具调用只能归属一个
   文件。另外 `getToolCallFileIdentity`（约 L339）**只认 Write/Edit**，StructSed 不产生文件
   身份——即 StructSed 的编辑本来就不走重放分组路径，只在 tree 快照缺失时才需要重放。

## 已确定的设计决定（重启时直接沿用）

- **参数名 `to_file`**。跨文件目标文件用 `to_file`，目标位置仍用 `to_symbol`/`to_address`，
  在 `to_file` 的内容里解析。理由：与既有 `to_*` 家族一致；全仓没有任何工具用裸 `to` 作
  路径参数（唯一的 `to:` 在 `recall.ts`，是日期区间）；裸 `to` 还会和文档里
  `/from/,/to/` 的正则地址语法混淆。
- `declaredWorktreePaths` 已从投机的 `args.to` 改为 `args.to_file`（`to` 这个 key 在
  StructSed 里从不存在，是早期占位代码，已纠正）。
- **记录方案**：跨文件 move 记录为 `{ command, file_path(源), to_file, resolvedStartLine/
  EndLine(源), ... }`。重放层不支持跨文件时，必须对这类记录抛 `ReplayDivergedError`
  （失败关闭），依赖 tree 快照回退——**绝不静默写错内容**。
- **编码与行尾继承**：目标已存在时用目标的编码/行尾；目标新建时继承源文件。从 GBK 文件搬
  出的内容写进新 UTF-8 文件会变乱码。
- **目标不存在**：创建（含父目录）。默认追加，**不提供 `>` 式截断**——覆盖整个已存在文件
  不该是一个 move 的隐含行为。

## AST rename 的额外约束

- 现有位置索引（`references.ts` 的 `identifierLines`）只记**行号**，不记列，且**同名符号会
  合并**。因此 rename 不能直接建在它上面：一行内同名标识符出现两次时无法定位，合并也无法
  区分"要改的这个 `x`"和"另一个作用域碰巧也叫 `x`"。
- 需要一次**独立的、带列位置的标识符遍历**，收集 `{ row, column, endColumn }`，然后**从后往
  前**替换（与批量搬运同理：从后往前改，前面的列偏移不受影响）。只匹配 `IDENTIFIER_TYPES`
  节点，天然跳过字符串/注释。
- **作用域是诚实边界**：纯语法解析无类型信息，做不到真正的作用域解析。v1 只能定位为"重命名
  文件内所有该名字的标识符出现"，并明确标注不区分作用域、shadowing 需人工复核。不假装是
  LSP rename。
- 重放记录 `{ command: "rename", oldName, newName }` 比记录一堆列位置更稳（确定性，重放时
  重新遍历即可）。

## update_imports

依赖跨文件搬运（找谁 import 了被搬的符号需要 `mode=usages`，已实现）。import 形态差异极大
（默认/命名/别名/type-only/重导出/动态 import），纯文本改写风险高。若重启这块，v1 建议**只
报告受影响的 import 位置**而不自动改写，把判断权留给人——仍然消除了"搬完不知道哪些 import
断了"的问题。

## 已经完成、可直接复用的部分

- `mode=usages`（跨文件反向引用，两段式 ripgrep + AST 精筛）已实现并有测试。
- 同文件 copy/move、批量事务（`operations`）、批量重放均已实现并有测试。
- `declaredWorktreePaths` 的双路径声明已就位，等跨文件写入可行时即可生效。
