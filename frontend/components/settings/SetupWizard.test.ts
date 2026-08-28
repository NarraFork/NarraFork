import { describe, expect, test } from "bun:test";
import {
	countConfiguredProviders,
	persistSetupWizardBeforeNetworkChange,
	WIZARD_STEPS,
	wizardNextBlockedReasonKey,
	wizardStepIndex,
} from "./SetupWizard";

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

describe("setup wizard step order and gating", () => {
	test("providers and models both come before dependencies", () => {
		// Order matters: dependency installation can be delegated to a Setup
		// Assistant narrator, which is spawned on `settings.agent.defaultModel`.
		// Both the provider credential AND the model selection must therefore be
		// settled before the user can reach the step that offers delegation,
		// otherwise the narrator runs on an unconfigured fallback model.
		expect(wizardStepIndex("provider")).toBeLessThan(wizardStepIndex("deps"));
		expect(wizardStepIndex("basic")).toBeLessThan(wizardStepIndex("deps"));
		expect(WIZARD_STEPS[0]).toBe("welcome");
		expect(WIZARD_STEPS.at(-1)).toBe("complete");
	});

	test("the provider step is a hard gate", () => {
		expect(
			wizardNextBlockedReasonKey({
				step: wizardStepIndex("provider"),
				providerCount: 0,
				basicStepValid: true,
			}),
		).toBe("wizardProviderRequired");
		expect(
			wizardNextBlockedReasonKey({
				step: wizardStepIndex("provider"),
				providerCount: 1,
				basicStepValid: true,
			}),
		).toBeNull();
	});

	test("the dependency step never blocks Next", () => {
		// Missing system dependencies must not trap a first-time user: git only
		// gates project features, and a narrator can install it later.
		expect(
			wizardNextBlockedReasonKey({
				step: wizardStepIndex("deps"),
				providerCount: 0,
				basicStepValid: false,
			}),
		).toBeNull();
	});

	test("the basic step still requires both models", () => {
		expect(
			wizardNextBlockedReasonKey({
				step: wizardStepIndex("basic"),
				providerCount: 1,
				basicStepValid: false,
			}),
		).toBe("wizardModelsRequired");
		expect(
			wizardNextBlockedReasonKey({
				step: wizardStepIndex("basic"),
				providerCount: 1,
				basicStepValid: true,
			}),
		).toBeNull();
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
