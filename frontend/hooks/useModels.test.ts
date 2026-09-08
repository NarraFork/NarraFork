import { describe, expect, test } from "bun:test";
import { getConfiguredFallbackModels, isSelectableProviderPrefix } from "./useModels";

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
					protocol: "responses-compatible",
				},
				{
					id: "no-key",
					name: "No Key",
					prefix: "no-key",
					apiKey: "",
					defaultModel: "no-key-default",
					protocol: "responses-compatible",
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
