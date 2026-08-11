# NarraFork — 项目起始开发文档

## 1. 项目概述

NarraFork 是一个以"叙事分叉"为核心隐喻的 AI 编程协作平台。它将软件开发过程视为一个不断分叉和汇聚的故事网络，每个工作分支（Chapter）都有自己的 AI 叙述者（Narrator），能够在隔离的 git worktree 和可选的容器环境中独立工作，同时保持上下文的连贯性和可追溯性。

### 1.1 核心理念

- **Chapter（章节）**：工作的基本单元，对应一个 git worktree + 一个或多个 AI 会话
- **Narrator（叙述者）**：绑定到 Chapter 的 AI 会话，拥有完整的上下文记忆
- **Story Network（故事网络）**：所有 Chapter 的分叉/合并关系构成的有向图

### 1.2 与 Fulcrum 的关系

NarraFork 借鉴 Fulcrum 的以下架构模式：
- Bun + Hono 后端框架
- SQLite + Drizzle ORM 数据层
- Git worktree 隔离工作区
- WebSocket 实时通信

差异点：
- 前端使用 React + Mantine（非 shadcn + Tailwind）
- 容器化使用 Podman（非 Docker Swarm）
- 核心抽象是 Chapter/Narrator（非 Task/Terminal）
- 会话管理是一等公民，支持分叉、回溯、继承

### 1.3 部署模式

NarraFork 面向小团队私有部署。所有用户共享项目和 Chapter 数据，无用户级数据隔离。认证系统用于身份识别和管理权限，而非数据权限分割。

### 1.4 扩展能力文档

以下为本起始文档之外、独立演进的通用平台能力设计（均为领域无关的平台能力，不绑定具体业务）：

- `docs/KNOWLEDGE_BASE.md` — 知识库：结构化、可检索、可引用、可版本化、可授权的知识资源（DB 表 + FTS5 + 写时复制版本 + ACL + 关键词注入），与现有 skills 互补。
- `docs/OPEN_API.md` — 开放 API：API Token 鉴权 + 程序化叙述者（带 `origin`/自定义 `metadata`）+ 知识库读写，供 NarraFork 之外的程序驱动。

> 这两项能力适用于广泛场景；其首批消费方之一是机器人远程诊断系统（见 `robot_assistant_next/docs/remote_diagnosis/`），但设计本身不含任何业务语义。

---

## 2. 技术栈

### 2.1 后端
| 技术 | 用途 | 版本要求 |
|------|------|----------|
| Bun | 运行时 | >= 1.2 |
| Hono | HTTP 框架 | >= 4.x |
| SQLite | 数据库 | 内置于 Bun |
| Drizzle ORM | 数据库抽象 | >= 0.38 |
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
| drizzle-kit | 数据库迁移 |
| Vite | 前端构建 |
| Biome | Lint + Format |

### 2.4 外部依赖
| 依赖 | 用途 | 必需 |
|------|------|------|
| git | 版本控制、worktree | 是 |
| podman | 容器环境 | 否（可选功能） |
| dtach | 终端持久化 | 否（可选功能） |

---

## 3. 数据库 Schema

### 3.1 核心实体关系图

```
projects ──1:N──> chapters
projects ──1:N──> chapter_edges
projects ──1:N──> exploration_groups
chapters ──1:N──> narrators (chapterId nullable: null = 游离会话)
chapters ──self── chapters (parentChapterId)
chapters ──N:1──> exploration_groups (explorationGroupId, nullable)
chapters ──1:N──> container_instances
chapters ──1:N──> port_allocations
chapters ──1:N──> terminals
chapters ──1:N──> chapter_commits
chapter_edges ──N:1──> chapters (sourceId)
chapter_edges ──N:1──> chapters (targetId)
exploration_groups ──N:1──> chapters (baseChapterId)
exploration_groups ──N:1──> chapters (decidedChapterId, nullable)
narrators ──1:N──> narrator_message_refs
narrators ──1:N──> narrator_tool_calls
narrators ──1:N──> narrator_whitelist_dirs
narrators ──1:N──> narrator_patches
narrator_messages ──1:N──> narrator_message_refs
narrator_messages ──1:N──> narrator_tool_calls
users ──1:1── user_preferences
users ──1:N── user_favorite_directories
```

> 注：`containerConfig` 以 JSON 字段存储在 `chapters` 表中，而非独立的 `container_configs` 表。
> `users` 表用于 JWT 认证，与上述业务实体无直接关联。
> 一个项目有且只有一个 Git 仓库，仓库信息直接存储在 `projects` 表中。
> 权限审批直接在 `narrator_tool_calls` 表中处理（`permissionDecidedBy`/`permissionDecidedAt` 等字段），无独立的 `permission_requests` 表。
> `chapter_edges` 显式建模章节间的所有关系（实际在用：fork/merge/review），`parentChapterId` 和 `mergedIntoChapterId` 作为冗余快捷字段保留。

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
  gitPath: text('git_path'),                       // 本地绝对路径（一个项目一个仓库）
  remoteUrl: text('remote_url'),                   // git remote URL
  defaultBranch: text('default_branch').default('main'),
  startupScript: text('startup_script'),           // chapter 创建后执行的脚本
  copyFiles: text('copy_files'),                   // JSON 数组，如 ["*.env", ".vscode/"]
  proxyDomain: text('proxy_domain'),               // 代理域名
  chapterSettings: text('chapter_settings', { mode: 'json' }),  // 章节级默认配置 JSON
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

  // 状态机：active → merged/abandoned/frozen, dormant 是中间态
  status: text('status', {
    enum: ['active', 'dormant', 'merged', 'abandoned', 'frozen']
  }).notNull().default('active'),

  // 角色（视觉和语义标签，不限制操作能力）
  role: text('role', {
    enum: ['trunk', 'branch', 'exploration']
  }).notNull().default('branch'),

  // Git 信息
  branch: text('branch').notNull(),                  // git branch 名
  worktreePath: text('worktree_path'),               // 章节根目录，dormant/frozen 时为 null
  baseBranch: text('base_branch').notNull(),          // 基于哪个 branch 创建
  isRoot: integer('is_root').default(0),              // 是否为根章节
  headCommitSha: text('head_commit_sha'),            // 当前 HEAD commit SHA
  startCommitSha: text('start_commit_sha'),          // 起始 commit SHA
  commitCount: integer('commit_count').default(0),   // commit 数量

  // 分叉关系（冗余快捷字段，同时在 chapter_edges 中维护）
  parentChapterId: text('parent_chapter_id')
    .references(() => chapters.id),
  forkPoint: text('fork_point', { mode: 'json' }), // { commitSha, narratorMessageUuid }

  // 合并信息（冗余快捷字段，同时在 chapter_edges 中维护）
  mergedIntoChapterId: text('merged_into_chapter_id')
    .references(() => chapters.id),
  mergeCommitSha: text('merge_commit_sha'),
  mergeStrategy: text('merge_strategy', {
    enum: ['merge', 'squash', 'cherry-pick']
  }),

  // 探索组
  explorationGroupId: text('exploration_group_id')
    .references(() => explorationGroups.id),

  // 容器配置（JSON 字段，非独立表）
  containerConfig: text('container_config', { mode: 'json' }),

  // 图可视化
  color: text('color'),                              // 用户自定义颜色（图上显示）
  groupLabel: text('group_label'),                   // 分组标签（如 "auth模块"、"v2.0"）
  pinned: integer('pinned').default(0),              // 遗留列：章节代码从不读写它，勿据此写逻辑
  anchorCommitSha: text('anchor_commit_sha'),        // 位置锚点 commit（ruler 模式沿轴定位用）
  axisOffset: real('axis_offset').default(0),        // 沿主轴偏移（classic 模式映射为 x）
  crossOffset: real('cross_offset').default(0),      // 垂直于主轴偏移（classic 模式映射为 y）
  panelExpanded: integer('panel_expanded').default(0),  // 节点内嵌面板是否展开
  panelWidth: real('panel_width'),                   // 侧边面板宽度
  panelHeight: real('panel_height'),                 // 侧边面板高度

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

**章节角色（role）语义：**
- `trunk`：主线章节。代表一条持续演进的开发线（类似 main、develop、release 分支），接收其他章节的合并。可以有多个 trunk（多层主线）。trunk 不会被自动休眠。
- `branch`：工作分支（默认）。从某个章节 fork 出来，完成后合并回去。
- `exploration`：探索分支。用于技术方案探索，通常属于某个 `exploration_group`，最终选择性地 cherry-pick 或合并。

role 只是视觉和语义标签，不影响 fork/merge 的技术能力。任何 role 的章节都可以 fork、被 fork、merge、被 merge。用户可以随时改变章节的 role。

**章节状态机：**
```
创建 → active
active → dormant（休眠，worktree 删除但分支保留）
active → merged（合并到目标章节）
active → abandoned（清理，worktree 和分支删除）
active → frozen（拆分后的前序章节，代码和对话只读）
dormant → active（唤醒，worktree 重建）
dormant → abandoned（清理）
frozen → abandoned（清理）
```

`frozen` 状态用于章节拆分（split at commit）操作产生的前序章节。frozen 章节的代码和对话历史只读，但可以被 fork。当 role 为 trunk 时，拆分后前序章节保持 active 而非 frozen（主线持续演进的语义）。

#### chapter_edges — 章节间关系（显式边表）

```typescript
export const chapterEdges = sqliteTable('chapter_edges', {
  id: text('id').primaryKey(),                       // nanoid
  projectId: text('project_id').notNull()
    .references(() => projects.id),
  sourceId: text('source_id').notNull()
    .references(() => chapters.id),
  targetId: text('target_id').notNull()
    .references(() => chapters.id),
  type: text('type', {
    // dependency 已移除、cherry_pick 从未实现：枚举值保留但无写入路径
    enum: ['fork', 'merge', 'dependency', 'cherry_pick', 'review']
  }).notNull(),
  metadata: text('metadata', { mode: 'json' }),      // 类型特定的元数据
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_chapter_edges_unique').on(table.sourceId, table.targetId, table.type),
  index('idx_chapter_edges_project').on(table.projectId),
  index('idx_chapter_edges_source').on(table.sourceId),
  index('idx_chapter_edges_target').on(table.targetId),
])
```

**边类型与 metadata 结构：**
- `fork`：sourceId fork 出 targetId。metadata: `{ commitSha: string, inheritMode: 'full' | 'compressed' | 'fresh', narratorMessageUuid?: string }`
- `merge`：sourceId 合并到 targetId。metadata: `{ mergeCommitSha: string, strategy: 'merge' | 'squash' | 'cherry-pick' }`
- `review`：sourceId 的评审章节是 targetId。由 `review-service` 创建
- ~~`dependency`~~：**已移除**（见 6c）。枚举值保留以便历史行加载，无写入路径
- ~~`cherry_pick`~~：**从未实现**（见 6e）。枚举值和 `CherryPickEdge` 组件都在，但没有任何代码创建这种边

> 所有边都由创建它的操作自动维护：fork 边来自 chapter-fork/chapter-split，merge 边来自
> chapter-merge（并与 `parentChapterId`/`mergedIntoChapterId` 冗余字段同步），review 边来自
> review-service。**没有用户手动创建的边** —— 因此 `/api/chapter-edges` 是只读的。

#### exploration_groups — 探索组

```typescript
export const explorationGroups = sqliteTable('exploration_groups', {
  id: text('id').primaryKey(),                       // nanoid
  projectId: text('project_id').notNull()
    .references(() => projects.id),
  title: text('title').notNull(),                    // 如 "数据库选型：SQLite vs PostgreSQL vs TiKV"
  description: text('description'),
  baseChapterId: text('base_chapter_id')
    .references(() => chapters.id),                  // 探索的基准章节
  status: text('status', {
    enum: ['active', 'decided', 'abandoned']
  }).notNull().default('active'),
  decidedChapterId: text('decided_chapter_id')
    .references(() => chapters.id),                  // 最终选定的章节（decided 时）
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
```

> 探索组原设计：将多个 exploration 角色的章节组织为一个"实验组"，在图上渲染为可折叠的分组框（React Flow Group Node），生命周期为 active → decided（选定方案）/ abandoned（放弃探索）。
>
> **⚠️ 未实现。** 表和 `chapters.explorationGroupId` 外键存在，`createExplorationGroupSchema`/
> `updateExplorationGroupSchema` 也在，但没有 `exploration-group-service.ts`、没有
> `/api/exploration-groups` 路由、图上也没有分组框组件。下文 4.2.8e 与 API 清单里的探索组
> 条目都是设计意图而非现状。

```typescript
export const narrators = sqliteTable('narrators', {
  id: text('id').primaryKey(),
  chapterId: text('chapter_id')              // null = 游离会话（standalone session）
    .references(() => chapters.id),

  // 类型：primary（主叙述者）或 subagent（子代理）
  type: text('type', {
    enum: ['primary', 'subagent']
  }).notNull().default('primary'),
  subagentType: text('subagent_type', {      // 子代理类型
    enum: ['explore', 'plan', 'general']
  }),

  // 上下文继承配置
  inheritMode: text('inherit_mode', {
    enum: ['full', 'compressed', 'fresh']
  }).notNull().default('fresh'),
  parentNarratorId: text('parent_narrator_id')
    .references(() => narrators.id),
  forkMessageId: text('fork_message_id'),    // fork 起点消息 ID
  contextSummary: text('context_summary'),         // compressed 模式或 compact 摘要

  // 会话标题（自动生成或手动设置）
  title: text('title'),

  // 会话配置
  model: text('model').default('claude-sonnet'),
  systemPrompt: text('system_prompt'),             // 额外的 system prompt
  permissionMode: text('permission_mode', {
    enum: ['default', 'acceptEdits', 'bypassPermissions', 'readOnly', 'dontAsk']
  }).default('default'),
  previousPermissionMode: text('previous_permission_mode'),  // 旧版 plan 迁移/UI 上下文
  planFileId: text('plan_file_id'),          // plan trait 激活时的 .narrafork/plan-{id}.md
  reasoningEffort: text('reasoning_effort', {      // 推理努力级别
    enum: ['low', 'medium', 'high', 'xhigh']
  }),
  fastMode: integer('fast_mode', { mode: 'boolean' }).notNull().default(false),
  relaxedPlan: integer('relaxed_plan', { mode: 'boolean' }).notNull().default(false),
  planMode: integer('plan_mode', { mode: 'boolean' }).notNull().default(false),

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

  // 上下文修剪
  pruneBoundaryMessageId: text('prune_boundary_message_id'),
  prunedPercent: integer('pruned_percent'),
  pruneEnabled: integer('prune_enabled', { mode: 'boolean' }).notNull().default(true),

  // 后台任务
  isBackground: integer('is_background', { mode: 'boolean' }).notNull().default(false),
  backgroundStatus: text('background_status', {
    enum: ['running', 'completed', 'failed', 'cancelled']
  }),
  backgroundResult: text('background_result'),
  backgroundCompletedAt: text('background_completed_at'),

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
  // SDK 消息 UUID，用于回溯分叉
  messageUuid: text('sdk_message_uuid'),
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

  // Git commit 关联
  commitSha: text('commit_sha'),
  commandText: text('command_text'),

  // 创建者
  createdBy: text('created_by').references(() => users.id),

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

  // 后台任务标记
  isBackground: integer('is_background', { mode: 'boolean' }).notNull().default(false),

  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_toolcalls_message').on(table.messageId),
  index('idx_toolcalls_status').on(table.narratorId, table.status),
])
```

#### narrator_message_refs — 叙述者-消息关联表（替代 conversation_branches + branch_messages）

消息与叙述者的多对多关系。同一条消息可属于多个叙述者（fork 时共享前缀）。`seq` 字段维护叙述者内的消息顺序，`isCompact` 标记压缩点位置。

```typescript
export const narratorMessageRefs = sqliteTable('narrator_message_refs', {
  id: text('id').primaryKey(),
  narratorId: text('narrator_id').notNull()
    .references(() => narrators.id),
  messageId: text('message_id').notNull()
    .references(() => narratorMessages.id),
  seq: integer('seq').notNull(),
  isCompact: integer('is_compact').notNull().default(0),
  prunedPercent: integer('pruned_percent'),
}, (table) => [
  uniqueIndex('idx_narrator_message_refs_unique').on(table.narratorId, table.messageId),
  index('idx_narrator_message_refs_seq').on(table.narratorId, table.seq),
  index('idx_narrator_message_refs_message').on(table.messageId),
])
```

#### terminals — 终端实例

```typescript
export const terminals = sqliteTable('terminals', {
  id: text('id').primaryKey(),
  chapterId: text('chapter_id')
    .references(() => chapters.id),
  narratorId: text('narrator_id')
    .references(() => narrators.id),
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
  proxyLabel: text('proxy_label'),                 // 代理标签
  containerIp: text('container_ip'),               // 容器 IP 地址
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
  avatarColor: text('avatar_color'),               // 头像颜色
  avatarImageId: text('avatar_image_id'),           // 头像图片 ID
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
  replyInUserLanguage: integer('reply_in_user_language', { mode: 'boolean' }).notNull().default(true),
  showTokenUsage: integer('show_token_usage', { mode: 'boolean' }).notNull().default(true),
  showOutputStats: integer('show_output_stats', { mode: 'boolean' }).notNull().default(false),
  terminalTheme: text('terminal_theme').default('dark'),
  terminalFontSize: integer('terminal_font_size').default(14),
  recentTabs: text('recent_tabs', { mode: 'json' }),  // 最近访问的标签页
  notifyOnDone: integer('notify_on_done', { mode: 'boolean' }).notNull().default(true),
  notifyOnWaiting: integer('notify_on_waiting', { mode: 'boolean' }).notNull().default(true),
  notifyPwaEnabled: integer('notify_pwa_enabled', { mode: 'boolean' }).notNull().default(false),
  notifySoundEnabled: integer('notify_sound_enabled', { mode: 'boolean' }).notNull().default(true),
  notifySoundType: text('notify_sound_type').default('builtin'),
  notifySoundBuiltin: text('notify_sound_builtin').default('default'),
  notifySoundFileId: text('notify_sound_file_id'),
  notifyDingtalkEnabled: integer('notify_dingtalk_enabled', { mode: 'boolean' }).notNull().default(false),
  notifyDingtalkWebhook: text('notify_dingtalk_webhook'),
  notifyDingtalkSecret: text('notify_dingtalk_secret'),
  notifyFeishuEnabled: integer('notify_feishu_enabled', { mode: 'boolean' }).notNull().default(false),
  notifyFeishuWebhook: text('notify_feishu_webhook'),
  notifyFeishuSecret: text('notify_feishu_secret'),
  commands: text('commands', { mode: 'json' }),    // 自定义命令
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

#### chapter_commits — 章节提交记录

```typescript
export const chapterCommits = sqliteTable('chapter_commits', {
  id: text('id').primaryKey(),
  chapterId: text('chapter_id').notNull()
    .references(() => chapters.id),
  sha: text('sha').notNull(),
  message: text('message').notNull(),
  fullMessage: text('full_message'),
  authorName: text('author_name'),
  authorEmail: text('author_email'),
  authoredAt: text('authored_at').notNull(),
  source: text('source', { enum: ['manual', 'auto', 'merge', 'cherry_pick', 'initial'] }),
  narratorId: text('narrator_id').references(() => narrators.id),
  narratorMessageId: text('narrator_message_id').references(() => narratorMessages.id),
  filesChanged: integer('files_changed'),
  linesAdded: integer('lines_added'),
  linesRemoved: integer('lines_removed'),
  createdAt: text('created_at').notNull(),
})
```

#### terminal_tabs — 终端标签

```typescript
export const terminalTabs = sqliteTable('terminal_tabs', {
  id: text('id').primaryKey(),
  chapterId: text('chapter_id').references(() => chapters.id),
  narratorId: text('narrator_id').references(() => narrators.id),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
})
```

#### terminal_view_state — 终端视图状态

```typescript
export const terminalViewState = sqliteTable('terminal_view_state', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  chapterId: text('chapter_id').references(() => chapters.id),
  narratorId: text('narrator_id').references(() => narrators.id),
  layout: text('layout', { enum: ['single', 'split-h', 'split-v', 'triple', 'quad'] }),
  activeTabId: text('active_tab_id'),
  panelAssignments: text('panel_assignments', { mode: 'json' }),
  updatedAt: text('updated_at').notNull(),
})
```

#### narrator_patches — 叙述者补丁记录

```typescript
export const narratorPatches = sqliteTable('narrator_patches', {
  id: text('id').primaryKey(),
  narratorId: text('narrator_id').notNull().references(() => narrators.id),
  messageId: text('message_id').notNull().references(() => narratorMessages.id),
  toolUseId: text('tool_use_id').notNull(),
  beforeHash: text('before_hash').notNull(),
  afterHash: text('after_hash').notNull(),
  filesJson: text('files_json', { mode: 'json' }),
  createdAt: text('created_at').notNull(),
})
```

#### merge_sessions — 合并会话

```typescript
export const mergeSessions = sqliteTable('merge_sessions', {
  id: text('id').primaryKey(),
  targetChapterId: text('target_chapter_id').notNull().references(() => chapters.id),
  sourceChapterIds: text('source_chapter_ids', { mode: 'json' }),
  strategy: text('strategy', { enum: ['merge', 'squash', 'cherry-pick'] }),
  status: text('status', { enum: ['running', 'waiting_decision', 'ai_resolving', 'completed', 'cancelled', 'error'] }),
  currentIndex: integer('current_index').notNull().default(0),
  mergedCount: integer('merged_count').notNull().default(0),
  currentSourceChapterId: text('current_source_chapter_id'),
  conflictFiles: text('conflict_files', { mode: 'json' }),
  error: text('error'),
  locale: text('locale'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
```

#### narrator_whitelist_dirs — 叙述者白名单目录

```typescript
export const narratorWhitelistDirs = sqliteTable('narrator_whitelist_dirs', {
  id: text('id').primaryKey(),
  narratorId: text('narrator_id').notNull().references(() => narrators.id),
  path: text('path').notNull(),
  accessLevel: text('access_level', { enum: ['readOnly', 'readWrite', 'full'] }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
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
    connection.ts             # 数据库连接管理
    fts.ts                    # FTS5 全文搜索设置
    migrate.ts                # 迁移脚本
  routes/
    projects.ts               # 项目 CRUD
    chapters.ts               # 章节 CRUD + 分叉/合并 + 容器管理
    chapter-edges.ts          # 章节间关系（边）CRUD
    exploration-groups.ts     # ❌ 不存在（探索组未实现）
    narrators.ts              # 叙述者管理 + 消息流 + 权限审批 + 游离会话
    terminals.ts              # 终端管理
    auth.ts                   # 注册 / 登录 / 当前用户
    admin.ts                  # 用户管理 + 全局设置
    settings.ts               # 全局配置管理
    user-preferences.ts       # 用户偏好设置
    favorites.ts              # 用户收藏目录 CRUD
    uploads.ts                # 图片上传文件服务
    graph.ts                  # 故事网络图数据 + 节点位置持久化
    search.ts                 # 全文搜索
    mcp.ts                    # MCP 工具暴露
    git.ts                    # Git 操作
    dependencies.ts           # 系统依赖检查
    skills.ts                 # 技能管理
    routines.ts               # 例程管理
    notifications.ts          # 通知管理
    notification-sounds.ts    # 通知声音
    fs.ts                     # 文件系统操作
    project-db.ts             # 项目数据库备份/导入
    anthropic.ts              # Anthropic API 配置
    openai.ts                 # OpenAI API 配置
    codex.ts                  # Codex API 配置
  services/
    chapter-service.ts        # 章节生命周期
    chapter-fork.ts           # 分叉逻辑（原子操作 + 回滚）+ 章节拆分 + 批量分叉
    chapter-merge.ts          # 合并逻辑（冲突检测 + AI 辅助解决）
    chapter-batch-merge.ts    # 批量合并编排（队列式处理 + 冲突等待）
    chapter-cleanup.ts        # 批量清理 + 自动休眠/唤醒
    chapter-edge-service.ts   # 章节间关系（边）CRUD
    chapter-dependency-service.ts  # 依赖关系管理（上游变更检测 + 同步）（计划中）
    chapter-cherry-pick-service.ts # ❌ 不存在（章节级 cherry-pick 未实现；合并策略走 git-service.cherryPick）
    exploration-group-service.ts   # ❌ 不存在（探索组未实现）
    narrator-service.ts       # 叙述者生命周期
    narrator-session.ts       # AI 会话管理 + 权限审批
    narrator-executor.ts      # 自定义 Agent Loop 执行器
    narrator-event-handler.ts # 叙述者事件处理
    narrator-subagent.ts      # 子代理管理
    narrator-recovery.ts      # 会话恢复
    narrator-auto-commit.ts   # 自动提交
    narrator-prompt.ts        # 系统提示词构建
    narrator-context.ts       # 上下文继承（full/compressed/fresh）
    narrator-title.ts         # 会话标题自动生成（Haiku 模型）
    container-service.ts      # 容器管理（Docker/Podman compose）
    container-proxy.ts        # 容器代理
    port-allocator.ts         # 端口分配
    git-service.ts            # Git 操作封装
    terminal-service.ts       # 终端 + PTY 管理
    terminal-tab-service.ts   # 终端标签管理
    terminal-view-service.ts  # 终端视图状态
    search-service.ts         # 全文搜索（FTS5 + LIKE 降级）
    command-service.ts        # 命令解析和执行
    output-stats.ts           # 输出统计
    merge-summary-service.ts  # 合并摘要
    commit-sync-service.ts    # 提交同步
    worktree-watcher.ts       # Worktree 监视
    project-db-sync.ts        # 项目数据库同步
    project-import.ts         # 项目导入
    snapshot.ts               # 快照管理
    routine-service.ts        # 例程管理
    skill-service.ts          # 技能管理
    notification-service.ts   # 通知管理
    dependency-service.ts     # 系统依赖检查
  middleware/
    auth.ts                   # JWT 认证 + 管理员权限中间件
  websocket/
    ws-handler.ts             # WebSocket 消息路由（统一入口）
    terminal-ws.ts            # 终端 I/O
    narrator-ws.ts            # 叙述者实时事件（消息流、权限请求、合并进度）
  terminal/                   # 终端运行时（PTY 抽象层、buffer 管理、dtach 支持）
  lib/
    settings/                 # 配置管理（加载/保存 ~/.narrafork/settings.json）
    auth.ts                   # JWT 签发/验证 + 用户注册/登录
    event-bus.ts              # 类型化事件总线
    validators.ts             # Zod 请求验证器
    logger.ts                 # JSONL 日志
    errors.ts                 # 错误类型（AppError / NotFoundError / ValidationError）
    id.ts                     # nanoid 生成器
    agent/                    # 自定义 AI Agent 框架（loop、多提供商、工具注册、15+ 内置工具）
    mcp/                      # MCP 集成（manager、tool-bridge、transports）
```

> 设计偏差说明：
> - 容器路由整合到 `chapters.ts`（容器是 chapter 的子资源），不再有独立的 `containers.ts`
> - 权限审批逻辑整合到 `narrator-session.ts`（与 session 生命周期紧密耦合），不再有独立的 `narrator-permission.ts`
> - 游离会话（standalone sessions）整合到 `narrators.ts`（通过 `chapterId=null` 区分），不再有独立的 `sessions.ts` 路由
### 4.2 核心服务设计

#### 4.2.1 chapter-fork.ts — 分叉服务

职责：从父 Chapter 创建新的分叉 Chapter，包含 git worktree、Narrator 继承、可选容器。从项目的 `gitPath` 获取仓库信息。同时负责章节拆分（split at commit）和批量分叉。

**核心操作流程（6 步原子操作 + 回滚栈）：**
1. 创建 Git branch + worktree（`<project.gitPath>/.worktrees/<slug-shortId>/`）
2. 创建 DB 记录（chapter + forkPoint）+ 创建 fork 边到 `chapter_edges`
3. 复制 repo 配置的 copyFiles
4. Fork Narrator(s)（根据 inheritMode 调用 narrator-context）
5. 复制 containerConfig + 可选启动容器（non-fatal，失败不回滚）
6. 执行 startup script（non-fatal，60 秒超时）

关键设计：
- 使用 `rollback: Array<() => Promise<void>>` 手动回滚栈，每步成功后 push 逆操作
- 失败时逆序执行回滚，覆盖 DB + git + container 跨系统操作
- Branch 命名规则：`chapter/{slug}-{nanoid(6)}`，如 `chapter/add-auth-x7k2m9`
- 支持 `forkAtMessageUuid` 回溯分叉，记录在 `forkPoint.narratorMessageUuid`
- fork 时支持指定 `role` 参数（默认 `'branch'`）

**章节拆分（splitAtCommit）：**

当用户从章节的某个历史 commit 分叉时，系统不是简单地从该 commit 创建新分支，而是将原章节拆分为前后两个，新分叉和原有的后续提交变成前序章节的两个 fork 章节。

`splitAtCommit(chapterId, commitSha, newForkInput)` — 三步原子操作：

1. **创建前序章节（prefix）**
   - 新建章节，git branch HEAD 指向选中的 commit（`git branch prefix-xxx <commitSha>`）
   - 创建 worktree（如果原章节 role 为 trunk 则保持 active，否则设为 frozen）
   - 继承原章节的 `parentChapterId`（原章节的上游关系转移给前序）
   - 叙述者处理：复制原章节的叙述者，但 `narrator_message_refs` 只保留 commit 时间点之前的消息引用（通过 commit 时间戳与消息 `createdAt` 对比确定截断点）
   - 在 `chapter_edges` 中：将原章节的入边（fork 边的 target）重新指向前序章节

2. **原章节变为后续章节（continuation）**
   - 代码、分支、worktree 保持不变
   - `parentChapterId` 改为指向前序章节
   - 叙述者保留完整对话历史
   - 在 `chapter_edges` 中创建 fork 边：prefix → continuation

3. **创建新分叉章节（new fork）**
   - 从前序章节的 HEAD（即选中的 commit）fork 出新分支
   - 叙述者继承模式由用户选择（full/compressed/fresh）
   - 在 `chapter_edges` 中创建 fork 边：prefix → new fork

回滚策略：三步操作共享同一个回滚栈，任一步失败时逆序回滚所有已完成的步骤。

**批量分叉（batchFork）：**

`batchFork(chapterId, forkInputs[])` — 从同一个章节一次创建多个分支。

- 循环调用标准 fork 流程，每个分支独立创建
- 支持为每个分支指定不同的 title、description、role、inheritMode
- 所有分支共享同一个 forkPoint（基于同一个 commit）
- 部分失败不影响已成功的分支（非全有全无），返回 `{ created: Chapter[], failed: { input, error }[] }`

#### 4.2.1b narrator-service.ts — 叙述者生命周期与消息管理

职责：叙述者 CRUD、消息持久化、Compact 机制。

核心功能：
- `create()` — 创建叙述者
- `persistUserMessage()` / `persistAssistantMessage()` — 消息持久化，同时写入 `narrator_messages` 和 `narrator_message_refs`（junction table），维护叙述者内 `seq` 排序
- `getMessagesCursor()` — 基于 `narrator_message_refs.seq` 的游标分页，查询当前叙述者的顶层消息，再递归加载子 agent 消息树（通过 `parentToolUseId` 关联）
- `getMessagesAround()` — 围绕指定消息加载上下文（用于搜索结果定位）
- `getMessagesSinceLastCompact()` — 从最近的 compact 标记之后加载消息（用于历史重建）

Compact 机制：
- `persistCompactingMessage()` — 插入 role=system 的 compact 占位消息（`status: "compacting"`），支持指定 `beforeMessageId` 进行部分压缩
- `finalizeCompactingMessage()` — 将占位消息更新为完成状态（`status: "compacted"`，含 summary），在 `narrator_message_refs` 中标记 `isCompact=1`
- `deleteCompactMessage()` / `updateCompactSummary()` — compact 标记的撤销和编辑

消息树构建：
- `buildMessageTree()` — 将扁平消息列表构建为树结构，子消息通过 `parentToolUseId` 嵌套到父消息的 `children` 数组
- `truncateToolIO()` — 递归截断大型 tool call 的 inputJson/outputJson（默认 2000 字符），完整数据通过 `/tool-calls/:toolUseId` 端点获取

#### 4.2.2 narrator-session.ts — AI 会话管理


核心功能：
- `startSession()` — 统一入口，根据 narrator 状态自动判断新建或恢复会话。传入 `cwd`、`model`、`permissionMode`。每次请求通过 `buildHistory()` 从 DB 消息重建完整对话历史，调用 Agent Loop 执行。
- `interruptSession()` — 中断当前执行
- `recoverOnStartup()` — 服务器重启恢复逻辑：重置 `thinking` 状态的 narrator 为 `idle`，自动拒绝 pending 权限请求，标记 running tool calls 为 failed
- `isSessionActive()` — 检查 narrator 是否有活跃的 Agent Loop session
- `setBufferedMessage()` / `clearBufferedMessage()` / `getBufferedMessage()` — 消息缓冲管理，允许用户在 narrator thinking 时排队下一条消息

关键设计：
- 内存中维护 `Map<narratorId, { query, abortController }>` 用于中断控制
- `startSession()` 是异步生成器，内部处理每条消息：持久化 assistant 消息、更新统计、广播到 WebSocket
- 两阶段标题生成：首条用户消息时立即调用 `generateQuickTitle()` 生成快速标题（不等 AI 回复），session 结束后再调用 `generateAndSetTitle()` 生成更准确的标题（会 await quickTitle 完成以避免竞态）
- 权限与计划模式自动处理：
  - `default` 权限模式：启用 `canUseTool` 回调，走完整审批流程
  - `acceptEdits` 权限模式：自动允许 `Edit`/`Write`/`NotebookEdit` 工具，其余走审批
  - `bypassPermissions` / `dontAsk` 权限模式：跳过/拒绝权限检查
  - plan mode 不再是权限模式，而是 narrator trait overlay；默认限制为只读，仅允许写入指定 `.narrafork/plan-{id}.md`，用户批准 `ExitPlanMode` 后才进入执行阶段
- `canUseTool` 对 `TodoWrite`/`TodoRead` 工具自动允许（白名单），不需要用户审批
- 权限审批流程：创建 tool_call 记录（status: initializing）→ 判断权限决策（auto allow/deny/ask）→ 需要用户审批时更新 status 为 pending → WebSocket 推送 `permission_request` → 等待决定（5 分钟超时，超时自动拒绝，`permissionDecidedBy: "auto_timeout"`）→ 更新 tool_call 记录 → 返回 Agent Loop。权限状态直接记录在 `narrator_tool_calls` 表上，无独立的 `permission_requests` 表
- "Allow with feedback" 流程：用户批准权限时附带 `feedbackText`，session 在当前 tool 完成后中断，feedbackText 作为下一条用户消息自动发送
- 消息缓冲：用户在 narrator thinking 时可通过 WebSocket 发送 `buffer_message`，session 结束后自动链式发送缓冲消息
- `TodoWrite` 工具结果自动持久化到 narrator 的 `todosJson` 字段
- Session 结束时状态设为 `done`（而非 `idle`），前端通过 `mark-read` 端点手动重置为 `idle`
#### 4.2.3 narrator-context.ts — 上下文继承

职责：在 Chapter 分叉时处理 Narrator 的上下文继承策略。

三种继承模式：
- **full**：延迟会话 fork，零成本完整继承。实际 fork 延迟到首次发消息时执行，创建时只记录 `parentNarratorId`，通过 `narrator_message_refs` 共享消息前缀
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
- 同时在 `chapter_edges` 中创建 merge 边（与冗余字段同步维护）
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
- `batchCleanup()` — 批量清理指定 chapters（支持 active/dormant/frozen 状态），返回 `CleanupReport { cleaned, skipped, errors }`
- `dormantInactiveChapters()` — 按 `lastAccessedAt` 排序，超出 `maxActiveWorktrees` 的自动休眠。trunk 角色的章节默认豁免（`exemptTrunkFromDormant` 配置）
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

#### 4.2.8b chapter-edge-service.ts — 章节间关系管理

职责：管理 `chapter_edges` 表的 CRUD，提供章节关系图的查询能力。

核心功能：
- `createForkEdge` / `createMergeEdge` — 由 chapter-fork/chapter-split/chapter-merge 内部调用，
  幂等（同步事务防重，因为表上只有普通索引没有 UNIQUE 约束）
- `getEdgesByChapter(chapterId)` — 获取章节的所有边（入边 + 出边）
- `getEdgesByProject(projectId)` — 获取项目的所有边（用于图渲染）
- `getEdgesByType(projectId, type)` — 按类型筛选（fork/merge/review）
- `deleteMergeEdgesBySource(chapterId)` — 唤醒已合并章节时清理过期 merge 线
- 无 `createEdge`/`deleteEdge` 公开入口：不存在用户手动创建的边（原先仅 dependency 可手动
  创建/删除，该类型已移除，见 6c）
- 无 `getUpstreamDependencies`/`getDownstreamDependents`：随 dependency 边一并移除

#### 4.2.8c chapter-dependency-service.ts — ❌ 不存在（依赖关系已移除，以下为原设计）

> 该文件从未存在。它服务的 dependency 边已整体移除，理由见 6c。注意不要与
> `server/services/dependency-service.ts` 混淆 —— 后者是系统工具检测（git/rg/dtach）。

职责：管理章节间的依赖关系，检测上游变更并提供同步操作。

核心功能：
- `checkUpstreamStatus(chapterId)` — 对每个 dependency 边，通过 `git log` 比较 `metadata.lastSyncedCommit` 和上游章节的当前 HEAD，返回 `{ edgeId, sourceChapterId, hasUpdates, newCommitCount, lastSyncedCommit, upstreamHead }[]`
- `syncUpstream(chapterId, edgeId, strategy)` — 执行上游同步
  - `strategy: 'rebase'`：`git rebase <upstream-branch>`，适用于线性历史
  - `strategy: 'merge'`：复用 chapter-merge 的合并逻辑
  - 成功后更新 `edge.metadata.lastSyncedCommit` 为上游当前 HEAD
  - 冲突时返回冲突信息，复用现有冲突处理流程
- `initDependency(edgeId)` — 创建 dependency 边后初始化 `lastSyncedCommit` 为当前上游 HEAD

原设计的关键假设（也是它被移除的原因）：
- 依赖检测是轻量级操作（只比较 commit SHA），不修改工作区
- 同步操作本质上是 merge 或 rebase，复用现有基础设施
- 通过 eventBus 广播 `dependency:upstream_updated` 事件，前端图上显示更新徽章
- ⚠️ 手工维护的 `lastSyncedCommit` 是漂移源：任何绕过 API 的 rebase/reset/force-push 都会
  让它说谎。"A 领先于 B" 本可由 `git log B..A` 直接算出，不需要记账字段

#### 4.2.8d chapter-cherry-pick-service.ts — Cherry-pick 操作

职责：从一个章节 cherry-pick 特定 commit 到另一个章节。

核心功能：
- `listCommits(chapterId, since?)` — 获取章节的 commit 列表（`git log --oneline`），支持 `since` 参数过滤（如只显示 fork 点之后的 commit）
- `cherryPick(targetChapterId, sourceChapterId, commitShas[])` — 执行 cherry-pick
  - 在目标章节的 worktree 中执行 `git cherry-pick <sha1> <sha2> ...`
  - 成功后在 `chapter_edges` 中创建 `cherry_pick` 边，metadata 记录 commit SHA 列表
  - 冲突时返回冲突信息，复用现有冲突处理流程（AI 辅助或手动解决）

关键设计：
- cherry-pick 按 commit 时间顺序执行（oldest first）
- 如果从同一 source 多次 cherry-pick，更新已有的 cherry_pick 边的 metadata（追加 commit SHA），而非创建新边
- 通过 eventBus 广播 `chapter:cherry_picked` 事件

#### 4.2.8e exploration-group-service.ts — 探索组管理（❌ 未实现，以下为设计意图）

> 该文件不存在。它依赖的 `chapter-fork.batchFork` 同样未实现（见 6b）。保留本节作为设计参考。

职责：管理探索组的生命周期，包括创建（含批量 fork）、决策和放弃。

核心功能：
- `create(input)` — 创建探索组 + 批量 fork 探索分支
  - 创建 `exploration_groups` 记录
  - 从 `baseChapterId` 批量 fork 多个章节（调用 chapter-fork 的 batchFork），每个章节 role 设为 `exploration`，`explorationGroupId` 指向探索组
  - 返回探索组 + 所有创建的章节
- `decide(groupId, chapterId)` — 标记胜出方案
  - 校验 chapterId 属于该探索组
  - 将选定章节合并到 baseChapter（调用 chapter-merge）
  - 其余章节标记为 `abandoned`（保留分支和数据，可查看代码和对话历史）
  - 更新 `group.status = 'decided'`，`group.decidedChapterId = chapterId`
- `abandon(groupId)` — 放弃整个探索组
  - 所有成员章节标记为 `abandoned`
  - 更新 `group.status = 'abandoned'`
- `get(groupId)` — 获取详情含所有成员章节
- `addChapter(groupId, forkInput)` — 向已有探索组追加新的探索分支

关键设计：
- 探索组的 decide 操作可能触发合并冲突，此时进入标准冲突处理流程
- abandoned 的探索章节保留 git 分支和叙述者对话历史，用户可以随时查看代码和 AI 对话作为参考
- 通过 eventBus 广播 `exploration:decided` / `exploration:abandoned` 事件

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
GET    /api/chapters                    # 列表（?projectId=&status=&type=&role=）
POST   /api/chapters                    # 创建（直接创建，非分叉）
GET    /api/chapters/:id                # 详情
PATCH  /api/chapters/:id                # 更新（含 role、color、groupLabel）；位置走 PATCH /api/projects/:id/graph/positions
DELETE /api/chapters/:id                # 删除

POST   /api/chapters/:id/fork           # 分叉（支持 role 参数）
POST   /api/chapters/:id/batch-fork     # 批量分叉（从同一章节创建多个分支）
POST   /api/chapters/:id/split          # 章节拆分（split at commit）
GET    /api/chapters/:id/commits        # 获取章节的 commit 列表（用于拆分和 cherry-pick）
GET    /api/chapters/:id/merge-check    # 预检测合并冲突
POST   /api/chapters/:id/merge          # 合并到目标 chapter
POST   /api/chapters/:id/ai-resolve     # AI 辅助解决合并冲突
POST   /api/chapters/:id/cherry-pick    # 从源章节 cherry-pick commits 到当前章节
POST   /api/chapters/:id/wake           # 唤醒 dormant chapter
POST   /api/chapters/:id/dormant        # 手动休眠

# dependency-status / sync-upstream 两条路由从未实现，随 dependency 边一并移除（见 6c）

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

#### Chapter Edges（章节间关系）
```
GET    /api/chapter-edges                # 列表（?projectId=&chapterId=&type=），只读
# POST / DELETE 已移除：所有边都由创建它的操作维护，不存在用户手动创建的边（见 6c）
```

#### Exploration Groups（探索组）— ❌ 未实现，以下路由均不存在
```
GET    /api/exploration-groups           # 列表（?projectId=&status=）
POST   /api/exploration-groups           # 创建探索组（含批量 fork 探索分支）
GET    /api/exploration-groups/:id       # 详情（含所有成员章节）
PATCH  /api/exploration-groups/:id       # 更新（标题、描述）
DELETE /api/exploration-groups/:id       # 删除探索组
POST   /api/exploration-groups/:id/decide    # 标记胜出方案
POST   /api/exploration-groups/:id/abandon   # 放弃整个探索组
POST   /api/exploration-groups/:id/chapters  # 向探索组追加新的探索分支
```

#### Graph（故事网络图数据）
```
GET    /api/projects/:id/graph           # 增强的图数据（含边类型、依赖状态；不含探索组 —— 该字段无人渲染已移除）
PATCH  /api/projects/:id/graph/positions # 批量更新节点位置
```

#### Narrators（含游离会话）
```
GET    /api/narrators                              # 列表（?chapterId=&standalone=true）
POST   /api/narrators                              # 创建（chapterId 为空时创建游离会话）
GET    /api/narrators/:id                          # 详情
DELETE /api/narrators/:id                          # 删除

POST   /api/narrators/:id/messages                 # 发送消息（SSE 流式响应，支持 multipart 图片上传）
GET    /api/narrators/:id/messages                 # 历史消息（?limit=&cursor=&around=）
GET    /api/narrators/:id/buffer                   # 获取缓冲消息（多设备同步）
GET    /api/narrators/:id/tool-calls/:toolUseId    # 获取完整 tool call 详情（未截断）

POST   /api/narrators/:id/compact                  # 触发手动 compact（?beforeMessageId=）
GET    /api/narrators/:id/compact/:messageId        # 获取 compact 摘要
PATCH  /api/narrators/:id/compact/:messageId        # 更新 compact 摘要
DELETE /api/narrators/:id/compact/:messageId        # 删除 compact 标记（撤销 compact）

POST   /api/narrators/:id/interrupt                # 中断当前执行
POST   /api/narrators/:id/clear-context            # 清除上下文
POST   /api/narrators/:id/retry                    # 重试消息
POST   /api/narrators/:id/revert                   # 撤销消息
PATCH  /api/narrators/:id/permission-mode          # 切换权限模式
PATCH  /api/narrators/:id/model                    # 切换模型
PATCH  /api/narrators/:id/title                    # 手动更新标题
POST   /api/narrators/:id/generate-title           # AI 自动生成标题
PATCH  /api/narrators/:id/archive                  # 归档叙述者
PATCH  /api/narrators/:id/unarchive                # 取消归档
PATCH  /api/narrators/:id/mark-read                # 标记已读（done → idle）
PATCH  /api/narrators/:id/fast-mode                # 快速模式
PATCH  /api/narrators/:id/relaxed-plan             # 放松规划
PATCH  /api/narrators/:id/reasoning-effort         # 推理努力级别
GET    /api/narrators/:id/patches                  # 补丁列表
GET    /api/narrators/:id/background-tasks         # 后台任务

# 白名单目录
GET    /api/narrators/:id/whitelist-dirs           # 白名单目录列表
POST   /api/narrators/:id/whitelist-dirs           # 添加白名单目录
PATCH  /api/narrators/:id/whitelist-dirs/:dirId    # 更新白名单目录
DELETE /api/narrators/:id/whitelist-dirs/:dirId    # 删除白名单目录
```

> 游离会话（standalone sessions）通过 `standalone=true` 查询参数区分，叙述者的 `chapterId` 为 null。

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

#### Git
```
POST   /api/projects/:id/git/init                  # 初始化 Git 仓库
GET    /api/projects/:id/git/branches              # 获取分支列表
GET    /api/projects/:id/git/status                # 获取 Git 状态
```

#### Dependencies（系统依赖检查）
```
GET    /api/dependencies                           # 检查系统依赖（git、podman、dtach 等）
```

#### Skills
```
GET    /api/skills                                 # 技能列表（?projectId=）
POST   /api/skills                                 # 创建技能
GET    /api/skills/:id                             # 技能详情
PATCH  /api/skills/:id                             # 更新技能
DELETE /api/skills/:id                             # 删除技能
```

#### Routines
```
GET    /api/routines                               # 例程列表
POST   /api/routines                               # 创建例程
GET    /api/routines/:id                           # 例程详情
PATCH  /api/routines/:id                           # 更新例程
DELETE /api/routines/:id                           # 删除例程
POST   /api/routines/:id/run                       # 执行例程
```

#### Notifications
```
GET    /api/notifications                          # 通知列表
POST   /api/notifications/mark-read                # 标记已读
GET    /api/notification-sounds                    # 通知声音列表
POST   /api/notification-sounds                    # 上传通知声音
```

#### AI 提供商
```
GET    /api/openai/models                          # OpenAI 模型列表
GET    /api/anthropic/models                       # Anthropic 模型列表
GET    /api/codex/status                           # Codex 状态
```

#### FS（文件系统）
```
GET    /api/fs/list                                # 列出目录内容
GET    /api/fs/read                                # 读取文件
```

#### Project DB（项目数据库）
```
POST   /api/projects/:id/db/backup                 # 备份项目数据库
POST   /api/projects/:id/db/import                 # 导入项目数据库
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
    licenses.tsx              # 开源许可证页面
    projects/
      index.tsx               # 项目列表
      $projectId.tsx          # 项目详情 = 故事网络图（主界面）
    chapters/
      $chapterId.tsx          # Chapter 重定向（查询 primary narrator → 跳转 /narrators/$narratorId）
    narrators/
      index.tsx               # 游离会话列表（活跃）
      archived.tsx            # 已归档会话列表
      $narratorId.tsx         # 叙述者详情
    settings/
      index.tsx               # 设置页（含语言切换器）
    admin/
      index.tsx               # 管理员面板
      providers.tsx           # AI 提供商配置
      terminals.tsx           # 终端管理
    routines/
      index.tsx               # 例程列表
  components/
    chapter/
      ChapterCard.tsx         # Chapter 卡片（可展开显示 commit 列表）
      ChapterForkModal.tsx    # 分叉对话框（支持 role 选择）
      ChapterSplitModal.tsx   # 章节拆分对话框（从 commit 列表选择拆分点）
      ChapterMergeModal.tsx   # 合并对话框
      ChapterCleanupModal.tsx # 批量清理对话框
      ChapterBatchMergeModal.tsx # 批量合并对话框
      BatchForkModal.tsx      # ❌ 不存在（批量分叉未实现，见 6b）
      CherryPickModal.tsx     # ❌ 不存在（章节级 cherry-pick 未实现，见 6e）
      SyncUpstreamModal.tsx   # ❌ 不存在（依赖关系已移除，见 6c）
      CommitList.tsx          # 章节 commit 列表组件（可展开，支持选择 commit）
    common/                   # 通用组件（按钮、模态框、布局等）
    narrator/
      NarratorPanel.tsx       # Narrator 面板（消息列表 + 输入 + 图片上传 + 缓冲消息）
      ChapterBar.tsx          # Chapter 信息栏（嵌入 NarratorPanel，当 narrator 绑定 chapter 时显示）
      MessageBubble.tsx       # 消息气泡
      MarkdownContent.tsx     # Markdown 渲染（react-markdown + remark-gfm）
      ToolCallCard.tsx        # Tool Call 展示卡片
      CodeBlockWithActions.tsx # 代码块（复制/全屏/自动换行/横屏模式）
      DiffView.tsx            # Diff 查看器（行级 + 词级高亮）
      PermissionBanner.tsx    # 权限审批横幅（支持内联 per-tool-call 审批 + feedbackText）
      AskUserQuestionBanner.tsx # AskUserQuestion 工具调用的问答 UI
    graph/                    # 实际内容见 8.x「故事网络图组件」一节
      NarraFlow.tsx           # 交互式 React Flow 画布（项目主界面核心组件）
      ChapterNode.tsx         # 自定义节点（显示 role 图标、颜色、状态徽章）
      DraftNode.tsx           # 操作草稿节点（fork/merge/review 落库前的预览）
      TerminalNode.tsx / ReviewNode.tsx
      ForkEdge.tsx            # 分叉边（实线蓝色）
      MergeEdge.tsx           # 合并边（虚线绿色）
      CherryPickEdge.tsx      # Cherry-pick 边（点线紫色）—— 已注册但无人创建此类边
      TerminalEdge.tsx / ReviewEdge.tsx
      NodeContextMenu.tsx     # 节点右键菜单
      SelectionToolbar.tsx / LassoSelection.tsx  # 框选与批量操作
      TerminalContextMenu.tsx
      # 以下均不存在：StoryNetworkCanvas、ExplorationGroupNode、DependencyEdge（已移除）、
      # EdgeContextMenu、CanvasContextMenu、GraphSidePanel（已移除）
    terminal/
      TerminalPanel.tsx       # 终端面板
      TerminalTabs.tsx        # 终端标签页
    container/
      ContainerStatus.tsx     # 容器状态指示器
      ContainerLogs.tsx       # 容器日志查看器
    nav/                      # 导航组件（侧边栏、面包屑等）
    project/                  # 项目相关组件
    providers/                # AI 提供商配置组件
    settings/                 # 设置页组件
    LanguageSwitcher.tsx      # 语言切换器（Mantine Select，位于设置页）
    ThemeSwitcher.tsx         # 主题切换器（light/dark/auto）
  hooks/
    useProjects.ts            # Project CRUD hooks
    useChapters.ts            # Chapter CRUD hooks
    useChapterEdges.ts        # 章节边 CRUD hooks
    useChapterCommits.ts      # 章节 commit 列表 hook
    useDependencyStatus.ts    # 依赖状态检查 hook
    useExplorationGroups.ts   # 探索组 CRUD hooks
    useCherryPick.ts          # Cherry-pick 操作 hook
    useGraphPositions.ts      # 节点位置保存（防抖 500ms）
    useNarrator.ts            # Narrator 消息 + CRUD（含游离会话）
    useNarratorWS.ts          # Narrator WebSocket 连接
    useTerminals.ts           # Terminal CRUD hooks
    useTerminalWS.ts          # Terminal WebSocket 连接
    useStoryGraph.ts          # 故事网络数据 + 布局（增强版，含边类型和探索组）
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
    en/                       # 英文翻译（15 个命名空间 JSON）
    zh-CN/                    # 简体中文翻译（15 个命名空间 JSON）
```

> 路由变更说明：`$projectId.graph.tsx` 已删除，故事网络图直接作为 `$projectId.tsx` 的主界面。打开项目即看到交互式图。
### 6.2 故事网络可视化（项目主界面）

故事网络图是项目的主界面（`/projects/$projectId`），使用 React Flow (`@xyflow/react`) + Dagre (`@dagrejs/dagre`) 实现交互式画布。

组件结构：
实际组件（`frontend/components/graph/`，宿主为 `NarraFlow`）：

- `NarraFlow` — 交互式画布主容器，通过 `useNarraFlow(projectId)` 获取图数据并做 Dagre 混合布局
- `ChapterNode` — 自定义节点，使用 Mantine Card 渲染，显示标题、role 图标、状态 Badge、narrator 数量、容器标记、上游更新徽章。trunk 节点较大尺寸 + 加粗边框，exploration 节点虚线边框
- `DraftNode` — 操作草稿节点：fork/merge/review 在落库前先以草稿节点 + 草稿边预览
- `TerminalNode` / `ReviewNode` — 画布上的终端气泡与评审节点
- `ForkEdge` — 分叉边（贝塞尔曲线样式，蓝色 `#4c6ef5`）
- `MergeEdge` — 合并边（smoothstep 样式，绿色 `#40c057`，`strokeDasharray`）

- `TerminalEdge` / `ReviewEdge` — 终端与评审关系边
- `NodeContextMenu` — 节点右键菜单：Fork、评审、设为 trunk/branch/exploration、休眠/唤醒、取消合并、删除、在文件管理器中显示、转为子代理、采纳/驳回评审
- `SelectionToolbar` + `LassoSelection` — 框选与多选批量操作
- `TerminalContextMenu` — 终端节点右键菜单

未实现但曾在本文档中描述过的组件，勿据此写代码：`StoryNetworkCanvas`、`useStoryGraph`、`ExplorationGroupNode`（探索组没有图上渲染）、`EdgeContextMenu`、`CanvasContextMenu`（ruler 模式有画布右键处理，classic 模式没有独立组件）、`GraphSidePanel`（已删除，功能由 SelectionToolbar + NodeContextMenu 承担）。`CherryPickEdge` 组件存在且已注册为 `cherry_pick` 边类型，但没有任何代码创建该类型的边，因此永不渲染 —— 详见下方 6e。

**节点交互：**
- 双击节点 → 导航到章节详情页 `/chapters/$chapterId`
- 右键节点 → 上下文菜单
- 拖拽节点 → 手动调整位置（防抖 500ms，`PATCH /api/projects/:id/graph/positions` 保存到 anchorCommitSha/axisOffset/crossOffset）
- 框选多个节点 → SelectionToolbar 批量操作（fork、合并到新章节/已有章节、开终端）
- 无「拖拽连接柄建边」交互：它原先用于创建 dependency 边，该边类型已移除（见 6c），
  `nodesConnectable` 也随之关闭

**commit 列表：**
- 由章节详情的 `GitCommitsTab` 和 `CommitDetailModal` 承担（不在图的侧边面板里 —— 该面板已删除）
- 每个 commit 行显示：短 SHA、提交信息、时间
- 每个 commit 行有"从此分叉"按钮，点击触发章节拆分（split at commit）操作
- commit 列表通过 `GET /api/chapters/:id/commits` 获取

**布局策略：**
- 混合模式：有手动位置（axisOffset/crossOffset）的节点固定，其余使用 Dagre 自动布局
- Dagre 配置：`rankdir: 'TB'`，节点间距 80/120

**视觉设计：**
- trunk 节点：较大尺寸（320×140），加粗边框（3px），显示 trunk 图标
- branch 节点：标准尺寸（280×120）
- exploration 节点：标准尺寸，虚线边框，包裹在探索组的分组框内
- frozen 节点：半透明 + 锁图标
- 状态颜色映射：active=indigo, dormant=gray, merged=green, abandoned=red(淡化), frozen=blue(淡化)
- 边样式：fork=实线蓝色, merge=虚线绿色, dependency=虚线橙色(animated), cherry_pick=点线紫色
- 分组框：通过 `groupLabel` 相同的节点自动分组，或通过 `explorationGroupId` 分组
- 上游有更新的节点显示橙色圆点徽章（右上角）
- 用户自定义 `color` 覆盖默认状态颜色

**增强的 Graph API 返回结构：**
```typescript
{
  nodes: [{
    id: string,
    type: "chapterNode" | "explorationGroupNode",
    data: {
      title: string,
      status: "active" | "dormant" | "merged" | "abandoned" | "frozen",
      role: "trunk" | "branch" | "exploration",
      branch: string,
      groupLabel?: string,
      color?: string,
      narratorCount: number,
      hasContainers: boolean,
      hasUpstreamUpdates: boolean,
      explorationGroupId?: string,
      recentCommits?: [{ sha: string, message: string, date: string }],
    },
    position: { x: number, y: number },
  }],
  edges: [{
    id: string,
    source: string,
    target: string,
    type: "fork" | "merge" | "dependency" | "cherry_pick",
    animated?: boolean,
  }],
  explorationGroups: [{
    id: string,
    title: string,
    status: "active" | "decided" | "abandoned",
    chapterIds: string[],
    baseChapterId: string,
    decidedChapterId?: string,
  }],
}
```

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
  | { type: 'chapter:forked'; chapterId: string; parentId: string; projectId: string }
  | { type: 'chapter:split'; prefixChapterId: string; continuationChapterId: string; newForkChapterId: string; commitSha: string; projectId: string }
  | { type: 'chapter:merged'; sourceId: string; targetId: string }
  | { type: 'chapter:conflict'; sourceId: string; targetId: string; files: string[] }
  | { type: 'chapter:cherry_picked'; sourceId: string; targetId: string; commits: string[] }
  | { type: 'chapter:frozen'; chapterId: string }
  | { type: 'chapter:dormant'; chapterId: string }
  | { type: 'chapter:woken'; chapterId: string }
  | { type: 'chapter:abandoned'; chapterId: string }
  | { type: 'chapter:role_changed'; chapterId: string; role: string }
  // 依赖关系
  | { type: 'dependency:created'; edgeId: string; sourceId: string; targetId: string }
  | { type: 'dependency:removed'; edgeId: string; sourceId: string; targetId: string }
  | { type: 'dependency:upstream_updated'; edgeId: string; targetChapterId: string; newCommitCount: number }
  | { type: 'dependency:synced'; edgeId: string; targetChapterId: string; strategy: string }
  // 探索组
  | { type: 'exploration:created'; groupId: string; chapterIds: string[] }
  | { type: 'exploration:decided'; groupId: string; decidedChapterId: string }
  | { type: 'exploration:abandoned'; groupId: string }
  | { type: 'exploration:chapter_added'; groupId: string; chapterId: string }
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

**"广播到所有 WebSocket 客户端"不是无条件的。** `server/websocket/narrator-ws.ts` 按前缀
（`chapter:` / `dependency:` / `exploration:` / `review:`）把故事网络事件桥接到 WS，前缀匹配
的好处是新增生命周期事件无需再改一处，代价是新事件的 **payload 也默认外发**。而
`broadcastToAll` 不按项目、章节或用户过滤——它遍历整个连接集合。因此：

- 这些前缀下的事件，payload 必须对"所有已登录客户端"都是安全的，且不能是高频的。
- 不满足的必须进 `GRAPH_TOPOLOGY_EXCLUDED`。当前成员：`chapter:files_changed`、
  `chapter:external_change_recorded`（worktree watcher 每几秒一次，且携带宿主路径）、
  `chapter:conflict`（携带某次合并的冲突文件名，无订阅者）。
- 需要跨客户端刷新图的事件必须带 `projectId`：前端 `shouldRefreshProjectGraphForEvent` 把
  **缺失** 的 projectId 当作"可能与我有关"，所以漏带会让一个项目的操作刷新所有项目的图。
- 需要窄范围投递的用 `narrator:ws_broadcast`（按 narrator 定向），不要放进上述前缀。

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
  anthropic: {
    apiKey?: string                 // Anthropic API Key
    baseUrl?: string                // 自定义 API 端点
  }
  openai: {
    apiKey?: string                 // OpenAI API Key
    baseUrl?: string                // 自定义 API 端点
  }
  }
  }
  mcp: {
    servers?: Record<string, {      // MCP 服务器配置
      command: string
      args?: string[]
      env?: Record<string, string>
    }>
  }
  chapters: {
    maxActiveWorktrees: number      // 默认 10
    maxActiveContainers: number     // 默认 5
    worktreeSizeWarningMb: number   // 默认 500
    autoSaveOnDormant: boolean      // 默认 true
    dormantAfterMinutes: number     // 不活跃多久后自动休眠，0=禁用
    exemptTrunkFromDormant: boolean // trunk 角色的章节不自动休眠，默认 true
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

### Phase 6: 章节系统重构 — 图即项目

#### 6a: 数据模型 + 图主界面（基础） ✅
- schema 变更：chapters 表新增 role/color/groupLabel/explorationGroupId（`pinned` 也加了但从未被读写；`frozen` 状态后来移除，见 6b）
- 新增 chapter_edges 表 + chapter-edge-service
- 数据迁移：从 parentChapterId/mergedIntoChapterId 生成 fork/merge 边
- 故事网络图作为项目主页面（替代章节卡片网格）
- 交互式画布：节点拖拽、右键菜单、框选工具栏（侧边面板 `GraphSidePanel` 曾存在，后被工具栏 + 右键菜单取代并删除）
- 节点位置持久化（anchorCommitSha/axisOffset/crossOffset + PATCH graph/positions；最初的 positionX/positionY 已被这三列取代）

#### 6b: 角色系统 + 章节拆分 ⚠️ 部分完成
- role 字段（trunk/branch/exploration）+ 图上的视觉区分
- groupLabel **只有存储没有渲染**：列、PATCH 校验、graph 响应字段都在，但前端只在 `useNarraFlow`
  的类型声明里出现一次，没有任何分组框或标签 UI 消费它。要实现分组渲染需自己加 UI。
- commit 列表（CommitList 组件 + GET /api/chapters/:id/commits）
- 章节拆分（split at commit）：`chapter-split.ts` + `POST /api/chapters/:id/split` + ChapterSplitModal ✅
  - **实现与本文档 4.2.1 的规格有一处故意偏离**：前序章节的消息截断用 `narrator_message_refs.seq`
    而非"commit 时间戳与消息 createdAt 对比"。时间戳方案在 commit 时间被 rebase/`--date` 改写、
    cherry-pick 后 authoredAt 早于实际、同毫秒碰撞、懒 fork 的 seq 稀疏而时间连续、compact 标记的
    createdAt 是压缩时刻而非内容时刻等场景下都会选错截断点。全部既有 fork 代码同样用 seq。
  - 前序章节状态用 `dormant` 而非 `frozen`（见下）。
- ~~frozen 状态~~ **已移除**：它没有任何写入路径，且 fork/wake/dormant 全部拒绝它，
  一旦进入就再也无法分叉、唤醒、合并或评审——一个没有出口的状态。"合并即冻结"的意图
  由 `merged` 表达，后者本就是这个语义且有 `unmerge` 作为出口。前端保留其显示映射以兼容旧数据。
- 批量分叉（batchFork）**未实现**，且残留已清理：原先存在的 `batchForkSchema` 与前端
  `batchForkChapter` 客户端函数都已删除（无路由、无服务方法、零调用点）。为一个 404 路由保留
  类型化客户端和 validator，会让后续开发者以为功能可用——这正是本节曾被标为"✅"的原因。
  若要实现：先加服务方法与路由，再加客户端；批量场景可预先分配 `crossOffset`，绕开
  `chapter-fork.ts` 中无锁的槽位搜索。

#### 6c: 依赖关系 ❌ 已移除

原设计：用户在图上拖拽连接两个节点声明 dependency 边，系统检测上游变更并提供 rebase/merge
同步。**本阶段唯一落地的部分是"画一条橙色虚线"，其余从未存在。已整体移除。**

移除前的实际状态：

- 边能建（`onConnect` 直接落库，无确认对话框，与本文档原先描述不符），但**无法从 UI 删除**：
  `NarraFlow` 没有 `onEdgesChange`/`onEdgesDelete`/`onEdgeContextMenu`，`useDeleteChapterEdge`
  零调用点。误拖一条线即产生永久边。
- 创建时只校验非自环、章节存在、同项目：**无环检测**（A→B→C→A 可建）、**无去重**
  （`chapter_edges` 只有普通索引没有 UNIQUE 约束；`createForkEdge` 专门用同步事务防重，
  dependency 路径没有）。
- **对任何行为零影响**：`chapter-merge`/`chapter-fork`/`chapter-service` 从不读 dependency 边，
  它不影响合并顺序、不阻止合并、不触发 rebase、不参与批量合并编排。
- `metadata.lastSyncedCommit` 写入 `null` 后再无代码更新或读取。
- 上游变更检测完全不存在：`hasUpstreamUpdates` 在 `graph.ts` **硬编码 `false`**（徽章永不亮），
  `dependency:upstream_updated`/`dependency:synced` 从未发出，
  `GET /chapters/:id/dependency-status` 与 `POST /chapters/:id/sync-upstream` 无路由
  （前端客户端在、零调用），`chapter-dependency-service.ts` 与 `SyncUpstreamModal` 都不存在。
  本文档原先所指的 "chapter-dependency-service" 实际被误认成了
  `server/services/dependency-service.ts` —— 后者是**系统工具检测**（git/rg/dtach 装没装），
  与章节依赖毫无关系。
- Ruler 流程模式对 dependency 边完全无支持，连 `onConnect` 都没有。

移除理由（不止是"没写完"）：它表达的关系 git 已经有了。"B 基于 A" 是 fork 边（自动维护）、
"B 取了 A 的改动" 是 merge 边、"A 领先于 B" 是 `git log B..A`。用一张手工维护、无校验的边表
复制这些信息，只会引入漂移源 —— 任何绕过 API 的 rebase/reset/force-push 都会让
`lastSyncedCommit` 说谎。若只想标记"两个分支语义相关"，`groupLabel` 是更合适的字段，
不需要一条有方向的图边。

实践中从未创建过任何 dependency 边，因此无需数据迁移。`chapter_edges.type` 枚举保留
`dependency` 值以便历史行（若有）仍可加载，但没有任何写入路径。`GET /api/chapter-edges`
保留为只读（fork/merge/review 边仍需要）。

#### 6d: 探索组 ❌ 未实现
本阶段整体未落地。已存在的只是**周边设施**，不构成可用功能：

- ✅ `exploration_groups` 表、`chapters.explorationGroupId` 外键、覆盖索引
- ✅ validators（`createExplorationGroupSchema` / `updateExplorationGroupSchema`）
- ✅ 项目数据库同步（`syncExplorationGroups`）与导入白名单
- ✅ `GET /:id/graph` 会返回 `explorationGroups`（但不含 `chapterIds`，前端接口声明了该字段）
- ❌ **无 `exploration-group-service.ts`、无路由、`app.ts` 无挂载**
- ❌ `explorationGroupId` 在整个 server 下**无写入点**
- ❌ 四个 `exploration:*` 事件从未发射
- ❌ 无 `ExplorationGroupNode`、无 `ExplorationGroupPanel`、无 `useExplorationGroups`
- ❌ `zh-CN/explorations.json` 不存在；`en` 版仅 5 个 key 且无任何组件使用
- ❌ 前端曾有 6 个 API 客户端函数，因零调用点已被移除（2026-08 决定）

重启该特性需要先定三个决策（调研结论，供将来参考）：
1. **decide 不应自动合并胜出分支**。本文档 4.4 说要合并，但同处也承认"可能触发冲突，
   进入标准冲突处理流程"——那是交互式的，端点返回值无法表达"等待用户裁决"。应只做
   标记 + 处理其余分支，合并交给现成的 merge 入口。
2. **abandon 应把成员置 `dormant` 而非 `abandoned`**。`abandoned` 是真正的终态：不可 wake、
   不可作为 fork 父、且 ignored 文件归档在置 abandoned 时已被丢弃，与"用户可随时查看代码和
   对话作为参考"的设计意图矛盾。
3. **create 部分失败应保留已成功的分支**并在响应中带 `failed`，与 batchFork 的非全有全无
   语义一致（fork 的 rollback 栈本就不跨章节）。

另注：create 依赖 `batchFork`，而后者同样未实现（见 6b）。若并发 fork 同一父章节，
需注意 fork 全程无 `chapterLock` 且 `crossOffset` 槽位分配是 read-then-write 竞态——
探索组可预先分配 `crossOffset` 规避。

#### 6e: Cherry-pick + 参考式整合 ❌ 未实现

先分清两件事：**作为合并策略的 cherry-pick 是可用的** —— `gitService.cherryPick` 由
`chapter-merge` 以 `strategy: "cherry-pick"` 正常调用，产生的 commit 记为
`source: "cherry_pick"`。本节描述的是另一件事：从别的章节挑选特定 commit 过来，并在图上
留一条 cherry_pick 边。这件事没有实现：

- `chapter-cherry-pick-service` 与 `CherryPickModal` **都不存在**（只有一个
  `chapter-cherry-pick-dirty.test.ts` 覆盖合并策略路径）
- 没有 `POST /api/chapters/:id/cherry-pick` 路由。残留的 `cherryPickSchema` 与前端
  `cherryPickChapter` 客户端已删除（与 6b 的 batchFork 残留同一类问题）
- `chapter_edges.type` 枚举含 `cherry_pick`，`CherryPickEdge` 组件也注册了，但
  **没有任何代码创建该类型的边**（`chapter-edge-service` 只有 createForkEdge /
  createMergeEdge / createDependencyEdge），所以这条紫色点线边永不渲染
- 参考式整合（@mention 其他章节并注入 diff）未实现。`NarratorPanel` 里的 @mention
  是给具名叙述者用的，与章节 diff 无关

若要实现：加服务方法 + 路由 + `chapterEdgeService.createCherryPickEdge`，再补回 validator
和客户端。

---

## 10. 关键设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 会话分叉机制 | 自定义 Agent Loop + narrator_message_refs 消息引用 | 通过 narrator_message_refs 共享消息前缀，支持多提供商 |
| 回溯分叉 | narrator_message_refs fork + forkMessageId | 精确到消息级别回溯，叙述者间共享前缀 |
| 上下文压缩 | Haiku 模型做 summarization | 成本低，速度快 |
| 容器运行时 | Podman | 无 daemon，rootless，兼容 Docker Compose 格式 |
| 前端组件库 | Mantine | 开箱即用的复杂组件，CSS-in-JS 主题系统 |
| 图可视化 | React Flow + Dagre | 成熟的 React 图渲染库，自动布局 |
| 消息存储 | 完整 BetaMessage.content JSON + narrator_message_refs junction table | 保留 tool_use/thinking blocks 用于展示，叙述者间共享消息实体 |
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
| 对话分支 | narrator_message_refs（叙述者-消息关联），通过 seq 字段维护消息顺序 | 支持从任意消息 fork 新叙述者，共享前缀避免消息重复，seq 字段支持高效游标分页 |
| Compact 机制 | system 消息标记 + narrator_message_refs.isCompact | 压缩历史上下文为摘要注入 system prompt，减少 token 消耗，支持部分压缩（指定 beforeMessageId） |
| FTS tokenizer | trigram | 支持 CJK 搜索，无需分词器 |
| 主题模式 | auto（跟随系统） | 用户可切换 light/dark/auto，比固定 dark 更灵活 |
| 自动休眠触发 | 防抖调度（30 秒窗口） | chapter 创建/访问时触发，避免频繁检查 |
| 章节关系建模 | chapter_edges 显式边表 + parentChapterId/mergedIntoChapterId 冗余字段 | 边表支持 4 种关系类型（fork/merge/dependency/cherry_pick），冗余字段保留高频查询路径 |
| 章节角色 | role 标签（trunk/branch/exploration）而非固定层级 | 动态涌现的层级关系，不预设固定结构，任何章节都可以成为基线 |
| 项目主界面 | 故事网络图（交互式画布）替代章节卡片网格 | 图是理解章节关系的最直观方式，打开项目即看到全局视图 |
| 节点位置持久化 | chapters 表 anchorCommitSha/axisOffset/crossOffset 字段（取代最初的 positionX/positionY） | 混合布局：手动定位的节点固定，其余自动布局，反映用户心智模型 |
| 探索组 | 独立 exploration_groups 表 | 曾按此设计建表并保留 validator，但**没有落地**：没有服务方法、没有路由、图上也没有分组框。graph 接口原先每次请求都查这张表并返回，却无人渲染，该查询已移除 |
| 章节拆分 | split at commit = 创建前序章节 + 原章节变后续 + 新 fork | 比简单的"从历史 commit fork"更精确地表达语义：历史被拆分为两条独立的演进路径 |
| ~~frozen 状态~~ | **已移除**，前序章节改用 dormant | 原设计让拆分后的前序章节进入 frozen，但该状态没有出口（fork/wake/dormant 全拒绝它），且从无写入路径。"已确定的历史"由 merged 表达，后者有 unmerge 作为出口 |
| 子代理系统 | narrator.type='subagent' + subagentType(explore/plan/general) | 叙述者可派生子任务代理，通过 parentToolUseId 关联消息树 |
| 技能系统 | 项目级技能库（skill-service.ts） | 为叙述者提供领域特定指令和知识，提升 AI 输出质量 |
| 例程系统 | 内置 + 自定义例程（routine-service.ts） | 自动化重复性任务，支持内置和用户自定义例程 |
