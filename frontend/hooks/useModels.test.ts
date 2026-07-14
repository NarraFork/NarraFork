import { describe, expect, test } from "bun:test";
import { getConfiguredFallbackModels } from "./useModels";

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
