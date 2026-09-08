import { describe, expect, test } from "bun:test";
import { REASONING_EFFORT_VALUES } from "@shared/reasoning-effort";
import {
	MAX_SUBAGENT_FIXED_EFFORTS_PER_POOL,
	MAX_SUBAGENT_MODEL_REFERENCE_LENGTH,
	SUBAGENT_POOL_TYPES,
} from "@shared/subagent-model-policy";
import { normalizeSubagentModelRestriction } from "../../../server/lib/narrator-custom-traits";
import {
	validateSubagentModelReasoningEffortsInput,
	validateSubagentModelRestrictionInput,
} from "../../../server/lib/validators/subagent-models";

describe("subagent fixed effort map validation", () => {
	test("accepts sparse maps, all five pools and all shared tiers", () => {
		expect(validateSubagentModelReasoningEffortsInput({})).toEqual({});
		for (const type of SUBAGENT_POOL_TYPES) {
			for (const effort of REASONING_EFFORT_VALUES) {
				const input = { [type]: { "__agg__:pool:provider:model [note]": effort } };
				expect(validateSubagentModelReasoningEffortsInput(input)).toEqual(input);
			}
		}
	});

	test("accepts boundary sizes and rejects excessive maps and references", () => {
		const pool = Object.fromEntries(
			Array.from(
				{ length: MAX_SUBAGENT_FIXED_EFFORTS_PER_POOL },
				(_, i) => [`m${i}`, "high"] as const,
			),
		);
		expect(validateSubagentModelReasoningEffortsInput({ explore: pool })).toEqual({
			explore: pool,
		});
		expect(() =>
			validateSubagentModelReasoningEffortsInput({ explore: { ...pool, extra: "high" } }),
		).toThrow();
		const maxKey = "m".repeat(MAX_SUBAGENT_MODEL_REFERENCE_LENGTH);
		expect(validateSubagentModelReasoningEffortsInput({ plan: { [maxKey]: "none" } })).toEqual({
			plan: { [maxKey]: "none" },
		});
		expect(() =>
			validateSubagentModelReasoningEffortsInput({ plan: { [`${maxKey}x`]: "high" } }),
		).toThrow();
	});

	test("rejects unknown types, malformed maps and illegal tiers", () => {
		for (const input of [
			null,
			[],
			"high",
			{ custom: {} },
			{ explore: [] },
			{ explore: null },
			{ explore: { "": "high" } },
			...["auto", "inherit", "", "HIGH", null, 1, {}].map((value) => ({
				explore: { model: value },
			})),
		]) {
			expect(() => validateSubagentModelReasoningEffortsInput(input)).toThrow();
		}
	});
});

describe("trait metadata write validation", () => {
	test("leaves legacy tolerant model and purpose normalization unchanged", () => {
		const input = {
			pools: {
				" My Pool ": [" legacy ", { model: " object ", purpose: " purpose " }, null, 42],
				empty: false,
			},
		};
		expect(() => validateSubagentModelRestrictionInput(input)).not.toThrow();
		expect(normalizeSubagentModelRestriction(input)).toEqual({
			version: 1,
			pools: {
				"my-pool": [{ model: "legacy" }, { model: "object", purpose: "purpose" }],
				empty: [],
			},
		});
	});

	test("accepts all new tiers for custom pool names and both body shapes", () => {
		for (const reasoningEffort of REASONING_EFFORT_VALUES) {
			const pools = { custom: [{ model: "p:m", purpose: "task", reasoningEffort }] };
			expect(() => validateSubagentModelRestrictionInput(pools)).not.toThrow();
			expect(() => validateSubagentModelRestrictionInput({ pools })).not.toThrow();
		}
	});

	test("rejects explicit invalid tiers even on entries normalization would discard", () => {
		for (const reasoningEffort of ["auto", "inherit", "", "HIGH", null, undefined, 1, {}]) {
			for (const model of ["p:m", "", null]) {
				expect(() =>
					validateSubagentModelRestrictionInput({
						pools: { general: [{ model, reasoningEffort }] },
					}),
				).toThrow("Invalid subagent reasoning effort");
			}
		}
	});
});
