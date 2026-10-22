# 叙事线退役计划

> 状态：决策已定（见“已定决策”），数据迁移 SQL 的写法待确认。

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

终端、终端视图状态、容器实例、端口分配、快照应用都已经有 `worktreeResourceId` 列，并有 CHECK 约束保证“挂章节”和“挂 worktree 资源”二选一（`server/db/schema.ts` 中 `terminals`、`terminalViewState`、`containerInstances`、`portAllocations`、`volumeSnapshotApplications`）。按 D1 直接删表后，挂章节的这些行随级联删除；挂 `worktreeResourceId` 的行不受影响。

### 指向 `chapters` 的外键

| 表 | 列 | 删除行为 | 处理方式 |
|---|---|---|---|
| `chapter_edges` | 两端章节 | cascade | 随章节删除 |
| `chapter_commits` | `chapter_id` | cascade | 随章节删除 |
| `narrators` | `chapter_id` | 无 | 删表前的数据迁移里清空，回填 `contextProjectId`（D1a） |
| `terminals` | `chapter_id` | cascade | 随删表删除（D1a） |
| `terminal_view_state` | `chapter_id` | cascade | 同上 |
| `container_instances` | `chapter_id` | cascade | 随删表删除（D1a） |
| `port_allocations` | `chapter_id` | cascade | 随删表删除（D1a） |
| `merge_sessions` | `target_chapter_id` | cascade | 随删表删除（D3） |
| `volume_snapshots` | `source_chapter_id` | set null | 只是来源记录，置空即可 |
| `volume_snapshot_applications` | `chapter_id` | cascade | 随删表删除（D1a） |
| `review_conclusions` | 评审/来源章节 | cascade | 随删表删除（D2） |
| `gateway_session_mappings` | `chapter_id` | set null | 置空即可 |
| `scheduled_tasks` | `chapter_id` | set null | 数据迁移里改指向主会话，否则停用 |

`projects.flowMode`（classic/ruler）在功能删除后没有读者，最后随 schema 清理删除。

### 代码规模（main @ 6ff0a4ee）

- 服务端非测试文件中提到 chapter 的有 213 个；前端 182 个；相关测试文件 248 个。
- 可整体删除的主要模块：
  - 前端：`frontend/components/chapter/`、`graph/`、`ruler/`（合计约 1.4 MB 源码）；路由 `routes/chapters/`、`routes/git/chapters/`、`routes/windows/git/chapters/`；`hooks/useChapters.ts`、`lib/api/chapters.ts`。
  - 服务端：路由 `chapters.ts`、`chapter-edges.ts`、`graph.ts`、`ruler.ts`、`reviews.ts`、`project-db.ts`；服务 `chapter-*.ts`、`chapter-write/`、`ruler-anchor-fallback.ts`、`merge-summary-service.ts`、`review-service.ts`、`review-event-handler.ts`、`project-db-sync*.ts`（D4）。这些路由和服务合计约 1.4 万行。
- 不能整体删、需要逐处改的：`narrator-service.ts`、`narrator-session.ts`（上下文逐层继承里的章节层）、`narrator-acl.ts`（项目可见性先查章节再查 `contextProjectId`）、worktree 生命周期/清理、tree 快照与 shadow GC、容器/终端运行时、计划任务。

## 已定决策（2026-10-22）

- **D1 旧数据：直接删表。** 不做逐类资源接管的后台转换；章节相关表通过迁移删除。
- **D1a 旧章节里的会话：保留为项目下的会话。** 删表前把 `narrators.chapter_id` 清空，`context_project_id` 设为章节所属项目，cwd 设为项目目录；会话和消息都保留。挂在章节上的终端、终端视图状态、容器、端口、快照应用、合并会话记录随删表级联删除。
- **D1b 磁盘上的旧 worktree 和章节分支：原样保留。** 只删数据库记录，不删目录和分支；同时保证任何清理逻辑都不会把它们当孤儿删掉，由用户自行处理。
- **D2 评审：整体删除。** 删除评审创建、`conclude_review` 工具和相关界面；已有评审会话按 D1a 保留为普通会话，`review_conclusions` 随删表删除。
- **D3 项目内合并 / cherry-pick / 拆分：整体删除。** 需要时在会话里直接用 git。
- **D4 `project.db` 归档同步：删除同步功能，已有的 `project.db` 文件不自动删除。**
- **D5 设置页 `/settings/chapters`：保留通用项（最大容器数、tree 快照开关、大小警告、自动保存），页面改名“工作区与容器”。** 章节专属项（最大 worktree 数、休眠分钟数）在确认会话 worktree 不依赖后删除。

### 待确认的实现点：数据迁移 SQL

D1a 的“清空 `chapter_id`、回填 `context_project_id` 和 cwd”必须和删表在同一个迁移里执行：`bun run start` 先跑迁移再启动应用，如果只靠应用启动时的回填，跨版本直接升级的用户会在回填前就丢掉 `chapter_id`，无法再知道会话属于哪个项目。

drizzle-kit 不会从 schema 差异生成这种数据 UPDATE。可行做法是用 `drizzle-kit generate --custom` 生成一个空的自定义迁移，在其中写 UPDATE，排在删表迁移之前；PG 侧对应用 `db:generate:pg` 的自定义迁移。CLAUDE.md 禁止手改 `drizzle/` 下的文件，这一步需要你确认“由工具生成的空自定义迁移里填写 SQL”是否允许。

## 分阶段

每一阶段单独一个 PR，CI 全绿再进入下一阶段。

### 阶段 1：改名和下线入口（只动前端，可回退）

- 4 处中文“叙事线”改为“项目”：`nav.json` 的 `projects`、`clearProjects`，`graph.json` 的 `storyNetwork`，`learning.json` 的 `subtitle`；`narrator.json` 的 `backToGraph`（“返回故事网络” / "Back to graph"）改为“返回项目” / "Back to project"。
- 去掉导航、会话页、命令面板里通往画布、尺子、章节页的入口。
- `/chapters/$chapterId` 和 git 子路由保留为重定向：有主会话跳会话，没有跳项目页（复用 `frontend/components/project/legacy-chapter-redirect.ts`）。
- 项目页的兼容面板（`ProjectCompatibilityPanel`、`LegacyResourceRecovery`）先保留，这是旧章节资源的唯一恢复入口，阶段 3 删除。

### 阶段 2：服务端停止产生新章节

- 删除或关闭创建章节的接口：新建章节、fork 到章节、merge、split、cherry-pick、review 创建。
- 旧章节会话的子代理和 fork 改为生成普通会话（`chapterId: null`，继承 `contextProjectId`）。
- 删除前端对应的组件、hooks、API，以及阶段 1 已断开入口的画布/尺子代码。
- 删除对应测试（含 `ruler-anchor-fallback.test.ts`、`chapter-*.test.ts` 等）。按 docs/TESTING.md，删除或移动被 `readFileSync` 守卫测试引用的文件后，全仓搜索旧路径字符串。
- 读路径（列出旧章节、恢复资源、只读查看）保留到阶段 3。

### 阶段 3：删除剩余章节代码

- 删除兼容面板（`ProjectCompatibilityPanel`、`LegacyResourceRecovery`）、旧章节读路径和 `/chapters/$chapterId` 等重定向以外的章节路由。
- `narrator-session.ts` 删掉上下文继承里的章节层；`narrator-acl.ts` 的项目可见性只看 `contextProjectId`。
- worktree 生命周期、tree 快照与 shadow GC、容器、终端运行时、计划任务里的章节分支全部删除。
- **worktree 清理守卫（D1b）**：检查 worktree 清理、孤儿扫描、shadow GC 的判断条件，确保没有了章节记录之后，`<gitPath>/.worktrees/` 下的旧目录和章节分支不会被当作孤儿删除。为此补测试。
- 删除 `project-db-sync*.ts`、`server/routes/project-db.ts` 及其调度器（D4），不碰磁盘上已有的 `project.db`。
- 设置页按 D5 处理。
- 更新 CLAUDE.md（删除“章节拆分”“章节边”“故事网络图”“Ruler 模式”等条目，worktree 条目改为会话 worktree）和相关 docs。

### 阶段 4：迁移删表（已获授权：D1）

一个 PR 内两个迁移，顺序执行：

1. **数据迁移**（见上文“待确认的实现点”）：
   - `narrators`：`context_project_id = chapters.project_id`（原值为空时）、cwd 设为项目目录、`chapter_id = NULL`；会话的 `visibility` 若是 `project`，因为仍在同一项目下，语义不变。
   - `scheduled_tasks`：指向章节的任务改指向该章节的主会话；没有主会话的置为停用。
   - 子代理会话同样处理（它们也带 `chapter_id`）。
2. **schema 迁移**：在 `server/db/schema.ts` 删除 `chapters`、`chapter_edges`、`chapter_commits`、`merge_sessions`、`review_conclusions`、各表的 `chapter_id` 列与只服务章节的索引和 CHECK 约束、`projects.flowMode`，然后 `bun run db:generate`；PG 侧按 CLAUDE.md 的 `db:generate:pg` 流程。FTS5 里章节的索引和触发器在 `server/db/fts.ts` 同步删除。

注意：

- SQLite 删列会重建表。`narrators` 不含消息内容，行数有限；终端、容器等表的章节行会随之删除（D1a 已接受）。
- 迁移在启动前执行，不经过应用代码，所以进行中的会话、终端、容器不会在迁移中被“安全点”保护。升级前应让用户停掉章节会话里的活跃运行；这一点写进 changelog。

## 每个 PR 的验证

- `bunx tsgo --noEmit`、`bunx @biomejs/biome check .`。
- 只跑与改动相关的测试：`bun test --isolate <路径>`；全量交给 CI。
- 阶段 4 额外需要：在带章节数据的 SQLite 副本上跑迁移（不碰 `~/.narrafork/narrafork.db`），核对：所有原章节会话的 `context_project_id` 已回填且可打开；没有残留 `chapter_id` 引用；磁盘上的 worktree 目录和章节分支仍在。PG 同样验证一遍。

## 风险

- **worktree 被误删**：删表后旧 worktree 目录不再有数据库记录，任何“没有记录就清理”的逻辑都会删掉其中未提交的改动。缓解：阶段 3 的清理守卫和测试，阶段 4 验证目录仍在。
- **级联删除的不可逆**：终端、容器等章节资源记录和评审结论随删表消失，无法恢复。升级说明里写明，建议升级前备份数据库。
- **级联删除**：阶段 5 删 `chapters` 会级联删掉仍挂章节的终端、容器等记录。缓解：阶段 5 前检查所有带 `chapter_id` 的表行数为 0。
- **运行中的 NarraFork 进程**：开发和验证过程中不得停止或重启 `bun run start:dev` 启动的进程；需要重载时由用户操作。
- **参考**：废弃分支 `origin/abandoned/chapter-retirement-migration`（`42874fd2`）的 `docs/CHAPTER_RETIREMENT_MIGRATION_DESIGN.md` 记录了“转换并删除项目”这一更难版本的问题。本计划保留项目并直接删表，权限、项目级资源搬迁和逐类资源接管都不再需要。
