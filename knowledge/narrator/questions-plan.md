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
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
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

## 从哪读起
- `server/lib/agent/tools/ask-user-question.ts`：同步/异步/撤回三种入口。
- `server/services/narrator-question-service.ts`：异步提问状态机。
- `server/services/narrator-plan-mode.ts`、`server/lib/agent/tools/plan-mode.ts`。
- 测试：`narrator-question-service.test.ts`、`async-question-runtime-delivery.test.ts`、`async-question-startup-recovery.test.ts`、`plan-body-integrity.test.ts`。

## 相关
- [Bot 叙述者](bot.md)
- [中断与恢复](recovery.md)
