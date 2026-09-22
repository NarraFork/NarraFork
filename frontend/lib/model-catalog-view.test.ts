import { describe, expect, test } from "bun:test";
import type { ModelCatalogSnapshot } from "@shared/model-catalog";
import { resolveCatalogEntry } from "./model-catalog-view";

const snapshot: ModelCatalogSnapshot = {
	catalog: {
		schemaVersion: 1,
		catalogVersion: "test-v1",
		publishedAt: "2026-01-01T00:00:00Z",
		models: [
			{
				id: "base",
				status: "legacy-unverified",
				metadata: {
					limits: { contextWindow: 1000 },
					referencePricing: { input: "2", output: "4" },
				},
			},
		],
		variants: [
			{
				id: "variant",
				modelId: "base",
				providerKey: "channel-type",
				upstreamModelIds: ["opaque:upstream"],
				metadata: { limits: { contextWindow: 2000 } },
			},
		],
	},
	local: {
		revision: 4,
		bindings: [
			{
				id: "actual",
				providerId: "local-provider",
				channelId: "local-channel",
				upstreamModelId: "opaque:upstream",
				variantId: "variant",
				overrides: { limits: { contextWindow: 3000 } },
			},
		],
		overrides: [
			{
				target: "model",
				targetId: "base",
				metadata: { referencePricing: { input: "0" }, nativeSearch: { supported: null } },
			},
		],
		hiddenModelIds: ["base"],
		hiddenVariantIds: ["variant"],
	},
	update: {
		activeVersion: "test-v1",
		bundledVersion: "test-v1",
		history: [],
		autoApply: false,
		pinnedVersion: null,
	},
};
describe("catalog management views", () => {
	test("a variant editor shows its layer, not a connection-level effective override", () => {
		const result = resolveCatalogEntry(snapshot, snapshot.catalog.variants[0]);
		expect(result.metadata.limits?.contextWindow).toBe(2000);
		expect(result.bindingId).toBeUndefined();
		expect(result.metadata.referencePricing).toEqual({ input: "0", output: "4" });
		expect(result.metadata.nativeSearch?.supported).toBeNull();
		expect(result.provenance["referencePricing.input"].layer).toBe("local-model");
	});
	test("inspection does not restore tombstones or mark unverified presets as local", () => {
		const result = resolveCatalogEntry(snapshot, snapshot.catalog.models[0]);
		expect(snapshot.local.hiddenModelIds).toEqual(["base"]);
		expect(snapshot.local.hiddenVariantIds).toEqual(["variant"]);
		expect(result.provenance["limits.contextWindow"].layer).toBe("preset-model");
	});
});
