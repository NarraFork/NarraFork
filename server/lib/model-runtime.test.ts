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

	test("gateway missing, empty and populated levels plus local explicit null stay distinct", () => {
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
		).toBeNull();
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
