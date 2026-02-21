# NarraFork — 项目起始开发文档

## 1. 项目概述

NarraFork 是一个以"叙事分叉"为核心隐喻的 AI 编程协作平台。它将软件开发过程视为一个不断分叉和汇聚的故事网络，每个工作分支（Chapter）都有自己的 AI 叙述者（Narrator），能够在隔离的 git worktree 和可选的容器环境中独立工作，同时保持上下文的连贯性和可追溯性。

### 1.1 核心理念

- **Chapter（章节）**：工作的基本单元，对应一个 git worktree + 一个或多个 AI 会话
- **Narrator（叙述者）**：绑定到 Chapter 的 Claude Code 会话，拥有完整的上下文记忆
- **Story Network（故事网络）**：所有 Chapter 的分叉/合并关系构成的有向图

### 1.2 与 Fulcrum 的关系

NarraFork 借鉴 Fulcrum 的以下架构模式：
- Bun + Hono 后端框架
- SQLite + Drizzle ORM 数据层
- Git worktree 隔离工作区
- Claude Agent SDK 集成
- WebSocket 实时通信

差异点：
- 前端使用 React + Mantine（非 shadcn + Tailwind）
- 容器化使用 Podman（非 Docker Swarm）
- 核心抽象是 Chapter/Narrator（非 Task/Terminal）
- 会话管理是一等公民，支持分叉、回溯、继承

### 1.3 部署模式

NarraFork 面向小团队私有部署。所有用户共享项目和 Chapter 数据，无用户级数据隔离。认证系统用于身份识别和管理权限，而非数据权限分割。

---

## 2. 技术栈

### 2.1 后端
| 技术 | 用途 | 版本要求 |
|------|------|----------|
| Bun | 运行时 | >= 1.2 |
| Hono | HTTP 框架 | >= 4.x |
| SQLite | 数据库 | 内置于 Bun |
| Drizzle ORM | 数据库抽象 | >= 0.38 |
| @anthropic-ai/claude-agent-sdk | Claude Code 会话管理 | >= 0.2.39 |
| @modelcontextprotocol/sdk | MCP 工具暴露 | >= 1.x |
| nanoid | ID 生成 | >= 5.x |

### 2.2 前端
| 技术 | 用途 | 版本要求 |
|------|------|----------|
| React | UI 框架 | >= 19 |
| Mantine | 组件库 | >= 7.x |
| TanStack Router | 文件路由 | >= 1.x |
| TanStack React Query | 服务端状态 | >= 5.x |
| @xyflow/react (React Flow) | 故事网络可视化 | >= 12.x |
| @dagrejs/dagre | 图自动布局 | >= 1.x |
| xterm.js | 终端模拟 | >= 5.x |
| react-i18next + i18next | 国际化（英文 + 简体中文） | >= 16.x / >= 25.x |

### 2.3 工具链
| 技术 | 用途 |
|------|------|
| mise | 任务运行器 |
| drizzle-kit | 数据库迁移 |
| Vite | 前端构建 |
| Biome | Lint + Format |

### 2.4 外部依赖
| 依赖 | 用途 | 必需 |
|------|------|------|
| git | 版本控制、worktree | 是 |
| podman | 容器环境 | 否（可选功能） |
| dtach | 终端持久化 | 是 |
| claude-code CLI | AI agent | 是 |

---

## 3. 数据库 Schema

### 3.1 核心实体关系图

```
projects ──1:N──> chapters
chapters ──1:N──> narrators (chapterId nullable: null = 游离会话)
chapters ──self── chapters (parentChapterId)
chapters ──1:N──> container_instances
chapters ──1:N──> port_allocations
chapters ──1:N──> terminals
narrators ──1:N──> narrator_messages
narrators ──1:N──> narrator_tool_calls
narrators ──1:N──> conversation_branches
narrators ──ref──> conversation_branches (activeBranchId)
conversation_branches ──1:N──> branch_messages
narrator_messages ──1:N──> branch_messages
users ──1:1── user_preferences
users ──1:N── user_favorite_directories
```

> 注：`containerConfig` 以 JSON 字段存储在 `chapters` 表中，而非独立的 `container_configs` 表。
> `users` 表用于 JWT 认证，与上述业务实体无直接关联。
> 一个项目有且只有一个 Git 仓库，仓库信息直接存储在 `projects` 表中。
> 权限审批直接在 `narrator_tool_calls` 表中处理（`permissionDecidedBy`/`permissionDecidedAt` 等字段），无独立的 `permission_requests` 表。

### 3.2 表定义

#### projects — 项目
```typescript
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),                    // nanoid
  name: text('name').notNull(),
  description: text('description'),
  status: text('status', {
    enum: ['active', 'archived']
  }).notNull().default('active'),
  defaultAgent: text('default_agent', {
    enum: ['claude', 'opencode']
  }).default('claude'),
  settings: text('settings', { mode: 'json' }),   // 项目级配置 JSON
  gitPath: text('git_path'),                       // 本地绝对路径（一个项目一个仓库）
  remoteUrl: text('remote_url'),                   // git remote URL
  defaultBranch: text('default_branch').default('main'),
  startupScript: text('startup_script'),           // chapter 创建后执行的脚本
  copyFiles: text('copy_files'),                   // JSON 数组，如 ["*.env", ".vscode/"]
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
```

#### chapters — 章节（核心实体）

```typescript
export const chapters = sqliteTable('chapters', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull()
    .references(() => projects.id),
  title: text('title').notNull(),
  description: text('description'),

  // 状态机：active → merged/abandoned, dormant 是中间态
  status: text('status', {
    enum: ['active', 'dormant', 'merged', 'abandoned']
  }).notNull().default('active'),

  // Git 信息
  branch: text('branch').notNull(),                  // git branch 名
  worktreePath: text('worktree_path'),               // 章节根目录，dormant 时为 null
  baseBranch: text('base_branch').notNull(),          // 基于哪个 branch 创建

  // 分叉关系
  parentChapterId: text('parent_chapter_id')
    .references(() => chapters.id),
  forkPoint: text('fork_point', { mode: 'json' }), // { commitSha, narratorMessageUuid }

  // 合并信息
  mergedIntoChapterId: text('merged_into_chapter_id')
    .references(() => chapters.id),
  mergeCommitSha: text('merge_commit_sha'),
  mergeStrategy: text('merge_strategy', {
    enum: ['merge', 'squash', 'cherry-pick']
  }),

  // 容器配置（JSON 字段，非独立表）
  containerConfig: text('container_config', { mode: 'json' }),

  // 元数据
  lastAccessedAt: text('last_accessed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
```

> 章节目录结构：worktree 位于 `<project.gitPath>/.worktrees/<slug-shortId>/`
> ```
> /path/to/repo/.worktrees/add-auth-x7k2m9/   (worktree for this chapter)
> ```

#### narrators — 叙述者（AI 会话）

```typescript
export const narrators = sqliteTable('narrators', {
  id: text('id').primaryKey(),
  chapterId: text('chapter_id')              // null = 游离会话（standalone session）
    .references(() => chapters.id),

  // API 会话标识
  apiConversationId: text('api_conversation_id'),      // API 返回的 conversation_id，用于关联会话
  activeBranchId: text('active_branch_id'),        // 当前活跃的对话分支 ID
  type: text('type', {
    enum: ['primary', 'secondary']
  }).notNull().default('primary'),

  // 上下文继承配置
  inheritMode: text('inherit_mode', {
    enum: ['full', 'compressed', 'fresh']
  }).notNull().default('fresh'),
  parentNarratorId: text('parent_narrator_id')
    .references(() => narrators.id),
  contextSummary: text('context_summary'),         // compressed 模式或 compact 摘要

  // 会话标题（自动生成或手动设置）
  title: text('title'),

  // 会话配置
  model: text('model').default('claude-sonnet'),
  systemPrompt: text('system_prompt'),             // 额外的 system prompt
  permissionMode: text('permission_mode', {
    enum: ['default', 'acceptEdits', 'bypassPermissions', 'dontAsk']
  }).default('default'),

  // 工作目录（游离会话使用，chapter 会话从 worktree 获取）
  cwd: text('cwd'),

  // TodoWrite 工具持久化
  todosJson: text('todos_json', { mode: 'json' }),     // JSON 数组，TodoWrite 工具写入的 todos
  todosToolUseId: text('todos_tool_use_id'),            // 关联的 tool_use_id

  // 统计
  messageCount: integer('message_count').default(0),
  totalCostUsd: real('total_cost_usd').default(0),
  lastMessageAt: text('last_message_at'),

  // 状态：idle（空闲）、thinking（处理中）、waiting（等待权限审批）、done（完成待阅读）、archived（已归档）、error、interrupted（已中断）
  status: text('status', {
    enum: ['idle', 'thinking', 'waiting', 'done', 'archived', 'error', 'interrupted']
  }).notNull().default('idle'),
  sdkPlanMode: integer('sdk_plan_mode', { mode: 'boolean' }).notNull().default(false),
  errorMessage: text('error_message'),

  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
```

#### narrator_messages — 会话消息

```typescript
export const narratorMessages = sqliteTable('narrator_messages', {
  id: text('id').primaryKey(),
  narratorId: text('narrator_id').notNull()
    .references(() => narrators.id),
  // SDK 消息 UUID，用于 resumeSessionAt 回溯分叉
  sdkMessageUuid: text('sdk_message_uuid'),
  role: text('role', {
    enum: ['user', 'assistant', 'system']
  }).notNull(),

  // 存储完整的 BetaMessage.content 数组（包含 text、tool_use、thinking blocks）
  // system 消息用于 compact 标记：[{type: "compact", status: "compacted", summary}]
  contentJson: text('content_json', { mode: 'json' }).notNull(),

  // 纯文本内容（用于搜索和预览）
  contentText: text('content_text'),

  // 子 agent 消息关联：指向父 tool_use_id，用于懒加载子 agent 消息树
  parentToolUseId: text('parent_tool_use_id'),

  // Token 统计与用量
  tokensIn: integer('tokens_in'),
  costUsd: real('cost_usd'),
  turnUsageJson: text('turn_usage_json', { mode: 'json' }),  // 完整的 turn 用量 JSON
  contextPercent: real('context_percent'),                     // 上下文窗口使用百分比
  meterUsage: real('meter_usage'),                             // 计量用量
  meterUnit: text('meter_unit'),                               // 计量单位

  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_messages_narrator').on(table.narratorId, table.createdAt),
  index('idx_messages_parent_tool_use').on(table.narratorId, table.parentToolUseId),
  index('idx_messages_toplevel').on(table.narratorId, table.parentToolUseId, table.createdAt),
])
```
#### narrator_tool_calls — Tool Call 记录（含权限审批）

```typescript
export const narratorToolCalls = sqliteTable('narrator_tool_calls', {
  id: text('id').primaryKey(),
  narratorId: text('narrator_id').notNull()
    .references(() => narrators.id),
  messageId: text('message_id').notNull()
    .references(() => narratorMessages.id),

  toolUseId: text('tool_use_id').notNull(),        // SDK 的 tool_use_id
  toolName: text('tool_name').notNull(),
  inputJson: text('input_json', { mode: 'json' }), // tool call 参数
  outputJson: text('output_json', { mode: 'json' }),// tool call 结果
  status: text('status', {
    enum: ['initializing', 'pending', 'running', 'success', 'fail']
  }).notNull().default('initializing'),
  durationMs: integer('duration_ms'),
  errorMessage: text('error_message'),

  // 权限审批（内联，无独立 permission_requests 表）
  permissionDecidedBy: text('permission_decided_by'),       // 'user' | 'auto' | 'auto_timeout' | 'aborted' | 'server_restart'
  permissionDecidedAt: text('permission_decided_at'),
  permissionDenyMessage: text('permission_deny_message'),
  permissionDecisionReason: text('permission_decision_reason'),
  permissionSuggestions: text('permission_suggestions', { mode: 'json' }),  // PermissionUpdate[]

  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_toolcalls_message').on(table.messageId),
  index('idx_toolcalls_status').on(table.narratorId, table.status),
])
```

#### conversation_branches — 对话分支

每个叙述者创建时自动生成一个 root 分支（name="main"）。用户可从任意消息 fork 新分支，fork 时复制父分支中 fork 点及之前的消息引用（共享前缀）。

```typescript
export const conversationBranches = sqliteTable('conversation_branches', {
  id: text('id').primaryKey(),
  narratorId: text('narrator_id').notNull()
    .references(() => narrators.id),
  name: text('name').notNull(),                     // 分支名称，如 "main"、"Branch 2"
  forkMessageId: text('fork_message_id'),           // fork 起点消息 ID（root 分支为 null）
  parentBranchId: text('parent_branch_id')          // 父分支 ID（root 分支为 null）
    .references(() => conversationBranches.id),
  apiConversationId: text('api_conversation_id'),       // 分支独立的 API conversation ID
  contextSummary: text('context_summary'),          // 分支级别的上下文摘要
  status: text('status', {
    enum: ['active', 'archived']
  }).notNull().default('active'),
  messageCount: integer('message_count').default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_branches_narrator').on(table.narratorId),
  index('idx_branches_parent').on(table.parentBranchId),
])
```

#### branch_messages — 分支-消息关联表（junction table）

消息与分支的多对多关系。同一条消息可属于多个分支（fork 时共享前缀）。`seq` 字段维护分支内的消息顺序，`isCompact` 标记压缩点位置。

```typescript
export const branchMessages = sqliteTable('branch_messages', {
  id: text('id').primaryKey(),
  branchId: text('branch_id').notNull()
    .references(() => conversationBranches.id),
  messageId: text('message_id').notNull()
    .references(() => narratorMessages.id),
  seq: integer('seq').notNull(),                    // 分支内排序序号
  isCompact: integer('is_compact').notNull().default(0),  // 1 = compact 标记点
}, (table) => [
  uniqueIndex('idx_branch_messages_unique').on(table.branchId, table.messageId),
  index('idx_branch_messages_seq').on(table.branchId, table.seq),
  index('idx_branch_messages_message').on(table.messageId),
])
```

#### terminals — 终端实例

```typescript
export const terminals = sqliteTable('terminals', {
  id: text('id').primaryKey(),
  chapterId: text('chapter_id')
    .references(() => chapters.id),
  name: text('name').notNull(),
  cwd: text('cwd'),
  dtachSocket: text('dtach_socket'),               // dtach socket 路径
  status: text('status', {
    enum: ['running', 'exited']
  }).notNull().default('running'),
  exitCode: integer('exit_code'),
  createdAt: text('created_at').notNull(),
})
```

#### container_instances — 容器实例

```typescript
export const containerInstances = sqliteTable('container_instances', {
  id: text('id').primaryKey(),
  chapterId: text('chapter_id').notNull()
    .references(() => chapters.id),
  containerId: text('container_id'),               // podman container ID
  serviceName: text('service_name').notNull(),
  status: text('status', {
    enum: ['created', 'running', 'paused', 'stopped', 'removed']
  }).notNull().default('created'),
  hostPort: integer('host_port'),
  containerPort: integer('container_port'),
  volumeName: text('volume_name'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
```

#### port_allocations — 端口分配池

```typescript
export const portAllocations = sqliteTable('port_allocations', {
  port: integer('port').primaryKey(),
  chapterId: text('chapter_id')
    .references(() => chapters.id),
  serviceName: text('service_name'),
  allocatedAt: text('allocated_at').notNull(),
})
```

#### users — 用户账户

```typescript
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', {
    enum: ['admin', 'user']
  }).notNull().default('user'),
  createdAt: text('created_at').notNull(),
})
```

#### user_preferences — 用户偏好设置

```typescript
export const userPreferences = sqliteTable('user_preferences', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique(),       // 每用户一条记录
  autoLoadOlderMessages: integer('auto_load_older_messages', { mode: 'boolean' }).notNull().default(true),
  language: text('language').notNull().default('en'),
  wordWrapMarkdown: integer('word_wrap_markdown', { mode: 'boolean' }).notNull().default(true),
  wordWrapCode: integer('word_wrap_code', { mode: 'boolean' }).notNull().default(true),
  wordWrapDiff: integer('word_wrap_diff', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
```

#### user_favorite_directories — 用户收藏目录

```typescript
export const userFavoriteDirectories = sqliteTable('user_favorite_directories', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  label: text('label'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
})
```

#### FTS5 全文搜索虚拟表

```sql
-- 章节搜索（trigram tokenizer 支持 CJK）
CREATE VIRTUAL TABLE chapters_fts USING fts5(
  title, description, content=chapters, content_rowid=rowid, tokenize='trigram'
);

-- 消息搜索
CREATE VIRTUAL TABLE narrator_messages_fts USING fts5(
  content_text, content=narrator_messages, content_rowid=rowid, tokenize='trigram'
);

-- 叙述者标题搜索
CREATE VIRTUAL TABLE narrators_fts USING fts5(
  title, content='narrators', content_rowid=rowid, tokenize='trigram'
);
```

### 3.3 索引策略

```typescript
// 高频查询索引
export const chaptersByProject = index('idx_chapters_project')
  .on(chapters.projectId, chapters.status)
export const chaptersByParent = index('idx_chapters_parent')
  .on(chapters.parentChapterId)
export const narratorsByChapter = index('idx_narrators_chapter')
  .on(narrators.chapterId)
export const messagesByNarrator = index('idx_messages_narrator')
  .on(narratorMessages.narratorId, narratorMessages.createdAt)
export const toolCallsByMessage = index('idx_toolcalls_message')
  .on(narratorToolCalls.messageId)
export const permissionsByNarrator = index('idx_permissions_narrator')
  .on(permissionRequests.narratorId, permissionRequests.decision)
```

---

## 4. 服务层架构

### 4.1 目录结构

```
server/
  index.ts                    # 入口，启动 Bun HTTP + WebSocket
  app.ts                      # Hono 路由注册 + 全局错误处理
  db/
    schema.ts                 # Drizzle schema（上述所有表）
    relations.ts              # Drizzle 关系定义
    index.ts                  # DB 连接 + 导出
    migrate.ts                # 迁移脚本
  routes/
    projects.ts               # 项目 CRUD
    chapters.ts               # 章节 CRUD + 分叉/合并 + 容器管理
    narrators.ts              # 叙述者管理 + 消息流 + 权限审批 + 游离会话
    terminals.ts              # 终端管理
    auth.ts                   # 注册 / 登录 / 当前用户
    admin.ts                  # 用户管理 + 全局设置
    settings.ts               # 全局配置管理
    user-preferences.ts       # 用户偏好设置（autoLoadOlderMessages 等）
    favorites.ts              # 用户收藏目录 CRUD
    uploads.ts                # 图片上传文件服务
    graph.ts                  # 故事网络图数据
    search.ts                 # 全文搜索
    mcp.ts                    # MCP 工具暴露
  services/
    chapter-service.ts        # 章节生命周期
    chapter-fork.ts           # 分叉逻辑（原子操作 + 回滚）
    chapter-merge.ts          # 合并逻辑（冲突检测 + AI 辅助解决）
    chapter-batch-merge.ts    # 批量合并编排（队列式处理 + 冲突等待）
    chapter-cleanup.ts        # 批量清理 + 自动休眠/唤醒
    narrator-service.ts       # 叙述者生命周期
    narrator-session.ts       # Claude SDK session 管理 + 权限审批
    narrator-context.ts       # 上下文继承（full/compressed/fresh）
    narrator-title.ts         # 会话标题自动生成（Haiku 模型）
    container-service.ts      # 容器管理（Docker/Podman compose）
    port-allocator.ts         # 端口分配
    git-service.ts            # Git 操作封装
    terminal-service.ts       # 终端 + dtach PTY 管理
    search-service.ts         # 全文搜索（FTS5 + LIKE 降级）
  middleware/
    auth.ts                   # JWT 认证 + 管理员权限中间件
  websocket/
    ws-handler.ts             # WebSocket 消息路由（统一入口）
    terminal-ws.ts            # 终端 I/O
    narrator-ws.ts            # 叙述者实时事件（消息流、权限请求、合并进度）
  lib/
    settings/                 # 配置管理（加载/保存 ~/.narrafork/settings.json）
    auth.ts                   # JWT 签发/验证 + 用户注册/登录
    event-bus.ts              # 类型化事件总线
    validators.ts             # Zod 请求验证器
    logger.ts                 # JSONL 日志
    errors.ts                 # 错误类型（AppError / NotFoundError / ValidationError）
    id.ts                     # nanoid 生成器
```

> 设计偏差说明：
> - 容器路由整合到 `chapters.ts`（容器是 chapter 的子资源），不再有独立的 `containers.ts`
> - 权限审批逻辑整合到 `narrator-session.ts`（与 session 生命周期紧密耦合），不再有独立的 `narrator-permission.ts`
> - 终端 PTY 管理整合到 `terminal-service.ts`（dtach 模式不需要独立 PTY 管理器），不再有独立的 `terminal/` 目录
> - 事件通知由 `event-bus.ts` + `narrator-ws.ts` 组合实现，不再有独立的 `notification-service.ts`
> - 游离会话（standalone sessions）整合到 `narrators.ts`（通过 `chapterId=null` 区分），不再有独立的 `sessions.ts` 路由
### 4.2 核心服务设计

#### 4.2.1 chapter-fork.ts — 分叉服务

职责：从父 Chapter 创建新的分叉 Chapter，包含 git worktree、Narrator 继承、可选容器。从项目的 `gitPath` 获取仓库信息。

核心操作流程（6 步原子操作 + 回滚栈）：
1. 创建 Git branch + worktree（`<project.gitPath>/.worktrees/<slug-shortId>/`）
2. 创建 DB 记录（chapter + forkPoint）
3. 复制 repo 配置的 copyFiles
4. Fork Narrator(s)（根据 inheritMode 调用 narrator-context）
5. 复制 containerConfig + 可选启动容器（non-fatal，失败不回滚）
6. 执行 startup script（non-fatal，60 秒超时）

关键设计：
- 使用 `rollback: Array<() => Promise<void>>` 手动回滚栈，每步成功后 push 逆操作
- 失败时逆序执行回滚，覆盖 DB + git + container 跨系统操作
- Branch 命名规则：`chapter/{slug}-{nanoid(6)}`，如 `chapter/add-auth-x7k2m9`
- 支持 `forkAtMessageUuid` 回溯分叉，记录在 `forkPoint.narratorMessageUuid`

#### 4.2.1b narrator-service.ts — 叙述者生命周期与消息管理

职责：叙述者 CRUD、消息持久化、对话分支管理、Compact 机制。

核心功能：
- `create()` — 创建叙述者，自动创建 root 对话分支（name="main"），设置 `activeBranchId`
- `persistUserMessage()` / `persistAssistantMessage()` — 消息持久化，同时写入 `narrator_messages` 和 `branch_messages`（junction table），维护分支内 `seq` 排序
- `getMessagesCursor()` — 基于 `branch_messages.seq` 的游标分页，查询当前活跃分支的顶层消息，再递归加载子 agent 消息树（通过 `parentToolUseId` 关联）
- `getMessagesAround()` — 围绕指定消息加载上下文（用于搜索结果定位）
- `getMessagesSinceLastCompact()` — 从最近的 compact 标记之后加载消息（用于 SDK 历史重建）

对话分支管理：
- `createBranch()` — 从指定消息 fork 新分支，复制父分支中 fork 点及之前的 `branch_messages` 记录（共享前缀），自动切换到新分支
- `switchBranch()` — 切换活跃分支，更新 `narrators.activeBranchId`
- `deleteBranch()` — 删除分支，提升子分支到父分支，清理孤儿消息（仅属于该分支的消息）

Compact 机制：
- `persistCompactingMessage()` — 插入 role=system 的 compact 占位消息（`status: "compacting"`），支持指定 `beforeMessageId` 进行部分压缩
- `finalizeCompactingMessage()` — 将占位消息更新为完成状态（`status: "compacted"`，含 summary），在 `branch_messages` 中标记 `isCompact=1`
- `deleteCompactMessage()` / `updateCompactSummary()` — compact 标记的撤销和编辑

消息树构建：
- `buildMessageTree()` — 将扁平消息列表构建为树结构，子消息通过 `parentToolUseId` 嵌套到父消息的 `children` 数组
- `truncateToolIO()` — 递归截断大型 tool call 的 inputJson/outputJson（默认 2000 字符），完整数据通过 `/tool-calls/:toolUseId` 端点获取

#### 4.2.2 narrator-session.ts — Claude Session 管理

职责：封装 AI provider 的流式调用，管理会话的创建和上下文重建，以及消息缓冲和权限审批。

核心功能：
- `startSession()` — 统一入口，根据 narrator 状态自动判断新建或恢复会话。传入 `cwd`、`model`、`permissionMode`。无 `apiConversationId` 时生成新 ID，有则复用。每次请求通过 `buildHistory()` 从 DB 消息重建完整对话历史。
- `interruptSession()` — 中断当前执行
- `recoverOnStartup()` — 服务器重启恢复逻辑：重置 `thinking` 状态的 narrator 为 `idle`，自动拒绝 pending 权限请求，标记 running tool calls 为 failed
- `isSessionActive()` — 检查 narrator 是否有活跃的 SDK session
- `setBufferedMessage()` / `clearBufferedMessage()` / `getBufferedMessage()` — 消息缓冲管理，允许用户在 narrator thinking 时排队下一条消息

关键设计：
- 内存中维护 `Map<narratorId, { query, abortController }>` 用于中断控制
- `startSession()` 是异步生成器，内部 `processSDKMessage()` 处理每条消息：捕获 `session_id` 持久化到 DB、持久化 assistant 消息、更新统计、广播到 WebSocket
- 两阶段标题生成：首条用户消息时立即调用 `generateQuickTitle()` 生成快速标题（不等 AI 回复），session 结束后再调用 `generateAndSetTitle()` 生成更准确的标题（会 await quickTitle 完成以避免竞态）
- 权限模式自动处理：
  - `default` 模式：启用 `canUseTool` 回调，走完整审批流程
  - `acceptEdits` 模式：自动允许 `Edit`/`Write`/`NotebookEdit`/`MultiEdit` 工具，其余走审批
  - `bypassPermissions` / `dontAsk` 模式：SDK 层面跳过所有权限检查
  - `plan` 模式：SDK 层面进入 plan 模式
- `canUseTool` 对 `TodoWrite`/`TodoRead` 工具自动允许（白名单），不需要用户审批
- 权限审批流程：创建 tool_call 记录（status: initializing）→ 判断权限决策（auto allow/deny/ask）→ 需要用户审批时更新 status 为 pending → WebSocket 推送 `permission_request` → 等待决定（5 分钟超时，超时自动拒绝，`permissionDecidedBy: "auto_timeout"`）→ 更新 tool_call 记录 → 返回 SDK。权限状态直接记录在 `narrator_tool_calls` 表上，无独立的 `permission_requests` 表
- "Allow with feedback" 流程：用户批准权限时附带 `feedbackText`，session 在当前 tool 完成后中断，feedbackText 作为下一条用户消息自动发送
- 消息缓冲：用户在 narrator thinking 时可通过 WebSocket 发送 `buffer_message`，session 结束后自动链式发送缓冲消息
- `TodoWrite` 工具结果自动持久化到 narrator 的 `todosJson` 字段
- Session 结束时状态设为 `done`（而非 `idle`），前端通过 `mark-read` 端点手动重置为 `idle`
#### 4.2.3 narrator-context.ts — 上下文继承

职责：在 Chapter 分叉时处理 Narrator 的上下文继承策略。

三种继承模式：
- **full**：SDK 原生 `resume` + `forkSession` + `resumeSessionAt`，零成本完整继承。实际 fork 延迟到首次发消息时执行，创建时只记录 `parentNarratorId`
- **compressed**：用 Haiku 模型对父 Narrator 最近 50 条消息生成摘要，存入 `contextSummary` 字段。新 session 启动时将摘要注入 system prompt
- **fresh**：全新 session，不带任何历史上下文

关键设计：
- compressed 模式使用 `settings.agent.summaryModel`（可配置，默认 `haiku`），`maxTurns: 1`，`tools: []` 明确禁用工具
- 摘要 prompt 要求关注：已做决策、代码当前状态、待办事项、关键上下文
- 摘要语言跟随原对话语言

#### 4.2.4 narrator-title.ts — 会话标题自动生成

职责：使用 Haiku 模型根据会话消息自动生成简短标题。支持两阶段生成。

核心功能：
- `generateTitle(narratorId)` — 读取前 4 条消息，使用 `settings.agent.summaryModel` 生成最多 50 字符的标题
- `generateQuickTitle(narratorId, userMessage)` — 仅根据用户消息快速生成标题（不等 AI 回复），fire-and-forget，错误仅记录不抛出
- `generateAndSetTitle(narratorId)` — fire-and-forget 版本，生成后持久化到 DB 并通过 WebSocket 广播 `title_updated` 事件 + eventBus 发射 `narrator:title_updated`

关键设计：
- 两阶段标题生成：首条用户消息时 `generateQuickTitle` 立即生成快速标题，session 结束后 `generateAndSetTitle` 生成更准确的标题
- `generateAndSetTitle` 会 await `quickTitlePromise` 完成后再执行，避免竞态覆盖
- 标题用于前端会话列表展示和 `narrators_fts` 全文搜索

#### 4.2.5 chapter-merge.ts — 合并服务

职责：处理 Chapter 间的代码合并，包括冲突预检测和 AI 辅助解决。

核心功能：
- `checkMergeConflicts()` — 使用 `git merge-tree` 模拟合并，不修改工作区，返回冲突文件列表
- `mergeChapter()` — 执行实际合并，支持三种策略：merge、squash、cherry-pick
- `aiResolveConflicts()` — 冲突时让目标 Chapter 的 primary Narrator 自动解决

三层冲突处理：
1. **预检测**：`git merge-tree` + `git merge-base` 模拟，UI 展示冲突文件
2. **AI 辅助**：少量冲突（≤5 文件）时可选让 Narrator 自动解决
3. **手动 UI**：前端展示冲突 diff，用户手动编辑

关键设计：
- 合并成功后更新 source chapter 状态为 `merged`，记录 `mergedIntoChapterId` 和 `mergeCommitSha`
- cherry-pick 策略按 commit 顺序逐个 pick（`--reverse`）
- AI 解决冲突时 resume 目标 Narrator 的 session，提供冲突文件列表
#### 4.2.6 container-service.ts — Podman 容器管理

职责：管理 Chapter 的可选 Podman 容器环境生命周期。

核心功能：
- `startChapterContainers()` — 根据 chapter.containerConfig 启动 `podman compose up -d`，自动发现 compose 文件（支持多种常见文件名），分配端口
- `stopChapterContainers()` — 停止容器（`podman compose stop`），不删除
- `pauseChapterContainers()` — chapter 休眠时暂停容器（`podman compose pause`）
- `unpauseChapterContainers()` — chapter 唤醒时恢复容器（`podman compose unpause`），失败时 fallback 到完整 remove + start
- `removeChapterContainers()` — 停止并删除容器 + 释放端口 + 清理 DB 记录，可选删除 volumes
- `getContainerLogs()` — 获取容器日志（`podman compose logs`），支持 tail 和按 service 过滤
- `listByChapter()` — 查询 chapter 的容器实例记录

端口分配（独立模块 `port-allocator.ts`）：
- `portAllocator.allocate()` — 从 DB 端口池分配不冲突的 host 端口，支持并发冲突重试
- `portAllocator.release()` — 释放 chapter 占用的端口
- `portAllocator.listByChapter()` — 查询端口分配

关键设计：
- 固定使用 `podman compose` CLI（非 REST API），rootless 模式
- 端口池范围：10000-20000，通过 `port_allocations` 表管理，insert 时 catch 主键冲突实现并发安全
- 环境变量注入 `NARRAFORK_CHAPTER_ID` 和 `NARRAFORK_VOLUME_PREFIX` 用于隔离
- 端口映射通过 `PORT_{containerPort}` 环境变量传递给 compose
- compose 文件解析带路径穿越防护（resolve 后校验仍在 worktree 内）
#### 4.2.7 chapter-cleanup.ts — 批量清理

职责：批量清理不再需要的 Chapter 资源，以及自动休眠/唤醒不活跃 Chapter。

核心功能：
- `batchCleanup()` — 批量清理指定 chapters，返回 `CleanupReport { cleaned, skipped, errors }`
- `dormantInactiveChapters()` — 按 `lastAccessedAt` 排序，超出 `maxActiveWorktrees` 的自动休眠
- `scheduleAutoDormant()` — 防抖调度（30 秒窗口），在 chapter 创建和访问时触发
- `wakeChapter()` — 唤醒 dormant chapter，重建 worktree + 恢复容器

清理流程（每个 chapter）：
1. Dirty check — 检查 `git status --porcelain`，有未提交更改时跳过（除非 force）
2. 停止并删除容器（可选删除 volumes）
3. 清理 chapter 下所有终端（`terminalService.cleanupForChapter`）
4. 删除 worktree（`git worktree remove`）
5. 删除 branch（`git branch -D`，可选）
6. 更新状态为 `abandoned`

休眠流程：
1. 清理 chapter 下所有终端
2. 暂停容器（pause，非 remove）
3. 自动 commit 未保存更改（`git add -A && git commit -m "auto-save before dormant"`）
4. 删除 worktree（保留 branch）
5. 状态设为 `dormant`，`worktreePath` 置 null

唤醒流程：
1. 重建 worktree（`git worktree add`，使用已有 branch）
2. 重启容器（如有 containerConfig）
3. 状态恢复为 `active`

#### 4.2.8 chapter-batch-merge.ts — 批量合并编排

职责：按顺序将多个 source chapter 合并到同一个 target chapter，支持冲突时暂停等待用户决策。

核心功能：
- `run()` — 启动批量合并会话，创建临时 fork 作为合并目标，按队列顺序合并
- `processQueue()` — 逐个处理合并队列，冲突时通过 eventBus 广播 `merge:conflict`，等待用户决策（continue/cancel）
- `rollback()` — 合并失败时删除临时 fork chapter

关键设计：
- 合并在临时 fork 上进行，全部成功后才 fast-forward 目标 branch
- 通过 `merge:*` 事件族广播进度，前端可实时展示每一步状态
- 支持 AI 自动解决冲突（`merge:ai_resolving` 事件）或等待用户手动决策

#### 4.2.9 terminal-service.ts — 终端管理

职责：管理 Chapter 的终端实例，通过 dtach 实现终端持久化。

核心功能：
- `create()` / `list()` / `kill()` — 终端 CRUD
- `cleanupForChapter(chapterId)` — 批量清理 chapter 下所有终端，被 chapter-cleanup 和 chapter-service 调用
- `recoverOnStartup()` — 服务器重启时恢复 running 状态的终端（重新 attach dtach socket）

#### 4.2.10 search-service.ts — 全文搜索

职责：基于 FTS5 虚拟表提供全文搜索，支持 chapters、messages、narrators 三种实体。

核心功能：
- `search(query, entities, limit)` — 统一搜索入口，返回按实体分组的结果

关键设计：
- 查询长度 < 3 时自动降级为 LIKE 搜索（trigram tokenizer 要求 >= 3 字符）
- 查询字符串进行特殊字符清理（防 FTS5 注入）

---

## 5. API 路由设计

### 5.1 RESTful 端点

#### Projects
```
GET    /api/projects                    # 列表（支持 ?status=active|archived）
POST   /api/projects                    # 创建
GET    /api/projects/:id                # 详情
PATCH  /api/projects/:id                # 更新
DELETE /api/projects/:id                # 删除
```

#### Chapters
```
GET    /api/chapters                    # 列表（?projectId=&status=&type=）
POST   /api/chapters                    # 创建（直接创建，非分叉）
GET    /api/chapters/:id                # 详情
PATCH  /api/chapters/:id                # 更新
DELETE /api/chapters/:id                # 删除

POST   /api/chapters/:id/fork           # 分叉
GET    /api/chapters/:id/merge-check    # 预检测合并冲突
POST   /api/chapters/:id/merge          # 合并到目标 chapter
POST   /api/chapters/:id/ai-resolve     # AI 辅助解决合并冲突
POST   /api/chapters/:id/wake           # 唤醒 dormant chapter
POST   /api/chapters/:id/dormant        # 手动休眠

POST   /api/chapters/cleanup            # 批量清理
POST   /api/chapters/batch-merge        # 批量合并

# 容器管理（子资源，无独立 containers 路由文件）
GET    /api/chapters/:id/containers                # 容器列表
POST   /api/chapters/:id/containers/start          # 启动
POST   /api/chapters/:id/containers/stop           # 停止
POST   /api/chapters/:id/containers/pause          # 暂停
POST   /api/chapters/:id/containers/unpause        # 恢复
GET    /api/chapters/:id/containers/logs            # 容器日志
POST   /api/chapters/:id/containers/remove          # 删除容器（可选删除 volumes）
```

#### Narrators（含游离会话）
```
GET    /api/narrators                              # 列表（?chapterId=&standalone=true）
POST   /api/narrators                              # 创建（chapterId 为空时创建游离会话）
GET    /api/narrators/:id                          # 详情
DELETE /api/narrators/:id                          # 删除

POST   /api/narrators/:id/messages                 # 发送消息（SSE 流式响应，支持 multipart 图片上传）
GET    /api/narrators/:id/messages                 # 历史消息（?limit=&cursor=&branchId=&around=）
GET    /api/narrators/:id/buffer                   # 获取缓冲消息（多设备同步）
GET    /api/narrators/:id/tool-calls/:toolUseId    # 获取完整 tool call 详情（未截断）

POST   /api/narrators/:id/compact                  # 触发手动 compact（?beforeMessageId=）
GET    /api/narrators/:id/compact/:messageId        # 获取 compact 摘要
PATCH  /api/narrators/:id/compact/:messageId        # 更新 compact 摘要
DELETE /api/narrators/:id/compact/:messageId        # 删除 compact 标记（撤销 compact）

POST   /api/narrators/:id/interrupt                # 中断当前执行
PATCH  /api/narrators/:id/permission-mode          # 切换权限模式
PATCH  /api/narrators/:id/model                    # 切换模型
PATCH  /api/narrators/:id/title                    # 手动更新标题
POST   /api/narrators/:id/generate-title           # AI 自动生成标题
PATCH  /api/narrators/:id/archive                  # 归档叙述者
PATCH  /api/narrators/:id/unarchive                # 取消归档
PATCH  /api/narrators/:id/mark-read                # 标记已读（done → idle）
```

#### Conversation Branches
```
GET    /api/narrators/:id/branches                 # 列表分支
POST   /api/narrators/:id/branches                 # 创建分支（fork from message）
PATCH  /api/narrators/:id/branches/:branchId       # 更新分支（重命名/归档）
DELETE /api/narrators/:id/branches/:branchId       # 删除分支（孤儿消息自动清理）
POST   /api/narrators/:id/branches/:branchId/switch # 切换活跃分支
POST   /api/narrators/:id/branches/root/switch     # 切换到 root 分支
```

#### Permission Requests
```
GET    /api/narrators/:id/permissions              # 待审批列表
POST   /api/narrators/permissions/:requestId/approve  # 批准
POST   /api/narrators/permissions/:requestId/deny     # 拒绝
```

#### Auth
```
POST   /api/auth/register                          # 注册（首个用户自动成为 admin）
POST   /api/auth/login                             # 登录（返回 JWT）
GET    /api/auth/me                                # 当前用户信息（需认证）
GET    /api/auth/status                            # 公开端点，返回 { hasUsers, registrationOpen }
```

#### Health
```
GET    /api/health                                 # 公开端点，健康检查
```

#### Admin
```
GET    /api/admin/users                            # 用户列表
DELETE /api/admin/users/:id                        # 删除用户
PATCH  /api/admin/settings                         # 更新全局设置（registrationOpen）
```

#### Settings
```
GET    /api/settings                               # 获取配置
PATCH  /api/settings                               # 更新配置（深度合并）
```

#### Story Network Graph
```
GET    /api/projects/:id/graph                     # 故事网络图数据
```

#### Search
```
GET    /api/search?q=&entities=chapters,messages,narrators&limit=  # 全文搜索（默认搜索 chapters,messages,narrators）
```

#### User Preferences
```
GET    /api/user-preferences                       # 获取当前用户偏好
PATCH  /api/user-preferences                       # 更新偏好（原子 upsert）
```

#### Favorite Directories
```
GET    /api/favorites                              # 列表
POST   /api/favorites                              # 添加收藏目录
PATCH  /api/favorites/:id                          # 更新
DELETE /api/favorites/:id                          # 删除
PUT    /api/favorites/reorder                      # 重排序
```

#### Uploads
```
GET    /api/uploads/:narratorId/:imageId           # 获取上传的图片（带缓存头）
```

### 5.2 WebSocket 端点

```
/ws/terminal          # 终端 I/O（复用 Fulcrum 的协议）
/ws/narrator          # Narrator 实时事件
```

#### Narrator WebSocket 消息类型

```typescript
// 服务端 → 客户端
type NarratorWSMessage =
  | { type: 'message'; narratorId: string; message: SDKMessage }
  | { type: 'permission_request'; narratorId: string; request: PermissionRequest }
  | { type: 'permission_resolved'; narratorId: string; requestId: string; decision: string }
  | { type: 'status_changed'; narratorId: string; status: NarratorStatus }
  | { type: 'stream_event'; narratorId: string; event: any }
  | { type: 'tool_completed'; narratorId: string; toolUseId: string; status: string; output?: any }
  | { type: 'tool_progress'; narratorId: string; toolUseId: string; elapsed: number }
  | { type: 'title_updated'; narratorId: string; title: string }
  | { type: 'todos_updated'; narratorId: string; todos: any[]; toolUseId?: string }
  | { type: 'buffer_set'; narratorId: string; text: string }
  | { type: 'buffer_cleared'; narratorId: string; reason: 'cancelled' | 'sent' | 'session_error' }
  | { type: 'error'; message: string }

// 客户端 → 服务端
type NarratorWSCommand =
  | { type: 'subscribe'; narratorIds: string[] }
  | { type: 'unsubscribe'; narratorIds: string[] }
  | { type: 'permission_decision'; requestId: string; decision: 'allow' | 'deny'; message?: string; answers?: Record<string, string>; feedbackText?: string }
  | { type: 'buffer_message'; narratorId: string; text: string; images?: string[] }
  | { type: 'cancel_buffer'; narratorId: string }
  | { type: 'merge_decision'; mergeSessionId: string; decision: 'continue' | 'cancel' }
```

### 5.3 MCP 工具（暴露给 Agent）

```typescript
// 让 Agent 能自主管理 Chapter
const mcpTools = [
  'narrafork_list_chapters',       // 列出当前项目的 chapters
  'narrafork_fork_chapter',        // 分叉当前 chapter
  'narrafork_merge_chapter',       // 合并 chapter
  'narrafork_check_conflicts',     // 检查合并冲突
  'narrafork_abandon_chapter',     // 放弃当前 chapter
  'narrafork_list_narrators',      // 列出 narrators
  'narrafork_get_context_summary', // 获取其他 narrator 的上下文摘要
]
```

---

## 6. 前端架构

### 6.1 目录结构

```
frontend/
  main.tsx                  # i18n init + MantineProvider（auto 主题）+ QueryClient + RouterProvider + PWA 注册
  routes/
    __root.tsx                # 根布局（AppShell + 认证守卫 + 全局搜索 + 导航）
    index.tsx                 # 首页/仪表盘
    login.tsx                 # 登录/注册页面
    search.tsx                # 搜索结果页面
    projects/
      index.tsx               # 项目列表
      $projectId.tsx          # 项目详情
      $projectId.graph.tsx    # 故事网络图
    chapters/
      $chapterId.tsx          # Chapter 详情（Narrator + Terminal）
    sessions/
      index.tsx               # 游离会话列表（活跃）
      archived.tsx            # 已归档会话列表
      $sessionId.tsx          # 游离会话详情
    settings/
      index.tsx               # 设置页（含语言切换器）
    admin/
      index.tsx               # 管理员面板（用户管理 + 全局设置）
  components/
    chapter/
      ChapterCard.tsx         # Chapter 卡片
      ChapterForkModal.tsx    # 分叉对话框
      ChapterMergeModal.tsx   # 合并对话框
      ChapterCleanupModal.tsx # 批量清理对话框
      ChapterBatchMergeModal.tsx # 批量合并对话框
    narrator/
      NarratorPanel.tsx       # Narrator 面板（消息列表 + 输入 + 图片上传 + 缓冲消息）
      MessageBubble.tsx       # 消息气泡
      MarkdownContent.tsx     # Markdown 渲染（react-markdown + remark-gfm）
      ToolCallCard.tsx        # Tool Call 展示卡片
      CodeBlockWithActions.tsx # 代码块（复制/全屏/自动换行/横屏模式）
      DiffView.tsx            # Diff 查看器（行级 + 词级高亮）
      PermissionBanner.tsx    # 权限审批横幅（支持内联 per-tool-call 审批 + feedbackText）
      AskUserQuestionBanner.tsx # AskUserQuestion 工具调用的问答 UI
    graph/
      StoryNetwork.tsx        # React Flow 故事网络
      ChapterNode.tsx         # 自定义节点（Mantine Card）
      ForkEdge.tsx            # 分叉边
      MergeEdge.tsx           # 合并边
    terminal/
      TerminalPanel.tsx       # 终端面板
      TerminalTabs.tsx        # 终端标签页
    container/
      ContainerStatus.tsx     # 容器状态指示器
      ContainerLogs.tsx       # 容器日志查看器
    LanguageSwitcher.tsx      # 语言切换器（Mantine Select，位于设置页）
    ThemeSwitcher.tsx         # 主题切换器（light/dark/auto）
  hooks/
    useProjects.ts            # Project CRUD hooks
    useChapters.ts            # Chapter CRUD hooks
    useNarrator.ts            # Narrator 消息 + CRUD（含游离会话）
    useNarratorWS.ts          # Narrator WebSocket 连接
    useTerminals.ts           # Terminal CRUD hooks
    useTerminalWS.ts          # Terminal WebSocket 连接
    useStoryGraph.ts          # 故事网络数据 + 布局
    useContainers.ts          # 容器管理 hooks
    usePermissions.ts         # 权限审批 hooks
    useAuth.ts                # 认证 hooks（login/register/logout/status）
    useSearch.ts              # 搜索 hook（300ms 防抖）
    useUserPreferences.ts     # 用户偏好设置 hooks
    useFavoriteDirectories.ts # 收藏目录 hooks
  lib/
    api.ts                    # API 客户端（含 auth token 管理）
    i18n.ts                   # i18next 初始化（语言检测 + locale 导入）
    constants.ts              # 常量（状态颜色映射等）
  locales/
    en/                       # 英文翻译（12 个命名空间 JSON）
    zh-CN/                    # 简体中文翻译（12 个命名空间 JSON）
```
### 6.2 故事网络可视化

使用 React Flow (`@xyflow/react`) + Dagre (`@dagrejs/dagre`) 实现。

组件结构：
- `StoryNetwork` — 主容器，使用 `useStoryGraph(projectId)` 获取图数据，Dagre 自动布局（`rankdir: 'TB'`，节点间距 80/120）
- `ChapterNode` — 自定义 React Flow 节点，使用 Mantine Card 渲染，显示标题、状态 Badge、narrator 数量、容器标记
- `ForkEdge` — 分叉边（贝塞尔曲线样式，蓝色 `#4c6ef5`）
- `MergeEdge` — 合并边（smoothstep 样式，绿色 `#40c057`，`strokeDasharray` + CSS class 动画）

关键设计：
- React Flow 与 Mantine 无样式冲突（React Flow 使用独立 CSS 命名空间）
- 节点尺寸固定 280×120，Dagre 布局后居中偏移
- Chapter 状态颜色映射：active=green, dormant=yellow, merged=blue, abandoned=gray
- Narrator 状态颜色映射：idle=blue, thinking=yellow, waiting=orange, archived=gray, error=red
- 默认主题为 `auto`（跟随系统），用户可通过 `ThemeSwitcher` 切换 light/dark/auto
- 支持 PWA（Service Worker 注册，离线缓存 + 自动更新提示）

### 6.3 Narrator 消息面板

组件结构：
- `NarratorPanel` — 消息列表 + 输入框 + 图片上传，通过 WebSocket 接收实时消息流。支持消息缓冲（narrator thinking 时排队下一条消息）、模型/权限模式切换、归档/取消归档
- `MessageBubble` — 消息气泡，解析 `contentJson` 中的 text/tool_use/thinking blocks
- `ToolCallCard` — Tool Call 展示卡片，可折叠显示 input/output JSON，状态 Badge（pending/approved/denied/running/completed/failed）+ 耗时。支持 TodoWrite 工具的 todo 列表渲染
- `CodeBlockWithActions` — 代码块增强组件，支持复制、全屏查看、自动换行切换、移动端横屏模式。桌面端 hover 显示操作栏，移动端始终显示
- `DiffView` — Diff 查看器，行级对比 + 词级高亮（added/removed），最多显示 500 行，带行号 gutter

关键设计：
- `contentJson` 存储完整的 `BetaMessage.content` 数组，前端按 block 类型分别渲染
- Tool Call 卡片默认折叠，点击展开参数和结果
- 消息历史支持游标分页（cursor-based）和围绕定位（around），用于子 agent 消息懒加载
- 图片上传支持最多 10 张，通过 multipart/form-data 发送

### 6.4 权限审批 UI

组件结构：
- `PermissionBanner` — 内联权限审批组件，嵌入在对应 ToolCallCard 内（per-tool-call 审批），使用 `usePermissions(narratorId)` hook
- `AskUserQuestionBanner` — 处理 Narrator 的 `AskUserQuestion` 工具调用，显示问题选项供用户回答
- 显示 tool name + input JSON（截断到 300 字符）+ decisionReason
- 三个操作：Allow / Allow with feedback（附带 textarea）/ Deny

关键设计：
- 一次只处理一个 pending 请求（队列式）
- WebSocket 双向通信：服务端推送请求，客户端发送决定（支持 `answers` 字段用于 AskUserQuestion 回答，`feedbackText` 字段用于 "allow with feedback"）
- "Allow with feedback" 流程：用户批准权限的同时附带反馈文本，session 在当前 tool 完成后中断，feedbackText 作为下一条用户消息自动发送
- 多标签页同步：`permission_resolved` 消息确保其他标签页及时更新审批状态

---

## 7. 事件系统

### 7.1 事件类型

```typescript
type NarraForkEvent =
  // Chapter 生命周期
  | { type: 'chapter:created'; chapterId: string; projectId: string }
  | { type: 'chapter:forked'; chapterId: string; parentId: string }
  | { type: 'chapter:merged'; sourceId: string; targetId: string }
  | { type: 'chapter:conflict'; sourceId: string; targetId: string; files: string[] }
  | { type: 'chapter:dormant'; chapterId: string }
  | { type: 'chapter:woken'; chapterId: string }
  | { type: 'chapter:abandoned'; chapterId: string }
  // 批量合并进度
  | { type: 'merge:started'; mergeSessionId: string; targetChapterId: string; sourceChapterIds: string[] }
  | { type: 'merge:step_ok'; mergeSessionId: string; sourceChapterId: string; index: number; total: number; commitSha?: string }
  | { type: 'merge:conflict'; mergeSessionId: string; sourceChapterId: string; index: number; total: number; conflictFiles: string[] }
  | { type: 'merge:ai_resolving'; mergeSessionId: string; sourceChapterId: string }
  | { type: 'merge:completed'; mergeSessionId: string; targetChapterId: string; mergedCount: number }
  | { type: 'merge:cancelled'; mergeSessionId: string; reason: string }
  | { type: 'merge:error'; mergeSessionId: string; sourceChapterId: string; error: string }
  // Narrator
  | { type: 'narrator:message'; narratorId: string; role: string }
  | { type: 'narrator:status_changed'; narratorId: string; status: string }
  | { type: 'narrator:title_updated'; narratorId: string; title: string }
  | { type: 'narrator:error'; narratorId: string; error: string }
  | { type: 'narrator:permission_request'; narratorId: string; requestId: string }
  // 容器
  | { type: 'container:started'; chapterId: string }
  | { type: 'container:stopped'; chapterId: string }
  | { type: 'container:error'; chapterId: string; error: string }
```

### 7.2 事件分发

使用 Node.js `EventEmitter` 封装 `NarraForkEventBus` 单例。

职责：
- 接收所有服务层发出的事件
- 广播到所有 WebSocket 客户端
- 写入 JSONL 日志（可选持久化）

事件消费者可通过 `eventBus.on(eventType, handler)` 订阅特定事件类型。

---

## 8. 配置管理

### 8.1 配置文件结构

```
~/.narrafork/
  settings.json          # 主配置
  narrafork.db           # SQLite 数据库
  server.log             # 生产日志
```

### 8.2 settings.json Schema

```typescript
interface NarraForkSettings {
  server: {
    port: number                    // 默认 7778
  }
  paths: {
    defaultProjectDir: string       // 默认 ~/projects
  }
  agent: {
    defaultModel: string            // 默认 'sonnet'
    defaultPermissionMode: PermissionMode
    summaryModel: string            // 压缩上下文用的模型，默认 'haiku'
    customModels: ModelOption[]     // 自定义模型选项列表，默认 []
    // ModelOption = { value: string; label: string }
  }
  chapters: {
    maxActiveWorktrees: number      // 默认 10
    maxActiveContainers: number     // 默认 5
    worktreeSizeWarningMb: number   // 默认 500
    autoSaveOnDormant: boolean      // 默认 true
    dormantAfterMinutes: number     // 不活跃多久后自动休眠，0=禁用
  }
  containers: {
    portRangeStart: number          // 默认 10000
    portRangeEnd: number            // 默认 20000
  }
  auth: {
    jwtSecret: string               // 自动生成的随机密钥
    registrationOpen: boolean       // 默认 true，admin 可关闭
  }
  editor: {
    type: 'vscode' | 'cursor' | 'windsurf' | 'zed'
  }
}
```

---

## 9. 开发计划

### Phase 1: 基础骨架 ✅
- 项目初始化（Bun + Hono + Vite + Mantine）
- 数据库 schema + 迁移
- Project / Repository CRUD
- 基础 Chapter 创建（git worktree）
- 终端管理（dtach + xterm.js）

### Phase 2: Narrator 核心 ✅
- Claude Agent SDK 集成
- Session 创建 / 恢复 / 消息流
- 消息持久化 + 展示
- Tool Call 参数和结果展示
- 权限审批 WebSocket 通道

### Phase 3: 分叉与合并 ✅
- Chapter 分叉（原子操作 + 回滚）
- 上下文继承（full / compressed / fresh）
- 合并冲突检测 + AI 辅助解决
- 批量合并编排（队列式 + 冲突等待）

### Phase 4: 容器与资源 ✅
- Podman 容器生命周期
- 端口自动分配（并发安全）
- 不活跃 chapter 自动休眠（防抖调度，chapter 创建/访问时触发）
- 批量清理
- JWT 认证 + 用户管理 + admin 面板

### Phase 5: 可视化与体验 ✅
- React Flow 故事网络
- 游离会话（standalone sessions，narrator.chapterId = null）
- 会话回溯分叉 UI（ChapterForkModal + forkAtMessageUuid）
- MCP 工具暴露给 Agent（8 个工具）
- 全文搜索（FTS5 + 同步触发器）
- 容器状态 / 日志前端组件

---

## 10. 关键设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 会话分叉机制 | SDK 原生 resume + forkSession + 本地对话分支 | SDK 级别零成本继承，本地 conversation_branches 管理分支消息视图 |
| 回溯分叉 | SDK 的 resumeSessionAt + conversation_branches fork | SDK 精确到消息级别回溯，本地分支复制共享前缀 |
| 上下文压缩 | Haiku 模型做 summarization | 成本低，速度快 |
| 容器运行时 | Podman | 无 daemon，rootless，兼容 Docker Compose 格式 |
| 前端组件库 | Mantine | 开箱即用的复杂组件，CSS-in-JS 主题系统 |
| 图可视化 | React Flow + Dagre | 成熟的 React 图渲染库，自动布局 |
| 消息存储 | 完整 BetaMessage.content JSON + branch_messages junction table | 保留 tool_use/thinking blocks 用于展示，分支间共享消息实体 |
| 端口管理 | DB 端口池 + insert 冲突重试 | 避免冲突，支持多 chapter 并发分配 |
| 分叉原子性 | 手动回滚栈 | 比 DB 事务更灵活，覆盖 git/container 操作 |
| 权限审批 | WebSocket 实时通道 | Agent 在等待，需要低延迟响应 |
| 认证方案 | JWT Bearer token | 无状态，首个注册用户自动成为 admin |
| 容器路由归属 | 整合到 chapters.ts | 容器是 chapter 的子资源，不需要独立路由文件 |
| 权限审批服务 | 整合到 narrator-session.ts + narrator_tool_calls 表 | 与 session 生命周期紧密耦合，权限状态直接记录在 tool call 上，无独立 permission_requests 表 |
| 批量合并 | 临时 fork + 队列式处理 | 在临时分支上合并，全部成功后 fast-forward，失败可回滚 |
| containerConfig 存储 | chapters 表 JSON 字段 | 避免独立表的 JOIN 开销，配置结构简单 |
| 数据共享模式 | 全团队共享，无用户隔离 | 小团队私有部署，认证仅用于身份识别 |
| Narrator 状态机 | idle/thinking/waiting/done/archived/error/interrupted | 比 active/paused/completed 更细粒度，`done` 表示 AI 完成回复待用户阅读，`interrupted` 表示用户主动中断 |
| 会话标题生成 | 两阶段：quickTitle（用户消息即时生成）+ generateAndSetTitle（session 结束后精确生成） | 快速标题改善 UX，精确标题保证质量 |
| 游离会话路由 | 整合到 narrators.ts（chapterId=null） | 避免重复路由逻辑，统一会话管理 |
| 权限审批 UI | 内联 per-tool-call 审批 + feedbackText | 比顶部 banner 更直观，feedback 支持 "allow with guidance" 模式 |
| 消息缓冲 | 内存 Map + WebSocket 双向同步 | 允许用户在 AI thinking 时排队消息，多设备同步 |
| 对话分支 | conversation_branches + branch_messages junction table | 支持从任意消息 fork 新分支，共享前缀避免消息重复，seq 字段支持高效游标分页 |
| Compact 机制 | system 消息标记 + branch_messages.isCompact | 压缩历史上下文为摘要注入 system prompt，减少 token 消耗，支持部分压缩（指定 beforeMessageId） |
| FTS tokenizer | trigram | 支持 CJK 搜索，无需分词器 |
| 主题模式 | auto（跟随系统） | 用户可切换 light/dark/auto，比固定 dark 更灵活 |
| 自动休眠触发 | 防抖调度（30 秒窗口） | chapter 创建/访问时触发，避免频繁检查 |
