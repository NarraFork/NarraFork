# 叙事线退役与项目自动索引计划

> 状态：决策已定（见“已定决策”），待实施。本分支目前只有本文档。

## 目标

- 删除整条叙事线：章节、章节边、画布（classic 故事网络图）、尺子（ruler）、章节内的分叉/合并/拆分/评审。
- 保留简化版项目（目录 + 会话，`frontend/routes/projects/$projectId.tsx`），界面上统一叫“项目”。
- 项目改为轻量、无感、自动进入：会话属于哪个项目由它的工作目录推导，`projects` 表是可随时自动增补的索引。
- 索引从一开始就支持“一个会话多个工作目录”。

## 不在范围内

- 项目已有的能力（成员与权限、技能、例程、命令、知识库、traits、启动脚本等）全部保留，挂在项目行上不变。
- `projects.chapterSettings` 名字带 chapter，但存的是项目级配置（例程工具模式、技能等，见 `server/services/routine-service.ts`、`skill-service.ts`）。它是活跃配置，保留；列名重命名不在本计划内。
- 会话自己的 worktree（`narrator-worktree-*`）、tree 快照、文件回退保留，它们不依赖章节。
- “给会话添加第二个工作目录”的功能本身（界面、工具）不在本计划内；本计划只让索引和读取方支持多目录。
- 远程设备上的工作目录本计划不做自动索引（见“项目自动索引的设计”中的“范围限制”）。

## 现状

### 会话属于哪个项目

- 唯一的判断入口是 `server/services/narrator-project.ts` 的 `resolveNarratorProjectId`：先看章节，再看 `narrators.contextProjectId`。权限闸门、traits、例程、技能、设备都经过它或与它一致的逻辑。
- 新会话不建章节：项目页里新建会话时写 `contextProjectId`，`chapterId` 为空（`server/routes/narrators.ts:1331`），cwd 默认是项目目录，可见性默认 `project`（`server/lib/narrator-audiences.ts`）。
- 目前没有按 cwd 推导项目的逻辑（兼容面板注释也写明了这一点：`frontend/components/project/ProjectCompatibilityPanel.tsx:22`）。
- 项目页的会话列表按 `contextProjectId` 或所属章节过滤（`server/routes/narrators.ts` 列表接口的 `projectId` 分支）。

仍会写 `chapterId` 的路径只剩旧章节会话派生出来的：子代理继承父会话的章节（`narrator-service.ts:1837`）、从章节会话 fork 到章节（`narrator-service.ts:2766`），以及章节的 fork / merge / split / review 操作本身。

### 旧章节会话的工作目录

旧章节会话的 cwd 大多没有存在会话上，而是运行时算出：会话自己的 cwd → 章节 worktree 路径 → 根章节才用项目目录（`server/services/narrator-cwd.ts:17`，调用处 `narrator-session.ts` 的章节分支）。休眠章节的 worktree 已被移除，这类会话现在就算不出目录，走 `WORKSPACE_DIRECTORY_REQUIRED` 让用户选。

### 资源表已经有非章节的归属方式

终端、终端视图状态、容器实例、端口分配、快照应用都已有 `worktreeResourceId` 列，并有 CHECK 约束保证“挂章节”和“挂 worktree 资源”二选一。删表后挂章节的行随级联删除，挂 `worktreeResourceId` 的行不受影响。

### 指向 `chapters` 的外键

| 表 | 列 | 删除行为 | 删表后 |
|---|---|---|---|
| `chapter_edges` | 两端章节 | cascade | 随表删除 |
| `chapter_commits` | `chapter_id` | cascade | 随表删除 |
| `narrators` | `chapter_id` | 无 | 列删除，不回填（D1a） |
| `terminals` | `chapter_id` | cascade | 章节行删除 |
| `terminal_view_state` | `chapter_id` | cascade | 章节行删除 |
| `container_instances` | `chapter_id` | cascade | 章节行删除 |
| `port_allocations` | `chapter_id` | cascade | 章节行删除 |
| `merge_sessions` | `target_chapter_id` | cascade | 随表删除（D3） |
| `volume_snapshots` | `source_chapter_id` | set null | 列删除，只是来源记录 |
| `volume_snapshot_applications` | `chapter_id` | cascade | 章节行删除 |
| `review_conclusions` | 评审/来源章节 | cascade | 随表删除（D2） |
| `gateway_session_mappings` | `chapter_id` | set null | 列删除 |
| `scheduled_tasks` | `chapter_id` | set null | 列删除；`runContext = "chapter"` 的任务改按项目目录运行 |

`projects.flowMode`（classic/ruler）在功能删除后没有读者，随 schema 清理删除。

### 代码规模（main @ 6ff0a4ee）

- 服务端非测试文件中提到 chapter 的有 213 个；前端 182 个；相关测试文件 248 个。
- 可整体删除的主要模块：
  - 前端：`frontend/components/chapter/`、`graph/`、`ruler/`（合计约 1.4 MB 源码）；路由 `routes/chapters/`、`routes/git/chapters/`、`routes/windows/git/chapters/`；`hooks/useChapters.ts`、`lib/api/chapters.ts`。
  - 服务端：路由 `chapters.ts`、`chapter-edges.ts`、`graph.ts`、`ruler.ts`、`reviews.ts`、`project-db.ts`；服务 `chapter-*.ts`、`chapter-write/`、`ruler-anchor-fallback.ts`、`merge-summary-service.ts`、`review-service.ts`、`review-event-handler.ts`、`project-db-sync*.ts`。这些路由和服务合计约 1.4 万行。
- 不能整体删、需要逐处改的：`narrator-project.ts`、`narrator-service.ts`、`narrator-session.ts`、`narrator-acl.ts`、`project-acl.ts`、worktree 生命周期/清理、tree 快照与 shadow GC、容器/终端运行时、计划任务。

## 已定决策（2026-10-22）

叙事线删除：

- **D1 旧数据：直接删表。** 只用 `bun run db:generate` 生成的结构迁移，不写自定义数据迁移 SQL。
- **D1a 旧章节会话：不回填。** 不回填 `contextProjectId`，也不把算出来的 cwd 固化到会话上。会话和消息保留；自己存了 cwd 的会话由自动索引重新归入项目；没存 cwd 的会话再打开时提示选择工作目录，选完后由索引归入项目。挂在章节上的终端、容器、端口、快照应用记录随删表级联删除。
- **D1b 磁盘上的旧 worktree 和章节分支：原样保留。** 只删数据库记录，不删目录和分支；任何清理逻辑都不得把它们当孤儿删掉。
- **D2 评审：整体删除。** 删除评审创建、`conclude_review` 工具和相关界面；已有评审会话按普通会话保留，`review_conclusions` 随删表删除。
- **D3 项目内合并 / cherry-pick / 拆分：整体删除。** 需要时在会话里直接用 git。
- **D4 `project.db` 归档同步：删除同步功能，已有的 `project.db` 文件不自动删除。**
- **D5 设置页 `/settings/chapters`：保留通用项（最大容器数、tree 快照开关、大小警告、自动保存），页面改名“工作区与容器”。** 章节专属项（最大 worktree 数、休眠分钟数）在确认会话 worktree 不依赖后删除。

项目自动索引：

- **P1 目录归属：已有项目优先，否则 git 主仓库。** 先在已有项目目录里按最长前缀匹配；都不匹配时取 git 主仓库根目录（worktree 归到它的主仓库，子目录归到仓库根）。
- **P2 非 git 且不匹配已有项目的目录：不建项目，算独立会话。** 用户仍可手动把任意目录建成项目。
- **P3 多工作目录：只按主工作目录的项目算配置和权限。** 会话出现在所有关联项目的项目页里（按各自权限过滤），但配置继承（traits、例程、技能、设备）和会话的 `project` 可见性只看主工作目录的项目。给会话加目录不会把它暴露给另一个项目的成员。
- **P4 自动建的项目：首个进入者拥有，公开。** 一个目录只对应一个项目，后来的用户的会话也索引到这个项目。
  - 后果：公开项目对所有登录用户开放读，所以可见性为 `project` 的会话在这类项目里对所有登录用户可读。从项目页新建的会话默认就是 `project` 可见性。写权限不受影响：公开项目不给写，`project` 写权限仍需要项目写授权。
  - 自动索引本身不改任何会话的可见性；在项目页之外新建的会话默认 `private`，归入公开项目后仍然只有自己可见。

## 项目自动索引的设计

### 索引表

新表 `narrator_project_links`：

| 列 | 说明 |
|---|---|
| `narrator_id` | FK → narrators，cascade |
| `project_id` | FK → projects，cascade |
| `role` | `primary` / `additional`；每个会话至多一条 `primary`（部分唯一索引） |
| `source` | `cwd`（由工作目录推导）/ `explicit`（来自 `contextProjectId`） |
| `device_id` | 工作目录所在设备，本计划只写 `local` |
| `directory` | 推导时用的规范化目录 |
| `updated_at` | |

索引：`(project_id, narrator_id)` 供项目页列表，`(narrator_id)` 供按会话查询。

索引是会话自身数据（cwd、`contextProjectId`）的纯函数：任何时候都可以整表重建，重建会删除推导不出来的链接。

### 归属规则

`resolveProjectForDirectory(dir)`，只处理本机目录：

1. 规范化：绝对路径；存在时取 realpath；Windows 和 macOS 按文件系统大小写规则比较。
2. 在活跃项目的规范化 `gitPath` 中做最长前缀匹配，按路径段边界比较（`/a/b` 不匹配 `/a/bc`）。命中即返回。
3. 不命中时异步执行 `git -C <dir> rev-parse --path-format=absolute --git-common-dir`（超时 2 秒，限制输出）。结果以 `/.git` 结尾时，其父目录是主仓库根；bare 仓库或失败按非 git 处理。
4. 主仓库根存在：再按 2 查一次（防并发），仍不存在则建项目：名字取目录名，`gitPath` 为仓库根，`ownerUserId` 为会话所有者，`visibility = "public"`。
5. 非 git：不建项目，不产生链接（P2）。

并发建同一项目的去重：给 `projects` 加规范化根目录列 `root_key`，部分唯一索引（非空时唯一）。已有数据可能有多个项目指向同一 `gitPath`，`root_key` 由后台任务填写，重复时只给最早的那个填，其他保持空、不参与匹配。不在迁移里写数据。

### 主项目

- 有 `contextProjectId` 时，它就是主项目（`source = "explicit"`）。这保留外部授权会话（OAuth 预置）冻结的项目上下文语义，也覆盖项目页新建的会话。
- 否则主工作目录推导出的项目是主项目。
- 其余工作目录推导出的项目记为 `additional`（多工作目录功能上线后才会出现）。

### 何时更新

- 会话创建、工作目录提交（workspace revision 变化）、会话 worktree 资源创建：对该会话增量重算，几次小的带索引写入。
- 项目新建或 `gitPath` 变更：后台任务重算可能受影响的会话。
- 启动时：后台重建任务，按游标分页、每批有上限、可中断续跑，不阻塞主线程（CLAUDE.md 主线程规则）。
- git 探测在请求路径里只做带超时的异步子进程调用；同一目录的结果短时缓存。

### 读取方切换

- `resolveNarratorProjectId` 改为只读主链接，不再查章节。
- 项目页会话列表的 `projectId` 过滤改为 `EXISTS (narrator_project_links ...)`，任何角色的链接都算。
- 配置继承、权限闸门、`project` 可见性只经过 `resolveNarratorProjectId`，也就只看主项目（P3）。不允许在别处另写一份“会话属于哪个项目”。

### 范围限制

- 远程设备的工作目录：路径属于另一台机器，不能拿本机项目目录做前缀匹配，也不能在本机跑 git。本计划不为它们推导链接，只保留 `explicit` 来源；之后要支持时，需要在设备执行器上做 git 探测，并给项目加设备维度。
- 归档项目仍参与匹配，避免对同一目录重复建项目。

## 实施方式

不发布中间版本，所以不写任何过渡代码：一个 PR 直接做到最终状态，只保证两件事——最终状态正确，以及从当前发布版本直接升级上来正确。PR 内按提交分块，方便评审和定位 CI 失败；每个提交都应能通过类型检查和相关测试。期间定期把 main 合并进来（merge，不 rebase）。

### 提交 1：删除章节功能代码

- 前端：`components/chapter/`、`graph/`、`ruler/`，章节路由、`useChapters`、`lib/api/chapters.ts`，项目页兼容面板（`ProjectCompatibilityPanel`、`LegacyResourceRecovery`）。`/chapters/$chapterId` 及 git 子路由只留一个轻量重定向：有主会话跳会话，否则跳项目列表（旧链接、通知、书签还会指向它们）。
- 服务端：章节、章节边、图、尺子、评审（D2）、合并/cherry-pick/拆分（D3）、`project.db` 同步与调度器（D4）的路由和服务；`conclude_review` 工具。
- 逐处改：`narrator-session.ts`、`narrator-service.ts`（子代理、fork 不再写 `chapterId`）、`narrator-project.ts`、`narrator-acl.ts`、`project-acl.ts`（含 `assertChapterProjectAccess`）、worktree 生命周期、tree 快照与 shadow GC、容器和终端运行时里的章节分支。
- **worktree 清理守卫（D1b）**：确保没有章节记录后，`<gitPath>/.worktrees/` 下的旧目录和章节分支不会被当作孤儿删除，并补测试。和删除章节分支放在同一提交里。
- 删除对应测试（含 `ruler-anchor-fallback.test.ts`、`chapter-*.test.ts` 等）。按 docs/TESTING.md，删除或移动被 `readFileSync` 守卫测试引用的文件后，全仓搜索旧路径字符串。
- 此时 schema 里的章节表和列还在，但代码不再读写。

### 提交 2：项目自动索引

- `server/db/schema.ts` 新增 `narrator_project_links`、`projects.root_key`（迁移在最后统一生成，见提交 4）。
- 实现 `resolveProjectForDirectory`、单会话增量重算、启动时的后台重建任务、`root_key` 填写任务。
- `resolveNarratorProjectId` 改为读主链接；项目页列表改用链接表过滤。
- 测试：前缀匹配边界、worktree 归到主仓库、子目录归到仓库根、非 git 目录不建项目、并发建项目只产生一行、重建会删除推导不出的链接、`explicit` 优先于 cwd、`additional` 链接不影响权限和配置。

### 提交 3：schema 删章节

- 在 `server/db/schema.ts` 删除 `chapters`、`chapter_edges`、`chapter_commits`、`merge_sessions`、`review_conclusions`、各表的 `chapter_id` 列与只服务章节的索引和 CHECK 约束、`projects.flowMode`。
- FTS5 里章节的索引和触发器在 `server/db/fts.ts` 同步删除。

### 提交 4：生成迁移

- 在最后一次合并 main 之后执行 `bun run db:generate`，PG 侧按 CLAUDE.md 的 `db:generate:pg` 流程。放到最后是为了避免和 main 上新增迁移的编号、journal 冲突；中途合并 main 时如果 main 带来了新迁移，丢弃本分支已生成的迁移重新生成（本分支的迁移未发布，可以重生成）。
- 不手改 `drizzle/`，不写自定义 SQL。SQLite 删列会重建表；`narrators` 不含消息内容，行数有限。

### 提交 5：改名、设置页、计划任务、文档

- 4 处中文“叙事线”改为“项目”：`nav.json` 的 `projects`、`clearProjects`，`graph.json` 的 `storyNetwork`，`learning.json` 的 `subtitle`；`narrator.json` 的 `backToGraph`（“返回故事网络” / "Back to graph"）改为“返回项目” / "Back to project"。其余只服务已删界面的翻译键随之删除。
- 设置页按 D5 处理。
- 计划任务界面只提供 standalone 和项目两种运行方式。
- 更新 CLAUDE.md（删除“章节拆分”“章节边”“故事网络图”“Ruler 模式”等条目，项目条目改为“按工作目录自动索引”，worktree 条目改为会话 worktree）和相关 docs；changelog 写明升级影响（见下）。

### 从当前版本直接升级必须处理的

这些不是过渡代码，是升级后数据仍然存在、最终版本必须能处理的情况：

- 没存 cwd 的旧章节会话：打开时走现有 `WORKSPACE_DIRECTORY_REQUIRED` 提示；选定目录后触发索引重算。
- `scheduled_tasks.runContext = "chapter"` 的旧值：按项目目录运行（`projectId` 列保留）。
- 磁盘上的旧 worktree 目录和章节分支：清理守卫保护（D1b）。
- 已有项目：后台任务填 `root_key`，重复 `gitPath` 只给最早的项目填。
- 已有会话：启动时后台重建索引。
- 迁移在应用启动前执行，进行中的章节会话、终端、容器不受安全点保护。changelog 写明：升级前停掉章节会话里的运行，并备份数据库。

## 验证

- 每个提交：`bunx tsgo --noEmit`、`bunx @biomejs/biome check .`，以及与改动相关的 `bun test --isolate <路径>`；全量交给 CI。
- 升级验证：在一份带章节数据的数据库副本上（不碰 `~/.narrafork/narrafork.db`）跑迁移和启动后的重建任务，核对：自己存了 cwd 的旧会话回到项目页；没存 cwd 的旧会话能打开并提示选目录；没有残留 `chapter_id` 引用；重复 `gitPath` 只给一个项目填了 `root_key`；磁盘上的 worktree 目录和章节分支仍在。PG 同样验证一遍。

## 风险

- **worktree 被误删**：删表后旧 worktree 目录不再有数据库记录，任何“没有记录就清理”的逻辑都会删掉其中未提交的改动。缓解：提交 1 的清理守卫和测试，升级验证时确认目录仍在。
- **级联删除不可逆**：终端、容器等章节资源记录和评审结论随删表消失。升级说明写明，建议升级前备份。
- **公开项目扩大 `project` 可见会话的读范围（P4）**：自动建的项目是公开的，其中 `project` 可见的会话对所有登录用户可读。PR 说明和 changelog 里写明。
- **改 cwd 会改变主项目**：会话的 `project` 可见性和配置继承跟着主项目走，把会话 cwd 移到另一个项目会改变谁能看到它。改 cwd 本身需要会话写权限。
- **项目表增长**：每个进入过的 git 仓库都会产生一个项目。需要确认项目列表的排序和筛选在项目数变多后仍然可用。
- **运行中的 NarraFork 进程**：开发和验证过程中不得停止或重启 `bun run start:dev` 启动的进程；需要重载时由用户操作。
- **参考**：废弃分支 `origin/abandoned/chapter-retirement-migration`（`42874fd2`）的 `docs/CHAPTER_RETIREMENT_MIGRATION_DESIGN.md` 记录了“转换并删除项目”这一更难版本的问题。本计划保留项目、直接删表，权限搬迁和逐类资源接管都不再需要。
