import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	countConfiguredProviders,
	wizardNextBlockedReasonKey,
	wizardStepIndex,
} from "../../../../frontend/components/settings/SetupWizard";
import { getCodexManager } from "../../codex-manager";
import { normalizeCustomApiProviderSettings, settings } from "../../settings";
import { registerTokenDanceRuntime, type TokenDanceRuntime } from "../../tokendance-runtime";
import {
	listProviderReadiness,
	type ProviderAdapter,
	registerExternalProviderResolver,
	resolveProviderAndModel,
} from "../provider";

const fixture = { id: "future:local", prefix: "future-local", name: "Future Local", ready: true };
const adapter = {} as ProviderAdapter;
let unregister: (() => void) | undefined;
let disposeRuntime: (() => void) | undefined;
const codexManager = getCodexManager();
let credentialDescriptor: PropertyDescriptor | undefined;
let codexReady = false;

beforeEach(() => {
	credentialDescriptor = Object.getOwnPropertyDescriptor(codexManager, "hasAvailableCredentials");
	codexReady = false;
	Object.defineProperty(codexManager, "hasAvailableCredentials", {
		configurable: true,
		get: () => codexReady,
	});
	settings.agent.disabledProviders = [];
	settings.agent.customModels = [];
	settings.customApiProviders = [];
	settings.openaiProviders = [];
	settings.anthropicProviders = [];
	settings.geminiProviders = [];
	settings.nugProviders = [];
});

afterEach(() => {
	unregister?.();
	unregister = undefined;
	disposeRuntime?.();
	disposeRuntime = undefined;
	if (credentialDescriptor)
		Object.defineProperty(codexManager, "hasAvailableCredentials", credentialDescriptor);
	else Reflect.deleteProperty(codexManager, "hasAvailableCredentials");
});

describe("registered provider source readiness", () => {
	test("TokenDance-only with an empty catalog advances only for an active runtime", async () => {
		let config: ReturnType<TokenDanceRuntime["getTokenDanceRuntimeConfig"]>;
		disposeRuntime = registerTokenDanceRuntime({
			getTokenDanceRuntimeConfig: () => config,
			getTokenDanceCatalogModels: () => [],
			assertTokenDanceConnection: () => {},
			registerTokenDanceRequest: () => () => {},
		});
		const gate = async (ready: boolean) => {
			const providerReadiness = await listProviderReadiness();
			expect(providerReadiness.find((entry) => entry.prefix === "tokendance")).toEqual({
				id: "platform-tokendance",
				prefix: "tokendance",
				name: "TokenDance",
				ready,
			});
			const providerCount = countConfiguredProviders({ providerReadiness });
			expect(providerCount).toBe(ready ? 1 : 0);
			expect(
				wizardNextBlockedReasonKey({
					step: wizardStepIndex("provider"),
					providerCount,
					basicStepValid: false,
				}),
			).toBe(ready ? null : "wizardProviderRequired");
			expect(JSON.stringify(providerReadiness)).not.toContain("runtime-secret");
		};
		await gate(false);
		config = { apiKey: "runtime-secret", generation: 1, disabled: true };
		await gate(false);
		config.disabled = false;
		await gate(true);
		// Readiness gates credential setup, not whether a model catalog was refreshed.
		expect(() => resolveProviderAndModel("tokendance:not-in-catalog")).toThrow(
			"TokenDance model is missing or has no supported protocol",
		);
		settings.agent.disabledProviders = ["tokendance"];
		await gate(false);
	});

	for (const configOrigin of ["custom", "legacy"] as const) {
		test(`TokenDance runtime and conflicting ${configOrigin} API prefix are both not ready until renamed`, async () => {
			disposeRuntime = registerTokenDanceRuntime({
				getTokenDanceRuntimeConfig: () => ({
					apiKey: "runtime-secret",
					generation: 1,
					disabled: false,
				}),
				getTokenDanceCatalogModels: () => [],
				assertTokenDanceConnection: () => {},
				registerTokenDanceRequest: () => () => {},
			});
			const config = {
				id: "conflicting-api",
				prefix: "tokendance",
				name: "Legacy API",
				apiKey: "legacy-secret",
				baseUrl: "https://legacy.invalid",
				defaultModel: "chat",
			};
			if (configOrigin === "custom") {
				settings.customApiProviders = [{ ...config, protocol: "openai-responses" }];
				normalizeCustomApiProviderSettings(settings);
			} else settings.openaiProviders = [config];
			const providerReadiness = await listProviderReadiness();
			expect(providerReadiness.filter((entry) => entry.prefix === "tokendance")).toEqual([
				{ id: "platform-tokendance", prefix: "tokendance", name: "TokenDance", ready: false },
				{ id: "api:conflicting-api", prefix: "tokendance", name: "Legacy API", ready: false },
			]);
			expect(countConfiguredProviders({ providerReadiness })).toBe(0);
			expect(
				wizardNextBlockedReasonKey({
					step: wizardStepIndex("provider"),
					providerCount: countConfiguredProviders({ providerReadiness }),
					basicStepValid: false,
				}),
			).toBe("wizardProviderRequired");
			expect(() => resolveProviderAndModel("tokendance:chat")).toThrow(
				"TokenDance prefix conflicts",
			);
			settings.customApiProviders = settings.customApiProviders?.map((entry) => ({
				...entry,
				prefix: "renamed-api",
			}));
			settings.openaiProviders = settings.openaiProviders?.map((entry) => ({
				...entry,
				prefix: "renamed-api",
			}));
			const restored = await listProviderReadiness();
			expect(restored).toContainEqual({
				id: "platform-tokendance",
				prefix: "tokendance",
				name: "TokenDance",
				ready: true,
			});
			expect(restored).toContainEqual({
				id: "api:conflicting-api",
				prefix: "renamed-api",
				name: "Legacy API",
				ready: true,
			});
			expect(countConfiguredProviders({ providerReadiness: restored })).toBe(2);
		});
	}

	test("Codex-only credentials advance the provider gate without model discovery", async () => {
		codexReady = true;
		const providerReadiness = await listProviderReadiness();
		expect(providerReadiness).toContainEqual({
			id: "platform-codex",
			prefix: "codex",
			name: "Codex",
			ready: true,
		});
		const providerCount = countConfiguredProviders({ providerReadiness });
		expect(providerCount).toBe(1);
		expect(
			wizardNextBlockedReasonKey({
				step: wizardStepIndex("provider"),
				providerCount,
				basicStepValid: false,
			}),
		).toBeNull();
		settings.agent.disabledProviders = ["codex"];
		expect(countConfiguredProviders({ providerReadiness: await listProviderReadiness() })).toBe(0);
	});
	test("an unknown registered provider both resolves and is counted without model discovery", async () => {
		unregister = registerExternalProviderResolver({
			resolve: (prefix) => (prefix === fixture.prefix ? adapter : null),
			listReadiness: () => [fixture],
		});
		settings.agent.disabledProviders = ["codex", "tokendance"];
		expect(settings.agent.customModels).toEqual([]);
		expect(resolveProviderAndModel("future-local:undiscovered-model").adapter).toBe(adapter);
		const readiness = await listProviderReadiness();
		expect(readiness).toContainEqual(fixture);
		expect(
			readiness.filter((entry) => entry.ready && entry.prefix === fixture.prefix),
		).toHaveLength(1);
		const providerCount = countConfiguredProviders({ providerReadiness: readiness });
		expect(providerCount).toBe(1);
		expect(
			wizardNextBlockedReasonKey({
				step: wizardStepIndex("provider"),
				providerCount,
				basicStepValid: false,
			}),
		).toBeNull();
	});

	test("disabled prefixes lose readiness and recover when re-enabled", async () => {
		unregister = registerExternalProviderResolver({
			resolve: () => adapter,
			listReadiness: () => [fixture],
		});
		settings.agent.disabledProviders = [fixture.prefix];
		expect(await listProviderReadiness()).toContainEqual({ ...fixture, ready: false });
		settings.agent.disabledProviders = [];
		expect(await listProviderReadiness()).toContainEqual(fixture);
	});

	test("unregistration removes routing and readiness and re-registration restores both", async () => {
		const source = { resolve: () => adapter, listReadiness: () => [fixture] };
		const baseline = await listProviderReadiness();
		unregister = registerExternalProviderResolver(source);
		expect(await listProviderReadiness()).toContainEqual(fixture);
		unregister();
		expect(await listProviderReadiness()).toEqual(baseline);
		expect(() => resolveProviderAndModel("future-local:chat")).toThrow(/not configured/);
		unregister = registerExternalProviderResolver(source);
		expect(resolveProviderAndModel("future-local:chat").adapter).toBe(adapter);
		expect(await listProviderReadiness()).toContainEqual(fixture);
	});

	test("readiness never resolves or creates adapters and explicitly strips credentials", async () => {
		let resolveCalls = 0;
		let createAdapterCalls = 0;
		const createAdapter = () => {
			createAdapterCalls++;
			return adapter;
		};
		unregister = registerExternalProviderResolver({
			resolve: () => {
				resolveCalls++;
				return createAdapter();
			},
			listReadiness: () => [
				{ ...fixture, apiKey: "private-key", token: "private-token", config: { secret: true } },
			],
		});
		const readiness = await listProviderReadiness();
		expect(readiness.find((entry) => entry.id === fixture.id)).toEqual(fixture);
		expect(JSON.stringify(readiness)).not.toContain("private-");
		expect(resolveCalls).toBe(0);
		expect(createAdapterCalls).toBe(0);
	});

	test("derived API family arrays report each custom API instance exactly once", async () => {
		settings.customApiProviders = [
			{
				id: "messages",
				prefix: "custom-messages",
				name: "Messages",
				apiKey: "secret-a",
				baseUrl: "https://messages.invalid",
				defaultModel: "chat",
				protocol: "anthropic-messages",
			},
			{
				id: "responses",
				prefix: "custom-responses",
				name: "Responses",
				apiKey: "secret-b",
				baseUrl: "https://responses.invalid",
				defaultModel: "chat",
				protocol: "openai-responses",
			},
			{
				id: "gemini",
				prefix: "custom-gemini",
				name: "Gemini",
				apiKey: "secret-c",
				baseUrl: "https://gemini.invalid",
				defaultModel: "chat",
				protocol: "gemini-compatible",
			},
		];
		normalizeCustomApiProviderSettings(settings);
		expect(settings.anthropicProviders).toHaveLength(1);
		expect(settings.openaiProviders).toHaveLength(1);
		expect(settings.geminiProviders).toHaveLength(1);
		const readiness = await listProviderReadiness();
		for (const config of settings.customApiProviders ?? []) {
			expect(readiness.filter((entry) => entry.id === `api:${config.id}`)).toEqual([
				{ id: `api:${config.id}`, prefix: config.prefix, name: config.name, ready: true },
			]);
		}
		expect(readiness.filter((entry) => entry.id.startsWith("api:"))).toHaveLength(3);
		expect(JSON.stringify(readiness)).not.toContain("secret-");
	});

	test("external readiness cannot shadow reserved builtin or configured API prefixes", async () => {
		settings.openaiProviders = [
			{
				id: "real-api",
				prefix: "real-api",
				name: "Real API",
				apiKey: "secret",
				baseUrl: "https://api.invalid",
				defaultModel: "chat",
			},
		];
		unregister = registerExternalProviderResolver({
			resolve: () => adapter,
			listReadiness: () =>
				["codex", "tokendance", "tutorial", "real-api"].map((prefix) => ({
					...fixture,
					id: `shadow:${prefix}`,
					prefix,
				})),
		});
		const readiness = await listProviderReadiness();
		expect(readiness.some((entry) => entry.id.startsWith("shadow:"))).toBe(false);
		expect(readiness.filter((entry) => entry.prefix === "real-api")).toEqual([
			{ id: "api:real-api", prefix: "real-api", name: "Real API", ready: true },
		]);
	});
});
