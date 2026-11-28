import { afterEach, describe, expect, test } from "bun:test";
import { syncDeepSeekBalanceCache } from "./deepseek-balance-cache";
import { getEffectiveModelCard, setModelOverride } from "./model-catalog";
import { buildRuntimeModelSummary } from "./model-runtime";
import { deleteNugCachedModels, setNugCachedModels } from "./nug-model-cache";
import { resolveAggregation, settings } from "./settings";
import { buildRuntimeSettings } from "./settings/runtime";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

afterEach(() => {
	deleteNugCachedModels("runtime-gateway");
	setModelOverride("connection", "runtime-nug:anthropic:claude-sonnet-4-5", null);
});

describe("bounded runtime projections", () => {
	test("settings projects before reading huge configuration or model arrays", () => {
		const source = { ...settings, agent: { ...settings.agent, summaryModel: "" } };
		for (const field of ["customApiProviders", "nugProviders", "auth", "speech"])
			Object.defineProperty(source, field, {
				get() {
					throw new Error(`unrelated ${field}`);
				},
			});
		for (const field of ["customModels", "modelAggregations", "defaultSystemPrompt"])
			Object.defineProperty(source.agent, field, {
				get() {
					throw new Error(`unrelated ${field}`);
				},
			});
		const dto = buildRuntimeSettings(source);
		expect(bytes(dto)).toBeLessThan(4 * 1024);
		expect(dto).not.toHaveProperty("nugProviders");
		expect(dto.agent).not.toHaveProperty("defaultSystemPrompt");
		expect(dto).not.toHaveProperty("update");
		expect(buildRuntimeSettings(source, true).updateSettingsKey).toBeString();
	});

	test("100 summary reads never advance balanced routing or guess the first member", () => {
		const id = `runtime-${crypto.randomUUID()}`;
		settings.agent.modelAggregations = [
			{ id, name: "balanced", routingMode: "balanced", models: ["anthropic:A", "openai:B"] },
		];
		expect(resolveAggregation(id)).toBe("anthropic:A");
		for (let index = 0; index < 100; index++) {
			const dto = buildRuntimeModelSummary({ selection: `__agg__:${id}` });
			expect(dto.state).toBe("not-observed");
			expect(dto.concreteValue).toBeNull();
		}
		expect(resolveAggregation(id)).toBe("openai:B");
	});

	test("bare upstream model does not replace the actual observed B source with A", () => {
		const summary = buildRuntimeModelSummary({
			selection: "auto:claude-sonnet-4-5",
			observation: {
				requestedModel: "auto:claude-sonnet-4-5",
				provider: "actual-B",
				model: "claude-sonnet-4-5",
				concreteValue: "actual-B:claude-sonnet-4-5",
				resolvedAt: 123,
			},
		});
		expect(summary.state).toBe("observed");
		expect(summary.concreteValue).toBe("actual-B:claude-sonnet-4-5");
		expect(summary.resolvedProvider).toBe("actual-B");
		expect(bytes(summary)).toBeLessThan(2 * 1024);
		expect(
			buildRuntimeModelSummary({ selection: "auto:claude-sonnet-4-5" }).concreteValue,
		).toBeNull();
	});

	test("selection mismatch ignores old observations; parent and pinned refs remain non-routing", () => {
		expect(
			buildRuntimeModelSummary({
				selection: "auto:new",
				observation: {
					requestedModel: "auto:old",
					provider: "A",
					model: "old",
					concreteValue: "A:old",
					resolvedAt: 1,
				},
			}).state,
		).toBe("not-observed");
		expect(
			buildRuntimeModelSummary({
				selection: "__parent__",
				inheritance: {
					source: "parent",
					model: "openai:B",
					parentModel: "openai:B",
				},
			}).concreteValue,
		).toBe("openai:B");
		expect(buildRuntimeModelSummary({ selection: "__agg__:example:openai:B" }).concreteValue).toBe(
			"openai:B",
		);
	});

	test("gateway missing, empty, and populated levels stay distinct and respect local overrides", () => {
		settings.nugProviders = [
			{
				id: "runtime-gateway",
				name: "Gateway",
				prefix: "runtime-nug",
				apiKey: "secret",
				baseUrl: "https://private.invalid",
				defaultModel: "anthropic:claude-sonnet-4-5",
			},
		];
		for (const tiers of [undefined, [], ["low", "high"]]) {
			setNugCachedModels("runtime-gateway", [
				{
					id: "anthropic:claude-sonnet-4-5",
					...(tiers !== undefined ? { effortLevels: tiers } : {}),
				},
			]);
			const dto = buildRuntimeModelSummary({
				selection: "runtime-nug:anthropic:claude-sonnet-4-5",
			});
			if (tiers !== undefined) expect(dto.effortLevels).toEqual(tiers);
			expect(JSON.stringify(dto)).not.toContain("private.invalid");
			expect(JSON.stringify(dto)).not.toContain("secret");
		}
		setModelOverride("connection", "runtime-nug:anthropic:claude-sonnet-4-5", {
			reasoningLevels: [],
		});
		expect(
			buildRuntimeModelSummary({ selection: "runtime-nug:anthropic:claude-sonnet-4-5" })
				.effortLevels,
		).toEqual([]);
		setModelOverride("connection", "runtime-nug:anthropic:claude-sonnet-4-5", null);
		const card = getEffectiveModelCard("anthropic:claude-sonnet-4-5");
		setNugCachedModels("runtime-gateway", [
			{
				id: "anthropic:claude-sonnet-4-5",
				effortLevels: ["high"],
				modelCard: { ...card, metadata: { reasoning_effort_levels: null } },
			},
		]);
		expect(
			buildRuntimeModelSummary({ selection: "runtime-nug:anthropic:claude-sonnet-4-5" })
				.effortLevels,
		).toEqual(["high"]);
	});

	test("runtime GPT-6.2 tiers follow the adapter after the per-model protocol override", () => {
		const providers = settings.openaiProviders;
		const overrides = settings.agent.modelProtocolOverrides;
		const selection = "runtime-codex:gpt-6.2-sol";
		settings.openaiProviders = [
			{
				id: "runtime-codex",
				prefix: "runtime-codex",
				name: "Relay",
				apiKey: "key",
				baseUrl: "https://relay.invalid",
				defaultModel: "gpt-6.2-sol",
				apiMode: "codex",
			},
		];
		try {
			settings.agent.modelProtocolOverrides = { [selection]: "openai-responses" };
			expect(buildRuntimeModelSummary({ selection }).capabilities?.channelType).toBe("codex");
			settings.agent.modelProtocolOverrides = { [selection]: "completions-compatible" };
			const summary = buildRuntimeModelSummary({ selection });
			expect(summary.capabilities?.channelType).toBe("openai");
			expect(summary.effortLevels).not.toEqual(["low", "medium", "high", "xhigh", "max"]);
		} finally {
			settings.agent.modelProtocolOverrides = overrides;
			settings.openaiProviders = providers;
		}
	});

	test("GPT-6.2 Codex defaults follow the concrete route without inventing none", () => {
		const previous = settings.nugProviders;
		settings.nugProviders = [
			{
				id: "runtime-gateway",
				prefix: "runtime-nug",
				name: "Gateway",
				apiKey: "secret",
				baseUrl: "https://private.invalid",
				defaultModel: "codex:gpt-6.2-sol",
			},
		];
		try {
			const selection = "runtime-nug:codex:gpt-6.2-sol";
			expect(buildRuntimeModelSummary({ selection }).reasoning).toMatchObject({
				levels: ["low", "medium", "high", "xhigh", "max"],
				canDisable: false,
			});
			expect(
				buildRuntimeModelSummary({ selection: "codex:gpt-6.2-astra" }).reasoning,
			).toMatchObject({
				levels: ["low", "medium", "high", "xhigh", "max"],
				canDisable: false,
			});
			expect(
				buildRuntimeModelSummary({ selection: "openai:gpt-6.2-sol" }).reasoning.levels,
			).not.toEqual(["low", "medium", "high", "xhigh", "max"]);
			expect(buildRuntimeModelSummary({ selection: "auto:gpt-6.2-sol" }).reasoning).toEqual({});
			expect(
				buildRuntimeModelSummary({
					selection: "auto:gpt-6.2-sol",
					observation: {
						requestedModel: "auto:gpt-6.2-sol",
						provider: "runtime-nug",
						model: "codex:gpt-6.2-sol",
						concreteValue: selection,
						resolvedAt: 10,
					},
				}).reasoning.canDisable,
			).toBe(false);
			for (const levels of [[], ["low", "high"], ["none", "high", " ULTRA "]]) {
				setNugCachedModels("runtime-gateway", [{ id: "codex:gpt-6.2-sol", effortLevels: levels }]);
				const summary = buildRuntimeModelSummary({ selection });
				expect(summary.effortLevels).toEqual(levels.filter((level) => level !== " ULTRA "));
				expect(summary.reasoning.canDisable).toBe(levels.includes("none"));
			}
		} finally {
			settings.nugProviders = previous;
		}
	});

	test("summary readiness proves invalid and missing credentials false, leaves auto unknown", () => {
		settings.agent.summaryModel = "invalid-provider:model";
		expect(buildRuntimeSettings(settings).summaryModelAvailable).toBe(false);
		settings.nugProviders = [
			{
				id: "runtime-gateway",
				name: "Gateway",
				prefix: "runtime-nug",
				apiKey: "",
				baseUrl: "https://private.invalid",
				defaultModel: "anthropic:claude-sonnet-4-5",
			},
		];
		settings.agent.summaryModel = "runtime-nug:anthropic:claude-sonnet-4-5";
		expect(buildRuntimeSettings(settings).summaryModelAvailable).toBe(false);
		settings.nugProviders = settings.nugProviders.map((provider) => ({
			...provider,
			apiKey: "configured",
		}));
		expect(buildRuntimeSettings(settings).summaryModelAvailable).toBe(true);
		settings.agent.summaryModel = "__agg__:removed:runtime-nug:anthropic:claude-sonnet-4-5";
		expect(buildRuntimeSettings(settings).summaryModelAvailable).toBe(true);
		settings.agent.summaryModel = "auto:claude-sonnet-4-5";
		expect(buildRuntimeSettings(settings).summaryModelAvailable).toBeNull();
	});

	test("current-provider generation never exposes a token for replaced credentials", () => {
		settings.customApiProviders = [
			{
				id: "runtime-deepseek",
				prefix: "runtime-deepseek",
				name: "DeepSeek",
				protocol: "completions-compatible",
				apiKey: "A",
				baseUrl: "https://api.deepseek.com",
				defaultModel: "deepseek-chat",
			},
		];
		syncDeepSeekBalanceCache();
		expect(
			buildRuntimeModelSummary({ selection: "runtime-deepseek:deepseek-chat" }).provider
				?.generation,
		).toBeString();
		settings.customApiProviders = settings.customApiProviders.map((provider) => ({
			...provider,
			apiKey: "B",
		}));
		expect(
			buildRuntimeModelSummary({ selection: "runtime-deepseek:deepseek-chat" }).provider
				?.generation,
		).toBeUndefined();
	});

	test("oversized identifiers explicitly fail rather than truncating to empty success", () => {
		expect(() => buildRuntimeModelSummary({ selection: `openai:${"x".repeat(2000)}` })).toThrow();
	});
});
