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

/**
 * Config size must not scale with how many credentials a plugin stores.
 *
 * The resolver injects exactly the secret fields a provider *declared*, so a plugin that keeps
 * its credentials under runtime-generated vault keys receives none of them here — it reads them
 * itself. That is what makes hundreds of credentials expressible: the old design put the whole
 * set into one declared field, so credential count inflated the injected config and ran into
 * both the vault's per-value limit and the provider's own `maxConfigBytes`.
 *
 * These tests pin the *host-side* half of that arrangement. Raising a byte ceiling would not
 * have achieved it; the coupling had to be removed.
 */
describe("config size is independent of credential count", () => {
	/** A provider that declares only a small bookkeeping sentinel, as reference plugins do. */
	const sentinelSchema = {
		type: "object",
		properties: {
			loadBalancingMode: { type: "string" },
			credentialsIndex: { type: "string", writeOnly: true },
		},
		additionalProperties: false,
	} as unknown as Record<string, JsonValue>;

	test("undeclared per-credential keys are never injected", async () => {
		// Three credentials in the vault under runtime-generated keys, plus the sentinel.
		const { resolver } = resolverFor(
			{
				[providerSecretKey("demo", "credentialsIndex")]: JSON.stringify({
					revision: 7,
					count: 3,
				}),
				[providerSecretKey("demo", "cred.aaa")]: JSON.stringify({ id: "aaa" }),
				[providerSecretKey("demo", "cred.bbb")]: JSON.stringify({ id: "bbb" }),
				[providerSecretKey("demo", "cred.ccc")]: JSON.stringify({ id: "ccc" }),
			},
			{ configSchema: sentinelSchema, config: { loadBalancingMode: "priority" } },
		);

		const resolved = await resolver.resolve("inst-demo");
		expect(Object.keys(resolved).sort()).toEqual(["credentialsIndex", "loadBalancingMode"]);
	});

	test("injected config stays the same size as credentials are added", async () => {
		const secrets: Record<string, string> = {
			[providerSecretKey("demo", "credentialsIndex")]: JSON.stringify({
				revision: 1,
				count: 1,
			}),
			[providerSecretKey("demo", "cred.one")]: JSON.stringify({ id: "one" }),
		};
		const small = resolverFor(secrets, {
			configSchema: sentinelSchema,
			config: { loadBalancingMode: "priority" },
		});
		const withOne = JSON.stringify(await small.resolver.resolve("inst-demo")).length;

		// 400 more credentials, each carrying JWT-sized tokens: over 1 MB of stored material.
		const jwt = `eyJ${"A".repeat(1_000)}`;
		for (let index = 0; index < 400; index += 1) {
			secrets[providerSecretKey("demo", `cred.gen-${index}`)] = JSON.stringify({
				id: `gen-${index}`,
				refreshToken: jwt,
				accessToken: jwt,
			});
		}
		const large = resolverFor(secrets, {
			configSchema: sentinelSchema,
			config: { loadBalancingMode: "priority" },
		});
		const withManyConfig = await large.resolver.resolve("inst-demo");
		const withMany = JSON.stringify(withManyConfig).length;

		// Only the sentinel's own `count` differs, so the payload does not grow with the set.
		expect(withMany).toBeLessThan(withOne + 16);
		// Comfortably inside a reference provider's declared 16 KB config budget, which the old
		// single-field design would have exceeded at roughly six credentials.
		expect(withMany).toBeLessThan(16_384);
	});

	test("the sentinel still reaches the plugin, so it can tell configured from empty", async () => {
		// The sentinel is the one credential-related value that must be injected: it is what
		// `requiresConfig` and `secretsSet` inspect, and a per-credential key cannot be
		// declared statically because its id is generated at runtime.
		const { resolver } = resolverFor(
			{
				[providerSecretKey("demo", "credentialsIndex")]: JSON.stringify({
					revision: 7,
					count: 3,
				}),
			},
			{ configSchema: sentinelSchema, config: {} },
		);

		expect(await resolver.resolve("inst-demo")).toEqual({
			credentialsIndex: JSON.stringify({ revision: 7, count: 3 }),
		});
	});

	test("no sentinel means the field is absent, not empty", async () => {
		// Absent is how the plugin tells "never configured" from "configured as empty", and it
		// is why zero credentials must delete the key rather than store a count of zero.
		const { resolver } = resolverFor(
			{ [providerSecretKey("demo", "cred.orphan")]: JSON.stringify({ id: "orphan" }) },
			{ configSchema: sentinelSchema, config: {} },
		);

		const resolved = await resolver.resolve("inst-demo");
		expect("credentialsIndex" in resolved).toBe(false);
	});
});
