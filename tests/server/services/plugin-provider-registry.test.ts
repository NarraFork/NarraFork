import { describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "@server/lib/agent/provider";
import {
	PluginProviderRegistry,
	type ProviderModelDescriptor,
	ProviderRegistryError,
} from "@server/services/plugin-provider-registry";

const MODEL: ProviderModelDescriptor = {
	id: "reasoning:model-v2",
	displayName: "Reasoning Model v2",
	aliases: ["reasoning:model-latest"],
	contextWindow: 200_000,
	capabilities: {
		chat: true,
		generate: true,
		streaming: true,
		tools: true,
		reasoning: true,
		sessionMode: "stateless",
	},
};

function adapter(name: string): ProviderAdapter {
	return { name } as unknown as ProviderAdapter;
}

function registerBuiltin(
	registry: PluginProviderRegistry,
	overrides: Partial<Parameters<PluginProviderRegistry["register"]>[0]> = {},
) {
	return registry.register({
		kind: "builtin",
		providerTypeId: "builtin/core",
		providerInstanceId: "builtin-core",
		providerPrefix: "core",
		displayName: "Core Provider",
		defaultModelId: "core-model",
		models: [
			{
				id: "core-model",
				displayName: "Core Model",
				capabilities: {
					chat: true,
					generate: true,
					streaming: true,
					tools: false,
					sessionMode: "stateful",
				},
			},
		],
		createAdapter: () => adapter("builtin"),
		...overrides,
	});
}

function registerPlugin(
	registry: PluginProviderRegistry,
	overrides: Partial<Parameters<PluginProviderRegistry["register"]>[0]> = {},
) {
	return registry.register({
		kind: "executable-plugin",
		pluginId: "com.example.provider",
		localId: "main",
		providerInstanceId: "plugin-instance",
		providerPrefix: "Acme",
		displayName: "Acme Provider",
		configSchema: {
			type: "object",
			properties: {
				apiKey: { type: "string", minLength: 1 },
				region: { type: "string", enum: ["us", "eu"] },
			},
			required: ["apiKey"],
			additionalProperties: false,
		},
		config: { apiKey: "secret", region: "us" },
		models: [MODEL],
		catalogVersion: "catalog-1",
		...overrides,
	});
}

describe("PluginProviderRegistry", () => {
	test("uses a case-insensitive prefix namespace and permanently protects builtin prefixes", () => {
		const registry = new PluginProviderRegistry({ reservedPrefixes: ["host-reserved"] });
		registerBuiltin(registry, { providerPrefix: "BuiltinOne" });

		expect(() =>
			registerPlugin(registry, {
				providerInstanceId: "case-conflict",
				providerPrefix: "builtinone",
			}),
		).toThrow(expect.objectContaining({ code: "PROVIDER_CONFLICT" }));
		expect(() =>
			registerPlugin(registry, {
				providerInstanceId: "reserved-conflict",
				providerPrefix: "HOST-RESERVED",
			}),
		).toThrow(expect.objectContaining({ code: "PROVIDER_CONFLICT" }));
		expect(() =>
			registerPlugin(registry, {
				providerInstanceId: "meta-conflict",
				providerPrefix: "__default__",
			}),
		).toThrow(expect.objectContaining({ code: "PROVIDER_CONFLICT" }));

		expect(registry.unregister("builtin-core")).toBe(true);
		expect(() =>
			registerPlugin(registry, {
				providerInstanceId: "removed-builtin-conflict",
				providerPrefix: "BUILTINONE",
			}),
		).toThrow(expect.objectContaining({ code: "PROVIDER_CONFLICT" }));
	});

	test("keeps provider type, instance, prefix and colon-bearing model IDs as separate identities", () => {
		const created: Array<{ typeId: string; instanceId: string; modelIds: string[] }> = [];
		const registry = new PluginProviderRegistry({
			remoteProviderAdapterFactory: ({ entry, modelCatalog }) => {
				created.push({
					typeId: entry.providerTypeId,
					instanceId: entry.providerInstanceId,
					modelIds: [...modelCatalog.keys()],
				});
				return adapter("remote");
			},
		});
		const entry = registerPlugin(registry);

		expect(entry).toMatchObject({
			providerTypeId: "com.example.provider/main",
			providerInstanceId: "plugin-instance",
			providerPrefix: "Acme",
		});
		expect(registry.describe("com.example.provider/main")?.providerInstanceId).toBe(
			"plugin-instance",
		);
		const resolution = registry.resolveProvider("aCmE:reasoning:model-v2", {
			requireKnownModel: true,
		});
		expect(resolution).toMatchObject({
			providerTypeId: "com.example.provider/main",
			providerInstanceId: "plugin-instance",
			providerPrefix: "Acme",
			modelId: "reasoning:model-v2",
			model: "Acme:reasoning:model-v2",
		});
		expect(resolution.adapter).toBeDefined();
		expect(created).toEqual([
			{
				typeId: "com.example.provider/main",
				instanceId: "plugin-instance",
				modelIds: ["reasoning:model-v2"],
			},
		]);
	});

	test("keeps disabled and incompatible plugin providers visible but unavailable", () => {
		const registry = new PluginProviderRegistry();
		registerPlugin(registry, {
			pluginState: { desiredState: "disabled", compatibility: "compatible" },
		});

		expect(registry.describe("plugin-instance")).toMatchObject({
			status: "unavailable",
			disabled: true,
			unavailableReason: "plugin-disabled",
		});
		expect(registry.listModels("plugin-instance")).toMatchObject({
			available: false,
			stale: true,
			models: [expect.objectContaining({ id: "reasoning:model-v2" })],
		});
		expect(() => registry.resolveProvider("Acme:reasoning:model-v2")).toThrow(
			expect.objectContaining({ code: "PROVIDER_UNAVAILABLE" }),
		);

		expect(registry.enablePlugin("com.example.provider")).toBe(1);
		expect(registry.markPluginIncompatible("com.example.provider")).toBe(1);
		expect(registry.describe("Acme")).toMatchObject({
			status: "unavailable",
			compatible: false,
			unavailableReason: "plugin-incompatible",
		});
	});

	test("retains the last-known-good catalog and marks it stale after a failed refresh", () => {
		const registry = new PluginProviderRegistry();
		registerPlugin(registry);

		expect(() =>
			registry.updateModelCatalog(
				"plugin-instance",
				[
					MODEL,
					{
						...MODEL,
						displayName: "Duplicate Model",
					},
				],
				{ catalogVersion: "catalog-bad" },
			),
		).toThrow(expect.objectContaining({ code: "MODEL_CATALOG_INVALID" }));

		const catalog = registry.listModels("plugin-instance");
		expect(catalog.catalogVersion).toBe("catalog-1");
		expect(catalog.stale).toBe(true);
		expect(catalog.models.map((model) => model.id)).toEqual(["reasoning:model-v2"]);

		registry.updateModelCatalog("plugin-instance", [{ ...MODEL, id: "fresh:model" }], {
			catalogVersion: "catalog-2",
		});
		expect(registry.listModels("plugin-instance")).toMatchObject({
			catalogVersion: "catalog-2",
			stale: false,
			models: [expect.objectContaining({ id: "fresh:model" })],
		});
	});

	test("falls back to an available builtin for an unprefixed unknown model", () => {
		const registry = new PluginProviderRegistry();
		registerBuiltin(registry);
		registerPlugin(registry);

		const resolution = registry.resolveProvider("vendor-model");
		expect(resolution).toMatchObject({
			providerPrefix: "core",
			providerInstanceId: "builtin-core",
			modelId: "vendor-model",
			model: "core:vendor-model",
		});
		expect((resolution.adapter as unknown as { name: string }).name).toBe("builtin");
	});

	test("validates config locally before creating an adapter", () => {
		let factoryCalls = 0;
		const registry = new PluginProviderRegistry({
			remoteAdapterFactory: () => {
				factoryCalls += 1;
				return adapter("remote");
			},
		});
		registerPlugin(registry);

		expect(registry.validateConfig("Acme", { apiKey: "", region: "moon" })).toMatchObject({
			valid: false,
			issues: expect.arrayContaining([
				expect.objectContaining({ path: "/apiKey" }),
				expect.objectContaining({ path: "/region" }),
			]),
		});
		expect(factoryCalls).toBe(0);
		expect(() =>
			registry.resolveProvider("Acme:reasoning:model-v2", {
				config: { apiKey: "", extra: true },
			}),
		).toThrow(expect.objectContaining({ code: "PROVIDER_CONFIG_INVALID" }));
		expect(factoryCalls).toBe(0);

		expect(
			registry.resolveProvider("Acme:reasoning:model-v2", {
				config: { apiKey: "valid", region: "eu" },
			}).adapter,
		).toBeDefined();
		expect(factoryCalls).toBe(1);
	});

	test("unregisters one instance without deleting other instances of the same provider type", () => {
		const registry = new PluginProviderRegistry();
		registerPlugin(registry);
		registerPlugin(registry, {
			providerInstanceId: "plugin-instance-2",
			providerPrefix: "AcmeTwo",
		});

		expect(registry.describeType("com.example.provider/main")).toHaveLength(2);
		expect(registry.unregister("plugin-instance")).toBe(true);
		expect(registry.describeType("com.example.provider/main")).toMatchObject([
			{ providerInstanceId: "plugin-instance-2" },
		]);
		expect(registry.unregister("missing")).toBe(false);
	});

	test("uses typed registry errors", () => {
		const registry = new PluginProviderRegistry();
		try {
			registry.resolveProvider("missing:model");
			throw new Error("expected resolution to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(ProviderRegistryError);
			expect(error).toMatchObject({ code: "PROVIDER_NOT_FOUND" });
		}
	});
});
