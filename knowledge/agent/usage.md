---
id: agent.usage
title: 用量与费用
summary: api_requests、token 记账、费用、额度。
anchors:
  - server/services/user-usage-totals.ts
  - server/services/usage-daily.ts
  - server/services/usage-history-service.ts
  - server/services/token-recalculation.ts
  - server/services/token-recalculation-service.ts
  - server/routes/usage-history.ts
  - server/lib/cost-estimate.ts
  - shared/token-accounting.ts
  - frontend/components/usage-history/
  - frontend/hooks/useOutputStats.ts
  - frontend/lib/token-recalculation-api.ts
  - frontend/lib/usage-cost.ts
  - frontend/lib/usage-history-api.ts
  - frontend/lib/usage-history-csv.ts
  - frontend/lib/usage-history-cursor-window.ts
  - frontend/lib/usage-history-user.ts
  - frontend/routes/admin/usage-history.tsx
  - frontend/routes/settings/usage.tsx
  - frontend/types/usage-history.ts
  - server/lib/agent/estimate-json-tokens.ts
  - server/lib/agent/estimate-tokens.ts
  - server/lib/agent/request-dump.ts
  - server/lib/agent/request-json-worker.ts
  - server/lib/agent/request-json.ts
  - server/lib/agent/request-url-tracker.ts
  - server/lib/api-request-tracker.ts
  - server/lib/model-pricing.ts
  - server/lib/reference-usage-cost.ts
  - server/lib/request-recorder-protocol.ts
  - server/lib/request-recorder-sanitize.ts
  - server/lib/request-recorder-store.ts
  - server/lib/request-recorder-worker.ts
  - server/lib/request-recorder.ts
  - server/lib/request-source.ts
  - server/lib/usage-history-cursor.ts
  - server/lib/usage-tracking.ts
  - server/lib/validators/token-recalculation.ts
  - server/routes/request-recordings.ts
  - server/services/output-stats.ts
  - server/services/token-recalculation-postgres.ts
  - server/services/token-recalculation-protocol.ts
  - server/services/token-recalculation-sqlite.ts
  - server/services/token-recalculation-worker-client.ts
  - server/services/token-recalculation-worker.ts
  - server/services/usage-bucket-sql.ts
  - shared/request-recording.ts
  - shared/token-recalculation.ts
  - shared/usage-time-zone.ts
  - server/services/credential-usage-totals.ts
keywords:
  - api_requests
  - usage_daily
  - user_usage_totals
  - credential_usage_totals
  - /api/usage-history
  - 用量统计
  - 费用估算
  - token 重算
  - TOKEN_ACCOUNTING_VERSION
  - costStatus
  - 参考价
  - 请求录制
  - requestEvidence
  - request-recordings
  - 输出速率
  - credential-totals
  - unpricedRequestCount
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 用量与费用

每次模型请求在 `api_requests` 留一行明细（token 分桶、费用、耗时、提供商/凭证/模型、归属），同时在同一事务里累加两个汇总：按用户的终身合计 `user_usage_totals` 和按日汇总 `usage_daily`。明细可以被清理，汇总不依赖明细存活。

## 关键规则
- 写入口 `user-usage-totals.ts:insertApiRequestWithUserUsage`：单个事务内插入明细（主键冲突则不插、返回 false，因此重复完成不会重复计费）、`addUsageDaily` 累加日汇总，有 `userId` 时再 upsert 用户合计。只做索引查找与 upsert，不做聚合扫描；失败要抛出，不允许明细没有汇总。新行打上 `tokenAccountingVersion = TOKEN_ACCOUNTING_VERSION`（当前为 1：未缓存输入与缓存读、缓存写分开存放）。
- 归属（`usage-daily.ts:resolveRequestAttribution`）：付费人 `billingUserId` 取根叙述者（`aclRootNarratorId`，否则自身）的 owner，项目 `projectId` 取根叙述者的主项目；无叙述者时付费人为发起人、无项目。子代理继承所在会话的归属。两者在写入时冻结，不随用户或项目删除而改写（表上无外键）。`userId` 是发起人，可与 `billingUserId` 不同。
- `usage_daily` 以 UTC 日 + 付费用户 + 项目 + 提供商 + 凭证 + 模型为唯一键（空值存空串），累加请求数、各 token 桶、费用与“未定价请求数”。费用 `costStatus` 为 `complete` / `partial` / `unknown`（空表示未改动的历史记录）；只有 complete（或空）且 `costUsd` 有限非负才算已定价。汇总状态由 `aggregateCostStatus`：无未定价为 complete，有 partial 或部分未定价为 partial，否则 unknown（`lib/cost-estimate.ts`）。
- 数据导入时，`addImportedRequestsToUsageDaily` 用一条 SQL 把新插入的行（rowid 大于导入前最大值，重复导入不会重复计入）并入日汇总；旧导出没有付费人时依次用叙述者 owner、发起人兜底。
- 查询（`usage-history-service.ts`、`routes/usage-history.ts`）：整个路由需要登录且为管理员。提供列表（page 或 cursor 分页）、`/stats`、`/timeseries`、`/timeseries-stacked`、`/breakdown`、`/providers`、`/credential-totals`、`/user-totals`（终身合计，与可删除的明细无关）、`/:id`。按时区分桶（`usage-bucket-sql.ts`、`shared/usage-time-zone`）。读取走 `readQuery` 工作线程读路径。
- token 重算：用于把“旧的输入含缓存”的区间转成当前记账口径。`recalculateTokenCounters` 按协议扣减：anthropic 不扣；其他协议扣缓存读；openai 额外扣缓存写；任一计数非安全整数则跳过。每批 500 行、批超时 30s，按 `(created_at, id)` 游标分页，每批提交后才更新进度，取消不会撤销已提交批次，批间让出事件循环；作业在工作线程的 store 上执行，失败时已完成批次保留、重跑会跳过（`token-recalculation*.ts`）。同一时刻只有一个作业，范围用 UTC 日期。
- 每凭证终身合计 `credential_usage_totals`（`credential-usage-totals.ts`）：按（提供商、凭证、模型）累加，由 `api-request-tracker.ts` 在明细插入成功后（重复完成不再记）调用 `recordCredentialUsage`，只记有用量且有凭证的请求；失败请求与来源未知的请求跳过。明细随叙述者删除，汇总不随之删；删除凭证才清（`deleteCredentialUsageTotals`，Codex 路由里调用），归档保留。费用是官方参考价，订阅制（如 Codex 套餐）只是等价消耗，`unpricedRequestCount` 记录无价格的请求数。读取走 `GET /api/usage-history/credential-totals?provider=`。
- 参考价（`model-pricing.ts`）取自模型卡，缺失或显式未知为 null，只有写明十进制 0 才算免费，不会改写 NUG 计费；非 token 维度（图片、音视频秒数、字符数、原生搜索次数）由 `reference-usage-cost.ts` 另行估算，只加不改 `usage-tracking.ts` 已记的 token。
- 请求录制（`request-recorder*.ts`）：录制环（请求/响应字节窗口默认 16MiB/128MiB，`settings.requestEvidence` 的 `ringEnabled`、`ringRequestBytes`、`ringResponseBytes`、`autoPin: off|errors|all`）在工作线程里写盘，排队 ≤4MiB、记录 ≤2048 条、保存 ≤10000 条、归档 ≤512MiB、下载租约 120s 且同时最多 4 个。路由挂在 `/api/narrators/:id/request-recordings`（`POST /` 保存当前环、`GET /` 列出已保存（limit 1–100，默认 20）、`GET /requests/:requestId` 取详情、`POST /requests/:requestId` 保存指定请求、`DELETE /:saveId`、`GET /:saveId/download`，`routes/request-recordings.ts`，需登录）；元数据与 URL 会清洗，body 保留原样作证据。提供商侧的内存捕获在 `agent/request-dump.ts`（错误体前缀默认 1MB，硬上限 32MB）。
- 额度（余额/套餐窗口）不在这里：见 [供应商余额与额度](provider-quota.md)。
- 实时输出速率：`output-stats.ts` 记录每个流式块的字符数，3 秒滑动窗口算 chars/sec，每秒向订阅的 WebSocket 客户端广播（`useOutputStats.ts` 消费）。
- token 估算 `estimate-tokens.ts` 是保守的字符启发式（ASCII 约 0.3、CJK 约 0.6 token/字符，偏高估），`estimate-json-tokens.ts` 不物化整个 JSON 串就估算；仅用于显示与预算，不用于记账。

## 从哪读起
- `server/db/schema.ts`：`apiRequests`、`userUsageTotals`、`usageDaily`。
- `server/services/user-usage-totals.ts`、`usage-daily.ts`、`credential-usage-totals.ts`；`server/lib/api-request-tracker.ts` 是明细与汇总的调用点。
- 前端：设置页 `routes/settings/usage.tsx`、管理页 `routes/admin/usage-history.tsx`、`components/usage-history/`、`lib/usage-history-api.ts`（光标分页 `usage-history-cursor-window.ts`）、`usage-history-csv.ts`（只导出已分页的有界数据）、`usage-cost.ts`（费用状态展示）、`token-recalculation-api.ts`。
- 测试：`server/services/usage-daily.test.ts`、`usage-history-service.test.ts`、`token-recalculation.test.ts`

## 改它时
- 给 `api_requests` 加列或改记账口径：同步 `insertApiRequestWithUserUsage` 与 `addUsageDaily`、`usage_daily` 唯一键、导入路径 `addImportedRequestsToUsageDaily`；新行带 `tokenAccountingVersion = TOKEN_ACCOUNTING_VERSION`，旧口径的区间靠重算转换（`token-recalculation*.ts`）。
- 新增用量查询路由：`routes/usage-history.ts` 整体要管理员；列表必须用游标与 `LIMIT n+1`，不要加 `COUNT(*)`；读走 `readQuery` 工作线程路径。
- schema 变更同步数据导入导出（`server/services/data-portability.ts`，`data-portability*.test.ts`）。
- 重算作业只能在工作线程的 store 上跑，工作线程不可用时失败而不是回到主线程（`tests/worker-main-thread-fallback.guard.test.ts` 会扫描遗留的回退标识）。
- 测试：`usage-daily.test.ts`、`usage-history-service.test.ts`、`token-recalculation*.test.ts`、`credential-usage-totals.test.ts`。

## 相关
- [供应商余额与额度](provider-quota.md)
- [凭证池与存储](credentials.md)
- [Agent Loop](loop.md)
