---
id: root
title: NarraFork 仓库知识
summary: NarraFork 是什么、核心概念、进程与目录地图，以及怎么使用这棵知识树。
anchors:
  - package.json
  - server/db/schema.ts
  - server/index.ts
status: draft
verified_at: 2e6441ad0
---
# NarraFork 仓库知识

NarraFork 是一个自托管的 AI 编程协作工作台：用 Bun 运行一个后端进程（Hono + SQLite/可选 PostgreSQL），同时托管 React 前端；用户在浏览器里创建绑定工作目录的 AI 会话（叙述者），由自定义 Agent Loop 调用多家模型提供商并执行文件、命令、终端、git 等工具，工具调用需要按规则审批；会话、项目、知识库等数据在多个用户之间按权限共享，也可以把工具执行放到远程设备上。

## 核心概念

下列定义都对照了代码（表定义见 `server/db/schema.ts`）。

- **叙述者（narrator）**：一个 AI 会话，表 `narrators`。`type` 为 `primary` 或 `subagent`；`variant` 为 `primary` 或 `subagent:<类型>`；`traits`（JSON 数组）叠加属性，如 `standalone`、`ask-in-passing`、`background`、`named`，以及 `bot`（`server/lib/narrator-utils.ts:BOT_TRAIT`，人们通过聊天房间与它对话，房间类型 `dm | narrator | bot`，见 `shared/chat-room-kinds.ts`）。工作目录在 `cwd`，消息存于 `narrator_messages`，经 `narrator_message_refs` 引用，分叉时共享前缀。
- **子代理（subagent）**：`type="subagent"` 的叙述者，有独立记录，经 `parentNarratorId` 与父叙述者关联；内置类型池 `explore | plan | search | review | general`（`shared/subagent-model-policy.ts:SUBAGENT_POOL_TYPES`），也允许自定义类型。上下文继承方式 `inheritMode` 为 `full | compressed | fresh`。
- **项目（project）**：表 `projects`，通常对应一个 git 仓库根。叙述者按工作目录自动归入项目：`server/services/project-index.ts` 维护 `narrator_project_links`（`role` 为 `primary | additional`，`source` 为 `cwd | explicit`），目录落在 git 仓库内而没有已有项目时自动建一个 `visibility: "public"` 的项目。“叙述者属于哪个项目”只经 `server/services/narrator-project.ts` 回答，只看主项目。
- **团队（team）**：表 `project_teams`，以一个“协调者”叙述者为主键（`narratorId`），绑定项目与 `baseBranch`，下挂 `team_work_items`（状态 `queued | in_progress | in_review | ready | merged | cancelled`）和事件；服务在 `server/services/teams/`。注意它不是用户分组，而是“项目内由协调者带子代理推进的工作团队”。
- **工作区（workspace）**：表 `workspaces`（按用户），成员在 `workspace_panels`，面板类型 `narrator | terminal | webview | outline`；`layout` 只存 dockview 排布。前端在 `frontend/components/narrator/workspace/`。
- **worktree**：叙述者专属的 git worktree，表 `narrator_worktree_resources`（设备、仓库键、`worktreePath`、状态 `preparing | ready | unknown`、归属范围），服务在 `server/services/narrator-worktree-service.ts`。
- **技能（skill）/ 例程（routine）**：技能是目录里的 `SKILL.md`，来源 `global | project | workspace`（`server/services/skill-service.ts`；全局在 `$NARRAFORK_HOME/skills/`，项目在 `<项目>/.narrafork/skills/`）。例程是内置可开关条目，类型 `command | skill | tool`（`server/lib/builtin-routines.ts`），启用状态写入用户偏好或项目 `chapterSettings`（`server/services/routine-service.ts`）。
- **知识库（knowledge base）**：表 `knowledge_collections` → `knowledge_entries`（每条有 `knowledge_revisions` 历史），访问由分级（`knowledge_levels`，带 rank）、标签（`knowledge_tags`/类型）和授权（`knowledge_grants`）控制，另有提交审核（`knowledge_submissions`）、条目链接、知识包；服务 `server/services/knowledge-*.ts`。
- **大纲（outline）**：表 `outline_spaces`（`kind` 为 `project | personal | session`），内含 `outline_blocks`（块树，带版本与提交 `outline_commits`）、任务认领 `outline_task_claims`、待确认项与提问；读写权限随空间类型决定（`server/services/outline/access.ts`）。可由设置关闭（`outline.enabled`）。

## 进程与目录地图

**进程。** 主进程是 `server/index.ts`：同一个可执行文件按参数分流——普通情况 `runServer()` 起 HTTP/WebSocket 服务（`server/serve.ts`）；Windows 编译版双击进入图形化管理器（`server/manager/`，管理器再以 `--serve` 拉起服务子进程）；还有若干只读/隔离子进程模式（数据库完整性探测、导出快照构建、文件变更物理审计、文件监听 worker、插件运行时 worker）。开发时 `bun run dev:all`（`server/dev-all.ts`）再起一个 Vite 进程（前端 41221，后端 7778）。独立于主进程的还有更新服务器 `update-server/`（自带 `Bun.serve`）和远程执行器（Go）。

**目录。**
- `server/`：后端。`routes/`（Hono 路由）、`services/`（业务）、`lib/agent/`（Agent Loop、提供商、工具、执行后端）、`db/`（schema、迁移、FTS、PG）、`websocket/`、`terminal/`、`gateway/`（IM 网关）、`manager/`、`builtin-plugins/`、`scripts/`。
- `frontend/`：React 前端（Vite 构建到 `dist/frontend/`）；`frontend/remote/` 是“远程访问”构建的入口。
- `shared/`：前后端及脚本共用的类型、协议、纯函数（约 240 个顶层条目），如 `pretext-layout/`、`remote-access/`、`update-index.ts`、`nav-layout.ts`。
- `remote-executor/`：Go 写的轻量远程执行器（`cmd/narrafork-executor`），部署在另一台机器上，让叙述者的文件/命令工具在那里执行；服务端一侧的设备表是 `remote_devices`，后端抽象在 `server/lib/agent/execution/`。
- `remote-peer/`：Go 写的远程访问对端（WebRTC，`peer.go`、`cmd/remote-peer`）；`remote-coordinator/`、`remote-host/`（TS）、`remote-prototype/` 属于远程访问基础设施/原型，协议在 `shared/remote-access/`。
- `update-server/`：更新服务器（Hono）。
- `vscode-extension/`：VS Code / code-server 扩展，只通过 HTTP 连接本机运行的 NarraFork 后端。
- `scripts/`：构建、发布、迁移生成、冒烟脚本；`tests/`：跨模块测试与测试基建（preload、夹具）；单元测试多与源码并排。
- `drizzle/`、`drizzle-postgres/`：SQLite / PostgreSQL 迁移（生成物，不手改）；`changelogs/`、`licenses/`、`patches/`、`vendor/zstd`、`examples/plugins`、`docs/`（设计文档，可能过时，以代码为准）。

## 下面有什么

- [运行平台](platform/index.md)：后端进程怎么启动、怎么接请求、怎么在线程之间分工，以及所有后端代码都要遵守的性能与隔离规则。
- [数据与存储](data/index.md)：数据库表、迁移、两种数据库后端、全文搜索、导入导出与存储清理。
- [叙述者（会话）](narrator/index.md)：NarraFork 的核心对象：一个绑定工作目录的 AI 会话。它的生命周期、消息存储、上下文、提示词与提问。
- [代理运行时](agent/index.md)：自定义 Agent Loop、多模型提供商、工具体系、子代理与执行后端。
- [权限与安全](security/index.md)：谁能做什么：工具调用审批、访问控制、登录、开放接口、外部进程加固。
- [文件与编辑](files/index.md)：受控文件写入、变更记录与回退、文件引用、编辑器文档、工作区布局。
- [代码仓库](git/index.md)：git 服务、状态与暂存、会话 worktree、分支与引用查询。
- [协作](collaboration/index.md)：项目、团队、聊天、通知与注意力、分享、IM 网关。
- [知识](kb/index.md)：团队知识库、大纲，以及这棵仓库知识树本身。
- [扩展与自动化](automation/index.md)：技能、例程与可选工具、定时任务、插件系统、钩子、基准测试与容器。
- [远程与设备](remote/index.md)：远程设备执行、远程访问、VS Code 插件。
- [前端](frontend/index.md)：React 19 + Mantine 应用：框架与路由、数据流、国际化、会话界面、组件与主题。
- [工程与发布](engineering/index.md)：开发命令与代码规范、测试、构建、发布与更新、第三方许可。
- [核心流程](flows/index.md)：跨主题的端到端路径：按发生顺序串起各个节点，改一个功能前先看它在哪条路径上。
