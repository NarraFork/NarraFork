---
id: frontend.pwa-remote
title: PWA 与远程前端
summary: Service Worker 的缓存与导航策略、per-request 品牌 manifest；远程访问构建（独立入口、哈希校验的版本选择、传输替换）。
anchors:
  - frontend/src-sw.ts
  - frontend/lib/pwa.ts
  - frontend/hooks/useVersionCheck.ts
  - frontend/vite.config.ts
  - frontend/vite.remote.config.ts
  - frontend/build/remote-boundaries.ts
  - frontend/remote/
  - frontend/public/
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# PWA 与远程前端

同一套前端有两种发布形态：原生构建由本机后端托管并带 Service Worker（可安装为应用）；远程访问构建是一个不含 SW 的独立入口，经 WebRTC 与后端通信。两者共用 `business-transport` 抽象。

## 关键规则
- SW 由 `vite-plugin-pwa` 的 `injectManifest` 构建（`vite.config.ts`，`registerType: "autoUpdate"`），源是 `src-sw.ts`；预缓存只含 `index.html`、`registerSW.js` 等构建产物。`manifest.webmanifest` 与品牌图标有意不预缓存，因为 manifest 由服务端按请求带实例名与图标改写（`server/lib/branding/manifest.ts`），`BRAND_ASSET_PATHS` 也被运行时缓存路由排除。
- 只缓存静态资源：同源 script/style/worker 用 StaleWhileRevalidate（120 条、7 天），font/image 用 CacheFirst（80 条、30 天）；API 与 WS 路径交还浏览器网络栈（`app-path-classify.ts:isApiOrWsRelativePath`，SW 用自己的 registration scope 当挂载前缀 `SW_BASE`，所以反代子路径下判断仍成立）。
- 导航：`NavigationRoute` 返回缓存的 `index.html`，但先用 `setBaseHref` 把 `<base href>` 改写成 `SW_BASE`（构建产物不含 base，直接返回会让嵌套路由的相对资源 404）；API/WS 前缀在 denylist 里。带 `_nf_reload` 参数的导航先 `no-store` 取新 HTML（8s 超时），5xx 且不是启动页（`STARTUP_STATUS_HEADER`）或失败时回退缓存外壳。
- 版本提示：SW 激活时请求 `<SW_BASE>api/health`（2.5s 超时），与内置 `__APP_VERSION__` 用 `appVersionsMatch` 比较，不一致就向所有窗口客户端 `postMessage({type:"VERSION_MISMATCH"})`；`hooks/useVersionCheck.ts` 收到后自行再核对。SW 自身 `skipWaiting` + `clients.claim`。
- manifest 默认值（`display: standalone`、`display_override: window-controls-overlay`、相对 `scope/start_url`）在 `vite.config.ts:webManifestAsset`；`frontend/public/` 仅放 favicon、PWA 图标、apple-touch-icon、robots.txt。“安装为应用”的页内提示（`beforeinstallprompt`）在前端代码里没有找到。
- 远程构建 `vite.remote.config.ts` 单独打包，入口 `remote/bootstrap.ts`（引导）与 `remote/mount.tsx`（挂载），产物在 `dist/frontend-remote`；刻意不引入原生配置、路由插件、PWA、插件宿主。`build/remote-boundaries.ts` 按解析后的源文件替换模块：传输与 base-path 换成 `remote/` 版本，插件、Monaco、目录选择器、部分叙述者面板换成空实现或 `RemoteUnsupported`。路由是精简的 `remote/route-tree.tsx`（登录、项目、叙述者）。
- 引导流程（`remote/bootstrap.ts:bootstrapRemote`）：若页面已被 SW 控制则直接失败（`REMOTE_SERVICE_WORKER_CONTROLLED`）；邀请取自 URL 片段或已存 grant；`RemoteClient.connect` 建 RTC；`selectRemoteBuild` 按后端身份精确选版本：读同源 `/remote/catalog.json`，校验 manifest 的 sha256、身份兼容键与 buildId，选不到就报错，**不回退到最新版**；样式与入口脚本用 SRI（`integrity`）加载，再 `import()` 并调用 `mount`。
- 传输：`remote/business-transport.ts` 只放行 `resolveRemoteRequestRule` 允许的请求，路径必须是 `/api/` 且拒绝编码绕过，`openSocket` 只支持 `/ws/narrator`（终端 WS 不支持）；`recovering-transport.ts:RecoveringTransport` 在连接关闭时用已存 grant 重连，若后端身份变了就关闭并失败。

## 从哪读起
- `frontend/src-sw.ts`、`frontend/lib/pwa.ts`（更新后等待新服务端就绪再重载）。
- `frontend/remote/bootstrap.ts`、`selection.ts`、`runtime.ts`；测试 `bootstrap.test.ts`、`production.browser.test.ts`。
- `scripts/build-remote-frontend.ts`：远程产物的清单与目录构建（内容未核实）。

## 相关
- [数据获取与实时同步](data-flow.md)：`businessTransport` 抽象与原生实现。
- [远程访问](../remote/remote-access.md)：配对、信令、托管侧。
- [应用框架与路由](shell-routing.md)
