---
id: frontend.data-flow
title: 数据获取与实时同步
summary: api 客户端与令牌、React Query 默认值与错误提示、业务传输抽象、叙述者 WebSocket 单连接管理器与 hooks。
anchors:
  - frontend/lib/query-client.ts
  - frontend/lib/business-transport.ts
  - frontend/build/remote-boundaries.ts
  - frontend/lib/ws.ts
  - frontend/lib/narrator-ws-manager.ts
  - frontend/lib/narrator-status-version.test.ts
  - frontend/hooks/useNarratorWS.ts
  - frontend/hooks/useRecentTabsWS.ts
  - frontend/components/WSConnectionAlert.tsx
  - frontend/hooks/usePlatform.ts
  - frontend/lib/api-error.ts
  - frontend/lib/api/client.ts
  - frontend/lib/api/index.ts
  - frontend/lib/api/misc.ts
  - frontend/lib/api/types.ts
  - frontend/lib/page-lifecycle.ts
  - frontend/lib/ws-status.ts
  - frontend/lib/ws-test-utils.ts
keywords:
  - /ws/narrator
  - narratorWSManager
  - useNarratorWS
  - businessTransport
  - queryClient
  - ApiError
  - narrafork_token
  - Authorization Bearer
  - suppressErrorToast
  - reportMutationError
  - catch-up 游标
  - WSConnectionAlert
  - setWSStatus
  - observePageLifecycle
  - /api/health
  - usePlatform
  - REMOTE_BUILD
  - 重连
  - 订阅粒度
status: draft
verified_at: 2c639f086aef21d60357f1e002e62767938833e8
---
# 数据获取与实时同步

前端用 `frontend/lib/api/` 的类型化客户端发 REST 请求，TanStack Query 管缓存，叙述者的实时事件走一条全局共享的 `/ws/narrator` WebSocket。

## 关键规则
- 会话令牌存在 `localStorage["narrafork_token"]`，`frontend/lib/api/client.ts:getToken/setToken/clearToken` 读写；`request<T>` 自动加 `Authorization: Bearer`，非 2xx 抛 `ApiError`（带 `status`、`data`），401 且服务端判定会话失效、当前 token 仍等于该请求实际发送的 token 时才清令牌（`clearTokenIfSessionInvalid`）；`authorizedFetch` 用 Response WeakMap 保存实际凭据，迟到旧会话 401 不注销新会话。令牌变化通过 `onTokenChange` 通知（VS Code 宿主桥依赖它）。`endSession` 先本地清令牌，再带 `keepalive` 发 `POST /api/auth/logout`（3s 超时，失败忽略）。
- 所有 HTTP/WS 出口走 `business-transport.ts:businessTransport`（`request` / `upload` / `openSocket`）。原生实现用 `fetch`/XHR/`WebSocket`；远程访问构建（`frontend/vite.remote.config.ts` 的 `remoteModuleBoundaries`，映射表在 `frontend/build/remote-boundaries.ts`）把它整个换成 `frontend/remote/business-transport.ts`，因此业务代码不应直接调 `fetch`/`new WebSocket`。
- `frontend/lib/api/index.ts:api` 是各领域对象（`projectsApi`、`narratorsApi`、`gitApi`、`knowledgeApi`…）展开合并而成的单一入口，hooks 里统一写 `api.xxx()`。路径经 `apiUrl` 加挂载前缀，不要手写 `/api`。
- `lib/query-client.ts:queryClient`：`staleTime` 5s、`gcTime` 2min、查询重试 1 次；mutation 默认 `onError` 弹全局错误 toast，mutation 自己渲染错误时设 `meta.suppressErrorToast`；自带 `onError` 的乐观更新需手动调 `reportMutationError` 才会出 toast。
- `lib/ws.ts:buildWsUrl`：开发态直连 Vite 端口时绕过 Vite 的 WS 代理直接连后端端口；否则按页面 origin + 挂载前缀拼地址。`safeCloseWs` 处理 CONNECTING 状态下关闭的告警。
- `narrator-ws-manager.ts:narratorWSManager` 是进程内单例：全站只有一条 `/ws/narrator`，按叙述者引用计数订阅，订阅粒度 `list | panel | messages | activity`（一个叙述者只有所有句柄都是 `activity` 时才停在最轻级别），再把消息按 `narratorIds`/`types`/`typePrefixes` 分发给监听器。断线重连指数退避 1s→30s；页面隐藏 ≥60s 回来强制重连；重连时带 catch-up 游标（`@shared/narrator-catch-up`），用来补拉断线期间的消息（补拉流程未核实：游标类型和按叙述者的记录存在，服务端回放路径没追）。聊天房间订阅每帧最多 `CHAT_ROOM_SUBSCRIBE_BATCH_SIZE`=50 个。
- 小型控制面恢复：`narratorWSManager.onControlPlaneRecovery` 只在合并后的前台恢复选择 `sync` 且连接仍在线时触发；普通帧、心跳不触发，真正重连走 `onConnectionChange`。面板、Agent 收件箱、执行设备和无人值守状态各自对账，不为此增加常态轮询。
- `useNarratorWS.ts:coerceNarratorStatusPatch` 对 `status_change` 和带主状态的 `substatus_change` 只接收状态白名单：`status`、合法 `substatus`、`turnStartedAt/updatedAt`、`errorMessage/errorRetryable`、`archivedWithNarratorId`、`backgroundWorkActive`、非负安全整数 `messageCount`，另保留 `statusEpoch/statusRevision`。完整子状态帧与主状态帧走同一路径；旧的仅标签 `substatus_change` 仍走稀疏回调。缺省字段不清空，显式 `null` 才清空可空值。面板直接合并缓存；可选精确 `messageCount` 缺省时保留原计数，不能当作零或触发每帧详情读取。完整补丁无需再 GET 详情，旧稀疏状态帧只在跨运行生命周期边界时兜底读取，`working ↔ waiting` 不触发该读取。
- 状态乱序水位（`narrator-ws-manager.ts`）：同一 socket 接受一个服务进程 epoch；合法版本的完整 status/substatus 帧先拒绝旧 epoch 和小于该会话 live 水位的 revision，相等允许。普通 live 帧推进共享 live 水位；带 `subscriptionRequestId` 的快照只推进实际接收 listener 的水位，不推进共享水位，以免压掉兄弟 listener 尚未收到的 live 帧；未知请求的版本快照直接丢弃。无合法版本的 legacy 帧不制造排序保证，仍兼容分发。新连接清水位和旧分发队列，最后一个会话订阅解除时清对应会话水位。
- 状态与通知意图分离：管理器丢弃同 epoch 的过期 live `idle+unread` 主状态时，若有字符串 `turnStartedAt` 且非定向快照，会转成本地 `status_notification`，不重放旧状态；RecentTabs 仍须验证当前已接受状态的 epoch/turn 与 `idle+unread` 资格。完整 `substatus_change` 是 `stateOnly` 对账，不作为新的完成声音/PWA 意图；late done 的原 `backgroundWorkActive` 与回合去重不能被更晚的子状态帧替代（见[最近标签页](../collaboration/recent-tabs.md)）。
- 轻量 `list_state_snapshot` 不推进完整状态水位；`useRecentTabsWS.ts` 用只读 `isStatusVersionStale` 检查共享 live 水位，再以列表域独立水位过滤状态字段（见[最近标签页](../collaboration/recent-tabs.md)），不会用一次列表快照压住面板的完整错误/归档字段。
- 连接状态：各 WS 管理器用 `ws-status.ts:setWSStatus/removeWSStatus` 登记自己的连接是否在线（可带 `reconnect` 回调），`WSConnectionAlert` 订阅 `getDisconnected()` 在任一连接断开时显示横幅，`useVersionCheck` 也读它。`page-lifecycle.ts:observePageLifecycle` 被叙述者与终端 WS 管理器、git 订阅共用：只看 `visibilitychange` 不够，进入 bfcache（`pagehide`）和标签冻结（`freeze`）可能没有先触发它，所以另听 `pageshow`（`persisted`）与 `resume`，这些是“套接字已死”的确定信号，不依赖可能仍报 `OPEN` 的 `readyState`；事件目标可注入以便测试。
- 平台与功能可用性：`hooks/usePlatform.ts` 现在只是 `/api/health`（`staleTime`/`gcTime` 无限，一次取回）的投影；多数“能力”是写死的常量（远程构建下 `LOCAL_ONLY` 为不支持），`useDatabaseCapability` 恒返回 `undefined`，不要指望它做运行时协商。
- 终端 WebSocket 不在该管理器里，见[面板与布局](panels.md)。

## 从哪读起
- `frontend/lib/api/client.ts`：`request`、`authorizedFetch`、错误解析。
- `frontend/hooks/useNarratorWS.ts`（约 2200 行）：把管理器事件翻成叙述者面板状态的 hook；`useRecentTabsWS.ts` 同类。
- `frontend/hooks/use*.ts`：一个领域一个 hook 文件（`useProjects`、`useGit*`、`useKnowledge`、`useOutline`、`usePermissions`…），内部是 `useQuery/useMutation` + 查询键与 invalidate 约定（例如 `useProjects.ts:invalidateProjectDeleteQueries`）。

## 改它时
- 加一个 REST 接口：在 `frontend/lib/api/<领域>.ts` 加方法并并入 `api/index.ts` 的 `api`，路径不写 `/api` 前缀；远程访问构建只放行 `remote/` 里 `resolveRemoteRequestRule` 允许的请求，新接口若要在远程可用要同步 `shared/remote-access/request-policy.ts:resolveRemoteRequestRule` 的规则表（`frontend/remote/` 下 `bootstrap`、`recovering-transport`、`selection`、`socket` 等有对应 `.test.ts`）。
- 加一个叙述者 WS 事件类型：服务端广播之外，前端要在 `useNarratorWS.ts`（或对应监听器）里处理，并考虑订阅粒度——只订 `activity` 的界面（如[首页](dashboard.md)）只收到有限的事件集合；管理器的行为由 `lib/narrator-ws-manager.test.ts` 覆盖。
- 改状态时序：`lib/narrator-status-version.test.ts` 覆盖等时间戳乱序、完整子状态与主状态排序、兄弟 listener 不被定向快照压住、未知请求不能建立 epoch、连接重置与 legacy 兼容；最近标签页列表域另看 `hooks/useRecentTabsWS.test.ts`，不能以轻量快照推进完整状态水位。
- 直接用 `fetch`/`new WebSocket` 会绕开 `businessTransport`，远程构建下失效；新增被远程构建替换的模块要改 `frontend/build/remote-boundaries.ts` 的映射。
- 改全局 query 默认值或 mutation 错误处理：`lib/query-client.test.ts`；改 `request` 的错误与令牌清理：`lib/api/client.test.ts`、`lib/api-error.test.ts`；改 URL 拼装：`lib/ws.test.ts`。

## 相关
- [应用框架与路由](shell-routing.md)
- [会话界面](narrator-ui/index.md)
- [面板与布局](panels.md)：终端连接与布局持久化。
- [国际化](i18n.md)：错误文案经 `describeApiError` 本地化。
