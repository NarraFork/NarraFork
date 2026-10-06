# Agent Provider 注意事项

## Anthropic 历史构造的两处易错点

`buildAnthropicHistory`（`server/lib/agent/anthropic-provider.ts`）有两处做错了不会报错、只会静默降低质量的地方：

1. **尾部 `sys` 行必须提到当前轮**（`trailingUserText`）。Dynamic Spec 提醒、目标续跑这类注入若留在历史末尾，模型会当作背景而非「刚被问到的事」。做错**只表现为模型重视程度下降**，没有任何错误信号。
   **只在 `officialApi: false` 时提取**：官方 API 路径把 `sys` 映射为 `role:"system"`（Claude Code 的刻意行为，本身已表达「常驻指令」），不可改写。

2. **历史图片的 `imageId` 必须从磁盘还原。** 存储的消息只有 imageId，字节在上传者的目录下。该函数原本只读 text 块，**历史里的图片全部丢失**——追问一张早前的截图时，模型收到的请求里什么都没有（`openai-provider.ts` 是另一条做对了的路径）。
   失败一律跳过并记 WARN（文件被清理、读不出、owner 未知）：丢一张图不好，但为一张被清理的旧图让整轮失败更糟。

## NUG 网关事件与图片去重

- **gateway 事件**：NUG 用自有事件名下发排队状态、配额余额、模型目录与图片缓存确认，在 `shared/agent-protocol/gateway-events.ts` 里解析。`AnthropicProvider` / `OpenAIProvider` 的 SSE 循环有泛化的 gateway 事件短路（走 `isGatewayEventType`），新增事件名无需改动它们。
- **图片去重的形状按 delegate 判定，不按渠道名**：`chat()` 里的 `dedupHistory` 分派用 `delegate instanceof AnthropicProvider` 而非渠道名。按渠道名分派会让某些组合走错形状的遍历器，**找不到任何图片从而静默停用去重**，症状是每轮重传全部图片——看起来像网关问题。
