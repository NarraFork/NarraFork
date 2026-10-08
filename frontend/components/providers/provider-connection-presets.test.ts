import { describe, expect, test } from "bun:test";
import en from "../../locales/en/settings.json";
import zh from "../../locales/zh-CN/settings.json";
import {
	getConnectionFamily,
	getInitialConnectionSelection,
	getPopularProviderPresets,
	POPULAR_PROVIDER_IDS,
	type ProviderBilling,
	type ProviderRegion,
	resolveProviderConnection,
} from "./provider-connection-presets";
import { PROVIDER_PRESETS, type ProviderPreset } from "./provider-presets";

function preset(id: string): ProviderPreset {
	const found = PROVIDER_PRESETS.find((entry) => entry.id === id);
	if (!found) throw new Error(`Missing preset: ${id}`);
	return found;
}

const A = "anthropic-messages";
const C = "completions-compatible";
const R = "openai-responses";

// Explicit independent fixtures cover all four families × two regions × two billing modes.
const cases: [string, ProviderRegion, ProviderBilling, string, string, string?][] = [
	[
		"moonshot",
		"china",
		"payg",
		"https://api.moonshot.cn/anthropic/v1",
		"https://api.moonshot.cn/v1",
		"https://api.moonshot.cn/v1",
	],
	[
		"moonshot",
		"international",
		"payg",
		"https://api.moonshot.ai/anthropic/v1",
		"https://api.moonshot.ai/v1",
		"https://api.moonshot.ai/v1",
	],
	[
		"moonshot",
		"china",
		"token-plan",
		"https://api.kimi.com/coding/v1",
		"https://api.kimi.com/coding/v1",
		"https://api.kimi.com/coding/v1",
	],
	[
		"moonshot",
		"international",
		"token-plan",
		"https://api.kimi.ai/coding/v1",
		"https://api.kimi.ai/coding/v1",
		"https://api.kimi.ai/coding/v1",
	],
	["minimax", "china", "payg", "https://api.minimax.cn/anthropic/v1", "https://api.minimax.cn/v1"],
	[
		"minimax",
		"international",
		"payg",
		"https://api.minimax.io/anthropic/v1",
		"https://api.minimax.io/v1",
	],
	[
		"minimax",
		"china",
		"token-plan",
		"https://api.minimax.cn/anthropic/v1",
		"https://api.minimax.cn/v1",
	],
	[
		"minimax",
		"international",
		"token-plan",
		"https://api.minimax.io/anthropic/v1",
		"https://api.minimax.io/v1",
	],
	[
		"mimo",
		"china",
		"payg",
		"https://api.xiaomimimo.com/anthropic/v1",
		"https://api.xiaomimimo.com/v1",
		"https://api.xiaomimimo.com/v1",
	],
	[
		"mimo",
		"international",
		"payg",
		"https://api.xiaomimimo.com/anthropic/v1",
		"https://api.xiaomimimo.com/v1",
		"https://api.xiaomimimo.com/v1",
	],
	[
		"mimo",
		"china",
		"token-plan",
		"https://token-plan-cn.xiaomimimo.com/anthropic/v1",
		"https://token-plan-cn.xiaomimimo.com/v1",
		"https://token-plan-cn.xiaomimimo.com/v1",
	],
	[
		"mimo",
		"international",
		"token-plan",
		"https://token-plan-sgp.xiaomimimo.com/anthropic/v1",
		"https://token-plan-sgp.xiaomimimo.com/v1",
	],
	[
		"zhipu",
		"china",
		"payg",
		"https://open.bigmodel.cn/api/anthropic/v1",
		"https://open.bigmodel.cn/api/paas/v4",
		"https://open.bigmodel.cn/api/v1",
	],
	[
		"zhipu",
		"international",
		"payg",
		"https://api.z.ai/api/anthropic/v1",
		"https://api.z.ai/api/paas/v4",
	],
	[
		"zhipu",
		"china",
		"token-plan",
		"https://open.bigmodel.cn/api/anthropic/v1",
		"https://open.bigmodel.cn/api/coding/paas/v4",
		"https://open.bigmodel.cn/api/v1",
	],
	[
		"zhipu",
		"international",
		"token-plan",
		"https://api.z.ai/api/anthropic/v1",
		"https://api.z.ai/api/coding/paas/v4",
		"https://api.z.ai/api/v1",
	],
];

describe("provider connection metadata", () => {
	test("popular providers use the exact stable order without international duplicates", () => {
		expect(POPULAR_PROVIDER_IDS).toEqual([
			"deepseek",
			"zhipu",
			"moonshot",
			"minimax",
			"mimo",
			"openai",
			"anthropic",
		]);
		expect(getPopularProviderPresets().map((entry) => entry.id)).toEqual([...POPULAR_PROVIDER_IDS]);
	});

	test("language defaults and international aliases", () => {
		for (const id of ["moonshot", "minimax", "mimo", "zhipu"]) {
			for (const language of ["zh", "zh-CN", "zh-TW", "ZH-cn"]) {
				expect(getInitialConnectionSelection(id, language)).toEqual({
					region: "china",
					billing: "payg",
				});
			}
			for (const language of ["en", "en-US", "ja", ""]) {
				expect(getInitialConnectionSelection(id, language)).toEqual({
					region: "international",
					billing: "payg",
				});
			}
		}
		for (const id of ["moonshot-global", "minimax-global", "zai"]) {
			expect(getInitialConnectionSelection(id, "zh-CN")).toEqual({
				region: "international",
				billing: "payg",
			});
		}
	});

	for (const [id, region, billing, messages, completions, responses] of cases) {
		test(`${id} ${region} ${billing}: verified endpoints, priority and real User-Agent`, () => {
			const original = preset(id);
			const snapshot = structuredClone(original);
			const result = resolveProviderConnection(original, { region, billing, cluster: "sgp" });
			expect(result).not.toBeNull();
			expect(result?.preset.endpoints).toEqual({
				[A]: messages,
				[C]: completions,
				...(responses ? { [R]: responses } : {}),
			});
			expect(result?.preset.defaultProtocol).toBe(responses ? R : A);
			expect(result?.userAgentMode).toBe(billing === "token-plan" ? "narrafork" : undefined);
			expect(Object.keys(result ?? {}).sort()).toEqual(
				billing === "token-plan" ? ["preset", "userAgentMode"] : ["preset"],
			);
			expect(result?.preset.id).toBe(original.id);
			expect(result?.preset.name).toBe(original.name);
			expect(result?.preset.nameKey).toBe(original.nameKey);
			expect(original).toEqual(snapshot);
			expect(`${result?.preset.endpoints[A]}/messages`).toBe(`${messages}/messages`);
		});
	}

	test("aliases resolve the same family while retaining their own identity", () => {
		for (const [alias, canonical, family] of [
			["moonshot-global", "moonshot", "kimi"],
			["minimax-global", "minimax", "minimax"],
			["zai", "zhipu", "zhipu"],
		] as const) {
			expect(getConnectionFamily(alias ?? "")).toBe(family);
			for (const region of ["china", "international"] as const) {
				for (const billing of ["payg", "token-plan"] as const) {
					const selection = { region, billing };
					const result = resolveProviderConnection(preset(alias ?? ""), selection);
					expect(result?.preset.endpoints).toEqual(
						resolveProviderConnection(preset(canonical ?? ""), selection)?.preset.endpoints,
					);
					expect(result?.preset.id).toBe(alias);
				}
			}
		}
		expect(getConnectionFamily("mimo")).toBe("mimo");
		expect(getConnectionFamily("unknown")).toBeUndefined();
	});

	test("only international MiMo Token Plan requires an explicit subscription cluster", () => {
		for (const [id, region, billing] of cases) {
			const result = resolveProviderConnection(preset(id), { region, billing });
			if (id === "mimo" && region === "international" && billing === "token-plan") {
				expect(result).toBeNull();
			} else {
				expect(result).not.toBeNull();
			}
		}
		for (const cluster of ["sgp", "ams"] as const) {
			const result = resolveProviderConnection(preset("mimo"), {
				region: "international",
				billing: "token-plan",
				cluster,
			});
			expect(result?.preset.endpoints).toEqual({
				[A]: `https://token-plan-${cluster}.xiaomimimo.com/anthropic/v1`,
				[C]: `https://token-plan-${cluster}.xiaomimimo.com/v1`,
			});
			expect(result?.preset.defaultProtocol).toBe(A);
		}
	});

	test("unrelated presets keep their endpoints, protocol and client behavior", () => {
		for (const id of ["openai", "anthropic", "deepseek", "gemini"]) {
			const original = preset(id);
			expect(
				resolveProviderConnection(original, { region: "china", billing: "token-plan" }),
			).toEqual({ preset: original });
		}
	});

	test("all new UI labels exist in both languages and KIMI is localized", () => {
		for (const key of [
			"addProviderCategoryPopular",
			"addProviderCategoryAll",
			"addProviderRegion",
			"addProviderRegionChina",
			"addProviderRegionInternational",
			"addProviderBilling",
			"addProviderBillingPayg",
			"addProviderBillingTokenPlan",
			"addProviderCluster",
			"addProviderClusterPlaceholder",
			"addProviderClusterSgp",
			"addProviderClusterAms",
			"addProviderTokenPlanHint",
		] as const) {
			expect(en[key]).toBeTruthy();
			expect(zh[key]).toBeTruthy();
		}
		expect(en.providerNames.moonshot).toBe("KIMI");
		expect(zh.providerNames.moonshot).toBe("KIMI");
	});
});
