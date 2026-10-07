# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在本仓库中工作时提供指导。

## 项目概述

NarraFork 把 AI 会话、开发工具和团队协作放在一个自托管平台里：部署在自己的电脑或服务器上，与同事共享项目，管理 Agent 的上下文和操作权限，也能通过手机查看进展、继续对话。

**核心领域概念：**
- **叙述者（Narrator）** — 基于自定义 Agent Loop 的 AI 会话，绑定工作目录；类型分 primary 和 subagent（explore/plan/general/review）
- **工作区（Workspace）** — 多叙述者的面板布局，可保存与恢复
- **项目（Project）** — 关联 git 仓库的工作单元，叙述者在仓库目录或其 worktree 中工作
- **消息（Messages）** — 团队成员间的站内会话与通知
- **技能（Skill）/ 例程（Routine）** — 项目级技能库与自动化例程
- **知识库（Knowledge Base）** — 分级 + 分 tag 授权的团队知识库（详见 docs/KNOWLEDGE_BASE.md）

## 常用命令

| 命令 | 用途 |
|------|------|
| `bun run dev` | 后端：运行数据库迁移 + 热重载服务器（端口 7779） |
| `bun run dev:frontend` | 前端：Vite 开发服务器（端口 7778，代理 /api 和 /ws 到 7779） |
| `bun run build` | 构建前端到 `dist/frontend/` |
| `bun run start` | 生产环境：运行数据库迁移 + 启动后端 + 静态前端 |
| `bun run db:generate` | 生成 Drizzle 迁移 SQL 文件 |
| `bun run db:migrate` | 执行 `./drizzle/` 中的迁移 |
| `bun run db:generate:pg --name <name>` | 在隔离目录生成PG增量迁移并更新唯一当前快照 |
| `bun run db:check:pg` | 检查PG迁移谱系及原生Drizzle当前基线 |
| `bun run db:baseline:pg` | 将旧PG多快照结构收敛为单基线（不是SQL squash） |
| `bun run db:resume:pg` | 按摘要校验恢复未完成的PG元数据发布 |
| `bunx @biomejs/biome check .` | Biome 代码检查 + 格式检查（白名单命令，无需用户批准） |
| `bunx tsgo --noEmit` | TypeScript 类型检查（白名单命令，无需用户批准） |
| `bunx @biomejs/biome check --write <file>` | Biome 格式化（白名单命令，建议单文件执行） |
| `bun test <路径>` | 运行测试。手动跑子集请加 `--isolate`；判断"是否有回归"必须以 `--isolate` 结果为准（原因见 docs/TESTING.md） |

**开发需要两个进程：** `bun run dev`（后端）和 `bun run dev:frontend`（前端）。也可用 `bun run dev:all` 一条命令同时启动两者（自动处理跨平台信号转发）。

**测试要点：** 单文件全绿、混跑失败 = 测试间原型污染，加 `--isolate` 复跑（详见 docs/TESTING.md）。移动被 `readFileSync` 类守卫测试引用的源文件后，必须全仓搜索旧路径字符串——类型检查和构建都不会发现（详见 docs/TESTING.md）。

**运行中 NarraFork 进程铁律（最高优先级）：**
- **永远不要停止、杀死、重启或接管由 `bun run start:dev` 启动的 NarraFork 进程。** 该进程承载当前 agent loop；一旦停止，所有会话都会中断，当前 agent 也可能无法重启并继续修复。
- 修改代码后不得通过 `kill`、`pkill`、`systemctl restart` 或其他方式主动终止/重启上述进程来加载变更。优先使用不影响运行会话的单元测试、静态检查和代码审查；需要重载时只能由用户自行操作。

**Bash 工具注意事项：** 当命令输出很大时，系统会自动将完整输出存放到一个你有权限读取的临时文件中，请使用 Read 工具读取该文件获取完整内容。**禁止手动将输出重定向或 `cat` 到 `/tmp`**，这会导致路径超出工作目录范围，需要额外的用户批准。

**后台任务与 Await 使用规则（严格遵守）：**
- **非必要不使用 Await 阻塞等待后台任务。** 后台 subagent 结束或后台 bash 任务结束时会自动唤醒主代理并带回结果，因此启动后台任务后应**直接结束当前响应**，等待唤醒通知，而不是在回合内轮询/等待。
- 仅当后续步骤**强依赖**该任务结果、且必须在当前回合内立即拿到才能继续时，才使用 Await；此时也应设置有意义的超时，避免反复短轮询。
- 对后台 subagent 同样适用：派生后直接结束响应即可，不要 Await 等它完成；有新信息需要传达时用 Send，没有就等自动唤醒。

**发布工作区规则（严格遵守）：**
- **发布（`bun scripts/release.ts`）必须在当前主仓库工作区就地执行，禁止为了发布新建/使用隔离 git worktree。** 隔离发布会导致 release 提交和 tag 落在别的分支、主仓库 main 上缺少版本 bump 与 changelog，需要二次合并。若当前工作区有未提交的无关改动，应先与用户确认提交或暂不发布，而不是旁路到隔离工作区。
- 发布产生的 dist 产物默认写回当前工作区 `dist/`，不要事后从别处复制。

**数据库迁移规则（严格遵守）：**
- **禁止手动修改 `drizzle/` 目录下的任何文件**（包括 SQL 迁移文件和 `meta/` 下的 journal/snapshot）
- 修改数据库结构的唯一正确流程：先修改 `server/db/schema.ts`，然后运行 `bun run db:generate` 自动生成迁移文件
- **代码评审特殊规则：** 如果评审中的改动修改了 `server/db/schema.ts` 但尚未生成对应迁移，**不要**把“未生成迁移”列为阻塞项或必须修复项；最多作为非阻塞提醒说明“合并/发布前需要生成迁移”。评审应优先确认 schema 设计和业务逻辑正确，迁移可在评审通过后再生成。
- **⚠️ 禁止自行删除数据库文件（`~/.narrafork/narrafork.db*`）或 `drizzle/` 目录** — 数据库包含用户数据，删除不可逆。迁移失败时应先尝试修复（如关闭外键检查、调整迁移顺序等），必须由用户明确授权后才能执行删除操作
- 如用户明确要求全新迁移：删除 `drizzle/` 目录和数据库文件（`~/.narrafork/narrafork.db*`），再运行 `bun run db:generate` + `bun run db:migrate`

**PostgreSQL 迁移元数据规则：**
- `drizzle-postgres/` 保留全部增量SQL和journal，但全量schema只保留固定的 `meta/current_snapshot.json`；`meta/_snapshot_history.json` 保存小型谱系记录，不增加历史全量快照或压缩归档。
- PG schema继续由 `bun scripts/generate-postgres-schema.ts` 从SQLite schema转译，再用 `bun run db:generate:pg --name <name>` 生成增量迁移；不要对正式PG目录直接运行裸 `drizzle-kit generate/check/up/drop`。
- 不改写已发布SQL、编号或journal时间戳；回退已发布结构应追加补偿迁移，不删除历史。尚未发布的custom SQL可以按正常流程填写。
- 出现pending receipt时使用 `db:resume:pg`；中断遗留锁必须先确认生产者已停止后由操作员修复，不自动抢占锁、不删除故障证据。

**后端主线程性能规则（严格遵守）：**
- Bun HTTP/WS、`bun:sqlite`、JSON 序列化、同步 FS/crypto/zlib 都可能占用同一个 JS 主线程；任何长时间同步工作都会表现为“所有请求无响应”。
- 主线程 SQLite 只做“小、快、有索引、有限制”的 CRUD。禁止在普通业务请求路径中运行 FTS rebuild、`integrity_check`、全库 `dbstat`/存储扫描、大范围聚合、大事务或无上限 `.all()`；这些必须做成后台 job/worker/subprocess。管理员显式确认触发的 `/api/storage/database/vacuum` 是受控维护窗口例外：它可以同步执行并暂时暂停普通 HTTP/WS/Agent 活动，不得被当作普通 CRUD 或自动清理路径调用。
- SQLite `busy_timeout` 不能设置为多秒级；遇到锁冲突应快速失败或短等待，并在应用层用 async retry/backoff/写队列处理，避免主线程在 SQLite busy handler 中阻塞。
- 列表页/API 摘要禁止读取大字段（如 `raw_dump_json`、`output_json`、`content_json`、文件快照内容）；只返回 `has*`、长度、摘要或计数，详情接口再按需读取完整内容。
- 分页/增量同步优先使用 cursor + `LIMIT n + 1` 判断是否还有更多，避免先跑大范围 `COUNT(*)`。
- 子进程调用必须有输出上限和超时；禁止先完整收集巨大 stdout/stderr 再截断。Git diff/log、容器日志、benchmark 输出等必须从源头限流或落盘分页读取。
- WebSocket 高频输出必须合并、节流并处理 backpressure；终端输出、bash 工具输出、叙述者流式事件不得每个 chunk 广播越来越大的完整累计字符串。
- 文件预览/分享/工具读取必须有大小上限或流式读取；HTML sanitize、压缩/解压、哈希大文件应放 worker/subprocess 或设置硬限制。
- 新增可能处理大数据的功能时，必须同时设计：最大输入/输出字节数、超时、取消、分页/流式策略、慢操作日志和对事件循环的影响。

## 技术栈

- **运行时：** Bun（≥ 1.2），所有脚本通过 `bun run`/`bunx` 执行
- **禁止使用 `npx`** — 可能解析到错误或缺失的包，始终使用 `bunx` 代替
- **后端：** Hono v4 运行于 Bun.serve()，SQLite 通过 `bun:sqlite`，Drizzle ORM
- **前端：** React 19 + Mantine v9（暗色主题，indigo 主色），TanStack Router（基于文件），TanStack React Query，@xyflow/react（图可视化），xterm.js（终端），react-i18next（国际化）
- **AI：** 自定义 Agent Loop 架构（`server/lib/agent/`），支持多提供商：Anthropic API、OpenAI API、Gemini、Codex、NUG（统一网关）；MCP 集成通过 `@modelcontextprotocol/sdk`
- **校验：** Zod v4
- **代码规范：** Biome v2（tab 缩进，100 字符行宽，推荐规则集）
- **外部依赖：** git、可选 podman（容器）

## 架构

### 后端（`server/`）

```
server/
  index.ts / app.ts   — Bun.serve() 入口 + Hono 路由注册
  db/                 — Drizzle schema/relations、连接、FTS5、迁移
  middleware/auth.ts  — requireAuth / requireAdmin JWT 中间件
  lib/                — 认证、validators（Zod）、event-bus、settings、errors、id、上传/分享等
  lib/agent/          — 自定义 AI Agent 框架（loop、多提供商、工具注册）
  lib/mcp/            — MCP 集成
  terminal/           — 终端运行时（PTY 抽象层、buffer、dtach）
  routes/             — Hono 路由组，挂载于 /api/*
  services/           — 业务逻辑（叙述者、工作区、git、终端、容器、技能、例程、知识库、快照等）
  websocket/          — Bun WebSocket 处理器
  generated/          — 自动生成文件（构建信息、嵌入式迁移数据）
```

**关键模式：**
- **事件总线**（`lib/event-bus.ts`）解耦服务 → WebSocket 广播，所有跨服务通信通过类型化事件流转。
- **叙述者会话**使用自定义 Agent Loop（`server/lib/agent/loop.ts`），HTTP SSE 流式 + 并行 WebSocket 广播；权限请求暂停会话（Promise 挂起）由用户决策解除（5 分钟超时）。
- **可选工具三段式模式**（`shared/routine-modes.ts`）：`manual`（会话内 `/load` 临时加载）、`auto`（预留，当前等同 manual）、`resident`（新会话默认加载）。模式存于 `settings.routines.toolModes` 与项目 `chapterSettings.routines.toolModes`（项目层优先），`enabledRoutines`/`disabledRoutines` 作为兼容投射双向同步；`narrators.enabledTools` 是正交的会话级临时装载。
- **子代理**：通过 `narrator_messages.parentToolUseId` 关联消息树，子代理有独立叙述者记录（`type="subagent"`）。
- **Fork 上下文继承**：`full`（延迟会话 fork）/ `compressed`（摘要注入 system prompt）/ `fresh`（无上下文）。
- **章节拆分（Split at Commit）**：从历史 commit 分叉时，原章节拆为 prefix + continuation，新分叉成为 prefix 的另一个 fork。
- **章节边**：`chapter_edges` 表显式建模五种关系（fork/merge/dependency/cherry_pick/review），与冗余字段同步维护。
- **Git worktrees**：每个活跃章节在 `<project.gitPath>/.worktrees/` 下创建；休眠章节移除 worktree 但保留分支。
- **容器管理**：Podman compose，端口从可配置池分配（默认 10000–20000）。
- **终端管理**：Unix 用 `Bun.Terminal`，Windows 用 `bun-pty`，统一 `TerminalRuntime` 接口；可选 dtach；生命周期绑定服务器进程。
- **故事网络图**：主界面 `/projects/$projectId`，两种流程模式：classic（React Flow 画布）和 ruler（**已弃用**），存于 `projects.flowMode`。
- **Ruler 模式已弃用**：不再开发，已知问题不修复，新功能只加 classic 侧；涉及改动仅限"不破坏现状"的必要维护。
- **快照系统**：两条路径，回退优先 tree 快照（`worktree-tree-snapshot.ts` 影子裸仓库写 tree 对象，捕获含 Bash/外部编辑器改动），缺失才回落逐文件重放（`file-state-rebuild.ts`，遇到无法应用的步骤抛 `ReplayDivergedError`）。热路径捕获有 4s 预算（`tryCaptureHot`），超预算升格后台暖捕获；`chapters.treeSnapshotsEnabled` 可整体关闭。回退走 `snapshot-revert.ts` 事务（commit/finalize/discard 三出口必调其一）。
- **叙述者服务拆分**：narrator-service / -session / -executor / -subagent / -context / -prompt / -title / -recovery / -event-handler。
- 其余服务：评审（review-service）、技能、例程、通知、项目数据库同步、worktree 监视、提交同步、合并摘要、输出统计、更新检查等，均在 `server/services/` 下。

**叙述者消息存储：** 三层结构：
- `narrator_messages` — 全部消息，`contentJson` 存 SDK content blocks，`parentToolUseId` 关联子代理消息树。
- `narrator_message_refs` — 叙述者-消息 junction table，`seq` 维护顺序，`isCompact` 标记压缩点；fork 时复制共享前缀。
- `narrator_tool_calls` — 工具调用记录，同时承担权限审批职责，无独立 `permission_requests` 表。
- 分页基于 `refs.seq` 游标；**Compact** 通过插入 system 压缩标记消息实现，后续查询从最近 compact 点之后加载。

**数据库：** SQLite 位于 `~/.narrafork/narrafork.db`。主键均为 nanoid 文本 ID。FTS5（trigram tokenizer，支持 CJK）用于章节、叙述者标题和消息全文搜索，触发器同步。

**认证：** JWT 经 `Authorization: Bearer` 头（HTTP）或 `?token=` 查询参数（WebSocket）传递。首个注册用户自动获得管理员权限。

### 前端（`frontend/`）

```
frontend/
  main.tsx      — i18n + MantineProvider + QueryClient + RouterProvider
  lib/          — 工具库（api、i18n、ws、notification、format 等）
  locales/      — en/ 和 zh-CN/ 翻译 JSON（按功能分命名空间）
  routes/       — TanStack 基于文件的路由（自动代码分割）
  hooks/        — React Query + WebSocket + UI 状态 hooks
  components/   — 按领域分组的组件目录
```

**路由结构：** `__root.tsx`（AppShell 布局）→ 仪表盘、项目、章节、叙述者、管理面板、例程、设置、搜索、登录、许可证。
**Vite 开发代理：** `/api/*` → `localhost:7779`，`/ws/*` → `ws://localhost:7779`。

### API 路由

全部位于 `/api/` 下，路由文件在 `server/routes/`（一个文件一组资源，`new Hono()` + `app.route` 注册）。公开接口：`/api/auth/*`、`/api/health`、`/api/auth/status`；其余均需 JWT。

**WebSocket：** `/ws/narrator?token=`（订阅模型），`/ws/terminal?terminalId=&token=`（stdin/stdout 管道）

## 代码风格

- **Biome** 强制格式化和代码检查 — 优先使用 `bunx @biomejs/biome check .`（白名单命令，无需用户批准）而非 `bun run check`
- **TypeScript 类型检查** — 使用 `bunx tsgo --noEmit`（白名单命令，无需用户批准）
- 使用 **tab** 缩进，最大行宽 **100** 字符
- 路径别名：`@server/*` → `./server/*`，`@frontend/*` → `./frontend/*`
- 全局使用 ESM（`"type": "module"`）
- `routeTree.gen.ts` 为自动生成文件 — 请勿手动编辑，也无需手动运行 `generate` 命令，开发服务器启动时会自动生成
- ID 生成：使用 `@server/lib/id` 中的 `generateId()`（21 字符）或 `generateShortId()`（8 字符）
- 错误处理：抛出 `@server/lib/errors` 中的 `AppError` 子类 — 全局处理器负责序列化
- 校验：Zod schema 定义在 `server/lib/validators/`（按资源拆分的目录），在路由处理器中解析
- 配置文件位于 `~/.narrafork/settings.json` — 通过 `@server/lib/settings` 的 `settings` 单例访问

## 深入文档（按需阅读）

涉及对应领域改动时先读：

- 跑测试/改测试基建、移动被守卫测试引用的文件 → `docs/TESTING.md`
- 发布、changelog、stable 增量包、更新服务器（含个人测试服务器） → `docs/RELEASE.md`
- 构建跨平台可执行文件 → `docs/BUILD.md`
- 新增第三方/非 npm 二进制依赖、改 licenses 页面 → `docs/LICENSES.md`
- 改 API request dump 存储/下载 → `docs/REQUEST_DUMPS.md`
- 改 agent provider 历史构造、图片处理、NUG 网关事件 → `docs/AGENT_PROVIDERS.md`
- 注入机制（服务端把内容放进叙述者对话） → `docs/INJECTION.md`
- 知识库（分级 + 分 tag 双轴授权、写时复制版本、知识图谱链接） → `docs/KNOWLEDGE_BASE.md`
- OAuth 2.0 + External API v1 接入 → `docs/OPEN_API.md`
- VS Code 插件 → `docs/VSCODE_EXTENSION.md`
- Codex Responses WebSocket → `docs/codex-websocket.md`

其余文档按性质：`docs/plugin-system/` 为插件系统设计与验收记录；`docs/*-DESIGN.md`、`docs/CODEX_CLIENT_RELAY.md`、`docs/DYNAMIC_SPEC_TEAM_TASKS.md` 为领域设计；`docs/HANDOUT-agent-control.md` / `docs/TALK-agent-control.md` 为培训讲义；`docs/task-call-challenges/` 为评测存档，不是产品文档。

> 新增表/路由/校验遵循既有范式：`schema.ts` → `bun run db:generate` → `bun run db:migrate`，FTS5 改 `server/db/fts.ts`，Zod schema 进 `server/lib/validators/`（按资源拆分目录），路由 `new Hono()` + `app.route`。

## 国际化（i18n）

- **支持语言：** 英文（默认回退）+ 简体中文（`zh-CN`），命名空间 JSON 位于 `frontend/locales/{en,zh-CN}/`
- **检测顺序：** localStorage 键 `narrafork_lang` → 浏览器 navigator → 回退 `en`
- **使用方式：** 组件中 `const { t } = useTranslation("namespace")`，插值 `t("key", { param })`
- **添加字符串：** 同时在 `en/*.json` 和 `zh-CN/*.json` 中添加键值，在 JSX 中使用 `t("key")`
