# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在本仓库中工作时提供指导。

## 项目概述

NarraFork 是一个以"叙事分叉"为隐喻的 AI 协作编程平台。软件开发被建模为分支故事网络，每个工作分支（章节/Chapter）拥有独立的 AI 叙述者（Claude Code 会话），运行在隔离的 git worktree 中，可选配 Podman 容器环境。面向小团队私有化部署，支持共享项目数据。

**核心领域概念：**
- **章节（Chapter）** — 工作单元 = git worktree + AI 会话，状态包括：active/dormant/merged/abandoned/frozen，角色（role）包括：trunk/branch/exploration
- **叙述者（Narrator）** — 绑定到章节（或独立运行）的 Claude Code 会话，支持流式输出和权限控制
- **故事网络（Story Network）** — 所有章节 fork/merge/dependency/cherry_pick 关系构成的有向图，是项目的主界面
- **探索组（Exploration Group）** — 将多个探索分支组织为一个实验组，用于技术方案对比
- **章节边（Chapter Edge）** — 章节间的显式关系，类型包括：fork/merge/dependency/cherry_pick

## 常用命令

| 命令 | 用途 |
|------|------|
| `bun run dev` | 后端：运行数据库迁移 + 热重载服务器（端口 7779） |
| `bun run dev:frontend` | 前端：Vite 开发服务器（端口 7778，代理 /api 和 /ws 到 7779） |
| `bun run build` | 构建前端到 `dist/frontend/` |
| `bun run start` | 生产环境：运行数据库迁移 + 启动后端 + 静态前端 |
| `bun run db:generate` | 生成 Drizzle 迁移 SQL 文件 |
| `bun run db:migrate` | 执行 `./drizzle/` 中的迁移 |
| `bun run check` | Biome 代码检查 + 格式检查 |
| `bun run format` | Biome 代码检查 + 格式化（自动修复） |

**开发需要两个进程：** `bun run dev`（后端）和 `bun run dev:frontend`（前端）。

**数据库迁移规则（严格遵守）：**
- **禁止手动修改 `drizzle/` 目录下的任何文件**（包括 SQL 迁移文件和 `meta/` 下的 journal/snapshot）
- 修改数据库结构的唯一正确流程：先修改 `server/db/schema.ts`，然后运行 `bun run db:generate` 自动生成迁移文件
- 如需全新迁移：删除 `drizzle/` 目录和数据库文件（`~/.narrafork/narrafork.db*`），再运行 `bun run db:generate` + `bun run db:migrate`

## 技术栈

- **运行时：** Bun（≥ 1.2），所有脚本通过 `bun run`/`bunx` 执行
- **禁止使用 `npx`** — 可能解析到错误或缺失的包，始终使用 `bunx` 代替
- **后端：** Hono v4 运行于 Bun.serve()，SQLite 通过 `bun:sqlite`，Drizzle ORM
- **前端：** React 19 + Mantine v7（暗色主题，indigo 主色），TanStack Router（基于文件），TanStack React Query，React Flow（图可视化），xterm.js（终端），react-i18next（国际化）
- **AI：** `@anthropic-ai/claude-agent-sdk` 用于叙述者会话
- **校验：** Zod v4
- **代码规范：** Biome v2（tab 缩进，100 字符行宽，推荐规则集）
- **外部依赖：** git、可选 podman（容器）

## 架构

### 后端（`server/`）

```
server/
  index.ts          — Bun.serve() 入口：HTTP（Hono）+ WS 升级
  app.ts            — Hono 路由注册 + 全局错误处理
  db/
    schema.ts       — Drizzle 表定义（projects、chapters、narrators 等）
    relations.ts    — Drizzle 关系定义
    index.ts        — 数据库初始化（WAL 模式、外键、FTS5 虚拟表 + 触发器）
  middleware/auth.ts — requireAuth / requireAdmin JWT 中间件
  lib/
    auth.ts         — JWT 签发/验证（HS256，7 天有效期），bcrypt 注册/登录
    validators.ts   — 所有 API 输入的 Zod schema
    event-bus.ts    — 类型化 EventEmitter，用于服务间解耦
    settings/       — 基于文件的配置（~/.narrafork/settings.json），深度合并默认值
    errors.ts       — AppError 层级（NotFoundError、ValidationError）
    id.ts           — nanoid 生成器（21 字符默认，8 字符短 ID）
  routes/           — Hono 路由组，挂载于 /api/*
  services/         — 业务逻辑（章节 CRUD、fork、merge、叙述者会话、git、终端、容器）
  websocket/        — Bun WebSocket 处理器（叙述者事件和终端 I/O）
```

**关键模式：**
- **事件总线**（`lib/event-bus.ts`）解耦服务 → WebSocket 广播。所有跨服务通信通过类型化事件流转。
- **叙述者会话**使用 Claude Agent SDK 的 `query()` 方法，通过 HTTP SSE 流式传输 + 并行 WebSocket 广播。权限请求会暂停会话（Promise 挂起），由用户决策解除（5 分钟超时）。
- **Fork 上下文继承**有三种模式：`full`（延迟 SDK 会话 fork）、`compressed`（Haiku 生成摘要注入 system prompt）、`fresh`（无上下文）。
- **章节拆分（Split at Commit）**：从历史 commit 分叉时，将原章节拆为前序（prefix）和后续（continuation），新分叉成为前序的另一个 fork。前序章节的叙述者只保留拆分点之前的消息。
- **章节角色（Role）**：trunk（主线，接收合并）、branch（工作分支，默认）、exploration（探索分支）。角色是视觉和语义标签，不限制操作能力。
- **章节边（Chapter Edges）**：`chapter_edges` 表显式建模四种关系（fork/merge/dependency/cherry_pick），与 `parentChapterId`/`mergedIntoChapterId` 冗余字段同步维护。
- **依赖关系**：章节间可声明 dependency 边，系统检测上游变更并提供 rebase/merge 同步。
- **探索组**：将多个 exploration 章节组织为实验组，支持决策（选定方案合并）和放弃。
- **Git worktrees** 每个活跃章节在 `<project.gitPath>/.worktrees/` 下创建。休眠章节移除 worktree 但保留分支。每个项目对应一个 git 仓库，通过项目的 `gitPath` 配置。
- **容器管理**通过 Podman compose 实现，端口从可配置池中分配（默认 10000–20000）。
- **终端管理**通过 Bun.Terminal (PTY) 直接实现 — 终端生命周期与服务器进程绑定，重启后标记为已退出。
- **批量合并**编排多章节合并，支持冲突检测、WebSocket 交互式决策和 AI 辅助冲突解决。
- **故事网络图**是项目的主界面（`/projects/$projectId`），交互式 React Flow 画布，支持节点拖拽、右键菜单、侧边面板、边连接。

**叙述者消息存储：** 消息通过三层结构管理：
- `narrator_messages` — 存储所有消息（user/assistant/system），`contentJson` 保存完整的 SDK content blocks（text/tool_use/thinking），`parentToolUseId` 关联子 agent 消息树。
- `narrator_message_refs` — 叙述者-消息关联表（junction table），通过 `seq` 字段维护消息顺序，`isCompact` 标记压缩点。消息可被多个叙述者共享（fork 时复制共享前缀）。叙述者通过 `parentNarratorId` 和 `forkMessageId` 追踪 fork 来源。
- `narrator_tool_calls` — 工具调用记录，同时承担权限审批职责（`permissionDecidedBy`/`permissionDecidedAt` 等字段），无独立的 `permission_requests` 表。
- 消息分页基于 `narrator_message_refs.seq` 的游标分页，查询时先通过 junction table 获取叙述者的顶层消息 ID，再加载消息及其子 agent 消息树。
- **Compact 机制**：插入 role=system 的压缩标记消息（`contentJson: [{type: "compact", status: "compacted", summary}]`），在 `narrator_message_refs` 中标记 `isCompact=1`，后续查询从最近的 compact 点之后开始加载。

**数据库：** SQLite 位于 `~/.narrafork/narrafork.db`。所有主键为 nanoid 文本 ID。FTS5 虚拟表（trigram tokenizer，支持 CJK）用于章节、叙述者标题和叙述者消息的全文搜索，通过触发器同步。

**认证：** JWT 通过 `Authorization: Bearer` 头（HTTP）或 `?token=` 查询参数（WebSocket）传递。首个注册用户自动获得管理员权限。JWT 密钥在配置文件中自动生成。

### 前端（`frontend/`）

```
frontend/
  main.tsx            — i18n 初始化 + MantineProvider + QueryClient + RouterProvider
  lib/api.ts          — 类型化 fetch 封装，自动注入 JWT 并处理 401 重定向
  lib/i18n.ts         — i18next 初始化，语言检测 + 语言包导入
  locales/            — 翻译 JSON 文件：en/ 和 zh-CN/，每种语言 12 个命名空间
  routes/             — TanStack 基于文件的路由（自动代码分割）
  hooks/              — 按资源划分的 React Query hooks + WebSocket hooks
  components/         — 按领域分组：chapter/、narrator/、terminal/、container/、graph/
```

**路由结构：** `__root.tsx`（AppShell 布局）→ 仪表盘、项目、章节、会话、设置、搜索、图可视化。

**Vite 开发代理：** `/api/*` → `localhost:7779`，`/ws/*` → `ws://localhost:7779`。

### API 路由

全部位于 `/api/` 下。公开接口：`/api/auth/*`、`/api/health`、`/api/auth/status`。其余均需 JWT。

- `/api/projects` — CRUD + `/:id/graph`
- `/api/chapters` — CRUD + fork、merge、merge-check、ai-resolve、dormant、wake、cleanup、batch-merge、containers
- `/api/narrators` — CRUD + messages（SSE）、interrupt、permission-mode、permissions、approve/deny
- `/api/terminals` — CRUD
- `/api/sessions` — 独立叙述者会话（不绑定章节）
- `/api/settings`、`/api/admin`、`/api/search`、`/api/mcp`

**WebSocket：** `/ws/narrator?token=`（订阅/取消订阅模型），`/ws/terminal?terminalId=&token=`（stdin/stdout 管道）

## 代码风格

- **Biome** 强制格式化和代码检查 — 提交前运行 `bun run check`
- 使用 **tab** 缩进，最大行宽 **100** 字符
- 路径别名：`@server/*` → `./server/*`，`@frontend/*` → `./frontend/*`
- 全局使用 ESM（`"type": "module"`）
- `routeTree.gen.ts` 为自动生成文件 — 请勿手动编辑
- ID 生成：使用 `@server/lib/id` 中的 `generateId()`（21 字符）或 `generateShortId()`（8 字符）
- 错误处理：抛出 `@server/lib/errors` 中的 `AppError` 子类 — 全局处理器负责序列化
- 校验：在 `@server/lib/validators.ts` 中定义 Zod schema，在路由处理器中解析
- 配置文件位于 `~/.narrafork/settings.json` — 通过 `@server/lib/settings` 的 `settings` 单例访问

## DESIGN.md

`DESIGN.md` 文件（中文编写）包含完整的项目规格说明，涵盖全部 5 个开发阶段、详细的数据库 schema、API 契约和 UI 线框图。需求和架构决策请参阅该文件。

## 国际化（i18n）

前端国际化使用 `react-i18next` 配合 `i18next-browser-languagedetector`。

- **支持语言：** 英文（默认回退）+ 简体中文（`zh-CN`）
- **配置：** `frontend/lib/i18n.ts` — 同步导入所有语言包，无异步加载
- **检测顺序：** localStorage 键 `narrafork_lang` → 浏览器 navigator → 回退 `en`
- **命名空间：** 每种语言 13 个按功能划分的 JSON 文件，位于 `frontend/locales/{en,zh-CN}/`：common、nav、dashboard、projects、chapters、sessions、settings、search、narrator、terminal、containers、graph、explorations
- **语言切换器：** `frontend/components/LanguageSwitcher.tsx` — 应用头部的 Mantine Select 组件
- **使用方式：** 组件中 `const { t } = useTranslation("namespace")`，插值 `t("key", { param })`
- **多命名空间：** `const { t } = useTranslation("chapters"); const { t: tc } = useTranslation("common");`
- **添加字符串：** 同时在 `en/*.json` 和 `zh-CN/*.json` 中添加键值，在 JSX 中使用 `t("key")`
