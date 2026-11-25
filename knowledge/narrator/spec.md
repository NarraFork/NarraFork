---
id: narrator.spec
title: 动态 Spec
summary: 会话的 Spec：spec:// 虚拟文件、任务、提醒、广播与编辑插话，以及行为边界 SOP。
anchors:
  - frontend/lib/api/spec.ts
  - server/lib/agent/tools/behavior-fence-grant.ts
  - server/lib/spec-uri.ts
  - server/lib/validators/spec.ts
  - server/routes/spec.ts
  - server/services/behavior-fence-sop.ts
  - server/services/spec-broadcast.ts
  - server/services/spec-edit-interject.ts
  - server/services/spec-reminder.ts
  - server/services/spec-task-service.ts
  - server/services/spec-update-queue.ts
  - server/services/spec-vfs-service.ts
  - server/services/task-source/spec.ts
  - shared/spec-content-loss.ts
keywords:
  - Dynamic Spec
  - spec://
  - spec://tasks.json
  - spec://behavior_fence
  - behavior_fence
  - tasks.json
  - spec_namespaces
  - spec_namespace_files
  - spec_file_revisions
  - spec_protected_tasks
  - spec_changed
  - spec:changed
  - SPEC_PROTECTED_TASK
  - SPEC_MOVED_TO_OUTLINE
  - SPEC_IMPORT_IN_PROGRESS
  - taskReflection
  - 行为边界
  - 受保护任务
  - team-sop
  - /api/narrators/:id/spec
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 动态 Spec

每个叙述者有一个虚拟文件空间 `spec://`（Dynamic Spec）：内置 `index.md`、`tasks.json`（任务队列）、`behavior_fence`（行为边界），也可以再建 `spec://*.md` 笔记。文件按修订存库，Agent 用 Read/Write/Edit 读写，人在 Spec 面板里编辑。任务由 `tasks.json` 编译出“当前/下一个任务”，驱动续跑与提醒。

## 关键规则
- 路径：`spec://` 加相对路径，每段只许字母数字 `.` `_` `-`，总长 ≤ 240，不许空段、`.`、`..`、空白、反斜杠，不做自动纠正；含 `spec:/` 样子却不是规范 `spec://` 写法的路径（如带盘符、空白、反斜杠）一律判为畸形并报错（`lib/spec-uri.ts:normalizeSpecPath`、`assertSpecPath`）。支持 `spec://` 的工具只有 Read、Write、Edit、ExitPlanMode（`file_path`）与 Grep（`path`，可为根）；Glob、StructView、StructSed 遇到 `spec://` 报错；只检查路径字段，内容与正则里提到 URI 不算（`assertToolSpecPaths`）。
- 存储：每个叙述者一个 namespace（`spec_namespaces`），当前文件指针在 `spec_namespace_files`，每次写入新增一行 `spec_file_revisions` 并切换指针，写入按 `namespaceId:path` 串行；单文件 ≤ 200000 字符，`index.md` 不许写空；内置文件不能删除；分叉时 `forkSpecNamespace` 原子复制命名空间、文件指针与保护锁（`spec-vfs-service.ts`）。
- 写权限两条独立的轴：`agentReadonly`（Agent 的 Write/Edit 不能改）与 `uiEditable`（人能否经面板改）；`behavior_fence` 对 Agent 只读、对人可编辑；Agent 只有在一个用户回合的第一次工具调用里才有一次性写授权（`grantBehaviorFenceEdit` → `consumeBehaviorFenceEditGrant`，第一个工具调用结束即 `clear`，续跑/后台/子代理回合从不授予）（`lib/agent/tools/behavior-fence-grant.ts`、`spec-vfs-service.ts:writeSpecFile`）。第三种写者 `system` 不受这两条轴限制，只用于 outline 导入后只留插件 SOP 的围栏。
- 任务文件：`tasks.json` 只许顶层 `tasks` 数组（≤ 100 项），每项只许 `text`（≤ 1000 码点）、`status`（`todo` / `doing` / `done` / `blocked`，`pending`、`in_progress`、`completed` 等别名会被归一）、`protected: true`；写前解析校验，非法即抛错（`spec-task-service.ts:parseSpecTasksDocument`）。`compileSpecTasks` 取第一个 `doing` 为当前任务、第一个 `todo` 为下一个，有 `blocked` 则标 blocked，统计开放的受保护任务数。
- 受保护任务：`protected` 任务在 `spec_protected_tasks` 里按文本哈希留锁；写入若修改、删除、去掉保护标记或把它标成 done，且没有 `allowProtectedTaskMutation`，抛 409 `SPEC_PROTECTED_TASK`（要求先过 `taskReflection`）；检测发生在写入存储的同一事务段内（`detectProtectedMutations`、`knowledgeWriteStore.writeSpecFileRevision`）。人通过面板写（`actor: "user"`）与系统的任务晋升允许改保护任务。
- 任务晋升：续跑决策前，若没有 `doing` 且策略允许 `promoteTodo`，把第一个 `todo` 写成 `doing`（`createdBy: "system"` 的修订并发 `spec:changed`），此写入先于模式判断，所以即使最终不续跑也已落库（`task-source/spec.ts:loadCompiledSpecForContinuation`）。
- 与 outline 的分流：会话的任务后端是 outline 时，Dynamic Spec 的任务读写一律拒绝（`assertSpecWritable` / `assertSpecTasksUsed`），已迁移的会话报 `SPEC_MOVED_TO_OUTLINE`，导入进行中报 `SPEC_IMPORT_IN_PROGRESS`；唯一放行的是围栏的插件 SOP 通道（`task-source/backend.ts`）。
- 行为边界里的插件 SOP 段由 HTML 注释标记包起来（`<!-- team-sop:com.whisent.narrator-team -->` … `<!-- /… -->`），插件只替换自己的段，人写的规则保留；`splitBehaviorFence` 把围栏拆成 `own` 与 SOP 段，插件命令、outline 导入与 outline 行为视图三处共用（`behavior-fence-sop.ts`）。
- 提醒：`spec-reminder.ts` 生成结构化摘要体（`SideCarBody`），模型文本与读者行共用同一来源——没有开放任务时区分“从未建任务”与“全部完成”两种催促；任务超过 30 条（`SPEC_TASKS_REORGANIZE_THRESHOLD`）提示整理；摘要有行数预算，因为它挂在大多数工具结果后面。空围栏不注入任何内容。
- 人改 Spec 如何通知 Agent：`PUT /api/narrators/:id/spec/file` 带 `baseRevisionId` 做乐观并发（不一致返回 409 `conflict` 与当前修订号）；`notifyAgent !== false` 时，运行中的叙述者经 `interjectSpecEditAsUserMessage` 作为一条插到队首的用户消息并请求软停（连续保存只改写同一条未消费的消息，不叠加）；空闲叙述者不唤醒，改入 `spec-update-queue.ts` 的内存队列（每个叙述者最多 10 条、每条预览 2000 字符），下次用户消息或 `after_tools` 边界取走；缓冲区满或叙述者不在内存（如子代理）时也退回队列。`tasks/clear` 与 `reset` 同样通知，`reset` 恢复内置文件的默认内容。
- 变更广播：服务端写入发事件总线 `spec:changed`，各路由经 `broadcastSpecChanged` 向 WS 发 `spec_changed`（`source`：ui / tool / task_create / import / revert；`updatedBy`：user / assistant / system）。
- 内容丢失检测：旧 Spec 面板的所见即所得编辑器曾在保存时吞掉表格、HTML、图片、任务项、脚注与 front matter；`shared/spec-content-loss.ts` 纯函数地比较相邻修订，只报告、从不自动修复（`extractSpecLossItems`、`lostSpecItems`）。

## 从哪读起
- `server/services/spec-vfs-service.ts`：读写、权限轴、分叉（`specVfsService`）。
- `server/services/spec-task-service.ts`：任务解析、编译、保护锁。
- `server/routes/spec.ts`：`/api/narrators/:id/spec/{files,file,tasks,tasks/clear,reset}`，读需 read、其余需 write 权限；`frontend/lib/api/spec.ts` 是客户端。
- `server/services/spec-reminder.ts`、`spec-edit-interject.ts`、`spec-update-queue.ts`：提醒与插话。
- 测试：`spec-vfs-service.test.ts`、`spec-task-service.test.ts`、`spec-reminder.test.ts`、`spec-edit-interject.test.ts`、`lib/__tests__/spec-uri.test.ts`、`lib/agent/tools/__tests__/spec-path-boundary.test.ts`、`task-source/__tests__/spec-task-source.test.ts`。

## 改它时
- 新增内置 Spec 文件：加进 `spec-vfs-service.ts:BUILTIN_FILES`（两条权限轴要明确），并检查 `listSpecFiles` / `resetSpecNamespace`、路由的 `panelEditable` 与前端面板标签；内置文件不可删除是既定规则。
- 新增支持 `spec://` 的工具：更新 `spec-uri.ts` 的 `SPEC_FILE_TOOLS` / `assertToolSpecPaths` / `toolNamesSpecPath`，并在工具里走 `specVfsService`；`spec-path-boundary.test.ts`、`spec-path-routing.test.ts`、`spec-vfs-tools.test.ts` 会拦。
- 改任务文件格式或状态集合：`spec-task-service.ts`、`task-source/spec.ts`、前端 `RenderSpecTask` 等渲染、`spec-reminder.ts` 的摘要一起改；`spec-task-service.test.ts` 与 `spec-reminder.test.ts` 覆盖。
- 不变量：行为边界只能在用户回合首个工具调用写；保护任务的变更必须经 `taskReflection` 或人；Spec 写入必须同时留修订；outline 会话不得写任务文件。
- 新增写入口：必须发 `spec:changed`/`spec_changed` 并考虑通知 Agent 的路径（队列与插话二选一，不要每次保存都唤醒空闲叙述者）。
- 改 spec 相关表：按 CLAUDE.md 先改 `schema.ts` 再生成迁移，并核对 `data-portability.ts`。

## 相关
- [提示词与注入](prompts.md)：side-car 注入与 `InjectionCadence`
- [分叉与前缀快照](fork.md)：分叉时复制命名空间
