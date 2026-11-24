---
id: frontend.narrator-ui
title: 会话界面
summary: 一个叙述者在界面上的组成：NarratorPanel 如何装配消息列表、输入区、工具卡片、文件面板与外框，以及未归入子节点的零散部分。
anchors:
  - frontend/components/narrator/NarratorPanel.tsx
  - frontend/components/narrator/NarratorPanelSkeleton.tsx
  - frontend/components/narrator/narrator-panel-*
  - frontend/components/narrator/useNarratorPanelWS.ts
  - frontend/components/narrator/panel-source.ts
  - frontend/components/narrator/split-tree.ts
  - frontend/components/narrator/remote-ui-*
  - frontend/components/narrator/RemoteUnsupported.tsx
  - frontend/components/narrator/narrator-message-helpers.ts
  - frontend/components/narrator/list/
  - frontend/components/narrator/knowledge/
  - frontend/components/narrator/mock/
status: draft
verified_at: 878917e97
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

## 本节点直接覆盖的部分
- `narrator-panel-types.ts`：面板对外属性与快照类型；`narrator-panel-overrides.ts`：每叙述者设置的三态（跟随默认 `inherit` / 开 / 关）归一化，未知的存储值回落为“跟随默认”而不是当成显式覆盖；`narrator-panel-visibility.tsx`：嵌套的面板可见性上下文（父级与自身都可见才算可见）。
- `useNarratorPanelWS.ts:handlePlanReflect`：「计划反思」按钮的回调（`PermissionCallbacks.onPlanReflect`，类型在 `narrator-panel-types.ts`）。调 `api.reflectPlan`，先隐藏按钮、不乐观移除权限；409 时触发面板对账，其他错误恢复按钮并提示 `planReflectFailed`。
- `panel-source.ts`：给面板源码守卫测试读取源文件的辅助（面板本身无法单元挂载，若干不变量靠读源码断言）；移动 `NarratorPanel.tsx` 前要全仓搜旧路径。
- `list/`：叙述者列表页的卡片与筛选（`NarratorListCard`、`narrator-list-utils`），被 `routes/narrators/index.tsx`、`archived.tsx` 使用。
- `knowledge/`：把知识库条目嵌入面板的内容视图（`KnowledgeEntryPanelContent`）。
- `split-tree.ts`：旧式递归分栏数据结构，仍被终端/窗口/工作区若干组件引用。
- `mock/`：临时的流式回放调试台（`MockStreamPanel` 等，内容固定的脚本，不写数据库）；需本地偏好 `narrafork_mock_stream` 开启才可达，`mock/README-REMOVAL.md` 写明它将被删除，界面文案不走 i18n。
- `narrator-message-helpers.ts`：流式文本预览、内容块处理等消息辅助函数。
- 测试：`*.browser.test.ts` 用 puppeteer-core 加载 `*.browser-fixture.tsx`，在真实 Chromium 里验证布局。

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
