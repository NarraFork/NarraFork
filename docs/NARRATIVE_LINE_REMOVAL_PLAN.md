# 叙事线退役计划

> 状态：草案，待评审。本文只描述计划，本分支在评审通过前不改代码和数据。

## 目标

- 删除整条叙事线：章节、章节边、画布（classic 故事网络图）、尺子（ruler）、章节内的分叉/合并/拆分/评审。
- 保留简化版项目（目录 + 会话，`frontend/routes/projects/$projectId.tsx`），界面上统一叫“项目”。
- 旧的章节会话最终变成“项目下的普通会话”：会话 id、消息、历史都不变。

## 不在范围内

- 项目本身（`projects` 表、成员与权限、技能、例程、命令、知识库）全部保留。
- `projects.chapterSettings` 名字带 chapter，但存的是项目级配置（例程工具模式、技能等，见 `server/services/routine-service.ts`、`skill-service.ts`）。它是活跃配置，保留；列名重命名需要迁移，不在本计划内。
- 会话自己的 worktree（`narrator-worktree-*`）、tree 快照、文件回退保留，它们不依赖章节。

## 现状

### 新会话已经不建章节

项目页里新建会话走 `contextProjectId`，`chapterId` 为空（`server/routes/narrators.ts:1331`）。仍会写 `chapterId` 的路径只剩旧章节会话派生出来的：

- 子代理继承父会话的章节（`server/services/narrator-service.ts:1837`）。
- 从章节会话 fork 到章节（`narrator-service.ts:2766`）。
- 章节的 fork / merge / split / review 等操作本身。

所以“停止产生新章节”只需要关掉上面这些入口，不影响普通会话。

### 资源表已经有非章节的归属方式

终端、终端视图状态、容器实例、端口分配、快照应用都已经有 `worktreeResourceId` 列，并有 CHECK 约束保证“挂章节”和“挂 worktree 资源”二选一（`server/db/schema.ts` 中 `terminals`、`terminalViewState`、`containerInstances`、`portAllocations`、`volumeSnapshotApplications`）。旧数据转换时，这些资源的目标归属已经存在，不需要新设计。

### 指向 `chapters` 的外键

| 表 | 列 | 删除行为 | 处理方式 |
|---|---|---|---|
| `chapter_edges` | 两端章节 | cascade | 随章节删除 |
| `chapter_commits` | `chapter_id` | cascade | 随章节删除 |
| `narrators` | `chapter_id` | 无 | 转换时清空，改用 `contextProjectId` |
| `terminals` | `chapter_id` | cascade | 改挂 `worktreeResourceId` 或会话 |
| `terminal_view_state` | `chapter_id` | cascade | 同上 |
| `container_instances` | `chapter_id` | cascade | 改挂 `worktreeResourceId` |
| `port_allocations` | `chapter_id` | cascade | 跟随容器 |
| `merge_sessions` | `target_chapter_id` | cascade | 功能删除，进行中的需先结束 |
| `volume_snapshots` | `source_chapter_id` | set null | 只是来源记录，置空即可 |
| `volume_snapshot_applications` | `chapter_id` | cascade | 改挂 `targetWorktreeResourceId` |
| `review_conclusions` | 评审/来源章节 | cascade | 取决于决策 D2 |
| `gateway_session_mappings` | `chapter_id` | set null | 置空即可 |
| `scheduled_tasks` | `chapter_id` | set null | 先改成指向会话或项目，否则任务失去目标 |

`projects.flowMode`（classic/ruler）在功能删除后没有读者，最后随 schema 清理删除。

### 代码规模（main @ 6ff0a4ee）

- 服务端非测试文件中提到 chapter 的有 213 个；前端 182 个；相关测试文件 248 个。
- 可整体删除的主要模块：
  - 前端：`frontend/components/chapter/`、`graph/`、`ruler/`（合计约 1.4 MB 源码）；路由 `routes/chapters/`、`routes/git/chapters/`、`routes/windows/git/chapters/`；`hooks/useChapters.ts`、`lib/api/chapters.ts`。
  - 服务端：路由 `chapters.ts`、`chapter-edges.ts`、`graph.ts`、`ruler.ts`、`reviews.ts`、`project-db.ts`；服务 `chapter-*.ts`、`chapter-write/`、`ruler-anchor-fallback.ts`、`merge-summary-service.ts`、`review-service.ts`、`review-event-handler.ts`、`project-db-sync*.ts`（取决于 D4）。这些路由和服务合计约 1.4 万行。
- 不能整体删、需要逐处改的：`narrator-service.ts`、`narrator-session.ts`（上下文逐层继承里的章节层）、`narrator-acl.ts`（项目可见性先查章节再查 `contextProjectId`）、worktree 生命周期/清理、tree 快照与 shadow GC、容器/终端运行时、计划任务。

## 需要先定的决策

**D1 旧数据怎么处理**（上一轮讨论的三个选项）
- (a) 删功能和代码，章节表只读保留，旧会话按普通会话显示和使用。
- (b) 在 (a) 之后用迁移删表。删表需要你明确授权。
- (c) 先把旧会话转换成普通会话（阶段 3），再删表。

建议：先做 (a)，转换验证通过后再做 (c) 的删表部分。

**D2 评审（review）**：评审节点本身是一个章节，`conclude_review` 工具和 `review_conclusions` 依赖它。选项：整体删除；或改成“会话级评审”（另立需求，不在本计划内）。建议整体删除，已有评审会话按普通会话保留，结论记录只读。

**D3 项目内合并 / cherry-pick / 拆分**：全部是章节之间的 git 操作。建议整体删除；需要合并时用户在会话里直接用 git。

**D4 `project.db` 归档同步**（`project-db-sync.ts`）：按章节把主库导出到项目目录下的可携带文件。建议删除，删除前停掉同步调度器，已有的 `project.db` 文件不自动删（删除用户文件需要单独确认）。

**D5 设置页 `/settings/chapters`**：里面混着章节专属项（最大 worktree 数、休眠分钟数）和通用项（最大容器数、tree 快照开关、大小警告、自动保存）。建议保留通用项，页面改名“工作区与容器”，章节专属项在确认没有会话 worktree 在用后删除。

## 分阶段

每一阶段单独一个 PR，CI 全绿再进入下一阶段。

### 阶段 1：改名和下线入口（只动前端，可回退）

- 4 处中文“叙事线”改为“项目”：`nav.json` 的 `projects`、`clearProjects`，`graph.json` 的 `storyNetwork`，`learning.json` 的 `subtitle`；`narrator.json` 的 `backToGraph`（“返回故事网络” / "Back to graph"）改为“返回项目” / "Back to project"。
- 去掉导航、会话页、命令面板里通往画布、尺子、章节页的入口。
- `/chapters/$chapterId` 和 git 子路由保留为重定向：有主会话跳会话，没有跳项目页（复用 `frontend/components/project/legacy-chapter-redirect.ts`）。
- 项目页的兼容面板（`ProjectCompatibilityPanel`、`LegacyResourceRecovery`）先保留，这是旧章节资源的唯一恢复入口，阶段 3 完成后再删。

### 阶段 2：服务端停止产生新章节

- 删除或关闭创建章节的接口：新建章节、fork 到章节、merge、split、cherry-pick、review 创建。
- 旧章节会话的子代理和 fork 改为生成普通会话（`chapterId: null`，继承 `contextProjectId`）。
- 删除前端对应的组件、hooks、API，以及阶段 1 已断开入口的画布/尺子代码。
- 删除对应测试（含 `ruler-anchor-fallback.test.ts`、`chapter-*.test.ts` 等）。按 docs/TESTING.md，删除或移动被 `readFileSync` 守卫测试引用的文件后，全仓搜索旧路径字符串。
- 读路径（列出旧章节、恢复资源、只读查看）保留到阶段 3。

### 阶段 3：旧章节会话转换为普通会话

后台任务，分批、可续跑、可中断，不在请求里做，不用大事务（CLAUDE.md 主线程规则）。每批处理前检查会话是否处于安全点：没有在运行、排队、等审批，也没有活跃子代理；不满足就跳过，下批再试。

按章节状态分三类，一类做完验证通过再做下一类：

1. **空章节**（没有会话）：只有元数据，直接标记为已退役。
2. **休眠章节**（worktree 已移除，只剩分支）：会话 `chapterId` 置空、`contextProjectId` 设为项目、cwd 设为项目目录；分支保留不动，不唤醒、不重建 worktree。在会话里提示原分支名。
3. **活跃章节**（有 worktree）：把 worktree 登记为会话的 worktree 资源（`narrator-worktree-resources`），终端/容器/端口/快照应用改挂 `worktreeResourceId`，然后再改会话归属。顺序必须是“先登记接管、再解除章节”，否则清理逻辑会把 worktree 当孤儿删掉，未提交改动丢失。

每类都要额外处理：

- **tree 快照与 shadow**：章节的 `snapshotShadowKey` 和快照引用先登记到会话名下，并改 shadow GC 的判断，否则旧会话的历史回退失效或快照被提前回收。
- **配置继承**：章节层若有自己的设置，先固化到会话上，避免转换后 cwd、traits、例程、技能解析结果变化。
- **权限**：会话仍在同一项目下，项目成员权限不变；`visibility: "project"` 的解析从“查章节”切到 `contextProjectId`，两者指向同一项目，结果应一致。转换前后各算一次有效权限并比对，不一致的跳过并记录。
- **计划任务**：指向章节的任务改为指向该章节的主会话；没有主会话的停用并通知创建者。
- **进行中的合并会话**：存在时该章节不转换，记录原因，留给用户处理。

每个会话转换都写一条回执（转换前的 `chapterId`、worktree、资源 id），用于核对和出错后重放。

### 阶段 4：删除剩余代码

- 删除兼容面板、旧章节读路径、`narrator-session.ts` 里的章节继承层、`narrator-acl.ts` 的章节分支、worktree/快照/容器/终端运行时里的章节分支。
- 按 D4、D5 处理 `project.db` 同步和设置页。
- 更新 CLAUDE.md（删除“章节拆分”“章节边”“故事网络图”“Ruler 模式”等条目，worktree 条目改为会话 worktree）和相关 docs。

### 阶段 5：schema 清理（需要你明确授权）

- 在 `server/db/schema.ts` 删除 `chapters`、`chapter_edges`、`chapter_commits`、`merge_sessions`、相关外键列、`projects.flowMode` 和只服务章节的 CHECK 约束，然后 `bun run db:generate`；PG 侧按 CLAUDE.md 的 `db:generate:pg` 流程。不手改 `drizzle/`。
- FTS5 里章节的索引和触发器在 `server/db/fts.ts` 同步删除。
- 迁移前确认阶段 3 的回执覆盖了所有章节会话，且没有残留引用。

## 每个 PR 的验证

- `bunx tsgo --noEmit`、`bunx @biomejs/biome check .`。
- 只跑与改动相关的测试：`bun test --isolate <路径>`；全量交给 CI。
- 阶段 3 额外需要：用旧数据的 SQLite 副本（不碰 `~/.narrafork/narrafork.db`）跑一遍转换任务，核对回执、会话可打开、历史回退可用、worktree 未丢改动。

## 风险

- **worktree 丢改动**：阶段 3 第 3 类最危险。缓解：先登记接管再解绑；转换前记录 `git status` 摘要，有未提交改动的章节可以选择留到最后单独处理。
- **级联删除**：阶段 5 删 `chapters` 会级联删掉仍挂章节的终端、容器等记录。缓解：阶段 5 前检查所有带 `chapter_id` 的表行数为 0。
- **运行中的 NarraFork 进程**：转换任务不得停止或重启 `bun run start:dev` 启动的进程；需要重载时由用户操作。
- **参考**：废弃分支 `origin/abandoned/chapter-retirement-migration`（`42874fd2`）的 `docs/CHAPTER_RETIREMENT_MIGRATION_DESIGN.md` 记录了“转换并删除项目”这一更难版本的问题。本计划保留项目，权限和项目级资源搬迁那部分不再需要。
