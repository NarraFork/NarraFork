import { afterEach, describe, expect, test } from "bun:test";
import { db } from "@server/db";
import { apiRequests } from "@server/db/schema";
import type { LocalCatalogState, ModelMetadata } from "@shared/model-catalog/schema/catalog";
import { eq } from "drizzle-orm";
import { finishApiRequest, startApiRequest, trackApiRequest } from "../api-request-tracker";
import {
	bindModelCatalogSettings,
	getEffectiveModelMetadata,
	getModelCatalogSnapshot,
	mutateModelCatalog,
	withModelMetadataSnapshotIterator,
} from "../model-catalog";
import { captureReferencePricingSnapshot, resolveModelPricing } from "../model-pricing";
import { saveSettings, settings } from "../settings";
import type { NarraForkSettings } from "../settings/types";
import { calculateCost, calculateCostDetailed, type UsageData } from "../usage-tracking";

afterEach(() => bindModelCatalogSettings(settings, () => saveSettings(settings)));
function install(
	pricing?: ModelMetadata["referencePricing"],
	extra: Partial<LocalCatalogState> = {},
) {
	const local: LocalCatalogState = {
		revision: 1,
		models: [
			{
				id: "cost-fixture",
				matches: { aliases: ["cost-alias"] },
				metadata: pricing ? { referencePricing: pricing } : {},
			},
		],
		...extra,
	};
	bindModelCatalogSettings(
		{
			agent: {
				modelCatalog: {
					schemaVersion: 1,
					migrationVersion: 1,
					local,
					autoApply: false,
					pinnedVersion: null,
				},
			},
		} as NarraForkSettings,
		() => {},
	);
}
function patchFixture(set: Record<string, string | number | boolean | null>, reset?: string[]) {
	return mutateModelCatalog({
		baseRevision: getModelCatalogSnapshot().local.revision,
		action: "patch",
		target: "model",
		targetId: "cost-fixture",
		patch: { set, reset },
	});
}
function usage(partial: Partial<UsageData> = {}): UsageData {
	return { inputTokens: 1_000_000, outputTokens: 1_000_000, ...partial };
}
const allPrices = { input: "2", output: "8", cacheRead: "0.5", cacheWrite: "2.5" };
const estimate = (data = usage(), provider = "openai", model = "cost-fixture") =>
	calculateCostDetailed(data, provider, model);

describe("reference costs use effective catalog metadata", () => {
	test("stream start price snapshots survive external consumers and preserve captured unknown", async () => {
		const cases: Array<{
			pricing?: ModelMetadata["referencePricing"];
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
			const producer = withModelMetadataSnapshotIterator(async function* () {
				yield {
					type: "api_request_start" as const,
					provider: "openai",
					model: "cost-fixture",
					referencePricingSnapshot: captureReferencePricingSnapshot("cost-fixture"),
				};
			});
			const event = (await producer.next()).value;
			if (!event) throw new Error("Missing start event");
			// The consumer runs outside producer ALS, after a concurrent settings edit.
			patchFixture({
				"referencePricing.input": "20",
				"referencePricing.output": "8",
				"referencePricing.cacheRead": "0.5",
				"referencePricing.cacheWrite": "2.5",
			});
			expect(estimate().knownCost).toBe(28);
			const handle = startApiRequest(event);
			const next = startApiRequest({ provider: "openai", model: "cost-fixture" });
			try {
				expect(Object.isFrozen(handle.referencePricingSnapshot)).toBe(true);
				expect(handle.referencePricingSnapshot.localRevision).toBe(1);
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
		install(allPrices);
		patchFixture({ "limits.contextWindow": 100_000 });
		let release = () => {};
		let entered = () => {};
		const deferred = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const options = { provider: "openai", model: "cost-fixture" };
		const pending = trackApiRequest(options, async () => {
			expect(getEffectiveModelMetadata(options.model).metadata.limits?.contextWindow).toBe(100_000);
			entered();
			await deferred;
			expect(getEffectiveModelMetadata(options.model).metadata.limits?.contextWindow).toBe(100_000);
			expect(estimate().knownCost).toBe(10);
			return { usage: usage() };
		});
		try {
			await started;
			patchFixture({ "referencePricing.input": "20", "limits.contextWindow": 200_000 });
			expect(getEffectiveModelMetadata(options.model).metadata.limits?.contextWindow).toBe(200_000);
			release();
			await pending;
			const first = db.select().from(apiRequests).where(eq(apiRequests.model, options.model)).all();
			expect(first.map((row) => row.costUsd)).toEqual([10]);
			await trackApiRequest(options, async () => {
				expect(getEffectiveModelMetadata(options.model).metadata.limits?.contextWindow).toBe(
					200_000,
				);
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
		const request = startApiRequest({ provider: "nug", model: "cost-fixture" });
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
		expect(calculateCost(usage(), "openai", "cost-fixture")).toBeNull();
	});
	test("actual cache usage requires its own price; unused missing fields do not", () => {
		install({ input: "2", output: "8" });
		expect(estimate()).toMatchObject({ status: "complete", knownCost: 10 });
		expect(
			estimate(usage({ cachedInputTokens: 500_000, cacheCreationInputTokens: 100_000 })),
		).toMatchObject({
			status: "partial",
			knownCost: 9,
			missingFields: ["cacheRead", "cacheWrite"],
		});
	});
	test("explicit null clears inherited price, not a free rate", () => {
		install(allPrices, {
			overrides: [
				{
					target: "model",
					targetId: "cost-fixture",
					metadata: { referencePricing: { input: null } },
				},
			],
		});
		expect(resolveModelPricing("cost-alias")?.input).toBeNull();
		expect(estimate()).toMatchObject({ status: "partial", knownCost: 8, missingFields: ["input"] });
		install({ input: null, output: null });
		expect(estimate()).toMatchObject({ status: "unknown", knownCost: 0 });
	});
	test("explicit all-zero prices are complete and free including caches", () => {
		install({ input: "0", output: "0", cacheRead: "0", cacheWrite: "0" });
		expect(
			estimate(usage({ cachedInputTokens: 100, cacheCreationInputTokens: 100 })),
		).toMatchObject({ status: "complete", knownCost: 0, missingFields: [] });
		expect(calculateCost(usage(), "openai", "cost-fixture")?.totalCost).toBe(0);
	});
	test("alias inherits custom override; reset clears it and republishing restores base", () => {
		install(allPrices, {
			overrides: [
				{
					target: "model",
					targetId: "cost-fixture",
					metadata: { referencePricing: { input: "9" } },
				},
			],
		});
		expect(estimate(usage(), "openai", "cost-alias")).toMatchObject({
			status: "complete",
			knownCost: 17,
		});
		const reset = patchFixture({}, ["referencePricing.input"]);
		expect(reset.local.overrides).toEqual([]);
		// Reset means inheritance even for creation-time fields; a local-only model has no input base.
		expect(estimate(usage(), "openai", "cost-alias")).toMatchObject({
			status: "partial",
			knownCost: 8,
			missingFields: ["input"],
		});
		const model = reset.local.models?.find((entry) => entry.id === "cost-fixture");
		if (!model) throw new Error("Missing fixture model");
		mutateModelCatalog({
			baseRevision: reset.local.revision,
			action: "upsert-model",
			model: { ...model, metadata: { referencePricing: allPrices } },
		});
		expect(estimate(usage(), "openai", "cost-alias").knownCost).toBe(10);
	});
	test("tombstone suppresses pricing immediately and restoration recovers it", () => {
		install(allPrices);
		mutateModelCatalog({
			baseRevision: getModelCatalogSnapshot().local.revision,
			action: "hide",
			target: "model",
			targetId: "cost-fixture",
		});
		expect(estimate(usage(), "openai", "cost-alias").status).toBe("unknown");
		mutateModelCatalog({
			baseRevision: getModelCatalogSnapshot().local.revision,
			action: "restore",
			target: "model",
			targetId: "cost-fixture",
		});
		expect(estimate(usage(), "openai", "cost-alias").knownCost).toBe(10);
	});
	test("variant price and explicit zero override are consumed", () => {
		install(allPrices, {
			variants: [
				{
					id: "cost-fixture-variant",
					modelId: "cost-fixture",
					providerKey: "openai",
					upstreamModelIds: ["variant-cost"],
					metadata: { referencePricing: { input: "5" } },
				},
			],
			overrides: [
				{
					target: "variant",
					targetId: "cost-fixture-variant",
					metadata: { referencePricing: { output: "0" } },
				},
			],
		});
		expect(estimate(usage(), "openai", "openai:variant-cost")).toMatchObject({
			status: "complete",
			knownCost: 5,
		});
	});
	test("OpenAI subtracts cached input; Anthropic counts disjoint components", () => {
		install(allPrices);
		const data = usage({
			inputTokens: 1_000_000,
			outputTokens: 0,
			cachedInputTokens: 500_000,
			cacheCreationInputTokens: 100_000,
		});
		expect(estimate(data, "openai").knownCost).toBe(1.5);
		expect(estimate(data, "anthropic").knownCost).toBe(2.5);
	});
	test("unknown models and empty usage do not look free", () => {
		install();
		expect(estimate().status).toBe("unknown");
		expect(estimate(usage({ inputTokens: 0, outputTokens: 0 })).status).toBe("unknown");
	});
	test("long context full mode uses prompt threshold and respects sparse/unknown/zero tiers", () => {
		install({
			...allPrices,
			longContext: {
				thresholdTokens: 1_000_000,
				basis: "promptTokens",
				mode: "full",
				input: "4",
				output: "16",
			},
		});
		expect(estimate().knownCost).toBe(10); // exactly threshold stays base
		expect(estimate(usage({ inputTokens: 1_000_001 })).knownCost).toBeCloseTo(20.000004);
		patchFixture({
			"referencePricing.longContext.input": null,
			"referencePricing.longContext.output": "0",
		});
		expect(estimate(usage({ inputTokens: 1_000_001 }))).toMatchObject({
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
		install({
			...allPrices,
			longContext: { thresholdTokens: null, basis: "promptTokens", mode: "full", input: "4" },
		});
		expect(estimate().status).toBe("unknown");
		expect(estimate().missingFields).toContain("longContext.thresholdTokens");
	});
	test("Anthropic threshold includes disjoint cache tokens", () => {
		install({
			...allPrices,
			longContext: { thresholdTokens: 100, basis: "promptTokens", mode: "full", input: "4" },
		});
		const result = estimate(
			usage({ inputTokens: 50, cachedInputTokens: 60, outputTokens: 0 }),
			"anthropic",
		);
		expect(result.inputCost).toBeCloseTo(0.0002);
		expect(result.cacheReadCost).toBeCloseTo(0.00003);
	});
	test("marginal rules without verified reference allocation stay unknown", () => {
		install({
			...allPrices,
			longContext: {
				thresholdTokens: 100,
				basis: "promptTokens",
				mode: "marginal",
				input: "4",
				output: "16",
			},
		});
		expect(estimate().status).toBe("unknown");
		expect(estimate().missingFields).toContain("longContext.mode");
	});
});
