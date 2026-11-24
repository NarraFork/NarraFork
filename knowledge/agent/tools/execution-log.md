---
id: agent.tools.execution-log
title: 工具执行日志
summary: 管理员对 narrator_tool_calls 的全局只读视图：游标分页、过滤、凭证脱敏与设置页展示。
anchors:
  - frontend/components/execution-log/
  - frontend/lib/execution-log-api.ts
  - frontend/lib/execution-log-cursor-window.ts
  - frontend/routes/settings/execution-log.tsx
  - frontend/types/execution-log.ts
  - server/lib/execution-log-cursor.ts
  - server/lib/execution-log-redaction.ts
  - server/routes/execution-log.ts
  - server/services/execution-log-service.ts
keywords:
  - 执行日志
  - execution_log
  - /api/execution-log
  - /settings/execution-log
  - narrator_tool_calls
  - 游标分页
  - payloadSearchTruncated
  - searchPayload
  - PAYLOAD_SEARCH_WINDOW_ROWS
  - REDACTED
  - 脱敏
  - idx_toolcalls_started_at
  - hideFileHistoryCheckpoints
  - 工具调用记录
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---

# 工具执行日志

设置页「执行日志」：管理员看所有叙述者的工具调用的全局只读视图。它不单独记录任何东西，读的就是 `narrator_tool_calls` 表（写入由工具执行路径完成）；这里负责过滤、游标分页、凭证脱敏和展示。

## 关键规则
- 路由 `/api/execution-log`（`routes/execution-log.ts`）整体要求登录并且是管理员：
  - `GET /`：游标分页列表，最新执行在前；`limit` 默认 50、上限 100（`MAX_EXECUTION_LOG_LIMIT`）；只有游标模式，没有 offset 与总数，因为那会扫整张表。
  - `GET /facets`：筛选项（工具名、状态、提供商），在 `/:id` 之前注册。
  - `GET /:id`：单条详情（含入参/出参）。
- 过滤条件（`listQuerySchema`）：`narratorId`（`includeSubagents` 时连同其子代理）、`projectId`、`toolName`、`status`（initializing / pending / running / success / fail）、`executionDeviceId`、`provider`、`model`（模糊）、`onlyErrors`、`isBackground`、`hideFileHistoryCheckpoints`（默认隐藏文件历史检查点克隆）、起止日期（按 `started_at`）、`q` 与 `searchPayload`。非法游标返回校验错误；`searchPayload` 没有非空 `q` 也直接拒绝。
- 游标是不透明的 base64url JSON：`{ v:1, startedAt, id }`，长度 ≤512，值 ≤128，`startedAt` 必须是 UTC ISO（毫秒可有可无，因为旧行没有毫秒），解码失败返回 null 而不抛错（`lib/execution-log-cursor.ts`）。查询用行值比较 `(started_at, id) < (?, ?)` 才能走 `idx_toolcalls_started_at` 索引；多取一行（`LIMIT n+1`）判断是否还有下一页。
- 文本搜索 `q`：默认只匹配小列（工具名、解析后的文件路径、错误信息、工作目录，以及由入参里的 description/file_path/path/pattern/query/url 提取出的摘要）；LIKE 通配符被转义、长度 ≤128。`searchPayload` 才搜 `input_json`/`output_json`，且只在最新 20,000 行（`PAYLOAD_SEARCH_WINDOW_ROWS`）内，响应里的 `payloadSearchTruncated` 与 `payloadSearchWindowStart` 告诉调用方搜索被窗口截断；已清理的工具调用其入参不参与匹配。
- 列表与筛选项走 `readQuery`（数据库工作线程读路径）并带 `AbortSignal`；单条详情是按主键的一行读取；列表行里只有 `summary` 这类有界字段，列表不读大字段（`output_json` 等）。工具名筛选项来自当前构建的注册表加上最近 20,000 行里出现过的名字（避免 `GROUP BY` 全表），所以 `toolNamesSampled` 恒为 true。
- 详情的脱敏与截断（`getRecord`、`capPayload`）：先 `redactExecutionLogPayload` 再按每列 256KiB 截断，超限时变成字符串预览并带 `inputTruncated`/`outputTruncated` 与原始字节数；脱敏是尽力而为：敏感键名（password、secret、token、credential、authorization、cookie、passphrase、privatekey，含 apiKey/accessToken 等拼写）的值整体替换为 `[REDACTED]`，字符串用网络诊断同一套模式加 PEM 私钥块、`export FOO_TOKEN=…` 与 `--password x` 类参数，递归深度 12；摘要也会脱敏（`lib/execution-log-redaction.ts`）。无法识别的密钥仍可能漏出。
- 详情同时返回执行目标：结构化的 `executionTargetsJson` 与旧的平铺列由 `toolCallWithExecutionTargets` 统一还原；文件回放入参不在普通详情里返回（已清理的工具入参为 null）。
- 前端：设置页路由 `routes/settings/execution-log.tsx`（设置导航里的 `/settings/execution-log`），过滤条 `ExecutionLogFilterBar`、表格 `ExecutionLogTable`；翻页用游标栈（`lib/execution-log-cursor-window.ts`：前进压栈、后退弹栈、不做页码运算），查询键 `["execution-log","list",filters,pageSize,cursor]`，页大小默认 50；API 客户端 `lib/execution-log-api.ts`，类型 `types/execution-log.ts`。

## 从哪读起
- `server/services/execution-log-service.ts:ExecutionLogService`：`listCursor`、`getRecord`、`listFacets`、`buildWhereConditions`。
- `server/lib/execution-log-redaction.ts`、`execution-log-cursor.ts`。
- 测试：`server/services/execution-log-service.test.ts`、`execution-log-worker-reads.test.ts`，`server/lib/execution-log-redaction.test.ts`、`execution-log-cursor.test.ts`，`frontend/lib/execution-log-cursor-window.test.ts`。

## 改它时
- 给日志加筛选或展示字段：改 `ExecutionLogFilters` 与 `buildWhereConditions`、路由的 `listQuerySchema`、前端 `types/execution-log.ts` 与 `execution-log-api.ts` 的 `appendExecutionLogFilters`、过滤条与表格，三端字段名保持一致；列表查询的排序键必须仍是 `(started_at, id)`，否则游标与索引失效。
- 不要给列表加 `COUNT(*)`、offset 或对 `input_json`/`output_json` 的无窗口搜索；新增大字段只能出现在详情，并经 `capPayload`（先脱敏后截断）。
- 新增敏感键名或密钥形态要放进 `execution-log-redaction.ts` 并补 `execution-log-redaction.test.ts`；这是管理员全局视图，别绕过脱敏直接返回原始入参/出参。
- 改游标格式要提升 `v` 并让旧游标解码为 null（`execution-log-cursor.test.ts`）。
- 新增一种工具调用状态要同步 `EXECUTION_LOG_STATUSES`、路由的 `status` 枚举与前端筛选。

## 相关
- [工具体系](index.md)
- [数据库](../../data/index.md)
