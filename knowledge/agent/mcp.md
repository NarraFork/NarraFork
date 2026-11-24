---
id: agent.mcp
title: MCP 集成
summary: MCP 服务器接入与工具暴露。
anchors:
  - server/lib/mcp/
  - server/routes/mcp.ts
  - shared/mcp-loading-mode.ts
  - server/services/tool-loading-service.ts
  - frontend/hooks/useMcp.ts
  - frontend/lib/mcp-import.ts
  - frontend/lib/mcp-json-draft.ts
  - frontend/lib/mcp-secrets.ts
keywords:
  - MCP
  - mcpServers
  - McpManager
  - mcp__
  - tool-bridge
  - stdio
  - streamable-http
  - sse
  - /api/mcp
  - /api/mcp/servers/import
  - /api/mcp/oauth/callback
  - narrafork_get_context_summary
  - loadingMode
  - McpAuthorizationRequiredError
  - __KEEP_EXISTING__
  - toolPermissions
  - defaultBehavior
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# MCP 集成

NarraFork 既是 MCP 客户端（连接外部 MCP 服务器，把它们的工具并入工具注册表），也在 `/api/mcp` 暴露一个很小的 MCP 服务端。基于 `@modelcontextprotocol/sdk`。

## 关键规则
- 传输：`stdio`、`streamable-http`、`sse`（`transports.ts:createTransport`）。stdio 子进程环境 = 用户环境代理变量 + 配置的 env；其 stderr 立即消费并丢弃，避免背压卡住响应。远程传输带 OAuth 时，配置的 headers 只加到 MCP 服务器同源请求上。
- 管理器（`manager.ts:McpManager`，单例 `mcpManager`）：`initialize` 对所有加载模式不是 `disabled` 的服务器并发连接再统一发布；连接/单页发现超时 30s；意外断线后 5s 重连，最多连续 3 次，之后放弃；监听 `tools/list_changed` 刷新目录；结构化结果缺文本镜像时序列化为 JSON，超 80000 字符截断并在首行注明。
- 工具并入：`tool-bridge.ts` 把每个 MCP 工具注册成 `mcp__<服务器名小写>__<工具名>`（两段都做字符集清洗并受长度预算约束，提供商会因非法名拒绝整个请求）；描述加前缀 `[MCP: 服务器名]`；输入 schema 原样克隆为 `rawJsonSchema`，本地只要求对象并透传，校验交给 MCP 服务器；工具可用性取决于服务器是否仍连接；调用超过 60s 发出“长时间运行”事件，进度通知以 250ms 节流合并后映射为结构化进度（`prepareMcpTools`、`createMcpToolDefinition`）。注册表在准备期间若版本变化，发布返回 false 而不写入。
- 加载模式 `disabled` / `auto` / `resident`（`shared/mcp-loading-mode.ts`）：未写 `mode` 时由 `enabled` 推导（false→disabled，true→resident，缺省→auto）；写入时 `mode` 与 `enabled` 冲突会被拒绝。`auto` 的服务器不预加载，经 ToolSearch 按单个工具加载（见 [工具体系](tools/index.md)）。该模式与逐工具权限无关（`toolPermissions`、`defaultBehavior`：readOnly/readWrite/ask/deny）。
- OAuth（`oauth.ts`）：授权发现、动态注册、PKCE、换票、刷新都由 SDK 完成，本模块只持久化状态并决定何时允许浏览器往返。后台连接（启动、重连、测试）只能用并刷新已存令牌，不能发起授权，会抛 `McpAuthorizationRequiredError`；交互式流程由管理员启动，PKCE verifier 与 state 只放内存、单次、有效期 10 分钟，同时最多 50 个。令牌、已注册客户端与密钥存放在 settings.json 旁的加密文件。回调路径 `/api/mcp/oauth/callback`。
- 管理路由（`routes/mcp.ts`）：服务器的增删改、connect/disconnect、refresh、test、OAuth start/clear、导入（`/servers/import`）全部 `requireAdmin`；API 返回的配置投影只含 env/header 的键名，不含值。`GET /api/mcp/tools` 列出已连接外部服务器的工具。
- 服务端：`POST /api/mcp/` 为每个请求新建一个无状态的 `McpServer`（名称 `narrafork`）。目前只注册一个工具 `narrafork_get_context_summary`（按叙述者 ID 返回上下文摘要）。

## 从哪读起
- `server/lib/mcp/manager.ts`、`tool-bridge.ts`
- `server/routes/mcp.ts`
- 管理员侧的 `McpAdmin` 工具在 `server/lib/agent/tools/mcp-admin.ts`（`tools/__tests__/mcp-admin.test.ts`）
- 前端：`frontend/hooks/useMcp.ts`（服务器列表与增删改、连接、刷新、测试、OAuth 的 React Query 封装）；MCP 管理界面在 `routes/routines/index.tsx`。编辑弹窗有表单与 JSON 两种视图，必须能无损往返 `McpServerDraft`（`lib/mcp-json-draft.ts`，保留已存密钥的占位符 `__KEEP_EXISTING__`）；env/headers 的值从不回显，`lib/mcp-secrets.ts:buildMcpSecretPatch` 只为被改动的键产出 `set`、为被删除的键产出 `delete`；导入对话框先经 `lib/mcp-import.ts:filterUnsupportedMcpImportTransports` 滤掉非 stdio（含只写 `url` 的）服务器并计数提示，再 POST `/api/mcp/servers/import`（服务端本身接受 sse 与 streamable-http，前端为何先滤掉未核实）。
- `server/services/tool-loading-service.ts`：`auto` 模式的 MCP 服务器按单个工具加入 ToolSearch 候选（标记 `mcpToolMarker`），`resident` 的服务器在新会话预载其工具，`disabled` 的不进入；见 [工具体系](tools/index.md)。

## 改它时
- 新增 MCP 配置字段：改 `server/lib/mcp/` 的配置类型与 `routes/mcp.ts` 的投影（投影只含键名不含值），同步前端 `useMcp.ts`、`mcp-json-draft.ts`（表单与 JSON 视图往返不得丢字段），以及管理员工具 `tools/mcp-admin.ts`。
- 加载模式与 `enabled` 冲突必须拒绝（`shared/mcp-loading-mode.ts`），读时才推导；MCP 工具名 `mcp__<服务器>__<工具>` 的清洗与长度预算在 `tool-bridge.ts`，改它会影响所有提供商的名称规则（`^[a-zA-Z0-9_-]+$`）。
- OAuth 后台连接只能用已存令牌、不能发起授权；新增连接入口时不要绕开 `McpAuthorizationRequiredError`。
- 测试：`tests/server/lib/mcp-manager-protocol.test.ts`、`mcp-manager-refresh.test.ts`、`mcp-oauth.test.ts`、`mcp-stdio-transport.test.ts`、`mcp-tool-bridge.test.ts`，`tools/__tests__/mcp-admin.test.ts`。

## 相关
- [工具体系](tools/index.md)
