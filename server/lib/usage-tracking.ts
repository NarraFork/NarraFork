import { db } from "@server/db";
import { narratorMessages } from "@server/db/schema";
import type { ReferencePricingSnapshot } from "@shared/agent-protocol/types";
import { eq } from "drizzle-orm";
import type { CostEstimate } from "./cost-estimate";
import {
	type PriceField,
	pricingFromReferenceSnapshot,
	referencePriceNumber,
	resolveModelPricing,
} from "./model-pricing";

export type { CostData, CostEstimate, CostStatus } from "./cost-estimate";

export interface UsageData {
	/** Non-cached input; cache reads and writes are disjoint counters, normalized by the adapter. */
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens?: number;
	cacheCreationInputTokens?: number;
	cacheCreation5mInputTokens?: number;
	cacheCreation1hInputTokens?: number;
	reasoningTokens?: number;
	/**
	 * Whether the provider's usage carried cache counters. Stored as
	 * `api_requests.cache_usage_reported`; undefined means the adapter cannot tell.
	 */
	cacheReported?: boolean;
}

export function buildUsageDataFromSnapshot(snapshot?: {
	promptTokens?: number;
	inputTokens?: number;
	completionTokens?: number;
	cachedInputTokens?: number;
	cacheCreationInputTokens?: number;
	cacheCreation5mTokens?: number;
	cacheCreation1hTokens?: number;
	reasoningTokens?: number;
	cacheReported?: boolean;
}): UsageData | null {
	if (!snapshot) return null;
	if (
		snapshot.promptTokens == null &&
		snapshot.inputTokens == null &&
		snapshot.completionTokens == null &&
		snapshot.cachedInputTokens == null &&
		snapshot.cacheCreationInputTokens == null &&
		snapshot.cacheCreation5mTokens == null &&
		snapshot.cacheCreation1hTokens == null
	) {
		return null;
	}
	const cacheRead = snapshot.cachedInputTokens ?? 0;
	const cacheWrite = Math.max(
		snapshot.cacheCreationInputTokens ?? 0,
		(snapshot.cacheCreation5mTokens ?? 0) + (snapshot.cacheCreation1hTokens ?? 0),
	);
	return {
		inputTokens:
			snapshot.inputTokens ?? Math.max(0, (snapshot.promptTokens ?? 0) - cacheRead - cacheWrite),
		outputTokens: snapshot.completionTokens ?? 0,
		cachedInputTokens: cacheRead,
		cacheCreationInputTokens: cacheWrite,
		cacheCreation5mInputTokens: snapshot.cacheCreation5mTokens ?? 0,
		cacheCreation1hInputTokens: snapshot.cacheCreation1hTokens ?? 0,
		reasoningTokens: snapshot.reasoningTokens ?? 0,
		...(snapshot.cacheReported !== undefined && { cacheReported: snapshot.cacheReported }),
	};
}

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
	_provider: string,
	model: string,
	snapshot?: ReferencePricingSnapshot,
): CostEstimate {
	// An explicit unknown snapshot must never fall back to a newly published price.
	const pricing =
		snapshot === undefined ? resolveModelPricing(model) : pricingFromReferenceSnapshot(snapshot);
	const tokens = (value?: number) =>
		typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
	const cacheRead = tokens(usage.cachedInputTokens);
	const cacheWrite = Math.max(
		tokens(usage.cacheCreationInputTokens),
		tokens(usage.cacheCreation5mInputTokens) + tokens(usage.cacheCreation1hInputTokens),
	);
	// Adapters normalize protocol-specific totals once. Provider identity (notably
	// NUG's mixed protocols) cannot tell us whether a counter includes caching.
	const input = tokens(usage.inputTokens);
	const promptTokens = input + cacheRead + cacheWrite;
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
		cacheReported:
			usage.cache_read_input_tokens != null ||
			usage.cache_creation_input_tokens != null ||
			cacheCreation != null,
	};
}

/**
 * 从 OpenAI usage 对象提取 token 数据
 */
export function extractOpenAIUsage(usage: {
	prompt_tokens?: number;
	input_tokens?: number;
	completion_tokens?: number;
	output_tokens?: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
		cache_write_tokens?: number;
		cache_creation_tokens?: number;
	};
	input_tokens_details?: {
		cached_tokens?: number;
		cache_write_tokens?: number;
		cache_creation_tokens?: number;
	};
	cached_tokens?: number;
	cached_input_tokens?: number;
	cache_read_input_tokens?: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_write_input_tokens?: number;
	cache_creation_tokens?: number;
	completion_tokens_details?: {
		reasoning_tokens?: number;
	};
	output_tokens_details?: {
		reasoning_tokens?: number;
	};
}): UsageData {
	const cacheTokens = (value?: number) =>
		value == null ? undefined : Number.isFinite(value) ? Math.max(value, 0) : 0;
	const firstPositive = (...values: Array<number | undefined>) =>
		values.find((value) => typeof value === "number" && Number.isFinite(value) && value > 0) ??
		(values.some((value) => value != null) ? 0 : undefined);
	// Nested counters are authoritative, including an explicit zero. Top-level
	// relay aliases instead use the first positive finite counter.
	const cachedInputTokens = cacheTokens(
		usage.input_tokens_details?.cached_tokens ??
			usage.prompt_tokens_details?.cached_tokens ??
			firstPositive(
				usage.cache_read_input_tokens,
				usage.cache_read_tokens,
				usage.cached_input_tokens,
				usage.cached_tokens,
			),
	);
	const cacheCreationInputTokens = cacheTokens(
		usage.input_tokens_details?.cache_write_tokens ??
			usage.prompt_tokens_details?.cache_write_tokens ??
			usage.input_tokens_details?.cache_creation_tokens ??
			usage.prompt_tokens_details?.cache_creation_tokens ??
			firstPositive(
				usage.cache_write_tokens,
				usage.cache_creation_input_tokens,
				usage.cache_write_input_tokens,
				usage.cache_creation_tokens,
			),
	);
	// Both OpenAI protocols report the full prompt, including cache reads/writes.
	return {
		inputTokens: Math.max(
			(usage.input_tokens ?? usage.prompt_tokens ?? 0) -
				(cachedInputTokens ?? 0) -
				(cacheCreationInputTokens ?? 0),
			0,
		),
		outputTokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
		cachedInputTokens,
		cacheCreationInputTokens,
		reasoningTokens:
			usage.output_tokens_details?.reasoning_tokens ??
			usage.completion_tokens_details?.reasoning_tokens ??
			0,
		cacheReported: cachedInputTokens !== undefined || cacheCreationInputTokens !== undefined,
	};
}
