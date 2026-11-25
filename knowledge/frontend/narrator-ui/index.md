---
id: frontend.narrator-ui
title: 会话界面
summary: 一个叙述者在界面上的组成：NarratorPanel 如何装配消息列表、输入区、工具卡片、文件面板与外框，以及未归入子节点的零散部分。
anchors:
  - frontend/components/narrator/NarratorPanel.tsx
  - frontend/components/narrator/NarratorPanelSkeleton.tsx
  - frontend/components/narrator/narrator-panel-*
  - frontend/components/narrator/useNarratorPanelWS.ts
  - frontend/components/narrator/narrator-polling.browser-fixture.tsx
  - frontend/components/narrator/narrator-polling.browser-ws-fixture.ts
  - frontend/components/narrator/narrator-polling.browser.test.ts
  - frontend/components/narrator/narrator-switch-budget.browser-fixture.ts
  - frontend/components/narrator/narrator-switch-budget.browser.test.ts
  - frontend/hooks/useNarratorUiSummary.ts
  - frontend/lib/api/narrator-ui-summary.ts
  - server/services/narrator-ui-summary.ts
  - server/routes/__tests__/narrator-ui-summary.test.ts
  - frontend/hooks/useNarratorUiSummary.test.tsx
  - frontend/components/narrator/panel-source.ts
  - frontend/components/narrator/split-tree.ts
  - frontend/components/narrator/remote-ui-*
  - frontend/components/narrator/RemoteUnsupported.tsx
  - frontend/components/narrator/narrator-message-helpers.ts
  - frontend/components/narrator/list/
  - frontend/components/narrator/knowledge/
  - frontend/components/narrator/mock/
status: draft
verified_at: 0baba9c1a
keywords:
  - NarratorPanel
  - useNarratorPanelWS
  - narrator-ws-manager
  - REMOTE_BUILD
  - RemoteUnsupported
  - 叙述者列表
  - NarratorListCard
  - narrafork_mock_stream
  - 模拟流
  - MockStreamPanel
  - 浏览器测试
  - browser-fixture
---
# 会话界面

`frontend/components/narrator/` 是体量最大的前端目录（约 650 个非测试文件）。一个叙述者在界面上是一个 `NarratorPanel`；它自己只负责装配与状态汇集，具体功能分在下面五个子节点。多个面板如何并排、工作区如何保存见[面板与布局](../panels.md)。

## 面板如何组成
- `NarratorPanel.tsx`（约 4000 行）：用 `useNarratorPanelWS`（再经 `hooks/useNarratorWS.ts`、`lib/narrator-ws-manager.ts` 订阅）取得实时状态，向下装配：
  - 头部与工具栏：`header/HeaderToolbar`、`NarratorHeaderLayout`（见[会话外框](session-chrome.md)）。
  - 消息区：`vlist/PretextExactMessageList`，用 `lazy()` 动态加载，并在文件里预加载（见[消息列表](message-list.md)）。
  - 输入区：`NarratorInteractionArea` → `composer/` + `interaction/`（见[输入框与交互](composer.md)）。
  - 权限与提问：内联在消息列表里的 `permission/`、`question/`（见[工具卡片](tool-cards.md)）。
  - 侧面板：详情、Spec、文件面板等同样 `lazy()` 加载；`REMOTE_BUILD` 下被替换为 `RemoteUnsupported`（`remote-ui-panels.tsx`、`remote-ui-contexts.tsx` 提供构建别名），不加载这些模块（见[文件面板](file-panels.md)、[会话外框](session-chrome.md)）。
- 同一个叙述者可以出现在 dock（桌面）、工作区预览、抽屉（手机/分离窗口）等不同宿主，面板通过 `NarratorDockContext` 等上下文与兄弟面板协作，无 Provider 时回退为旧的 prop 回调。
- 头部标题后：团队协调者会话显示「团队」标记（`header/NarratorTeamBadge.tsx`，见[会话外框](session-chrome.md)）。是否显示由 `NarratorPanel` 用 `useNarratorTeamBadge` 决定（远程访问构建与工作区预览里不显示），宽度经 `titleBadgeWidth` 计入头部布局，窄到放不下时由 `headerLayout.showTitleBadge` 隐藏；底部输入区按叙述者写权限变成只读提示（文字可由 `readOnlyNotice` 换掉，见[输入框与交互](composer.md)）。`hideHeader`（默认 false）让宿主自己画头部：面板不渲染 `NarratorHeaderLayout`（标题、团队标记、断线徽标、`HeaderToolbar`），其余照旧；只有团队页的协调者栏传它（`team-page-components.test.tsx` 核对会话页路由不传），见[团队页与审批](../../collaboration/teams/page.md)。列表卡片 `list/NarratorListCard.tsx` 的「跟随默认（模型）」经 `followDefaultLabel`。

## 本节点直接覆盖的部分
- `narrator-panel-types.ts`：面板对外属性与快照类型；`narrator-panel-overrides.ts`：每叙述者设置的三态（跟随默认 `inherit` / 开 / 关）归一化，未知的存储值回落为“跟随默认”而不是当成显式覆盖；`narrator-panel-visibility.tsx`：嵌套的面板可见性上下文（父级与自身都可见才算可见）。
- `useNarratorPanelWS.ts:handlePlanReflect`：「计划反思」按钮的回调（`PermissionCallbacks.onPlanReflect`，类型在 `narrator-panel-types.ts`）。调 `api.reflectPlan`，先隐藏按钮、不乐观移除权限；409 时触发面板对账，其他错误恢复按钮并提示 `planReflectFailed`。
- `useNarratorPanelWS.ts`：在线 `waiting` 不建 panel-state timer；仅页面可见、WS 离线、状态仍为 `waiting` 且没有待处理权限时，每 5 秒安全对账，不额外立即读一次。初始/连接边界和 `onControlPlaneRecovery` 各有对账入口，恢复时提升权限与缓冲代际；状态完整小补丁直接更新详情缓存，旧稀疏帧与子代理状态只在生命周期边界补读（见[数据获取与实时同步](../data-flow.md)）。
- 面板快照共享以挂载级 `readScope` 隔离：PanelWS 按 token/userId/narratorId 创建并显式交给 Composer；API 用 WeakMap 存仅在途池，键包含 token、叙述者、权限与 buffer 双游标，不复用别的面板订阅前的读、不缓存已完成权限。已在线挂载算 `initial`，真实连接边缘/前台恢复才 `fresh` 并提升权限/buffer 代际；监听原始连接回调，不靠 React 合并后的 boolean 判断重连。身份未就绪不匿名预读，token 变化中止并丢弃旧结果（`lib/api/narrators.ts`、`lib/narrator-panel-state.ts`）。
- 首屏 `GET /:id/ui-summary` 在 Worker 读取 ACL 小列并逐请求校验，响应 ≤2 KiB，仅 `narratorId/canWrite/activeTerminalCount/discussion(roomId|null,unread,unreadCapped)`；只查已有讨论室，不创建房间/成员、不读终端实体/所有房间未读。面板徽标、路由与终端权限门共用身份隔离查询（30 秒 stale、60 秒 GC）；未知或失败的写权限不允许打开终端。事件更新先取消旧 HTTP，计数帧不续期 ACL 新鲜度，access 变化先置不可写再重查。
- `panel-source.ts`：给面板源码守卫测试读取源文件的辅助（面板本身无法单元挂载，若干不变量靠读源码断言）；移动 `NarratorPanel.tsx` 前要全仓搜旧路径。
- `list/`：叙述者列表页的卡片与筛选（`NarratorListCard`、`narrator-list-utils`），被 `routes/narrators/index.tsx`、`archived.tsx` 使用。
- `knowledge/`：把知识库条目嵌入面板的内容视图（`KnowledgeEntryPanelContent`）。
- `split-tree.ts`：旧式递归分栏数据结构，仍被终端/窗口/工作区若干组件引用。
- `mock/`：临时的流式回放调试台（`MockStreamPanel` 等，内容固定的脚本，不写数据库）；需本地偏好 `narrafork_mock_stream` 开启才可达，`mock/README-REMOVAL.md` 写明它将被删除，界面文案不走 i18n。
- `narrator-message-helpers.ts`：流式文本预览、内容块处理等消息辅助函数。
- 测试：`*.browser.test.ts` 用 puppeteer-core 加载 `*.browser-fixture.tsx`，在真实 Chromium 里验证布局；`narrator-polling.browser*` 仅替换 WS 传输、运行生产 hooks/API 客户端，并在独占随机端口服务端统计真实 HTTP，请求计数覆盖在线静默与事件/恢复后的补读。

## 改它时
- 挂载共享快照与草稿：`useNarratorPanelWS.panel-state.hook.test.tsx`、`composer/NarratorComposer.test.tsx`、`permission/PermissionRulePolicySync.test.tsx` 覆盖首读/真实重连、StrictMode、权限回执与 hydration meta；`api/client.test.ts` 覆盖旧 token 迟到 401。
- `narrator-switch-budget.browser.test.ts` 使用工作树已构建 SPA 与隔离 HOME/DB 的真实路由/ACL/Worker，在随机端口记录 cold A→首次 B→warm A 的 1/3 秒请求、字节及浏览器/服务器/实际传输峰；B/A 在线切换断言 runtime settings/UI prefs/model runtime 三类全局投影零重读。测量只约束当前构建回归，不是原运行版的同数据性能同比，也不表示 7778 已部署本分支。
- cold UI prefs 正常一次；只有恰好两次且证明首读早于唯一真实 WS 握手边缘、第二读在边缘后、期间没有 prefs PATCH 时，预算测试才接受 HTTP→WS safety gap 的一次补偿（`useFastModeUpdates` 首连调用 `schedule(true)`）。这不是泛泛放宽重复读取，cold panel-state 的两次也须证明相同首读/首连 fresh 边界。当前 fixture 的首次 B 14 次、warm A 5 次观测不是恒定 API 契约，不得与不同数据/部署的旧 33 次当作同比。

## 子节点
- [消息列表](message-list.md)：虚拟列表、细节级别（LOD）、滚动、消息与内容渲染、Markdown、流式输出。
- [输入框与交互](composer.md)：输入框、草稿与附件、发送与排队、斜杠控制命令、状态栏控件。
- [工具卡片](tool-cards.md)：工具调用展示与详情、编辑差异、权限审批与提问卡片、错误请求转储。
- [文件面板](file-panels.md)：文件树、文件查看（预览/节点/归档）与 Monaco 编辑器面板。
- [会话外框](session-chrome.md)：头部与工具栏、模型与额度、dock 与工作区、后台任务、上下文与压缩、Spec、详情、时间线、会话导入导出。

## 相关
- [面板与布局](../panels.md)
- [数据获取与实时同步](../data-flow.md)
- [通用组件与主题](../components-theme.md)
