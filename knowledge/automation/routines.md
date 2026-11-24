---
id: automation.routines
title: 例程与可选工具
summary: manual / auto / resident 三段式、项目层覆盖。
anchors:
  - server/services/command-service.ts
  - server/services/routine-service.ts
  - shared/routine-modes.ts
  - server/routes/routines.ts
  - server/lib/builtin-routines.ts
  - server/services/tool-loading-service.ts
  - frontend/hooks/useRoutines.ts
  - frontend/routes/routines/index.tsx
keywords:
  - /api/routines
  - toolModes
  - enabledRoutines
  - disabledRoutines
  - BUILTIN_ROUTINES
  - /load
  - ToolSearch
  - global-prompt
  - tool-permissions
  - 工具模式
  - 常驻
  - 手动
  - 自动
  - 例程
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 例程与可选工具

例程是代码里内置的一份清单（`BUILTIN_ROUTINES`），分三种：`tool`（可选 Agent 工具）、`command`（斜杠命令）、`skill`（启用时落成 `SKILL.md`）。其中只有 tool 例程有三段式模式；command/skill 只有启用/禁用。

## 关键规则
- 三种模式：`manual`（不进会话工具表，会话内 `/load` 才临时加载）、`auto`（不预加载，可经 ToolSearch 按组发现并按需加载）、`resident`（新会话默认预加载）；只有 `resident` 算预加载（`shared/routine-modes.ts:isPreloadedMode`）。`auto` 已有实现：`tool-loading-service.ts:buildCandidates` 把 `auto` 的内置工具组和 MCP 服务器工具列为可加载候选。
- 模式解析：先看项目层，项目层未表态才看全局层；全局层未配置时 `defaultEnabled` 为 `resident`，否则 `manual`（`resolveEffectiveToolRoutineMode`，返回 `mode` 与 `source`）。
- 存储在 `settings.routines`（全局）和项目 `chapterSettings.routines`（项目），字段 `toolModes`；旧的 `enabledRoutines/disabledRoutines` 仍被读取并折算（enabled→`resident`，disabled→`manual`）。
- 写入同步旧列表：`resident` 进 enabled 列表，`manual` 进 disabled 列表，`auto` 两个都不进（旧读者视为“未启用”）（`applyToolRoutineMode`）。项目层 `global` 表示清除项目意见（`clearToolRoutineMode`）。
- 对 tool 例程调用 toggle 等价于设为 `resident`/`manual`（`enableRoutineGlobal`）；设置模式时必须是 tool 例程，否则拒绝（`requireToolRoutine`）。
- 启用 command 例程会写入全局命令，skill 例程写入全局技能目录；禁用时移除（`enableRoutineGlobal/disableRoutineGlobal`）。
- 路由 `/api/routines`：`GET /`、`POST /:id/toggle`、`POST /:id/mode`（值只能是 manual/auto/resident）、`/project/:projectId...`（项目 mode 额外允许 `global`，需项目 manage 权限）、`/global-prompt`（读取上限 200000 字节，写入需管理员）。
- 会话级临时装载（`narrators.enabledTools`）与此正交，由 `command-service.ts` 的 `/load <toolName>` 触发。

- 前端：`frontend/hooks/useRoutines.ts` 以查询键 `routines`、`project-routines` 缓存并乐观更新；页面 `frontend/routes/routines/index.tsx`（同目录另有 `tool-permissions.tsx`）。

## 从哪读起
- `shared/routine-modes.ts`：纯函数的模式解析与写入（无依赖，前后端共用）。
- `server/lib/builtin-routines.ts`：内置清单（本版本含 20 个 tool 类）。
- `server/services/routine-service.ts`：全局/项目状态与写入。
- `server/services/narrator-session.ts`：新会话按 resident 预加载工具（搜 `isPreloadedMode`）。

## 改它时
- 加一个内置例程：`server/lib/builtin-routines.ts` 的清单（类型 tool/command/skill、`defaultEnabled`）；`tool-loading-service.ts:buildCandidates` 决定 `auto` 的可发现范围。
- 改模式语义或存储：`shared/routine-modes.ts`（前后端共用，纯函数）、`routine-service.ts`、旧的 `enabledRoutines/disabledRoutines` 双向投射、项目 `chapterSettings.routines` 一起；`shared/routine-modes.test.ts` 守着解析与写入规则。
- 不变量：只有 `resident` 算预加载；项目层先于全局层；设置模式必须是 tool 例程；`auto` 不进旧列表。

## 相关
- [技能](skills.md)
- 注意：仓库根 CLAUDE.md 说 `auto` “预留、当前等同 manual”，与现行实现不符，以代码为准。
