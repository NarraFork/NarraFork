---
id: frontend.narrator-ui
title: 会话界面
summary: 叙述者面板、懒加载的精确虚拟消息列表（零 DOM 测量）、LOD 细节级别、输入框、工具卡片。
anchors:
  - frontend/components/narrator/
  - frontend/components/narrator/NarratorPanel.tsx
  - frontend/components/narrator/vlist/
  - frontend/components/narrator/lod/
  - frontend/components/narrator/dock/FocusChatHost.tsx
  - frontend/hooks/useNarratorLod.ts
status: stub
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 会话界面

`frontend/components/narrator/` 是体量最大的前端目录：一个叙述者在界面上是一个 `NarratorPanel`，里面是消息列表、输入框、权限/提问卡片和若干侧面板；多个面板如何并排见[面板与布局](../panels.md)。

## 关键规则
- 消息列表由 `vlist/PretextExactMessageList.tsx` 渲染，`NarratorPanel.tsx` 用动态 `import()` 懒加载它；`vlist/vlist-isolation.guard.test.ts` 强制 vlist 目录之外不得静态 import vlist（避免首屏带上整个 vlist 模块图）。
- 列表高度是纯算术：整段文档在当前 LOD 和宽度下用 `@chenglou/pretext` 预测量，前缀索引决定画布总高，可见项按精确偏移绝对定位（见 `vlist/PretextExactMessageList.tsx` 文件头与 `vlist/CONTRACT.md`）。测量路径禁止 DOM 测量，由 `vlist/zero-dom-measure.guard.test.ts` 与 `shared/pretext-layout/shared-core.guard.test.ts` 扫描强制；内核在 `shared/pretext-layout/`。
- LOD（渲染细节级别）取值 1–5，默认 4（`lod/RenderLodCtx.ts`）。每个叙述者各记一个等级（localStorage `narrafork_lod:<id>`），“设为默认”才写 `narrafork_lod_default`（`hooks/useNarratorLod.ts`）；调节入口是 `lod/` 下的指示器（按住 Alt 滚轮/捏合，或点击步进按钮）。
- 实时数据来自 `hooks/useNarratorWS.ts` / `components/narrator/useNarratorPanelWS.ts`，经 `lib/narrator-ws-manager.ts` 订阅；消息树整理在 `message/message-tree-utils.ts`，子代理消息通过父工具调用嵌套显示。
- 输入框 `composer/NarratorComposer.tsx`（编辑器内核是 `InlineComposerEditor`，基于 ProseMirror）：草稿持久化（`narrator-draft-storage.ts`）、文件引用、引用选中文本、图片/媒体附件、发送选项。
- 工具调用的展示逻辑集中在 `tool-call/tool-display.ts`，详情查看器 `ToolCallInspector`；权限审批卡片在 `permission/`，提问在 `question/`；压缩标记与操作在 `compact/`；时间线面板在 `timeline/`。
- 多面板 dock、工作区布局与布局持久化见[面板与布局](../panels.md)。
- 浏览器类测试（`*.browser.test.ts`）用 puppeteer-core 加载 `*.browser-fixture.tsx`，在真实 Chromium 里验证布局。

## 从哪读起
- `frontend/components/narrator/NarratorPanel.tsx`（超大文件）：面板装配，懒加载点集中在文件前部。
- `frontend/components/narrator/vlist/`：虚拟列表（`vlist-exact-*`、`measure/`、`render/`、`registry.ts`）。
- `frontend/components/narrator/dock/FocusChatHost.tsx`：聊天面板在 dock 里的承载（dock 本身见[面板与布局](../panels.md)）。

## 相关
- [面板与布局](../panels.md)
- [数据获取与实时同步](../data-flow.md)
- [通用组件与主题](../components-theme.md)

## 下面有什么

- [消息列表](message-list.md)：虚拟列表、细节级别、滚动、消息与内容渲染、Markdown、流式输出。
- [输入框与交互](composer.md)：输入框、草稿、附件、斜杠命令，以及提问与审批的交互面板。
- [工具卡片](tool-cards.md)：工具调用卡片、详情、差异、权限与提问卡片、请求追踪。
- [文件面板](file-panels.md)：文件树、文件查看与编辑器面板。
- [会话外框](session-chrome.md)：会话头部、模型选择、dock 与工作区、后台任务、上下文管理与压缩入口、Spec。
