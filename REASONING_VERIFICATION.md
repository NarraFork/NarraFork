# Reasoning 实现验证报告

## 验证时间
2026-04-12

## 验证目标
确保 narrafork 的 reasoning 处理与 codex 完全一致。

## 验证方法

### 1. 代码对比分析

**Codex 实现**：
- `get_formatted_input()` 直接返回 `Vec<ResponseItem>`
- `ResponseItem::Reasoning` 通过 serde 自动序列化
- 包含字段：`type`, `id`, `summary`, `encrypted_content`

**Narrafork 实现**：
- `buildHistory()` 提取 reasoning blocks 到 `_reasoningBlocks`
- `convertHistoryToResponsesApi()` 将 reasoning blocks 转换为 Responses API 格式
- 输出相同字段：`type`, `id`, `summary`, `encrypted_content`

### 2. 格式验证测试

#### 测试 1：基础 reasoning + text

**输入**：
```json
{
  "contentJson": [
    {
      "type": "reasoning",
      "text": "I need to analyze the user's request carefully.",
      "providerMetadata": {
        "openai": {
          "itemId": "rs_abc123",
          "reasoningEncryptedContent": "ZW5jcnlwdGVkX2NvbnRlbnRfaGVyZQ=="
        }
      }
    },
    {
      "type": "text",
      "text": "Here's my response to your question."
    }
  ]
}
```

**输出**：
```json
[
  {
    "type": "reasoning",
    "id": "rs_abc123",
    "summary": [
      {
        "type": "summary_text",
        "text": "I need to analyze the user's request carefully."
      }
    ],
    "encrypted_content": "ZW5jcnlwdGVkX2NvbnRlbnRfaGVyZQ=="
  },
  {
    "role": "assistant",
    "content": [
      {
        "type": "output_text",
        "text": "Here's my response to your question."
      }
    ]
  }
]
```

**结果**：✅ 与 codex 格式完全匹配

#### 测试 2：Reasoning + text + tool calls

**输入**：
```json
{
  "contentJson": [
    {
      "type": "reasoning",
      "text": "I should read the file first to understand its contents.",
      "providerMetadata": {
        "openai": {
          "itemId": "rs_xyz789",
          "reasoningEncryptedContent": "YW5vdGhlcl9lbmNyeXB0ZWRfY29udGVudA=="
        }
      }
    },
    {
      "type": "text",
      "text": "Let me check the file contents."
    }
  ],
  "toolCalls": [
    {
      "toolUseId": "call_abc123",
      "toolName": "Read",
      "inputJson": { "file_path": "/path/to/file.txt" },
      "status": "success"
    }
  ]
}
```

**输出顺序**：
1. `type: "reasoning"` (with encrypted_content)
2. `role: "assistant"` (with text)
3. `type: "function_call"` (tool call)

**结果**：✅ 顺序正确，所有字段完整

#### 测试 3：纯 reasoning（无 text）

**输入**：
```json
{
  "contentJson": [
    {
      "type": "reasoning",
      "text": "Pure reasoning without any visible text.",
      "providerMetadata": {
        "openai": {
          "itemId": "rs_pure",
          "reasoningEncryptedContent": "cHVyZV9yZWFzb25pbmc="
        }
      }
    }
  ],
  "contentText": null
}
```

**输出**：
```json
[
  {
    "type": "reasoning",
    "id": "rs_pure",
    "summary": [
      {
        "type": "summary_text",
        "text": "Pure reasoning without any visible text."
      }
    ],
    "encrypted_content": "cHVyZV9yZWFzb25pbmc="
  }
]
```

**结果**：✅ 正确处理纯 reasoning 场景

### 3. 单元测试验证

运行 `bun test server/lib/agent/__tests__/openai-provider-history.test.ts`：

```
✓ buildHistory includes reasoning items with encrypted_content for continuation
✓ buildHistory handles assistant message with reasoning but no text
✓ pushAssistantTurn prepends reasoning fallback for current responses history

3 pass, 0 fail
```

### 4. 完整测试套件

运行 `bun test server/lib/agent/__tests__/`：

```
476 pass, 0 fail
```

## 关键验证点

| 验证项 | Codex | Narrafork | 状态 |
|--------|-------|-----------|------|
| **Reasoning item 结构** | `type`, `id`, `summary`, `encrypted_content` | ✅ 相同 | ✅ |
| **Summary 格式** | `[{type: "summary_text", text: "..."}]` | ✅ 相同 | ✅ |
| **Encrypted content 回传** | ✅ 包含在 input 数组 | ✅ 包含在 input 数组 | ✅ |
| **顺序** | reasoning → assistant → function_call | ✅ 相同 | ✅ |
| **纯 reasoning 处理** | ✅ 支持 | ✅ 支持 | ✅ |
| **Reasoning + tool calls** | ✅ 支持 | ✅ 支持 | ✅ |
| **请求参数** | `include: ["reasoning.encrypted_content"]` | ✅ 相同 | ✅ |
| **Reasoning effort** | `reasoning: {effort, summary}` | ✅ 相同 | ✅ |

## 与 Codex 的差异

### 实现方式差异

**Codex (Rust)**：
- 使用 `ResponseItem` enum，serde 自动序列化
- 直接将 `Vec<ResponseItem>` 作为 input

**Narrafork (TypeScript)**：
- 从 DB 读取 `contentJson`，提取 reasoning blocks
- 在 `convertHistoryToResponsesApi` 中手动构建 reasoning items
- 输出格式与 codex 完全一致

### 功能等价性

虽然实现方式不同，但**输出格式完全一致**：
- ✅ 相同的 JSON 结构
- ✅ 相同的字段名称
- ✅ 相同的数据类型
- ✅ 相同的顺序

## 结论

✅ **Narrafork 的 reasoning 实现与 codex 完全一致**

1. **格式匹配**：输出的 JSON 结构与 codex 完全相同
2. **字段完整**：所有必需字段（type, id, summary, encrypted_content）都正确包含
3. **顺序正确**：reasoning → assistant → function_call 的顺序符合预期
4. **边界情况**：纯 reasoning、reasoning + text、reasoning + tool calls 都正确处理
5. **测试覆盖**：所有单元测试和集成测试通过

## 验证脚本

以下脚本可用于持续验证：

1. `scripts/verify-reasoning-fix.ts` - 基础验证
2. `scripts/compare-reasoning-format.ts` - 格式对比
3. `scripts/test-reasoning-complex.ts` - 复杂场景测试
4. `scripts/test-pure-reasoning.ts` - 纯 reasoning 测试

运行方式：
```bash
bun run scripts/verify-reasoning-fix.ts
bun run scripts/compare-reasoning-format.ts
bun run scripts/test-reasoning-complex.ts
bun run scripts/test-pure-reasoning.ts
```

## 修复前后对比

### 修复前（v0.1.9）

```typescript
// ❌ 错误：只将 reasoning 作为文本 fallback
const content = mergeAssistantTextWithReasoningFallback(
    m.content, 
    m._reasoningTextFallback  // 只是摘要文本
);
result.push({ role: "assistant", content });
```

**问题**：
- 没有 `type: "reasoning"` item
- 没有 `encrypted_content` 字段
- Reasoning continuation 功能失效

### 修复后（v0.1.10+）

```typescript
// ✅ 正确：输出完整的 reasoning item
if (m._reasoningBlocks?.length) {
    for (const rb of m._reasoningBlocks) {
        const metadata = rb.providerMetadata?.openai;
        if (metadata?.reasoningEncryptedContent) {
            result.push({
                type: "reasoning",
                id: metadata.itemId,
                summary: [{ type: "summary_text", text: rb.text }],
                encrypted_content: metadata.reasoningEncryptedContent,
            });
        }
    }
}
```

**改进**：
- ✅ 完整的 reasoning item
- ✅ 包含 encrypted_content
- ✅ Reasoning continuation 正常工作

---

**验证日期**：2026-04-12  
**状态**：✅ 通过
