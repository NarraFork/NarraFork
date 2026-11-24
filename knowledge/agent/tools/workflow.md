---
id: agent.tools.workflow
title: 流程与协作工具
summary: 计划模式、定时任务、技能、知识包、团队、worktree 与设备切换、回忆、生图。
anchors:
  - server/lib/agent/tools/plan-mode.ts
  - server/lib/agent/tools/scheduled-task.ts
  - server/lib/agent/tools/scheduled-task-actions.ts
  - server/lib/agent/tools/skill.ts
  - server/lib/agent/tools/pack.ts
  - server/lib/agent/tools/team.ts
  - server/lib/agent/tools/worktree.ts
  - server/lib/agent/tools/switch-device.ts
  - server/lib/agent/tools/recall.ts
  - server/lib/agent/tools/image-gen.ts
  - server/services/narrator-permission.ts
  - server/lib/agent/image-generation-api.ts
  - server/lib/agent/image-generation-response-protocol.ts
  - server/lib/agent/image-generation-response-worker.ts
  - server/lib/agent/image-generation-response.ts
  - server/lib/agent/image-generation.ts
  - server/lib/agent/recall-tool-summary.ts
  - server/lib/agent/tools/switch-working-directory.ts
  - server/lib/agent/tools/working-directory-recovery.ts
  - server/lib/validators/workspace-context.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 流程与协作工具

让会话自己组织工作的工具：先规划再动手、定时或委派、加载技能与资源包、换目录和设备、回看历史、生成图片。它们大多不碰文件，权限判定集中在 `services/narrator-permission.ts`，不在工具文件里。

## 关键规则
- 计划模式（`plan-mode.ts`）：`EnterPlanMode` 带可选 `plan_name`，计划文件落在工作目录 `.narrafork/plans/`（`lib/plan-file-path.ts:PLAN_DIR_REL`）；outline 会话改在会话空间里建或恢复计划根，不写文件（`services/outline-plan-mode`）。
- `ExitPlanMode` 必填 `mode`：`inline`、`file`、`outline`。声明 `inline` 却无正文即报错，不会去读计划文件；`inline` 还要 `settings.agent.planModeAllowInlinePlan` 开启，内容像路径引用也不算正文。严格计划模式下已有计划文件时拒绝 inline 提交；只有宽松计划模式才采用 `plan_file_path`。缺 `mode` 的旧调用退回按字段推断（`narrator-permission.ts:resolveExitPlanModeInputWithBackend`）。`allowedPrompts` 已退役，不授予任何权限。
- `ScheduledTask`：actions 为 list/get/create/update/enable/disable/delete/run_now/runs，`runs` 单页最多 50 条、默认 10；create 必填 name/cronExpr/prompt，校验 cron 与项目上下文，任务以当前用户身份创建。读动作只有 list/get/runs，其余一律视为写：判定在 `narrator-permission.ts`，位于 bypassPermissions 快捷路径之上，所以绕过模式也要确认，readOnly/dontAsk 直接拒绝。
- `Skill`：按名字（`skill` 或 `name`）加载技能全文，返回 `<skill_content>`、技能目录与附带文件列表；被 trait 屏蔽（`blockedSkills`）的技能报错。可用技能清单以 `<available_skills>` 注入提示词，不含 disabled 与 `allowImplicitInvocation: false` 的技能；清单缓存按技能上下文键存放，会话创建时预热。
- 知识包 `PackList`/`PackActivate`/`PackDeactivate`：激活把包解压到隔离目录并作为读写白名单登记，与激活记录在同一次存储操作里完成；`settings.knowledge.packActivateRequiresPermission`（默认 true）为真时激活要用户批准。停用删除目录并撤销白名单，没激活也安全。
- `Team`：仅团队协调者会话可见（`agent-runtime/orchestrator.ts` 过滤）。actions 为 work.list/create/review/ready/sync/cancel、brief、checkin、cleanup、decision。权限逐动作判定，位于绕过与 dontAsk 快捷路径之上：读动作放行；`cleanup` 删除目录，永远要人批准，readOnly、dontAsk、计划模式下直接拒绝；其余写动作在 readOnly 下拒绝，其他模式放行（审查只读会话另有拦截，未逐项核实）。
- worktree：当前面向模型的是 `ListWorktrees`、`CreateWorktree`（新分支）、`AttachWorktree`（已有分支）、`GetWorktreeOperation`；旧的 `Worktree` 工具 `isAvailable` 恒为 false，只保留历史执行与恢复。创建返回 operationId，结果未知时只能用 `GetWorktreeOperation` 对账，不可重建或清理；`switchToWorktree` 可顺带切换工作目录，成功切换会结束当前这一轮。
- `SwitchDevice`：改变文件与命令工具的默认执行设备，未知设备或离线设备报错；运行策略禁止本机执行时拒绝切到 `local`；设备还没有工作目录时拒绝，并指向 `SwitchWorkingDirectory`。
- `Recall`：默认只搜索与读取当前叙述者；`all_narrators: true` 跨全部叙述者，权限层要求批准（bypass 模式直接放行）。search 默认 20 条、上限 50，单次最多 10 个查询；读取默认 20 条、上限 50；搜索走搜索端口，会话读取走 SQLite Worker 快照。
- `ImageGen`：必须显式给出生图模型 ID，不会用对话模型替代；提供商需实现 `generateImage`。已付费的响应在本地处理失败时，仅传 `response_id` 恢复，不会再发起生成请求。

## 从哪读起
- `server/lib/agent/tools/index.ts`：这些工具属于 core 还是 optional。
- `server/services/narrator-permission.ts`：`ScheduledTask`、`Team`、`Recall` 的判定分支。
- 测试：`lib/agent/tools/__tests__/scheduled-task.test.ts`、`switch-device.test.ts`、`worktree-intent.test.ts`、`image-gen.test.ts`

## 相关
- [工具体系](index.md)
- [管理工具](admin.md)
- [子代理](../subagents.md)
