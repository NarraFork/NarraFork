import { expect, test } from "bun:test";
import type { ModelCard, RawMetadata } from "@shared/model-catalog/card";
import { modelCardView } from "@shared/model-catalog/card";
import {
	combineReferenceCostStatus,
	estimateReferenceUsageDimensions,
} from "../../../server/lib/reference-usage-cost";

const card = (metadata: RawMetadata): ModelCard => ({
	schemaVersion: 2,
	catalogVersion: "v2:test",
	localRevision: 1,
	matchedVia: "exact",
	metadata,
	provenance: {},
	view: modelCardView(metadata),
});

test("reported non-token dimensions are priced from the card's own rows", () => {
	const estimate = estimateReferenceUsageDimensions(
		card({
			input_cost_per_image: 0.01,
			input_cost_per_audio_per_second: 0.002,
			search_context_cost_per_query: { search_context_size_high: 0.03 },
		}),
		{ images: 3, audioSeconds: 10, searchQueries: { high: 2 } },
	);
	expect(estimate.status).toBe("complete");
	expect(estimate.knownCost).toBeCloseTo(0.03 + 0.02 + 0.06, 12);
	// Every line names the source row it came from, so the number is auditable.
	expect(estimate.lines.map((line) => line.key).sort()).toEqual([
		"input_cost_per_audio_per_second",
		"input_cost_per_image",
		"search_context_cost_per_query.search_context_size_high",
	]);
	expect(estimate.missingFields).toEqual([]);
});

test("an unpriced dimension is missing rather than free, and is not borrowed from another unit", () => {
	// A token-only card: images have no rate at all.
	const estimate = estimateReferenceUsageDimensions(
		card({ input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 }),
		{ images: 4 },
	);
	expect(estimate.status).toBe("unknown");
	expect(estimate.knownCost).toBe(0);
	expect(estimate.missingFields).toEqual(["images"]);
	// The per-token rate must not be reused as a per-image rate.
	expect(estimate.lines).toEqual([]);
});

test("an explicitly unknown rate keeps the quantity but refuses an amount", () => {
	const estimate = estimateReferenceUsageDimensions(card({ input_cost_per_image: null }), {
		images: 2,
	});
	expect(estimate.status).toBe("unknown");
	expect(estimate.lines[0]).toMatchObject({ quantity: 2, rate: null, cost: null });
	expect(estimate.missingFields).toEqual(["images"]);
});

test("an explicit zero rate is free, and unreported dimensions add no uncertainty", () => {
	const free = estimateReferenceUsageDimensions(card({ input_cost_per_image: 0 }), { images: 5 });
	expect(free.status).toBe("complete");
	expect(free.knownCost).toBe(0);
	expect(free.lines[0]?.rate).toBe("0");

	const nothing = estimateReferenceUsageDimensions(card({ input_cost_per_image: 0.01 }), {});
	expect(nothing.status).toBe("complete");
	expect(nothing.lines).toEqual([]);
});

test("a tiny rate survives without being rounded to zero", () => {
	const estimate = estimateReferenceUsageDimensions(
		card({ input_cost_per_character: 0.00000015 }),
		{ characters: 2000 },
	);
	expect(estimate.lines[0]?.rate).toBe("0.00000015");
	expect(estimate.knownCost).toBeCloseTo(0.0003, 12);
});

test("free tokens cannot make an unpriced image request look complete", () => {
	const unpriced = estimateReferenceUsageDimensions(card({ input_cost_per_token: 0 }), {
		images: 2,
	});
	expect(combineReferenceCostStatus("complete", unpriced)).toBe("partial");
	// Both sides unknown stays unknown; anything mixed is partial.
	expect(combineReferenceCostStatus("unknown", unpriced)).toBe("unknown");
	const priced = estimateReferenceUsageDimensions(card({ input_cost_per_image: 0.01 }), {
		images: 1,
	});
	expect(combineReferenceCostStatus("complete", priced)).toBe("complete");
	expect(combineReferenceCostStatus("partial", priced)).toBe("partial");
});

test("batch and long-context rows are never used for a standard-tier dimension", () => {
	const estimate = estimateReferenceUsageDimensions(
		card({
			input_cost_per_image_batches: 0.001,
			long_context_input_token_threshold: 200000,
			long_context_input_cost_multiplier: 2,
		}),
		{ images: 10 },
	);
	// The only image rate belongs to the batch tier, so the standard request is unpriced.
	expect(estimate.status).toBe("unknown");
	expect(estimate.missingFields).toEqual(["images"]);
});
