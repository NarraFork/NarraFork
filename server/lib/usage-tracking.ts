import { db } from "@server/db";
import { narratorMessages, narratorToolCalls } from "@server/db/schema";
import { eq } from "drizzle-orm";
import type { CostEstimate } from "./cost-estimate";
import type { ReferencePricingSnapshot } from "@shared/agent-protocol/types";
import { type PriceField, referencePriceNumber, resolveModelPricing, pricingFromReferenceSnapshot } from "./model-pricing";

export type { CostData, CostEstimate, CostStatus } from "./cost-estimate";

export interface UsageData {
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens?: number;
	cacheCreationInputTokens?: number;
	cacheCreation5mInputTokens?: number;
	cacheCreation1hInputTokens?: number;
	reasoningTokens?: number;
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
 * This set describes token semantics, not price coverage. Every provider's
 * reference price comes from the effective catalog; NUG actual billing stays separate.
 */
const PROVIDERS_WITH_CACHE_INCLUSIVE_INPUT = new Set(["openai", "codex", "nug", "gemini"]);

/**
 * Attribute a USD cost to one request's token usage using the official
 * reference prices in `model-pricing.ts`.
 *
 * Returns null when the model has no known price, so callers can record "not
 * priced" rather than a misleading 0. For subscription-based access (Codex on a
 * ChatGPT plan) the figure is what the same tokens would have
 * cost through the metered API, not an amount actually billed.
 */
export function calculateCost(
	usage: UsageData,
	provider: string,
	model: string,
): CostEstimate | null {
	const estimate = calculateCostDetailed(usage, provider, model);
	// Compatibility callers cannot accidentally present a partial amount as the whole cost.
	return estimate.status === "complete" ? estimate : null;
}

export function calculateCostDetailed(
	usage: UsageData,
	provider: string,
	model: string,
	snapshot?: ReferencePricingSnapshot,
): CostEstimate {
	// An explicit unknown snapshot must never fall back to a newly published price.
	const pricing = snapshot === undefined ? resolveModelPricing(model) : pricingFromReferenceSnapshot(snapshot);
	const tokens = (value?: number) =>
		typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
	const cacheRead = tokens(usage.cachedInputTokens);
	const cacheWrite = Math.max(
		tokens(usage.cacheCreationInputTokens),
		tokens(usage.cacheCreation5mInputTokens) + tokens(usage.cacheCreation1hInputTokens),
	);
	const reportedInput = tokens(usage.inputTokens);
	const inclusive = PROVIDERS_WITH_CACHE_INCLUSIVE_INPUT.has(provider.toLowerCase());
	const input = inclusive ? Math.max(0, reportedInput - cacheRead) : reportedInput;
	const promptTokens = inclusive
		? reportedInput + cacheWrite
		: reportedInput + cacheRead + cacheWrite;
	const counts: Record<PriceField, number> = {
		input,
		output: tokens(usage.outputTokens),
		cacheRead,
		cacheWrite,
	};
	const missingFields: string[] = [];
	let knownComponents = 0;
	const tier = pricing?.longContext;
	const threshold = tier?.thresholdTokens;
	const above = typeof threshold === "number" && promptTokens > threshold;
	const costs: Record<PriceField, number> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const add = (field: PriceField, count: number, price: number | null | undefined, prefix = "") => {
		if (count <= 0) return;
		if (price == null) missingFields.push(`${prefix}${field}`);
		else {
			costs[field] += (count * price) / 1_000_000;
			knownComponents++;
		}
	};
	for (const field of Object.keys(counts) as PriceField[]) {
		if (tier && typeof threshold !== "number") {
			add(field, counts[field], null, "longContext.");
			if (counts[field] > 0) missingFields.push("longContext.thresholdTokens");
		} else if (!above) add(field, counts[field], pricing?.[field]);
		else if (!tier?.mode || tier.basis !== "promptTokens") {
			// An unspecified tier rule cannot silently fall back to cheaper base prices.
			add(field, counts[field], null, "longContext.");
		} else if (tier.mode === "full") {
			// Only absence inherits the base tier: explicit null stays unknown and zero stays free.
			const rate = tier[field] === undefined ? pricing?.[field] : referencePriceNumber(tier[field]);
			add(field, counts[field], rate, "longContext.");
		} else {
			// Marginal output allocation is a gateway operator policy, not a verified
			// vendor reference rule. Do not fabricate a complete estimate from it.
			add(field, counts[field], null, "longContext.");
			if (counts[field] > 0) missingFields.push("longContext.mode");
		}
	}
	// Zero usage alone is not evidence that an unknown model is free.
	if (!Object.values(counts).some((value) => value > 0)) {
		for (const field of Object.keys(counts) as PriceField[]) {
			if (pricing?.[field] == null) missingFields.push(field);
			else knownComponents++;
		}
	}
	const knownCost = Object.values(costs).reduce((sum, amount) => sum + amount, 0);
	return {
		status: missingFields.length ? (knownComponents ? "partial" : "unknown") : "complete",
		knownCost,
		missingFields: [...new Set(missingFields)],
		inputCost: costs.input,
		outputCost: costs.output,
		cacheReadCost: costs.cacheRead,
		cacheCreationCost: costs.cacheWrite,
		totalCost: knownCost,
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
	const cost = calculateCostDetailed(usage, provider, model);

	const updateData: Record<string, unknown> = {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cachedInputTokens || 0,
		cacheCreationTokens: usage.cacheCreationInputTokens || 0,
		cacheCreation5mTokens: usage.cacheCreation5mInputTokens || 0,
		cacheCreation1hTokens: usage.cacheCreation1hInputTokens || 0,
		provider,
		model,
		costStatus: cost.status,
		costMissingFields: cost.missingFields,
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
	const cost = calculateCostDetailed(usage, provider, model);
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
			costUsd: cost.status === "unknown" ? null : cost.knownCost,
			costStatus: cost.status,
			costMissingFields: cost.missingFields,
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
