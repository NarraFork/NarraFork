import { afterEach, describe, expect, test } from "bun:test";
import {
	__resetModelPricingForTests,
	MODEL_PRICING_TABLE,
	normalizeModelPricingKey,
	resolveModelPricing,
	setModelPricingOverrides,
} from "../model-pricing";
import { calculateCost, type UsageData } from "../usage-tracking";

afterEach(() => {
	__resetModelPricingForTests();
});

function usage(partial: Partial<UsageData>): UsageData {
	return { inputTokens: 0, outputTokens: 0, ...partial };
}

describe("model pricing table", () => {
	test("每一行都有非负价格且 key 唯一", () => {
		const seen = new Set<string>();
		for (const entry of MODEL_PRICING_TABLE) {
			expect(seen.has(entry.modelKey)).toBe(false);
			seen.add(entry.modelKey);
			expect(entry.input).toBeGreaterThanOrEqual(0);
			expect(entry.output).toBeGreaterThanOrEqual(0);
			expect(entry.cacheRead).toBeGreaterThanOrEqual(0);
			expect(entry.cacheWrite).toBeGreaterThanOrEqual(0);
			// Output is always at least as expensive as input for every vendor we price.
			expect(entry.output).toBeGreaterThanOrEqual(entry.input);
		}
	});

	test("alias 不会和真实 key 冲突", () => {
		const keys = new Set(MODEL_PRICING_TABLE.map((e) => e.modelKey));
		for (const entry of MODEL_PRICING_TABLE) {
			for (const alias of entry.aliases ?? []) {
				expect(keys.has(alias)).toBe(false);
			}
		}
	});

	test("GPT 与 Claude 关键行的价格与官方参考价一致", () => {
		expect(resolveModelPricing("gpt-6-astra")).toMatchObject({
			input: 10.0,
			cacheWrite: 12.5,
			cacheRead: 1.0,
			output: 50.0,
		});
		expect(resolveModelPricing("gpt-5.6-sol")).toMatchObject({
			input: 5.0,
			cacheWrite: 6.25,
			cacheRead: 0.5,
			output: 30.0,
		});
		expect(resolveModelPricing("gpt-5.6-terra")).toMatchObject({
			input: 2.5,
			cacheWrite: 3.125,
			cacheRead: 0.25,
			output: 15.0,
		});
		expect(resolveModelPricing("gpt-5.6-luna")).toMatchObject({ input: 1.0, output: 6.0 });
		expect(resolveModelPricing("gpt-5.5")).toMatchObject({ input: 5.0, output: 30.0 });
		expect(resolveModelPricing("claude-opus-4-6")).toMatchObject({ input: 5.0, output: 25.0 });
		expect(resolveModelPricing("claude-sonnet-4-6")).toMatchObject({ input: 3.0, output: 15.0 });
		expect(resolveModelPricing("claude-haiku-4-5")).toMatchObject({ input: 1.0, output: 5.0 });
	});
});

describe("resolveModelPricing lookup rules", () => {
	test("剥离 provider 前缀后精确匹配", () => {
		const direct = resolveModelPricing("gpt-5.5");
		const prefixed = resolveModelPricing("codex:gpt-5.5");
		expect(prefixed?.modelKey).toBe("gpt-5.5");
		expect(prefixed?.matchedVia).toBe("exact");
		expect(prefixed).toEqual(direct);
	});

	test("大小写与空白不影响匹配", () => {
		expect(resolveModelPricing("  GPT-5.5  ")?.modelKey).toBe("gpt-5.5");
		expect(resolveModelPricing("Claude-Opus-4-6")?.modelKey).toBe("claude-opus-4-6");
	});

	test("alias 命中并标记 matchedVia=alias", () => {
		const viaAlias = resolveModelPricing("gpt-5.6");
		expect(viaAlias?.modelKey).toBe("gpt-5.6-sol");
		expect(viaAlias?.matchedVia).toBe("alias");

		const dotted = resolveModelPricing("claude-opus-4.6");
		expect(dotted?.modelKey).toBe("claude-opus-4-6");
		expect(dotted?.matchedVia).toBe("alias");
	});

	test("剥离日期/快照后缀后仍能命中", () => {
		for (const name of [
			"claude-opus-4-6-20260514",
			"claude-opus-4-6-2026-05-14",
			"claude-opus-4-6-latest",
			"claude-opus-4-6-preview",
		]) {
			const resolved = resolveModelPricing(name);
			expect(resolved?.modelKey).toBe("claude-opus-4-6");
			expect(resolved?.matchedVia).toBe("suffix-stripped");
		}
		// Repeated stripping: -preview then the date.
		expect(resolveModelPricing("claude-opus-4-6-preview-2026-05-14")?.modelKey).toBe(
			"claude-opus-4-6",
		);
	});

	test("语义后缀永不剥离，变体不会撞到 Astra 的基座价", () => {
		// A semantic variant is not a dated snapshot. Pricing it as Astra would
		// silently fabricate a rate for a model the builtin catalog no longer lists.
		expect(resolveModelPricing("gpt-6-astra-mini")).toBeNull();
		expect(resolveModelPricing("gpt-6-astra-codex")).toBeNull();
	});

	test("retired builtin GPT/Codex models are unpriced", () => {
		for (const model of [
			"gpt-5-codex",
			"gpt-5.1-codex",
			"gpt-5.2-codex",
			"gpt-5.3-codex",
			"gpt-5.4",
			"gpt-5.4-mini",
		]) {
			expect(resolveModelPricing(model)).toBeNull();
		}
	});

	test("未知模型返回 null 而不是 0 价格", () => {
		expect(resolveModelPricing("totally-unknown-model")).toBeNull();
		expect(resolveModelPricing("")).toBeNull();
		expect(resolveModelPricing(undefined)).toBeNull();
		// A bare family prefix is not a model: pricing must not guess.
		expect(resolveModelPricing("gpt")).toBeNull();
		expect(resolveModelPricing("claude")).toBeNull();
	});

	test("legacy 短名有价格，不会常态化未定价标记", () => {
		// Legacy short aliases are still used for backward compat.
		// Leaving them unpriced pushed every such request into
		// unpricedRequestCount and made the UI's "*" permanent.
		const haiku = resolveModelPricing("claude-haiku");
		expect(haiku?.modelKey).toBe("claude-haiku-4-5");
		expect(haiku?.matchedVia).toBe("alias");
		expect(haiku?.input).toBe(1.0);

		expect(resolveModelPricing("claude-sonnet")?.modelKey).toBe("claude-sonnet-4-5");
		expect(resolveModelPricing("claude-sonnet")?.input).toBe(3.0);
		expect(resolveModelPricing("claude-opus")?.modelKey).toBe("claude-opus-4-5");
		expect(resolveModelPricing("claude-opus")?.input).toBe(5.0);

		// Provider-prefixed spelling resolves too.
		expect(resolveModelPricing("anthropic:claude-sonnet")?.modelKey).toBe("claude-sonnet-4-5");
	});

	test("非日期的尾部数字不会被当作日期剥离（避免按错误价格静默计费）", () => {
		// `-\d{6}$` used to match any 6 trailing digits, so a version-style suffix
		// was stripped. If the reduced form happened to hit another row the request
		// would be priced at the WRONG rate — worse than reporting it unpriced.
		expect(resolveModelPricing("gpt-5.5-202699")).toBeNull();
		expect(resolveModelPricing("gpt-5.5-999999")).toBeNull();
		// Month 13 / month 00 are not dates.
		expect(resolveModelPricing("gpt-5.5-261301")).toBeNull();
		expect(resolveModelPricing("gpt-5.5-20261301")).toBeNull();
		expect(resolveModelPricing("gpt-5.5-260001")).toBeNull();
		expect(resolveModelPricing("gpt-5.5-2026-13-01")).toBeNull();
		// An 8-digit form must start with a plausible century.
		expect(resolveModelPricing("gpt-5.5-19990101")).toBeNull();

		// Real dates still strip, in all three supported spellings.
		expect(resolveModelPricing("gpt-5.5-260601")?.modelKey).toBe("gpt-5.5");
		expect(resolveModelPricing("gpt-5.5-20260601")?.modelKey).toBe("gpt-5.5");
		expect(resolveModelPricing("gpt-5.5-2026-06-01")?.modelKey).toBe("gpt-5.5");
	});

	test("后缀剥离最多 4 轮，病态名称不会无限循环也不会误命中", () => {
		// volatileCandidates is bounded at 4 rounds. Five strippable suffixes means
		// the base name is never reached, so the lookup reports unpriced instead of
		// spinning or guessing.
		expect(resolveModelPricing("gpt-5.5-preview-latest-260601-260602-260603")).toBeNull();

		// Exactly 4 rounds still resolves.
		expect(resolveModelPricing("gpt-5.5-preview-latest-260601-260602")?.modelKey).toBe("gpt-5.5");

		// A name made only of strippable suffixes must not reduce to something that
		// accidentally matches; stripping stops before producing an empty key.
		expect(resolveModelPricing("-latest")).toBeNull();
		expect(resolveModelPricing("-preview-latest")).toBeNull();
	});

	test("normalizeModelPricingKey 处理前缀、空白与大小写", () => {
		expect(normalizeModelPricingKey("codex:GPT-5.5")).toBe("gpt-5.5");
		expect(normalizeModelPricingKey("  anthropic:claude-opus-4.6 ")).toBe("claude-opus-4.6");
		expect(normalizeModelPricingKey("gpt-5.5")).toBe("gpt-5.5");
		expect(normalizeModelPricingKey(undefined)).toBe("");
	});
});

describe("pricing overrides", () => {
	test("部分覆盖只改指定字段", () => {
		setModelPricingOverrides({ "gpt-5.5": { input: 9.75 } });
		const resolved = resolveModelPricing("gpt-5.5");
		expect(resolved?.input).toBe(9.75);
		expect(resolved?.output).toBe(30.0);
		expect(resolved?.overridden).toBe(true);
	});

	test("覆盖键会归一化（可带 provider 前缀/大写）", () => {
		setModelPricingOverrides({ "codex:GPT-5.5": { output: 41.25 } });
		expect(resolveModelPricing("gpt-5.5")?.output).toBe(41.25);
	});

	test("可为内置表里没有的模型定价", () => {
		expect(resolveModelPricing("gpt-6-unreleased")).toBeNull();
		setModelPricingOverrides({ "gpt-6-unreleased": { input: 7, output: 42 } });
		const resolved = resolveModelPricing("gpt-6-unreleased");
		expect(resolved).toMatchObject({
			input: 7,
			output: 42,
			cacheRead: 0,
			cacheWrite: 0,
			matchedVia: "override",
			overridden: true,
		});
	});

	test("非法覆盖值被忽略，回落到内置价格", () => {
		setModelPricingOverrides({
			"gpt-5.5": {
				// biome-ignore lint/suspicious/noExplicitAny: exercising malformed operator input
				input: "free" as any,
				output: Number.NaN,
				cacheRead: -1,
			},
		});
		const resolved = resolveModelPricing("gpt-5.5");
		expect(resolved?.input).toBe(5.0);
		expect(resolved?.output).toBe(30.0);
		expect(resolved?.cacheRead).toBe(0.5);
		expect(resolved?.overridden).toBe(false);
	});

	test("覆盖可被清空", () => {
		setModelPricingOverrides({ "gpt-5.5": { input: 1 } });
		expect(resolveModelPricing("gpt-5.5")?.input).toBe(1);
		setModelPricingOverrides(undefined);
		expect(resolveModelPricing("gpt-5.5")?.input).toBe(5.0);
	});
});

describe("calculateCost", () => {
	test("Codex 模型现在能算出成本（回归：此前 gpt-5.x 全部返回 null）", () => {
		const cost = calculateCost(
			usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
			"codex",
			"codex:gpt-5.5",
		);
		expect(cost).not.toBeNull();
		expect(cost?.inputCost).toBeCloseTo(5.0, 6);
		expect(cost?.outputCost).toBeCloseTo(30.0, 6);
		expect(cost?.totalCost).toBeCloseTo(35.0, 6);
	});

	test("OpenAI 系：cached token 从 input 中扣除，不双重计费", () => {
		// Upstream reports input_tokens as the whole prompt, cache included.
		const cost = calculateCost(
			usage({ inputTokens: 1_000_000, cachedInputTokens: 900_000, outputTokens: 0 }),
			"codex",
			"gpt-5.5",
		);
		// 100k uncached @ $5/M + 900k cached @ $0.5/M
		expect(cost?.inputCost).toBeCloseTo(0.5, 6);
		expect(cost?.cacheReadCost).toBeCloseTo(0.45, 6);
		expect(cost?.totalCost).toBeCloseTo(0.95, 6);
	});

	test("Anthropic 系：input 已不含 cached token，不做扣减", () => {
		const cost = calculateCost(
			usage({
				inputTokens: 100_000,
				cachedInputTokens: 900_000,
				cacheCreationInputTokens: 200_000,
				outputTokens: 0,
			}),
			"anthropic",
			"claude-sonnet-4-6",
		);
		// 100k input @ $3/M + 900k cache read @ $0.3/M + 200k cache write @ $3.75/M
		expect(cost?.inputCost).toBeCloseTo(0.3, 6);
		expect(cost?.cacheReadCost).toBeCloseTo(0.27, 6);
		expect(cost?.cacheCreationCost).toBeCloseTo(0.75, 6);
		expect(cost?.totalCost).toBeCloseTo(1.32, 6);
	});

	test("cached 超过 input 时不产生负成本", () => {
		const cost = calculateCost(
			usage({ inputTokens: 100, cachedInputTokens: 500, outputTokens: 0 }),
			"openai",
			"gpt-5.5",
		);
		expect(cost?.inputCost).toBe(0);
		expect(cost?.totalCost).toBeGreaterThanOrEqual(0);
	});

	test("未知模型返回 null，调用方可区分未定价与零成本", () => {
		expect(calculateCost(usage({ inputTokens: 1000 }), "openai", "mystery-model-9")).toBeNull();
	});

	test("cacheWrite 为 0 的行不给 cache creation 记账", () => {
		const cost = calculateCost(
			usage({ inputTokens: 0, cacheCreationInputTokens: 1_000_000 }),
			"codex",
			"gpt-5.5",
		);
		expect(cost?.cacheCreationCost).toBe(0);
	});

	test("覆盖后的价格立即体现在成本里", () => {
		setModelPricingOverrides({ "gpt-5.5": { input: 10, output: 60 } });
		const cost = calculateCost(
			usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
			"codex",
			"gpt-5.5",
		);
		expect(cost?.totalCost).toBeCloseTo(70.0, 6);
	});
});
