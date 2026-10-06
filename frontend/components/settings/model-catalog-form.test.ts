import { describe, expect, test } from "bun:test";
import { buildCatalogPatch, metadataFromPatch } from "./model-catalog-form";

describe("model catalog explicit leaf operations", () => {
	test("opening a form without touching fields is a no-op", () =>
		expect(buildCatalogPatch({})).toBeNull());
	test("zero, unknown, false, empty list and reset remain distinct", () => {
		const patch = buildCatalogPatch({
			"referencePricing.input": { mode: "set", value: "0.000" },
			"referencePricing.output": { mode: "unknown" },
			"nativeSearch.supported": { mode: "set", value: "false" },
			"reasoning.levels": { mode: "set", value: "" },
			"limits.contextWindow": { mode: "reset" },
		});
		expect(patch).toEqual({
			set: {
				"referencePricing.input": "0",
				"referencePricing.output": null,
				"nativeSearch.supported": false,
				"reasoning.levels": [],
			},
			reset: ["limits.contextWindow"],
		});
		expect(metadataFromPatch(patch)).toEqual({
			referencePricing: { input: "0", output: null },
			nativeSearch: { supported: false },
			reasoning: { levels: [] },
		});
	});
	test("blank prices and zero token limits never silently become free or inherit", () => {
		for (const value of ["", " ", "-1", "1e2", "NaN"])
			expect(() =>
				buildCatalogPatch({ "referencePricing.input": { mode: "set", value } }),
			).toThrow();
		for (const value of ["", "0", "-1", "1.5", "Infinity"])
			expect(() => buildCatalogPatch({ "limits.contextWindow": { mode: "set", value } })).toThrow();
	});
	test("new metadata contains only selected leaves and decimal strings stay exact", () => {
		expect(
			metadataFromPatch(
				buildCatalogPatch({
					"referencePricing.input": { mode: "set", value: "0.000000000000000001" },
				}),
			),
		).toEqual({ referencePricing: { input: "0.000000000000000001" } });
	});
});
