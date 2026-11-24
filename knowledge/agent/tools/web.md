---
id: agent.tools.web
title: 浏览器与网页
summary: Browser、WebFetch、WebSearch。
anchors:
  - server/lib/agent/tools/browser.ts
  - server/lib/agent/tools/web-fetch.ts
  - server/lib/agent/tools/web-search.ts
  - server/lib/browser/
  - server/lib/web-fetch/
  - server/lib/search/router.ts
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

## 相关
- [工具体系](index.md)
