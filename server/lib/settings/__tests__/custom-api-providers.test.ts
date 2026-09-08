import { describe, expect, test } from "bun:test";
import {
	customApiProtocolFromOpenAI,
	customApiProviderToGemini,
	deriveCustomApiProvidersFromLegacy,
	geminiProviderToCustomApi,
	getProviderPrefixChanges,
	migrateProviderPrefixReferences,
	normalizeCustomApiProvider,
} from "../custom-api-providers";
import { DEFAULTS } from "../defaults";
import type { GeminiProviderConfig, NarraForkSettings, OpenAIProviderConfig } from "../types";

describe("custom API provider migration", () => {
	test("preserves legacy responsesApi=false as completions-compatible", () => {
		const provider: OpenAIProviderConfig = {
			id: "legacy-openai",
			name: "Legacy OpenAI Compatible",
			prefix: "legacy",
			apiKey: "sk-test",
			baseUrl: "https://example.com/v1",
			defaultModel: "test-model",
			responsesApi: false,
		};

		expect(customApiProtocolFromOpenAI(provider)).toBe("completions-compatible");
		expect(deriveCustomApiProvidersFromLegacy([provider], [])[0]?.protocol).toBe(
			"completions-compatible",
		);
	});

	test("apiMode takes precedence over legacy responsesApi", () => {
		const provider: OpenAIProviderConfig = {
			id: "explicit-responses",
			name: "Explicit Responses",
			prefix: "responses",
			apiKey: "sk-test",
			baseUrl: "https://example.com/v1",
			defaultModel: "test-model",
			responsesApi: false,
			apiMode: "responses",
		};

		expect(customApiProtocolFromOpenAI(provider)).toBe("responses-compatible");
	});

	test("preserves legacy Gemini providers and their keys when split arrays are merged", () => {
		const gemini: GeminiProviderConfig = {
			id: "gemini-id",
			name: "Gemini",
			prefix: "google",
			apiKey: "real-gemini-key",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			defaultModel: "gemini-2.5-flash",
		};

		expect(deriveCustomApiProvidersFromLegacy([], [], [gemini])).toEqual([
			expect.objectContaining({
				id: "gemini-id",
				prefix: "google",
				apiKey: "real-gemini-key",
				protocol: "gemini-compatible",
			}),
		]);
	});

	test("Gemini legacy, unified, and normalized conversions preserve transport with safe defaults", () => {
		const legacy: GeminiProviderConfig = {
			id: "gemini-legacy",
			name: "Gemini Legacy",
			prefix: "gemini",
			apiKey: "secret",
			baseUrl: "https://example.com/v1beta",
			defaultModel: "gemini-model",
		};
		const defaultUnified = geminiProviderToCustomApi(legacy);
		expect(defaultUnified.geminiTransport).toBe("generate-content");
		expect(customApiProviderToGemini(defaultUnified)?.geminiTransport).toBe("generate-content");

		const interactionsUnified = geminiProviderToCustomApi({
			...legacy,
			geminiTransport: "interactions",
		});
		expect(interactionsUnified.geminiTransport).toBe("interactions");
		expect(customApiProviderToGemini(interactionsUnified)?.geminiTransport).toBe("interactions");
		expect(
			normalizeCustomApiProvider({
				...defaultUnified,
				geminiTransport: undefined,
			}).geminiTransport,
		).toBe("generate-content");
	});

	test("migrates every agent model reference when a stable provider id changes prefix", () => {
		const settings = structuredClone(DEFAULTS) as NarraForkSettings;
		settings.agent.defaultModel = "old:model-default";
		settings.agent.summaryModel = "__agg__:summary:old:model-summary";
		settings.agent.translationModel = "old:model-translation";
		settings.agent.subagentModels = {
			explore: "old:model-explore",
			plan: "other:model-plan",
			search: "old:model-search",
		};
		settings.agent.subagentAllowedModels = {
			explore: ["old:model-a"],
			plan: ["other:model-b"],
			general: ["old:model-c"],
			search: ["old:model-d"],
		};
		settings.agent.modelAggregations = [
			{
				id: "agg",
				name: "Aggregation",
				models: ["old:model-a", "other:model-b"],
				routingMode: "priority",
			},
		];
		settings.agent.hiddenModels = ["old:hidden"];
		settings.agent.customModels = [{ value: "old:custom", label: "Custom", provider: "old" }];
		settings.agent.modelContextWindows = { "old:model-a": 123, "other:model-b": 456 };
		settings.agent.providerOrder = ["other", "old"];
		settings.agent.disabledProviders = ["old"];

		const changes = getProviderPrefixChanges(
			[[{ id: "stable", prefix: "old" }]],
			[[{ id: "stable", prefix: "new" }]],
		);
		expect(migrateProviderPrefixReferences(settings, changes)).toBe(true);
		expect(settings.agent).toMatchObject({
			defaultModel: "new:model-default",
			summaryModel: "__agg__:summary:new:model-summary",
			translationModel: "new:model-translation",
			subagentModels: {
				explore: "new:model-explore",
				plan: "other:model-plan",
				search: "new:model-search",
			},
			subagentAllowedModels: {
				explore: ["new:model-a"],
				plan: ["other:model-b"],
				general: ["new:model-c"],
				search: ["new:model-d"],
			},
			hiddenModels: ["new:hidden"],
			customModels: [{ value: "new:custom", label: "Custom", provider: "new" }],
			modelContextWindows: { "new:model-a": 123, "other:model-b": 456 },
			providerOrder: ["other", "new"],
			disabledProviders: ["new"],
		});
		expect(settings.agent.modelAggregations?.[0]?.models).toEqual(["new:model-a", "other:model-b"]);
	});

	test("migrates effort keys including aggregate members and preserves per-type tiers", () => {
		const settings = structuredClone(DEFAULTS);
		settings.agent.subagentModelReasoningEfforts = {
			explore: { "old:model [note]": "high", __default__: "none" },
			plan: { "__agg__:pool:old:model": "medium", __summary__: "max" },
			search: { "old:model": "low" },
			review: { "old:model": "xhigh" },
			general: {},
		};
		const changes = [{ id: "stable", from: "old", to: "new" }];
		expect(migrateProviderPrefixReferences(settings, changes)).toBe(true);
		expect(settings.agent.subagentModelReasoningEfforts).toEqual({
			explore: { "new:model [note]": "high", __default__: "none" },
			plan: { "__agg__:pool:new:model": "medium", __summary__: "max" },
			search: { "new:model": "low" },
			review: { "new:model": "xhigh" },
			general: {},
		});
		// Only effort keys changed; before/after must include that field, and be idempotent.
		expect(migrateProviderPrefixReferences(settings, changes)).toBe(false);
	});

	test("merges identical effort targets without changing another pool", () => {
		const settings = structuredClone(DEFAULTS);
		settings.agent.subagentModelReasoningEfforts = {
			explore: { "old:model": "none", "new:model": "none" },
			general: { "new:model": "max" },
		};
		expect(
			migrateProviderPrefixReferences(settings, [{ id: "stable", from: "old", to: "new" }]),
		).toBe(true);
		expect(settings.agent.subagentModelReasoningEfforts).toEqual({
			explore: { "new:model": "none" },
			general: { "new:model": "max" },
		});
	});

	test("rejects conflicting effort targets before any settings mutation", () => {
		const settings = structuredClone(DEFAULTS);
		settings.agent.defaultModel = "old:default";
		settings.agent.subagentAllowedModels.explore = ["old:model"];
		settings.agent.modelContextWindows = { "old:model": 123 };
		settings.agent.subagentModelReasoningEfforts = {
			explore: { "old:model": "high" },
			review: { "old:model": "low", "new:model": "max" },
		};
		const before = structuredClone(settings);
		expect(() =>
			migrateProviderPrefixReferences(settings, [{ id: "stable", from: "old", to: "new" }]),
		).toThrow("would overwrite subagent reasoning effort");
		expect(settings).toEqual(before);
	});

	test("keeps optional map absent when migrating legacy settings", () => {
		const settings = structuredClone(DEFAULTS);
		delete settings.agent.subagentModelReasoningEfforts;
		settings.agent.defaultModel = "old:model";
		migrateProviderPrefixReferences(settings, [{ id: "stable", from: "old", to: "new" }]);
		expect(settings.agent.subagentModelReasoningEfforts).toBeUndefined();
	});

	test("does not let malformed optional disk maps block unrelated prefix migration", () => {
		for (const value of [null, [], "invalid"]) {
			const settings = structuredClone(DEFAULTS);
			settings.agent.defaultModel = "old:model";
			settings.agent.subagentModelReasoningEfforts =
				value as unknown as NarraForkSettings["agent"]["subagentModelReasoningEfforts"];
			migrateProviderPrefixReferences(settings, [{ id: "stable", from: "old", to: "new" }]);
			expect(settings.agent.defaultModel).toBe("new:model");
			expect(settings.agent.subagentModelReasoningEfforts as unknown).toEqual(value);
		}
	});

	test("rejects prefix migration when context-window targets conflict", () => {
		const settings = structuredClone(DEFAULTS) as NarraForkSettings;
		settings.agent.modelContextWindows = {
			"old:model": 100,
			"new:model": 200,
		};
		expect(() =>
			migrateProviderPrefixReferences(settings, [{ id: "stable", from: "old", to: "new" }]),
		).toThrow("would overwrite context window");
	});

	test("rejects prefix migration when custom-model targets conflict", () => {
		const settings = structuredClone(DEFAULTS) as NarraForkSettings;
		settings.agent.customModels = [
			{ value: "old:model", label: "Old", provider: "old" },
			{ value: "new:model", label: "New", provider: "new" },
		];
		expect(() =>
			migrateProviderPrefixReferences(settings, [{ id: "stable", from: "old", to: "new" }]),
		).toThrow("conflicting custom model");
	});
});
