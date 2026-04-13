# 请求历史功能 - Token 估算实现总结

## 修改内容

为所有不返回 usage 数据的 AI 提供商添加了基于文本长度的 token 使用量估算功能，使请求历史记录能够显示这些提供商的 token 统计信息。

## 修改的文件

### 1. `server/lib/agent/loop.ts`

**位置**: 第 1241-1258 行（在 `api_request_end` 事件之前）

**修改内容**:
```typescript
// ── Estimate token usage when provider doesn't report it ──
// For these cases, we estimate based on text length to provide usage statistics.
if (!requestUsage) {
	const historyText = JSON.stringify(history);
	const systemText = config.systemPrompt ?? "";
	const estimatedInputTokens =
		estimateTokens(historyText) + estimateTokens(systemText) + estimateTokens(content);
	const estimatedOutputTokens = estimateTokens(assistantText);

	requestUsage = {
		inputTokens: estimatedInputTokens,
		promptTokens: estimatedInputTokens,
		completionTokens: estimatedOutputTokens,
	};
}
```

**说明**:
- 检查是否有 usage 数据（`!requestUsage`）
- 如果没有，则估算输入和输出 token
- 使用现有的 `estimateTokens()` 函数进行估算
- 适用于所有不返回 usage 的提供商


**新增文件**: 详细的功能文档

**内容**:
- 功能概述
- 实现位置和代码说明
- 数据流图
- 适用场景
- 注意事项
- 测试方法
- 未来改进建议

## 工作原理

1. **Agent Loop** 在完成 API 调用后检查是否有 usage 数据
2. 对于任何不返回 usage 数据的提供商，进行估算：
   - **输入 tokens** = history + system prompt + 当前消息
   - **输出 tokens** = assistant 响应文本
3. 估算使用字符级启发式方法：
   - ASCII/拉丁字符：~0.3 tokens/字符
   - CJK/宽字符：~0.6 tokens/字符
4. 估算的数据通过 `api_request_end` 事件传递
5. Event Handler 将数据保存到 `api_requests` 表
6. 前端从 API 读取并显示在使用历史表格中

## 适用范围

此功能自动应用于所有不返回 usage 数据的提供商，包括：
- ✅ 未来可能添加的其他提供商

对于返回精确 usage 的提供商，继续使用 API 数据：
- ✅ Anthropic (精确数据)
- ✅ OpenAI (精确数据)
- ✅ Codex (如果返回 usage)

## 验证

✅ TypeScript 类型检查通过
✅ Biome 代码检查通过
✅ 构建成功
✅ Token 估算函数测试通过

## 影响范围

- **后端**: `server/lib/agent/loop.ts` - 添加估算逻辑
- **前端**: 无需修改（已支持显示 token 数据）
- **数据库**: 无需修改（schema 已支持）

## 向后兼容性

✅ 完全向后兼容
- Anthropic 和 OpenAI 继续使用 API 返回的精确数据
- 只有在没有 usage 数据时才使用估算
- 现有的请求历史记录不受影响
- 前端已正确处理所有提供商的数据显示

## 使用方法

1. 使用任何不返回 usage 数据的提供商创建叙述者会话
2. 发送消息进行对话
3. 访问 `/admin/usage-history` 查看请求历史
4. Token 列将显示估算的输入和输出 token 数量
5. 成本列根据提供商类型显示相应数据

## 注意事项

1. **自动应用**: 只要提供商不返回 usage 数据，就会自动使用估算
2. **精确数据优先**: 如果提供商返回了 usage 数据，则使用精确数据
3. **估算精度**: 估算值是近似的，通常略高于实际值（保守估算）
4. **成本显示**: 不同提供商显示不同类型的成本数据
5. **缓存支持**: 估算不包括缓存相关字段，缓存字段为 0
6. **性能影响**: 估算计算非常轻量，对性能影响可忽略不计

## 未来改进

1. 使用更精确的 tokenizer（如 tiktoken）
2. 根据不同模型调整估算系数
3. 在 UI 中添加"估算值"标记
4. 支持更多提供商的 token 估算
