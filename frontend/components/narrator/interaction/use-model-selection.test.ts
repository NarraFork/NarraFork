import { describe, expect, test } from "bun:test";
import bundledCatalog from "@shared/model-catalog/dist/catalog.json";
import { type CatalogQuery, resolveModelCard } from "@shared/model-catalog/resolve";
import type { RawCatalog, RawMetadata } from "@shared/model-catalog/schema/catalog";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelOption } from "../../../lib/constants";
import {
	type UseModelSelectionOptions,
	type UseModelSelectionResult,
	useModelSelection,
} from "./use-model-selection";

const catalog = bundledCatalog as RawCatalog;
const resolveCard = (query: CatalogQuery, discovered?: RawMetadata) =>
	resolveModelCard({ catalog, query, discovered });

function select(
	model = "deepseek-v4-pro",
	overrides: Partial<UseModelSelectionOptions> = {},
): UseModelSelectionResult {
	let result: UseModelSelectionResult | undefined;
	function Harness() {
		result = useModelSelection({
			narratorId: "narrator",
			resolvedModel: `relay:${model}`,
			resolvedBareModel: model,
			resolvedModelOption: undefined,
			narratorReasoningEffort: "low",
			settingsData: {},
			modelCard: resolveCard({ upstreamModelId: model }),
			reasoningEffortMutation: { mutate: () => {} },
			updateSettingsMutation: { mutate: () => {} },
			...overrides,
		});
		return null;
	}
	renderToStaticMarkup(createElement(Harness));
	if (!result) throw new Error("Hook did not render");
	return result;
}

describe("model-card reasoning selection", () => {
	test.each([
		"deepseek-v4-flash",
		"deepseek-v4-pro",
		"deepseek-flash",
		"deepseek-v4.1-flash",
		"deepseek-v4.1-flash-1017",
	])("%s uses the card's low/high/max ladder, not the old vendor table", (model) => {
		const selection = select(model);
		expect(selection.reasoningEffortOptions).toEqual(["none", "low", "high", "max"]);
		expect(selection.displayedReasoningEffort).toBe("low");
	});

	test("Haiku 5.5 uses explicit card tiers including xhigh", () => {
		const selection = select("claude-haiku-5-5", {
			narratorReasoningEffort: "xhigh",
		});
		expect(selection.reasoningEffortOptions).toEqual([
			"none",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(selection.displayedReasoningEffort).toBe("xhigh");
	});

	test.each([
		["none", "none"],
		["low", "low"],
		["medium", "high"],
		["high", "high"],
		["xhigh", "high"],
		["max", "max"],
	])("normalizes the stored %s selection to %s", (effort, expected) => {
		expect(select(undefined, { narratorReasoningEffort: effort }).displayedReasoningEffort).toBe(
			expected,
		);
	});

	test("follow-default and follow-parent subagents use the same declared clamp", () => {
		expect(
			select(undefined, {
				narratorReasoningEffort: null,
				settingsData: { agent: { defaultReasoningEffort: "low" } },
			}).displayedReasoningEffort,
		).toBe("low");
		expect(
			select(undefined, {
				narratorReasoningEffort: null,
				inheritedReasoningEffort: "xhigh",
				settingsData: { agent: { defaultReasoningEffort: "max" } },
			}).displayedReasoningEffort,
		).toBe("high");
	});

	test("gateway declarations beat vendor identity and preset legacy migration", () => {
		const selection = select(undefined, {
			narratorReasoningEffort: "xhigh",
			resolvedModelOption: {
				channelType: "openai",
				effortLevels: ["low", "medium", "high", "max"],
			} as ModelOption,
		});
		expect(selection.reasoningEffortOptions).toEqual(["none", "low", "medium", "high", "max"]);
		expect(selection.displayedReasoningEffort).toBe("max");
		expect(
			select(undefined, {
				resolvedModelOption: { effortLevels: [], channelType: "openai" } as unknown as ModelOption,
			}).supportsReasoningEffort,
		).toBe(false);
	});

	test("discovered card tiers and canDisable take precedence without a vendor override", () => {
		const card = resolveCard(
			{ upstreamModelId: "deepseek-v4-pro" },
			{
				reasoning_effort_levels: ["low", "medium", "high", "xhigh"],
				can_disable_reasoning: false,
			},
		);
		const selection = select(undefined, { modelCard: card, narratorReasoningEffort: "xhigh" });
		expect(selection.reasoningEffortOptions).toEqual(["low", "medium", "high", "xhigh"]);
		expect(selection.displayedReasoningEffort).toBe("xhigh");
	});

	test("local tiers bypass the preset-only historical xhigh migration", () => {
		const query = { upstreamModelId: "deepseek-v4-pro" };
		const modelId = resolveCard(query).modelId;
		if (!modelId) throw new Error("Missing preset model");
		const modelOverrides = new Map([
			[modelId, { reasoningLevels: ["low" as const, "high" as const, "max" as const] }],
		]);
		const resolveLocal = (q: CatalogQuery) =>
			resolveModelCard({ catalog, query: q, modelOverrides });
		expect(
			select(undefined, {
				modelCard: resolveLocal(query),
				narratorReasoningEffort: "xhigh",
			}).displayedReasoningEffort,
		).toBe("max");
	});

	test("an unknown DeepSeek-like id keeps all generic tiers and its stored value", () => {
		const selection = select("deepseek-future-unknown", { narratorReasoningEffort: "xhigh" });
		expect(selection.reasoningEffortOptions).toEqual([
			"none",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(selection.displayedReasoningEffort).toBe("xhigh");
	});

	test("other models retain nearest-tier, higher-on-tie semantics", () => {
		const card = resolveCard(
			{ upstreamModelId: "claude-opus-4-6" },
			{ reasoning_effort_levels: ["low", "high", "max"] },
		);
		expect(
			select("claude-opus-4-6", {
				resolvedModel: "deepseek-relay:claude-opus-4-6",
				modelCard: card,
				narratorReasoningEffort: "xhigh",
			}).displayedReasoningEffort,
		).toBe("max");
	});
});
