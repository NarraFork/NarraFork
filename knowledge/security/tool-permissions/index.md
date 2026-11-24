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
  - frontend/components/permissions/
  - frontend/hooks/usePermissions.ts
  - frontend/lib/localize-danger-copy.ts
  - frontend/routes/routines/tool-permissions.tsx
  - server/lib/agent/tools/reflection-description.ts
  - server/lib/agent/tools/task-reflection.ts
  - server/lib/boolean-override.ts
  - server/lib/fs-secret-paths.ts
  - server/lib/robot-diagnostic-policy.ts
  - server/lib/validators/permission-rule-requests.ts
  - server/scripts/approve-all.ts
  - server/services/narrator-review-boundary.ts
  - server/services/pending-permission-visibility.ts
  - server/services/permission-rule-service.ts
  - server/services/reflection-broadcast.ts
  - shared/danger-copy.ts
  - shared/permission-policy-events.ts
  - shared/permission-rule-request.ts
keywords:
  - handlePermission
  - resolvePermissionDecision
  - permission_request
  - permission_resolved
  - permission:policy_changed
  - /api/narrators/permissions/:requestId/approve
  - narrator_whitelist_dirs
  - narrator_blacklist_dirs
  - narrator_whitelist_cmds
  - narrator_blacklist_cmds
  - /api/narrators/:id/whitelist-dirs
  - /api/narrators/:id/cmd-blacklist
  - 工具权限
  - 权限模式
  - 危险反思
  - 执行策略
  - DangerConfirm
  - DangerCancel
  - TaskReflectConfirm
  - RequestPermissionRule
  - permissionRuleAutoApprove
  - dangerReflectionOverride
  - RULE_CONFLICT
  - robotDiagnostic
  - bun run approve
status: stub
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
- 任务反思（`lib/agent/tools/task-reflection.ts`）：受保护的任务改动同样挂起一个反思门，只有 `TaskReflectConfirm`（证据至少 20 字符）与 `TaskReflectRevise` 两个 `reflectionOnly` 工具可用；用户接管后走同一个 approve/deny，allow 即确认、deny 即退回修改（`narrator-permission.ts:resolvePermissionOrDangerReflection` 末段）。`reflectionOnly` 工具每次请求都声明以保持提示缓存前缀稳定，说明文字由 `reflection-description.ts:describeReflectionOnlyTool` 统一加上「仅在对应反思门内可调用」。
- 反思门的开始/结束帧由 `services/reflection-broadcast.ts` 广播到所有观看者：子代理的门同时发给父叙述者页和子代理自己的页，避免一边一直显示运行中。`pending-permission-visibility.ts:shouldHidePendingPermission` 决定列表里谁算「等人决定」：反思仍在运行或已自行结束的不显示，只有 `awaiting_user` 或无反思的才显示。
- 危险反思的取值：`lib/boolean-override.ts` 的 `DANGER_REFLECTION_LEVEL_VALUES`（off/light/standard/strict）与叙述者覆盖值（inherit/on/及各等级）。危险说明文字服务端写英文，前端用 `shared/danger-copy.ts` 查表、`frontend/lib/localize-danger-copy.ts` 按 i18n 键显示，未知文本原样显示。
- 评审边界：`services/narrator-review-boundary.ts` 用 `jwtSecret` 做 HMAC 签名规则 id（前缀 `review-boundary:v1:`），只有签名通过且标记为服务端可信的目录黑名单行才算评审边界；外部输入里带这个前缀的 id 会被剥掉（`sanitizeUntrustedReviewBoundaryIds`）。
- 受保护路径：`lib/fs-secret-paths.ts:isSecretPlatformPath`（NarraFork 数据目录里的密钥与私有请求录制等）在判定里直接 deny；`isSecretUserPath` 另拒绝用户主目录下的 `.ssh`、`.aws`、`.gnupg`、`.kube`，两者都同时按字面路径与真实路径（符号链接解析后）判断；同一份名单也被 `routes/fs.ts` 与 git 工作区访问等复用。
- 规则存储与失效：四类规则存在 `narrator_whitelist_dirs`、`narrator_blacklist_dirs`、`narrator_whitelist_cmds`、`narrator_blacklist_cmds`，增删改 REST 在 `routes/narrators.ts` 的 `/:id/whitelist-dirs|blacklist-dirs|cmd-whitelist|cmd-blacklist` 与 `/narrators/<类型>/:ruleId`；`services/permission-rule-service.ts` 写入后触发 `permissionPolicyChanges`，先让 `executionPolicyEngine.invalidate(narratorId)`，再通知观察者，`narrator-ws.ts` 把它转成 `permission:policy_changed`（`shared/permission-policy-events.ts`，只带 id 与变更类型，不带规则内容）。同一约束冲突抛 409 `RULE_CONFLICT`。
- 预置规则：`lib/robot-diagnostic-policy.ts` 是只读命令/目录白名单预置（`ExecutionPolicyPreset = "robotDiagnostic"`，由 OAuth 客户端策略 `allowRobotDiagnosticPreset` 打开）；只收只读形式、按 token 前缀匹配，不含 `sudo`，目录规则只授 readOnly。
- 前端：规则管理页 `routes/routines/tool-permissions.tsx`（`/routines/tool-permissions`，i18n 命名空间 `routines`），规则编辑与设备目录选择在 `components/permissions/`；`hooks/usePermissions.ts` 读待审批列表，不轮询（注释称靠 WebSocket 事件触发失效，具体事件名未核实）。
- `server/scripts/approve-all.ts`（`bun run approve [--watch]`）：前端不可用时的应急脚本：直接往库里写一条管理员会话（只存令牌哈希，退出时吊销），读出 `narrator_tool_calls` 里待审批的请求，再用该令牌逐个调 `POST /api/narrators/permissions/:id/approve`。它借管理员身份批准所有请求，只用于应急。
- OAuth 任务有运行时权限约束，作为硬上限，不继承宽松计划（`handlePermission` 的 `runtimeConstraint`，`recheckFinalToolExecutionPermission` 在执行前最后复核）。

## 从哪读起
- `server/services/narrator-permission.ts:resolvePermissionDecision`（纯判定）与 `handlePermission`（挂起、持久化、广播）；文件很大，按函数名搜索。
- `server/services/execution-policy/engine.ts`、`compiler.ts`：规则合并与求值。
- 测试：`server/services/__tests__/narrator-permission-confirm.test.ts`、`permission-rule-request-service.test.ts`、`team-permission.test.ts`。

## 改它时
- 加一个权限模式：`server/db/schema.ts` 的 `permission_mode` 枚举、`lib/permission-modes.ts`、`resolvePermissionDecision` 的各模式分支、前端模式选择与 i18n 都要改；测试 `lib/__tests__/permission-modes.test.ts`、`services/__tests__/narrator-permission-confirm.test.ts`。
- 加一种规则类型或字段：`permission-rule-service.ts:normalizePermissionRuleInput`、`execution-policy/` 的 types/normalize/compiler、`shared/permission-rule-request.ts` 与 `lib/validators/permission-rule-requests.ts`、前端 `components/permissions/PermissionRuleEditor.tsx` 同步；测试 `execution-policy/__tests__/*`、`permission-rule-request-service.test.ts`、`permission-rule-runtime-cleanup.test.ts`。
- 加一个反思门或反思工具：工具需 `reflectionOnly: true` 并经 `describeReflectionOnlyTool`；生命周期帧经 `reflection-broadcast.ts`；列表可见性改 `shouldHidePendingPermission`；测试 `danger-reflection-takeover.test.ts`、`reflection-broadcast.test.ts`、`plan-task-reflection-failure.test.ts`。
- 加一个会改变工具执行权限的新入口：必须经 `handlePermission`；执行前最后复核（`recheckFinalToolExecutionPermission`）也要覆盖，测试 `services/tool-final-start-authorization.test.ts`、`permission-recovery-gate.test.ts`。
- 新增审批路由：要先 `prepareDecision` 校验叙述者 write 权限，并在派发前 `assertStillAllowed`，不要只在入口校验一次。
- 不变量：灾难性 Bash 恒 `fatal`；受保护路径与评审边界先于白名单；OAuth 运行时约束是硬上限；规则申请不能放宽继承的 deny。

## 相关
- [访问控制](../acl.md)
- [OAuth 与开放 API](../oauth-api/index.md)
- [外部进程加固](../hardening.md)
- 「未核实」：挂起中的权限请求的整体超时（项目说明称 5 分钟），本次未在代码中逐一核对。

## 下面有什么

- [审批流程](flow.md)：权限模式、待批请求、批准与拒绝（HTTP 与 WebSocket）、超时与复查。
- [反思门](reflection.md)：危险反思、任务反思、计划退出反思与评审边界。
- [规则与执行策略](rules.md)：权限规则与规则申请、执行策略、预设与行为边界。
