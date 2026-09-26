import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	PluginProviderRegistry,
	ProviderRegistryError,
} from "../../../services/plugin-provider-registry";
import { settings } from "../../settings";

class MockProvider {}

// Snapshot the real provider modules before mocking. Bun's mock.module is
// process-wide and mock.restore() does NOT undo it, so afterAll re-points each
// specifier back — otherwise these MockProvider stubs leak into later suites
// that need the real provider classes (e.g. anthropic-v1-fallback).
const realProviderModules: Record<string, () => unknown> = {
	"../anthropic-provider": () => realAnthropic,
	"../codex-provider": () => realCodex,
	"../nug-provider": () => realNug,
	"../openai-provider": () => realOpenai,
};
const realAnthropic = { ...(await import("../anthropic-provider")) };
const realCodex = { ...(await import("../codex-provider")) };
const realNug = { ...(await import("../nug-provider")) };
const realOpenai = { ...(await import("../openai-provider")) };

mock.module("../anthropic-provider", () => ({ AnthropicProvider: MockProvider }));
mock.module("../codex-provider", () => ({ CodexProvider: MockProvider }));
mock.module("../nug-provider", () => ({ NugProvider: MockProvider }));
mock.module("../openai-provider", () => ({ OpenAIProvider: MockProvider }));

const { registerExternalProviderResolver, resolveProviderAndModel } = await import("../provider");

describe("resolveProviderAndModel", () => {
	let originalDisabledProviders: string[] | undefined;

	beforeEach(() => {
		originalDisabledProviders = settings.agent?.disabledProviders;
		if (settings.agent) settings.agent.disabledProviders = [];
	});

	afterEach(() => {
		if (settings.agent) settings.agent.disabledProviders = originalDisabledProviders;
	});

	afterAll(() => {
		for (const [specifier, factory] of Object.entries(realProviderModules)) {
			mock.module(specifier, factory);
		}
		mock.restore();
	});

	test("delegates unknown provider prefixes to the registered plugin resolver", () => {
		const adapter = {} as never;
		const unregister = registerExternalProviderResolver((provider, model) => {
			expect(provider).toBe("acme");
			expect(model).toBe("acme:chat:large");
			return adapter as never;
		});

		try {
			const resolved = resolveProviderAndModel("acme:chat:large");
			expect(resolved.provider).toBe("acme");
			expect(resolved.model).toBe("acme:chat:large");
			expect(resolved.adapter).toBe(adapter);
		} finally {
			unregister();
		}
	});

	test("preserves the existing error semantics when the plugin resolver declines", () => {
		const unregister = registerExternalProviderResolver(() => null);
		try {
			expect(() => resolveProviderAndModel("acme:chat:large")).toThrow(
				/Provider "acme" is not configured/,
			);
		} finally {
			unregister();
		}
	});

	test("preserves plugin lifecycle errors and resolves again after recovery without reconfiguration", () => {
		const registry = new PluginProviderRegistry();
		const adapter = {} as never;
		registry.register({
			kind: "executable-plugin",
			pluginId: "com.example.cline",
			localId: "main",
			providerInstanceId: "cline-instance",
			providerPrefix: "cline-ext",
			displayName: "Cline",
			createAdapter: () => adapter,
		});
		const unregister = registerExternalProviderResolver((provider, model) =>
			registry.resolveExternalProvider(provider, model),
		);
		try {
			expect(resolveProviderAndModel("cline-ext:chat:large").adapter).toBe(adapter);
			registry.markUnavailable("cline-instance", "runtime-generation-changed");
			expect(() => resolveProviderAndModel("cline-ext:chat:large")).toThrow(
				expect.objectContaining({
					code: "PROVIDER_UNAVAILABLE",
					message: "Provider cline-ext is unavailable: runtime-generation-changed",
				}),
			);
			// Discovery probes still decline unavailable providers without throwing.
			expect(registry.tryResolveProvider("cline-ext:chat:large")).toBeUndefined();
			registry.enablePlugin("com.example.cline");
			expect(resolveProviderAndModel("cline-ext:chat:large").adapter).toBe(adapter);
			registry.disablePlugin("com.example.cline", "runtime-crash");
			expect(() => resolveProviderAndModel("cline-ext:chat:large")).toThrow(
				expect.objectContaining({
					code: "PROVIDER_UNAVAILABLE",
					message: "Provider cline-ext is unavailable: runtime-crash",
				}),
			);
			expect(() => resolveProviderAndModel("missing-plugin:chat")).toThrow(
				'Provider "missing-plugin" is not configured',
			);
		} finally {
			unregister();
		}
	});

	test("does not mask a registered plugin's config or adapter failure as a missing prefix", () => {
		const configError = new ProviderRegistryError(
			"PROVIDER_CONFIG_INVALID",
			"Plugin adapter rejected its configuration",
		);
		const registry = new PluginProviderRegistry({
			remoteProviderAdapterFactory: () => {
				throw configError;
			},
		});
		registry.register({
			kind: "executable-plugin",
			pluginId: "com.example.config",
			localId: "main",
			providerInstanceId: "config-instance",
			providerPrefix: "config-plugin",
			displayName: "Config plugin",
			configSchema: { type: "object", required: ["token"] },
			config: { token: "fixture" },
		});
		const unregister = registerExternalProviderResolver((provider, model) =>
			registry.resolveExternalProvider(provider, model),
		);
		try {
			expect(() => resolveProviderAndModel("config-plugin:chat")).toThrow(
				expect.objectContaining({ code: "PROVIDER_CONFIG_INVALID" }),
			);
			registry.setRemoteProviderAdapterFactory(undefined);
			expect(() => resolveProviderAndModel("config-plugin:chat")).toThrow(
				expect.objectContaining({ code: "PROVIDER_UNAVAILABLE" }),
			);
		} finally {
			unregister();
		}
	});

	test("builtin providers are consulted before the plugin resolver for their own prefix", () => {
		let pluginResolverCalls = 0;
		const unregister = registerExternalProviderResolver(() => {
			pluginResolverCalls += 1;
			return null;
		});
		try {
			// codex is a builtin provider resolved before the external resolver hook.
			// Asking for a codex model must never reach the plugin resolver — it may
			// throw for other reasons (e.g. mocked class), but the resolver is skipped.
			try {
				resolveProviderAndModel("codex:gpt-5.5");
			} catch {
				// Construction may fail due to mocking — the point is the plugin resolver was skipped.
			}
			expect(pluginResolverCalls).toBe(0);

			// An unknown prefix does fall through to the plugin resolver.
			expect(() => resolveProviderAndModel("acme:chat:large")).toThrow(/not configured/);
			expect(pluginResolverCalls).toBe(1);
		} finally {
			unregister();
		}
	});
});
