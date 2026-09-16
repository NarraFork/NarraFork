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

### multi 路由复查（已完成，结论：不改核心就走不通）

后续专门复查过「能否借 multi 路由绕开」，结论是**不能**，且卡点比原先记录的更靠底层。四个
独立障碍，任一存在就足以否决，全部有行号：

1. **`validateCall` 比对的是 tool-call 行的扁平列，不是执行计划。**
   `file-change-runtime.ts` 约 L403-426 逐字段核对 `row.lexical`/`row.canonical`/`row.cwd`
   与 `target`，再校验 `resolve(target.cwd, request.filePath)` 必须等于 `target.lexicalPath`，
   否则抛 `Tool input changed its frozen path`。**一行只能存一个路径**。
2. **`expectedEffectCount: 1`**（约 L726）——operation 契约就是「一次调用一个效果」。
3. **`sourceId: frozen.row.id`**（L506）对同一次调用是**同一个值**，而 `executeBound` 入口
   （L678）和写锁内（L715）都会用它查 `existingOperation`，命中即抛 `alreadyAttempted`。
   所以「同一次调用里顺序写第二个文件」会被去重逻辑当成重复尝试直接拒绝。
4. **租约 scope 是按文件各自的 root 推导的**（`prepareWorkspaceScope`，L648-654：
   `canonicalRoot: root` + `workspaceInstanceId: hash([...root, rootIdentity])`）。两个文件
   若不在同一 root 下，就是两个 scope、两把锁，跨 scope 原子性需要协调器支持多 scope 事务。

值得记下的一点：**`executionTargetsJson` 列已经持久化完整 `ToolExecutionPlan`**
（`schema.ts` L1478-1481），所以「存不下两个目标」并不是障碍——障碍是 `validateCall` 只读扁平
列、以及 2/3/4 三条 operation 与租约层的单效果假设。真要做 Plan A，改动面是
`validateCall` + operation 效果计数 + sourceId 去重键 + 多 scope 租约，全在写入管线核心。

**因此按计划的决策规则选择方案 B：不改核心，接受非原子的三步路径**（下方「三步替代路径」
一节）。失败方向是安全的那一侧——留下两份，不会丢代码。

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

## 三步替代路径（已可用，非原子）

后续新增的两项能力让「把符号搬到另一个文件」不再需要退回 Read/Write，纯结构三步即可完成：

1. `StructView mode=extract symbol=X line_numbers=false` — 拿到**不带 `123│` 行号前缀**的裸
   源码（含其文档注释，因为 `startIndex` 已包含附着注释）。这是关键一步：此前 extract 无条件
   加行号，导致输出无法直接当内容用。
2. `StructSed command=append address="1" create_if_missing=true content=<上一步输出>` — 目标
   文件不存在时创建。只有 replace/insert/append 可创建文件（它们自带完整内容）。
3. `StructSed command=delete symbol=X` — 从原文件移除。

**这条路径不是原子的**：第 2 步成功、第 3 步失败会留下「两个文件都有该符号」，而不是丢失代码
（失败方向是安全的那一侧）。真正的原子跨文件仍需前述 multi 路由/租约改造，未做。

另外修掉一个连带 bug：`assertRange` 曾拒绝空文件的第 1 行，导致 StructSed **无法向任何空文件
写入**（不止新建文件）。现在空文件的第 1 行可寻址，第 2 行仍报错。

## usages 别名盲区已关闭，AST rename 的前置条件变了

本文档下方「AST rename」一节曾把「缺少别名信息」列为障碍。该前置缺口已修复：

- `collectImports`（`tree-sitter-provider.ts`）此前**只填 module/line/form，从不填 `names`**，
  尽管 `ImportExportInfo` 接口早已声明该字段。因此 `import { x as y }` 在整个系统里不可见。
- 现在提取为 `ImportedName { local, original? }`。**记录的是 local（文件正文里出现的名字）**，
  别名时才附 `original`——方向很重要：跨文件搜索要找的是使用处写的名字。
- 两种语法形态都处理：JS/TS 的 `import_specifier` 有 `name`/`alias` **字段**；Python 的
  `aliased_import` 是**位置子节点、没有字段**，只按字段读会让每个 Python 文件静默返回空。
- `mode=usages` 现在分 `confirmed`（能证明从定义模块导入，别名会跟到 local 名）和
  `unverified`（同名但找不到可关联的 import）两组，别名文件标 `[imported as X]`。
- `importMayReferTo` 是**按文件名的启发式，不是解析器**（tsconfig paths/package exports 需要
  构建系统自己的逻辑，半实现会给出自信的错误答案）。**桶导入算命中**——本仓库大多数消费方
  是 `from "../../structural"` 而非具体文件，排除它们会把真实用法丢进 unverified，等于在上
  一层重犯同一个错误。

**AST rename 仍未做**，但现在缺的只是「改写」那一半：别名信息和 confirmed/unverified 判定已
可用，rename 的候选集合可以先用 usages 得到。仍未解决的是缺列位置（provider 只给行不给列）。

## `mode=find` 已实现，定位不再依赖 grep

原先每个 StructView 模式都要求已知 `file_path`，"这个符号在哪个文件"只能 grep，而 grep 会把
声明、调用点、注释、同名无关符号混在一起。`mode=find`（`modes/find.ts`）用同样的两段式
（ripgrep 预过滤 → 逐候选 outline 精筛）只保留**真实声明**，输出工作区相对路径 + kind + 行号，
可直接作为下一次调用的 `file_path`。精度仍标 `structural`（按名字、单仓库、无类型解析）。
