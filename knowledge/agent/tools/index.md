---
id: agent.tools
title: 工具体系
summary: 工具注册、可选工具加载、工具搜索；各类工具的职责。
anchors:
  - server/lib/agent/tools/index.ts
  - server/lib/agent/tools/tool-search.ts
  - server/lib/agent/tool-registry.ts
  - server/lib/agent/tool-loading.ts
  - server/lib/agent/tool-search-index.ts
  - server/lib/agent/tool-name.ts
  - server/services/tool-loading-service.ts
  - shared/routine-modes.ts
  - server/lib/agent/tools/learning-guide.ts
  - server/lib/agent/tools/number-param.ts
keywords:
  - toolRegistry
  - ToolRegistry
  - OPTIONAL_TOOLS
  - ToolSearch
  - /load
  - 工具加载
  - manual auto resident
  - routine-modes
  - 前缀保持
  - anthropic_tool_addition
  - custom_injection
  - LearningGuide
  - looseNumber
  - 工具名规则
  - tool-load-markers
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 工具体系

工具是 `ToolDefinition`（名称、描述、zod 参数、`execute`），集中注册在单例 `toolRegistry`。一部分工具始终可用（core），一部分默认不进会话，需要加载（optional）；加载方式分手动 `/load`、常驻、以及经 ToolSearch 按需发现。按职责分成几类：文件、命令、网页、与人交互四类各有子节点；会话自己组织工作的流程与协作工具（计划模式、定时任务、技能、团队、worktree、回忆、生图等）见 [流程与协作工具](workflow.md)；让会话管理 NarraFork 自身（设置、MCP、钩子、知识库 ACL、插件安装）的管理工具由管理员闸门保护，见 [管理工具](admin.md)。

## 关键规则
- 注册：`tools/index.ts` 在模块末尾调用 `registerCoreTools`，注册 `core` 与 `optional` 两个 provider。provider 的工具是惰性实体化的（首次 `get/all` 才调用 `tools()`），避免循环导入时读到未初始化的绑定；显式 `register` 的工具优先于 provider 里的同名工具；每次变更递增 `revision`（`tool-registry.ts`）。
- 名称必须符合 `^[a-zA-Z0-9_-]+$`（OpenAI/Anthropic/Gemini 交集）；shell 工具在所有平台都叫 `Bash`，旧别名 `Shell` 在 `get` 中回退到 `Bash`，精确匹配优先（`tool-name.ts`、`ToolRegistry.get`）。MCP 与插件工具的名称在生成处规范化。
- core 包括 ToolSearch、Bash、Read/Write/Edit/Glob/Grep、StructView/StructSed、WebSearch/WebFetch、计划模式、子代理（`agentTool`，线上名 `Agent`）、Stop/Watch/Send、Team、Skill、知识库与大纲读取、设备/目录/worktree 切换，以及各类反思确认工具（danger/exit-plan/task）。
- `OPTIONAL_TOOLS` 是默认不加载的集合：Eval、Terminal、ShareFile、GenUI、ImageGen、Notification、Recall、Browser、ForkNarrator、ScheduledTask、各种 *Admin 工具、知识库编辑、Pack、PluginInstall、OutlineEdit、Pipeline 工具等（`tools/index.ts:OPTIONAL_TOOLS`）。
- 三种加载模式 `manual` / `auto` / `resident`（`shared/routine-modes.ts`）：manual 只有 `/load` 才进会话；resident 新会话预加载；auto 不预加载，但能被 ToolSearch 发现并按组加载。ToolSearch 只检索已授权的 auto 工具；MCP 命中只加载该工具，内置命中加载其 routine 组；`limit` 1–5，默认 3，query 1–512 字符，整体 10s 超时；排序用有界 BM25（`tool-search-index.ts`）。
- 前缀保持（`tool-loading.ts`）：在一个上下文纪元（最近一次 compact 之后）内，请求的 `tools` 数组固定，会话中途加载的工具以协议原生形式插入历史：`anthropic_tool_addition`、`anthropic_deferred_tail`、`openai_additional_tools`、`kimi_system_tools`，否则 `custom_injection`（把 schema 写进加载通知）。模型卡未声明模式时按模型名取默认（claude、gpt、deepseek、kimi 各有默认，其余 `custom_injection`）。目标协议无法追加时，下次请求以新的缓存基线重新声明，对话保留（ToolSearch 输出里的 note）。卸载不会缩减声明，执行器会拒绝已卸载的工具。
- 并行与串行：Read/Grep/WebFetch/Watch/Send 等只读类工具可并行，Stop、Pipeline、计划模式、设备/目录切换、Worktree、Team 等是串行屏障（`shared/tool-parallel-groups.ts`）。
- 知识库管理员类会话（Knowledge Steward）会在 toolFilter 中拒绝 WebSearch/WebFetch（`KNOWLEDGE_KIND_DENY_CORE`）。

## 从哪读起
- `server/lib/agent/tools/index.ts`：全部内置工具的清单。
- `server/services/tool-loading-service.ts:changeLoadedToolGroup`：加载/卸载一个工具组的服务端实现。
- `server/lib/agent/__tests__/loop-tool-loading.test.ts`、`server/lib/agent/tool-routing.test.ts`
- `tools/learning-guide.ts`：core 工具，按语言检索与读取内置学习文档（`@shared/learning-content`）；`tools/number-param.ts`：`looseNumber` 宽松接受字符串数字与浮点，`normalizeNumber` 在执行时按范围取整截断，避免模型的小偏差白白浪费一轮（browser、grep、knowledge 等工具使用）。

## 下面有什么

- [文件工具](file-tools.md)：Read / Write / Edit / Glob / Grep / 结构化编辑。
- [命令与终端工具](shell.md)：Bash、后台任务、Watch、Stop、Terminal 工具（Await 已退役）。
- [浏览器与网页](web.md)：Browser、WebFetch、WebSearch。
- [与人交互的工具](interaction.md)：Notification、Send、ShareFile、GenUI。
- [流程与协作工具](workflow.md)：计划模式、定时任务、技能、知识包、团队、worktree 与设备切换、回忆、生图。
- [管理工具](admin.md)：让会话管理 NarraFork 自身的工具：各类 *Admin、插件安装、引导设置。
- [工具执行日志](execution-log.md)：管理员对 `narrator_tool_calls` 的全局只读视图：游标分页、过滤、凭证脱敏与设置页展示。

其余工具（子代理 Task/Agent、知识库读写与审阅、MCP 服务器提供的工具等）不在本层子节点内，分别见 [子代理](../subagents.md)、[MCP 集成](../mcp.md) 等。

## 改它时
- 加一个内置工具：在 `tools/index.ts` 的 core 或 optional provider 里登记；不默认加载的要进 `OPTIONAL_TOOLS`；工具名必须符合 `^[a-zA-Z0-9_-]+$`（`tool-name.test.ts`）；工具定义必须是静态数据属性，不能用 getter 读设置或模型池（`tools/__tests__/static-definitions.test.ts` 会失败）；只管理员可加载的要加进 `services/tool-load-markers.ts:ADMIN_ONLY_LOAD_TOOLS`。
- 同时要看的外围：权限分类在 `services/narrator-permission.ts`，并行/串行屏障在 `shared/tool-parallel-groups.ts`（`tool-execution-groups.test.ts`），可选工具的加载与装载状态在 `tool-loading-service.ts`（`tool-search-service.test.ts`、`optional-tool-state.test.ts`、`loop-tool-loading.test.ts`），ToolSearch 排序在 `tool-search-index.ts`（`tool-search-index.test.ts`）。
- 前缀保持是缓存不变量：同一上下文纪元内请求的 `tools` 数组固定，卸载不缩减声明，只由执行器拒绝已卸载的工具；改加载逻辑别破坏它。
- 旧别名 `Shell` 回退到 `Bash`，改名要保留（`tool-registry-legacy-alias.test.ts`）。
- 新增一类工具时在对应子节点（文件/命令/网页/交互/流程/管理）补充说明。
