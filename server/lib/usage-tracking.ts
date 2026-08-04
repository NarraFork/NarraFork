import { db } from "@server/db";
import { narratorMessages, narratorToolCalls } from "@server/db/schema";
import { eq } from "drizzle-orm";
import { resolveModelPricing } from "./model-pricing";

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
 * Providers whose reported `input_tokens` is the *total* prompt size, cached
 * tokens included. For these, the cached portion must be subtracted before
 * applying the full input rate or those tokens get billed twice — once at the
 * input rate and again at the cache-read rate.
 *
 * Anthropic is the opposite: `input_tokens` already excludes
 * `cache_read_input_tokens` and `cache_creation_input_tokens`, so subtracting
 * would undercount.
 *
 * This set describes token *semantics*, not price coverage: `gemini`, `cline`,
 * `model-pricing.ts` only ships rows for the gpt/claude families. Until an
 * operator adds overrides those requests resolve to no price at all and this
 * subtraction never runs for them — which is intended, not an oversight.
 */
const PROVIDERS_WITH_CACHE_INCLUSIVE_INPUT = new Set([
	"openai",
	"codex",
	"cline",
	"nug",
	"gemini",
]);

/**
 * Attribute a USD cost to one request's token usage using the official
 * reference prices in `model-pricing.ts`.
 *
 * Returns null when the model has no known price, so callers can record "not
 * priced" rather than a misleading 0. For subscription-based access (Codex on a
 * cost through the metered API, not an amount actually billed.
 */
export function calculateCost(usage: UsageData, provider: string, model: string): CostData | null {
	const pricing = resolveModelPricing(model);
	if (!pricing) return null;

	const cachedInputTokens = Math.max(0, usage.cachedInputTokens || 0);
	const cacheCreationTokens = Math.max(0, usage.cacheCreationInputTokens || 0);
	const reportedInput = Math.max(0, usage.inputTokens || 0);
	const uncachedInputTokens = PROVIDERS_WITH_CACHE_INCLUSIVE_INPUT.has(provider.toLowerCase())
		? Math.max(0, reportedInput - cachedInputTokens)
		: reportedInput;

	const inputCost = (uncachedInputTokens / 1_000_000) * pricing.input;
	const outputCost = (Math.max(0, usage.outputTokens || 0) / 1_000_000) * pricing.output;
	const cacheReadCost = (cachedInputTokens / 1_000_000) * pricing.cacheRead;
	const cacheCreationCost = (cacheCreationTokens / 1_000_000) * pricing.cacheWrite;

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
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
}): UsageData {
	// 尝试从嵌套对象中提取 5m/1h 缓存明细（如果存在）
	// biome-ignore lint/suspicious/noExplicitAny: dynamic structure
	const cacheCreation = (usage as any).cache_creation;
	const cache5m = cacheCreation?.ephemeral_5m_input_tokens || 0;
	const cache1h = cacheCreation?.ephemeral_1h_input_tokens || 0;

	return {
		inputTokens: usage.input_tokens ?? 0,
		outputTokens: usage.output_tokens ?? 0,
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
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
	};
	completion_tokens_details?: {
		reasoning_tokens?: number;
	};
}): UsageData {
	return {
		inputTokens: usage.prompt_tokens ?? 0,
		outputTokens: usage.completion_tokens ?? 0,
		cachedInputTokens: usage.prompt_tokens_details?.cached_tokens || 0,
		reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || 0,
	};
}
