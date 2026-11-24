---
id: security.tool-permissions.rules
title: 规则与执行策略
summary: 四类权限规则的存储与失效、执行策略的合并与目标匹配、规则申请工具、预置规则、规则管理页。
anchors:
  - server/services/execution-policy/
  - server/services/permission-rule-service.ts
  - server/services/permission-rule-request-service.ts
  - server/lib/agent/tools/request-permission-rule.ts
  - server/lib/validators/permission-rule-requests.ts
  - server/lib/robot-diagnostic-policy.ts
  - shared/permission-policy-events.ts
  - shared/permission-rule-request.ts
  - frontend/components/permissions/
  - frontend/routes/routines/tool-permissions.tsx
keywords:
  - narrator_whitelist_dirs
  - narrator_blacklist_dirs
  - narrator_whitelist_cmds
  - narrator_blacklist_cmds
  - permission:policy_changed
  - /api/narrators/:id/cmd-blacklist
  - RULE_CONFLICT
  - RequestPermissionRule
  - permissionRuleAutoApprove
  - robotDiagnostic
  - 执行策略
  - compileExecutionPolicy
  - ExecutionPolicyRepository
  - executionPolicyEngine
  - pathFlavor
  - RuleTargetSelector
  - oauthGroup
  - permissionPolicyChanges
  - normalizePermissionRuleInput
  - PERMISSION_RULE_REQUEST_TTL_MS
  - ExecutionPolicyPreset
  - allowRobotDiagnosticPreset
  - registerExecutionPolicyPendingReprocessor
  - /api/narrators/:id/whitelist-dirs
  - /api/narrators/:id/blacklist-dirs
  - /api/narrators/:id/cmd-whitelist
  - /api/narrators/:id/cmd-blacklist
  - 目录白名单
  - 命令黑名单
  - 规则申请
  - /routines/tool-permissions
status: draft
verified_at: 776dbf07e
---
# 规则与执行策略

判定的“数据面”：目录与命令的白/黑名单怎么存、怎么合并成一份编译后的执行策略、怎么在改动后失效，以及 Agent 如何自己申请一条规则。判定顺序本身在 [审批流程](flow.md)。

## 关键规则
- 规则存储：四类规则存在 `narrator_whitelist_dirs`、`narrator_blacklist_dirs`、`narrator_whitelist_cmds`、`narrator_blacklist_cmds`。增删改 REST 在 `routes/narrators.ts` 的 `/:id/whitelist-dirs|blacklist-dirs|cmd-whitelist|cmd-blacklist` 与 `/narrators/<类型>/:ruleId`。
- 执行策略 `services/execution-policy/`：规则分目录白/黑名单与命令白/黑名单，来源 `global` / `project` / `narrator`（`PermissionRuleSource`），带目标选择器 `all` / `host` / `device` / `oauthGroup`（`selector.ts`，老数据的 `deviceScope` 由 `selectorFromLegacyDeviceScope` 转换）。
- 编译：`compileExecutionPolicy` 只保留启用、目标匹配且路径文法（`pathFlavor`）与目标一致的规则，所以 Windows 规则不能授权 POSIX 目标。普通叙述者的 `deviceClass` 为 `null`，匹配不到 `oauthGroup` 选择器。
- 读取：`ExecutionPolicyRepository.load`（读 worker，需已提交的文件库）；`engine.ts` 按叙述者缓存加载与编译结果，缓存项带设置版本，并在最后一个等待者离开时取消共享的加载。
- 写入后失效：`permission-rule-service.ts` 写入后触发 `permissionPolicyChanges`，先让 `executionPolicyEngine.invalidate(narratorId)`，再通知观察者；`narrator-ws.ts` 把它转成 `permission:policy_changed`（`shared/permission-policy-events.ts`，只带 id 与变更类型，不带规则内容）。同一约束冲突抛 409 `RULE_CONFLICT`。
- 策略变化后重算待批请求：`execution-policy/events.ts` 把受影响的叙述者合并到微任务里，交给 `registerExecutionPolicyPendingReprocessor` 登记的重算器处理挂起中的请求；单个叙述者重算失败只记日志，不影响其他。
- 规则申请：`RequestPermissionRule` 只能为本叙述者新增一条启用的规则（scope 固定 narrator，四种 ruleType，必须给 reason），不能改删规则、不能选全部设备、不能覆盖继承的 deny、受保护路径、灾难性命令、评审与 OAuth 上限。
- 申请的批准：默认需人工批准；仅当管理员启用 `permissionRuleAutoApprove` 且处于 `bypassPermissions` 时可经严格反思自动通过；请求 TTL 300 秒（`permission-rule-request-service.ts:PERMISSION_RULE_REQUEST_TTL_MS`）。请求和结果的形状在 `shared/permission-rule-request.ts` 与 `lib/validators/permission-rule-requests.ts`。
- 预置规则：`lib/robot-diagnostic-policy.ts` 是只读命令/目录白名单预置（`ExecutionPolicyPreset = "robotDiagnostic"`，由 OAuth 客户端策略 `allowRobotDiagnosticPreset` 打开）；只收只读形式、按 token 前缀匹配，不含 `sudo`，目录规则只授 `readOnly`。`engine.ts` 里按 `ExecutionPolicyPreset` 取出预置规则集（目前只有 `robotDiagnostic`）。
- 前端：规则管理页 `routes/routines/tool-permissions.tsx`（`/routines/tool-permissions`，i18n 命名空间 `routines`）；规则编辑与设备目录选择在 `components/permissions/`（`PermissionRuleEditor`、`RuleTargetSelector`、`RemoteDirectoryBrowser` 等）。

## 从哪读起
- `server/services/execution-policy/engine.ts`、`compiler.ts`：规则合并与求值；`types.ts` 是规则与目标的类型。
- `server/services/permission-rule-service.ts`：增删改与失效事件。
- 测试：`execution-policy/__tests__/*`、`permission-rule-request-service.test.ts`、`permission-rule-runtime-cleanup.test.ts`；`lib/__tests__/robot-diagnostic-policy.test.ts`。

## 改它时
- 加一种规则类型或字段：`permission-rule-service.ts:normalizePermissionRuleInput`、`execution-policy/` 的 types/normalize/compiler、`shared/permission-rule-request.ts` 与 `lib/validators/permission-rule-requests.ts`、前端 `components/permissions/PermissionRuleEditor.tsx` 同步；测试见上。
- 加一种目标选择器：`execution-policy/types.ts`、`selector.ts`、编译器匹配、前端 `RuleTargetSelector.tsx`，旧数据转换要兼容。
- 改规则后必须走 `permissionPolicyChanges`，否则引擎缓存与挂起请求不会刷新；`narrator-ws.ts` 的转发与 `shared/permission-policy-events.ts` 要同步。
- 改预置：只收只读形式，改动后看 `robot-diagnostic-policy.test.ts` 与 `robot-diagnostic-reflection.test.ts`。
- 不变量：规则申请不能放宽继承的 deny；目录黑名单优先于白名单；Windows 规则不能授权 POSIX 目标。

## 相关
- [审批流程](flow.md)
- [反思门](reflection.md)
- [OAuth 服务端](../oauth-api/oauth-server.md)（预置规则的开关来源）
