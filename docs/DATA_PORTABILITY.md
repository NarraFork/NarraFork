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
| `snapshot.db` | 固定表清单的原生快照。当前是 `api_requests`、`narrators`、`narrator_messages`、`narrator_message_refs`、`narrator_tool_calls`、`narrator_blocks`、`narrator_text_snapshots`、`folder_git_identity_bindings`。**新增的表不会自动包含** |
| `providers.json` | 供应商配置：`customApiProviders`、`nugProviders`、`codex`、`tokendance`、`commandCode`；平台实例 `platformInstances`；逐模型设置 `hiddenModels`、`autoExcludedProviders`、`modelProtocols`、`modelProtocolOverrides`、`customModels`、`modelCatalog`。**不含 Key**：所有 `apiKey` 都是空的 |
| `provider-keys.sealed.json` | 导出供应商并设置口令时出现，采用主线统一凭据迁移载荷，包含包内供应商组的凭据及组级秘密，保留标签、开关和网络身份；不包含 Codex 账户。用 scrypt + AES-256-GCM 密封，口令至少 10 个字符；兼容读取旧按 owner 分组的 v2 Key 包。见 `server/services/data-portability-keys.ts` 与 `server/lib/credential-transfer/kinds.ts` |
| `provider-settings.sealed.json` | 仅导出供应商且扩展设置含秘密时出现，使用同一导出口令独立密封；包含扩展秘密及与普通配置的认证绑定，不含本机私钥 |
| `manifest.json` | `{ version, exportedAt, counts }`。含插件供应商扩展记录时为 3，另有 `providerSettings: {count, sealed, targets: [{kind, id}]}`（目标清单仅含稳定 ID）；使用统一凭据密封载荷时也为 3，且不要求附带扩展表；纯请求/会话或无密封数据为 1。导入继续支持旧 v1/v2 与两类 v3 |

**导出供应商需要核验**：勾选「供应商」时，要先通过密码 + 两步验证（step-up 用途 `storage.export.providers`），并设置口令。流式导出走 `POST /api/storage/export`，授权和口令都在请求体里；没有文件选择器的浏览器走票据，签发票据时消费 step-up，口令只存在内存里的票据记录中，不进 URL。`GET /api/storage/export?providers=1` 会被拒绝。没有第二因素的账号不能导出供应商，请求和会话照常可以导出。Codex 账号不在数据导出里，只能用凭据迁移搬。

**版本号**：含供应商扩展记录的包使用 `version: 3`，即使扩展没有秘密也不能由只支持 v1/v2 的宿主忽略后宣称成功。没有扩展记录但含主线统一凭据密封载荷时同样使用 v3；无扩展且无密封载荷维持 v1，旧 v2 仍可导入。仅供应商且没有扩展数据时仍不生成 snapshot.db。扩展清单只在包确实包含扩展行、扩展声明或扩展秘密文件时强制校验，不把纯凭据 v3 误判为缺少扩展。

选择供应商时，`SNAPSHOT_TABLES.providers` 把全部持久化的 `plugin_provider_settings` 纳入快照，包含 `custom-api`、`nug`、`platform`、`executable-plugin` 四类、孤立目标、休眠记录和删除墓碑；不按当前核心供应商清单过滤。Codex 的 `codex:credential:<id>` / `codex:pool`、仅通过 CLI 登录的 `commandcode:singleton` 和可执行插件实例的扩展也会保留，凭据账号、插件包和授权本体仍不随扩展搬运。`manifest.providerSettings.targets` 按稳定 `{kind,id}` 去重列出实际快照目标；旧 v3 未带清单时仍以快照为准。

导出进程先解密验证并口令封装秘密，再从快照移除 `secrets_envelope`/`key_id`，压实后归档。普通配置和仅宿主可见字段保留，原始秘密、本机密钥和授权不随快照进入。单次最多512项，普通配置和秘密合计4MiB，密封文件最多8MiB；超限明确失败。没有密码不能导出含秘密的扩展。扫描、解密、封装和导入暂存均在受限子进程执行，创建/超时/取消失败无主线程回退。

## 三、导入的合并语义

| 数据 | 规则 |
|---|---|
| 请求历史 `api_requests` | 按主键 `INSERT OR IGNORE` 追加（重复 id 跳过）。指向被跳过会话的请求不导入 |
| 用量日账本 `usage_daily` | 不在快照里。本次新增的请求（rowid 大于导入前基线）按日 / 计费用户 / 项目 / 来源 / 模型汇总后加进账本，一条 SQL 完成；重复导入被主键跳过的请求不会重复计数。旧包没有计费用户与项目时，用会话所有者、再退到发起人 |
| 会话 `narrators` | 预览列出 id 冲突 → 用户逐条或统一选择**覆盖**或**跳过**；新会话直接插入 |
| 跳过会话 | 不导入该会话的消息、引用、工具调用、消息块，以及 `narrator_id` 指向它的请求 |
| 覆盖会话 | 保留会话行（`narrator_messages.narrator_id` 是 NOT NULL，删行会失败），用导入行 `UPDATE` 各列。子行按主键合并，不删除本地的引用、工具调用或消息块。例外：`task_backend` 变了时删掉该会话在 `outline_spec_imports` 的行（见下） |
| Dynamic Spec 导入状态 `outline_spec_imports` | **不导出**。它说的是本机 spec 行和本机大纲内容之间的关系，而 spec 表和大纲表都不导出，带过去的行会指向那边没有的空间、任务页、spec 修订，`reverted` 还会挡住那边的导入。`narrators.task_backend` 随会话行照旧复制。覆盖本地会话时，导入行带来的 `task_backend` 和本地不同才删掉它的状态行（下次尝试重新得出）；相同就保留（管理员的退回决定不丢）。导入后清任务后端与导入状态的缓存 |
| 被吞内容排查 `outline_spec_loss_findings` / `outline_spec_loss_scans` | **不导出**。记录的是本机 spec 修订里「旧 Spec 面板保存后可能丢失的内容」和哪些会话查过；spec 表不导出，带过去的行对不上那边的修订，那边的排查会自己重新得出。覆盖本地会话时**不动**这两张表（数据导入不改本机的 spec 行，记录仍然成立，人的处理决定也保留） |
| 项目 team `project_teams` / `team_work_items` / `team_work_item_dependencies` / `team_work_events` | **不导出**。team 就是它的协调者会话，这四张表记的是本机的 git 分支、worktree 和对它们的操作（项目本身也不导出）；带到别的机器上会指向那边没有的目录。会话行照旧复制，所以协调者会话会被导入，但它的 team 不会：导入后，传入的会话**有没有 `team` trait 以本机有没有 team 行为准**——本机没有 team 行的会话去掉 `team`（在那边是一个普通会话，不带协调者提示词），覆盖本机的协调者时保留 `team`（team 行和它的工作记录不动） |
| 消息 `narrator_messages` | `INSERT OR IGNORE`（主键相同的消息被复用，保持 fork 共享语义，不覆盖其它会话内容） |
| 引用 / 工具调用 | `INSERT OR IGNORE` |
| 消息块 `narrator_blocks` | `INSERT OR IGNORE`。`body_rows_only = 1` 时正文只在块行里，旧包没有这张表时跳过 |
| 文本快照 `narrator_text_snapshots` | 会话导出携带完整共享内容库（含 prefix contract、parts、context updates、tools manifest 及其 children）。至少一个会话新增或覆盖时，按 hash `INSERT OR IGNORE` 合并**整包**内容，不按单个会话精确过滤；全跳过或只导入请求时不搬运。旧包缺表时跳过。引用与内容同事务导入，并刷新包内 hash 的 GC 宽限时间（含已有 hash 复用），防止并发 mark/sweep 删掉刚导入的引用 |
| 文件夹 Git 身份绑定 `folder_git_identity_bindings` | 随会话数据按主键 `INSERT OR IGNORE` 合并；旧包缺表时跳过。目标库必须已有对应用户和身份，缺失引用的入站绑定会被跳过；身份的 `user_id` 还必须与绑定一致，避免跨用户串联。用户与身份本体不在快照里 |
| 供应商 | 追加：重名加「-副本」（重复再加编号），`prefix` 冲突自动编号；`codex`/`tokendance`/`commandCode` 单例平台本地为空则导入、已配置则跳过 |
| 供应商凭据 | 包里有密封凭据且勾选供应商时必须提供口令，否则报 `IMPORT_PASSPHRASE_REQUIRED`；只导请求或会话时不需要。导入事务前解密并转换旧v1/v2或统一v3载荷，口令错误不写数据。共享供应商分配器根据模板和稳定身份决定新增/复用及前缀映射；配置、会话与扩展暂存数据提交后，再将新增组的凭据和组级秘密恢复到对应本地ID。既有供应商的凭据不覆盖，标签、开关和网络身份随恢复项保留；凭据文件不属于SQL事务，写入失败明确记录 `keysFailed`，其余成功项保留。 |
| 供应商扩展 `plugin_provider_settings`（v3） | 校验记录数、稳定目标清单、字段格式及密封绑定；独立进程按目标机密钥重新加密后暂存，事务中用 `copyTable` 合并。Custom API/NUG 按实际新增或同端点复用的本地供应商 ID 映射；已配置的单例也可补入缺失的扩展。没有核心目标映射的记录保留原稳定 targetId，不生成供应商，也不按显示名称自动匹配。普通记录以新的 `import-UUID` 安装身份和 `dormant` 状态保存，旧安装墓碑保持 `deleted`；休眠配置后续由管理员确认映射到当前目标并重绑。已有本地配置或墓碑始终优先；多条来源映射到同一扩展地址时，按快照 ID 顺序保留首条，其余计为冲突。结果返回 `providerSettingsImported`、`providerSettingsSkipped` 和 `providerSettingsConflicts`，每条来源均计入导入或跳过，预算只增加实际插入数。旧授权不恢复，未知 schema 不按默认值覆盖；Codex 凭据和插件 provider 实例本体仍不由这个供应商包创建。 |
| 插件资源、迁移回执、资源预算 | 不作为可移植用户配置导出；缓存和运行代次不跨机生效，预算按导入配置重建增量。宿主迁移/清空回执只能由目标宿主建立，不能信任导入包来解除门禁。 |
| 旧版包（`version: 1`） | `providers.json` 里的明文 Key 照旧导入，不要求口令 |
| 平台实例 | 同按前缀避让：本地已有同平台同前缀时跳过，前缀被占用则改名后追加 |
| 逐模型设置 | 隐藏模型、自定义模型取并集；协议覆盖按模型 ID **导入优先**（本地独有的键保留）；模型目录的自定义参数（`modelCatalog.overrides`，存于 `~/.narrafork/model-catalog/overrides.json`）按键合并、导入优先，旧包里的内联本地层按同样规则转成自定义参数；自动更新偏好不随导入改变。供应商前缀被改名，或同一端点因已存在而跳过但两边前缀不同时，`prefix:model` 的第一段改到新前缀（`openai` 不会误改 `openai-2`） |

**列交集**：拷贝与 UPDATE 都按「两库 `PRAGMA table_info` 的交集」生成列清单。这样快照与
当前库的迁移进度不同（列多了/少了）也能导入——但也意味着**旧快照缺少的新列会用数据库默认值**，
若新列是 `NOT NULL` 且无默认值，导入会失败（事务回滚，主库不受影响）。覆盖时旧包缺少的列保留本地值。
例如 nullable `narrators.reply_context`：新包保留完整 `{ locale, replyInUserLanguage }` 或显式 null；旧包新增会话时用 null，覆盖时保留本地值，跳过时不改变本地语言上下文。

文本快照不额外导入或回填 `narrator_block_assets`：现有 GC 同时扫描 legacy 消息正文与 rows-only 块正文，
并追踪 tools manifest children；导入宽限时间保护扫描已完成、稍后才 sweep 的并发窗口。

## 四、清空语义

- 分项：`requests`（删 `api_requests` 与按天汇总它的 `usage_daily`）、`sessions`（删会话及其消息/引用/工具调用，
  消息块随消息级联删除；并把 `terminals` / `benchmark_task_results` 的 `narrator_id` 置空，
  保留这些数据本体，同时清空不随会话外键级联的 `folder_git_identity_bindings`，以及
  Dynamic Spec 导入状态 `outline_spec_imports` 和被吞内容排查的 `outline_spec_loss_findings` / `outline_spec_loss_scans`，它们有会话外键级联，仍显式删除；
  以及项目 team 的 `team_work_events` / `team_work_item_dependencies` / `team_work_items` / `project_teams`：team 行对会话是 RESTRICT，必须先删。
  team 记录的 worktree 目录和分支**不会被删**，只是不再有记录，需要时由人手工清理）、
  `providers`（清空全部供应商配置：含平台实例、隐藏模型、逐模型协议与自定义模型；
  **不清模型自定义参数**（`overrides.json`），那里是用户手写的数据）。
- 清空供应商还会通过独立进程分批清除扩展配置/密文及 provider/credential 资源值，保留递增 revision 的删除标记，防止旧 create-only 迁移复活数据；每批最多50项并同步资源预算。核心文件清空与扩展分批清空不属于同一个数据库事务；扩展失败返回错误，已完成部分保留，重新清空可继续，不能把失败报成全量成功。
- 全量：以上全部。
- 会话清空仅释放快照的消息/块引用，不直接清空共享 `narrator_text_snapshots`，不误删非会话数据。
  不再可达的内容由既有 GC 在宽限期后回收；孤儿 manifest 的 children 可能再保留一轮。
  因此「清空会话」**不等于立即物理擦除文本快照**。
- **安全**：前端先「确认弹窗」，再「输入当前登录密码」；后端复用登录密码校验
  （`authSessionStore.findPasswordHash` + `Bun.password.verify`），密码错误拒绝执行。
- 所有操作都在管理员权限（`requireAdmin`）下。会话/请求及暂存扩展表的 SQL 合并在事务中完成；供应商文件和 Key 存储在事务外部，不能声称文件与 SQL 跨介质整体回滚。扩展导入前完成解密与校验，并在提交前复查核心设置 revision；扩展导入/清空失败会明确返回并保留恢复依据。

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
- v2/v3 包的供应商凭据使用口令密封；旧 v1 包可能包含明文 Key。没有口令不能导入所选供应商的密封凭据；仍可只导入请求或会话。
- **下载不进页面内存。** 支持 File System Access API 的浏览器先选保存位置，再把
  `GET /api/storage/export` 的响应体直接写入该文件。其它浏览器由已登录管理员
  `POST /api/storage/export/ticket` 换一张两分钟、一次有效的票据，再用普通链接请求
  `GET /api/storage/export/download?ticket=`，由浏览器下载管理器写盘。这条路径挂在
  全局会话认证之前，因为 `<a href>` 带不上 `Authorization`。
