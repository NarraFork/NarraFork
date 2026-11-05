import { describe, expect, test } from "bun:test";
import {
	buildAggModelValue,
	FOLLOW_DEFAULT_MODEL,
	FOLLOW_PARENT_MODEL,
	FOLLOW_SUMMARY_MODEL,
	type ModelAggregation,
	type ModelOption,
} from "../../../lib/constants";
import {
	applyModelMenuMaxHeight,
	autoChoiceReason,
	canAssignGlobalModelRole,
	centerModelMenuSelection,
	familyLabel,
	formatReferencePrice,
	groupModelOptions,
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

describe("grouping by vendor and by service", () => {
	const source = (value: string) => ({
		value,
		provider: value.slice(0, value.indexOf(":")),
		available: true,
		subscription: false,
	});
	const options: ModelOption[] = [
		{ value: "__default__", label: "Follow default", provider: "__default__" },
		{
			value: "auto:gpt-5.5",
			label: "GPT-5.5",
			provider: "__auto__",
			family: "gpt",
			autoSources: [source("codex:gpt-5.5"), source("relay:gpt-5.5")],
		},
		{
			value: "auto:new-model",
			label: "New",
			provider: "__auto__",
			autoSources: [source("relay:new-model")],
		},
		{ value: "codex:gpt-5.5", label: "GPT-5.5", provider: "codex" },
		{ value: "relay:gpt-5.5", label: "GPT-5.5", provider: "relay" },
		{ value: "relay:new-model", label: "New", provider: "relay" },
		{ value: "relay:private-x", label: "Private", provider: "relay" },
	];

	test("a model shows once under its vendor; services keep only what auto does not list", () => {
		const groups = groupModelOptions(options, "__default__");
		expect([...groups.keys()]).toEqual(["__default__", "__auto__:gpt", "__auto__:", "relay"]);
		expect(groups.get("relay")?.map((m) => m.value)).toEqual(["relay:private-x"]);
		expect(groups.has("codex")).toBe(false);
	});

	test("the selected pin keeps its service row", () => {
		const groups = groupModelOptions(options, "codex:gpt-5.5");
		expect(groups.get("codex")?.map((m) => m.value)).toEqual(["codex:gpt-5.5"]);
	});

	test("vendor groups take the auto slot, by label, with other models last", () => {
		const entries: Array<readonly [string, number]> = [
			["relay", 1],
			["__auto__:", 2],
			["__auto__:gpt", 3],
			["__auto__:claude", 4],
			["__default__", 5],
		];
		const labels: Record<string, string> = {
			relay: "Relay",
			"__auto__:": "Other",
			"__auto__:gpt": "GPT",
			"__auto__:claude": "Claude",
		};
		expect(
			orderModelGroupEntries(entries, (key) => labels[key] ?? key).map(([key]) => key),
		).toEqual(["__default__", "__auto__:claude", "__auto__:gpt", "__auto__:", "relay"]);
		expect(familyLabel("gpt")).toBe("GPT");
		expect(familyLabel("qwen")).toBe("Qwen");
	});
});

describe("auto source rows", () => {
	test("reference prices are shown only when the catalog knows them", () => {
		expect(formatReferencePrice(undefined)).toBeNull();
		expect(formatReferencePrice(Number.NaN)).toBeNull();
		expect(formatReferencePrice(0.42)).toBe("$0.42");
		expect(formatReferencePrice(3.5)).toBe("$3.5");
		expect(formatReferencePrice(30)).toBe("$30");
	});

	test("the reason follows routing order: unavailable, subscription, then price", () => {
		const t = (key: string, options?: Record<string, unknown>) =>
			`${key}:${String(options?.provider)}`;
		const labels = { codex: "Codex" };
		const source = (
			provider: string,
			available: boolean,
			subscription: boolean,
			referencePrice?: number,
		) => ({ provider, available, subscription, referencePrice });
		expect(autoChoiceReason([], labels, t)).toBeNull();
		expect(
			autoChoiceReason([source("codex", true, true), source("relay", true, false, 3)], labels, t),
		).toBe("autoReasonSubscription:Codex");
		// Cheapest only when compared on price with another priced source.
		expect(
			autoChoiceReason(
				[source("relay", true, false, 3), source("other", true, false, 9)],
				labels,
				t,
			),
		).toBe("autoReasonCheapest:relay");
		expect(autoChoiceReason([source("relay", true, false, 3)], labels, t)).toBe(
			"autoReasonFirst:relay",
		);
		expect(autoChoiceReason([source("relay", true, false)], labels, t)).toBe(
			"autoReasonFirst:relay",
		);
		// The first available one is chosen, even if listed after an unavailable one.
		expect(
			autoChoiceReason([source("codex", false, true), source("relay", true, false)], labels, t),
		).toBe("autoReasonFirst:relay");
		expect(autoChoiceReason([source("codex", false, true)], labels, t)).toBe(
			"autoReasonNoneAvailable:Codex",
		);
	});
});
