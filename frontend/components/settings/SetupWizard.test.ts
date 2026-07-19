import { describe, expect, test } from "bun:test";
import { countConfiguredProviders, persistSetupWizardBeforeNetworkChange } from "./SetupWizard";

describe("setup wizard completion", () => {
	test("persists completion before applying a network change", async () => {
		const calls: string[] = [];
		const response = await persistSetupWizardBeforeNetworkChange(
			"0.0.0.0",
			async () => {
				calls.push("completion");
			},
			async (host) => {
				calls.push(`network:${host}`);
				return { serverRestarting: true };
			},
		);

		expect(calls).toEqual(["completion", "network:0.0.0.0"]);
		expect(response).toEqual({ serverRestarting: true });
	});
});

describe("setup wizard provider readiness", () => {
	test("counts credentialed providers without requiring cached models", () => {
		expect(
			countConfiguredProviders({
				customApiProviders: [
					{
						id: "gemini",
						prefix: "gemini",
						apiKey: "key",
						protocol: "gemini-compatible",
					},
				],
				nugProviders: [{ id: "nug", prefix: "nug", apiKey: "key", baseUrl: "https://nug.example" }],
				clineProviders: [
					{ id: "cline", prefix: "cline", accessToken: "token", baseUrl: "https://cline.example" },
				],
				codexAvailable: true,
				agent: { disabledProviders: [] },
			}),
		).toBe(5);
	});

	test("ignores disabled or incomplete credentials", () => {
		expect(
			countConfiguredProviders({
				customApiProviders: [
					{ id: "disabled", prefix: "gemini", apiKey: "key", disabled: true },
					{ id: "empty", prefix: "openai", apiKey: "" },
				],
				nugProviders: [{ id: "nug", prefix: "nug", apiKey: "key", baseUrl: "" }],
				clineProviders: [{ id: "cline", prefix: "cline", accessToken: "token", baseUrl: "" }],
				codexAvailable: true,
			}),
		).toBe(0);
	});
});
