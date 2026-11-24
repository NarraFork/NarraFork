---
id: frontend.shell-routing
title: 应用框架与路由
summary: 入口启动顺序、根路由与公开页/登录后外壳的分流、TanStack 文件路由、侧栏导航注册表。
anchors:
  - frontend/main.tsx
  - frontend/App.tsx
  - frontend/routes/
  - frontend/components/AppRootLayout.tsx
  - frontend/components/AuthenticatedAppLayout.tsx
  - frontend/components/nav/nav-items.tsx
  - shared/nav-layout.ts
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

## 从哪读起
- `frontend/main.tsx`、`frontend/App.tsx`：启动与路由器。
- `frontend/routes/`：顶层页面 `index`、`projects/`、`narrators/`（含 `workspace/`）、`settings/`、`knowledge/`、`outline/`、`routines/`、`scheduled-tasks/`、`messages`、`search`、`windows/`、`shared.narrators.$shareId`、`login`、`licenses`、`changelog` 等。
- `frontend/components/AuthenticatedAppLayout.tsx`：AppShell、移动端侧栏、滚动恢复。
- `frontend/components/nav/`：`RecentTabs`（最近标签树，支持拖拽/文件夹）、`NavBottomBar`、`WorkspaceSwitcher`。

## 相关
- [国际化](i18n.md)：命名空间门与路径到命名空间的映射。
- [数据获取与实时同步](data-flow.md)
- [会话界面](narrator-ui/index.md)
