import { describe, expect, test } from "bun:test";
import type { JsonValue } from "@server/lib/plugins/protocol";
import { providerSecretKey } from "@server/services/plugin-provider-config-service";
import {
	PluginProviderCredentialResolver,
	type ProviderCredentialSource,
} from "@server/services/plugin-provider-credential-resolver";
import {
	PluginProviderRegistry,
	type ProviderRegistryRegistration,
} from "@server/services/plugin-provider-registry";

/**
 * The resolver is the only thing that turns a stored credential into something a plugin
 * can use, so its guarantees are security-relevant:
 *
 *   1. a declared secret reaches the plugin (otherwise a configured key is useless);
 *   2. nothing beyond the provider's own declared fields ever reaches it;
 *   3. an unset secret stays *absent* rather than becoming `""`;
 *   4. no caching, so revocation and rotation take effect on the next call;
 *   5. a broken vault degrades to "unauthenticated" instead of breaking the provider.
 */

const pluginId = "com.example.credentials";

function registration(
	overrides: Partial<ProviderRegistryRegistration> = {},
): ProviderRegistryRegistration {
	return {
		kind: "executable-plugin",
		pluginId,
		localId: "demo",
		providerInstanceId: "inst-demo",
		providerPrefix: "demo",
		displayName: "Demo Provider",
		configSchema: {
			type: "object",
			properties: {
				apiMode: { type: "string" },
				apiKey: { type: "string", writeOnly: true },
			},
			additionalProperties: false,
		},
		config: { apiMode: "offline" },
		...overrides,
	} as ProviderRegistryRegistration;
}

/** In-memory stand-in for the vault's read side. */
function source(secrets: Record<string, string>): ProviderCredentialSource {
	return {
		getSecret: async ({ key }) => secrets[key],
	};
}

function resolverFor(
	secrets: Record<string, string>,
	overrides: Partial<ProviderRegistryRegistration> = {},
): { resolver: PluginProviderCredentialResolver; registry: PluginProviderRegistry } {
	const registry = new PluginProviderRegistry();
	registry.register(registration(overrides));
	return {
		registry,
		resolver: new PluginProviderCredentialResolver({
			registry,
			secretSource: source(secrets),
		}),
	};
}

describe("plugin provider credential resolver", () => {
	test("merges a stored secret into the config sent to the plugin", async () => {
		const key = providerSecretKey("demo", "apiKey");
		const { resolver } = resolverFor({ [key]: "sk-live-123" });

		const config = await resolver.resolve("inst-demo");

		// The whole point: the plain field and the credential arrive together.
		expect(config).toEqual({ apiMode: "offline", apiKey: "sk-live-123" });
	});

	test("omits an unset secret instead of sending an empty string", async () => {
		const { resolver } = resolverFor({});

		const config = await resolver.resolve("inst-demo");

		// A plugin must be able to tell "no credential configured" apart from
		// "configured as empty", which an `""` would erase.
		expect(config).toEqual({ apiMode: "offline" });
		expect("apiKey" in config).toBe(false);
	});

	test("treats a stored empty value as unset", async () => {
		const { resolver } = resolverFor({ [providerSecretKey("demo", "apiKey")]: "" });

		expect(await resolver.resolve("inst-demo")).toEqual({ apiMode: "offline" });
	});

	test("never sends a field the provider's schema does not declare", async () => {
		// Both a sibling provider's key and an undeclared field for this provider.
		const { resolver } = resolverFor({
			[providerSecretKey("other", "apiKey")]: "sk-other",
			[providerSecretKey("demo", "undeclared")]: "sk-undeclared",
		});

		const config = await resolver.resolve("inst-demo");

		expect(config).toEqual({ apiMode: "offline" });
		expect(Object.values(config)).not.toContain("sk-other");
		expect(Object.values(config)).not.toContain("sk-undeclared");
	});

	test("scopes the lookup to the requesting plugin", async () => {
		const key = providerSecretKey("demo", "apiKey");
		const registry = new PluginProviderRegistry();
		registry.register(registration());
		const seen: Array<{ pluginId: string; key: string }> = [];
		const resolver = new PluginProviderCredentialResolver({
			registry,
			secretSource: {
				getSecret: async (input) => {
					seen.push(input);
					return input.pluginId === pluginId ? "sk-live-123" : "sk-wrong-plugin";
				},
			},
		});

		await resolver.resolve("inst-demo");

		// A vault read must be bound to the owning plugin, or one plugin could be handed
		// another's credential under a colliding contribution id.
		expect(seen).toEqual([{ pluginId, key }]);
	});

	test("re-reads on every call so rotation and revocation take effect immediately", async () => {
		const key = providerSecretKey("demo", "apiKey");
		const secrets: Record<string, string> = { [key]: "sk-first" };
		const registry = new PluginProviderRegistry();
		registry.register(registration());
		let reads = 0;
		const resolver = new PluginProviderCredentialResolver({
			registry,
			secretSource: {
				getSecret: async ({ key: requested }) => {
					reads += 1;
					return secrets[requested];
				},
			},
		});

		expect((await resolver.resolve("inst-demo")).apiKey).toBe("sk-first");
		secrets[key] = "sk-rotated";
		expect((await resolver.resolve("inst-demo")).apiKey).toBe("sk-rotated");
		delete secrets[key];
		expect("apiKey" in (await resolver.resolve("inst-demo"))).toBe(false);
		expect(reads).toBe(3);
	});

	test("reflects a config update without being rebuilt", async () => {
		const { resolver, registry } = resolverFor({
			[providerSecretKey("demo", "apiKey")]: "sk-live-123",
		});

		registry.updateConfig("inst-demo", { apiMode: "verbose" });

		expect(await resolver.resolve("inst-demo")).toEqual({
			apiMode: "verbose",
			apiKey: "sk-live-123",
		});
	});

	test("degrades to plain config when the vault read throws", async () => {
		const registry = new PluginProviderRegistry();
		registry.register(registration());
		const resolver = new PluginProviderCredentialResolver({
			registry,
			secretSource: {
				getSecret: () => {
					throw new Error("vault unreadable");
				},
			},
		});

		// An unreadable vault should surface as the provider's own auth failure, which is
		// actionable, rather than as an opaque host error on every request.
		expect(await resolver.resolve("inst-demo")).toEqual({ apiMode: "offline" });
	});

	test("returns plain config when no secret source is configured", async () => {
		const registry = new PluginProviderRegistry();
		registry.register(registration());
		const resolver = new PluginProviderCredentialResolver({ registry });

		expect(await resolver.resolve("inst-demo")).toEqual({ apiMode: "offline" });
	});

	test("returns an empty object for an unknown provider", async () => {
		const { resolver } = resolverFor({});

		// Runs in the request path; the caller's own resolution error is the better report.
		expect(await resolver.resolve("inst-missing")).toEqual({});
	});

	test("leaves a provider without secret fields untouched", async () => {
		const { resolver } = resolverFor(
			{ [providerSecretKey("demo", "apiKey")]: "sk-live-123" },
			{
				configSchema: {
					type: "object",
					properties: { apiMode: { type: "string" } },
					additionalProperties: false,
				} as unknown as Record<string, JsonValue>,
			},
		);

		// The stored value exists but the schema no longer declares it, so it must not be
		// resurrected into the payload.
		expect(await resolver.resolve("inst-demo")).toEqual({ apiMode: "offline" });
	});

	test("recognizes every documented secret marker", async () => {
		for (const marker of [
			{ format: "password" },
			{ writeOnly: true },
			{ "x-narrafork-secret": true },
		]) {
			const { resolver } = resolverFor(
				{ [providerSecretKey("demo", "apiKey")]: "sk-live-123" },
				{
					configSchema: {
						type: "object",
						properties: { apiMode: { type: "string" }, apiKey: { type: "string", ...marker } },
						additionalProperties: false,
					} as unknown as Record<string, JsonValue>,
				},
			);

			expect((await resolver.resolve("inst-demo")).apiKey).toBe("sk-live-123");
		}
	});
});
