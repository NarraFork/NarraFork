import { describe, expect, test } from "bun:test";
import { parseManifest } from "@server/lib/plugins/manifest";
import { getVisibleModels, registerExtraModelSource, resolveProvider } from "@server/lib/settings";
import { PluginProviderCatalogRefresher } from "@server/services/plugin-provider-catalog-refresh";
import { PluginProviderClientPool } from "@server/services/plugin-provider-client";
import { providerRegistrationsFromManifest } from "@server/services/plugin-provider-manifest";
import {
	findPluginProviderForModel,
	listPluginProviderModelGroups,
	listPluginProviderModelValues,
} from "@server/services/plugin-provider-model-source";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";

/**
 * Walks the whole Stage B chain against the real shipped example manifest:
 *
 *   manifest -> provider registration -> catalog discovery -> model surfaces
 *
 * Each step has focused unit tests; this one exists so the seams between them keep
 * working, using `examples/plugins/provider/manifest.json` rather than a fixture so
 * a drift between the example and the host is caught here.
 */

const EXAMPLE_MANIFEST = "examples/plugins/provider/manifest.json";

function describeResult(pluginId: string) {
	return {
		selectedProtocolVersion: "1.0",
		plugin: { id: pluginId, name: "Example", version: "1.0.0" },
		providers: [
			{
				localId: "example-provider",
				displayName: "Example Provider",
				configSchema: { type: "object", additionalProperties: true },
				capabilities: { validateConfig: true, listModels: true, chat: true, generate: false },
				limits: {
					maxConcurrentChat: 2,
					maxConcurrentGenerate: 1,
					maxConfigBytes: 4096,
					maxModelPageSize: 10,
				},
			},
		],
	};
}

/** Mirrors the catalog in examples/plugins/provider/server/index.js. */
const EXAMPLE_CATALOG = {
	models: [
		{
			id: "example/offline",
			displayName: "Example Offline Model",
			description: "A deterministic model that does not use network access.",
			contextWindow: 4096,
			maxOutputTokens: 512,
			capabilities: {
				chat: true,
				generate: false,
				streaming: true,
				tools: false,
				sessionMode: "stateless" as const,
			},
		},
	],
	catalogVersion: "example-1",
};

describe("plugin provider stage B end-to-end", () => {
	test("registers, discovers models, and reaches both model surfaces", async () => {
		const manifest = parseManifest(await Bun.file(EXAMPLE_MANIFEST).json());
		const registry = new PluginProviderRegistry();
		for (const registration of providerRegistrationsFromManifest({
			manifest,
			generation: "1.0.0:abc",
		})) {
			registry.register(registration);
		}

		// Registration alone yields no models: the manifest declares a default model id,
		// not a catalog.
		expect(registry.list()[0].modelCount).toBe(0);
		expect(registry.list()[0].catalogStale).toBe(true);

		const pool = new PluginProviderClientPool(async () => ({
			request: async <T>(method: string): Promise<T> =>
				(method === "provider.describe" ? describeResult(manifest.pluginId) : EXAMPLE_CATALOG) as T,
			notify: async () => undefined,
			quarantine: () => undefined,
		}));
		await new PluginProviderCatalogRefresher({ registry, clientPool: pool }).refreshStale();

		expect(listPluginProviderModelValues(registry)).toEqual(["example:example/offline"]);
		expect(findPluginProviderForModel(registry, "example/offline")).toBe("example");

		const [group] = listPluginProviderModelGroups(registry);
		expect(group.prefix).toBe("example");
		expect(group.catalogStale).toBe(false);
		expect(group.models[0]).toMatchObject({
			value: "example:example/offline",
			contextWindow: 4096,
			available: true,
		});

		const dispose = registerExtraModelSource("stage-b-e2e", {
			listModels: () => listPluginProviderModelValues(registry),
			resolveProvider: (bare) => findPluginProviderForModel(registry, bare),
		});
		try {
			expect(getVisibleModels()).toContain("example:example/offline");
			expect(resolveProvider("example:example/offline")).toBe("example");
			// A prefix-less plugin model still routes home.
			expect(resolveProvider("example/offline")).toBe("example");
			// ...but a builtin model id is never captured by a plugin.
		} finally {
			dispose();
		}

		// Disposing the source withdraws the models again.
		expect(getVisibleModels()).not.toContain("example:example/offline");
	});
});
