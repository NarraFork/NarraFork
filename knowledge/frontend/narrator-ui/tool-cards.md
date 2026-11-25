---
id: frontend.narrator-ui.tool-cards
title: 工具卡片
summary: 工具调用展示与详情、编辑差异、权限审批与提问卡片、错误请求转储。
anchors:
  - frontend/components/narrator/tool-call/
  - frontend/components/narrator/diff/
  - frontend/components/narrator/permission/
  - frontend/components/narrator/question/
  - frontend/components/narrator/ErrorRequestModal.tsx
  - frontend/components/narrator/SaveDumpModal.tsx
  - frontend/components/narrator/useErrorRequestDump.ts
  - frontend/components/narrator/error-localization.ts
  - frontend/components/narrator/pending-permissions-reconcile.ts
  - frontend/components/narrator/useNarratorAsyncQuestionSlots.ts
  - frontend/components/narrator/useToolEditNavigation.tsx
  - frontend/components/narrator/subagent-output-count-store.ts
  - shared/prefer-open-tool.ts
  - shared/tool-display-duration.ts
  - shared/tool-edit-preview.ts
  - shared/tool-parallel-groups.ts
  - shared/tool-progress.ts
  - shared/tool-row-status.ts
  - shared/tool-shimmer.ts
keywords:
  - ToolCallInspector
  - ToolCategory
  - getCategory
  - InlinePermission
  - PermButtonBar
  - AskUserQuestion
  - 异步提问
  - 顺便提问
  - ask in passing
  - 权限规则
  - ExitPlanMode
  - 请求转储
  - 错误通知
  - RetryRuleModal
  - LeakedToolCallModal
  - DiffView
status: draft
verified_at: 878917e97
---
# 工具卡片

一次工具调用在界面上的呈现：折叠行/卡片的分类与摘要、详情查看器、编辑差异、权限审批表单、提问表单，以及出错时的请求转储入口。卡片本身在消息列表里由 `vlist/measure/measure-tool-call.ts`（零 DOM 高度）和 `vlist/render/RenderToolCall.tsx`（绘制）实现，见[消息列表](message-list.md)；本节点是它们依赖的展示逻辑与对话框。

## 关键规则
- 分类（`tool-call/tool-display.ts:getCategory`）把工具名/输入映射到 `ToolCategory`（read、file、bash、search、structure、structureEdit、webSearch、webFetch、tasks、agent、await、watch、send、ask、plan、pipeline、terminal、share、transfer、recall、skill、browser、knowledge、outline、schedule、contextAsk、workspace、generic 等）；`Shell`/`Execute` 是 `Bash` 的旧别名；`getSummary` 产出折叠行摘要。
- 默认展开（`measure-tool-call.ts:computeDefaultOpen`）：
  - 有待决权限、或状态 `pending`：展开。
  - 流式中：只有 `file` 类展开。
  - 类别为 tasks/share/transfer/recall/send/pipeline/plan/knowledge/file/structureEdit：展开。
  - `await`/`bash` 且有 detail：展开。
  - 状态 `fail`：展开。其余折叠。
- LOD 对展开的影响见 `resolveToolCallOpened`：`lodExempt`/`lodUserOverride` 恒展开；`preferOpen` 卡片（提问等）除非用户显式折叠否则展开；L5 除非 `userCollapsed` 否则展开；L4 仅最近 run-segment 用默认态；L3 及以下折叠。
- 详情查看器 `ToolCallInspector` 只在需要时懒加载（`tool-call-inspector-host.tsx`）：虚拟行出视口会卸载，所以列表挂一个宿主，行调 `openHostedToolCallInspector`；无宿主时返回 `false` 由行自己兜底。JSON 预览上限 80000 字符。
- 编辑差异（`tool-call/tool-edit-diff.ts:buildToolEditDiff`）有界：新旧文本合计 >2MB 返回 `unavailable`；`diff` 库 75ms 超时、`maxEditLength` 10000；行数上限 5000、累计字符上限 240000 时标记 `truncated`；上下文 3 行。
- 工具文件目标只信持久化的执行事实（`tool-file-target.ts:toolFileTarget`）：无 `deviceId` 返回 null，输入/输出文本不作授权依据；重试/COW 行不得借用别的行的执行身份（`toolExecutionFallback`）。接收文件导航的面板不是文件授权者（`useToolFileNavigation`）。
- 权限审批（`permission/InlinePermission.tsx`）：
  - 能力不支持（`useNarratorPermissionsCapability` 的 `approveDeny` 为假）或 `readOnly`：只读展示。
  - 决策回调 `onDecision(requestId, "allow"|"deny", feedback?, compactAfter?, updatedPlan?)`；ExitPlanMode 且带反馈文本的允许先弹确认，选“修改”则按 deny 发送。
  - 草稿存 session-store 的 `permission-draft`，决策后清除。
  - 「计划反思」按钮：`shouldShowPlanReflectButton` 决定是否显示，要求同时满足：有 `onPlanReflect` 回调、`ExitPlanMode`、服务端标了 `planReflectionAvailable`、不是 outline 计划审批（`isOutlinePlanApproval`）、没在编辑、计划没被人改过（改过则审查读到的仍是原提交）。点击调 `onPlanReflect(permission.id)`，回调经 `vlist-permission-bridge` 与全局收件箱（`GlobalQuestionInbox` 的 `api.reflectPlan`）传入。
  - 同一表单承载提问（`onQuestionSubmit/Reflect/Deny/Defer`），Defer 把阻塞的提问转入异步收件箱。
  - 表单交互性强，vlist 不做零 DOM 副本，而是经 `vlist-permission-bridge` 挂真实组件。
- 按钮条键盘规则（`PermButtonBar.tsx`）：⏎ 高亮与浏览器焦点保持在同一个按钮上；Enter 在活动条上执行高亮决策；焦点在别处自己拥有 Enter 的控件或有模态框时隐藏提示。
- 权限规则回执只认输出里 `status` 为 `applied`/`alreadyExists`、`scope` 为 `narrator` 且带 requestId/ruleId/deviceId 的结果，字符串输出超 32000 字符直接忽略（`PermissionRuleResultNotice.tsx:readPermissionRuleReceipt`）；规则请求视图只做展示，权限以服务端冻结的提案为准（`permission-rule-request-view.ts`）。
- 待决权限集合更新用结构共享的深比较（`pending-permissions-reconcile.ts`），整份 JSON 都参与比较，不用字段白名单。
- 提问：`AskUserQuestionBanner`（同步提问）、`AsyncQuestionDetail`/`GlobalQuestionInbox`（异步提问与统一人工决策中心；列表只带摘要，展开行才持有表单）、`AskInPassingCard`（顺便提问）；历史回执只读（`AsyncQuestionHistoricalSnapshot`）。
- 顺便提问的答案是独立的只读子叙述者：有 dock 时在聊天旁开面板，没有 dock（移动页、工作区预览）才导航（`ask-in-passing-open-target.ts`）。
- 错误请求转储（`useErrorRequestDump.ts:downloadErrorRequestDump`）：先取详情并校验 narratorId/requestId 一致；已保存的录制只有恰好含这一个请求才复用，否则只为该请求保存一份，不会下载整个窗口或别的请求。`LeakedToolCallModal` 提供流式 XML 工具调用泄漏的证据下载。

## 从哪读起
- `tool-call/tool-display.ts`：分类、颜色、摘要。
- `tool-call/ToolCallInspector.tsx`、`tool-call-inspector-host.tsx`：详情。
- `permission/InlinePermission.tsx`、`question/AskUserQuestionBanner.tsx`：审批与提问表单。
- `error-localization.ts`：把提供商错误文本映射为本地化提示。

## 改它时
- 新增工具类别：`ToolCategory`、`getCategory`/`getCategoryColor`/`getSummary`，再看 `measure-tool-call.ts`（`computeDefaultOpen` 自动展开清单）与 `vlist/render/category-icons.tsx`、`category-chip.tsx`；`every-call-addressable.guard.test.ts` 要求每个 LOD 下调用可寻址。
- 动 `InlinePermission` 的表单高度要同步 `resolvePermissionFormReserve` 与 `vlist-permission-prediction.ts`，否则行高会在 paint 后变化（`vlist-stable-height.guard.test.ts`）。
- 动提问字段名要同步 `question/async-question-questions.ts`（旧 `question`/`label` 与新 header/description 两种形状）。

## 相关
- [消息列表](message-list.md)
- [输入框与交互](composer.md)
- [会话界面总览](index.md)
