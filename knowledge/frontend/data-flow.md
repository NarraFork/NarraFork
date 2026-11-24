---
id: frontend.data-flow
title: 数据获取与实时同步
summary: api 客户端与令牌、React Query 默认值与错误提示、业务传输抽象、叙述者 WebSocket 单连接管理器与 hooks。
anchors:
  - frontend/lib/api/
  - frontend/lib/query-client.ts
  - frontend/lib/business-transport.ts
  - frontend/build/remote-boundaries.ts
  - frontend/lib/ws.ts
  - frontend/lib/narrator-ws-manager.ts
  - frontend/hooks/useNarratorWS.ts
  - frontend/hooks/useTerminalWS.ts
  - frontend/hooks/
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 数据获取与实时同步

前端用 `frontend/lib/api/` 的类型化客户端发 REST 请求，TanStack Query 管缓存，叙述者的实时事件走一条全局共享的 `/ws/narrator` WebSocket。

## 关键规则
- 会话令牌存在 `localStorage["narrafork_token"]`，`frontend/lib/api/client.ts:getToken/setToken/clearToken` 读写；`request<T>` 自动加 `Authorization: Bearer`，非 2xx 抛 `ApiError`（带 `status`、`data`），401 且服务端判定会话失效时清令牌（`clearTokenIfSessionInvalid`）。令牌变化通过 `onTokenChange` 通知（VS Code 宿主桥依赖它）。`endSession` 先本地清令牌，再带 `keepalive` 发 `POST /api/auth/logout`（3s 超时，失败忽略）。
- 所有 HTTP/WS 出口走 `business-transport.ts:businessTransport`（`request` / `upload` / `openSocket`）。原生实现用 `fetch`/XHR/`WebSocket`；远程访问构建（`frontend/vite.remote.config.ts` 的 `remoteModuleBoundaries`，映射表在 `frontend/build/remote-boundaries.ts`）把它整个换成 `frontend/remote/business-transport.ts`，因此业务代码不应直接调 `fetch`/`new WebSocket`。
- `frontend/lib/api/index.ts:api` 是各领域对象（`projectsApi`、`narratorsApi`、`gitApi`、`knowledgeApi`…）展开合并而成的单一入口，hooks 里统一写 `api.xxx()`。路径经 `apiUrl` 加挂载前缀，不要手写 `/api`。
- `lib/query-client.ts:queryClient`：`staleTime` 5s、`gcTime` 2min、查询重试 1 次；mutation 默认 `onError` 弹全局错误 toast，mutation 自己渲染错误时设 `meta.suppressErrorToast`；自带 `onError` 的乐观更新需手动调 `reportMutationError` 才会出 toast。
- `lib/ws.ts:buildWsUrl`：开发态直连 Vite 端口时绕过 Vite 的 WS 代理直接连后端端口；否则按页面 origin + 挂载前缀拼地址。`safeCloseWs` 处理 CONNECTING 状态下关闭的告警。
- `narrator-ws-manager.ts:narratorWSManager` 是进程内单例：全站只有一条 `/ws/narrator`，按叙述者引用计数订阅，订阅粒度 `list | panel | messages | activity`（一个叙述者只有所有句柄都是 `activity` 时才停在最轻级别），再把消息按 `narratorIds`/`types`/`typePrefixes` 分发给监听器。断线重连指数退避 1s→30s；页面隐藏 ≥60s 回来强制重连；重连时带 catch-up 游标（`@shared/narrator-catch-up`），用来补拉断线期间的消息（补拉流程未核实：游标类型和按叙述者的记录存在，服务端回放路径没追）。聊天房间订阅每帧最多 `CHAT_ROOM_SUBSCRIBE_BATCH_SIZE`=50 个。
- 终端 WebSocket 不在该管理器里，`hooks/useTerminalWS.ts` 自己维护一条 `/ws/terminal` 连接。

## 从哪读起
- `frontend/lib/api/client.ts`：`request`、`authorizedFetch`、错误解析。
- `frontend/hooks/useNarratorWS.ts`（约 2200 行）：把管理器事件翻成叙述者面板状态的 hook；`useRecentTabsWS.ts`、`useTerminalWS.ts` 同类。
- `frontend/hooks/use*.ts`：一个领域一个 hook 文件（`useProjects`、`useGit*`、`useKnowledge`、`useOutline`、`usePermissions`…），内部是 `useQuery/useMutation` + 查询键与 invalidate 约定（例如 `useProjects.ts:invalidateProjectDeleteQueries`）。

## 相关
- [应用框架与路由](shell-routing.md)
- [会话界面](narrator-ui.md)
- [国际化](i18n.md)：错误文案经 `describeApiError` 本地化。
