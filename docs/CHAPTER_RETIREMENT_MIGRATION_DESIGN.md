# 章节退役迁移助手设计

状态：分阶段实施中。同步停用门禁和共享 Drawer 已实现；保留式转换先开放严格预检通过的最小闭环，复杂资源接管仍须后续实现。下面“已核验现状”记录的是实施前基线。不授权开发过程中删除任何真实用户数据库或资源。

## 1. 目标与结论

用户打开遗留章节时，进入迁移助手；提供一个项目（旧叙事线）级动作：**迁移全部章节为普通叙述者并删除叙事线**。同时永久停止 project-db-sync，清理该项目独立数据库。

这里的“删除叙事线”是移除旧 project/chapter 的业务元数据，不是删除仓库、Git 分支、worktree、会话或容器卷。不要复用现有 project DELETE/chapter remove。

推荐三个顺序明确的阶段：

1. **解除同步**：先停止备份投射，立即消除这条性能负担；无需等待复杂资源迁移。
2. **保留式转换**：会话原地解绑，接管目录、权限、配置和资源。
3. **删除旧元数据及独立 DB**：全部转换和读回验证成功才删除叙事线；文件清理失败可单独重试。

“一键”指一次明确确认后由后台任务执行，不代表绕过权限、强杀运行中会话或静默销毁数据。目标覆盖全部章节；不能把只支持少数本地空闲会话的试点宣称为完成。

## 2. 已核验现状

- 章节路由现在查章节及会话，自动跳到第一个 primary；没有迁移助手。[章节路由](../frontend/routes/chapters/$chapterId.tsx#L17-L73)、[跳转规则](../frontend/components/project/legacy-chapter-redirect.ts#L1-L14)。还必须覆盖直接打开章节所属 narrator 的情况，否则旧路由跳转后会遗漏提示。
- 旧项目页已是配置兼容面板，并有 canManage 权限门禁。[兼容面板](../frontend/components/project/ProjectCompatibilityPanel.tsx#L22-L79)。迁移入口放在这里，不重建画布。
- 自动同步仍监听消息、状态、标题和章节生命周期。[事件入口](../server/services/project-db-sync.ts#L717-L852)。本稿不把用户报告的严重性能问题视为已经完成 profiling；需要用事件延迟和同步调用计数验证解除效果。
- 同步归属同时读取 chapterId 和 contextProjectId；只清 chapterId 不够。[归属查询](../server/services/project-db-sync.ts#L92-L103)。
- DB manager 缓存命中不检查项目状态，关闭后仍能重新打开/创建。[连接管理](../server/lib/project-db.ts#L390-L438)。独立 DB 是主库向仓库内的备份投射，转换以主库为准，不从可能过期的 project.db 重建会话。
- cwd、例程、traits、设备和技能加载存在项目/章节继承。[会话上下文](../server/services/narrator-session.ts#L1123-L1232)。解绑字段不等于上下文已经等效迁移。
- 子代理权限跟随 ACL root；旧 narrator grant 受 project gate 限制。[会话权限](../server/services/narrator-acl.ts#L297-L343)。删除项目后直接保留 grants 可能放宽权限，project 可见性也可能失效。
- resource 注册表有独立生命周期、scope 和 ownershipRevision，但不能假定现有资源运行时已经支持完整接管。[资源 schema](../server/db/schema.ts#L79-L130)。现有 detach 协议明确是 fixture，不能直接暴露为生产执行接口。[fixture 合约](../server/services/local-session-detach/contract.ts#L3-L17)。

## 3. 交互方案：共享内容，桌面 dock / 移动 drawer

### 入口

- `/chapters/:id`：未迁移时不再无提示自动跳转，展示助手；有 primary 时可以进入会话并打开同一助手。
- narrator 页面：存在 chapterId 时首次打开迁移面板；关闭只影响展示，不产生任何业务写入；保留“章节待迁移”按钮。
- 项目兼容页：提供项目级迁移按钮，包括无 narrator 的空章节。
- 已转换章节旧链接：通过迁移映射跳到原 narrator；空章节跳迁移结果。旧 project 链接打开结果页，不返回无法解释的 404。

### 展示

- 桌面在现有 narrator dockview 中注册 `legacy-migration` 面板，以 projectId 去重；没有 narrator 的旧路由用相同内容的独立页面容器。
- 移动端使用 Drawer，复用返回键关闭约定；关闭 drawer 不取消服务端任务。
- 面板内容独立于容器，包含项目名、范围、阶段进度、分页章节清单、阻塞项、保留/删除清单。
- 普通成员只能查看自己可见范围，不能用预检总数泄漏隐藏会话。项目级完整预检/执行需要管理权限及后端逐项迁移授权。

主按钮：**迁移全部章节并删除叙事线**。

确认页明示：保留会话与历史、仓库、分支和工作目录；停止独立 DB 同步；删除旧叙事线/章节元数据及 project.db/WAL/SHM；共享权限和配置的具体变更摘要。不要把“删除”写成普通会话删除。

辅助动作：**仅停止独立 DB 同步**。用于资源暂时无法迁移时先止血；不删 project.db，不解绑任何会话。同步停用是持久设置，重启不自动恢复。

## 4. 持久模型与 API（拟新增）

### 持久模型

- projects 增加 `legacySyncState = enabled | disabled`、`legacyMigrationState = none | migrating | blocked | migrated`。升级默认保持旧同步行为；用户显式停止/开始迁移后持久 disabled。是否全实例默认停用作为独立发布策略，不偷偷混入迁移。
- 独立迁移 operation 表：projectId（历史标识，不随项目 cascade）、actorId、requestId 唯一键、phase、revision、planDigest、cursor、errorCode、timestamps。持久 job lease/epoch 防止重启后重复执行。
- 分页 item/映射表：旧 chapterId → 保留 narratorIds/resourceIds、完成状态、失败原因；空章节保留明确映射。映射只存最小元数据，不复制消息正文。
- 已完成结果不依赖已删除项目授权：保存结果页授权主体/审计依据；没有授权的旧链接不可通过映射枚举会话。
- 继承配置/ACL/历史资源的持久接管数据与普通 narrator/resource 模型一起设计，不能只存在 job JSON 中。旧项目最终删除后，不允许继续依赖 contextProjectId。

schema 修改走自动 SQLite/PG 迁移流程，不手工写正式迁移 SQL。

### API

- `GET /api/projects/:id/legacy-migration/preview`：摘要及 blockers；章节条目 cursor 分页，禁止加载历史大字段。
- `POST /api/projects/:id/legacy-sync/disable`：管理权限，持久禁用并排空；返回 operation 状态，不能把“写了标志”当成 drain 完成。
- `POST /api/projects/:id/legacy-migration`：requestId、previewRevision/planDigest、明确确认；重复请求返回同一 job。旧预检返回 409，要求刷新确认。
- `GET /api/legacy-migrations/:operationId`：摘要、进度、下一页 cursor。
- `POST /api/legacy-migrations/:operationId/resume`：解决 blockers/重试失败阶段，重新校验权限与版本。
- `GET /api/legacy-chapters/:chapterId/target`：存活章节入口或受授权约束的完成映射。

任务返回 202，不在一次 HTTP 请求中迁移全部章节。WebSocket 只发阶段与计数增量，客户端失联后通过 GET 恢复。

## 5. 同步停用：先封入口，再 drain，再 close

统一项目级 sync coordinator 覆盖：事件同步、narrator 调度器、fork 直写、手动全量 backup worker、manager getDb/openForGitPath。不能只在事件监听器加 if。

1. 写 disabled，推进项目 sync epoch；所有执行入口和获取缓存连接入口必须校验 gate。
2. 取消待执行调度；调度器按 narrator 排队，但任务执行时解析项目后逐项目申请 permit，不误取消同时归属其他项目的同步。
3. 记录当前项目的 in-flight 任务和全量 worker；取消或等待它们结束。已有异步任务在最终取连接/写入处再次检查 epoch。
4. 超时保留 disabled 和可重试状态，不删除 DB，也不谎报完成；等待旧 worker 确认退出。
5. 排空后关闭连接。迁移或独立停用失败都不自动恢复 sync。

仅停止同步不删除文件。完整迁移的最后清理只处理已核验 `<gitPath>/.narrafork/project.db` 及其 `-wal/-shm`；不删除整个 .narrafork、不删除主库、不改 .gitignore。

路径验证防 symlink/路径替换，记录 canonical identity；多个项目指向同一物理 DB 时，必须排空全部使用者并获得必要授权，否则保留文件并报告 blocker。不能在 worker 仍持有连接时 unlink。已存在文件缺失按幂等成功处理，锁占用/权限错误保持 cleanup_pending。

## 6. 转换规则：会话不复制，资源不误删

| 对象 | 目标处理 |
| --- | --- |
| chapter 下全部 primary、variant 会话 | 保留 id/type/variant/title/status；清 chapterId；不挑一个删其余；已归档会话不强行激活 |
| 子代理、fork/lazy 继承 | 保留 parent/ACL root、refs、工具记录、spec、附件、来源及历史依赖；对子代理自身遗留 chapter/context 关联也清理 |
| contextProjectId-only 会话 | 纳入项目删除依赖清单，迁移或明确阻塞；不能遗留悬空上下文 |
| 工作目录 | 固化当前有效 device/cwd/workspace revision；保留用户 override，不强制改回章节目录；显式 cwd 与章节资源可分别接管 |
| 活跃章节 worktree/分支 | 保留原路径和分支；注册持久资源及使用者 claim，再移除章节元数据。共享 cwd 不强制选一个用户作为唯一 owner |
| 休眠章节 | 不隐式唤醒、不偷偷切主分支；默认固化现有效目录，标明不代表旧章节分支。需要继续旧分支时通过显式恢复步骤/普通 worktree API，未恢复资源及 ignored-file 归档保持可追踪 |
| 空章节 | 不凭空制造会话；有资源则接管成可见独立资源，无资源则只保存历史映射 |
| 终端/容器/端口/卷 | 转为独立资源关联，并实现相应运行时及 ACL adapter；保留运行实例/volume。尚不能接管时阻塞，不用删除或强停代替接管 |
| tree/文件快照 | 建立 narrator/resource 的持久 shadow/历史路径 claim；保留回退所需对象闭包，改消费者/GC 判断后才删章节引用 |
| 章节边/commit/merge 元数据 | 生成有限迁移来源摘要；仍是回退/运行依赖的数据必须接管。进行中的 merge 先用户结束或安全续接，不自动丢弃 |
| 计划任务/外部绑定 | 防止再创建章节会话；迁移 task target 为 standalone（保留执行者身份并重验权限），无法等效时明确暂停。OAuth/integration 必须专门迁移/重新授权，不抹 provenance 冒充本地会话 |

运行中、排队中、权限等待或存在活跃子代理的会话：job 显示等待安全点，禁止新的关联变更，空闲后重新验证再转换。不重启承载本 agent loop 的服务器，不强杀用户任务；用户可以关闭助手后继续等待。

项目级动作的完成条件是**所有章节及项目依赖都处理完**。可以逐批转换并恢复，但任何 blocker 存在时不删除项目，不显示成功；已转换项不重复处理。

## 7. 权限与配置保真

- 执行至少需要 project canManage；这不自动授予对所有 narrator 分享/所有权/远端资源的改写权限。逐项通过现有授权体系，不把操作人变成所有会话 owner；owner 缺失由管理员明确处置。
- 用转换前“实际有效读/写主体”重建 standalone ACL，包括 project gate 与 narrator grant 的交集。旧无效 grants 不可在解绑后复活；public/private、读/写分离以及 subagent root 语义保持。
- 默认冻结当前明确授权的团队成员为会话 grants，确认页提示其后不再随项目成员变化。不能表达相同权限或共享资源 scope 时阻塞，不暗中 privatize 团队历史，也不公开会话。
- 解析有效项目+narrator traits、执行 deny/readOnly、例程 modes/工具开关、技能根、commands 及设备授权，保存为普通会话/资源支持的配置。用户层仍动态解析；不要把某一次 acting-user 配置冻结给其他人。
- 项目层的约束要保持约束语义，而不是随意并入能被 narrator override 覆盖的字段；必要时新增独立 inherited policy 层。设备注入不是设备授权，必须分别处理。
- 项目知识库、技能/例程定义、ACL grants 等项目外键逐表盘点。资源原地迁移或导出到等效授权容器；不能把 cascade 当清理策略。未实现这种接管前项目不可删除。
- CAS 后刷新会话运行时并读回验证，确认继续对话、权限判定、工具及 cwd 都不依赖旧 project/chapter。转换不插入假消息，不压缩/复制历史。

## 8. 后台状态机与失败恢复

`queued → sync_disabling → draining → planning → waiting_safe_point/blocked → adopting_resources → converting → verifying → deleting_metadata → cleaning_db → completed`

- 完整预检先构建所有 chapter/context/资源/外部引用依赖清单。章节创建、fork、wake、删除及 scope 修改在迁移期间统一 admission gate，避免清单不断变化。
- 每批转换用短事务：检查 narrator/workspace/ownership/ACL revision，写配置/claims/映射，更新关联和 cursor。历史正文无需复制或整库哈希。
- SQLite 事务不覆盖 Git、FS、worker 等副作用。每个副作用前后写 receipt，重启按 phase/cursor/epoch 续跑，不能靠内存 flags 保证安全。
- 项目删除前验证零遗留关联、所有继承依赖已接管、运行时不引用旧章节、资源 claim 有效。专用 metadata cleanup 不调用现有 destructive remove，不广播会触发旧删除消费者的事件。
- 删除旧 project/chapter 元数据分有限批次，结果映射和 gate/tombstone 独立保存；项目删除后 sync gate 仍拒绝旧事件和旧 job。
- 已完成转换不做破坏性自动回滚。失败项目停留为不可新增旧域资源的兼容壳，允许普通会话继续使用已迁移配置；未完成项保留原授权和数据。
- DB 删除失败标记 cleaning_db/cleanup_pending，可重试，不恢复 sync。只有实际完成文件处理才标 completed。

## 9. 性能与运行边界

建议初始预算（实现时以压测校准）：列表每页 50、最大 200；HTTP 摘要上限 256 KiB；子进程输出 1 MiB、单次 30 秒；drain 默认 30 秒到期返回可重试等待；每批至多 50 条元数据更新，主线程事务目标低于 20 ms，超出记录慢操作并缩批。

- 主库不跑全库 integrity/dbstat/FTS rebuild，不加载 raw_dump/output/content 等大字段。预检用索引和 cursor，不先 COUNT 全部历史。
- 文件检查、目录身份验证、checkpoint/独立 DB 文件清理等潜在慢操作用 worker/subprocess；主线程连接关闭与 coordinator 配合，避免多秒 busy handler/checkpoint 阻塞。
- coordinator 最多一个 job/项目，实例级初始并发 1；其他项目继续正常服务。
- 支持取消未开始阶段/暂停后续批次；drain 开始后保持 sync disabled，转换已提交部分不得假装回滚。
- WS 每 250 ms 合并进度，只传阶段/计数/失败代码；任务详情分页，不累计广播巨大 JSON。
- 记录阶段耗时、主线程延迟、sync attempts/writes/skips、重试次数及字节预算，日志不含消息正文。日志和 receipts 设保存上限。

## 10. 实施顺序与验收

### A. 先止血：生产 sync coordinator + 单独停用入口

覆盖缓存命中、direct open、事件、调度 timer、全量 worker 和重启恢复。验收：disable+drain 后持续发消息/改标题/fork/手动 sync 都不会写或重建独立 DB；迁移尚未完成也成立。对照 idle/消息流/大历史场景测事件循环延迟，确认同步调用计数归零。

### B. 助手与只读预检

实现 shared panel、dock/drawer、旧链接识别、权限门禁与分页 dependencies。替换原“入口无 mutation”守卫的具体期望，但继续要求无用户确认不得写入。不把 fixture planner 标为生产功能。

### C. 生产保留式转换与完整依赖接管

先用本地空闲、无共享资源的案例贯通状态机；再补共享 ACL、休眠/空章节、目录 override/远端、资源运行时、快照、配置、计划任务和外部授权。所有类别支持或给出明确可执行解除 blocker 流程，才开放项目级最终删除。

### D. 删除旧元数据与精准 DB 清理

最后上线最终按钮的完整闭环，重启恢复及幂等验收后再扩展到更多后端。PG/resource registry 支持尚需实现，不因 SQLite 通过便承诺 PG 可用。

验收用 `bun test --isolate`，覆盖：

1. 同章多会话/多用户、子代理与 lazy fork：ID、refs/seq、附件、spec、工具记录保留，继续对话/历史回退可用。
2. 多章节/空章节/休眠/已归档、cwd override、共享目录、远端离线：不删除目录、不悄悄唤醒或改设备、不产生 home fallback。
3. shared/private/public、旧失效 grant、无 owner、project deny/readOnly、设备与技能/例程：不扩权，不静默丢团队访问。
4. running/queued/permission wait、并发 chapter mutation、ownership revision 变化：等待或 409，不半解绑可执行。
5. worker 写入与 disable/close/unlink 交错、缓存命中及 direct open、同物理 DB 多项目：不重建、不删仍使用的文件。
6. 每个阶段 fault injection/进程中断、HTTP 重复确认、断线恢复：job 幂等、cursor 可续跑、失败数据仍有归属。
7. 终端/容器卷/快照/ignored-file 归档、知识库/任务/OAuth：没有通过 FK cascade 静默删除；未接管项目不得完成删除。
8. 无权限成员不可预检隐藏内容/执行/读取映射；迁移后旧书签可安全跳转。
9. 大项目预算测试：分页输出有界、主线程事务有限、WS 节流；同步停用后健康请求及会话响应不因清理被长期阻塞。

## 11. 明确不做

- 不恢复退役画布/Ruler 功能，不为迁移修复旧章节交互。
- 不调用当前 project DELETE，不删除任何用户仓库、worktree、分支、容器 volume 或主数据库。
- 不在页面打开时自动执行迁移；不未经确认停用全部项目同步。
- 不把失败/blocked/仅停 sync 描述成“所有章节已转换”。

## 12. 第一批实现与工作审视报告

### 原定目标

打开旧章节进入助手；最终支持整个叙事线全部章节保留式转换、删除旧元数据、解除 sync 并清理独立 DB。第一批并不等于整个目标完成。

### 完成情况

- 已完成：共享 Drawer，章节/叙述者/项目三个入口、明确确认、仅停止同步、失败反馈、完成结果刷新恢复和旧章节映射。桌面也暂用 Drawer，未新建画布。
- 已完成：持久 `legacySyncDisabled`、项目及 canonical repository root 门禁、receipt 墓碑、所有备份写入口 tracking、worker 排空、hot-reload 安全和失败后保持停用。[协调器](../server/services/project-db-sync-coordinator.ts)、[连接管理](../server/lib/project-db.ts)。
- 已完成：严格有界预检、revision CAS、单项目互斥、原地保留全部 ID/历史/parent/refs、持久清理回执、重试及精准备份处理。[服务核心](../server/services/legacy-project-migration-core.ts)、[生产授权适配](../server/services/legacy-project-migration.ts)。
- 已完成：SQLite 三条增量迁移、PG 两条增量迁移均按官方脚本生成，未手工修改 SQL。PG 仅生成 schema/谱系，新增运行接口仍明确拒绝 PG。
- 未完成：活跃章节 worktree/历史 shadow 接管、终端/容器/卷运行时、共享 ACL 和项目继承策略、远端及外部授权、计划任务、超过安全预算的后台分批迁移。此类项目现在只允许独立停用 sync，完整转换返回具体 blocker。

### 当前转换范围（不是全量支持）

SQLite；root 或 dormant、非 review；本地明确且有效的绝对 cwd；private owner/owner 写权限；无共享 grants、项目配置、独立 worktree、shadow/容器/终端/知识库等依赖；没有缓存运行时、持久队列或活跃后代；元数据在安全预算内。子代理/variant/context-only 关联会有界枚举，保留既有关系，不通过改 type 或删历史来转换。

`archivePath` 的持久契约为 canonical **Git repository root**，不是 `.narrafork` 目录。实际删除路径单独拼接 `.narrafork/project.db`、`-wal`、`-shm`；回执同时保存 root/directory/file identity。无法验证备份归属、身份缺失或变更时保留文件及项目壳。

### 发现的问题与纠正

| 严重程度 | 具体问题 | 原因 | 已落实的纠正 |
| --- | --- | --- | --- |
| 必须改正 | 清理初稿只认 `project.db` 文件名 | 把预期文件位置当成归属证据 | 只读 worker 有界校验备份格式及唯一 project ID，校验线程退出才授权删除；最大并发 2 |
| 必须改正 | receipt 校验后重新 stat，自比较产生新的删除授权 | 未将原始授权贯穿每个异步阶段 | unlink 前重新核验持久 root/directory/file identity，补“第二次取样窗口替换”故障注入测试 |
| 必须改正 | 项目删除后访问结果仍依赖旧项目 canManage | 混淆操作权限与历史回执读取权限 | 仅确定 404 时只读探测独立授权的回执；目标链接按当前 narrator ACL 过滤；401/403 不消费旧缓存 |
| 必须改正 | 后端旧链接结果曾返回复数 IDs，而前端读取单一 target | 跨模块契约未用生产层测试验证 | 统一 `narratorId: string | null`，优先可读 primary，增加生产适配测试 |
| 后续实现 | 普通关闭仍可能触发 SQLite last-close 自动 checkpoint | 只移除了显式 TRUNCATE，尚未实现 worker 连接交接 | 不承诺关闭阶段完全无主线程 I/O；后续用大备份验收并增加关闭交接 |

### 做得好的地方与验证证据

- 不复用 destructive project/chapter 删除服务，不触碰真实用户数据库、不重启承载会话的进程。
- 154 项相关测试在同一次 `bun test --isolate` 中通过，覆盖 18 文件；不是全仓测试通过的声明。
- TypeScript 全仓检查通过；Biome 实际检查 41 个改动源码文件，处理数非零。
- 最终前端构建通过；SQLite 迁移资产检查和 PG 谱系检查通过；i18n 检查无新增缺失键，保留的旧命名空间/额外键警告未冒充本次修复。
- 尚未运行完整发布 smoke/真实 PG 迁移或大生产数据库性能压测，不把这些列为已验收。

### 下次重点关注

优先扩大本地普通章节适用范围：先验证 root/main-checkout 的 cwd 与 workspace 上下文等效转换，再接入独立 worktree 和 shadow 的持久归属；随后补共享 ACL/策略以及终端容器资源运行时。不能用要求用户删除资源/权限/历史来代替接管，也不能把“明确 blocker”当成全部章节转换完成。

继续开发时以本节及 Dynamic Spec 中剩余任务作为上下文；如需在另一会话中落实改进，可将本报告作为上下文粘贴进去。

## 13. 第二批：main-checkout 根章节接管

### 已实现

- [根章节只读计划](../server/services/legacy-main-checkout-adoption.ts)：可验证的普通主工作树不制造独立 worktree；物化 cwd 和 local workspace context，保留物理 namespace，revision 与上下文同事务推进。unborn/非 main 分支、dirty 和用户文件不被改写；linked/bare/gitfile/symlink/远端/未知身份不放行。
- [严格历史检查](../server/services/legacy-root-history.ts)：只读 SQLite worker，共享 refs/lazy 祖先、章节边界、工具和文件变更依赖、物理 shadow 对象及 refs 均有累计预算；只有明确 `empty` 可进入接管。现在保守地把 Git 提交索引/提交边界与所有工具记录也作为 history，尚未声称覆盖常见有历史的根章节。
- [非打断缓存接管](../server/services/legacy-migration-runtime.ts)：完整目标生命周期 admission；只卸载证明空闲且仍为同一实例的缓存，持久化 conversation ID CAS，不 abort、不清队列/审批、不关闭 browser/terminal/container。有效持久 context 优先，卸载前 runtime cwd/device 观察保留到事务窗口结束。
- 事务内复核所有 history guards、章节历史标量及 indexed physical scope/snapshot 存在性；检查/提交窗口发生主连接写入则返回 stale，不能把旧“无历史”结论作为新授权。
- [回退兼容桥](../server/services/legacy-workspace-rollback-bridge.ts)：目录身份不变的退役不是跨目录回退，持久化迁移证明允许后续普通文件回退；任意后续 workspace 切换、目录替换、Git namespace 替换或绑定变化仍拒绝。桥只证明物理 lineage，不替代权限检查。
- 停用时独立保存 canonical-root 墓碑，项目 gitPath 修改、普通删除及进程重启均不让旧目录自动恢复 legacy sync。

### 真实集成中发现并修复

1. SQLite 文本 `substr(snapshot_shadow_key)` 会截断 `local\0path`；改用 BLOB 字节长度限制后读取完整 key，验证 NUL 后路径不能被同 device 前缀冒充。
2. sync flag/tombstone 的正常写入会改变 DB/WAL 时间戳，不是历史变化；采用稳定主 DB 文件身份和 scoped history/guards，不把瞬态 WAL 当跨检查的版本证据。
3. 检查后新 scope 或未触碰 narrator counters 的章节标量可导致错误“empty”；增加提交守卫、物理 scope 索引和外部连接故障注入测试。
4. 仅比较 cwd inode 无法识别 `.git` 替换；保存 Git directory 身份并在回退前重新确认 ordinary main checkout、git/common-dir 与 keys。

### 验收与边界

- 本次合并回归：319 项相关测试，28 文件，同一次 `--isolate` 全绿；不是全仓测试声明。
- 全仓 TypeScript 通过；Biome 实际检查 57 个改动源码文件；SQLite 200 条迁移资产及 PG 15 条谱系检查通过。
- 新增结构仍由官方 generator 生成，没有操作真实用户 DB 或服务器进程。
- **仍未完成全量迁移**：有真实历史（含当前保守分类的提交索引/工具记录）、独立 worktree、共享 ACL、项目策略/hooks、终端容器卷、远端和外部绑定仍是明确 blocker。下一步必须建立保留式历史/资源接管，而不是要求用户删除历史或私有化团队工作来通过。
