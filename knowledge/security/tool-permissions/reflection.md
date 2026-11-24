---
id: security.tool-permissions.reflection
title: 反思门
summary: 危险反思、任务反思、问题反思（AskUserQuestion）、反思门的广播与可见性、评审边界。
anchors:
  - server/lib/agent/tools/danger-reflection.ts
  - server/lib/agent/tools/task-reflection.ts
  - server/lib/agent/tools/reflection-description.ts
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
status: draft
verified_at: 776dbf07e
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
- `reflectionOnly` 工具每次请求都声明以保持提示缓存前缀稳定，说明文字由 `reflection-description.ts:describeReflectionOnlyTool` 统一加上“仅在对应反思门内可调用”。
- 开始/结束帧由 `services/reflection-broadcast.ts` 广播到所有观看者：子代理的门同时发给父叙述者页和子代理自己的页，避免一边一直显示运行中。进度（`reflection_progress`）只广播不落库。
- 列表可见性：`pending-permission-visibility.ts:shouldHidePendingPermission` 决定谁算“等人决定”：反思仍在运行或已自行结束的不显示，只有 `awaiting_user` 或无反思的才显示。
- 评审边界：`services/narrator-review-boundary.ts` 用 `jwtSecret` 做 HMAC 签名规则 id（前缀 `review-boundary:v1:`），只有签名通过且标记为服务端可信的目录黑名单行才算评审边界；外部输入里带这个前缀的 id 会被剥掉（`sanitizeUntrustedReviewBoundaryIds`）。评审边界在判定里先于白名单，见 [审批流程](flow.md)。

## 从哪读起
- `server/lib/agent/tools/danger-reflection.ts`、`task-reflection.ts`：两组工具与状态类型。
- `server/services/narrator-permission.ts`：按 `danger_reflection`、`reflectPendingAskUserQuestion`、`confirmDangerReflection` 搜。
- 测试：`danger-reflection-takeover.test.ts`、`reflection-broadcast.test.ts`、`plan-task-reflection-failure.test.ts`、`narrator-question-reflection-override.test.ts`、`reflection-update-gate-deadlock.test.ts`（均在 `server/services/__tests__/`）。

## 改它时
- 加一个反思门或反思工具：工具需 `reflectionOnly: true` 并经 `describeReflectionOnlyTool`；生命周期帧经 `reflection-broadcast.ts`；列表可见性改 `shouldHidePendingPermission`；测试见上。
- 改危险等级取值：`lib/boolean-override.ts`、设置默认值、前端选择与 `shared/danger-copy.ts` 一起改。
- 新增危险说明文字：服务端写的英文文本要在 `shared/danger-copy.ts` 的精确匹配表登记一个 `dangerCopy_*` 键（`narrator` 命名空间，en / zh-CN 都要补），否则前端原样显示英文。
- 改评审边界：必须保持签名校验与 `sanitizeUntrustedReviewBoundaryIds`，外部输入不得自带可信边界。

## 相关
- [审批流程](flow.md)
- [规则与执行策略](rules.md)
