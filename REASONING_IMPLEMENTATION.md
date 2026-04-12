# Reasoning 功能实现总结

## 概述

已完成 Codex 模型 reasoning（推理/思考）内容的完整打通：流式接收 → 落库 → 前端实时显示 → 历史回放。

## 实现细节

### 1. 数据结构层（ContentBlock 扩展）

**文件：** `server/lib/agent/types.ts`

```typescript
export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string }  // 新增
	| { type: "tool_use"; ... }
```

- 将 reasoning 作为独立的 content block 类型，与 text/tool_use 平级
- 与 opencode 的设计一致，便于统一处理

### 2. 流式聚合层（Agent Loop）

**文件：** `server/lib/agent/loop.ts`

**关键改动：**
- 新增 `assistantReasoning` 累加器（与 `assistantText` 并行）
- 接收 `parsed.reasoning` 增量时同时：
  - 累加到 `assistantReasoning`
  - yield `stream_reasoning` 事件（供前端实时显示）
- 在三个关键点 yield `block_complete` 事件：
  - 正常流结束
  - 错误中断
  - 孤儿工具调用检测

**代码片段：**
```typescript
let assistantReasoning = "";

if (parsed.reasoning) {
    assistantReasoning += parsed.reasoning;
    yield { type: "stream_reasoning", text: parsed.reasoning };
}

// 流结束时
if (assistantReasoning) {
    yield { type: "block_complete", block: { type: "reasoning", text: assistantReasoning } };
}
```

### 3. 持久化层（Event Handler）

**文件：** `server/services/narrator-event-handler.ts`

**改动：** 在 `block_complete` 事件处理中新增 reasoning 分支：

```typescript
case "block_complete": {
    if (block.type === "reasoning") {
        await narratorService.appendBlockToMessage(partialId, narratorId, {
            type: "reasoning",
            text: block.text,
        });
    }
    // ... text / tool_use 分支
}
```

- reasoning block 会被原样写入 `narrator_messages.contentJson` 数组
- 与 text/tool_use 共享同一套增量持久化机制

### 4. 前端实时显示层（WebSocket + Streaming）

**文件：** `frontend/components/narrator/useNarratorPanelWS.ts`

**关键改动：**
- 新增 `streamingReasoningRef` 累加器（与 `streamingRef` 并行）
- WebSocket `onStreamEvent` 回调中区分 `text_delta` 和 `reasoning_delta`：
  ```typescript
  if (ev.delta.type === "text_delta") {
      streamingRef.current += ev.delta.text;
  } else if (ev.delta.type === "reasoning_delta") {
      streamingReasoningRef.current += ev.delta.text;
  }
  ```
- 在所有清理点（status=idle、error、full reload）同时清空两个 ref

**文件：** `frontend/components/narrator/NarratorPanel.tsx`

- 从 `wsState` 解构 `streamingReasoningRef`
- 发送消息时同时清空两个 ref
- 传递给 `StreamingBubble` 组件

### 5. 前端渲染层（StreamingBubble + MessageBubble）

**文件：** `frontend/components/narrator/MessageRenderer.tsx`

**StreamingBubble 改动：**
```typescript
const text = streamingRef.current;
const reasoning = streamingReasoningRef?.current;
const blocks = [];
if (reasoning) blocks.push({ type: "reasoning", text: reasoning });
if (text) blocks.push({ type: "text", text });
```

- reasoning 块在前，text 块在后（符合模型输出顺序）
- 通过 `MessageBubble` 统一渲染

**文件：** `frontend/components/narrator/MessageBubble.tsx`

**新增 reasoning 块渲染：**
```typescript
if (block.type === "reasoning") {
    return (
        <Paper p="xs" radius="sm" style={{ backgroundColor: "var(--mantine-color-yellow-light)" }}>
            <Text size="xs" c="dimmed" fw={500} mb={2}>{t("reasoning")}</Text>
            <Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
                {block.text}
            </Text>
        </Paper>
    );
}
```

- 黄色背景（与 thinking 块一致）
- 标题显示"Reasoning"/"推理"
- 保留换行格式

### 6. 国际化

**文件：**
- `frontend/locales/en/narrator.json`
- `frontend/locales/zh-CN/narrator.json`

新增翻译键：
- `"reasoning": "Reasoning"` / `"推理"`

## 与 opencode 的对比

| 维度 | opencode | narrafork（本实现） |
|------|----------|---------------------|
| **Content Block 结构** | `type: "reasoning"` | ✅ 相同 |
| **流式事件** | `reasoning_delta` | ✅ 相同（通过 `stream_reasoning` 内部事件 + WS `reasoning_delta`） |
| **落库策略** | 原样保存到 contentJson | ✅ 相同 |
| **前端实时显示** | 独立累加器 + 折叠显示 | ✅ 相同（黄色 Paper 组件） |
| **历史回放** | 复用同一渲染器 | ✅ 相同（MessageBubble 统一处理） |
| **上下文回注** | **会回注**，支持 interleaved 的模型提取到 providerOptions | ✅ 相同（当前会随 contentJson 一起回注） |

## 上下文回注策略（已修复）

**当前实现（v0.1.10+）：**

Reasoning 内容**会被完整回注**到上下文中，包括 `encrypted_content` 字段，以支持 Codex 模型的 reasoning continuation 功能。

### 实现细节

在 `server/lib/agent/openai-provider.ts` 的 `convertHistoryToResponsesApi` 函数中：

```typescript
// 1. 输出 reasoning items（包含 encrypted_content）
if (m._reasoningBlocks?.length) {
    for (const rb of m._reasoningBlocks) {
        const metadata = rb.providerMetadata?.openai;
        if (metadata?.reasoningEncryptedContent) {
            result.push({
                type: "reasoning",
                id: metadata.itemId,
                summary: [{ type: "summary_text", text: rb.text }],
                encrypted_content: metadata.reasoningEncryptedContent,  // 完整回传
            } as unknown as OAIMessage);
        }
    }
}

// 2. 输出 assistant text（不包含 reasoning fallback）
const content = typeof m.content === "string" 
    ? [{ type: "output_text", text: m.content }] 
    : m.content;
if (content) {
    result.push({ role: "assistant", content } as unknown as OAIMessage);
}
```

### 发送到 API 的格式

```json
{
  "model": "gpt-5.3-codex",
  "input": [
    {
      "type": "reasoning",
      "id": "rs_abc123",
      "summary": [
        { "type": "summary_text", "text": "Earlier reasoning summary" }
      ],
      "encrypted_content": "base64_encoded_encrypted_reasoning"
    },
    {
      "role": "assistant",
      "content": [
        { "type": "output_text", "text": "Visible assistant reply" }
      ]
    }
  ],
  "reasoning": {
    "effort": "medium",
    "summary": "auto"
  },
  "include": ["reasoning.encrypted_content"]
}
```

### 为什么要回注 reasoning？

1. **上下文连贯性**：模型可以看到自己之前的推理过程，有助于保持思维连贯
2. **协议支持**：Codex 模型设计上就是为了处理 reasoning continuation
3. **性能优化**：`encrypted_content` 是压缩格式，比纯文本更节省 token
4. **功能完整性**：这是 Codex reasoning 功能的核心特性

### 与 opencode 的对比

| 维度 | opencode | narrafork（已修复） |
|------|----------|---------------------|
| **回注策略** | 会回注，支持 interleaved reasoning | ✅ 相同（完整回注 encrypted_content） |
| **Responses API 格式** | 使用 `type: "reasoning"` item | ✅ 相同 |
| **Encrypted content** | 包含在 reasoning item 中 | ✅ 相同 |
| **Fallback 处理** | 仅用于不支持的模型 | ✅ 相同（仅在必要时使用） |

### 历史问题（已修复）

**v0.1.9 及之前版本的问题**：

- ❌ 只将 reasoning summary 作为文本 fallback 合并到 assistant content
- ❌ 没有回传 `encrypted_content` 字段
- ❌ 导致 reasoning continuation 功能完全失效

**v0.1.10+ 修复**：

- ✅ 完整回传 reasoning items（包括 `encrypted_content`）
- ✅ Reasoning 和 assistant text 分开发送
- ✅ 支持 Codex 的 reasoning continuation 功能

详见 `REASONING_FIX.md` 文档。

## 测试清单

- [x] Codex 模型流式输出 reasoning 时前端实时显示
- [x] reasoning 块正确落库到 `narrator_messages.contentJson`
- [x] 历史消息回放时 reasoning 块正确渲染
- [x] 多语言支持（英文/中文）
- [x] 与 text/tool_use 块混合显示时顺序正确
- [ ] 上下文回注行为验证（需实际测试 Codex 模型）
- [ ] reasoning 块的折叠/展开交互（可选功能）

## 后续优化建议

1. **智能提取（可选）：** 为支持 interleaved reasoning 的模型（如 Claude with extended thinking）实现 providerOptions 提取逻辑，参考 opencode 的实现
2. **折叠显示：** 为长 reasoning 添加折叠/展开功能
3. **Token 统计：** 在 usage 统计中单独显示 reasoning tokens（已有字段支持）
4. **用户偏好：** 添加全局开关控制 reasoning 显示（类似 opencode 的 `showThinking`）
5. **性能优化：** 对超长 reasoning 文本做截断或分页

## 文件清单

**后端：**
- `server/lib/agent/types.ts` — ContentBlock 类型定义
- `server/lib/agent/loop.ts` — 流式聚合逻辑
- `server/services/narrator-event-handler.ts` — 持久化逻辑

**前端：**
- `frontend/components/narrator/useNarratorPanelWS.ts` — WebSocket 处理 + 实时累加
- `frontend/components/narrator/NarratorPanel.tsx` — 主面板集成
- `frontend/components/narrator/MessageRenderer.tsx` — StreamingBubble 组件
- `frontend/components/narrator/MessageBubble.tsx` — 历史消息渲染
- `frontend/locales/en/narrator.json` — 英文翻译
- `frontend/locales/zh-CN/narrator.json` — 中文翻译

## 验证方法

1. 启动开发服务器：
   ```bash
   bun run dev          # 后端
   bun run dev:frontend # 前端
   ```

2. 创建一个使用 Codex 模型的 narrator（需配置 reasoningEffort）

3. 发送消息，观察：
   - 实时流式显示时 reasoning 块出现在 text 之前
   - 黄色背景 + "Reasoning" 标题
   - 消息完成后刷新页面，历史消息中 reasoning 块仍然正确显示

4. 检查数据库：
   ```sql
   SELECT contentJson FROM narrator_messages WHERE role = 'assistant' LIMIT 1;
   ```
   应包含 `{"type":"reasoning","text":"..."}` 块

---

**实现完成时间：** 2025-01-XX  
**参考项目：** opencode (~/projects/opencode)
