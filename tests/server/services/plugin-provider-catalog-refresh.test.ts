import { describe, expect, test } from "bun:test";
import { eventBus, type NarraForkEvent } from "@server/lib/event-bus";
import { PluginProviderCatalogRefresher } from "@server/services/plugin-provider-catalog-refresh";
import {
	PluginProviderClientPool,
	type ProviderRuntimeLike,
} from "@server/services/plugin-provider-client";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";

/**
 * Registration only knows the manifest, which carries a `defaultModelId` at most.
 * The real catalog arrives over `provider.listModels`, so until a refresh runs a
 * provider is registered with an empty catalog the registry reports as stale.
 *
 * The properties worth pinning are the ones a well-behaved plugin never exercises:
 * pagination termination, failure isolation, and not activating plugins needlessly.
 */

const pluginId = "com.example.catalog";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function model(id: string) {
	return {
		id,
		displayName: id.toUpperCase(),
		capabilities: {
			chat: true,
			generate: true,
			streaming: true,
			tools: false,
			sessionMode: "stateless" as const,
		},
	};
}

interface FakePluginOptions {
	/** Successive listModels responses, consumed in order. */
	pages?: Array<{
		models: ReturnType<typeof model>[];
		nextCursor?: string;
		catalogVersion?: string;
		stale?: boolean;
	}>;
	failListModels?: string;
}

interface CallLog {
	activations: number;
	listModelCalls: Array<{ cursor?: string; config: unknown }>;
}

function fakeRuntime(log: CallLog, options: FakePluginOptions): ProviderRuntimeLike {
	let page = 0;
	return {
		request: async <T>(method: string, params?: unknown): Promise<T> => {
			if (method === "provider.describe") {
				return {
					selectedProtocolVersion: "1.0",
					plugin: { id: pluginId, name: "Catalog", version: "1.0.0" },
					providers: [
						{
							localId: "cat",
							displayName: "Catalog Provider",
							configSchema: { type: "object", additionalProperties: true },
							capabilities: { validateConfig: true, listModels: true, chat: true, generate: true },
							limits: {
								maxConcurrentChat: 1,
								maxConcurrentGenerate: 1,
								maxConfigBytes: 4096,
								maxModelPageSize: 200,
							},
						},
					],
				} as T;
			}
			if (method === "provider.listModels") {
				const record = isRecord(params) ? params : {};
				log.listModelCalls.push({
					cursor: typeof record.cursor === "string" ? record.cursor : undefined,
					config: record.config,
				});
				if (options.failListModels) throw new Error(options.failListModels);
				const current = options.pages?.[Math.min(page, (options.pages.length ?? 1) - 1)];
				page += 1;
				return {
					models: current?.models ?? [],
					...(current?.nextCursor ? { nextCursor: current.nextCursor } : {}),
					...(current?.catalogVersion ? { catalogVersion: current.catalogVersion } : {}),
					...(current?.stale === undefined ? {} : { stale: current.stale }),
				} as T;
			}
			throw new Error(`unexpected method ${method}`);
		},
		notify: async () => undefined,
		quarantine: () => undefined,
		onNotification: () => () => undefined,
		onClose: () => () => undefined,
	};
}

function harness(options: FakePluginOptions = {}) {
	const log: CallLog = { activations: 0, listModelCalls: [] };
	const registry = new PluginProviderRegistry();
	const pool = new PluginProviderClientPool(async () => {
		log.activations += 1;
		return fakeRuntime(log, options);
	});
	registry.register({
		kind: "executable-plugin",
		pluginId,
		localId: "cat",
		providerInstanceId: `${pluginId}/cat`,
		providerPrefix: "cat",
		displayName: "Catalog Provider",
		capabilities: { listModels: true },
		config: { apiKey: "secret-value" },
		configSchema: { type: "object", additionalProperties: true },
	});
	const refresher = new PluginProviderCatalogRefresher({ registry, clientPool: pool });
	return { log, registry, refresher, pool };
}

describe("plugin provider catalog refresh", () => {
	test("pulls the catalog into the registry and clears the stale flag", async () => {
		const { log, registry, refresher } = harness({
			pages: [{ models: [model("cat/a"), model("cat/b")], catalogVersion: "v7" }],
		});
		// A freshly registered provider has no models and is reported stale.
		expect(registry.get(`${pluginId}/cat`)?.modelCount).toBe(0);
		expect(registry.get(`${pluginId}/cat`)?.catalogStale).toBe(true);

		const result = await refresher.refresh(`${pluginId}/cat`);

		expect(result.modelCount).toBe(2);
		expect(result.catalogVersion).toBe("v7");
		expect(result.stale).toBe(false);
		const entry = registry.get(`${pluginId}/cat`);
		expect(entry?.modelCount).toBe(2);
		expect(entry?.catalogStale).toBe(false);
		expect(entry?.getModel("cat/a")?.displayName).toBe("CAT/A");
		expect(log.activations).toBe(1);
	});

	test("publishes a bounded invalidation only after the complete catalog is available", async () => {
		const options: FakePluginOptions = {
			pages: [{ models: [model("cat/a")], nextCursor: "next" }, { models: [model("cat/b")] }],
		};
		const { registry, refresher } = harness(options);
		const seen: Array<{ event: NarraForkEvent; models: string[] }> = [];
		const onChanged = (event: NarraForkEvent) => {
			seen.push({
				event,
				models:
					registry
						.get(`${pluginId}/cat`)
						?.getModels()
						.map((item) => item.id) ?? [],
			});
		};
		eventBus.on("plugin:provider_models_changed", onChanged);
		try {
			await refresher.refresh(`${pluginId}/cat`);
			expect(seen).toEqual([
				{
					event: {
						type: "plugin:provider_models_changed",
						pluginId,
						providerInstanceId: `${pluginId}/cat`,
					},
					models: ["cat/a", "cat/b"],
				},
			]);
			options.failListModels = "unreachable";
			await refresher.refresh(`${pluginId}/cat`);
			expect(seen).toHaveLength(1); // Failed discovery is not advertised as a new catalog.
		} finally {
			eventBus.off("plugin:provider_models_changed", onChanged);
		}
	});

	test("forwards the stored provider config so credentialed discovery works", async () => {
		const { log, refresher } = harness({ pages: [{ models: [model("cat/a")] }] });

		await refresher.refresh(`${pluginId}/cat`);

		// Without config a plugin needing an API key could not enumerate models.
		expect(log.listModelCalls[0]?.config).toEqual({ apiKey: "secret-value" });
	});

	test("follows pagination cursors", async () => {
		const { log, registry, refresher } = harness({
			pages: [
				{ models: [model("cat/a")], nextCursor: "c1" },
				{ models: [model("cat/b")], nextCursor: "c2" },
				{ models: [model("cat/c")] },
			],
		});

		const result = await refresher.refresh(`${pluginId}/cat`);

		expect(result.modelCount).toBe(3);
		expect(registry.get(`${pluginId}/cat`)?.modelCount).toBe(3);
		expect(log.listModelCalls.map((call) => call.cursor)).toEqual([undefined, "c1", "c2"]);
	});

	test("stops when a plugin repeats the same cursor, and dedupes models", async () => {
		// A plugin that always returns the same cursor would otherwise loop to the page
		// cap. It also re-sends the same model, which the registry would reject as a
		// duplicate id — that must not wipe the catalog, so the refresher dedupes.
		const { log, registry, refresher } = harness({
			pages: [{ models: [model("cat/a")], nextCursor: "stuck" }],
		});

		const result = await refresher.refresh(`${pluginId}/cat`);

		expect(log.listModelCalls).toHaveLength(2);
		expect(result.error).toBeUndefined();
		expect(result.modelCount).toBe(1);
		expect(registry.get(`${pluginId}/cat`)?.modelCount).toBe(1);
	});

	test("respects the page cap for an endlessly paginating plugin", async () => {
		const log: CallLog = { activations: 0, listModelCalls: [] };
		const registry = new PluginProviderRegistry();
		let counter = 0;
		const pool = new PluginProviderClientPool(async () => {
			log.activations += 1;
			return {
				request: async <T>(method: string, params?: unknown): Promise<T> => {
					if (method === "provider.describe") {
						return {
							selectedProtocolVersion: "1.0",
							plugin: { id: pluginId, name: "Catalog", version: "1.0.0" },
							providers: [
								{
									localId: "cat",
									displayName: "Catalog Provider",
									configSchema: { type: "object", additionalProperties: true },
									capabilities: {
										validateConfig: true,
										listModels: true,
										chat: true,
										generate: true,
									},
									limits: {
										maxConcurrentChat: 1,
										maxConcurrentGenerate: 1,
										maxConfigBytes: 4096,
										maxModelPageSize: 200,
									},
								},
							],
						} as T;
					}
					const record = isRecord(params) ? params : {};
					log.listModelCalls.push({
						cursor: typeof record.cursor === "string" ? record.cursor : undefined,
						config: record.config,
					});
					counter += 1;
					return {
						models: [model(`cat/${counter}`)],
						nextCursor: `cursor-${counter}`,
					} as T;
				},
				notify: async () => undefined,
				quarantine: () => undefined,
				onNotification: () => () => undefined,
				onClose: () => () => undefined,
			} satisfies ProviderRuntimeLike;
		});
		registry.register({
			kind: "executable-plugin",
			pluginId,
			localId: "cat",
			providerInstanceId: `${pluginId}/cat`,
			providerPrefix: "cat",
			displayName: "Catalog Provider",
			capabilities: { listModels: true },
		});
		const refresher = new PluginProviderCatalogRefresher({
			registry,
			clientPool: pool,
			maxPages: 3,
		});

		const result = await refresher.refresh(`${pluginId}/cat`);

		expect(log.listModelCalls).toHaveLength(3);
		expect(result.modelCount).toBe(3);
	});

	test("keeps the previous catalog and marks it stale when discovery fails", async () => {
		const { registry, refresher } = harness({ pages: [{ models: [model("cat/a")] }] });
		await refresher.refresh(`${pluginId}/cat`);
		expect(registry.get(`${pluginId}/cat`)?.modelCount).toBe(1);

		// Simulate the upstream going away on a later refresh.
		const failing = new PluginProviderCatalogRefresher({
			registry,
			clientPool: new PluginProviderClientPool(async () => {
				throw new Error("plugin is unreachable");
			}),
		});
		const result = await failing.refresh(`${pluginId}/cat`);

		expect(result.error).toContain("plugin is unreachable");
		expect(result.stale).toBe(true);
		// A working model list must survive a failed refresh.
		expect(registry.get(`${pluginId}/cat`)?.modelCount).toBe(1);
		expect(registry.get(`${pluginId}/cat`)?.catalogStale).toBe(true);
	});

	test("collapses concurrent refreshes for the same provider", async () => {
		const { log, refresher } = harness({ pages: [{ models: [model("cat/a")] }] });

		await Promise.all([refresher.refresh(`${pluginId}/cat`), refresher.refresh(`${pluginId}/cat`)]);

		expect(log.activations).toBe(1);
		expect(log.listModelCalls).toHaveLength(1);
	});

	test("skips providers that do not support model discovery", async () => {
		const log: CallLog = { activations: 0, listModelCalls: [] };
		const registry = new PluginProviderRegistry();
		const pool = new PluginProviderClientPool(async () => {
			log.activations += 1;
			return fakeRuntime(log, {});
		});
		registry.register({
			kind: "executable-plugin",
			pluginId,
			localId: "fixed",
			providerInstanceId: `${pluginId}/fixed`,
			providerPrefix: "fixed",
			displayName: "Fixed Catalog Provider",
			capabilities: { listModels: false },
			models: [model("fixed/only")],
		});
		const refresher = new PluginProviderCatalogRefresher({ registry, clientPool: pool });

		const result = await refresher.refresh(`${pluginId}/fixed`);

		expect(result.skipped).toBe(true);
		// A manifest-only catalog must not cause the plugin to be started.
		expect(log.activations).toBe(0);
		expect(registry.get(`${pluginId}/fixed`)?.modelCount).toBe(1);
	});

	test("refreshStale only touches stale, available, discoverable providers", async () => {
		const { log, registry, refresher } = harness({ pages: [{ models: [model("cat/a")] }] });
		// A second provider that is already fresh must not be re-fetched.
		registry.register({
			kind: "executable-plugin",
			pluginId,
			localId: "fresh",
			providerInstanceId: `${pluginId}/fresh`,
			providerPrefix: "fresh",
			displayName: "Fresh Provider",
			capabilities: { listModels: true },
			models: [model("fresh/a")],
			catalogStale: false,
		});

		const results = await refresher.refreshStale();

		expect(results.map((item) => item.providerPrefix)).toEqual(["cat"]);
		expect(log.listModelCalls).toHaveLength(1);
	});

	test("refreshStale skips disabled providers", async () => {
		const { log, registry, refresher } = harness({ pages: [{ models: [model("cat/a")] }] });
		registry.disablePlugin(pluginId, "Plugin is disabled");

		const results = await refresher.refreshStale();

		expect(results).toEqual([]);
		expect(log.activations).toBe(0);
	});

	test("rejects an unknown provider reference", async () => {
		const { refresher } = harness();
		await expect(refresher.refresh("nope")).rejects.toThrow("not registered");
	});
});
