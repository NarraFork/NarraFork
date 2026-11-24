import { describe, expect, test } from "bun:test";
import type { SourceRegion } from "@shared/sourcing/identify";
import type { ProviderBilling, ProviderPreset } from "@shared/sourcing/presets";
import { sourcingRoutes } from "../../../server/routes/sourcing";
import en from "../../locales/en/settings.json";
import zh from "../../locales/zh-CN/settings.json";
import {
	connectionClusters,
	getProviderPresetName,
	initialConnectionSelection,
	popularProviderPresets,
	resolveProviderConnection,
	searchProviderPresets,
} from "./provider-catalog";

// What the add page receives from GET /api/sourcing/templates.
const PROVIDER_PRESETS = (
	(await (await sourcingRoutes.request("/templates")).json()) as { presets: ProviderPreset[] }
).presets;

function preset(id: string): ProviderPreset {
	const found = PROVIDER_PRESETS.find((entry) => entry.id === id);
	if (!found) throw new Error(`Missing preset: ${id}`);
	return found;
}

const A = "anthropic-messages";
const C = "completions-compatible";
const R = "openai-responses";

// Explicit independent fixtures cover all four families × two regions × two billing modes.
const cases: [string, SourceRegion, ProviderBilling, string, string, string?][] = [
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
		expect(popularProviderPresets(PROVIDER_PRESETS).map((entry) => entry.id)).toEqual([
			"tokendance",
			"deepseek",
			"zhipu",
			"moonshot",
			"minimax",
			"mimo",
			"openai",
			"anthropic",
		]);
	});

	test("language defaults and international aliases", () => {
		for (const id of ["moonshot", "minimax", "mimo", "zhipu"]) {
			for (const language of ["zh", "zh-CN", "zh-TW", "ZH-cn"]) {
				expect(initialConnectionSelection(preset(id), language)).toEqual({
					region: "china",
					billing: "payg",
				});
			}
			for (const language of ["en", "en-US", "ja", ""]) {
				expect(initialConnectionSelection(preset(id), language)).toEqual({
					region: "international",
					billing: "payg",
				});
			}
		}
		for (const id of ["moonshot-global", "minimax-global", "zai"]) {
			expect(initialConnectionSelection(preset(id), "zh-CN")).toEqual({
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
			// Kimi is created on Chat Completions even though it also serves Responses:
			// only that route gives it dynamic tool loading.
			const kimi = id === "moonshot";
			expect(result?.preset.defaultProtocol).toBe(kimi ? C : responses ? R : A);
			expect(result?.preset.creationProtocol).toBe(kimi ? C : undefined);
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

	test("aliases resolve the same variants while retaining their own identity", () => {
		for (const [alias, canonical] of [
			["moonshot-global", "moonshot"],
			["minimax-global", "minimax"],
			["zai", "zhipu"],
		] as const) {
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
	});

	test("only international MiMo Token Plan requires an explicit subscription cluster", () => {
		for (const [id, region, billing] of cases) {
			const result = resolveProviderConnection(preset(id), { region, billing });
			const clusterRequired =
				id === "mimo" && region === "international" && billing === "token-plan";
			expect(result === null).toBe(clusterRequired);
			expect(connectionClusters(preset(id), { region, billing })).toEqual(
				clusterRequired ? ["sgp", "ams"] : [],
			);
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

describe("localized preset names", () => {
	for (const [locale, names] of [
		["en", en.providerNames],
		["zh-CN", zh.providerNames],
	] as const) {
		test(`${locale} translates every built-in provider name`, () => {
			expect(Object.keys(names).sort()).toEqual(PROVIDER_PRESETS.map((entry) => entry.id).sort());
			const translate = (key: string) =>
				names[key.slice("providerNames.".length) as keyof typeof names];
			for (const entry of PROVIDER_PRESETS) {
				expect(entry.nameKey).toBe(`providerNames.${entry.id}`);
				expect(getProviderPresetName(entry, translate)).toBe(names[entry.id as keyof typeof names]);
				expect(getProviderPresetName(entry, translate).trim()).not.toBe("");
			}
		});
	}

	test("custom names without a translation key bypass translation", () => {
		const custom: ProviderPreset = {
			id: "custom",
			name: "My custom gateway",
			endpoints: {},
			defaultProtocol: "completions-compatible",
		};
		expect(
			getProviderPresetName(custom, () => {
				throw new Error("Custom names must not be translated");
			}),
		).toBe("My custom gateway");
	});
});

describe("preset search", () => {
	test("localized names participate in search while raw names remain searchable", () => {
		const names = zh.providerNames;
		const translate = (key: string) =>
			names[key.slice("providerNames.".length) as keyof typeof names];
		expect(searchProviderPresets(PROVIDER_PRESETS, "天翼云息壤")).toEqual([]);
		expect(
			searchProviderPresets(PROVIDER_PRESETS, "天翼云息壤", translate).map((entry) => entry.id),
		).toEqual(["xirang"]);
		expect(
			searchProviderPresets(PROVIDER_PRESETS, "腾讯TokenHub", translate).map((entry) => entry.id),
		).toEqual(["tokenhub"]);
		expect(
			searchProviderPresets(PROVIDER_PRESETS, "Xirang", translate).map((entry) => entry.id),
		).toEqual(["xirang"]);
		expect(searchProviderPresets(PROVIDER_PRESETS, "", translate)).toEqual(PROVIDER_PRESETS);
		const uniqueName = (key: string) => (key === "providerNames.openai" ? "LOCALIZED BRAND" : key);
		expect(
			searchProviderPresets(PROVIDER_PRESETS, "localized brand", uniqueName).map(
				(entry) => entry.id,
			),
		).toEqual(["openai"]);
	});
	test("empty or whitespace returns the full list without sharing the array", () => {
		for (const query of ["", " \t\n "]) {
			expect(searchProviderPresets(PROVIDER_PRESETS, query)).toEqual(PROVIDER_PRESETS);
			expect(searchProviderPresets(PROVIDER_PRESETS, query)).not.toBe(PROVIDER_PRESETS);
		}
	});

	test("searches id, name, URL and protocol case-insensitively", () => {
		expect(
			searchProviderPresets(PROVIDER_PRESETS, "  OPENAI  ").map((entry) => entry.id),
		).toContain("openai");
		expect(
			searchProviderPresets(PROVIDER_PRESETS, "hugging face").map((entry) => entry.id),
		).toEqual(["huggingface"]);
		expect(
			searchProviderPresets(PROVIDER_PRESETS, "api.minimax.io").map((entry) => entry.id),
		).toEqual(["minimax-global"]);
		expect(
			searchProviderPresets(PROVIDER_PRESETS, "radeon-cloud").map((entry) => entry.id),
		).toEqual(["radeon-cloud"]);
		expect(
			searchProviderPresets(PROVIDER_PRESETS, "gemini-compatible").map((entry) => entry.id),
		).toEqual(["gemini"]);
	});

	test("Chinese and English local aliases match without changing original display names", () => {
		const examples: Array<[string, string]> = [
			["硅基流动", "silicon"],
			["SiliconFlow", "silicon"],
			["智谱", "zhipu"],
			["深度求索", "deepseek"],
			["通义", "dashscope"],
			["百炼", "dashscope"],
			["豆包", "doubao"],
			["月之暗面", "moonshot"],
			["阶跃", "stepfun"],
			["英伟达", "nvidia"],
			["魔搭", "modelscope"],
			["千帆", "baidu-cloud"],
		];
		for (const [query, id] of examples) {
			expect(searchProviderPresets(PROVIDER_PRESETS, query).map((entry) => entry.id)).toContain(id);
		}
		expect(
			searchProviderPresets(PROVIDER_PRESETS, "月之暗面 .ai").map((entry) => entry.id),
		).toEqual(["moonshot-global"]);
		expect(searchProviderPresets(PROVIDER_PRESETS, "硅基流动")[0]?.name).toBe("Silicon");
	});

	test("all terms must match and search does not reorder or mutate the catalog", () => {
		const ids = PROVIDER_PRESETS.map((entry) => entry.id);
		expect(
			searchProviderPresets(PROVIDER_PRESETS, "moonshot .cn").map((entry) => entry.id),
		).toEqual(["moonshot"]);
		expect(searchProviderPresets(PROVIDER_PRESETS, "no-such-provider")).toEqual([]);
		expect(PROVIDER_PRESETS.map((entry) => entry.id)).toEqual(ids);
	});
});
