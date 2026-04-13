import { db } from "@server/db";
import { narratorMessages, narratorToolCalls } from "@server/db/schema";
import { eq } from "drizzle-orm";

export interface UsageData {
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens?: number;
	cacheCreationInputTokens?: number;
	cacheCreation5mInputTokens?: number;
	cacheCreation1hInputTokens?: number;
	reasoningTokens?: number;
}

export interface CostData {
	inputCost: number;
	outputCost: number;
	cacheCreationCost: number;
	cacheReadCost: number;
	totalCost: number;
}

export function buildUsageDataFromSnapshot(snapshot?: {
	inputTokens?: number;
	completionTokens?: number;
	cachedInputTokens?: number;
	cacheCreationInputTokens?: number;
	cacheCreation5mTokens?: number;
	cacheCreation1hTokens?: number;
	reasoningTokens?: number;
}): UsageData | null {
	if (!snapshot) return null;
	if (
		snapshot.inputTokens == null &&
		snapshot.completionTokens == null &&
		snapshot.cachedInputTokens == null &&
		snapshot.cacheCreationInputTokens == null
	) {
		return null;
	}
	return {
		inputTokens: snapshot.inputTokens ?? 0,
		outputTokens: snapshot.completionTokens ?? 0,
		cachedInputTokens: snapshot.cachedInputTokens ?? 0,
		cacheCreationInputTokens: snapshot.cacheCreationInputTokens ?? 0,
		cacheCreation5mInputTokens: snapshot.cacheCreation5mTokens ?? 0,
		cacheCreation1hInputTokens: snapshot.cacheCreation1hTokens ?? 0,
		reasoningTokens: snapshot.reasoningTokens ?? 0,
	};
}

/**
 * 从 usage 数据计算费用
 * 价格参考 Anthropic 和 OpenAI 的定价（2024年）
 */
export function calculateCost(usage: UsageData, _provider: string, model: string): CostData | null {
	// 简化的价格表（实际应该从配置或数据库读取）
	const pricing: Record<
		string,
		{ input: number; output: number; cacheRead: number; cacheWrite: number }
	> = {
		// Anthropic Claude 3.5 Sonnet (per 1M tokens)
		"claude-3-5-sonnet": {
			input: 3.0,
			output: 15.0,
			cacheRead: 0.3,
			cacheWrite: 3.75,
		},
		// OpenAI GPT-4o (per 1M tokens)
		"gpt-4o": {
			input: 2.5,
			output: 10.0,
			cacheRead: 1.25,
			cacheWrite: 0,
		},
	};

	// 查找匹配的价格（简单匹配模型名称前缀）
	let modelPricing = null;
	for (const [key, value] of Object.entries(pricing)) {
		if (model.toLowerCase().includes(key)) {
			modelPricing = value;
			break;
		}
	}

	if (!modelPricing) {
		return null;
	}

	const inputCost = (usage.inputTokens / 1_000_000) * modelPricing.input;
	const outputCost = (usage.outputTokens / 1_000_000) * modelPricing.output;
	const cacheReadCost = ((usage.cachedInputTokens || 0) / 1_000_000) * modelPricing.cacheRead;
	const cacheCreationCost =
		((usage.cacheCreationInputTokens || 0) / 1_000_000) * modelPricing.cacheWrite;

	return {
		inputCost,
		outputCost,
		cacheCreationCost,
		cacheReadCost,
		totalCost: inputCost + outputCost + cacheCreationCost + cacheReadCost,
	};
}

/**
 * 更新工具调用的 token 使用和费用信息
 */
export async function updateToolCallUsage(
	toolCallId: string,
	usage: UsageData,
	provider: string,
	model: string,
): Promise<void> {
	const cost = calculateCost(usage, provider, model);

	const updateData: Record<string, unknown> = {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cachedInputTokens || 0,
		cacheCreationTokens: usage.cacheCreationInputTokens || 0,
		cacheCreation5mTokens: usage.cacheCreation5mInputTokens || 0,
		cacheCreation1hTokens: usage.cacheCreation1hInputTokens || 0,
		provider,
		model,
	};

	if (cost) {
		updateData.inputCost = cost.inputCost;
		updateData.outputCost = cost.outputCost;
		updateData.cacheCreationCost = cost.cacheCreationCost;
		updateData.cacheReadCost = cost.cacheReadCost;
		updateData.totalCost = cost.totalCost;
	}

	await db.update(narratorToolCalls).set(updateData).where(eq(narratorToolCalls.id, toolCallId));
}

export async function updateMessageUsage(
	messageId: string,
	usage: UsageData,
	provider: string,
	model: string,
): Promise<void> {
	const cost = calculateCost(usage, provider, model);
	await db
		.update(narratorMessages)
		.set({
			provider,
			model,
			tokensIn: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cachedInputTokens: usage.cachedInputTokens ?? 0,
			cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
			cacheCreation5mTokens: usage.cacheCreation5mInputTokens ?? 0,
			cacheCreation1hTokens: usage.cacheCreation1hInputTokens ?? 0,
			reasoningTokens: usage.reasoningTokens ?? 0,
			...(cost ? { costUsd: cost.totalCost } : {}),
		})
		.where(eq(narratorMessages.id, messageId));
}

/**
 * 从 Anthropic usage 对象提取 token 数据
 */
export function extractAnthropicUsage(usage: {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}): UsageData {
	// 尝试从嵌套对象中提取 5m/1h 缓存明细（如果存在）
	// biome-ignore lint/suspicious/noExplicitAny: dynamic structure
	const cacheCreation = (usage as any).cache_creation;
	const cache5m = cacheCreation?.ephemeral_5m_input_tokens || 0;
	const cache1h = cacheCreation?.ephemeral_1h_input_tokens || 0;

	return {
		inputTokens: usage.input_tokens,
		outputTokens: usage.output_tokens,
		cachedInputTokens: usage.cache_read_input_tokens || 0,
		cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
		cacheCreation5mInputTokens: cache5m,
		cacheCreation1hInputTokens: cache1h,
	};
}

/**
 * 从 OpenAI usage 对象提取 token 数据
 */
export function extractOpenAIUsage(usage: {
	prompt_tokens: number;
	completion_tokens: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
	};
	completion_tokens_details?: {
		reasoning_tokens?: number;
	};
}): UsageData {
	return {
		inputTokens: usage.prompt_tokens,
		outputTokens: usage.completion_tokens,
		cachedInputTokens: usage.prompt_tokens_details?.cached_tokens || 0,
		reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || 0,
	};
}
