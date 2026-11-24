---
id: agent
title: 代理运行时
summary: 自定义 Agent Loop、多模型提供商、工具体系、子代理与执行后端。
anchors:
  - server/lib/agent/index.ts
keywords:
  - Agent Loop
  - 代理运行时
  - agentLoop
  - ProviderAdapter
  - 工具注册
  - 子代理
  - 执行后端
  - MCP
  - Eval
  - 用量
  - 凭证池
  - server/lib/agent
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 代理运行时

叙述者的“大脑”：一个自己实现的 Agent Loop，加上围绕它的模型适配、工具、委派与隔离执行。代码主要在 `server/lib/agent/`，业务侧配套在 `server/services/`。

怎么配合：
- 宿主（叙述者服务）把数据库里的消息行交给循环，循环经 `buildAdapterHistory` 投影出请求历史，调用由 `provider.ts` 解析出的提供商适配器流式取回模型输出（见 [Agent Loop](loop.md)、[模型提供商](providers/index.md)）。多密钥连接由池包装器在密钥层面选择与降级（见 [凭证池与存储](credentials.md)；额度见 [供应商余额与额度](provider-quota.md)），模型能力与价格取自目录卡（见 [模型目录与来源](model-catalog/index.md)）。
- 模型发出的 tool_use 由 `tool-executor.ts` 准入、做权限与目标冻结后，在 [工具体系](tools/index.md) 注册的工具里执行；文件和命令类工具通过 [执行后端](execution.md) 落到本机或远程设备，且远程不可用时不回退本机。可选工具、MCP 工具与按需加载由前缀保持机制处理，MCP 见 [MCP 集成](mcp.md)。
- 委派给 [子代理](subagents.md) 时，只是创建另一条叙述者记录并按模板收紧能力上限，嵌套最多两层；[程序化执行与沙箱](programmatic.md) 目前只有 Eval 工具使用（默认关闭）。
- 每次请求结束，[用量与费用](usage.md) 在一个事务里写明细与汇总。

## 下面有什么

- [Agent Loop](loop.md)：一轮请求如何构造历史、流式处理、工具调用与重试。
- [模型提供商](providers/index.md)：Anthropic / OpenAI / Gemini / Codex / NUG 等适配，历史构造与图片处理差异。
- [凭证池与存储](credentials.md)：多凭证（Codex 账号池、自定义 API 多密钥）的选择、冷却与降级，credentials.json 存储与跨实例搬运。
- [工具体系](tools/index.md)：工具注册、可选工具加载、工具搜索；各类工具的职责。
- [子代理](subagents.md)：Task 工具、模板、嵌套两层、委派深度、子代理资源。
- [执行后端](execution.md)：工具在哪执行：本地、远程设备；路径语义。
- [MCP 集成](mcp.md)：MCP 服务器接入与工具暴露。
- [程序化执行与沙箱](programmatic.md)：程序化工具调用、沙箱与 VM 运行时。
- [用量与费用](usage.md)：api_requests、token 记账、费用、请求录制；额度见供应商额度节点。
- [模型目录与来源](model-catalog/index.md)：模型卡分层解析、目录更新与本地覆盖、来源组、auto 模型列表。
- [模型鉴别（ModelTrace）](modeltrace.md)：向上游发数数挑战、本地检测器打分，判断模型是否货真价实（/modeltrace）。
- [供应商余额与额度](provider-quota.md)：各供应商（Codex、Kimi、DeepSeek、OpenCode Go、NUG、TokenDance、中转站等）的余额与套餐额度查询、缓存、展示，以及额度墙等待。
