import { expect, test } from "bun:test";
import { modelCardView } from "@shared/model-catalog/card";
import settings from "../../locales/en/settings.json";
import { cardValueText } from "./ModelCardDetails";

/** The component's own translator, resolved against the real English catalog. */
const t = (key: string, options?: Record<string, unknown>): string => {
	const value = key
		.split(".")
		.reduce<unknown>(
			(node, part) =>
				node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
			settings,
		);
	if (typeof value === "string")
		return value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ""));
	return String(options?.defaultValue ?? key);
};

test("absent, unknown, false and empty list stay four distinct displays", () => {
	expect(cardValueText(undefined, t)).toBe(settings.card.unreported);
	expect(cardValueText(null, t)).toBe(settings.card.unknown);
	expect(cardValueText(false, t)).toBe(settings.card.values.false);
	expect(cardValueText([], t)).toBe(settings.card.emptyList);
	// A real zero is a value, not an absence — the price table labels it free separately.
	expect(cardValueText(0, t)).toBe("0");
});

test("every label the card view can emit exists in the shipped catalog", () => {
	const view = modelCardView({
		mode: "chat",
		max_input_tokens: 128000,
		max_output_tokens: 272000,
		context_window: 400000,
		working_context_tokens: 150000,
		supported_modalities: ["text", "image"],
		supports_vision: true,
		reasoning_effort_levels: ["low", "high"],
		input_cost_per_token: 0.000002,
		output_cost_per_token: 0.000008,
		cache_read_input_token_cost: 0.0000002,
		cache_creation_input_token_cost_above_1hr: 0.000004,
		input_cost_per_token_batches: 0.000001,
		input_cost_per_image: 0.01,
		search_context_cost_per_query: { search_context_size_high: 0.03 },
		long_context_input_token_threshold: 200000,
		long_context_input_cost_multiplier: 2,
		long_context_pricing_basis: "marginal",
	});
	const missing: string[] = [];
	const require = (key: string) => {
		if (t(key, { defaultValue: "\u0000" }) === "\u0000") missing.push(key);
	};
	require(`card.categories.${view.category}`);
	if (view.pricingBasis) require(`card.basis.${view.pricingBasis}`);
	for (const group of view.prices) {
		require(`card.tiers.${group.tier}`);
		for (const row of group.rows) {
			require(`card.components.${row.component}`);
			require(`card.modalities.${row.modality}`);
			require(`card.units.${row.unit}`);
			if (row.cacheDuration) require(`card.cache.${row.cacheDuration}`);
		}
	}
	for (const field of view.fields) require(`card.groups.${field.group}`);
	expect(missing).toEqual([]);
});

test("the price view separates service tiers, cache durations and context thresholds", () => {
	const view = modelCardView({
		input_cost_per_token: 0.000002,
		input_cost_per_token_batches: 0.000001,
		cache_creation_input_token_cost: 0.0000025,
		cache_creation_input_token_cost_above_1hr: 0.000004,
		long_context_input_token_threshold: 200000,
		long_context_input_cost_multiplier: 2,
	});
	const tiers = view.prices.map((group) => group.tier);
	expect(tiers).toEqual(["standard", "batch"]);
	const standard = view.prices.find((group) => group.tier === "standard")?.rows ?? [];
	// The batch rate never lands in the standard tier.
	expect(standard.every((row) => row.tier === "standard")).toBe(true);
	// Two cache-write durations remain separate rows rather than collapsing, and each
	// keeps its own derived threshold row instead of sharing one.
	expect(
		standard
			.filter((row) => row.component === "cacheWrite" && row.thresholdTokens === null)
			.map((row) => row.cacheDuration),
	).toEqual(["default", "1h"]);
	expect(
		standard
			.filter((row) => row.component === "cacheWrite" && row.thresholdTokens === 200000)
			.map((row) => row.cacheDuration),
	).toEqual(["default", "1h"]);
	// The threshold row is derived from the multiplier and marked as such, with the
	// tiny per-token rate preserved exactly rather than rounded to zero.
	const derived = standard.find(
		(row) => row.thresholdTokens === 200000 && row.component === "input",
	);
	expect(derived?.derived).toBe(true);
	expect(derived?.rate).toBe("0.000004");
	expect(derived?.displayRate).toBe("4");
	// The input multiplier must not be reused for a cache-write row; that row derives
	// from its own duration-specific base rate.
	expect(
		standard.find((row) => row.thresholdTokens === 200000 && row.cacheDuration === "default")?.rate,
	).toBe("0.000005");
});
