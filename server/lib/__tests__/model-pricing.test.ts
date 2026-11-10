import { afterEach, describe, expect, test } from "bun:test";
import { db } from "@server/db";
import { apiRequests } from "@server/db/schema";
import type { ReferencePricingSnapshot } from "@shared/agent-protocol/types";
import { decimalValue, type RawMetadata } from "@shared/model-catalog/card";
import type { ModelOverride } from "@shared/model-catalog/override";
import { modelProfile } from "@shared/model-catalog/profile";
import { eq } from "drizzle-orm";
import { finishApiRequest, startApiRequest, trackApiRequest } from "../api-request-tracker";
import {
	getEffectiveModelProfile,
	getModelOverride,
	getModelOverridesRevision,
	replaceModelOverridesForTests,
	resolveEffectiveModelCard,
	withModelMetadataSnapshotIterator,
} from "../model-catalog";
import { captureReferencePricingSnapshot, resolveModelPricing } from "../model-pricing";
import {
	buildUsageDataFromSnapshot,
	calculateCost,
	calculateCostDetailed,
	type UsageData,
} from "../usage-tracking";

const restores: Array<() => void> = [];
afterEach(() => {
	while (restores.length) restores.pop()?.();
});

describe("normalized usage snapshot conversion", () => {
	test.each([
		undefined,
		0,
		17,
	])("input=%s preserves net counters or derives them from full prompt", (inputTokens) => {
		expect(
			buildUsageDataFromSnapshot({
				promptTokens: 100,
				inputTokens,
				cachedInputTokens: 40,
				cacheCreation5mTokens: 15,
				cacheCreation1hTokens: 5,
			}),
		).toMatchObject({
			inputTokens: inputTokens ?? 40,
			cachedInputTokens: 40,
			cacheCreationInputTokens: 20,
		});
	});
	test("cache-only usage does not turn cache into ordinary input", () => {
		expect(
			buildUsageDataFromSnapshot({
				promptTokens: 60,
				cachedInputTokens: 40,
				cacheCreation5mTokens: 20,
			}),
		).toMatchObject({ inputTokens: 0, cacheCreationInputTokens: 20 });
		expect(buildUsageDataFromSnapshot({ cacheCreation1hTokens: 20 })).toMatchObject({
			inputTokens: 0,
			cacheCreationInputTokens: 20,
		});
	});
});
type Prices = NonNullable<ModelOverride["prices"]>;
/** A provider entry the catalog does not know; its prices come only from its own override. */
const MODEL = "openai:cost-fixture";
function overrides(input: Parameters<typeof replaceModelOverridesForTests>[0]) {
	restores.push(replaceModelOverridesForTests(input));
}
/** Prices are written per million tokens, as people type them into the override editor. */
function install(prices?: Prices, extra: ModelOverride = {}) {
	const override = { ...extra, ...(prices ? { prices } : {}) };
	overrides({ connections: Object.keys(override).length ? { [MODEL]: override } : {} });
}
/** A concurrent edit of the fixture's own override. */
function patchFixture(change: ModelOverride) {
	const before = getModelOverride("connection", MODEL) ?? {};
	overrides({
		connections: {
			[MODEL]: { ...before, ...change, prices: { ...before.prices, ...change.prices } },
		},
	});
}
/** Catalog-shaped metadata (as a gateway reports it), captured into a price snapshot. */
const PRICE_KEYS = {
	input: "input_cost_per_token",
	output: "output_cost_per_token",
	cacheRead: "cache_read_input_token_cost",
	cacheWrite: "cache_creation_input_token_cost",
} as const;
function perToken(prices: Partial<Record<keyof Prices, string | null>>, suffix = ""): RawMetadata {
	const raw: RawMetadata = {};
	for (const [field, value] of Object.entries(prices) as Array<[keyof Prices, string | null]>)
		raw[PRICE_KEYS[field] + suffix] = value === null ? null : decimalValue(value, -6);
	return raw;
}
function discoveredSnapshot(raw: RawMetadata): ReferencePricingSnapshot {
	const card = resolveEffectiveModelCard({ upstreamModelId: "cost-fixture" }, raw);
	return {
		catalogVersion: card.catalogVersion,
		localRevision: card.localRevision,
		referencePricing: modelProfile(card).referencePricing ?? null,
	};
}
function usage(partial: Partial<UsageData> = {}): UsageData {
	return { inputTokens: 1_000_000, outputTokens: 1_000_000, ...partial };
}
const allPrices: Prices = { input: "2", output: "8", cacheRead: "0.5", cacheWrite: "2.5" };
const estimate = (data = usage(), provider = "openai", model = MODEL) =>
	calculateCostDetailed(data, provider, model);
const estimateRaw = (raw: RawMetadata, data = usage(), provider = "openai") =>
	calculateCostDetailed(data, provider, MODEL, discoveredSnapshot(raw));

describe("reference costs use effective catalog metadata", () => {
	test("stream start price snapshots survive external consumers and preserve captured unknown", async () => {
		const cases: Array<{
			pricing?: Prices;
			status: string;
			cost: number | null;
		}> = [
			{ pricing: allPrices, status: "complete", cost: 10 },
			{ pricing: { input: "2" }, status: "partial", cost: 2 },
			{ status: "unknown", cost: null },
			{
				pricing: { input: "0", output: "0", cacheRead: "0", cacheWrite: "0" },
				status: "complete",
				cost: 0,
			},
		];
		for (const fixture of cases) {
			install(fixture.pricing);
			const revision = getModelOverridesRevision();
			const producer = withModelMetadataSnapshotIterator(async function* () {
				yield {
					type: "api_request_start" as const,
					provider: "openai",
					model: MODEL,
					referencePricingSnapshot: captureReferencePricingSnapshot(MODEL),
				};
			});
			const event = (await producer.next()).value;
			if (!event) throw new Error("Missing start event");
			// The consumer runs outside producer ALS, after a concurrent override edit.
			patchFixture({ prices: { input: "20", output: "8", cacheRead: "0.5", cacheWrite: "2.5" } });
			expect(estimate().knownCost).toBe(28);
			const handle = startApiRequest(event);
			const next = startApiRequest({ provider: "openai", model: MODEL });
			try {
				expect(Object.isFrozen(handle.referencePricingSnapshot)).toBe(true);
				expect(handle.referencePricingSnapshot.localRevision).toBe(revision);
				await finishApiRequest(handle, { usage: usage() });
				await finishApiRequest(next, { usage: usage() });
				expect(
					db.select().from(apiRequests).where(eq(apiRequests.id, handle.id)).get(),
				).toMatchObject({ costStatus: fixture.status, costUsd: fixture.cost });
				expect(
					db.select().from(apiRequests).where(eq(apiRequests.id, next.id)).get(),
				).toMatchObject({ costStatus: "complete", costUsd: 28 });
			} finally {
				db.delete(apiRequests).where(eq(apiRequests.id, handle.id)).run();
				db.delete(apiRequests).where(eq(apiRequests.id, next.id)).run();
				await producer.return();
			}
		}
	});
	test("tracked request and completion pricing share one snapshot across deferred edits", async () => {
		install(allPrices, { contextWindow: 100_000 });
		let release = () => {};
		let entered = () => {};
		const deferred = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const options = { provider: "openai", model: MODEL };
		const pending = trackApiRequest(options, async () => {
			expect(getEffectiveModelProfile(options.model).contextWindow).toBe(100_000);
			entered();
			await deferred;
			expect(getEffectiveModelProfile(options.model).contextWindow).toBe(100_000);
			expect(estimate().knownCost).toBe(10);
			return { usage: usage() };
		});
		try {
			await started;
			patchFixture({ prices: { input: "20" }, contextWindow: 200_000 });
			expect(getEffectiveModelProfile(options.model).contextWindow).toBe(200_000);
			release();
			await pending;
			const first = db.select().from(apiRequests).where(eq(apiRequests.model, options.model)).all();
			expect(first.map((row) => row.costUsd)).toEqual([10]);
			await trackApiRequest(options, async () => {
				expect(getEffectiveModelProfile(options.model).contextWindow).toBe(200_000);
				return { usage: usage() };
			});
			const both = db.select().from(apiRequests).where(eq(apiRequests.model, options.model)).all();
			expect(both.map((row) => row.costUsd).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([10, 28]);
		} finally {
			release();
			await pending;
			db.delete(apiRequests).where(eq(apiRequests.model, options.model)).run();
		}
	});
	test("new request records persist partial coverage without altering NUG metering", async () => {
		install({ input: "2" });
		const request = startApiRequest({ provider: "nug", model: MODEL });
		try {
			await finishApiRequest(request, { usage: usage(), meterUsage: 17, meterUnit: "credits" });
			const row = db.select().from(apiRequests).where(eq(apiRequests.id, request.id)).get();
			expect(row).toMatchObject({
				costStatus: "partial",
				costUsd: 2,
				costMissingFields: ["output"],
				meterUsage: 17,
				meterUnit: "credits",
			});
		} finally {
			db.delete(apiRequests).where(eq(apiRequests.id, request.id)).run();
		}
	});
	test("input-only prices retain known amount but cannot claim full cost", () => {
		install({ input: "2" });
		expect(estimate()).toMatchObject({
			status: "partial",
			knownCost: 2,
			missingFields: ["output"],
		});
		expect(calculateCost(usage(), "openai", MODEL)).toBeNull();
	});
	test("actual cache usage requires its own price; unused missing fields do not", () => {
		install({ input: "2", output: "8" });
		expect(estimate()).toMatchObject({ status: "complete", knownCost: 10 });
		expect(
			estimate(usage({ cachedInputTokens: 500_000, cacheCreationInputTokens: 100_000 })),
		).toMatchObject({
			status: "partial",
			knownCost: 10,
			missingFields: ["cacheRead", "cacheWrite"],
		});
	});
	test("explicit null price in catalog metadata is unknown, not a free rate", () => {
		expect(estimateRaw({ ...perToken(allPrices), ...perToken({ input: null }) })).toMatchObject({
			status: "partial",
			knownCost: 8,
			missingFields: ["input"],
		});
		expect(estimateRaw(perToken({ input: null, output: null }))).toMatchObject({
			status: "unknown",
			knownCost: 0,
		});
	});
	test("explicit all-zero prices are complete and free including caches", () => {
		install({ input: "0", output: "0", cacheRead: "0", cacheWrite: "0" });
		expect(
			estimate(usage({ cachedInputTokens: 100, cacheCreationInputTokens: 100 })),
		).toMatchObject({ status: "complete", knownCost: 0, missingFields: [] });
		expect(calculateCost(usage(), "openai", MODEL)?.totalCost).toBe(0);
	});
	test("alias inherits a model-wide override; clearing it restores the catalog price", () => {
		// claude-haiku-4-5 is a catalog model with alias claude-haiku-4.5.
		const alias = "anthropic:claude-haiku-4.5";
		overrides({});
		const base = resolveModelPricing(alias);
		expect(base).toMatchObject({ modelKey: "claude-haiku-4-5", matchedVia: "alias", input: 1 });
		overrides({ models: { "claude-haiku-4-5": { prices: { input: "9" } } } });
		expect(resolveModelPricing(alias)).toMatchObject({
			input: 9,
			output: base?.output,
			overridden: true,
		});
		expect(resolveModelPricing(alias)?.provenance.input_cost_per_token).toMatchObject({
			layer: "local-model",
			id: "claude-haiku-4-5",
		});
		overrides({});
		expect(resolveModelPricing(alias)).toMatchObject({ input: 1, overridden: false });
	});
	test("a provider entry's explicit zero override wins over model-wide and catalog prices", () => {
		const value = "anthropic:claude-haiku-4-5";
		overrides({
			models: { "claude-haiku-4-5": { prices: { input: "9", output: "7" } } },
			connections: { [value]: { prices: { output: "0" } } },
		});
		expect(resolveModelPricing(value)).toMatchObject({ input: 9, output: 0 });
		expect(estimate(usage(), "anthropic", value)).toMatchObject({
			status: "complete",
			knownCost: 9,
		});
		expect(resolveModelPricing(value)?.provenance.output_cost_per_token).toMatchObject({
			layer: "local-connection",
			id: value,
		});
	});
	test.each([
		"openai",
		"codex",
		"gemini",
		"nug",
		"anthropic",
	])("%s prices normalized disjoint input and cache components without another subtraction", (provider) => {
		install(allPrices);
		const data = usage({
			inputTokens: 1_000_000,
			outputTokens: 0,
			cachedInputTokens: 500_000,
			cacheCreationInputTokens: 100_000,
		});
		expect(estimate(data, provider).knownCost).toBe(2.5);
		const fullyCached = estimate(
			usage({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000 }),
			provider,
		);
		expect(fullyCached.inputCost).toBe(0);
		expect(fullyCached.cacheReadCost).toBe(0.5);
	});
	test("unknown models and empty usage do not look free", () => {
		install();
		expect(estimate().status).toBe("unknown");
		expect(estimate(usage({ inputTokens: 0, outputTokens: 0 })).status).toBe("unknown");
	});
	test("long context full mode uses prompt threshold and respects sparse/unknown/zero tiers", () => {
		const raw: RawMetadata = {
			...perToken(allPrices),
			long_context_input_token_threshold: 1_000_000,
			...perToken({ input: "4", output: "16" }, "_above_1000k_tokens"),
		};
		expect(estimateRaw(raw).knownCost).toBe(10); // exactly threshold stays base
		expect(estimateRaw(raw, usage({ inputTokens: 1_000_001 })).knownCost).toBeCloseTo(20.000004);
		const sparse: RawMetadata = {
			...raw,
			input_cost_per_token_above_1000k_tokens: null,
			output_cost_per_token_above_1000k_tokens: "0",
		};
		expect(estimateRaw(sparse, usage({ inputTokens: 1_000_001 }))).toMatchObject({
			status: "partial",
			knownCost: 0,
			missingFields: ["longContext.input"],
		});
	});
	test("cache TTL details still require cache-write pricing when aggregate is omitted", () => {
		install({ input: "2", output: "8" });
		expect(estimate(usage({ cacheCreation1hInputTokens: 100 }))).toMatchObject({
			status: "partial",
			missingFields: ["cacheWrite"],
		});
	});
	test("unknown long-context threshold cannot silently use base price", () => {
		const raw: RawMetadata = {
			...perToken(allPrices),
			long_context_input_token_threshold: null,
			long_context_input_cost_multiplier: 2,
		};
		expect(estimateRaw(raw).status).toBe("unknown");
		expect(estimateRaw(raw).missingFields).toContain("longContext.thresholdTokens");
	});
	test.each([
		"anthropic",
		"openai",
		"codex",
		"gemini",
		"nug",
	])("%s threshold includes disjoint cache read and write tokens", (provider) => {
		const raw: RawMetadata = {
			...perToken(allPrices),
			long_context_input_token_threshold: 100,
			...perToken({ input: "4" }, "_above_100_tokens"),
		};
		const result = estimateRaw(
			raw,
			usage({
				inputTokens: 50,
				cachedInputTokens: 30,
				cacheCreationInputTokens: 30,
				outputTokens: 0,
			}),
			provider,
		);
		expect(result.inputCost).toBeCloseTo(0.0002);
		expect(result.cacheReadCost).toBeCloseTo(0.000015);
	});
	test("marginal rules without verified reference allocation stay unknown", () => {
		const raw: RawMetadata = {
			...perToken(allPrices),
			long_context_input_token_threshold: 100,
			long_context_pricing_basis: "marginal",
			...perToken({ input: "4", output: "16" }, "_above_100_tokens"),
		};
		expect(estimateRaw(raw).status).toBe("unknown");
		expect(estimateRaw(raw).missingFields).toContain("longContext.mode");
	});
});
