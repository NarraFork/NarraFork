---
id: flows.tool-call
title: 一次工具调用
summary: 模型发出工具调用、权限判断与审批、在哪执行、结果写回与广播。
anchors:
  - server/lib/agent/loop.ts
  - server/lib/agent/tool-executor.ts
  - server/lib/agent/tool-registry.ts
  - server/lib/agent/tools/index.ts
  - server/lib/agent/execution/registry.ts
  - server/services/narrator-permission.ts
  - server/services/narrator-event-handler.ts
  - server/routes/narrators.ts
  - server/websocket/narrator-ws.ts
  - frontend/hooks/useNarratorWS.ts
  - server/services/tool-edit-preview-reader.ts
  - server/services/tool-final-start-authorization.ts
  - server/services/tool-input-stream-source-worker.ts
  - server/services/tool-input-stream-source.ts
keywords:
  - 工具调用
  - 权限审批
  - permission_request
  - permission_resolved
  - tool_result
  - narrator_tool_calls
  - 工具未加载
  - 审批卡片
  - PreToolUse
status: draft
verified_at: 878917e97
---
# 一次工具调用

模型在一轮里发出 tool_use，到结果作为 tool_result 写回历史、模型进入下一轮。权限判断是执行前的必经关口，执行在本机或远程设备上。

## 路径
1. 参数流：provider 流式给出 tool_use，`loop.ts` 产出 `tool_use_chunk`；`narrator-event-handler.ts:processEvent` 在 `block_complete` 的 tool 块上经 `writeAttemptItem` 先落一行 `narrator_tool_calls`（初始状态），并广播。见 [消息存储](../narrator/messages/index.md)。
2. 分组：同一轮的调用经 `groupToolExecutions` 分成并行组与串行屏障；参数流已成形的调用可由 `selectStreamingToolExecutions` 提前启动（`shouldEagerExecuteTool`）。见 [Agent Loop](../agent/loop.md)。
3. 反思前置：`loop.ts:executeToolAfterReflections` 在进入执行器前处理 ExitPlanMode 的计划反思；反思确认则带 `preGrantedPermission` 直接执行，要人工则走普通审批。计划走到人工审批卡时，`loop.ts` 还为这次等待注册一个按需反思运行器（卡片的「计划反思」按钮经 `POST /api/narrators/permissions/:requestId/reflect-plan` 触发，开关设为 on 时自动触发），结论 confirm 则直接批准、revise 则把反馈退回模型、无法决策则保留审批卡。见 [Agent Loop](../agent/loop.md)。
4. 准入与查表：`tool-executor.ts:executeTool` 先做更新准入（`preAdmitToolExecution`），再 `toolRegistry.get(name)`；不存在、MCP 工具被禁用或未加载、可选工具未加载，都直接返回错误结果（"Tool is not loaded in this session…"），不进入权限。见 [工具体系](../agent/tools/index.md)。
5. 冻结执行目标：需要路由的工具在审批**前**解析并持久化 `ToolExecutionTarget`（设备、cwd、规范路径）；审批后返回的输入必须与冻结的目标一致，否则报错。见 [执行后端](../agent/execution.md)。
6. 权限判定：`config.permissionHandler` → `narrator-permission.ts:handlePermission`，内部 `resolvePermissionDecision` 给出 allow / deny / ask / fatal。见 [工具调用审批](../security/tool-permissions/index.md)。
7. 分支，allow：直接到步骤 10。
8. 分支，deny / fatal：执行器返回拒绝文本作为 tool_result（`isError`），跳到步骤 11。
9. 分支，ask：`handlePermission` 登记到 `pendingPermissions`，广播 `permission_request`，Promise 挂起；前端渲染审批卡片，用户经 `POST /api/narrators/permissions/:requestId/approve|deny`（`routes/narrators.ts`）或 WebSocket 决定入口，两者都调 `resolvePermissionOrDangerReflection` 解除挂起，再广播 `permission_resolved`。挂起期间执行器释放更新准入（`onAwaitingUserDecision`）。若命中危险反思，则先走反思，仅 `DangerConfirm` / `DangerCancel` 可用。
10. 执行：`PreToolUse` 钩子（失败不阻断，`blocked` 才拒绝）→ 最终准入（`acquireFinalToolExecution`，`tool_executing` 事件表示真正开始）→ `tool.execute(input, ctx)`；文件与命令类工具经执行后端在本机或远程设备上做 IO，远程目标不可用时报错而不回退本机。`PostToolUse` 钩子异步触发，不阻塞。
11. 结果整理：输出超限由 `truncateOutput` 截断（工具自己已截断的原样放行），再经 `annotateToolOutput` 加注；得到 `ToolExecResult`（输出、`isError`、`durationMs`）。
12. 回写：`loop.ts` 产出 `tool_result`；`processEvent` 先 `validateToolCallBinding` 校验，把输出与状态写进 `narrator_tool_calls` 与 tool_result 消息，再广播。工具长输出期间的 `tool_output` / `tool_progress` 只广播不落库。
13. 前端：`useNarratorWS` 收到 `permission_request`、`tool_result` 等帧，更新工具卡片与审批卡片。见 [数据获取与实时同步](../frontend/data-flow.md)、[工具卡片](../frontend/narrator-ui/tool-cards.md)。
14. 下一轮：本轮所有 tool_result 就绪后，`loop.ts` 带着它们请求模型，回到 [一轮对话](turn.md) 的步骤 9。

## 改它时
- 新增一个工具：`tools/index.ts` 注册（core 或 `OPTIONAL_TOOLS`）、`narrator-permission.ts` 里它的权限分类（`ALWAYS_ALLOW_TOOLS` / `READ_ONLY_TOOLS` / `WRITE_TOOLS` / `ALWAYS_ASK_TOOLS` 等集合）、`shared/tool-parallel-groups.ts` 里它能否并行、工具自己的 `execute`、前端的工具卡片（`frontend/components/narrator/tool-call/`）与 i18n；若是路由类（碰设备文件）还要接 `withDeviceParam` 与执行目标冻结。
- 新增权限模式或判定分支：`resolvePermissionDecision` 的顺序是语义的一部分（受保护路径与黑名单先于模式放行），同时看 `permission-modes.ts`、审批路由与前端审批卡片。
- 改审批的传输：HTTP 路由与 `narrator-ws.ts` 的决定入口都要通到 `resolvePermissionOrDangerReflection`，决定时都要重新校验写权限。
- 改 tool_result 的形状：`tool-executor.ts` 的返回、`processEvent` 的 `tool_result` 分支、`narrator_tool_calls` 列、`model-history` 对它的读取、前端卡片一起对齐。
- 改并行规则：`groupToolExecutions` 同时服务正常路径与计划重启恢复，别只改一边。

## 相关
- [一轮对话](turn.md)
- [一次文件修改与回退](file-change.md)
- [一次子代理委派](subagent.md)
