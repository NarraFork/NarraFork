import { describe, expect, test } from "bun:test";
import { TUTORIAL_PROVIDER_PREFIX } from "@shared/tutorial/lessons";
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

	test("requires both token and base URL for Cline fallback injection", () => {
		const incomplete = getConfiguredFallbackModels({
			clineProviders: [
				{
					id: "cline",
					name: "Cline",
					prefix: "cline-custom",
					accessToken: "token",
					baseUrl: "",
					defaultModel: "model",
				},
			],
			agent: { defaultModel: "cline-custom:model", summaryModel: "" },
		});
		expect(incomplete).toEqual([]);
	});
});

describe("selectable provider prefixes", () => {
	const none: ReadonlySet<string> = new Set();

	test("the tutorial prefix is never selectable", () => {
		// A user who picked the scripted tutorial model for real work would get a
		// session that ignores everything they say, with no error explaining why.
		expect(isSelectableProviderPrefix(TUTORIAL_PROVIDER_PREFIX, none)).toBe(false);
	});

	test("the tutorial prefix stays excluded even if explicitly enabled", () => {
		// The exclusion must not be expressible as a user preference: it is a product
		// invariant, not a default.
		expect(isSelectableProviderPrefix(TUTORIAL_PROVIDER_PREFIX, new Set(["anthropic"]))).toBe(
			false,
		);
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
