import { describe, expect, test } from "bun:test";
import {
	customApiProtocolFromOpenAI,
	customApiProviderToGemini,
	defaultUserAgentModeForProtocol,
	deriveCustomApiProvidersFromLegacy,
	geminiProviderToCustomApi,
	getProviderPrefixChanges,
	migrateProviderPrefixReferences,
	normalizeCustomApiProvider,
	normalizeCustomApiProviderSettings,
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

		expect(customApiProtocolFromOpenAI(provider)).toBe("openai-responses");
	});

	test("legacy plain-Responses entries keep native tools off and the NarraFork UA", () => {
		const provider: OpenAIProviderConfig = {
			id: "legacy-responses",
			name: "Legacy Responses",
			prefix: "legacy-resp",
			apiKey: "sk-test",
			baseUrl: "https://example.com/v1",
			defaultModel: "test-model",
			apiMode: "responses",
		};

		expect(deriveCustomApiProvidersFromLegacy([provider], [])[0]).toMatchObject({
			protocol: "openai-responses",
			codexWebSearch: false,
			codexImageGeneration: false,
			userAgentMode: "narrafork",
		});
	});

	test("ghost materialized tool flags on plain-Responses entries are forced off", () => {
		// Older versions materialized codexWebSearch/codexImageGeneration=true onto
		// every persisted entry regardless of protocol. Those flags never took
		// effect for plain Responses, so they must not survive the fold.
		const provider: OpenAIProviderConfig = {
			id: "ghost",
			name: "Ghost Flags",
			prefix: "ghost",
			apiKey: "sk-test",
			baseUrl: "https://example.com/v1",
			defaultModel: "test-model",
			apiMode: "responses",
			codexWebSearch: true,
			codexImageGeneration: true,
		};

		expect(deriveCustomApiProvidersFromLegacy([provider], [])[0]).toMatchObject({
			protocol: "openai-responses",
			codexWebSearch: false,
			codexImageGeneration: false,
		});
	});

	test("legacy Codex entries keep native tools on the unified protocol defaults", () => {
		const provider: OpenAIProviderConfig = {
			id: "legacy-codex",
			name: "Legacy Codex",
			prefix: "legacy-codex",
			apiKey: "sk-test",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			defaultModel: "gpt-5.6",
			apiMode: "codex",
		};

		const [derived] = deriveCustomApiProvidersFromLegacy([provider], []);
		expect(derived?.protocol).toBe("openai-responses");
		// No pins: normalize falls back to the unified defaults (tools on, codex UA).
		if (!derived) throw new Error("expected a derived provider");
		const normalized = normalizeCustomApiProvider(derived);
		expect(normalized.codexWebSearch).toBe(true);
		expect(normalized.codexImageGeneration).toBe(true);
		expect(normalized.userAgentMode).toBe("codex");
	});

	test("legacy non-official Anthropic entries keep native search off", () => {
		const compatible = deriveCustomApiProvidersFromLegacy(
			[],
			[
				{
					id: "legacy-anthropic",
					name: "Legacy Anthropic",
					prefix: "legacy-ant",
					apiKey: "sk-test",
					baseUrl: "https://example.com",
					defaultModel: "claude-opus-5",
					officialApi: false,
					// Inert on non-official entries; must not survive the fold.
					nativeSearch: true,
				},
			],
		)[0];
		expect(compatible).toMatchObject({ protocol: "anthropic-messages", nativeSearch: false });

		const official = deriveCustomApiProvidersFromLegacy(
			[],
			[
				{
					id: "legacy-anthropic-official",
					name: "Legacy Anthropic Official",
					prefix: "legacy-ant-off",
					apiKey: "sk-test",
					baseUrl: "https://api.anthropic.com",
					defaultModel: "claude-opus-5",
					officialApi: true,
					nativeSearch: true,
				},
			],
		)[0];
		expect(official).toMatchObject({ protocol: "anthropic-messages", nativeSearch: true });
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

	test("protocol default User-Agent modes: OpenAI Responses → codex, Anthropic Messages → claude-code", () => {
		expect(defaultUserAgentModeForProtocol("openai-responses")).toBe("codex");
		expect(defaultUserAgentModeForProtocol("anthropic-messages")).toBe("claude-code");
		expect(defaultUserAgentModeForProtocol("completions-compatible")).toBe("narrafork");
		expect(defaultUserAgentModeForProtocol("gemini-compatible")).toBe("narrafork");
	});

	test("normalize materializes the protocol default UA mode when unset", () => {
		const base = {
			id: "p1",
			name: "P",
			prefix: "p",
			apiKey: "k",
			baseUrl: "https://example.com",
			defaultModel: "m",
			codexAccountId: "",
		};

		expect(
			normalizeCustomApiProvider({ ...base, protocol: "openai-responses" }).userAgentMode,
		).toBe("codex");
		expect(
			normalizeCustomApiProvider({ ...base, protocol: "anthropic-messages" }).userAgentMode,
		).toBe("claude-code");
		// An explicit operator choice is preserved.
		expect(
			normalizeCustomApiProvider({
				...base,
				protocol: "openai-responses",
				userAgentMode: "narrafork",
			}).userAgentMode,
		).toBe("narrafork");
	});

	test("removed protocol values migrate to the unified protocols", () => {
		const base = {
			id: "p1",
			name: "P",
			prefix: "p",
			apiKey: "k",
			baseUrl: "https://example.com",
			defaultModel: "m",
		};

		expect(normalizeCustomApiProvider({ ...base, protocol: "codex-native" }).protocol).toBe(
			"openai-responses",
		);
		expect(normalizeCustomApiProvider({ ...base, protocol: "responses-compatible" }).protocol).toBe(
			"openai-responses",
		);
		expect(normalizeCustomApiProvider({ ...base, protocol: "anthropic-official" }).protocol).toBe(
			"anthropic-messages",
		);
		expect(normalizeCustomApiProvider({ ...base, protocol: "anthropic-compatible" }).protocol).toBe(
			"anthropic-messages",
		);
	});

	test("codex-native migration keeps Codex feature defaults on", () => {
		const migrated = normalizeCustomApiProvider({
			id: "p1",
			name: "P",
			prefix: "p",
			apiKey: "k",
			baseUrl: "https://example.com",
			defaultModel: "m",
			protocol: "codex-native",
		});
		expect(migrated.protocol).toBe("openai-responses");
		expect(migrated.codexWebSearch).toBe(true);
		expect(migrated.codexImageGeneration).toBe(true);
		expect(migrated.userAgentMode).toBe("codex");
	});

	test("responses-compatible migration keeps native tools off and pins the NarraFork UA", () => {
		const migrated = normalizeCustomApiProvider({
			id: "p1",
			name: "P",
			prefix: "p",
			apiKey: "k",
			baseUrl: "https://example.com/v1",
			defaultModel: "m",
			protocol: "responses-compatible",
		});
		expect(migrated.protocol).toBe("openai-responses");
		expect(migrated.codexWebSearch).toBe(false);
		expect(migrated.codexImageGeneration).toBe(false);
		expect(migrated.userAgentMode).toBe("narrafork");

		// The real persisted shape: older versions materialized ghost `true`
		// tool flags onto every entry. They had no wire effect for this protocol
		// (the adapter only reads them in codex apiMode), so the migration pins
		// win over them. An explicitly chosen UA survives — that selector was
		// visible for every protocol.
		const withGhostFlags = normalizeCustomApiProvider({
			id: "p1",
			name: "P",
			prefix: "p",
			apiKey: "k",
			baseUrl: "https://example.com/v1",
			defaultModel: "m",
			protocol: "responses-compatible",
			codexWebSearch: true,
			codexImageGeneration: true,
			userAgentMode: "custom",
			customUserAgent: "my-agent",
		});
		expect(withGhostFlags.codexWebSearch).toBe(false);
		expect(withGhostFlags.codexImageGeneration).toBe(false);
		expect(withGhostFlags.userAgentMode).toBe("custom");
	});

	test("anthropic-compatible migration keeps native search off", () => {
		const migrated = normalizeCustomApiProvider({
			id: "p1",
			name: "P",
			prefix: "p",
			apiKey: "k",
			baseUrl: "https://example.com",
			defaultModel: "m",
			protocol: "anthropic-compatible",
		});
		expect(migrated.protocol).toBe("anthropic-messages");
		expect(migrated.nativeSearch).toBe(false);
		expect(migrated.userAgentMode).toBe("claude-code");

		// nativeSearch was inert on compatible entries (the old conversion dropped
		// it), so even a stored `true` is forced off rather than newly enabling
		// server-side search after the fold.
		const withInertSearchFlag = normalizeCustomApiProvider({
			id: "p1b",
			name: "P1b",
			prefix: "p1b",
			apiKey: "k",
			baseUrl: "https://example.com",
			defaultModel: "m",
			protocol: "anthropic-compatible",
			nativeSearch: true,
		});
		expect(withInertSearchFlag.nativeSearch).toBe(false);

		const official = normalizeCustomApiProvider({
			id: "p2",
			name: "P2",
			prefix: "p2",
			apiKey: "k",
			baseUrl: "https://api.anthropic.com",
			defaultModel: "m",
			protocol: "anthropic-official",
		});
		expect(official.protocol).toBe("anthropic-messages");
		expect(official.nativeSearch).toBeUndefined();
	});

	test("settings-level normalization migrates stored protocols and rederives split arrays", () => {
		const settings = structuredClone(DEFAULTS) as NarraForkSettings;
		settings.customApiProviders = [
			{
				id: "legacy-codex",
				name: "Codex Relay",
				prefix: "cx",
				apiKey: "k",
				baseUrl: "https://example.com/backend-api/codex",
				defaultModel: "gpt-5.6",
				protocol: "codex-native",
			},
			{
				id: "legacy-resp",
				name: "Responses Relay",
				prefix: "resp",
				apiKey: "k",
				baseUrl: "https://example.com/v1",
				defaultModel: "gpt-4o",
				protocol: "responses-compatible",
			},
			{
				id: "legacy-ant",
				name: "Anthropic Relay",
				prefix: "ant",
				apiKey: "k",
				baseUrl: "https://example.com",
				defaultModel: "claude-opus-5",
				protocol: "anthropic-compatible",
			},
		] as unknown as NarraForkSettings["customApiProviders"];

		expect(normalizeCustomApiProviderSettings(settings)).toBe(true);
		expect(settings.customApiProviders?.map((p) => p.protocol)).toEqual([
			"openai-responses",
			"openai-responses",
			"anthropic-messages",
		]);
		// Derived OpenAI entries all use the codex apiMode; the migrated
		// responses-compatible provider keeps native tools off.
		expect(settings.openaiProviders?.map((p) => [p.prefix, p.apiMode])).toEqual([
			["cx", "codex"],
			["resp", "codex"],
		]);
		expect(settings.openaiProviders?.[1]?.codexWebSearch).toBe(false);
		// Derived Anthropic entry always speaks the official dialect; the migrated
		// compatible provider keeps native search off.
		expect(settings.anthropicProviders?.map((p) => [p.prefix, p.officialApi])).toEqual([
			["ant", true],
		]);
		expect(settings.anthropicProviders?.[0]?.nativeSearch).toBe(false);

		// Already normalized settings are a no-op.
		expect(normalizeCustomApiProviderSettings(settings)).toBe(false);
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
