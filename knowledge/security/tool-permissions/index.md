---
id: security.tool-permissions
title: 工具调用审批
summary: 权限请求流程、模式（readOnly/dontAsk/plan…）、危险反思、执行策略、规则申请。
anchors:
  - server/services/narrator-permission.ts
  - server/lib/permission-modes.ts
keywords:
  - 工具权限
  - 权限模式
  - 危险反思
  - 执行策略
  - 工具审批
  - 全部允许
  - bypassPermissions
  - permission_request
status: draft
verified_at: 878917e97
---
# 工具调用审批

Agent 每次调用工具前都经过 `narrator-permission.ts:handlePermission`：先由纯函数 `resolvePermissionDecision` 判出 allow / deny / ask / fatal，需要人决定时挂起，等用户审批。这是应用层护栏，不是操作系统沙箱（`RequestPermissionRule` 工具的描述里也这样声明）。

## 由哪几部分组成
- **审批流程**：权限模式（`default`、`acceptEdits`、`bypassPermissions`、`readOnly`、`dontAsk`；plan 是 trait，不是模式）与判定顺序；请求挂起后写进 `narrator_tool_calls`（不另设表）；用户经 HTTP 路由或 WebSocket 批准/拒绝；受保护路径和 OAuth 硬上限也在这条线上。
- **规则与执行策略**：目录/命令的白黑名单（来源 global/project/narrator，带目标选择器）如何存储、编译、改动后失效；Agent 用 `RequestPermissionRule` 为自己申请规则；预置规则；规则管理页。
- **反思门**：把“先让模型自己复核再打扰人”做成暂停点，有危险反思、任务反思、问题反思三种，另含评审边界；挂在审批卡上的 `ExitPlanMode` 还可按需触发计划反思（「计划反思」按钮）。

## 怎么配合
1. 工具调用进入 `handlePermission`，`resolvePermissionDecision` 读取【规则与执行策略】编译出的策略，按固定顺序判定（灾难性命令恒 `fatal`，受保护路径与评审边界先于白名单，目录黑名单先于白名单，然后才是各模式）。
2. 操作达到危险反思阈值、属于受保护的任务改动、或是 `AskUserQuestion` 时，进入对应的【反思门】；用户可随时接管，接管后落回同一个 approve/deny。
3. 请求挂起，等人经【审批流程】里的入口决定；决定前后都要重校验叙述者 write 权限。
4. 规则被改（包括 Agent 申请被批准）后，策略缓存失效并重算已挂起的请求，前端收到 `permission:policy_changed`。
5. OAuth 外部任务带运行时约束，作为硬上限，不被宽松计划或规则放宽。

## 读哪一篇
- “为什么这个调用被拒/被问”“有哪些模式”“批准接口在哪”“请求有没有超时”→ [审批流程](flow.md)。
- “怎么加一条白名单”“规则为什么没生效”“Agent 能不能改自己的权限”“robotDiagnostic 预置”→ [规则与执行策略](rules.md)。
- “计划反思按钮”“按需计划反思”“开关打开后挂起的计划”→ [反思门](reflection.md)。
- “DangerConfirm 是什么”“危险等级怎么配”“AskUserQuestion 自动作答”“评审边界”→ [反思门](reflection.md)。

## 不变量
- 灾难性 Bash 恒 `fatal`；受保护路径与评审边界先于白名单；OAuth 运行时约束是硬上限；规则申请不能放宽继承的 deny。
- 需要新增会改变工具执行权限的入口，必须经 `handlePermission`，执行前最后复核（`recheckFinalToolExecutionPermission`）也要覆盖。

## 相关
- [访问控制](../acl.md)
- [OAuth 与开放 API](../oauth-api/index.md)
- [外部进程加固](../hardening.md)

## 下面有什么

- [审批流程](flow.md)：权限模式、判定顺序、待批请求的挂起与持久化、批准与拒绝入口（HTTP 与 WebSocket）、受保护路径、OAuth 硬上限。
- [反思门](reflection.md)：危险反思、任务反思、问题反思（AskUserQuestion）、反思门的广播与可见性、评审边界。
- [规则与执行策略](rules.md)：四类权限规则的存储与失效、执行策略的合并与目标匹配、规则申请工具、预置规则、规则管理页。
