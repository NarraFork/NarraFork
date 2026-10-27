import { describe, expect, test } from "bun:test";
import {
	buildAggModelValue,
	FOLLOW_DEFAULT_MODEL,
	FOLLOW_PARENT_MODEL,
	FOLLOW_SUMMARY_MODEL,
	type ModelAggregation,
} from "../../../lib/constants";
import {
	applyModelMenuMaxHeight,
	canAssignGlobalModelRole,
	centerModelMenuSelection,
	MODEL_MENU_POSITIONING,
	modelMenuSelection,
	modelProviderPrefix,
	orderModelGroupEntries,
	shouldAutoFocusModelFilter,
} from "./model-menu-selection";

const aggregations: ModelAggregation[] = [
	{ id: "group", name: "Group", models: ["a:model", "b:model:variant"], routingMode: "priority" },
];

describe("model menu selection", () => {
	test.each([
		null,
		undefined,
		"",
		FOLLOW_DEFAULT_MODEL,
	])("normalizes default selection %s", (value) => {
		expect(modelMenuSelection(value, aggregations).targetValue).toBe(FOLLOW_DEFAULT_MODEL);
	});
	test("keeps ordinary and summary model values", () => {
		for (const value of ["a:model", "__summary__", FOLLOW_PARENT_MODEL, "removed:model"]) {
			expect(modelMenuSelection(value, aggregations).targetValue).toBe(value);
		}
	});
	test("resolves automatic aggregation and exposes members", () => {
		const selection = modelMenuSelection(buildAggModelValue("group"), aggregations);
		expect(selection.targetValue).toBe("__agg__:group");
		expect(selection.members).toEqual(aggregations[0].models);
	});
	test("preserves pinned member including embedded colons", () => {
		const value = buildAggModelValue("group", "b:model:variant");
		expect(modelMenuSelection(value, aggregations).targetValue).toBe(value);
	});
	test("falls back to aggregation for missing members or configuration", () => {
		expect(modelMenuSelection("__agg__:group:missing:model", aggregations).targetValue).toBe(
			"__agg__:group",
		);
		expect(modelMenuSelection("__agg__:group:a:model", []).targetValue).toBe("__agg__:group");
	});
});

describe("model menu group ordering", () => {
	const labelOf = (provider: string) =>
		({ a: "Provider A", codex: "Codex", zeta: "Zeta Gateway", xiaomi: "Xiaomi" })[provider] ??
		provider;

	test("keeps default and summary pinned above the sorted providers", () => {
		const entries = [
			["zeta", 1],
			["__summary__", 2],
			["codex", 3],
			["__default__", 4],
			["a", 5],
		] as const;
		expect(orderModelGroupEntries(entries, labelOf).map(([provider]) => provider)).toEqual([
			"__default__",
			"__summary__",
			"codex",
			"a",
			"zeta",
		]);
	});

	test("pins aggregations after summary even when its label would sort last", () => {
		const labelOfAggLast = (provider: string) =>
			provider === "__agg__" ? "Zzz Aggregations" : labelOf(provider);
		const entries = [
			["zeta", 1],
			["__agg__", 2],
			["__summary__", 3],
			["a", 4],
			["__default__", 5],
		] as const;
		// "Zzz Aggregations" sorts after every provider label below. Pinning is
		// what keeps the group next to Summary.
		expect(orderModelGroupEntries(entries, labelOfAggLast).map(([provider]) => provider)).toEqual([
			"__default__",
			"__summary__",
			"__agg__",
			"a",
			"zeta",
		]);
	});

	test("sorts remaining groups by display label, not by raw provider prefix", () => {
		const entries = [
			["zeta", 1],
			["codex", 2],
			["a", 3],
		] as const;
		// Labels: Codex < Provider A < Zeta Gateway — prefix order would differ.
		expect(orderModelGroupEntries(entries, labelOf).map(([provider]) => provider)).toEqual([
			"codex",
			"a",
			"zeta",
		]);
	});

	test("sorts a list without role groups and leaves the input untouched", () => {
		const entries = [
			["zeta", 1],
			["a", 2],
		] as const;
		const ordered = orderModelGroupEntries(entries, labelOf);
		expect(ordered.map(([provider]) => provider)).toEqual(["a", "zeta"]);
		expect(entries.map(([provider]) => provider)).toEqual(["zeta", "a"]);
	});

	test("falls back to the provider prefix when no label is known", () => {
		const entries = [
			["unknown-b", 1],
			["unknown-a", 2],
		] as const;
		expect(orderModelGroupEntries(entries, labelOf).map(([provider]) => provider)).toEqual([
			"unknown-a",
			"unknown-b",
		]);
	});
});

describe("model provider prefix for role rows", () => {
	test("extracts the provider prefix from a concrete model value", () => {
		expect(modelProviderPrefix("codex:gpt-6-astra")).toBe("codex");
		expect(modelProviderPrefix("xiaomi:codex:gpt-6-astra")).toBe("xiaomi");
		expect(modelProviderPrefix("a:model:variant")).toBe("a");
	});
	test("returns null for empty values and meta sentinels", () => {
		expect(modelProviderPrefix(null)).toBeNull();
		expect(modelProviderPrefix(undefined)).toBeNull();
		expect(modelProviderPrefix("")).toBeNull();
		expect(modelProviderPrefix("no-colon")).toBeNull();
		expect(modelProviderPrefix(FOLLOW_DEFAULT_MODEL)).toBeNull();
		expect(modelProviderPrefix(FOLLOW_SUMMARY_MODEL)).toBeNull();
		expect(modelProviderPrefix(FOLLOW_PARENT_MODEL)).toBeNull();
		expect(modelProviderPrefix(buildAggModelValue("group"))).toBeNull();
		expect(modelProviderPrefix(buildAggModelValue("group", "a:model"))).toBeNull();
	});
});

describe("global model role assignment", () => {
	test("rejects empty values and meta sentinels", () => {
		expect(canAssignGlobalModelRole(null)).toBe(false);
		expect(canAssignGlobalModelRole(undefined)).toBe(false);
		expect(canAssignGlobalModelRole("")).toBe(false);
		expect(canAssignGlobalModelRole(FOLLOW_DEFAULT_MODEL)).toBe(false);
		expect(canAssignGlobalModelRole(FOLLOW_SUMMARY_MODEL)).toBe(false);
		expect(canAssignGlobalModelRole(FOLLOW_PARENT_MODEL)).toBe(false);
	});
	test("allows concrete models and aggregation roots", () => {
		expect(canAssignGlobalModelRole("xiaomi:mimo-x-pro-preview")).toBe(true);
		expect(canAssignGlobalModelRole(buildAggModelValue("group"))).toBe(true);
	});
});

describe("dropdown-only centering", () => {
	function center(rowTop: number, scrollTop = 0, scrollHeight = 2000) {
		const container = {
			scrollTop,
			scrollHeight,
			clientHeight: 400,
			clientTop: 1,
			getBoundingClientRect: () => ({ top: 100 }),
		} as HTMLElement;
		const item = { getBoundingClientRect: () => ({ top: rowTop, height: 32 }) } as HTMLElement;
		centerModelMenuSelection(container, item, 48);
		return container.scrollTop;
	}
	test("centers in viewport above sticky search footer", () => {
		expect(center(1000)).toBe(739);
		expect(center(700, 300)).toBe(739);
	});
	test("clamps to both scroll boundaries and handles short lists", () => {
		expect(center(101)).toBe(0);
		expect(center(3000)).toBe(1600);
		expect(center(200, 0, 200)).toBe(0);
	});
});

test("both statusbar variants wire aggregation controls inside the model dropdown", async () => {
	// The model dropdown lives in the interaction status bar (both desktop and
	// mobile variants), not NarratorPanel.
	const statusBar = await Bun.file(
		new URL("../interaction/NarratorInteractionStatusBar.tsx", import.meta.url),
	).text();
	expect(statusBar).not.toContain("AggProviderSwitcher");
	expect(statusBar.match(/data-model-menu-scroll/g)).toHaveLength(2);
	expect(
		statusBar.match(
			/<ModelMenuItems\s+opened=\{menuOpen(?:Desktop|Mobile)\}\s+aggregations=\{model\.aggregations\}/g,
		),
	).toHaveLength(2);
});

describe("model menu viewport fitting", () => {
	test("clamps the dropdown to the visible height left above the keyboard", () => {
		const floating = { style: {} as { maxHeight?: string } } as HTMLElement;
		applyModelMenuMaxHeight(floating, 173.6);
		expect(floating.style.maxHeight).toBe("min(60vh, 173px)");
		applyModelMenuMaxHeight(floating, 10);
		expect(floating.style.maxHeight).toBe("min(60vh, 96px)");
	});

	test("lets the dropdown flip while open and sizes it through floating-ui", () => {
		expect(MODEL_MENU_POSITIONING.preventPositionChangeWhenVisible).toBe(false);
		const floating = { style: {} as { maxHeight?: string } } as HTMLElement;
		MODEL_MENU_POSITIONING.middlewares.size.apply({
			elements: { floating },
			availableHeight: 240,
		} as unknown as Parameters<typeof MODEL_MENU_POSITIONING.middlewares.size.apply>[0]);
		expect(floating.style.maxHeight).toBe("min(60vh, 240px)");
	});

	test("does not auto-focus the search field on touch devices", () => {
		const win = (matches: boolean) => ({ matchMedia: () => ({ matches }) }) as unknown as Window;
		expect(shouldAutoFocusModelFilter(win(true))).toBe(false);
		expect(shouldAutoFocusModelFilter(win(false))).toBe(true);
	});
});

test("every model dropdown uses the viewport-aware positioning", async () => {
	for (const file of [
		"../interaction/NarratorInteractionStatusBar.tsx",
		"../compact/compact-summary-modal.tsx",
	]) {
		const source = await Bun.file(new URL(file, import.meta.url)).text();
		expect(source.match(/data-model-menu-scroll/g)?.length).toBe(
			source.match(/\{\.\.\.MODEL_MENU_POSITIONING\}/g)?.length,
		);
	}
});
