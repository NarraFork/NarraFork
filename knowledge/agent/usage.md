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
- 额度（余额/套餐窗口）不在这里：额度快照按凭证身份存放，见 [凭证池与模型目录](credentials-models.md)（`sourcing/quota-store.ts`）。

## 从哪读起
- `server/db/schema.ts`：`apiRequests`、`userUsageTotals`、`usageDaily`。
- `server/services/user-usage-totals.ts`、`usage-daily.ts`
- 测试：`server/services/usage-daily.test.ts`、`usage-history-service.test.ts`、`token-recalculation.test.ts`

## 相关
- [凭证池与模型目录](credentials-models.md)
- [Agent Loop](loop.md)
