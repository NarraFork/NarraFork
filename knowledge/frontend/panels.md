---
id: frontend.panels
title: 面板与布局
summary: dockview 通用表面、三区拖放、单会话 dock 与工作区 dock 的布局持久化、终端面板与终端 WebSocket。
anchors:
  - frontend/components/dockview/
  - frontend/components/terminal/
  - frontend/components/narrator/dock/
  - frontend/components/narrator/workspace/
  - frontend/components/narrator/communication/CommunicationTopologyPanel.tsx
  - frontend/components/narrator/communication/Topology.module.css
  - frontend/components/narrator/communication/topology-model.ts
  - frontend/components/narrator/communication/use-topology-gestures.ts
  - frontend/components/narrator/communication/topology-fixture-data.ts
  - frontend/components/narrator/communication/topology-server.browser-fixture.ts
  - frontend/components/narrator/communication/topology.browser-fixture.tsx
  - frontend/hooks/useCommunicationTopology.ts
  - frontend/lib/communication-subscription.ts
  - frontend/hooks/useTerminalWS.ts
  - frontend/hooks/useTerminalViewState.ts
  - frontend/components/StandaloneWindowLayout.tsx
  - frontend/components/window/
  - frontend/hooks/useMobileTerminalDrawerOpen.ts
  - frontend/lib/panel-drag.ts
  - frontend/routes/windows/panel.tsx
  - shared/narrator-panel-state.ts
keywords:
  - dockview
  - DockviewSurface
  - NarratorDock
  - DockviewWorkspace
  - narrafork_ndock_
  - WORKSPACE_LAYOUT_VERSION
  - director
  - 导演布局
  - reconcileLayoutWithPanels
  - workspace-membership-wiring
  - TerminalPanel
  - NarratorTerminal
  - TerminalWSManager
  - /ws/terminal
  - OSC 52
  - /windows/panel
  - 独立窗口
  - panel-drag
  - 拖放分区
  - swapPanels
status: draft
verified_at: fac3988333435e3fc3b5a4a6ace226c72ce14745
---
# 面板与布局

界面里的多面板并排都建在 dockview-react 上。`components/dockview/` 是通用封装，叙述者页（单会话 dock）和工作区页（多叙述者）各自带上自己的面板注册表与布局持久化。终端面板是其中一种面板。

## 关键规则
- `dockview/DockviewSurface.tsx:DockviewSurface` 统一提供主题（`DOCKVIEW_THEME_CLASS`，显式传入自有 theme 以免 dockview 默认暗色主题的变量盖掉 `theme.css`）、拖放和标签菜单；面板组件表、外部拖入的落点处理（`onDropSubject`/`onDidDrop`）、布局存取都由调用方注入。
- 拖放分三区（`dockview/drop-intent.ts`）：中心小方块 `swap`（`panel-swap.ts:swapPanels` 互换两个面板的网格位置），四周 `merge`（并入目标组标签），外缘带 `left/right/above/below` 分割；默认 `edge: 0.2`、`swapHalf: 0.14`，`allowedSplits` 可限制方向（移动端抽屉只允许上下，`NarratorDock` 的 `thresholds` 属性透传）。
- 关闭标签的批量动作在 `dockview/tab-close.ts:getTabCloseTargets`：`chat` 面板永远不被关闭，`all`/`auxiliary` 还保留 `narrator` 面板，`auxiliary` 同时保留 `subagent`。
- 单会话 dock：`narrator/dock/NarratorDock.tsx` 防抖 400ms 保存；布局只存本机 localStorage，键 `narrafork_ndock_<narratorId>_<desktop|mobile>`，桌面与移动各一份（`narrator-dock-layout.ts:saveNarratorDockLayout`），信封带 `lastOpenedAt`；启动时 `cleanupStaleNarratorDockLayouts` 清除超过 30 天、或解析失败的条目，时间戳缺失的保留。
- 工作区 dock：布局信封 `WORKSPACE_LAYOUT_VERSION = 2`，含 dockview 序列化布局与 `director` 状态（`grid|director`、主面板、主比例，范围 0.55–0.85，默认 0.72，`director-constants.ts:normalizeDirectorPrimaryRatio`）。存储位置、版本号与 409 规则在服务端，见 [工作区布局](../narrator/workspaces.md)。客户端侧：`DockviewWorkspace.tsx` 防抖 500ms 调 `saveWorkspaceLayout(id, layout, expectedRevision)`；遇 409 取回 `currentRevision` 只重试一次，再冲突则放弃本次保存。
- 成员与位置分离（服务端规则见 [工作区布局](../narrator/workspaces.md)）：客户端用 `workspace-panel-set.ts:reconcileLayoutWithPanels` 裁掉非成员条目、把布局没放置的成员追加进去。新增/关闭/拖入面板必须写成员行，`workspace-membership-wiring.guard.test.ts` 扫源码守这条。
- 终端面板（`terminal/`）：`NarratorTerminal` 管一个叙述者的多个终端（标签 + `TerminalGrid` 的 single/split-h/split-v/triple/quad 布局，换布局时按需创建终端），视图状态经 `useTerminalViewState` 乐观更新后防抖写服务端；`WorkspaceTerminalPanel` 是工作区里带头部的包装；`TerminalPanel` 才是 xterm 实例。
- dock 通过真实面板可见性（不是焦点）传给讨论室与终端。`NarratorTerminal` 隐藏、document 不可见或权限未确认为可写时卸载内容，释放 xterm/WS/在途实体读，服务端 PTY 不因此结束；讨论室则保持 `ChatRoomView`/coordinator 挂载，只 suspended 传输以保留输入与锚点（见[聊天](../collaboration/chat.md)）。
- `TerminalPanel` 的输出先攒进缓冲，同时挂 rAF 与 250ms 定时器两路冲刷（先到先执行），待写缓冲超过 1,000,000 字符就丢最旧部分；scrollback 2000 行；`terminal-reply.ts:isHeadlessTerminalReply` 把服务端无头缓冲已回写的设备报告（CPR、DA 等）在浏览器侧丢弃，避免重复应答；`osc52-handler.ts` 拦截 OSC 52，读请求与写请求都只吞掉，不写剪贴板。
- 终端 WebSocket 是 `useTerminalWS.ts:TerminalWSManager` 单例，订阅/退订多个终端；重连指数退避 1s→30s，连续失败 3 次起标记断开，50 次后放弃；收到 1001 不再重连；60s 内没收到服务端 ping 就断开重连；页面隐藏 ≥30s 回来强制重连。

- 拖拽状态：`lib/panel-drag.ts` 是与框架无关的指针拖拽单例（侧栏最近标签、面板头都经它拖到 dockview 表面上），拖拽对象分 `narrator`（只有它能新建工作区或实体化成叙述者面板）与 `tool`（只在表面内重排，永不新建工作区）；另有 @dnd-kit 路径 `startDragManual/moveDrag/endDrag`（此时指针归 @dnd-kit 管）。
- 独立窗口：任一 dock 面板可经 `window/panel-window.ts` 把规范化后的参数序列化进 `/windows/panel` 的 `d` 查询参数，`StandalonePanelWindow` 直接渲染面板内容组件而不是 dockview 适配器；描述符丢弃面板行 ID、一次性高亮请求和未知字段，新旧版本互相降级到共同字段，调试用 `mock` 面板不可打开（`panel-window.ts` 里对 `mock` 直接返回 null）。窗口是独立的 JS 环境，自带叙述者 WS 连接（`StandaloneWindowLayout` 自己不连）；它在没有令牌或会话丢失时跳 `/login`，临时的鉴权查询失败不会清掉会话。依赖 dock 的跨面板桥（聊天↔终端推送、详情上下文、文件引用发布）在窗口里缺席。
- 手机端终端抽屉：`useMobileTerminalDrawerOpen` 打开抽屉前，若终端受支持且没有运行中的终端，先建一个名为 `Terminal 1` 的终端。
- 通讯拓扑面板在会话 dock、工作区、手机抽屉与团队页共用同一内容组件。背景框表达通讯组内互发，框外实线只连接两个具体会话；拖动可建联系、移出通讯子树或恢复原通讯父边，不改变委派控制、任务结果回传、ACL 或团队归属。图和详情均提供按钮/键盘替代，窄容器纵向排布而不是缩小文字。
- 通讯卡片状态图标与 RecentTabs 共用 `nav/RecentTabIcon.tsx`：主会话使用状态气泡，子代理使用机器人，颜色和 reasoning 等标记沿用原规则，状态与 substatus 通过拓扑 WS 更新。背景框优先显示团队名称，无团队时回退根会话标题。卡片仅一行“状态图标 + 叙述者名称”，不显示团队名或协调者/工作者/评审/助手标签；节点高 48px，仍保留 44px 拖动/操作触点。连线依据实际节点中心定位，图、关系列表和详情的组名使用同一投影。
- 通讯图使用共享 narrator socket 的 `communication_snapshot` / `communication_delta`，以 subscriptionId、epoch、连续 seq 防旧帧/缺口；首次、重连和明确 resync 重新快照，不轮询。节点/边/字节和订阅预算在共享协议中定义，断线或撤权会清掉敏感投影并停用管理动作。
- 手动建连的候选搜索与精确校验显式使用 `purpose=manual-connect`，按签入用户对两端的写权限，与建连事务一致；不把源会话执行账号的私有权限当作协作者限制，也不把这条连接当作 Agent Send 的新增 ACL。默认 @ 的执行约束与候选缓存保持分离。
- 归档会话仍可按权限断连，但不可新建连接。重连式撤销仅在断开前两端可连接且当前没有已知归档/只读端点时开放；普通断连使外部端点退出投影，不等于端点被删除，逆操作仍交服务端重验。

## 从哪读起
- `frontend/components/dockview/DockviewSurface.tsx`、`useDockviewDnd.ts`：通用表面与拖放接线。
- `frontend/components/narrator/dock/`：`panels.tsx` 是组件表（chat、terminal、git、file、knowledge、outline、plugin 等，见 `dock-panel-types.ts`），`NarratorDockContext.tsx` 管打开/关闭工具面板。
- `frontend/components/narrator/workspace/`：`DockviewWorkspace.tsx`（保存与成员同步）、`dockview-layout.ts`（信封解析）、`DirectorLayout.tsx`。
- `frontend/components/terminal/TerminalPanel.tsx`。

## 改它时
- 加一种 dock 面板：在 `narrator/dock/dock-panel-types.ts` 登记类型，`dock/panels.tsx`（单会话）与 `workspace/panels.tsx`（工作区）各补组件表；要能弹出独立窗口还要让 `window/panel-window.ts` 的描述符与 `StandalonePanelWindow` 认得它。工作区里新增、关闭、拖入面板必须写成员行，`workspace/workspace-membership-wiring.guard.test.ts` 扫源码，漏写会失败。
- 改拖放分区或关闭规则：`dockview/drop-intent.test.ts`、`panel-swap.test.ts`、`tab-close.test.ts`、`useDockviewDnd.test.ts`；改布局信封：`narrator-dock-layout.test.ts`、`workspace/dockview-layout.test.ts`，并先读服务端的版本与 409 规则（[工作区布局](../narrator/workspaces.md)），`WORKSPACE_LAYOUT_VERSION` 变了要处理旧信封。
- 终端 WS 的退避与超时常量写在 `useTerminalWS.ts` 里，对应终端输出缓冲上限在 `TerminalPanel.tsx`；这些是协议行为，改前对照服务端 `/ws/terminal`（[终端运行时](../platform/terminal.md)）。

## 相关
- [会话界面](narrator-ui/index.md)：面板内部的消息列表与输入框。
- [数据获取与实时同步](data-flow.md)：叙述者 WebSocket；终端用另一条连接。
- [插件界面宿主](plugin-host.md)：`plugin` 面板。
- [工作区](../narrator/workspaces.md)、[终端运行时](../platform/terminal.md)：服务端一侧。
