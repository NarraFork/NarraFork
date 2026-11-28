import { describe, expect, test } from "bun:test";
import { type ComboboxParsedItem, defaultOptionsFilter, type OptionsFilter } from "@mantine/core";
import { groupModelsByProvider, type ModelOption } from "./constants";
import {
	createModelOptionsFilter,
	createModelQueryMatcher,
	createModelSearchIndex,
	createProviderPrefixOptionsFilter,
	defaultModelOptionsFilter,
	matchesModelQuery,
	modelSearchText,
	providerPrefixDisplay,
} from "./model-search";

const ALL = Number.POSITIVE_INFINITY;

// Shaped like useAllModels() output: the display name differs from the prefix
// (Example Cloud / edge), Gemini labels are display names, NUG labels are `channel · name`.
const providerLabels: Record<string, string> = {
	edge: "Example Cloud",
	gemini: "Gemini Pro",
	nug: "NUG Gateway Hub",
	codex: "Codex",
};
const models: ModelOption[] = [
	{ value: "__default__", label: "Follow default", provider: "__default__" },
	{ value: "__summary__", label: "Follow summary", provider: "__summary__" },
	{ value: "__agg__:fast", label: "Fast", provider: "__agg__" },
	{ value: "edge:claude-opus-5", label: "claude-opus-5", provider: "edge" },
	{ value: "gemini:gemini-3-pro", label: "Gemini 3 Pro", provider: "gemini" },
	{ value: "gemini:gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "gemini" },
	{
		value: "nug:moonshot:kimi-k3",
		label: "moonshot · Kimi K3",
		provider: "nug",
		channel: "moonshot",
		bareModel: "kimi-k3",
		rateMultiplier: 2,
	},
	{ value: "codex:gpt-6-astra", label: "gpt-6-astra", provider: "codex" },
];
const grouped: ComboboxParsedItem<string>[] = groupModelsByProvider(models, {
	...providerLabels,
	__default__: "Default",
	__summary__: "Summary",
	__agg__: "Aggregations",
});
const filter = createModelOptionsFilter({
	providerLabels,
	defaultModelValue: "edge:claude-opus-5",
	summaryModelValue: "gemini:gemini-3-pro",
});

type Parsed = { value: unknown } | { group: unknown; items: { value: unknown }[] };
function values(items: Parsed[]): string[] {
	return items.flatMap((item) =>
		("group" in item ? item.items : [item]).map((i) => String(i.value)),
	);
}
function search(
	query: string,
	limit = ALL,
	f: OptionsFilter<string> = filter,
	options: ComboboxParsedItem<string>[] = grouped,
): string[] {
	return values(f({ options, search: query, limit }));
}
function mantine(query: string, limit = ALL, options: ComboboxParsedItem<string>[] = grouped) {
	return values(defaultOptionsFilter({ options, search: query, limit }));
}

describe("model options filter", () => {
	test("finds a provider by display name and by prefix when they differ", () => {
		// The Default row resolves to edge, so it is found through its target too.
		expect(search("Example Cloud")).toEqual(["__default__", "edge:claude-opus-5"]);
		expect(search("edge")).toEqual(["__default__", "edge:claude-opus-5"]);
	});

	test("finds a model by id when its label is a display name", () => {
		expect(search("gemini-3-pro")).toEqual(["__summary__", "gemini:gemini-3-pro"]);
		expect(search("gemini-2.5-flash")).toEqual(["gemini:gemini-2.5-flash"]);
	});

	test("finds a NUG model by bare id, channel and gateway name", () => {
		expect(search("kimi-k3")).toEqual(["nug:moonshot:kimi-k3"]);
		expect(search("moonshot")).toEqual(["nug:moonshot:kimi-k3"]);
		expect(search("Gateway Hub")).toEqual(["nug:moonshot:kimi-k3"]);
	});

	test("Default/Summary rows match their own target's provider only", () => {
		expect(search("gemini pro")).toContain("__summary__");
		expect(search("gemini pro")).not.toContain("__default__");
		expect(search("Example Cloud")).not.toContain("__summary__");
	});

	test("matches group headers", () => {
		expect(search("aggregations")).toEqual(["__agg__:fast"]);
		expect(search("codex")).toEqual(["codex:gpt-6-astra"]);
	});

	test("multi-word queries require every term, across fields", () => {
		expect(search("Example Cloud opus")).toEqual(["__default__", "edge:claude-opus-5"]);
		expect(search("gemini flash")).toEqual(["gemini:gemini-2.5-flash"]);
		expect(search("nug kimi")).toEqual(["nug:moonshot:kimi-k3"]);
		expect(search("codex opus")).toEqual([]);
	});

	test("ignores case and surrounding whitespace; an empty query keeps everything", () => {
		expect(search("  EDGE  ")).toEqual(search("edge"));
		expect(search("GEMINI-3-PRO")).toEqual(search("gemini-3-pro"));
		expect(search("")).toEqual(models.map((m) => m.value));
		expect(search("   ")).toEqual(models.map((m) => m.value));
	});

	test("drops groups without matches instead of leaving a bare header", () => {
		expect(filter({ options: grouped, search: "flash", limit: ALL })).toEqual([
			{
				group: "Gemini Pro",
				items: [{ value: "gemini:gemini-2.5-flash", label: "Gemini 2.5 Flash" }],
			},
		]);
	});

	test("keeps Mantine's limit budget; a group without matches takes no slot", () => {
		const options: ComboboxParsedItem<string>[] = [
			{ group: "Other", items: [{ value: "other:x", label: "x" }] },
			{
				group: "Gemini Pro",
				items: ["a", "b", "c"].map((id) => ({ value: `gemini:${id}`, label: `gem ${id}` })),
			},
		];
		// A group header takes one top-level slot, exactly as in Mantine.
		expect(search("", 2, filter, options)).toEqual(mantine("", 2, options));
		expect(search("", 2, filter, options)).toEqual(["other:x", "gemini:a"]);
		// Mantine keeps the empty "Other" group and spends a slot on it.
		expect(mantine("gem", 3, options)).toEqual(["gemini:a", "gemini:b"]);
		expect(search("gem", 3, filter, options)).toEqual(["gemini:a", "gemini:b", "gemini:c"]);
	});

	test("unbounded filtering preserves every Mantine label-only match", () => {
		const queries = ["", "a", "gem", "Gemini 3", "pro", "opus", "moonshot · kimi", "×2", "Fast"];
		for (const query of queries) {
			const ours = search(query);
			for (const value of mantine(query)) expect(ours).toContain(value);
		}
		// What the fix is for: Mantine's label-only match finds none of these.
		for (const query of ["Example Cloud", "edge", "gemini-3-pro", "kimi-k3"]) {
			expect(mantine(query)).toEqual([]);
			expect(search(query).length).toBeGreaterThan(0);
		}
	});

	test("without settings context still matches header, value and prefix", () => {
		// No context: the Default row has no target to be found through.
		expect(search("edge", ALL, defaultModelOptionsFilter)).toEqual(["edge:claude-opus-5"]);
		expect(search("Example Cloud", ALL, defaultModelOptionsFilter)).toEqual(["edge:claude-opus-5"]);
	});

	test("searches flat (ungrouped) options such as bare pool model values", () => {
		const flat: ComboboxParsedItem<string>[] = [
			{ value: "edge:claude-opus-5", label: "edge:claude-opus-5" },
			{ value: "codex:gpt-6-astra", label: "codex:gpt-6-astra" },
			{ value: "summary", label: "summary" },
		];
		expect(search("Example Cloud", ALL, filter, flat)).toEqual(["edge:claude-opus-5"]);
		expect(search("Example Cloud", ALL, defaultModelOptionsFilter, flat)).toEqual([]);
		expect(search("summary", ALL, filter, flat)).toEqual(["summary"]);
	});

	test("extraText adds searchable text per value", () => {
		const variants = createModelOptionsFilter({
			extraText: (value) => (value === "v1" ? "openrouter" : undefined),
		});
		const options: ComboboxParsedItem<string>[] = [
			{ value: "v1", label: "Opus via router" },
			{ value: "v2", label: "Opus direct" },
		];
		expect(search("openrouter", ALL, variants, options)).toEqual(["v1"]);
		expect(search("opus", ALL, variants, options)).toEqual(["v1", "v2"]);
	});
});

describe("matching helpers", () => {
	test("matchesModelQuery requires every term; an empty query matches", () => {
		const text = modelSearchText({
			value: "edge:claude-opus-5",
			label: "claude-opus-5",
			group: "Example Cloud",
		});
		expect(matchesModelQuery(text, "Example Cloud opus")).toBe(true);
		expect(matchesModelQuery(text, "Example Cloud gpt")).toBe(false);
		expect(matchesModelQuery(text, "  ")).toBe(true);
	});

	test("ignores inherited object keys when resolving display names", () => {
		const text = modelSearchText(
			{ value: "constructor:model", label: "model" },
			{ providerLabels: {} },
		);
		expect(text).toBe("model constructor:model constructor");
	});
});

describe("bare provider prefix options (log filters)", () => {
	const options: ComboboxParsedItem<string>[] = ["codex", "gemini", "edge", "removed"].map(
		(prefix) => ({ value: prefix, label: prefix }),
	);
	const prefixFilter = createProviderPrefixOptionsFilter(providerLabels);

	test("matches the display name as well as the prefix", () => {
		expect(search("Example Cloud", ALL, prefixFilter, options)).toEqual(["edge"]);
		expect(search("edge", ALL, prefixFilter, options)).toEqual(["edge"]);
		expect(search("pro", ALL, prefixFilter, options)).toEqual(["gemini"]);
		// A deleted provider has no display name but stays findable by prefix.
		expect(search("removed", ALL, prefixFilter, options)).toEqual(["removed"]);
	});

	test("shows the display name next to the prefix only when it adds information", () => {
		expect(providerPrefixDisplay("edge", providerLabels)).toBe("Example Cloud · edge");
		expect(providerPrefixDisplay("codex", providerLabels)).toBe("codex");
		expect(providerPrefixDisplay("removed", providerLabels)).toBe("removed");
		expect(providerPrefixDisplay("edge", undefined)).toBe("edge");
	});
});

describe("metadata behind projected picker data", () => {
	const metadata: ModelOption[] = [
		{ value: "__default__", label: "Follow default", provider: "__default__" },
		{ value: "__summary__", label: "Follow summary", provider: "__summary__" },
		{
			value: "nug:opaque-id",
			label: "Friendly display name",
			provider: "nug",
			bareModel: "kimi-k3",
			channel: "moonshot",
			rateMultiplier: 2,
		},
		{ value: "edge:gpt-6-astra", label: "GPT 6 Astra", provider: "edge" },
		{
			value: "auto:gpt-6-astra",
			label: "GPT 6 Astra",
			provider: "__auto__",
			family: "gpt",
			autoSources: [
				{ value: "edge:gpt-6-astra", provider: "edge", available: false, subscription: false },
			],
		},
	];
	const context = {
		providerLabels,
		defaultModelValue: "auto:gpt-6-astra",
		summaryModelValue: "__default__",
	};
	const projected = groupModelsByProvider(metadata, providerLabels);
	const indexedFilter = createModelOptionsFilter(context, metadata);

	test("recovers bare model ids and channels removed by grouped projection", () => {
		expect(projected[2].items[0]).not.toHaveProperty("bareModel");
		expect(search("kimi-k3", ALL, indexedFilter, projected)).toEqual(["nug:opaque-id"]);
		expect(search("moonshot", ALL, indexedFilter, projected)).toEqual(["nug:opaque-id"]);
	});

	test("auto rows and both follow roles match their source provider", () => {
		expect(search("Example Cloud gpt", ALL, indexedFilter, projected)).toEqual([
			"__default__",
			"__summary__",
			"edge:gpt-6-astra",
			"auto:gpt-6-astra",
		]);
	});

	test("follow roles recover target metadata even when absent from the metadata snapshot", () => {
		const f = createModelOptionsFilter(
			{ ...context, summaryModelValue: "nug:opaque-id" },
			metadata.filter((model) => !model.value.startsWith("__")),
		);
		expect(search("kimi-k3", ALL, f, projected)).toEqual(["__summary__", "nug:opaque-id"]);
	});

	test("keeps display-only labels searchable alongside original metadata", () => {
		const options = [{ value: "nug:opaque-id", label: "Custom decorated caption" }];
		expect(search("decorated", ALL, indexedFilter, options)).toEqual(["nug:opaque-id"]);
		expect(search("kimi-k3", ALL, indexedFilter, options)).toEqual(["nug:opaque-id"]);
	});

	test("the index never adds a model omitted from the supplied options", () => {
		const hidden = { value: "hidden:opaque", label: "Hidden alias", bareModel: "hidden-id" };
		const f = createModelOptionsFilter(context, [...metadata, hidden]);
		expect(search("hidden-id", ALL, f, projected)).toEqual([]);
		expect(search("", ALL, f, projected)).toEqual(values(projected));
	});

	test("returns original disabled option objects without mutating the input", () => {
		const option = { value: "nug:opaque-id", label: "Friendly display name", disabled: true };
		const options = [{ group: "Gateway", items: [option] }];
		const before = structuredClone(options);
		const result = indexedFilter({ options, search: "kimi-k3", limit: ALL });
		expect(result).toEqual(options);
		expect("group" in result[0] && result[0].items[0]).toBe(option);
		expect(options).toEqual(before);
	});

	test("indexes family and the displayed multiplier even when the id is opaque", () => {
		const model: ModelOption = {
			value: "auto:orion",
			label: "Orion",
			family: "claude",
			rateMultiplier: 0.25,
		};
		const index = createModelSearchIndex([model]);
		const matches = createModelQueryMatcher("CLAUDE ×0.25");
		expect(matches(index.get(model.value) ?? "")).toBe(true);
	});

	test("malformed follow cycles terminate without borrowing another model's metadata", () => {
		const index = createModelSearchIndex(metadata, {
			providerLabels,
			defaultModelValue: "__summary__",
			summaryModelValue: "__default__",
		});
		const matches = createModelQueryMatcher("Example Cloud");
		expect(matches(index.get("__default__") ?? "")).toBe(false);
		expect(matches(index.get("__summary__") ?? "")).toBe(false);
	});
});
