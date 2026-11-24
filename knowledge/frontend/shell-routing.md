---
id: frontend.shell-routing
title: 应用框架与路由
summary: 入口启动顺序、根路由与公开页/登录后外壳的分流、TanStack 文件路由、侧栏导航注册表。
anchors:
  - frontend/main.tsx
  - frontend/App.tsx
  - frontend/components/AppRootLayout.tsx
  - frontend/components/AuthenticatedAppLayout.tsx
  - frontend/components/nav/nav-items.tsx
  - shared/nav-layout.ts
  - frontend/components/nav/HeaderPullToRefresh.tsx
  - frontend/components/nav/MobileNavButton.tsx
  - frontend/components/nav/NavBottomBar.tsx
  - frontend/components/nav/NavHoverPanel.tsx
  - frontend/components/nav/NavOverflowMenu.tsx
  - frontend/components/nav/NavTopSection.tsx
  - frontend/components/nav/NavUserMenu.tsx
  - frontend/components/nav/nav-bottom-bar-logic.ts
  - frontend/components/nav/nav-hover-expand.ts
  - frontend/components/nav/nav-render-context.ts
  - frontend/components/nav/use-nav-badges.ts
  - frontend/hooks/nav-layout.ts
  - frontend/hooks/useNavLayout.ts
  - frontend/hooks/useResizableNav.ts
  - frontend/hooks/useSetupAssistant.ts
  - frontend/hooks/useSetupWizardGuard.ts
  - frontend/lib/app-path-classify.ts
  - frontend/lib/app-shell-scroll.ts
  - frontend/lib/base-path.ts
  - frontend/lib/dom-mutation-guard.ts
  - frontend/lib/fullscreen-escape.ts
  - frontend/lib/history-entry.ts
  - frontend/lib/history-state.ts
  - frontend/lib/hmr-guard.ts
  - frontend/lib/ios-scroll-to-top.ts
  - frontend/lib/lazy-with-retry.ts
  - frontend/lib/legacy-browser-polyfills.ts
  - frontend/lib/pinch-zoom-guard.ts
  - frontend/lib/settings-nav.ts
  - frontend/lib/smooth-scroll.ts
  - frontend/lib/standalone-window.ts
  - frontend/routes/__root.tsx
  - frontend/routes/learn.tsx
  - frontend/routes/tutorial/$lessonId.tsx
  - frontend/routes/tutorial/index.tsx
  - frontend/routes/windows.tsx
  - server/routes/learning.ts
  - server/routes/tutorial.ts
  - shared/learning-content.ts
keywords:
  - AppShell
  - TanStack Router
  - routeTree.gen.ts
  - createAppRouter
  - getRouterBasepath
  - RootLayout
  - AuthenticatedLayout
  - CUSTOMIZABLE_NAV_IDS
  - nav_layout
  - 侧栏
  - 更多菜单
  - 下拉刷新
  - /windows
  - /learn
  - /api/learning
  - TUTORIAL_REMOVED
  - setupWizardCompleted
  - lazyWithRetry
  - legacy-browser-polyfills
  - getAppBase
  - apiUrl
  - 反向代理子路径
  - 设置导航
  - settings-nav
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 应用框架与路由

前端是 Vite 构建的单页应用：`main.tsx` 只做启动副作用，React 树在 `App.tsx`，路由由 TanStack Router 按 `frontend/routes/` 文件生成，登录后的界面包在 Mantine `AppShell`（侧栏 + 主区）里。

## 关键规则
- 启动顺序（`frontend/main.tsx:bootstrap`）：先装旧浏览器 polyfill（必须是第一个 import），再在首帧前写入插件主题、调色板、壁纸属性（公开分享页跳过），安装编辑器宿主桥与捏合缩放守卫，创建 browser history，`await initI18n` 只等 `common`/`errors`，最后 `createRoot` 渲染 `<App history>`。
- React 组件不放进 `main.tsx`：入口有模块级副作用，不能当 Fast Refresh 边界。`App.tsx` 的导出必须全是组件，由 `frontend/lib/app-hmr-boundary.test.ts`（`app-hmr-boundary.test.ts`）守着。
- 路由器在 `App.tsx:createAppRouter` 创建：`basepath` 取自 `getRouterBasepath()`（支持反向代理子路径）、每条路由默认带 `RouteChunkErrorBoundary`（叶子路由出错不卸载侧栏）、`defaultPreload: "intent"`、挂起 400ms 后显示 `RoutePendingIndicator`。
- 路由文件由 `TanStackRouterVite`（`autoCodeSplitting: true`，`frontend/vite.config.ts`）生成 `routeTree.gen.ts`；该文件不入库，CI 先 `bun run build` 再类型检查。
- 根路由 `frontend/routes/__root.tsx` 在 `beforeLoad` 里预取当前路径所需的 i18n 命名空间（失败不阻塞），布局为 `AppRootLayout.tsx:RootLayout`。
- `RootLayout` 分流：独立窗口路径（`/windows/*`）直接 `<Outlet/>`；`/login`、`/oauth/authorize`、公开叙述者分享页、以及未登录访问 `/licenses`、`/changelog` 走无外壳的 `I18nNamespaceGate`；其余路径懒加载 `AuthenticatedLayout`（`AuthenticatedAppLayout.tsx`），外面套 `APP_SHELL_NAMESPACES` 的命名空间门。
- 侧栏导航项 id 来自 `shared/nav-layout.ts:CUSTOMIZABLE_NAV_IDS`（projects、messages、routines、scheduled-tasks、learn、knowledge、outline），前端 `nav-items.tsx` 用 `Record<CustomizableNavId, …>` 补展示细节，新增 id 漏补会编译失败；服务端校验器也从同一列表派生。用户布局存于 `user_preferences.nav_layout`，`__divider__` 之后的项收进“更多”菜单，未出现在已存布局中的 id 由 `useNavLayout` 自动补入；`outline` 在 `outline.enabled` 关闭时隐藏。

- 部署前缀：`lib/base-path.ts:getAppBase` 由 `document.baseURI` 算出挂载根（只取目录部分，解析失败回退 `/`），`apiUrl`/`assetUrl` 据此拼地址，带 `api` 段的路径不会拼成 `/api/api`。`lib/app-path-classify.ts` 单独成模块，是因为 Service Worker 没有 `document`、要共用同一套“哪些相对路径是 API/WS 流量”的判断，两边必须一致（见 [PWA 与远程前端](pwa-remote.md)）。
- 懒加载与错误隔离：`lib/lazy-with-retry.ts:lazyWithRetry` 只对“动态 import 取模块失败”（`Failed to fetch` 等消息）重试，默认再试 1 次、间隔 250ms，模块求值抛的错不重试；`lib/dom-mutation-guard.ts` 在 import 时给 `Node.prototype.removeChild/insertBefore` 打补丁（父节点不符时 `removeChild` 原样返回、`insertBefore` 退成 `appendChild`），防浏览器翻译插件改乱 DOM 后 React 崩溃；`lib/legacy-browser-polyfills.ts` 给旧 Safari 补内建方法，`lib/legacy-builtins.guard.test.ts` 扫 `frontend/` 与 `shared/`，用了清单里没有 shim 的禁用内建方法（构建目标 `es2020`/`safari14` 只降语法不补运行时）就失败。
- 手势与历史：`lib/pinch-zoom-guard.ts` 拦截浏览器标签页里 Safari 仍会触发的多指缩放；`lib/history-state.ts`/`history-entry.ts` 管应用自己的 history 哨兵条目（`useMobileDrawerHistory` 用它让返回键先关抽屉）；`components/nav/HeaderPullToRefresh.tsx` 只在头部识别下拉刷新手势。
- 侧栏宽度：`hooks/useResizableNav.ts` 让拖拽帧直接改 DOM 属性，已落定的宽度才进 React；`components/nav-width-isolation.guard.test.ts` 读 `AuthenticatedAppLayout.tsx` 源码，要求 `useNavWidth()` 只能在外壳的薄包装里调用，上移会让每个拖拽帧重渲整个侧栏。
- 设置导航：`lib/settings-nav.ts` 是设置页桌面侧栏与手机选择页共用的唯一清单（分组 `personal`/`enhancements`/`instance`），`ADMIN_PATHS` 列出需要管理员的路径，注释要求与 `instance` 分组保持一致（`settings-nav.test.ts` 覆盖）。
- 学习与旧教程：`/learn`（`routes/learn.tsx`）读 `GET /api/learning`、`/api/learning/search`、`/api/learning/:id`（`server/routes/learning.ts`，内容来自 `shared/learning-content.ts`，`lang` 查询参数选语言）；`/tutorial` 与 `/tutorial/$lessonId` 前端只是重定向到 `/learn`，`/api/tutorial/*` 一律抛 `TUTORIAL_REMOVED`（410）。
- 初始设置向导：`hooks/useSetupWizardGuard.ts` 对管理员且 `setupWizardCompleted === false` 的情形拦住动作并触发打开向导，非管理员永远放行；`useSetupAssistant.ts` 把缺失系统依赖的安装委托给一个“Setup Assistant”叙述者，调用方必须显式传授权级别（`full`/`default`），仅管理员可用。

## 从哪读起
- `frontend/main.tsx`、`frontend/App.tsx`：启动与路由器。
- `frontend/routes/`：顶层页面 `index`（见[首页](dashboard.md)）、`projects/`、`narrators/`（含 `workspace/`）、`settings/`、`knowledge/`、`outline/`、`routines/`、`scheduled-tasks/`、`messages`、`search`、`windows/`、`shared.narrators.$shareId`、`login`、`licenses`、`changelog` 等。
- `frontend/components/AuthenticatedAppLayout.tsx`：AppShell、移动端侧栏、滚动恢复。
- `frontend/components/nav/`：`RecentTabs`（最近标签树，支持拖拽/文件夹）、`NavBottomBar`、`WorkspaceSwitcher`。

## 改它时
- 加侧栏导航项：在 `shared/nav-layout.ts:CUSTOMIZABLE_NAV_IDS` 加 id，`nav-items.tsx` 的 `Record<CustomizableNavId, …>` 会在编译期要求补展示项；服务端校验器从同一列表派生，不用另改；`hooks/nav-layout.test.ts` 覆盖合并规则（漏项会静默丢失，所以逻辑拆成纯函数测）。
- 加页面：新建 `frontend/routes/` 下文件，在 `lib/i18n.ts:getRouteNamespaces` 登记命名空间；`tests/frontend/app-shell-i18n-namespaces.test.ts` 断言登录后路径都含外壳命名空间。`routeTree.gen.ts` 不入库，不要手改。
- 加设置页：只改 `lib/settings-nav.ts`；需要管理员的同时进 `ADMIN_PATHS`。
- 往 `App.tsx` 加导出：只能是组件，`lib/app-hmr-boundary.test.ts` 守着；入口副作用放 `main.tsx`，且 polyfill 保持第一个 import。
- 用了新的运行时内建方法：先看 `legacy-builtins.guard.test.ts:GUARDED_BUILTINS`（每项要么已 shim 要么禁用），必要时补进 `legacy-browser-polyfills.ts`。
- 改侧栏宽度相关：读 `components/nav-width-isolation.guard.test.ts`。

## 相关
- [国际化](i18n.md)：命名空间门与路径到命名空间的映射。
- [数据获取与实时同步](data-flow.md)
- [会话界面](narrator-ui/index.md)
