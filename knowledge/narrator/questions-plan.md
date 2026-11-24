---
id: narrator.questions-plan
title: 提问与计划模式
summary: AskUserQuestion、异步提问、计划模式与审批。
anchors:
  - server/lib/agent/tools/ask-user-question.ts
  - server/services/narrator-question-service.ts
  - server/services/narrator-plan-mode.ts
  - server/lib/agent/tools/plan-mode.ts
  - server/lib/plan-file-path.ts
  - shared/question-protocol.ts
  - server/services/__tests__/narrator-question-service.test.ts
  - frontend/hooks/useAsyncQuestions.ts
  - frontend/lib/ask-in-passing-events.ts
  - server/lib/agent/question-model-input.ts
  - server/lib/agent/strip-plan-body.ts
  - server/lib/agent/tools/exit-plan-reflection.ts
  - server/lib/agent/pending-plan-reflection.ts
  - server/lib/agent/tools/question.ts
  - server/services/ask-user-question-coerce.ts
  - server/services/ask-user-question-reflection.ts
  - server/services/narrator-question-history.ts
  - server/services/plan-approval-attribution.ts
  - shared/ask-user-question-shape.ts
  - shared/plan-reference.ts
keywords:
  - AskUserQuestion
  - ExitPlanMode
  - EnterPlanMode
  - narrator_questions
  - narrator_question_events
  - async-questions
  - /api/narrators/:id/questions
  - /api/narrators/:id/suggest-answers
  - reflect-question
  - plan_reflection
  - ExitPlanConfirm
  - ExitPlanRevise
  - 计划反思
  - reflect-plan
  - planReflectionAvailable
  - 异步提问
  - 顺带提问
  - ask-in-passing
  - planMode
  - .narrafork/plans
  - Question 工具
status: draft
verified_at: 878917e97
---
# 提问与计划模式

Agent 向人提问有两档：同步（阻塞等待）和异步（不停工，答案以消息回来）。计划模式让 Agent 先只读探索、提交计划，经人批准后再动手。

## 关键规则
- `AskUserQuestion` 与 `ExitPlanMode` 属于“始终需要用户批准”的工具，与权限模式无关（`narrator-permission.ts:ALWAYS_ASK_TOOLS`）。同步提问由权限闸挂起会话，用户回答后工具以 `answers` 返回 “User answered: …”（`ask-user-question.ts:execute`）。
- 一次 1–4 个问题，每题选项 0–4 个（0 为自由输入），“Other” 由界面自动提供；单选题才支持 `preview`（schema 描述）。
- 异步提问：`async: true` 且必须带非空 `context`（上限 2KiB，`QUESTION_CONTEXT_MAX_BYTES`）；先落一行 `narrator_questions`（状态 open / answered / dismissed / withdrawn，来源 `agent_async` 或 `user_deferred`），`tool_call_id` 唯一索引保证重放不产生第二行（`narrator-question-service.ts:createAsyncQuestion`）。
- 答案回流：答案/驳回在一个同步事务内完成“条件更新状态 + 写消息 + 写历史引用”，失败则问题仍保持 open 可重试；撤回同样以 `status='open'` 为条件，先到者生效（返回 `stale`）。答案作为 `role: "user"` 的消息行经 `deliverInjection` 投递，因为模型每次请求都重放完整历史，改旧工具输出不会让正在运行的循环看到（见 [提示词与注入](prompts.md)）。
- 数量与大小：每个叙述者未答问题软上限 `ASYNC_QUESTION_SOFT_LIMIT = 20`（超出仍创建，只是提示 Agent 别再延后）；快照 64KiB、答案 16KiB、回执 80KiB、备注 2KiB（`shared/question-protocol.ts`）。`Question` 工具的 get/list/resolve/withdraw 用于压缩之后找回历史问题。
- 限制：outline 任务后端的根会话不允许 `async: true`（改用 `Ask`，子代理仍可用 async）；bot 等运行时上限拒绝提问（`assertRuntimeCanAskQuestion`，见 [Bot](bot.md)）。
- 计划模式状态：`narrators.planMode` 布尔 + `plan` trait；进入/退出在 `narratorTraitsLock` 下同时更新两者（`narrator-plan-mode.ts:enterNarratorPlanMode`、`exitNarratorPlanMode`）。EnterPlanMode 先 `prepareNarratorPlanMode` 预留计划文件身份，待对应 tool_result 成功后才 `commitPreparedEnterPlanModeResult` 提交，预留的 id 为一次性。
- 计划文件固定在工作目录下 `.narrafork/plans/plan-<id>.md`（`plan-file-path.ts:buildPlanFileRelPath`）；计划 id 由名字前缀（≤48 字节）+ 16 位随机后缀组成（`PLAN_NAME_MAX_BYTES`、`PLAN_ID_RANDOM_SUFFIX_LENGTH`）。
- `ExitPlanMode` 必须声明 `mode`：`inline`（`inline_plan` 给出全文，缺失则报错，不回退读文件）、`file`（读指定计划文件；仅宽松计划模式可指定其他路径，且必须仍在 `.narrafork/plans/` 内，含符号链接解析后）、`outline`（计划是 outline 会话任务树）。
- 批准时若带 `compactAfter`（`narrator-permission.ts` 把叙述者加入 `pendingPlanCompact`），ExitPlanMode 完成后用批准的计划文本执行 `runPlanCompact`，等于以计划作为压缩摘要开启新上下文（`narrator-session.ts` 中 `pendingPlanCompact` 分支，见 [上下文与压缩](context.md)）。

- 提问反思：`generateAskUserQuestionAnswers` 用模型根据最近的对话（只取顶层消息，最多 24000 字符）替人回答 `AskUserQuestion`，答案按问题 `header` 为键；`mode: "suggest"`（`POST /:id/suggest-answers`，给人当建议）与 `mode: "reflection"`（权限闸里无人应答时自动代答，`narrator-permission.ts`；`POST /permissions/:requestId/reflect-question` 触发、`disarm-question-reflection` 取消）两种，缺省 reflection（`ask-user-question-reflection.ts`）。入参 `coerceAskQuestions` 把模型传来的各种形状归一为 `header` + `description` + 选项，前后端共用 `shared/ask-user-question-shape.ts`；`ask-user-question-coerce.ts` 无副作用，便于单测。
- 计划批准归因：批准后的“开始执行”回合以 `role: "user"` 落库，作者按强到弱判定——带反馈文本则归反馈者；有真人批准者 ID 则归他（压过反思标记）；来源是 reflection 则标“计划反思”、无账号；都没有则是系统自动续跑（`plan-approval-attribution.ts:resolvePlanApprovalAttribution`）。
- 计划反思：spec 会话的计划由反思循环评审，工具为 `ExitPlanConfirm`、`ExitPlanConfirmAndCompact`、`ExitPlanRevise`；outline 会话改用单个评审工具（留评论而非退回），状态 running / awaiting_user / confirmed / cancelled / failed / aborted（`lib/agent/tools/exit-plan-reflection.ts`）。
- 按需计划反思：反思门没触发、计划已挂在审批卡上时，卡片上的「计划反思」按钮（`POST /permissions/:requestId/reflect-plan`）或把计划反思开关显式置为开，都可对挂起的非 outline `ExitPlanMode` 再跑一次审查，通过后以 `decidedBy: "reflection"` 自动批准（含 `confirm_compact`），要修改则按拒绝带反馈退回；无法判定则仍归人。审查不写人的待批行，运行器只在内存里（`pending-plan-reflection.ts`），重启后恢复出的请求没有按钮。完整规则见 [反思门](../security/tool-permissions/reflection.md)。
- 模型侧瘦身：文件型 `ExitPlanMode` 的计划全文在重建的模型历史中被短引用句替换，`isModelPlanReference` 等判断前后端共用，卡片遇到引用句要回退显示权威计划正文（`lib/agent/strip-plan-body.ts`、`shared/plan-reference.ts`）；AskUserQuestion 输入/回执投影给模型时只保留作者字段（`lib/agent/question-model-input.ts`）。
- 历史回退时的提问对账：回退/删除消息时按固定行程序删除对应提问事件、必要时把提问置为 withdrawn（原因 `Question creation was removed from history.`），并取消指向被删消息的缓冲收件；单次最多处理 2048 个提问、4 MiB（`narrator-question-history.ts`，由 `narrator-messages.ts` 与 `revert-history-commit.ts` 调用）。
- 异步提问路由：`/api/narrators/questions`、`/questions/all`（跨会话收件箱）、`/:id/questions`、`/:id/questions/:questionId` 及 `supplement` / `answer` / `dismiss` / `ignore`；前端 `useAsyncQuestions` 同时刷新会话内表单与全局收件箱，“顺带提问”事件走 `lib/ask-in-passing-events.ts`（start / resolved / deleted）。

## 从哪读起
- `server/lib/agent/tools/ask-user-question.ts`：同步/异步/撤回三种入口。
- `server/services/narrator-question-service.ts`：异步提问状态机。
- `server/services/narrator-plan-mode.ts`、`server/lib/agent/tools/plan-mode.ts`。
- 测试：`narrator-question-service.test.ts`、`async-question-runtime-delivery.test.ts`、`async-question-startup-recovery.test.ts`、`plan-body-integrity.test.ts`。

## 改它时
- 新增提问字段：同改 `shared/question-protocol.ts`（限额）、`shared/ask-user-question-shape.ts`（归一）、`ask-user-question.ts` 的 schema、模型投影 `question-model-input.ts` 与前端表单；`narrator-question-service.test.ts` 覆盖状态机。
- 改答案回流：必须保持“条件更新状态 + 写消息 + 写历史引用”在同一同步事务内（`async-question-runtime-delivery.test.ts`、`async-question-startup-recovery.test.ts` 覆盖）；`narrator_questions.tool_call_id` 的唯一索引保证重放幂等，别绕过。
- 改计划文件路径或模式：`plan-file-path.ts` 与 `ExitPlanMode` 的路径校验（须仍在 `.narrafork/plans/` 内）一起改，`plan-body-integrity.test.ts` 会拦。
- 新增“始终需要用户批准”的工具：加进 `narrator-permission.ts:ALWAYS_ASK_TOOLS`，并检查 bot 运行时上限（`agent-runtime/policy.ts`）是否也应拒绝。

## 相关
- [Bot 叙述者](bot.md)
- [中断与恢复](recovery.md)
- [反思门](../security/tool-permissions/reflection.md)
