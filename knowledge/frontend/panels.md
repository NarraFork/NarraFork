---
id: frontend.panels
title: 面板与布局
summary: dockview 通用表面、三区拖放、单会话 dock 与工作区 dock 的布局持久化、终端面板与终端 WebSocket。
anchors:
  - frontend/components/dockview/
  - frontend/components/terminal/
  - frontend/components/narrator/dock/
  - frontend/components/narrator/workspace/
  - frontend/hooks/useTerminalWS.ts
  - frontend/hooks/useTerminalViewState.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 面板与布局

界面里的多面板并排都建在 dockview-react 上。`components/dockview/` 是通用封装，叙述者页（单会话 dock）和工作区页（多叙述者）各自带上自己的面板注册表与布局持久化。终端面板是其中一种面板。

## 关键规则
- `dockview/DockviewSurface.tsx:DockviewSurface` 统一提供主题（`DOCKVIEW_THEME_CLASS`，显式传入自有 theme 以免 dockview 默认暗色主题的变量盖掉 `theme.css`）、拖放和标签菜单；面板组件表、外部拖入的落点处理（`onDropSubject`/`onDidDrop`）、布局存取都由调用方注入。
- 拖放分三区（`dockview/drop-intent.ts`）：中心小方块 `swap`（`panel-swap.ts:swapPanels` 互换两个面板的网格位置），四周 `merge`（并入目标组标签），外缘带 `left/right/above/below` 分割；默认 `edge: 0.2`、`swapHalf: 0.14`，`allowedSplits` 可限制方向（移动端抽屉只允许上下，`NarratorDock` 的 `thresholds` 属性透传）。
- 关闭标签的批量动作在 `dockview/tab-close.ts:getTabCloseTargets`：`chat` 面板永远不被关闭，`all`/`auxiliary` 还保留 `narrator` 面板，`auxiliary` 同时保留 `subagent`。
- 单会话 dock：`narrator/dock/NarratorDock.tsx` 防抖 400ms 保存；布局只存本机 localStorage，键 `narrafork_ndock_<narratorId>_<desktop|mobile>`，桌面与移动各一份（`narrator-dock-layout.ts:saveNarratorDockLayout`），信封带 `lastOpenedAt`；启动时 `cleanupStaleNarratorDockLayouts` 清除超过 30 天、或解析失败的条目，时间戳缺失的保留。
- 工作区 dock：布局信封 `WORKSPACE_LAYOUT_VERSION = 2`，含 dockview 序列化布局与 `director` 状态（`grid|director`、主面板、主比例，范围 0.55–0.85，默认 0.72，`director-constants.ts:normalizeDirectorPrimaryRatio`）。存储位置、版本号与 409 规则在服务端，见 [工作区布局](../files/workspaces.md)。客户端侧：`DockviewWorkspace.tsx` 防抖 500ms 调 `saveWorkspaceLayout(id, layout, expectedRevision)`；遇 409 取回 `currentRevision` 只重试一次，再冲突则放弃本次保存。
- 成员与位置分离（服务端规则见 [工作区布局](../files/workspaces.md)）：客户端用 `workspace-panel-set.ts:reconcileLayoutWithPanels` 裁掉非成员条目、把布局没放置的成员追加进去。新增/关闭/拖入面板必须写成员行，`workspace-membership-wiring.guard.test.ts` 扫源码守这条。
- 终端面板（`terminal/`）：`NarratorTerminal` 管一个叙述者的多个终端（标签 + `TerminalGrid` 的 single/split-h/split-v/triple/quad 布局，换布局时按需创建终端），视图状态经 `useTerminalViewState` 乐观更新后防抖写服务端；`WorkspaceTerminalPanel` 是工作区里带头部的包装；`TerminalPanel` 才是 xterm 实例。
- `TerminalPanel` 的输出先攒进缓冲，同时挂 rAF 与 250ms 定时器两路冲刷（先到先执行），待写缓冲超过 1,000,000 字符就丢最旧部分；scrollback 2000 行；`terminal-reply.ts:isHeadlessTerminalReply` 把服务端无头缓冲已回写的设备报告（CPR、DA 等）在浏览器侧丢弃，避免重复应答；`osc52-handler.ts` 拦截 OSC 52，读请求与写请求都只吞掉，不写剪贴板。
- 终端 WebSocket 是 `useTerminalWS.ts:TerminalWSManager` 单例，订阅/退订多个终端；重连指数退避 1s→30s，连续失败 3 次起标记断开，50 次后放弃；收到 1001 不再重连；60s 内没收到服务端 ping 就断开重连；页面隐藏 ≥30s 回来强制重连。

## 从哪读起
- `frontend/components/dockview/DockviewSurface.tsx`、`useDockviewDnd.ts`：通用表面与拖放接线。
- `frontend/components/narrator/dock/`：`panels.tsx` 是组件表（chat、terminal、git、file、knowledge、outline、plugin 等，见 `dock-panel-types.ts`），`NarratorDockContext.tsx` 管打开/关闭工具面板。
- `frontend/components/narrator/workspace/`：`DockviewWorkspace.tsx`（保存与成员同步）、`dockview-layout.ts`（信封解析）、`DirectorLayout.tsx`。
- `frontend/components/terminal/TerminalPanel.tsx`。

## 相关
- [会话界面](narrator-ui.md)：面板内部的消息列表与输入框。
- [数据获取与实时同步](data-flow.md)：叙述者 WebSocket；终端用另一条连接。
- [插件界面宿主](plugin-host.md)：`plugin` 面板。
- [工作区](../files/workspaces.md)、[终端运行时](../platform/terminal.md)：服务端一侧。
