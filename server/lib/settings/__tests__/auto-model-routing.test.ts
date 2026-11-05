import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	AutoModelUnavailableError,
	expandAllowedPoolForDisplay,
	getSubagentVisibleModels,
	listAutoModelCandidates,
	listAutoModelIds,
	resolveAllowedModelCandidateMatch,
	resolveEffectiveModel,
	resolveProvider,
	settings,
} from "../index";
import type { ModelOption } from "../types";

// auto:<model> resolves among every visible provider model that is a strong catalog
// match for the logical model (docs/PROVIDER-SOURCING-DESIGN.md §4.1). Visible models
// are injected through customModels so nothing depends on provider caches or network.

const models = (...values: string[]): ModelOption[] =>
	values.map((value) => ({ value, label: value, provider: value.slice(0, value.indexOf(":")) }));

// The catalog splits a value into provider prefix and upstream id only for configured
// providers, so each test prefix needs a provider entry.
const PREFIXES = ["provA", "provB", "provC", "provD", "provE"];
const providers = (): NonNullable<typeof settings.customApiProviders> =>
	PREFIXES.map((prefix) => ({
		id: `autoTest${prefix}`,
		name: prefix,
		prefix,
		apiKey: "",
		baseUrl: "https://example.com/v1",
		defaultModel: "m",
		protocol: "completions-compatible",
	}));

describe("auto model routing", () => {
	let saved: {
		customModels: ModelOption[];
		hiddenModels: string[];
		disabledProviders?: string[];
		autoExcludedProviders?: string[];
		defaultModel: string;
		summaryModel: string;
		customApiProviders: typeof settings.customApiProviders;
	};

	beforeEach(() => {
		saved = {
			customModels: settings.agent.customModels,
			hiddenModels: settings.agent.hiddenModels,
			disabledProviders: settings.agent.disabledProviders,
			autoExcludedProviders: settings.agent.autoExcludedProviders,
			defaultModel: settings.agent.defaultModel,
			summaryModel: settings.agent.summaryModel,
			customApiProviders: settings.customApiProviders,
		};
		settings.agent.hiddenModels = [];
		settings.agent.disabledProviders = [];
		settings.agent.autoExcludedProviders = [];
		settings.customApiProviders = [...(saved.customApiProviders ?? []), ...providers()];
		settings.agent.customModels = models(
			"provA:claude-opus-4-6",
			"provB:claude-opus-4.6",
			"provC:claude-opus-4-6-20260101",
			"provD:claude-opus-4-6-foo",
			"provB:gpt-5.5",
			"provE:private-model-x",
		);
	});

	afterEach(() => {
		Object.assign(settings.agent, {
			customModels: saved.customModels,
			hiddenModels: saved.hiddenModels,
			disabledProviders: saved.disabledProviders,
			autoExcludedProviders: saved.autoExcludedProviders,
			defaultModel: saved.defaultModel,
			summaryModel: saved.summaryModel,
		});
		settings.customApiProviders = saved.customApiProviders;
	});

	test("candidates are the strong matches only, and catalog-less models have no auto", () => {
		expect(listAutoModelCandidates("claude-opus-4-6")).toEqual([
			"provA:claude-opus-4-6",
			"provB:claude-opus-4.6",
		]);
		const ids = listAutoModelIds();
		expect(ids).toContain("claude-opus-4-6");
		expect(ids).toContain("gpt-5.5");
		expect(ids.some((id) => id.includes("private-model-x"))).toBe(false);
	});

	test("resolves to the first provider, stays on the session's provider, and names it", () => {
		expect(resolveEffectiveModel("auto:claude-opus-4-6")).toBe("provA:claude-opus-4-6");
		expect(resolveEffectiveModel("auto:claude-opus-4-6", "provB")).toBe("provB:claude-opus-4.6");
		// A sticky provider that does not serve the model is ignored.
		expect(resolveEffectiveModel("auto:claude-opus-4-6", "provE")).toBe("provA:claude-opus-4-6");
		expect(resolveProvider("auto:claude-opus-4-6")).toBe("provA");
	});

	test("excluded and disabled providers leave auto but still serve pinned values", () => {
		settings.agent.autoExcludedProviders = ["provA"];
		expect(resolveEffectiveModel("auto:claude-opus-4-6")).toBe("provB:claude-opus-4.6");
		expect(resolveEffectiveModel("provA:claude-opus-4-6")).toBe("provA:claude-opus-4-6");
		settings.agent.disabledProviders = ["provB"];
		expect(() => resolveEffectiveModel("auto:claude-opus-4-6")).toThrow(AutoModelUnavailableError);
	});

	test("a model nobody serves is an error, never another model", () => {
		expect(() => resolveEffectiveModel("auto:no-such-model")).toThrow(AutoModelUnavailableError);
		settings.agent.defaultModel = "auto:claude-opus-4-6";
		expect(resolveEffectiveModel("__default__")).toBe("provA:claude-opus-4-6");
		// An unservable summary model follows the default, like an empty aggregation does.
		settings.agent.summaryModel = "auto:no-such-model";
		expect(resolveEffectiveModel("__summary__")).toBe("provA:claude-opus-4-6");
	});

	test("subagents see auto values, and a pool entry admits the providers that serve it", () => {
		const visible = getSubagentVisibleModels();
		expect(visible).toContain("auto:claude-opus-4-6");
		expect(visible).toContain("provA:claude-opus-4-6");
		expect(visible).not.toContain("auto:private-model-x");

		const pool = ["auto:claude-opus-4-6"];
		expect(resolveAllowedModelCandidateMatch("auto:claude-opus-4-6", pool)?.model).toBe(
			"auto:claude-opus-4-6",
		);
		expect(resolveAllowedModelCandidateMatch("provB:claude-opus-4.6", pool)?.model).toBe(
			"provB:claude-opus-4.6",
		);
		expect(resolveAllowedModelCandidateMatch("provC:claude-opus-4-6-20260101", pool)).toBeNull();
		expect(expandAllowedPoolForDisplay(pool)).toEqual([
			"auto:claude-opus-4-6 (currently provA:claude-opus-4-6, provB:claude-opus-4.6)",
		]);
	});

	test("an existing provider prefixed `auto` keeps its values until renamed", () => {
		settings.customApiProviders = [
			...(settings.customApiProviders ?? []),
			{
				id: "legacyAutoPrefix",
				name: "Legacy",
				prefix: "auto",
				apiKey: "",
				baseUrl: "https://example.com/v1",
				defaultModel: "m",
				protocol: "completions-compatible",
			},
		];
		expect(resolveEffectiveModel("auto:claude-opus-4-6")).toBe("auto:claude-opus-4-6");
		expect(resolveProvider("auto:claude-opus-4-6")).toBe("auto");
	});
});
