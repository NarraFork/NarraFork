---
id: remote.vscode
title: VS Code 插件
summary: 插件结构与和服务端的连接。
anchors:
  - vscode-extension/
  - vscode-extension/src/extension.ts
  - vscode-extension/src/discovery.ts
  - vscode-extension/src/panel.ts
  - server/lib/cors-origin.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# VS Code 插件

`vscode-extension/`（包名 `narrafork-vscode`，要求 VS Code ≥ 1.85）在编辑器里开一个 webview 面板，面板内是一个 iframe，加载**已在运行**的 NarraFork 后端自己的前端。插件不启动也不管理后端。

## 关键规则
- 命令：`narrafork.openPanel`、`reconnect`、`signOut`、`openInBrowser`；配置：`narrafork.serverUrl`、`narrafork.openOnStartup`（`package.json`）。
- 找后端（`discovery.ts`）：用 `/api/health`（公开且带版本）探测，3s 超时。设置了 `serverUrl` 时只试它，错了就明确失败；否则依次试 `~/.narrafork/settings.json` 里的地址和 `http://localhost:7778`。
- 回环地址会被改写成 `localhost` 拼法，因为 `asExternalUri` 无法映射 IPv6 字面量（`loopback.ts`）。`external-uri.ts` 负责得到 webview 可达的基址（含 code-server 场景）。
- 面板是单例：已打开时只 reveal，不重渲染（避免丢掉流式叙述者和未发送输入）；`reconnect` 或端点变化才强制重载（`panel.ts:createOrShow`）。
- 会话 token 存在 VS Code SecretStorage，每个后端 origin 一项，不进 settings；前端把 token 变化回报给宿主，宿主下次打开时注入（`token-store.ts`）。握手 nonce 只表示「编辑器宿主有意嵌入」，真正的边界是每条消息的 origin 检查（`shell.ts`）。
- 服务端配合：`server/lib/cors-origin.ts` 允许 `vscode-webview:` / `vscode-file:` 等编辑器宿主 origin 跨域读 `/api`，理由是认证只用 Bearer 头、没有 cookie；`server/app.ts` 的 CSP 也包含 `vscode-webview:`。引入 cookie 会使这个放行变成漏洞。
- 前端侧有对应的 host bridge（`frontend/lib/api/client.ts` 注释提到 `lib/host-bridge.ts`），具体协议未逐项核实。

## 从哪读起
- `vscode-extension/src/extension.ts`：命令注册与启动流程。
- `vscode-extension/src/shell.ts`：webview HTML、CSP、消息中继。

## 相关
- [远程访问](remote-access.md)
