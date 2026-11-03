# 数据导入 / 导出 / 清空（DATA_PORTABILITY）

> 实现：`server/services/data-portability.ts`（服务层） + `server/routes/storage-transfer.ts`（HTTP）
> 入口：设置 → 存储空间 →「数据导入 / 导出 / 清空」卡片
> 测试：`server/services/__tests__/data-portability.test.ts`、`data-portability-edge.test.ts`、`data-portability-prefix.test.ts`

## 一、为什么这样做（性能取向）

请求历史与消息表可能有数十万行。逐行转 JSON、再逐行 INSERT 的方案会把大量数据搬进 JS
主线程（CLAUDE.md「后端主线程性能规则」），所以：

- **导出**：子进程把 `SNAPSHOT_TABLES` 里的固定表复制成**原生 SQLite 快照**
  （`CREATE TABLE … AS SELECT` + `INSERT … SELECT`，再压实），打进 ZIP 的 `snapshot.db`；
  不经过 JS 序列化。新表不会自动进来。
- **导入**：`ATTACH` 快照后用**纯 SQL 合并**（`INSERT OR IGNORE ... SELECT`、
  行值 `UPDATE`），SQLite 引擎内部完成，JS 侧零逐行。
- **预览**：`ATTACH` + 联查检出会话 id 冲突，确认后再执行。

## 二、导出包内容

| 文件 | 内容 |
|---|---|
| `snapshot.db` | 固定表清单的原生快照。当前是 `api_requests`、`narrators`、`narrator_messages`、`narrator_message_refs`、`narrator_tool_calls`、`narrator_blocks`、`narrator_text_snapshots`。**新增的表不会自动包含** |
| `providers.json` | 供应商配置：`customApiProviders`、`nugProviders`、`codex`、`tokendance`、`commandCode`；平台实例 `platformInstances`；逐模型设置 `hiddenModels`、`modelProtocols`、`modelProtocolOverrides`、`customModels`、`modelCatalog`（**含凭据**） |
| `manifest.json` | `{ version, exportedAt, counts }`，导入时校验 `version <= 1` |

## 三、导入的合并语义

| 数据 | 规则 |
|---|---|
| 请求历史 `api_requests` | 按主键 `INSERT OR IGNORE` 追加（重复 id 跳过）。指向被跳过会话的请求不导入 |
| 会话 `narrators` | 预览列出 id 冲突 → 用户逐条或统一选择**覆盖**或**跳过**；新会话直接插入 |
| 跳过会话 | 不导入该会话的消息、引用、工具调用、消息块，以及 `narrator_id` 指向它的请求 |
| 覆盖会话 | 保留会话行（`narrator_messages.narrator_id` 是 NOT NULL，删行会失败），用导入行 `UPDATE` 各列。子行按主键合并，不删除本地的引用、工具调用或消息块 |
| 消息 `narrator_messages` | `INSERT OR IGNORE`（主键相同的消息被复用，保持 fork 共享语义，不覆盖其它会话内容） |
| 引用 / 工具调用 | `INSERT OR IGNORE` |
| 消息块 `narrator_blocks` | `INSERT OR IGNORE`。`body_rows_only = 1` 时正文只在块行里，旧包没有这张表时跳过 |
| 文本快照 `narrator_text_snapshots` | 会话导出携带完整共享内容库（含 prefix contract、parts、context updates、tools manifest 及其 children）。至少一个会话新增或覆盖时，按 hash `INSERT OR IGNORE` 合并**整包**内容，不按单个会话精确过滤；全跳过或只导入请求时不搬运。旧包缺表时跳过。引用与内容同事务导入，并刷新包内 hash 的 GC 宽限时间（含已有 hash 复用），防止并发 mark/sweep 删掉刚导入的引用 |
| 供应商 | 追加：重名加「-副本」（重复再加编号），`prefix` 冲突自动编号；`codex`/`tokendance`/`commandCode` 单例平台本地为空则导入、已配置则跳过 |
| 平台实例 | 同按前缀避让：本地已有同平台同前缀时跳过，前缀被占用则改名后追加 |
| 逐模型设置 | 隐藏模型、自定义模型取并集；协议覆盖按模型 ID **导入优先**（本地独有的键保留）；模型目录的本地编辑层按 id 合并，`revision` 前进一格。供应商前缀被改名，或同一端点因已存在而跳过但两边前缀不同时，`prefix:model` 的第一段改到新前缀（`openai` 不会误改 `openai-2`） |

**列交集**：拷贝与 UPDATE 都按「两库 `PRAGMA table_info` 的交集」生成列清单。这样快照与
当前库的迁移进度不同（列多了/少了）也能导入——但也意味着**旧快照缺少的新列会用数据库默认值**，
若新列是 `NOT NULL` 且无默认值，导入会失败（事务回滚，主库不受影响）。覆盖时旧包缺少的列保留本地值。
例如 nullable `narrators.reply_context`：新包保留完整 `{ locale, replyInUserLanguage }` 或显式 null；旧包新增会话时用 null，覆盖时保留本地值，跳过时不改变本地语言上下文。

文本快照不额外导入或回填 `narrator_block_assets`：现有 GC 同时扫描 legacy 消息正文与 rows-only 块正文，
并追踪 tools manifest children；导入宽限时间保护扫描已完成、稍后才 sweep 的并发窗口。

## 四、清空语义

- 分项：`requests`（只删 `api_requests`）、`sessions`（删会话及其消息/引用/工具调用，
  消息块随消息级联删除；并把 `terminals` / `benchmark_task_results` 的 `narrator_id` 置空，
  保留这些数据本体）、
  `providers`（清空全部供应商配置：含平台实例、隐藏模型、逐模型协议与自定义模型；
  **不清模型目录**，那里有用户手写的模型卡片）。
- 全量：以上全部。
- 会话清空仅释放快照的消息/块引用，不直接清空共享 `narrator_text_snapshots`，不误删非会话数据。
  不再可达的内容由既有 GC 在宽限期后回收；孤儿 manifest 的 children 可能再保留一轮。
  因此「清空会话」**不等于立即物理擦除文本快照**。
- **安全**：前端先「确认弹窗」，再「输入当前登录密码」；后端复用登录密码校验
  （`authSessionStore.findPasswordHash` + `Bun.password.verify`），密码错误拒绝执行。
- 所有操作都在管理员权限（`requireAdmin`）下，导入/清空在单事务里完成，失败整体回滚。

## 五、修改数据库结构时必须同步的事项（重要）

修改 `server/db/schema.ts` 时，请对照本清单：

1. **新增需要跨机迁移/备份还原的表** → 加进 `server/db/snapshot-protocol.ts` 的
   `SNAPSHOT_TABLES`，并在 `applyImport` 里补一行 `copyTable(attachName, "新表名")`。
   两处缺一都会丢数据：导出不会自动包含新表。
2. **新增 NOT NULL 且无默认值的列** → 旧快照导入会因缺列失败。二选一：
   - 给列加数据库默认值；或
   - 在导入时识别「旧版本快照」并补齐默认值，或明确报错拒绝（当前行为：`version` 校验 + 列交集）。
3. **新增需要随「清空」处理的数据** → 在 `clearData` 的 `clearSessions` / `clearRequests` /
   `clearProviders` 对应分支补删除或断引用逻辑；引用 `narrators.id` 的新表若为 NOT NULL，
   还必须先把它拆开（当前做法：可空列置 NULL；不可空列保留行、改为 UPDATE）。
4. **新增会话级关联表** → 加进 `SNAPSHOT_TABLES` 并补 `copyTable`。跳过会话时要按
   `narrator_id`（或经消息间接）排除该会话的行。覆盖会话只按主键合并，不删除本地行。
5. **改完必跑**：
   ```bash
   bun test --isolate server/services/__tests__/data-portability*.test.ts
   ```
   测试覆盖：全链路、导出/预览只读、无效/畸形/缺表/空/损坏快照、重复导入幂等、
   分项清空隔离、逐条混合冲突决策、供应商多次重名、100 会话 / 5000 消息批量、
   5000 请求性能护栏；真实 prefix 导出→空库导入→epoch/updates/tools manifest 恢复（legacy 与 rows-only）、
   GC mark→导入→sweep 竞态、新旧 `reply_context` 列兼容、清空后的延迟回收。

## 六、已知边界

- **跨版本导入**依赖「列交集 + 数据库默认值」。如果未来做**破坏性 schema 变更**
  （删列/改类型/改语义），旧快照导入后数据的语义可能不再正确——此时应提升
  `EXPORT_VERSION` 并在 `assertVersion` 里拒绝旧版本包，或提供专门的迁移脚本。
- 旧导出包若已带 prefix hash、却未携带其文本快照，导入兼容不代表能凭 hash 重建丢失内容；
  应从仍保留快照的原实例重新导出。本修补不伪造或静默重建旧前缀。
- 快照是**单文件**：导入期间快照被 ATTACH 使用，预览 token 30 分钟过期后自动清理临时文件。
- 供应商配置里的凭据（API key）是**明文**导出，导出文件请按敏感文件保管。
- **下载不进页面内存。** 支持 File System Access API 的浏览器先选保存位置，再把
  `GET /api/storage/export` 的响应体直接写入该文件。其它浏览器由已登录管理员
  `POST /api/storage/export/ticket` 换一张两分钟、一次有效的票据，再用普通链接请求
  `GET /api/storage/export/download?ticket=`，由浏览器下载管理器写盘。这条路径挂在
  全局会话认证之前，因为 `<a href>` 带不上 `Authorization`。
