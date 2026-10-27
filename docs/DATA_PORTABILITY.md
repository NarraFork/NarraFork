# 数据导入 / 导出 / 清空（DATA_PORTABILITY）

> 实现：`server/services/data-portability.ts`（服务层） + `server/routes/storage-transfer.ts`（HTTP）
> 入口：设置 → 存储空间 →「数据导入 / 导出 / 清空」卡片
> 测试：`server/services/__tests__/data-portability.test.ts`、`data-portability-edge.test.ts`

## 一、为什么这样做（性能取向）

请求历史与消息表可能有数十万行。逐行转 JSON、再逐行 INSERT 的方案会把大量数据搬进 JS
主线程（CLAUDE.md「后端主线程性能规则」），所以：

- **导出**：`VACUUM INTO` 生成**原生 SQLite 快照**（单条 SQL，含 WAL 已提交数据），
  打进 ZIP 的 `snapshot.db`；不经过 JS 序列化。
- **导入**：`ATTACH` 快照后用**纯 SQL 合并**（`INSERT OR IGNORE ... SELECT`、
  行值 `UPDATE`），SQLite 引擎内部完成，JS 侧零逐行。
- **预览**：`ATTACH` + 联查检出会话 id 冲突，确认后再执行。

## 二、导出包内容

| 文件 | 内容 |
|---|---|
| `snapshot.db` | 整库原生快照（`VACUUM INTO`）——**新增的表会自动包含** |
| `providers.json` | 供应商配置：`customApiProviders`、`nugProviders`、`codex`、`tokendance`、`commandCode`（**含凭据**） |
| `manifest.json` | `{ version, exportedAt, counts }`，导入时校验 `version <= 1` |

## 三、导入的合并语义

| 数据 | 规则 |
|---|---|
| 请求历史 `api_requests` | 按主键 `INSERT OR IGNORE` 追加（重复 id 跳过） |
| 会话 `narrators` | 预览列出 id 冲突 → 用户逐条或统一选择**覆盖**或**跳过**；新会话直接插入 |
| 覆盖会话 | 保留会话行（`narrator_messages.narrator_id` 是 NOT NULL，删行会失败），用导入行 `UPDATE` 各列；先删本会话的 `narrator_message_refs` / `narrator_tool_calls` 后按快照重建 |
| 消息 `narrator_messages` | `INSERT OR IGNORE`（主键相同的消息被复用，保持 fork 共享语义，不覆盖其它会话内容） |
| 引用 / 工具调用 | `INSERT OR IGNORE` |
| 供应商 | 追加：重名加「-副本」（重复再加编号），`prefix` 冲突自动编号；`codex`/`tokendance`/`commandCode` 单例平台本地为空则导入、已配置则覆盖 |

**列交集**：拷贝与 UPDATE 都按「两库 `PRAGMA table_info` 的交集」生成列清单。这样快照与
当前库的迁移进度不同（列多了/少了）也能导入——但也意味着**旧快照缺少的新列会用数据库默认值**，
若新列是 `NOT NULL` 且无默认值，导入会失败（事务回滚，主库不受影响）。

## 四、清空语义

- 分项：`requests`（只删 `api_requests`）、`sessions`（删会话及其消息/引用/工具调用，
  并把 `terminals` / `benchmark_task_results` 的 `narrator_id` 置空，保留这些数据本体）、
  `providers`（清空全部供应商配置）。
- 全量：以上全部。
- **安全**：前端先「确认弹窗」，再「输入当前登录密码」；后端复用登录密码校验
  （`authSessionStore.findPasswordHash` + `Bun.password.verify`），密码错误拒绝执行。
- 所有操作都在管理员权限（`requireAdmin`）下，导入/清空在单事务里完成，失败整体回滚。

## 五、修改数据库结构时必须同步的事项（重要）

修改 `server/db/schema.ts` 时，请对照本清单：

1. **新增需要跨机迁移/备份还原的表** → 在 `applyImport` 里补一行
   `copyTable(attachName, "新表名")`；否则**导入会静默丢这张表的数据**。
   （导出不需要改：`VACUUM INTO` 自动包含新表。）
2. **新增 NOT NULL 且无默认值的列** → 旧快照导入会因缺列失败。二选一：
   - 给列加数据库默认值；或
   - 在导入时识别「旧版本快照」并补齐默认值，或明确报错拒绝（当前行为：`version` 校验 + 列交集）。
3. **新增需要随「清空」处理的数据** → 在 `clearData` 的 `clearSessions` / `clearRequests` /
   `clearProviders` 对应分支补删除或断引用逻辑；引用 `narrators.id` 的新表若为 NOT NULL，
   还必须先把它拆开（当前做法：可空列置 NULL；不可空列保留行、改为 UPDATE）。
4. **新增会话级关联表** → 导出自动包含；导入若需要合并，补 `copyTable`；
   覆盖会话时若新表引用该会话，按第 3 条处理引用。
5. **改完必跑**：
   ```bash
   bun test --isolate server/services/__tests__/data-portability*.test.ts
   ```
   测试覆盖：全链路、导出/预览只读、无效/畸形/缺表/空/损坏快照、重复导入幂等、
   分项清空隔离、逐条混合冲突决策、供应商多次重名、100 会话 / 5000 消息批量、
   5000 请求性能护栏。

## 六、已知边界

- **跨版本导入**依赖「列交集 + 数据库默认值」。如果未来做**破坏性 schema 变更**
  （删列/改类型/改语义），旧快照导入后数据的语义可能不再正确——此时应提升
  `EXPORT_VERSION` 并在 `assertVersion` 里拒绝旧版本包，或提供专门的迁移脚本。
- 快照是**单文件**：导入期间快照被 ATTACH 使用，预览 token 30 分钟过期后自动清理临时文件。
- 供应商配置里的凭据（API key）是**明文**导出，导出文件请按敏感文件保管。
