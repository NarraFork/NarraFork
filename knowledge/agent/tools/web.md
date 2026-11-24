---
id: agent.tools.web
title: 浏览器与网页
summary: Browser、WebFetch、WebSearch。
anchors:
  - frontend/routes/settings/search.tsx
  - server/lib/agent/tools/browser.ts
  - server/lib/agent/tools/web-fetch.ts
  - server/lib/agent/tools/web-search.ts
  - server/lib/browser/
  - server/lib/web-fetch/
  - server/lib/search/router.ts
  - frontend/hooks/useBrowserSessions.ts
  - server/lib/agent/tools/browser-memory-profile.ts
  - server/lib/agent/tools/browser-memory.ts
  - server/lib/search/
  - server/services/browser-session-recovery.ts
keywords:
  - Browser
  - WebFetch
  - WebSearch
  - browser_session
  - launch
  - puppeteer
  - readability
  - screenshot
  - webFetchPolicy
  - browserProxy
  - memory_profile
  - heap snapshot
  - 堆快照
  - browser-sessions-handoff
  - search router
  - 搜索渠道
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 浏览器与网页

三个工具分别对应：一次性取页面内容（WebFetch）、联网搜索（WebSearch）、多步交互的浏览器会话（Browser，可选工具）。底层浏览器由 `server/lib/browser/pool.ts` 以 puppeteer-core 驱动（单例、懒初始化，自动发现 Chrome/Edge）。

## 关键规则
- WebFetch 的 `mode`：`readability`（默认，Readability 抽正文）、`screenshot`、`dom`（清洗后的 HTML，可带 `selector`）、`smart`（取 DOM 后让 AI 按 `purpose` 总结）。`max_length` 默认 20000 字符（screenshot 不适用）。只允许 `http:`、`https:`、`data:`，`file:` 被明确排除，本地文件必须走 Read 以保留其路径白/黑名单检查（`tools/web-fetch.ts`）。
- readability/dom/smart 在没有可用浏览器时回退到普通 HTTP 抓取（`web-fetch/http-fetch.ts`，默认 30s 超时，静态页可用，不渲染 JS）；screenshot 必须有浏览器。截图会存成分享链接供前端预览，有效期用 `SCREENSHOT_PREVIEW_EXPIRY_HOURS`。抓取与 abort 信号竞速，可被中断。
- WebFetch 每次导航开新的隔离浏览器上下文，代理按目标 URL 解析：先看 `settings.agent.webFetchPolicy.proxy` 覆盖，缺省走全局出站策略（`web-fetch/proxy.ts`）；Browser 会话的代理单独由 `settings.agent.browserProxy` 决定。
- WebSearch：参数 `query`（至少 2 字符）、`purpose`、`allowed_domains`/`blocked_domains`、`recency_days`、`max_results`（1–50）。实际渠道由设置里的搜索路由决定（模型原生搜索、网关托管、自定义搜索 API、可选搜索子代理），见 `search/router.ts`；`isAvailable` 在没有可用渠道时让工具不可用。搜索子代理运行时不得再进入普通渠道路由，只能用原生侧请求搜索（`web-search.ts:execute`）。结果 metadata 带渠道、尝试次数与来源。
- Browser：先 `launch`（可传 `headless:false` 开可见窗口）得到 `session_id`，其余动作都需要它；动作清单见 `browser.ts:ACTIONS`（click、fill、type、screenshot、evaluate、dom、wait、get_console/get_network、set_viewport、perf_*、memory_* 等）。每个叙述者可有多个命名会话，空闲 TTL 默认 10 分钟，可配 1 秒到 24 小时（`browser/session.ts`）；控制台消息保留 200 条、网络请求 500 条；视口边长上限 4096。
- 有头会话可挂到用户自己的浏览器（需在浏览器里开启远程调试并逐次点“允许”，等待 60s，`browser/user-browser.ts`）。
- 计划内更新重启时，浏览器会话信息写入 `updates/browser-sessions-handoff.json`，新进程启动时读一次后删除；超过 5 分钟视为过期（`browser/handoff.ts`）。
- 内存/堆快照/性能追踪相关的重活在 `browser/` 下用 worker 与流式处理（`memory-*-worker.ts`），不在主线程完成。

## 从哪读起
- `server/lib/agent/tools/web-fetch.ts`、`server/lib/web-fetch/`
- `server/lib/agent/tools/web-search.ts`、`server/lib/search/router.ts`
- `server/lib/agent/tools/browser.ts`、`server/lib/browser/session.ts`、`pool.ts`
- 测试：`server/lib/search/__tests__/`、`server/lib/browser/__tests__/`
- 内存诊断（Browser 的 `memory_*` 动作）：`tools/browser-memory.ts` 取页面指标（JS 堆、文档/帧/节点/事件监听数，范围只是当前页面目标，不是浏览器 RSS）或堆快照，快照以分享链接交付、有效 24 小时、内容不脱敏（`HEAP_SNAPSHOT_PRIVACY_NOTICE`）；`browser-memory-profile.ts` 提供 `memory_profile_start` / `stop` / `status` / `cancel`。
- 更新重启交接：`services/browser-session-recovery.ts` 在旧进程因 `replacement_started` 关停时写交接文件并让 Chrome 保持存活（清空内存会话表但不关上下文），新进程启动时读一次、按 wsEndpoint 重连并重建会话，恢复不了的会话通知所属叙述者（见上一条的 5 分钟过期规则）。
- 前端 `frontend/hooks/useBrowserSessions.ts`：查询某叙述者的浏览器会话（`["browser-sessions", narratorId]`）及关闭、聚焦等变更，另有「可选工具是否已加载并一键加载」的 `useOptionalToolState` / `useLoadOptionalTool`。

## 改它时
- 加一个 Browser 动作：改 `browser.ts:ACTIONS` 与分发，会话级状态放 `browser/session.ts`；重活（内存、堆快照、追踪）放 `browser/` 下的工作线程，不得回到主线程，工作线程不可用时按失败处理。
- 改 WebFetch 的模式或协议白名单：`file:` 必须继续被排除，本地文件只能走 Read 的路径黑白名单；代理解析走 `web-fetch/proxy.ts`，不要在工具里硬编码。
- 改 WebSearch 渠道：路由在 `search/router.ts`，`isAvailable` 在没有可用渠道时必须让工具不可用；搜索子代理运行时不得再进入普通渠道路由。
- 改交接文件格式要同时看 `browser/handoff.ts`（读一次即删、5 分钟过期）与 `browser-session-recovery.ts`。
- 测试：`tools/__tests__/web-fetch.test.ts`、`web-search.test.ts`、`browser-memory*.test.ts`，`server/lib/browser/__tests__/`、`server/lib/search/__tests__/`。

## 相关
- [工具体系](index.md)
