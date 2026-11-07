import { describe, expect, test } from "bun:test";
import bundledCatalog from "./dist/catalog.json";
import {
	normalizeOverride,
	OverrideValidationError,
	overrideToRaw,
	rawToOverride,
} from "./override";
import { modelProfile } from "./profile";
import { identifyModel, resolveModelCard } from "./resolve";
import type { RawCatalog } from "./schema/catalog";

const catalog = bundledCatalog as RawCatalog;
const profile = (input: Omit<Parameters<typeof resolveModelCard>[0], "catalog">) =>
	modelProfile(resolveModelCard({ catalog, ...input }));

describe("identity", () => {
	test("exact, alias, dated suffix and vendor-prefixed ids reach the same model", () => {
		for (const id of [
			"claude-opus-4-6",
			"claude-opus-4.6",
			"claude-opus-4-6-20260101",
			"anthropic/claude-opus-4.6",
		])
			expect(identifyModel(catalog, { upstreamModelId: id }).modelId).toBe("claude-opus-4-6");
	});

	test("a provider variant wins for its own channel only", () => {
		expect(
			identifyModel(catalog, { upstreamModelId: "gpt-5.5", providerKey: "codex" }),
		).toMatchObject({
			modelId: "gpt-5.5",
			variantId: "gpt-5.5@codex",
		});
		expect(identifyModel(catalog, { upstreamModelId: "gpt-5.5" }).variantId).toBeUndefined();
	});

	test("an unknown id resolves to nothing instead of throwing", () => {
		const card = resolveModelCard({ catalog, query: { upstreamModelId: "no-such-model-x" } });
		expect(card.matchedVia).toBe("none");
		expect(card.metadata).toEqual({});
	});

	test("a prefix look-alike borrows limits but never prices", () => {
		const card = resolveModelCard({ catalog, query: { upstreamModelId: "claude-opus-4-6-foo" } });
		expect(card.matchedVia).toBe("prefix");
		expect(modelProfile(card).contextWindow).toBeGreaterThan(0);
		expect(modelProfile(card).referencePricing?.input).toBeUndefined();
	});
});

describe("layers", () => {
	const query = { upstreamModelId: "claude-opus-4-6" };

	test("discovered beats the catalog; a provider-entry override beats a model-wide one", () => {
		expect(profile({ query, discovered: { max_input_tokens: 500_000 } }).contextWindow).toBe(
			500_000,
		);
		const both = profile({
			query,
			modelOverrides: new Map([
				["claude-opus-4-6", { contextWindow: 300_000, maxOutputTokens: 9_000 }],
			]),
			connectionOverride: { contextWindow: 200_000 },
		});
		expect(both.contextWindow).toBe(200_000);
		expect(both.contextWindowSource?.layer).toBe("local-connection");
		expect(both.maxOutputTokens).toBe(9_000);
	});

	test("a model-wide override does not reach a look-alike", () => {
		const modelOverrides = new Map([["claude-opus-4-6", { maxOutputTokens: 1_234 }]]);
		expect(
			profile({ query: { upstreamModelId: "claude-opus-4-6-foo" }, modelOverrides })
				.maxOutputTokens,
		).not.toBe(1_234);
	});

	test("prices are USD per million in the override and per token in the card", () => {
		const card = resolveModelCard({
			catalog,
			query,
			connectionOverride: { prices: { input: "3" } },
		});
		expect(card.metadata.input_cost_per_token).toBe("0.000003");
		expect(modelProfile(card).referencePricing?.input).toBe("3");
	});

	test("a default level the effective levels drop is removed, not thrown", () => {
		const card = resolveModelCard({
			catalog,
			query: { upstreamModelId: "deepseek-v4-pro" },
			discovered: { default_reasoning_effort: "medium" },
			connectionOverride: { reasoningLevels: ["low", "high"] },
		});
		expect(modelProfile(card).reasoning.defaultLevel).toBeUndefined();
	});
});

describe("overrides", () => {
	test("rejects bad values with the field that caused them", () => {
		const reject = (input: unknown) => {
			try {
				normalizeOverride(input);
			} catch (error) {
				return error instanceof OverrideValidationError ? error.field : "other";
			}
			return "accepted";
		};
		expect(reject({ contextWindow: 0 })).toBe("contextWindow");
		expect(reject({ inputModalities: ["image"] })).toBe("inputModalities");
		expect(reject({ reasoningLevels: ["turbo"] })).toBe("reasoningLevels");
		expect(reject({ reasoningLevels: ["low"], defaultReasoningLevel: "high" })).toBe(
			"defaultReasoningLevel",
		);
		expect(reject({ prices: { input: "-1" } })).toBe("prices.input");
		expect(reject({ contextWindow: null, unknownKey: 1 })).toBe("accepted");
	});

	test("an old raw layer converts to the typed fields it can express", () => {
		expect(
			rawToOverride({
				working_context_tokens: 64_000,
				max_input_tokens: 999,
				supports_vision: true,
				output_cost_per_token: "0.000015",
				mode: "chat",
			}),
		).toEqual({
			contextWindow: 64_000,
			inputModalities: ["text", "image"],
			prices: { output: "15" },
		});
		expect(overrideToRaw({ contextWindow: 64_000, toolLoadingModes: [] })).toEqual({
			working_context_tokens: 64_000,
			tool_loading_modes: [],
		});
	});
});
