---
id: frontend
title: 前端
summary: React 19 + Mantine 单页应用：框架与路由、数据流、国际化、会话界面、组件与主题。
anchors:
keywords:
  - 前端
  - frontend
  - React 19
  - Mantine
  - Vite
  - dist/frontend
  - 远程访问构建
  - "@frontend/*"
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 前端

`frontend/` 是用 Vite 构建、由后端静态托管的单页应用（React 19、Mantine v9、TanStack Router 与 Query、dockview、xterm.js）。构建产物在 `dist/frontend/`；同一套代码还有一个“远程访问”构建（`frontend/remote/`、`vite.remote.config.ts`），用另一份传输实现替换 `lib/business-transport.ts`。

几部分的配合：`main.tsx` 启动后挂载 `App.tsx` 的路由器；根路由决定走公开页还是登录后 AppShell（[应用框架与路由](shell-routing.md)）；页面里的数据经 `lib/api` + React Query，实时事件经单例 WebSocket 管理器（[数据获取与实时同步](data-flow.md)）；文案按命名空间懒加载（[国际化](i18n.md)）；最重的界面是叙述者面板（[会话界面](narrator-ui/index.md)）；全局 Provider 与令牌化样式见[通用组件与主题](components-theme.md)；面板如何并排、拖放与持久化，以及终端面板见[面板与布局](panels.md)；插件视图在沙箱 iframe 中由[插件界面宿主](plugin-host.md)承载；Service Worker、安装为应用和不含 SW 的远程访问构建见[PWA 与远程前端](pwa-remote.md)。

其余目录：`frontend/hooks/`（一个领域一个 hook）、`frontend/lib/`（无 UI 工具）、`frontend/plugin-runtime/` 与 `frontend/components/plugins/`（插件 UI 宿主）、`frontend/src-sw.ts`（PWA service worker）、`frontend/remote/`（远程访问构建的入口）、`frontend/locales/`。别名 `@frontend/*`、`@shared/*`（前后端共享代码在 `shared/`）。

## 下面有什么

- [应用框架与路由](shell-routing.md)：入口、AppShell、TanStack 文件路由、导航。
- [数据获取与实时同步](data-flow.md)：api 客户端、React Query、WebSocket 订阅与 hooks。
- [国际化](i18n.md)：en / zh-CN 命名空间、检测顺序、加字符串的规则。
- [会话界面](narrator-ui/index.md)：会话时间线、输入框、工具卡片。
- [通用组件与主题](components-theme.md)：通用组件、样式、暗色主题。
- [面板与布局](panels.md)：dockview 面板、拖放与布局、终端面板、编辑器面板。
- [插件界面宿主](plugin-host.md)：前端如何加载和承载插件界面、插件运行时约定。
- [PWA 与远程前端](pwa-remote.md)：Service Worker、安装为应用、远程访问用的独立前端入口。
- [前端排版引擎](layout-engine.md)：pretext 排版：不量 DOM 就算出文字和块的高度，供虚拟列表等使用。
- [首页](dashboard.md)：首页：待处理的会话与决定、快速输入、各会话最近的工具活动。
- [前端通用工具](utils.md)：没有业务归属的前端小工具：格式化、剪贴板、安全区、窗口控件覆盖等。
