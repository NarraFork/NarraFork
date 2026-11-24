---
id: agent
title: 代理运行时
summary: 自定义 Agent Loop、多模型提供商、工具体系、子代理与执行后端。
anchors: []
status: stub
verified_at: null
---
# 代理运行时

> 待填写：自定义 Agent Loop、多模型提供商、工具体系、子代理与执行后端。

## 下面有什么

- [Agent Loop](loop.md)：一轮请求如何构造历史、流式处理、工具调用与重试。
- [模型提供商](providers.md)：Anthropic / OpenAI / Gemini / Codex / NUG 等适配，历史构造与图片处理差异。
- [凭证池与模型目录](credentials-models.md)：凭证池、模型目录、模型来源。
- [工具体系](tools/index.md)：工具注册、可选工具加载、工具搜索；各类工具的职责。
- [子代理](subagents.md)：Task 工具、模板、嵌套两层、委派深度、子代理资源。
- [执行后端](execution.md)：工具在哪执行：本地、远程设备；路径语义。
- [MCP 集成](mcp.md)：MCP 服务器接入与工具暴露。
- [程序化执行与沙箱](programmatic.md)：程序化工具调用、沙箱与 VM 运行时。
- [用量与费用](usage.md)：api_requests、token 记账、费用、额度。
