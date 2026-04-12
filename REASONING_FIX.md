# Reasoning Encrypted Content 修复

## 问题描述

在之前的实现中，narrafork 在处理 Codex 模型的 reasoning 功能时存在严重缺陷：

### 核心问题

**没有将 `encrypted_content` 回传给 API**

虽然系统正确地：
1. 请求时设置了 `include: ["reasoning.encrypted_content"]`
2. 接收并保存了 `encrypted_content` 到数据库
3. 在前端正确显示了 reasoning summary

但在构建历史请求时，**完全没有**将 `encrypted_content` 作为 Responses API 的 `reasoning` item 回传给模型。

### 错误实现

```typescript
// 旧实现：只将 reasoning summary 作为文本 fallback 合并到 assistant content
const content = mergeAssistantTextWithReasoningFallback(
    m.content, 
    m._reasoningTextFallback  // 只是文本摘要
);
```

### 后果

1. **上下文丢失**：模型无法看到之前的完整推理过程，只能看到摘要文本
2. **推理连贯性差**：每次请求都是"新的"推理，无法基于之前的深度思考继续
3. **Token 浪费**：摘要文本作为普通 assistant text 发送，占用更多 token 且效果更差
4. **功能失效**：Codex 的 reasoning continuation 功能完全无法工作

## 修复方案

### 1. 修改 `convertHistoryToResponsesApi` 函数

在转换 assistant 消息时，正确输出 reasoning items：

```typescript
// 新实现：输出完整的 reasoning item
if (m._reasoningBlocks?.length) {
    for (const rb of m._reasoningBlocks) {
        const metadata = rb.providerMetadata?.openai;
        if (metadata?.reasoningEncryptedContent) {
            result.push({
                type: "reasoning",
                id: metadata.itemId,
                summary: [{ type: "summary_text", text: rb.text }],
                encrypted_content: metadata.reasoningEncryptedContent,  // 关键！
            } as unknown as OAIMessage);
        }
    }
}
```

### 2. 修改 `buildOAIHistory` 函数

确保包含 reasoning blocks 的消息不会被跳过：

```typescript
const hasReasoningBlocks = reasoningBlocks.length > 0;
if (!hasText && toolCalls.length === 0 && !hasReasoningBlocks) {
    // 只有在没有 text、tool_calls 和 reasoning 时才跳过
    continue;
}
```

### 3. 更新测试

修改测试用例以验证新行为：

```typescript
test("buildHistory includes reasoning items with encrypted_content for continuation", async () => {
    // 验证 reasoning item 被正确包含
    expect(historyJson).toContain('"type":"reasoning"');
    expect(historyJson).toContain('"encrypted_content":"enc_123"');
});
```

## 正确的 Responses API 格式

修复后，发送给 API 的历史格式为：

```json
[
  {
    "type": "reasoning",
    "id": "rs_123",
    "summary": [
      { "type": "summary_text", "text": "Earlier reasoning summary" }
    ],
    "encrypted_content": "base64_encoded_encrypted_content"
  },
  {
    "role": "assistant",
    "content": [
      { "type": "output_text", "text": "Visible assistant reply" }
    ]
  }
]
```

## 参考实现

修复参考了 codex-rs 的实现：

1. **请求时**：`include: ["reasoning.encrypted_content"]`
2. **接收时**：保存 `encrypted_content` 到 `providerMetadata.openai.reasoningEncryptedContent`
3. **回传时**：将完整的 reasoning item（包括 `encrypted_content`）放入 `input` 数组

## 验证方法

1. **检查请求日志**：确认发送到 API 的 `input` 数组包含 `type: "reasoning"` 的 items
2. **检查字段存在**：确认 `encrypted_content` 字段存在且非空
3. **测试多轮对话**：观察模型的推理连贯性是否改善
4. **运行单元测试**：`bun test server/lib/agent/__tests__/openai-provider-history.test.ts`

## 影响范围

- **文件修改**：
  - `server/lib/agent/openai-provider.ts`
  - `server/lib/agent/__tests__/openai-provider-history.test.ts`

- **功能影响**：
  - 所有使用 Codex 模型且启用 reasoning 的 narrator
  - 多轮对话中的推理连贯性
  - Reasoning token 的正确计费

## 测试结果

```bash
✓ buildHistory includes reasoning items with encrypted_content for continuation
✓ buildHistory handles assistant message with reasoning but no text
✓ pushAssistantTurn prepends reasoning fallback for current responses history

3 pass, 0 fail
```

## 后续优化建议

1. **添加日志**：在发送请求前记录 reasoning items 的数量和大小
2. **监控指标**：跟踪 reasoning token 使用情况
3. **性能优化**：考虑对超长 reasoning 进行压缩或摘要
4. **用户配置**：添加开关控制是否回传 reasoning（默认开启）

---

**修复时间**：2026-04-12  
**参考项目**：codex-rs (~/projects/codex)
