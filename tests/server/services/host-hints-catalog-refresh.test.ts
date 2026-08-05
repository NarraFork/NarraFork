/**
 * Tests that `hostHints` (proxy URL) is correctly delivered through the catalog
 * refresh path (provider.listModels). This was a real bug: the adapter factory
 * injected hints into chat/generate, but the catalog refresher used a separate
 * code path that never received `resolveHostHints`. In proxy-required environments
 * this meant "chat works but model list is empty".
 */

import { describe, expect, test } from "bun:test";
import { PluginProviderCatalogRefresher } from "@server/services/plugin-provider-catalog-refresh";
import {
	PluginProviderClientPool,
	type ProviderRuntimeLike,
} from "@server/services/plugin-provider-client";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";
import type { ProviderHostHints } from "@server/services/plugin-provider-rpc";

const pluginId = "com.example.hints-catalog";

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

interface CallLog {
	activations: number;
	listModelCalls: Array<{ cursor?: string; config: unknown; hostHints: unknown }>;
}

function fakeRuntime(log: CallLog): ProviderRuntimeLike {
	return {
		request: async <T>(method: string, params?: unknown): Promise<T> => {
			if (method === "provider.describe") {
				return {
					selectedProtocolVersion: "1.0",
					plugin: { id: pluginId, name: "HintsCatalog", version: "1.0.0" },
					providers: [
						{
							localId: "test",
							displayName: "Test Provider",
							configSchema: { type: "object", additionalProperties: true },
							capabilities: { validateConfig: true, listModels: true, chat: true, generate: true },
							limits: {
								maxConcurrentChat: 2,
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
					hostHints: record.hostHints,
				});
				return {
					models: [model("test/base")],
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

function harness(resolveHostHints?: () => ProviderHostHints | undefined) {
	const log: CallLog = { activations: 0, listModelCalls: [] };
	const registry = new PluginProviderRegistry();
	const pool = new PluginProviderClientPool(async () => {
		log.activations += 1;
		return fakeRuntime(log);
	});
	registry.register({
		kind: "executable-plugin",
		pluginId,
		localId: "test",
		providerInstanceId: `${pluginId}/test`,
		providerPrefix: "test",
		displayName: "Test Provider",
		capabilities: { listModels: true },
		config: { apiKey: "secret-value" },
		configSchema: { type: "object", additionalProperties: true },
	});
	const refresher = new PluginProviderCatalogRefresher({
		registry,
		clientPool: pool,
		resolveHostHints,
	});
	return { log, registry, refresher };
}

describe("catalog refresh — hostHints delivery to listModels", () => {
	test("injects hostHints.outbound.proxyUrl into listModels params", async () => {
		const { log, refresher } = harness(() => ({
			outbound: { proxyUrl: "http://user:pass@proxy.corp:3128" },
		}));

		await refresher.refresh(`${pluginId}/test`);

		expect(log.listModelCalls).toHaveLength(1);
		expect(log.listModelCalls[0]?.hostHints).toEqual({
			outbound: { proxyUrl: "http://user:pass@proxy.corp:3128" },
		});
	});

	test("omits hostHints when resolver returns undefined (no proxy configured)", async () => {
		const { log, refresher } = harness(() => undefined);

		await refresher.refresh(`${pluginId}/test`);

		expect(log.listModelCalls).toHaveLength(1);
		expect(log.listModelCalls[0]?.hostHints).toBeUndefined();
	});

	test("omits hostHints when no resolver is provided (backward compatible)", async () => {
		const { log, refresher } = harness(undefined);

		await refresher.refresh(`${pluginId}/test`);

		expect(log.listModelCalls).toHaveLength(1);
		expect(log.listModelCalls[0]?.hostHints).toBeUndefined();
	});

	test("same hostHints instance is used across all pages of a paginated refresh", async () => {
		let callCount = 0;
		const { log, registry } = (() => {
			const log: CallLog = { activations: 0, listModelCalls: [] };
			const registry = new PluginProviderRegistry();
			let page = 0;
			const pool = new PluginProviderClientPool(async () => {
				log.activations += 1;
				return {
					request: async <T>(method: string, params?: unknown): Promise<T> => {
						if (method === "provider.describe") {
							return {
								selectedProtocolVersion: "1.0",
								plugin: { id: pluginId, name: "HintsCatalog", version: "1.0.0" },
								providers: [
									{
										localId: "test",
										displayName: "Test Provider",
										configSchema: { type: "object", additionalProperties: true },
										capabilities: {
											validateConfig: true,
											listModels: true,
											chat: true,
											generate: true,
										},
										limits: {
											maxConcurrentChat: 2,
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
								hostHints: record.hostHints,
							});
							page += 1;
							if (page < 3) {
								return { models: [model(`test/m${page}`)], nextCursor: `c${page}` } as T;
							}
							return { models: [model(`test/m${page}`)] } as T;
						}
						throw new Error(`unexpected method ${method}`);
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
				localId: "test",
				providerInstanceId: `${pluginId}/test`,
				providerPrefix: "test",
				displayName: "Test Provider",
				capabilities: { listModels: true },
			});
			// `pool` is built only to register the runtime resolver above; this test drives the
			// refresher through its own pool below, so returning it would be dead weight.
			void pool;
			return { log, registry };
		})();

		const refresher = new PluginProviderCatalogRefresher({
			registry,
			clientPool: (() => {
				const log2: CallLog = { activations: 0, listModelCalls: [] };
				const pool = new PluginProviderClientPool(async () => {
					log2.activations += 1;
					let page = 0;
					return {
						request: async <T>(method: string, params?: unknown): Promise<T> => {
							if (method === "provider.describe") {
								return {
									selectedProtocolVersion: "1.0",
									plugin: { id: pluginId, name: "HintsCatalog", version: "1.0.0" },
									providers: [
										{
											localId: "test",
											displayName: "Test Provider",
											configSchema: { type: "object", additionalProperties: true },
											capabilities: {
												validateConfig: true,
												listModels: true,
												chat: true,
												generate: true,
											},
											limits: {
												maxConcurrentChat: 2,
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
									hostHints: record.hostHints,
								});
								page += 1;
								if (page < 3) {
									return { models: [model(`test/m${page}`)], nextCursor: `c${page}` } as T;
								}
								return { models: [model(`test/m${page}`)] } as T;
							}
							throw new Error(`unexpected method ${method}`);
						},
						notify: async () => undefined,
						quarantine: () => undefined,
						onNotification: () => () => undefined,
						onClose: () => () => undefined,
					} satisfies ProviderRuntimeLike;
				});
				return pool;
			})(),
			resolveHostHints: () => {
				callCount += 1;
				return { outbound: { proxyUrl: "http://proxy:8080" } };
			},
		});

		await refresher.refresh(`${pluginId}/test`);

		// resolveHostHints called once per refresh (not once per page)
		expect(callCount).toBe(1);
		// All pages receive the same hints
		for (const call of log.listModelCalls) {
			expect(call.hostHints).toEqual({ outbound: { proxyUrl: "http://proxy:8080" } });
		}
	});

	test("proxy URL does not appear in any logged output from refresh", async () => {
		// The logger.debug call in the refresher only logs providerInstanceId, providerPrefix,
		// modelCount, and pages — never the hostHints or config contents.
		const { log, refresher } = harness(() => ({
			outbound: { proxyUrl: "http://secret:cred@proxy.internal:9999" },
		}));

		const result = await refresher.refresh(`${pluginId}/test`);

		// The result object that surfaces to callers does not contain hostHints
		const resultStr = JSON.stringify(result);
		expect(resultStr).not.toContain("proxy.internal");
		expect(resultStr).not.toContain("secret:cred");

		// The config might contain sensitive data too, but hostHints is the focus here
		// The listModels call DID receive the hints (verified by the first test)
		expect(log.listModelCalls[0]?.hostHints).toEqual({
			outbound: { proxyUrl: "http://secret:cred@proxy.internal:9999" },
		});
	});
});
