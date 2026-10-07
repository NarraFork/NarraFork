import { describe, expect, test } from "bun:test";
import { type ModelOption, mergeModels } from "../lib/constants";
import {
	classifyFallbackModelPresence,
	getConfiguredFallbackModels,
	isSelectableProviderPrefix,
} from "./useModels";

describe("configured fallback models", () => {
	test("injects defaults and current selections only for enabled configured prefixes", () => {
		const models = getConfiguredFallbackModels({
			customApiProviders: [
				{
					id: "configured",
					name: "Configured Gemini",
					prefix: "gemini-live",
					apiKey: "****abcd",
					defaultModel: "gemini-provider-default",
					protocol: "gemini-compatible",
				},
				{
					id: "disabled",
					name: "Disabled",
					prefix: "disabled-provider",
					apiKey: "key",
					defaultModel: "disabled-default",
					disabled: true,
					protocol: "openai-responses",
				},
				{
					id: "no-key",
					name: "No Key",
					prefix: "no-key",
					apiKey: "",
					defaultModel: "no-key-default",
					protocol: "openai-responses",
				},
			],
			codexAvailable: true,
			agent: {
				defaultModel: "gemini-live:gemini-current-default",
				summaryModel: "stale-prefix:stale-summary",
				disabledProviders: ["codex"],
			},
		});

		expect(models.map((model) => model.value)).toEqual([
			"gemini-live:gemini-provider-default",
			"gemini-live:gemini-current-default",
		]);
		expect(models.every((model) => model.provider === "gemini-live")).toBe(true);
		expect(models.find((m) => m.value === "gemini-live:gemini-current-default")?.pinnedAs).toEqual([
			"default",
		]);
	});

	test("records both roles when the same model is default and summary", () => {
		const models = getConfiguredFallbackModels({
			nugProviders: [
				{
					id: "nug-1",
					name: "NUG",
					prefix: "xiaomi",
					apiKey: "key",
					baseUrl: "https://example.test",
				},
			],
			agent: {
				defaultModel: "xiaomi:mimo-x-pro-preview",
				summaryModel: "xiaomi:mimo-x-pro-preview",
			},
		});

		expect(models.map((m) => m.value)).toEqual(["xiaomi:mimo-x-pro-preview"]);
		expect(models[0]?.pinnedAs).toEqual(["default", "summary"]);
	});
});

describe("fallback model catalog presence", () => {
	// Value shape matches `getConfiguredFallbackModels`: `prefix:model`, never a
	// doubled prefix. The classifier only compares strings, but fixtures that
	// invent a different shape hide real matching bugs.
	const base = {
		value: "xiaomi:mimo-x-pro-preview",
		provider: "xiaomi",
		pinnedAs: ["summary"] as Array<"default" | "summary">,
	};

	test("marks a delisted model when the provider catalog still has other models", () => {
		const result = classifyFallbackModelPresence({
			...base,
			catalogValues: new Set(["xiaomi:mimo-v2.6-flash", "xiaomi:mimo-v2.6-pro"]),
			catalogCountByProvider: new Map([["xiaomi", 2]]),
		});
		expect(result.catalogMissing).toBe(true);
		expect(result.pinnedAs).toEqual(["summary"]);
	});

	test("does not mark a model that is still in the catalog", () => {
		const result = classifyFallbackModelPresence({
			...base,
			value: "xiaomi:mimo-v2.6-pro",
			catalogValues: new Set(["xiaomi:mimo-v2.6-pro"]),
			catalogCountByProvider: new Map([["xiaomi", 1]]),
		});
		expect(result.catalogMissing).toBe(false);
	});

	test("stays quiet while the provider catalog is still empty (bootstrap)", () => {
		const result = classifyFallbackModelPresence({
			...base,
			catalogValues: new Set(),
			catalogCountByProvider: new Map([["xiaomi", 0]]),
		});
		expect(result.catalogMissing).toBe(false);
	});
});

describe("mergeModels keeps status annotations across duplicates", () => {
	const catalogRow: ModelOption = {
		value: "xiaomi:mimo-x-pro-preview",
		label: "mimo-x-pro-preview",
		provider: "xiaomi",
	};

	test("a later pinned catalog-missing fallback is not dropped by an unmarked catalog row", () => {
		const merged = mergeModels(
			[catalogRow],
			[
				{
					...catalogRow,
					catalogMissing: true,
					pinnedAs: ["default", "summary"],
					available: false,
				},
			],
		);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({
			catalogMissing: true,
			pinnedAs: ["default", "summary"],
			available: false,
		});
	});

	test("earlier identity fields win while later pins accumulate", () => {
		const merged = mergeModels(
			[{ ...catalogRow, label: "Catalog Label", pinnedAs: ["default"] }],
			[{ ...catalogRow, label: "Fallback Label", pinnedAs: ["summary"], available: false }],
		);
		expect(merged).toEqual([
			{
				value: "xiaomi:mimo-x-pro-preview",
				label: "Catalog Label",
				provider: "xiaomi",
				pinnedAs: ["default", "summary"],
				available: false,
			},
		]);
	});

	test("available:false on either side survives the merge", () => {
		const merged = mergeModels(
			[{ ...catalogRow, available: false }],
			[{ ...catalogRow, available: true }],
		);
		expect(merged[0]?.available).toBe(false);
	});
});

describe("selectable provider prefixes", () => {
	const none: ReadonlySet<string> = new Set();

	test("the retired tutorial prefix is never selectable", () => {
		expect(isSelectableProviderPrefix("tutorial", none)).toBe(false);
	});

	test("the retired prefix stays excluded even if old settings enable it", () => {
		expect(isSelectableProviderPrefix("tutorial", new Set(["anthropic"]))).toBe(false);
	});

	test("ordinary prefixes are selectable unless disabled", () => {
		expect(isSelectableProviderPrefix("anthropic", none)).toBe(true);
		expect(isSelectableProviderPrefix("anthropic", new Set(["anthropic"]))).toBe(false);
	});

	test("a prefix that merely starts with the tutorial name is unaffected", () => {
		// The check is an exact match: a user-configured provider called
		// "tutorial-mirror" is a real provider and must remain usable.
		expect(isSelectableProviderPrefix("tutorial-mirror", none)).toBe(true);
	});
});
