---
id: agent.provider-quota
title: 供应商余额与额度
summary: 各供应商（Codex、Kimi、DeepSeek、OpenCode Go、NUG、TokenDance、中转站等）的余额与套餐额度怎么查、缓存、展示，以及额度墙等待。
anchors:
  - frontend/components/providers/CodexQuotaOverview.tsx
  - frontend/components/providers/CodexQuotaTrendChart.tsx
  - frontend/hooks/useQuotaSnapshots.ts
  - frontend/lib/api/quota-snapshots.ts
  - frontend/components/narrator/model/QuotaSnapshotIndicator.tsx
  - frontend/components/narrator/model/quota-snapshot-view.ts
  - frontend/components/narrator/model/quota-panel-view.ts
  - frontend/components/narrator/model/use-narrator-quota.ts
  - frontend/components/narrator/model/use-nug-quota.ts
  - server/lib/custom-api-quota-cache.ts
  - server/lib/deepseek-balance-cache.ts
  - server/lib/kimi-quota-wait.ts
  - server/lib/nug-quota-cache.ts
  - server/routes/nug.ts
  - server/routes/nug-runtime.test.ts
  - server/lib/opencode-quota-wait.ts
  - server/lib/provider-balance-cache.ts
  - server/services/provider-quota-service.ts
  - server/services/provider-quota-targets.ts
  - server/services/provider-quota-persistence.ts
  - server/services/plugin-provider-connection-service.ts
  - server/lib/provider-key-quota.ts
  - server/lib/provider-quota-wait.ts
  - server/routes/provider-balances.ts
  - server/services/plugin-quota-registry.ts
  - server/services/provider-settings-service.ts
  - server/services/provider-quota-settings-migration.ts
  - shared/provider-quota.ts
  - shared/provider-balance.ts
  - shared/quota-snapshot.ts
  - server/lib/sourcing/quota-store.ts
  - server/lib/sourcing/quota-snapshots.ts
  - server/lib/sourcing/templates.ts
  - server/lib/sourcing/source-groups.ts
  - server/routes/quota-snapshots.ts
  - server/routes/__tests__/quota-snapshots.test.ts
  - server/lib/codex-manager.ts
  - server/lib/codex-usage.ts
  - server/lib/codex-usage-queue.ts
  - server/lib/codex-usage-summary.ts
  - server/lib/commandcode-usage.ts
  - server/lib/kimi-usage-cache.ts
  - server/lib/opencode-usage-cache.ts
  - server/lib/persisted-credential-cache.ts
  - shared/agent-protocol/quota-exhausted.ts
  - server/lib/provider-key-subjects.ts
  - server/services/tokendance-service.ts
  - server/services/narrator-event-handler.ts
  - frontend/components/providers/CodexUsageDisplay.tsx
  - frontend/components/providers/ProviderBalanceStatus.tsx
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
  - /api/quota-snapshots
  - /api/quota-snapshots/refresh
  - groupId
  - cachedOnly
  - expectedGeneration
status: draft
verified_at: 2c639f086aef21d60357f1e002e62767938833e8
---

# 供应商余额与额度

余额（钱包/点数）、套餐额度窗口及额度墙等待。普通展示统一读取公开快照，探测调度仍归各源 owner；凭证选择与降级见 [凭证池与存储](credentials.md)。

## 关键规则
- 统一形状见 [shared/quota-snapshot.ts](../../shared/quota-snapshot.ts)：`scope` 为 key / account / wallet / subscription；`windows` 含周期、`usedRatio`、毫秒 `resetsAt` 及可选绝对用量；另有 `balances`、`plan`、额度有效期 `expiresAt` 和服务端私有 `detail`。未知不是零，uncapped 不制造 0 限额；有效期不是窗口补充时间。`quotaExhaustedUntil` 只取已用尽且重置时间在未来的窗口中的最晚时刻。
- [QuotaStore](../../server/lib/sourcing/quota-store.ts) 按凭证 id 与来源名存放，读取必须匹配当前密钥、端点、网络等身份；换身份不继承旧数字。`quota-snapshots.json` 只存带盐 HMAC 身份指纹；[持久缓存](../../server/lib/persisted-credential-cache.ts) 限 1 MiB / 256 条、防抖 250ms 异步写，恢复值由来源校验。probe 与 `STREAM_QUOTA_SOURCE = "quota_balance"` 独立保存、失效和恢复，流内余额不能覆盖独立窗口；来源自己管 TTL / 退避，仓库不调度探测。
- [NUG owner](../../server/lib/nug-quota-cache.ts) 的全局 `fetchedAt` 仍是最后尝试，carry 数字保留宿主真实观察时间；私有 `detail._remainingObservedAt` / `_totalObservedAt` 经[公开白名单](../../server/lib/sourcing/quota-snapshots.ts) 映射到 balance 的 `remainingObservedAt` / `totalObservedAt`。观察时间三态为 number（真实 epoch-ms）、null（从未观察）、undefined（按旧 snapshot 合同回退 `fetchedAt`）；非法观察时间省略、不造 null，不信任上游时间。legacy / Unified 仅比较同 CID、同单位单 wallet 的各字段时间，同毫秒 probe 优先，partial `total=111` 不遮较新 STREAM `remaining=0`，旧 STREAM total 不盖新 total。metadata-only 不等于显式 unknown / error / expiry；legacy 可比视图明细缺席才只读回退另一槽，非空 latest 优先、`extra: null` 不变，Unified 保留 probe 元数据，两个原槽不互写。
- 普通入口是 [GET /api/quota-snapshots](../../server/routes/quota-snapshots.ts)：登录后返回按组 / 凭据 / source 区分的公开投影，不输出 `detail`、私密身份或原始上游错误；非管理员不拿凭据 id，Codex 只给匿名概览。`plugin_not_enabled` / `quota_unavailable` 是安全码，不是直接展示的错误全文。
- `POST /api/quota-snapshots/refresh` 接受 `{ groupId?, credentialId? }`，主动刷新通常要管理员；仅无配置 Key 的 Command Code CLI 单组临时读取保留普通会话权限，不缓存结果。TD 等待本次真实刷新有 15s / 取消预算；其它普通刷新提交源 owner 工作后返回当前快照。显式管理员 `POST /api/provider-balances/:id/probe` 端点诊断仍保留。
- [refreshQuotaSnapshots](../../server/lib/sourcing/quota-snapshots.ts) 对 Custom API 直接调用插件额度服务，其余来源调用模板 `probeQuota(group, credentialId)`，跳过停用组 / Key；[模板](../../server/lib/sourcing/templates.ts) 委托各来源 owner，不另建 pending 表。TD 调 `refreshTokenDanceBalance(true, credentialId)`，CC 调 `refreshCommandCodeQuota(true, credentialId)`，NUG 调 `refreshNugQuota(group.id, credentialId)`；不是只有测试调用。Codex 只用 `projectQuota` 投影 canonical usage，不经统一入口重发探测。
- root GET 沿用各 owner 的 SWR / 并发 / TTL 预算，不等上游；`cachedOnly` scoped 读只取已有快照。[useQuotaSnapshots](../../frontend/hooks/useQuotaSnapshots.ts) 用 React Query 管共享缓存、取消、失效与 GC：staleTime 30s，普通读取在 refreshing 时 3s、否则 30s 重取，后台不轮询，cachedOnly 不周期轮询；[API 包装](../../frontend/lib/api/quota-snapshots.ts) 不加第二请求缓存。
- root / scoped Query 都按认证 `authGeneration` 隔离并在异步返回前复核，旧会话响应不能写入新会话；scoped 读取还以 `expectedGeneration` 核对模型运行时设置代际。
- [QuotaSnapshotIndicator](../../frontend/components/narrator/model/QuotaSnapshotIndicator.tsx) 与 [quota-snapshot-view](../../frontend/components/narrator/model/quota-snapshot-view.ts) 统一徽标、窗口绝对用量、未知 / 过期 / 无限额和本地化错误展示；[quota-panel-view](../../frontend/components/narrator/model/quota-panel-view.ts) 负责额度条与文本格式。`plugin_not_enabled` 显示本地化停用提示，不显示原始 error。
- Custom API 主动额度统一由 [ProviderQuotaService](../../server/services/provider-quota-service.ts) 调度，[ProviderBalanceCache](../../server/lib/provider-balance-cache.ts) 与 Kimi / OpenCode / DeepSeek 的旧缓存接口只保留兼容投影。厂商协议属于 [独立额度包](../../plugins/provider-quota/src/query.ts)，通过 [PluginQuotaRegistry](../../server/services/plugin-quota-registry.ts) 注册，不再注册 Agent tool 或重复的模型提供商。
- 中转适配器依次识别 Sub2API `/v1/usage`、New API `/api/usage/token/`；站点账户经声明的 `/api/user/self` 连接读取，500000 单位折 1 USD。显式站点账户失败不回退推理 Key。推理 Key 仍由统一凭据库持有，站点配置 / 令牌进入 `plugin_provider_settings`；令牌密文由宿主读取，插件只取得短期连接引用和公开配置。
- [受控连接](../../server/services/plugin-provider-connection-service.ts) 保留代理、UA、响应字节、请求数与取消预算；来源的限额在 [manifest](../../plugins/provider-quota/manifest.json) 声明。共享队列并发最多4、排队最多128，手动间隔10秒；队列满在受理阶段返回429及 `Retry-After`，不会用异步占位成功掩盖拒绝。
- 插件额度快照与游标由 [资源持久化](../../server/services/provider-quota-persistence.ts) 分别保存到 `plugin_resource_entries`，绑定安装、来源版本、凭据及配置身份；恢复值标记过期。旧 OpenCode / DeepSeek 文件只由受限 Worker 校验原 HMAC 与可信包身份后转换，原文件不修改；历史观察带宿主私有 display-only 标记，不能参与自动选源或额度墙等待，真实刷新成功后才恢复决策用途。流内 `quota_balance` 仍单独存在 QuotaStore，不能覆盖主动窗口或跨 generation 恢复。
- 瞬时 `request_failed` 可在来源声明的窗口内保留同身份上次成功值；认证、配置、权限错误会撤回旧值。插件停用、撤权、卸载、崩溃或输出非法均不在宿主运行第二套厂商探测器。启动调度等插件贡献与 [设置迁移](../../server/services/provider-quota-settings-migration.ts) 完成，关停排空仍保留所有权。
- 独立包支持 Kimi Coding `/coding/v1/usages`、OpenCode Go `/zen/go/v1/usage` 或 `/inference/go/v1/usage`、DeepSeek `/user/balance`。当前专用请求超时15秒 / 响应64KiB，缓存新鲜期60秒；读取和刷新都走同一插件服务。平台来源仍各自保留 owner / 预算：
  - [NUG](../../server/lib/nug-quota-cache.ts) 与 [自定义 API STREAM](../../server/lib/custom-api-quota-cache.ts)：流内 `quota_balance` 事件和主动 probe 分槽；NUG owner 可按 CID 主动取网关额度，晚到响应不能改写新身份。
  - [TokenDance](../../server/services/tokendance-service.ts)：余额 TTL 30s，CNY 钱包；逐 Key 额度 owner 与门户登录身份分开，门户不随池排序切换。
  - [Command Code](../../server/lib/commandcode-usage.ts)：上游 `/alpha/billing/credits`，5 小时 / 每周窗口与月度点数，已接逐 Key owner；CLI 额度没有统一凭据，只共用运行中的请求、不保留结果。
  - [Codex](../../server/lib/codex-usage.ts)：`chatgpt.com/backend-api/wham/usage`，20s / 256 KiB；`limit_window_seconds` 的 18000 为 5h、604800 为 weekly、28–31 天为 monthly，其余 unknown。`projectCodexUsageSnapshot` 只投影；[CodexManager](../../server/lib/codex-manager.ts) 保留 5 分钟 TTL / 重置后补刷，[usage queue](../../server/lib/codex-usage-queue.ts) 串行且间隔 500ms，[usage summary](../../server/lib/codex-usage-summary.ts) 保留套餐档位、趋势与预测。credits 续用、`useCreditQuota`、`consumeCodexResetCredit` 与专属展示仍读原 canonical 结构；兼容公开概览 `GET /api/codex/quota-overview` 登录可读，其余 Codex 路由仍要管理员。
- [NUG 标题栏](../../frontend/components/narrator/model/use-nug-quota.ts) 走同一 `GET /api/quota-snapshots?groupId=…&cachedOnly=true&expectedGeneration=…`，只读当前组身份保护缓存，15s / 64 KiB；无 token / provider generation、隐藏或禁用时停发，不轮询后台。409 `MODEL_RUNTIME_STALE` 只使当前会话的 runtime / 模型摘要失效，不回退旧 NUG 全量 GET 或显式付款 RPC。
- [NUG 付款确认](../../server/routes/nug.ts) 保留 payment-only `GET /api/nug/providers/:id/quota` 例外：订单请求携 `orderId` / 不透明 `binding` 复核原 CID 与用户 / 连接身份，按该 CID 更新 per-Key 快照；重排后不能把 A 的付款余额写成 B 的首 Key 摘要。普通额度展示不用此 RPC。
- [额度墙等待](../../server/lib/provider-quota-wait.ts) 仅 Kimi / OpenCode 的额度拒绝按已知重置时刻处理，其余返回 none：wait 在预算内挂起到 `resumeAt`；refuse 等不起 / 重置未知，报告并附 `resetAt`；none 不等待。`loop.ts:tryQuotaSuspension` 发 `model_unavailable`，orchestrator 等待。Kimi 重置后加 5s 偏差、最长 24h、每次运行最多 3 次；OpenCode 依 retry-after、usage 窗口、文本、文档窗口取重置，短限速不挂起，402 / 余额不足不等待。共享标识在 `shared/agent-protocol/quota-exhausted.ts`。

## 从哪读起
- 服务端：[quota-snapshots 路由](../../server/routes/quota-snapshots.ts) → [sourcing owner 汇总](../../server/lib/sourcing/quota-snapshots.ts) → [模板](../../server/lib/sourcing/templates.ts) / 各来源 owner；[QuotaStore](../../server/lib/sourcing/quota-store.ts) 与 [共享 DTO](../../shared/quota-snapshot.ts) 定义存取边界。
- 前端：[useQuotaSnapshots](../../frontend/hooks/useQuotaSnapshots.ts) / [API](../../frontend/lib/api/quota-snapshots.ts) → [QuotaSnapshotIndicator](../../frontend/components/narrator/model/QuotaSnapshotIndicator.tsx) / [统一 formatter](../../frontend/components/narrator/model/quota-snapshot-view.ts)；[useNugQuota](../../frontend/components/narrator/model/use-nug-quota.ts) 是轻量头部，[useNarratorQuota](../../frontend/components/narrator/model/use-narrator-quota.ts) 负责充值提示派生。
- Custom API：[共享额度服务](../../server/services/provider-quota-service.ts)、[插件注册](../../server/services/plugin-quota-registry.ts)、[独立包适配器](../../plugins/provider-quota/src/relay.ts)；[通用扩展设置](../../server/services/provider-settings-service.ts) 管理站点凭证与连接。
- 额度墙：[provider-quota-wait](../../server/lib/provider-quota-wait.ts)、[kimi-quota-wait](../../server/lib/kimi-quota-wait.ts)、[opencode-quota-wait](../../server/lib/opencode-quota-wait.ts)。
- Codex 专属展示仍在 `CodexQuotaOverview.tsx`、`CodexQuotaTrendChart.tsx`、`CodexUsageDisplay.tsx`、`codex-usage-windows.ts`、`codex-tiers.ts`、`codex-credits.ts`，不以通用快照替换其档位 / credits / 重置业务。
- 回归入口：[统一 API 测试](../../server/routes/__tests__/quota-snapshots.test.ts)，另有 quota-store、provider-balance、额度墙与 Codex usage / 持久缓存测试。

## 改它时
- 新额度来源产出 `QuotaSnapshot`，按 CID / 身份写源 owner 和 quotaStore，接模板 `probeQuota`；TTL、退避及晚到响应校验仍归 owner，不能加第二份探测队列或把未知当零。
- 新 Custom API 适配器在独立插件实现并声明 `quotaSources`，遵循 `shared/provider-quota.ts` 与受控连接权限；确定性错误不能当瞬时失败，停用插件不能回退绕过授权。兼容 DTO 的转换留在宿主桥接层。
- 改身份串必须覆盖密钥、端点、代理及实际生效的网络 / 站点凭据；指纹改变后旧快照读不回是预期，不能为了恢复数字跨身份复用。
- 改接口同步共享 DTO、`frontend/lib/api/quota-snapshots.ts`、`useQuotaSnapshots.ts` 与 `quota-snapshot-view.ts`；保留 root / scoped 的认证代际屏障、NUG scoped 预算和付款原 CID 绑定例外。
- 新增额度墙供应商同步 `provider-quota-wait.ts` / `QuotaProviderKind`，不能改变已有等待预算与次数上限。

## 相关
- [凭证池与存储](credentials.md)
- [用量与费用](usage.md)
- [模型提供商](providers/index.md)
