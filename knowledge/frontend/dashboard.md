---
id: frontend.dashboard
title: 首页
summary: 首页（路由 `/`）：顶部输入框直接建会话并发出首条消息，下面按“需要你处理 / 正在运行 / 最近”分组列出会话，并叠加各会话最近的工具活动。
anchors:
  - frontend/components/dashboard/
  - frontend/routes/index.tsx
  - frontend/lib/dashboard-composer-focus.ts
  - server/routes/dashboard.ts
keywords:
  - 首页
  - 接下来做什么
  - 需要你处理
  - 正在运行
  - 打开收件箱
  - DashboardComposer
  - DashboardSessions
  - useDashboardSessions
  - buildDashboardSessions
  - useNarratorActivity
  - applyActivityEvent
  - narrafork_dashboard_composer
  - dashboard-composer
  - /api/dashboard/summary
  - getDashboardSummary
  - dashboard 命名空间
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 首页

`frontend/routes/index.tsx` 的 `DashboardPage` 只做装配：标题（`dashboard:heading`）、`DashboardComposer`、`DashboardSessions`。输入即开始：不需要先建会话。

## 关键规则
- 输入框 `DashboardComposer.tsx` 复用叙述者的 `NarratorComposer`，但以“草稿模式”运行：草稿、输入历史、暂存附件都存在本机，键是 `DASHBOARD_COMPOSER_KEY = "dashboard-composer"`，不对应任何叙述者。目录、设备、模型、思考强度、权限模式、是否从计划模式开始存在 `localStorage["narrafork_dashboard_composer"]`，读写失败（隐私模式）时只是不记忆。
- 发送顺序：`send` 先 `createNarrator.mutateAsync(...)` 建会话（只带显式选择的字段：有 `chosenCwd` 才带 `cwd`，选了远程设备才带 `deviceId`，思考强度只在显式覆盖时带，权限模式与计划模式只在对应菜单值已知时带），再 `api.sendNarratorMessage` 发首条消息，成功后清草稿与附件、`addRecentTab`、导航到 `/narrators/$narratorId`。建会话成功但发送失败时会话保存在 `pendingSessionRef`，下次发送复用而不重建；任何创建期选项（目录、设备、模型等）一改就清掉它。
- 阻断条件：`directoryRequired`（选了远程设备但目录为空，或未选目录且 `useProjectDirStatus().needsChoice`）时发送改为打开目录选择器；`deviceUnavailable`（所选远程设备已不在线，且设备列表已成功取回）时直接不发，不允许退回到本机。远程访问构建（`REMOTE_BUILD`）不查设备列表。
- 侧栏“新会话”用 `lib/dashboard-composer-focus.ts` 请求聚焦：请求先挂起，已挂载的输入框立即取走，之后才挂载的在挂载时取走（`NavTopSection.tsx` 发起、`DashboardComposer` 消费）。
- 分组在 `dashboard-sessions.ts:buildDashboardSessions`（纯函数）：数据来自三条列表查询（working、waiting 各最多 30 条，最近 50 条，按 `updatedAt` 降序，分别每 15s/15s/60s 轮询）与 `useHumanAttention` 的待办项。有待办的会话归“需要你处理”，其归属是待办的 `rootNarratorId ?? narratorId`（同一会话多项合并计数，只要有一项 `blocking` 就升级为阻塞）；其余无待办的会话按这个顺序判断：`archived` 不显示；状态为 `working`/`waiting` → 正在运行；子状态含 `error` → 需要你处理（`errored`）；有后台任务 → 正在运行；子状态含 `unread` → 需要你处理（`unread`）；否则 → 最近，只留 `RECENT_SESSION_LIMIT = 6` 条。需要你处理内排序：有决定 > 阻塞 > 出错 > 时间。
- 实时活动：`useDashboardSessions` 先用静态数据算出一遍分组，取其中需要处理（未读放最后）与运行中的会话，最多 `MAX_ACTIVITY_SUBSCRIPTIONS = 40` 个，经 `narratorWSManager.subscribe(ids, {kind: "activity"})` 订阅，再用 `dashboard-activity.ts:applyActivityEvent` 把 `activity_snapshot`、`tool_started/executing/completed`、`tool_use_discarded`、`status_change`、`substatus_change`、`title_updated`、`background_task_count_changed` 折进状态；每个会话只保留最近 `ACTIVITY_TOOL_ROWS = 4` 个顶层工具（带 `parentToolUseId` 的子代理事件被忽略），迟到的 `tool_started` 不会把已结束的行拉回运行中（`isLiveToolStatusRegression`）。实时状态再回灌，决定会话落在哪一组。
- 工具行 `ActivityToolCallRow.tsx` 用 `@shared/tool-row-status` 的标记规则和图标，自己画一份：`vlist/` 之外不允许静态 import vlist（见[消息列表](narrator-ui/message-list.md)）。
- 服务端 `GET /api/dashboard/summary`（`server/routes/dashboard.ts`）返回项目数、工作中/等待中叙述者数、运行中终端与容器数、启用的定时任务数、今日花费与 token、待处理权限数与出错叙述者数。项目与叙述者计数都按调用者可读范围过滤（`projectReadableWhere`、`narratorReadableWhere`，只数 primary、未隐藏、未归档），花费与 token 只统计该用户自己的请求；终端、容器、定时任务计数没有按用户过滤。待处理权限数是对至多 50 个 `waiting` 叙述者逐个 `getPendingPermissions` 求和。查询都经 `readQuery` 走读 worker，请求中止会传到 worker 池。前端 `lib/api/misc.ts` 里有 `getDashboardSummary`，但首页组件没有调用它（`frontend/` 内未找到其他调用者）。

## 从哪读起
- `frontend/routes/index.tsx`：页面装配。
- `frontend/components/dashboard/dashboard-sessions.ts`、`dashboard-activity.ts`：分组与活动折叠，均有同名 `.test.ts`。
- `frontend/components/dashboard/DashboardSessions.tsx`：`useDashboardSessions` 与分区渲染（含“打开收件箱”弹窗、`viewAll` 链到 `/narrators`）。
- `frontend/components/dashboard/DashboardComposer.tsx`：建会话并发送。

## 改它时
- 文案在 `frontend/locales/{en,zh-CN}/dashboard.json`，路径 `/` 的命名空间集合在 `lib/i18n.ts:getNamespacesForPath`（`common`、`nav`、`dashboard`），加新键要两种语言同改，否则 `bun run i18n:check` 失败。
- 改分组规则只动 `buildDashboardSessions`，由 `dashboard-sessions.test.ts` 覆盖；新增活动事件类型要同时加进 `ACTIVITY_EVENT_TYPES`（订阅过滤用它）与 `applyActivityEvent`，`dashboard-activity.test.ts` 覆盖。
- 动 `DashboardComposer` 的建会话参数：`DashboardComposer.execution-device.test.tsx`（执行设备）与 `.media.test.tsx`（媒体附件）会拦；它与叙述者页共用 `composer/`、`interaction/` 下的 hooks，改那边会连带影响首页（见[输入框与交互](narrator-ui/composer.md)）。
- 动 `/api/dashboard/summary`：`server/routes/__tests__/dashboard-worker-reads.test.ts` 断言权限范围、50 条上限与计数仍精确、worker 禁用时失败而不回退主连接、请求中止传到 worker。

## 相关
- [输入框与交互](narrator-ui/composer.md)：首页复用的输入框。
- [数据获取与实时同步](data-flow.md)：`narratorWSManager` 的 `activity` 订阅级别。
- [应用框架与路由](shell-routing.md)：根路由与侧栏“新会话”。
