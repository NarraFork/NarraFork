---
id: security.tool-permissions
title: 工具调用审批
summary: 权限请求流程、模式（readOnly/dontAsk/plan…）、危险反思、执行策略、规则申请。
anchors:
  - server/services/narrator-permission.ts
  - server/services/execution-policy/
  - server/services/permission-rule-request-service.ts
  - server/lib/agent/tools/danger-reflection.ts
  - server/lib/agent/tools/request-permission-rule.ts
  - server/lib/permission-modes.ts
  - server/routes/narrators.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 工具调用审批

Agent 每次调用工具前都经过 `handlePermission`：先由纯函数 `resolvePermissionDecision` 判出 allow / deny / ask / fatal，需要人决定时挂起，等用户经路由审批。这是应用层护栏，不是操作系统沙箱（`RequestPermissionRule` 工具的描述里也这样声明）。

## 关键规则
- 权限模式存在 `narrators.permission_mode`：`default`、`acceptEdits`、`bypassPermissions`、`readOnly`、`dontAsk`（`server/db/schema.ts`）。plan 是叙述者的 trait：严格计划模式下有效模式降为 `readOnly`，开启宽松计划（`relaxedPlan`）则沿用原模式；`bypassPermissions` 强制宽松计划（`lib/permission-modes.ts:resolveEffectiveRelaxedPlan`，`narrator-permission.ts:resolvePermissionDecision` 里的 `effectiveMode`）。
- 判定顺序（`resolvePermissionDecision`）：参数/路径规格错误 → 灾难性 Bash 直接 `fatal` → 受保护路径与评审边界 deny → 命令黑名单 → 目录黑名单（优先于白名单）→ 评审只读 Bash 上限 → `.git` 内部写入复核 → 各模式：`bypassPermissions` 放行、`dontAsk` 拒绝所有需要询问的、`readOnly` 拒绝写、`acceptEdits` 自动放行编辑类。`ExitPlanMode`、`AskUserQuestion` 始终询问（`ALWAYS_ASK_TOOLS`），异步提问和只撤回的提问不需要审批。
- 路由类工具必须带冻结的执行目标上下文，缺失或校验失败即 deny（`handlePermission` 的 `freezePermissionExecutionContext` 段）；工具调用记录有歧义或缺失也 deny。权限请求记录在 `narrator_tool_calls`（含 `permissionDecidedBy`、`permissionDecisionReason`），不另设表。
- 审批入口 `POST /api/narrators/permissions/:requestId/{approve,deny,plan,defer,reflect-question}`；每次决定前都要求对所属叙述者有 write 权限，并在决定时再校验一次（`routes/narrators.ts:prepareDecision`，`assertStillAllowed`）。approve/deny 路由（`routes/narrators.ts`）与 WebSocket 的决定入口（`websocket/narrator-ws.ts`）最终都调用 `narrator-permission.ts:resolvePermissionOrDangerReflection(requestId, "allow"|"deny", opts)`：请求挂在待决权限表里就按普通审批解除，挂在危险反思表里则解除反思。
- 执行策略 `services/execution-policy/`：规则分目录白/黑名单与命令白/黑名单，来源 global/project/narrator，带目标选择器（all/host/device/oauthGroup）；`compileExecutionPolicy` 只保留启用、目标匹配且路径文法（pathFlavor）与目标一致的规则，Windows 规则不能授权 POSIX 目标。策略读取走 `ExecutionPolicyRepository.load`（读 worker，需已提交的文件库）。
- 危险反思：`classifyDanger` 给操作定严重度，`shouldTriggerDangerReflection` 按等级 off/light/standard/strict（对应阈值 high/medium/low，`dangerReflectionThreshold`）决定是否暂停；暂停期间 Agent 只能调用 `DangerConfirm` 或 `DangerCancel`（`reflectionOnly` 工具），确认令牌 TTL 5 分钟（`DANGER_CONFIRMATION_TTL_MS`）。叙述者可有 `dangerReflectionOverride`。
- 规则申请：`RequestPermissionRule` 只能为本叙述者新增一条启用的规则（scope 固定 narrator，四种 ruleType，必须给 reason），不能改删规则、不能选全部设备、不能覆盖继承的 deny、受保护路径、灾难性命令、评审与 OAuth 上限；默认需人工批准，仅当管理员启用 `permissionRuleAutoApprove` 且处于 `bypassPermissions` 时可经严格反思自动通过；请求 TTL 300 秒（`permission-rule-request-service.ts:PERMISSION_RULE_REQUEST_TTL_MS`）。
- OAuth 任务有运行时权限约束，作为硬上限，不继承宽松计划（`handlePermission` 的 `runtimeConstraint`，`recheckFinalToolExecutionPermission` 在执行前最后复核）。

## 从哪读起
- `server/services/narrator-permission.ts:resolvePermissionDecision`（纯判定）与 `handlePermission`（挂起、持久化、广播）；文件很大，按函数名搜索。
- `server/services/execution-policy/engine.ts`、`compiler.ts`：规则合并与求值。
- 测试：`server/services/__tests__/narrator-permission-confirm.test.ts`、`permission-rule-request-service.test.ts`、`team-permission.test.ts`。

## 相关
- [访问控制](acl.md)
- [OAuth 与开放 API](oauth-api.md)
- [外部进程加固](hardening.md)
- 「未核实」：挂起中的权限请求的整体超时（项目说明称 5 分钟），本次未在代码中逐一核对。
