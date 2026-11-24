---
id: security.tool-permissions.flow
title: 审批流程
summary: 权限模式、判定顺序、待批请求的挂起与持久化、批准与拒绝入口（HTTP 与 WebSocket）、受保护路径、OAuth 硬上限。
anchors:
  - server/services/narrator-permission.ts
  - server/lib/permission-modes.ts
  - server/routes/narrators.ts
  - server/lib/fs-secret-paths.ts
  - server/scripts/approve-all.ts
  - frontend/hooks/usePermissions.ts
keywords:
  - /api/narrators/permissions/:requestId/approve
  - bun run approve
  - handlePermission
  - resolvePermissionDecision
  - resolveEffectiveRelaxedPlan
  - effectiveMode
  - ALWAYS_ASK_TOOLS
  - freezePermissionExecutionContext
  - prepareDecision
  - assertStillAllowed
  - permissionDecidedBy
  - permissionDecisionReason
  - pending_permission
  - permission_request
  - permission_resolved
  - runtimeConstraint
  - recheckFinalToolExecutionPermission
  - isSecretPlatformPath
  - isSecretUserPath
  - /api/narrators/permissions/:requestId/deny
  - /api/narrators/permissions/:requestId/plan
  - /api/narrators/permissions/:requestId/defer
  - /api/narrators/permissions/:requestId/reflect-plan
  - planReflectionAvailable
  - 待批权限
  - 应急批准
status: draft
verified_at: 878917e97
---
# 审批流程

Agent 每次调用工具前都经过 `narrator-permission.ts:handlePermission`：先由纯函数 `resolvePermissionDecision` 判出 allow / deny / ask / fatal，需要人决定时挂起，等用户经路由或 WebSocket 审批。这是应用层护栏，不是操作系统沙箱（`RequestPermissionRule` 工具的描述里也这样声明）。

## 关键规则
- 权限模式存在 `narrators.permission_mode`：`default`、`acceptEdits`、`bypassPermissions`、`readOnly`、`dontAsk`（`server/db/schema.ts`）。
- plan 是叙述者的 trait，不是模式：严格计划模式下有效模式降为 `readOnly`；开启宽松计划（`relaxedPlan`）则沿用原模式；`bypassPermissions` 强制宽松计划（`lib/permission-modes.ts:resolveEffectiveRelaxedPlan`，`resolvePermissionDecision` 里的 `effectiveMode`）。
- 判定顺序（`resolvePermissionDecision`）：参数/路径规格错误 → 灾难性 Bash 直接 `fatal` → 受保护路径与评审边界 deny → 命令黑名单 → 目录黑名单（优先于白名单）→ 评审只读 Bash 上限 → `.git` 内部写入复核 → 各模式。
- 各模式的处理：`bypassPermissions` 放行；`dontAsk` 拒绝所有需要询问的；`readOnly` 拒绝写；`acceptEdits` 自动放行编辑类。
- `ExitPlanMode`、`AskUserQuestion` 始终询问（`ALWAYS_ASK_TOOLS`）；异步提问和只撤回的提问不需要审批。
- 路由类工具必须带冻结的执行目标上下文，缺失或校验失败即 deny（`handlePermission` 的 `freezePermissionExecutionContext` 段）；工具调用记录有歧义或缺失也 deny。
- 权限请求记录在 `narrator_tool_calls`（含 `permissionDecidedBy`、`permissionDecisionReason`），不另设表。叙述者被中止时，待批请求按 `permissionDecidedBy: "aborted"` 记失败并 deny。
- 挂起中的请求没有整体超时：`handlePermission` 末段的 Promise 只由用户决定、策略重算或叙述者中止解除；代码注释说明等待是持久的，检查点会把它存成 `pending_permission` 续接，替换进程后按存下的输入重新提供。CLAUDE.md 里“5 分钟超时”不适用于普通权限请求；5 分钟 TTL 只属于危险确认令牌和规则申请，见 [反思门](reflection.md)、[规则与执行策略](rules.md)，问题反思的倒计时也在反思门里。
- 受保护路径：`lib/fs-secret-paths.ts:isSecretPlatformPath`（NarraFork 数据目录里的密钥与私有请求录制等）在判定里直接 deny；`isSecretUserPath` 另拒绝用户主目录下的 `.ssh`、`.aws`、`.gnupg`、`.kube`。两者都同时按字面路径与真实路径（符号链接解析后）判断；同一份名单也被 `routes/fs.ts` 与 git 工作区访问等复用。
- OAuth 任务有运行时权限约束，作为硬上限，不继承宽松计划（`handlePermission` 的 `runtimeConstraint`，`recheckFinalToolExecutionPermission` 在执行前最后复核），约束来源见 [OAuth 服务端](../oauth-api/oauth-server.md)。

## 审批入口
- HTTP：`POST /api/narrators/permissions/:requestId/{approve,deny,plan,defer,reflect-question,reflect-plan}`；每次决定前都要求对所属叙述者有 write 权限，并在决定时再校验一次（`routes/narrators.ts:prepareDecision`、`assertStillAllowed`）。
- `reflect-plan`：对已挂起的 `ExitPlanMode` 按需启动计划反思，立即返回 `started: true`，不可用时 409；审查结论经 `resolvePermission` 以 `decidedBy: "reflection"` 落到该请求，生效前再复查发起人写权限（见 [反思门](reflection.md)）。`GET /:id/permissions` 对 `ExitPlanMode` 请求附带 `planReflectionAvailable`。
- approve/deny 路由与 WebSocket 的决定入口（`websocket/narrator-ws.ts`）最终都调用 `resolvePermissionOrDangerReflection(requestId, "allow"|"deny", opts)`：请求挂在待决权限表里就按普通审批解除，挂在危险反思表里则解除反思（反思分支见 [反思门](reflection.md)）。
- 前端：`hooks/usePermissions.ts` 用 query key `["permissions", narratorId]` 读待审批列表，不轮询；注释称靠 `permission_request` / `permission_resolved` 事件触发失效，`useNarratorPanelWS.ts` 的危险反思开始回调确实会对该 key 调用 `invalidateQueries`，其他事件是否逐一覆盖未核实。
- `server/scripts/approve-all.ts`（`bun run approve [--watch]`）：前端不可用时的应急脚本。它直接往库里写一条管理员会话（只存令牌哈希，退出时吊销），读出 `narrator_tool_calls` 里待审批的请求，再用该令牌逐个调 `POST /api/narrators/permissions/:id/approve`。它借管理员身份批准所有请求，只用于应急。

## 从哪读起
- `server/services/narrator-permission.ts:resolvePermissionDecision`（纯判定）与 `handlePermission`（挂起、持久化、广播）；文件很大，按函数名搜索。
- `server/routes/narrators.ts` 里 `permissions/:requestId/*` 一组路由。
- 测试：`server/services/__tests__/narrator-permission-confirm.test.ts`、`team-permission.test.ts`。

## 改它时
- 加一个权限模式：`server/db/schema.ts` 的 `permission_mode` 枚举、`lib/permission-modes.ts`、`resolvePermissionDecision` 的各模式分支、前端模式选择与 i18n 都要改；测试 `lib/__tests__/permission-modes.test.ts`、`services/__tests__/narrator-permission-confirm.test.ts`。
- 加一个会改变工具执行权限的新入口：必须经 `handlePermission`；执行前最后复核（`recheckFinalToolExecutionPermission`）也要覆盖；测试 `services/tool-final-start-authorization.test.ts`、`permission-recovery-gate.test.ts`。
- 新增审批路由：要先 `prepareDecision` 校验叙述者 write 权限，并在派发前 `assertStillAllowed`，不要只在入口校验一次。
- 改受保护路径名单：`lib/__tests__/fs-secret-paths.test.ts`；`routes/fs.ts` 与 git 工作区访问共用这份名单，要一起看。
- 不变量：灾难性 Bash 恒 `fatal`；受保护路径与评审边界先于白名单；OAuth 运行时约束是硬上限。

## 相关
- [工具调用审批](index.md)
- [访问控制](../acl.md)
