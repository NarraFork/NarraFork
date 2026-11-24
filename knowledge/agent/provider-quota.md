---
id: agent.provider-quota
title: 供应商余额与额度
summary: 各供应商（Codex、Kimi、DeepSeek、OpenCode Go、NUG、TokenDance、中转站等）的余额与套餐额度怎么查、缓存、展示，以及额度墙等待。
anchors:
  - frontend/components/providers/CodexQuotaOverview.tsx
  - frontend/components/providers/CodexQuotaTrendChart.tsx
  - frontend/hooks/useDeepSeekBalance.ts
  - frontend/hooks/useProviderBalance.ts
  - frontend/hooks/useTokenDanceBalance.ts
  - frontend/lib/provider-balance-format.ts
  - server/lib/custom-api-quota-cache.ts
  - server/lib/deepseek-balance-cache.ts
  - server/lib/kimi-quota-wait.ts
  - server/lib/nug-quota-cache.ts
  - server/lib/opencode-quota-wait.ts
  - server/lib/provider-balance-adapters.ts
  - server/lib/provider-balance-cache.ts
  - server/lib/provider-balance-engine.ts
  - server/lib/provider-balance-transport.ts
  - server/lib/provider-key-quota.ts
  - server/lib/provider-quota-wait.ts
  - server/routes/provider-balances.ts
  - server/services/apikey-quota-plugin-engine.ts
  - shared/provider-balance.ts
  - shared/quota-snapshot.ts
  - server/lib/sourcing/quota-store.ts
  - server/lib/codex-usage.ts
  - server/lib/codex-usage-queue.ts
  - server/lib/codex-usage-summary.ts
  - server/lib/commandcode-usage.ts
  - server/lib/kimi-usage-cache.ts
  - server/lib/opencode-usage-cache.ts
  - server/lib/persisted-credential-cache.ts
  - server/routes/deepseek.ts
  - server/routes/kimi.ts
  - server/routes/opencode.ts
  - shared/agent-protocol/quota-exhausted.ts
  - server/lib/provider-key-subjects.ts
  - server/services/tokendance-service.ts
  - frontend/components/providers/CodexUsageDisplay.tsx
  - frontend/components/providers/ProviderBalanceStatus.tsx
  - frontend/hooks/useOpencodeUsage.ts
  - frontend/lib/codex-credits.ts
  - frontend/lib/codex-tiers.ts
  - frontend/lib/codex-usage-windows.ts
keywords:
  - 余额
  - 额度
  - 套餐窗口
  - 5小时窗口
  - provider-balances
  - QuotaSnapshot
  - quota-snapshots.json
  - sub2api
  - new-api
  - new-api-user
  - apikey-quota
  - Kimi Code
  - OpenCode Go
  - DeepSeek 余额
  - wham/usage
  - PROVIDER_BALANCE_THROTTLED
  - plugin_not_enabled
  - model_unavailable
  - quota_balance
  - codex-usage-queue
  - /api/kimi/usages
  - /api/opencode/usages
  - /api/deepseek/balances
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---

# 供应商余额与额度

各供应商的余额（钱包/点数）与套餐额度窗口（5 小时、每周、每月）怎么查、缓存在哪、怎么展示，以及额度墙到来时循环怎么等。凭证怎么选与降级不在这里，见 [凭证池与存储](credentials.md)。

## 关键规则
- 统一形状 `QuotaSnapshot`（`shared/quota-snapshot.ts`）：`scope`（key / account / wallet / subscription）、`windows`（kind 为 5h / weekly / monthly / other，`usedRatio` 0..1、`resetsAt` 毫秒）、`balances`、`plan`、模板私有的 `detail`。`quotaExhaustedUntil` 只认 `usedRatio >= 1` 且重置时间在未来的窗口，取最晚者。
- 快照仓库 `sourcing/quota-store.ts:QuotaStore`：按凭证 id（加来源名）存放，每条快照带凭证身份；读时传入现身份，不一致返回空，换了密钥或端点就看不到上一个账号的数字。落盘到 `quota-snapshots.json`，身份只存带盐 HMAC 指纹（`persisted-credential-cache.ts`：文件 ≤1MB、≤256 条、防抖 250ms 异步写；读回的值由调用方重新校验）。各来源自己管调度（TTL、退避、刷新），仓库只读写。`STREAM_QUOTA_SOURCE = "quota_balance"` 让流内余额与同一凭证的主动探测并存。模块加载时 `registerKeyQuotaProbe` 把 `quotaExhaustedUntil` 接到密钥池，用于跳过额度用尽的密钥（`provider-key-quota.ts`）。
- 中转站余额（自定义 API，非下面三家专用来源）：`provider-balance-cache.ts:ProviderBalanceCache`。候选条件：启用、有 `apiKey` 和 `baseUrl`，且不是 DeepSeek / Kimi / OpenCode Go（`isProviderBalanceCandidate`）；查询的是新请求实际会用的那把密钥（`withSelectedCredential`）。先探测适配器再刷新：`sub2api`（`/v1/usage`）、`new-api`（`/api/usage/token/`）、`new-api-user`（站点账号 `/api/user/self`，需站点令牌与用户 id，500000 单位折 1 美元）。配了站点账号任一字段就走 `new-api-user`，失败不回退推理密钥端点。
- 缓存参数：新鲜期 60s，手动探测/刷新间隔 10s（过密返回 `PROVIDER_BALANCE_THROTTLED` 与 `Retry-After`），单轮 20s，并发 4、排队 ≤128。传输层（`provider-balance-transport.ts`）单次请求 8s、响应 ≤64KB，沿用连接的代理、UA 与额外头，上游文本和异常不进快照，只给固定错误码。
- 失败分类：`request_failed` 为瞬时，可在最近一次成功后 10 分钟内继续显示旧值，之后撤回；`invalid_configuration` / `auth_failed` / `invalid_response` / `plugin_not_enabled` 为确定性错误，立即暴露并丢弃缓存（`shared/provider-balance.ts`、`provider-balance-adapters.ts:balanceErrorCode`）。
- 查询引擎可替换（`provider-balance-engine.ts`）：`server/app.ts` 装入 `apikey-quota` 插件引擎（`apikey-quota-plugin-engine.ts`）：插件答 ok/unsupported 即为准；插件失败走瞬时/不支持错误；插件被管理员禁用则返回 `plugin_not_enabled`，不回退内置适配器；插件缺失、崩溃或输出不合法才回退内置适配器。
- 路由 `/api/provider-balances`：`GET /` 登录即可，只返回无凭证投影；`POST /:id/probe`、`/:id/refresh` 要管理员，起一个合并的后台任务立即返回，不等上游。
- 专用来源各有自己的缓存与路由，读路由先触发过期刷新（不 await）再返回缓存，非管理员拿到的错误文本被替换为 `hasError`：
  - Kimi Code（`kimi-usage-cache.ts`，`GET /api/kimi/usages`、`POST /api/kimi/usages/refresh`）：`/coding/v1/usages`，新鲜期 60s，超时 15s，按 `kimi-code` 模板识别。
  - OpenCode Go（`opencode-usage-cache.ts`，`/api/opencode/usages`）：新鲜期 60s，失败退避 60s 起翻倍到 10 分钟，请求后刷新最短间隔 20s，响应 ≤64KB；各家族端点都映射到 `/inference/go/v1/usage`。
  - DeepSeek（`deepseek-balance-cache.ts`，`/api/deepseek/balances`）：`api.deepseek.com/user/balance`，新鲜期 60s，响应 ≤64KB。
  - NUG（`nug-quota-cache.ts`，`/api/nug/providers/:id/quota`、`/api/nug/quotas`）与自定义 API 流内余额（`custom-api-quota-cache.ts`）：余额来自请求流里的 `quota_balance` 事件（`narrator-event-handler.ts` 调 `updateCustomApiQuotaByPrefix` / `updateNugQuotaByPrefix`），NUG 另可主动拉取网关。
  - TokenDance（`tokendance-service.ts:getTokenDanceBalance`，`/api/tokendance/balance`）：缓存 30s，快照为 CNY 钱包。
  - Command Code（`commandcode-usage.ts`，`/api/commandcode/usage`）：`/alpha/billing/credits`，5 小时与每周窗口加月度点数；CLI 登录没有对应凭证，不缓存。
  - Codex（`codex-usage.ts`）：`chatgpt.com/backend-api/wham/usage`，超时 20s、响应 ≤256KB；窗口按 `limit_window_seconds` 判定（18000 → 5h，604800 → weekly，28–31 天 → monthly，其余 unknown）；`projectCodexUsageSnapshot` 转成统一快照；`consumeCodexResetCredit` 消耗一次重置额度。用量由 `codex-manager` 调度（TTL 5 分钟，重置时刻后补刷），批量排队走 `codex-usage-queue.ts`（串行，任务间隔 500ms）；套餐档位汇总与预测在 `codex-usage-summary.ts`。公开概览 `GET /api/codex/quota-overview` 登录即可，其余 Codex 路由要管理员。
- 额度墙等待（`provider-quota-wait.ts`）：Kimi 与 OpenCode Go 的额度拒绝按已知重置时刻等待，其余错误返回 `none`。决定三种：`wait`（重置在预算内，挂起到 `resumeAt`）、`refuse`（等不起或重置未知，报告并附 `resetAt`）、`none`。`loop.ts:tryQuotaSuspension` 产出 `model_unavailable` 事件，orchestrator 负责等待。Kimi：重置后加 5s 偏差，单次最长 24h，每次运行最多等 3 次（`MAX_QUOTA_WAITS_PER_RUN`）；OpenCode Go 的额度墙按 retry-after 头、`/usage` 窗口、文本、文档窗口规则顺序取重置时刻，短于下限的限速不挂起，计费类拒绝（402、余额不足）不等待。共享标识在 `shared/agent-protocol/quota-exhausted.ts`。
- 模板上的 `probeQuota`（`probeKimiQuota`、`probeDeepSeekQuota` 等）在运行时没有调用方，只有测试用到（未核实是否仍在接入）。

## 从哪读起
- `server/lib/sourcing/quota-store.ts`、`shared/quota-snapshot.ts`：统一快照与存放。
- `server/lib/provider-balance-cache.ts`、`provider-balance-adapters.ts`：中转站余额。
- `server/lib/provider-quota-wait.ts`、`kimi-quota-wait.ts`、`opencode-quota-wait.ts`：额度墙等待。
- 前端：`useProviderBalance.ts`（轮询：pending/probing 2s，supported 60s，`plugin_not_enabled` 30s，其余不轮询）、`useDeepSeekBalance.ts`、`useOpencodeUsage.ts`（60s）、`useTokenDanceBalance.ts`；`provider-balance-format.ts` 把快照格式化成徽标与悬浮提示（超过 120s 标「过期」）；`ProviderBalanceStatus.tsx` 是设置页的余额徽标。
- Codex 展示：`CodexQuotaOverview.tsx`、`CodexQuotaTrendChart.tsx`（趋势与预测）、`CodexUsageDisplay.tsx`、`codex-usage-windows.ts`、`codex-tiers.ts`、`codex-credits.ts`。
- 测试：`server/lib/__tests__/quota-store.test.ts`、`provider-balance-*.test.ts`、`opencode-quota-wait.test.ts`、`codex-usage*.test.ts`、`persisted-credential-cache.test.ts`。

## 改它时
- 新增一个额度来源：产出 `QuotaSnapshot` 写入 `quotaStore`（传入凭证身份），自己管 TTL 与退避；需要被密钥池跳过时只需有 `windows` 且 `usedRatio`/`resetsAt` 正确，不必改 `credential-pool.ts`。
- 新增中转站适配器：加 `ProviderBalanceAdapter` 取值（`shared/provider-balance.ts`）、解析函数与探测顺序（`provider-balance-adapters.ts`），错误必须归入 `BalanceFailureKind`，确定性错误不能当瞬时处理；插件引擎输出的校验在 `shared/apikey-quota-plugin.ts`。
- 改任何缓存的身份串（`connectionIdentity` 等）会让已落盘快照读不回，这是预期；身份必须包含密钥、端点与代理，否则会显示别的账号的数字。
- 新增额度墙等待的供应商：在 `provider-quota-wait.ts` 增加分支，并同步 `QuotaProviderKind`；等待预算与次数上限在 `kimi-quota-wait.ts`。
- 改接口形状要同步 `frontend/lib/api` 类型与 `provider-balance-format.ts`；列表类路由不得返回上游错误全文给非管理员。

## 相关
- [凭证池与存储](credentials.md)
- [用量与费用](usage.md)
- [模型提供商](providers/index.md)
