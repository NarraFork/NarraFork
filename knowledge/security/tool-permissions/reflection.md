---
id: security.tool-permissions.reflection
title: 反思门
summary: 危险反思、任务反思、问题反思（AskUserQuestion）、按需计划反思（审批卡上的「计划反思」）、反思门的广播与可见性、评审边界。
anchors:
  - server/lib/agent/tools/danger-reflection.ts
  - server/lib/agent/tools/task-reflection.ts
  - server/lib/agent/tools/reflection-description.ts
  - server/lib/agent/pending-plan-reflection.ts
  - server/lib/agent/tools/exit-plan-reflection.ts
  - server/lib/boolean-override.ts
  - server/services/reflection-broadcast.ts
  - server/services/pending-permission-visibility.ts
  - server/services/narrator-review-boundary.ts
  - shared/danger-copy.ts
  - frontend/lib/localize-danger-copy.ts
keywords:
  - DangerConfirm
  - DangerCancel
  - TaskReflectConfirm
  - dangerReflectionOverride
  - 危险反思
  - classifyDanger
  - shouldTriggerDangerReflection
  - dangerReflectionThreshold
  - DANGER_CONFIRMATION_TTL_MS
  - DANGER_REFLECTION_LEVEL_VALUES
  - confirmDangerReflection
  - reflectionOnly
  - describeReflectionOnlyTool
  - TaskReflectRevise
  - task_reflection
  - question_reflection
  - questionReflectionEnabled
  - questionReflectionTimeoutMs
  - questionReflectionOverride
  - reflectPendingAskUserQuestion
  - reflect-question
  - awaiting_user
  - shouldHidePendingPermission
  - review-boundary:v1:
  - sanitizeUntrustedReviewBoundaryIds
  - 评审边界
  - 问题反思
  - 任务反思
  - 计划反思
  - 按需计划反思
  - /api/narrators/permissions/:requestId/reflect-plan
  - reflectPendingExitPlanMode
  - registerPendingPlanReflectionRunner
  - planReflectionAvailable
  - startAutomaticPlanReflectionForNarrator
  - planReflectionAutoApproveOverride
status: draft
verified_at: 878917e97
---
# 反思门

反思门是权限流程里“先让模型自己复核、再决定是否打扰人”的暂停点。有三种：危险反思（危险操作）、任务反思（受保护的任务改动）、问题反思（`AskUserQuestion` 自动作答）。反思期间 Agent 只能调用对应的 `reflectionOnly` 工具，用户随时可以接管，接管后走普通 approve/deny（入口见 [审批流程](flow.md)）。

## 关键规则
- 危险反思：`classifyDanger` 给操作定严重度，`shouldTriggerDangerReflection` 按等级 off/light/standard/strict（对应阈值 high/medium/low，`dangerReflectionThreshold`）决定是否暂停；叙述者可有 `dangerReflectionOverride`。
- 暂停期间 Agent 只能调用 `DangerConfirm` 或 `DangerCancel`（`reflectionOnly` 工具，`lib/agent/tools/danger-reflection.ts`）；确认令牌 TTL 5 分钟（`narrator-permission.ts:DANGER_CONFIRMATION_TTL_MS`）。没有活跃暂停时调用这两个工具只返回错误提示。
- 取值：`lib/boolean-override.ts` 的 `DANGER_REFLECTION_LEVEL_VALUES`（off/light/standard/strict）与叙述者覆盖值（inherit/on/及各等级）。
- 危险说明文字：服务端写英文，前端用 `shared/danger-copy.ts` 查表、`frontend/lib/localize-danger-copy.ts` 按 i18n 键显示，未知文本原样显示。
- 任务反思（`lib/agent/tools/task-reflection.ts`）：受保护的任务改动同样挂起一个反思门，只有 `TaskReflectConfirm`（证据至少 20 字符）与 `TaskReflectRevise` 两个 `reflectionOnly` 工具可用。用户接管后走同一个 approve/deny：allow 即确认、deny 即退回修改（`narrator-permission.ts:resolvePermissionOrDangerReflection` 末段）。状态有 running / awaiting_user / confirmed / cancelled / failed / aborted。
- 问题反思：`AskUserQuestion` 始终要问人，但在 `bypassPermissions` 且 `agent.questionReflectionEnabled`（可被叙述者的 `questionReflectionOverride` 覆盖，默认关）时，倒计时到期后由模型自动作答。倒计时取 `agent.questionReflectionTimeoutMs`，默认 300000，下限 10000（`getQuestionReflectionTimeoutMs`、`shouldScheduleQuestionReflection`）。用户也可经 `reflect-question` 路由手动触发；用户接管后自动作答会放弃（`reflectPendingAskUserQuestion`）。
- 按需计划反思（计划已挂起等人时再触发）：循环里的计划反思门在 `executeTool` 请求权限之前运行；门没触发（开关关或模式不是 `acceptEdits`/`bypassPermissions`）的 `ExitPlanMode` 会挂在审批卡上，此时循环悬在权限处理器里，只有这一栈帧持有 `AgentConfig` 与历史。所以 `loop.ts:executeToolAfterReflections` 在等待期间用 `registerPendingPlanReflectionRunner(narratorId, toolUseId, runner)` 登记一个运行器（`lib/agent/pending-plan-reflection.ts`，内存表，`hotSafe` 挂在 globalThis；注册返回的注销函数只删自己那一条），`handlePermission` 把它挂到待批请求的 `planReflection` 上。反思嵌套循环里（`config.reflectionLoop`）不登记。
  - 谁能触发：
    - 审批卡上的「计划反思」按钮 → `POST /api/narrators/permissions/:requestId/reflect-plan`；没有运行器、已在运行、不是 `ExitPlanMode`、或是 outline 计划提交（`outlinePlanSubmissionOf` 非空，outline 的评审只留评论、不自动批准）时返回 409。同属 `/permissions/:id/*` 路由组，要求对所属叙述者有 write 权限。
    - 把叙述者的计划反思开关（`PATCH /:id/reflection-overrides` 的 `planReflectionAutoApproveOverride`）置为 `on`：对该叙述者所有挂起的计划各启动一次自动反思（`startAutomaticPlanReflectionForNarrator`）。只认叙述者行上显式的 `on`，继承实例默认不触发；还要按行里当前权限模式重判 `shouldRunExitPlanModeReflection`，不满足则 `unavailable`。
  - 两条入口都立即返回（HTTP 只回 `started: true`），审查在后台跑，卡片靠 `plan_reflection_*` 帧跟进。同一请求在跑时再触发是空操作（`planReflectionRunning` 在第一个 await 前置位）。
  - 审查的对象是挂起请求自己的 `input`（卡片上显示的计划），不重新解析模型原始输入；不能自行做出结论的审查把计划交还给人，不拒绝也不失败。
  - 结论怎么落：
    - `confirm` / `confirm_compact`：`resolvePermission(..., "allow", { decidedBy: "reflection", compactAfter })`，并把 `pendingPlanApproverSource` 标为 `reflection`（让“开始执行”回合归因到计划反思）；若请求已被他人解决则撤回该标记。
    - `revise`：`resolvePermission(..., "deny", { decidedBy: "reflection", exitPlanCancelled: true })`，拒绝文案来自 `buildExitPlanReflectionDeniedToolResult`。
    - `manual`（人接管）与 `human`（无法判定）：不动请求，审批仍归人。
    - 审查抛错：同样回到 `awaiting_user`，只记日志。
  - 写不写库：按需审查不写 `narrator_tool_calls` 行（`exit-plan-reflection.ts` 的 `onDemand` 门在 `markExitPlanReflectionStatus` 里把行 id 置空）；那一行仍是人的待批审批，面板可见性与重启恢复都读它，结论只经 `resolvePermission` 落到该行。请求先被他人决定、被重处理成新的等待或叙述者中止时，`resolvePermission` 与等待结束处理会 abort 在跑的审查，门经 `discardExitPlanReflection` 丢弃：只向前端发 `plan_reflection_resolved`（`decision: "aborted"`），不写状态。判断是否仍是同一个等待用待批对象的引用，不用请求 id（重处理会以同一 id 登记新输入）。
  - 重启与恢复：运行器只在内存里、且持有挂起栈帧的闭包，进程重启后不会保留；恢复出来的待批请求没有运行器，`planReflectionAvailable` 为假，卡片不显示该按钮。恢复判定本身（`recovery-gate.ts:isRecoveredHumanPermission`）把未决的行当人的待批审批，因为按需审查从不改写它。重启后循环重进该等待时是否会重新登记运行器：未核实。
  - 权限复查：HTTP 路由与开关两处都在启动时抓住发起人的 principal，并传入 `assertStillAllowed`（`loadNarratorForAccess(narratorId, principal, "write")`）。审查要跑数分钟，结论生效前（仅 confirm / confirm_compact / revise 三种会改动请求的结论）再校验一次；失败（例如成员已被移出团队）则丢弃结论、请求仍归人，返回 `awaiting_user`。这与人手动批准时 `resolvePermissionOrDangerReflection` 的复核同一规则。
  - 可见性：`planReflectionAvailable` 只对 `ExitPlanMode` 带出：`handlePermission` 的 `permission_request` 帧、`GET /:id/permissions`、面板状态页（`narrator-panel-state.ts`）、人工注意力详情（`human-attention-service.ts`）都用 `isPendingPlanReflectionAvailable` 算；正在审查时为假。审查开始与结束都会通知注意力列表刷新。
- `reflectionOnly` 工具每次请求都声明以保持提示缓存前缀稳定，说明文字由 `reflection-description.ts:describeReflectionOnlyTool` 统一加上“仅在对应反思门内可调用”。
- 开始/结束帧由 `services/reflection-broadcast.ts` 广播到所有观看者：子代理的门同时发给父叙述者页和子代理自己的页，避免一边一直显示运行中。进度（`reflection_progress`）只广播不落库。
- 列表可见性：`pending-permission-visibility.ts:shouldHidePendingPermission` 决定谁算“等人决定”：反思仍在运行或已自行结束的不显示，只有 `awaiting_user` 或无反思的才显示。
- 评审边界：`services/narrator-review-boundary.ts` 用 `jwtSecret` 做 HMAC 签名规则 id（前缀 `review-boundary:v1:`），只有签名通过且标记为服务端可信的目录黑名单行才算评审边界；外部输入里带这个前缀的 id 会被剥掉（`sanitizeUntrustedReviewBoundaryIds`）。评审边界在判定里先于白名单，见 [审批流程](flow.md)。

## 从哪读起
- `server/lib/agent/tools/danger-reflection.ts`、`task-reflection.ts`：两组工具与状态类型。
- `server/lib/agent/pending-plan-reflection.ts`（运行器登记表）、`loop.ts:createPendingPlanReflectionRunner`、`narrator-permission.ts:reflectPendingExitPlanMode`：按需计划反思。
- `server/services/narrator-permission.ts`：按 `danger_reflection`、`reflectPendingAskUserQuestion`、`confirmDangerReflection` 搜。
- 测试：`danger-reflection-takeover.test.ts`、`reflection-broadcast.test.ts`、`plan-task-reflection-failure.test.ts`、`narrator-question-reflection-override.test.ts`、`reflection-update-gate-deadlock.test.ts`、`pending-plan-reflection-service.test.ts`（均在 `server/services/__tests__/`）；`server/lib/agent/__tests__/pending-plan-reflection.test.ts`。

## 改它时
- 加一个反思门或反思工具：工具需 `reflectionOnly: true` 并经 `describeReflectionOnlyTool`；生命周期帧经 `reflection-broadcast.ts`；列表可见性改 `shouldHidePendingPermission`；测试见上。
- 改危险等级取值：`lib/boolean-override.ts`、设置默认值、前端选择与 `shared/danger-copy.ts` 一起改。
- 新增危险说明文字：服务端写的英文文本要在 `shared/danger-copy.ts` 的精确匹配表登记一个 `dangerCopy_*` 键（`narrator` 命名空间，en / zh-CN 都要补），否则前端原样显示英文。
- 改按需计划反思：结论只能经 `resolvePermission` 落地，不得让审查直接写 `narrator_tool_calls`；任何新入口都要带 `assertStillAllowed`；改 `PendingPermission` 的 `planReflection*` 字段要同看 `narrator-session-state.ts`。
- 改评审边界：必须保持签名校验与 `sanitizeUntrustedReviewBoundaryIds`，外部输入不得自带可信边界。

## 相关
- [审批流程](flow.md)
- [规则与执行策略](rules.md)
