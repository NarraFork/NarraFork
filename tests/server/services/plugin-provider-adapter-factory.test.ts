import { describe, expect, test } from "bun:test";
import type { JsonValue } from "@server/lib/plugins/protocol";
import { createPluginProviderAdapterFactory } from "@server/services/plugin-provider-adapter-factory";
import type { ProviderRuntimeLike } from "@server/services/plugin-provider-client";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";

/**
 * `entry.createAdapter()` is synchronous and runs while resolving a model, but the
 * plugin process may not be running and starting it is async. The factory therefore
 * hands back an adapter immediately and defers activation to the first
 * `chat()`/`generate()` call.
 *
 * Two properties matter and neither is visible by reading the adapter:
 *
 * - registration (and adapter construction) must not start a plugin process, or a
 *   catalog refresh would spawn every installed plugin;
 * - concurrent first use must activate exactly once and handshake exactly once.
 */

const pluginId = "com.example.lazy";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RuntimeCallLog {
	activations: string[];
	requests: Array<{ method: string; params: unknown }>;
}

function fakeRuntime(log: RuntimeCallLog): ProviderRuntimeLike {
	// The RPC client consumes stream events as notifications, so the fake plugin has
	// to push a terminal `done` for every accepted operation or the adapter waits
	// forever for output.
	const notificationHandlers = new Set<(notification: unknown, bytes?: number) => void>();
	const emitDone = (operationId: string): void => {
		const notification = {
			jsonrpc: "2.0" as const,
			method: "provider.event" as const,
			params: {
				protocolVersion: "1.0",
				operationId,
				seq: 1,
				event: { type: "done", status: "completed", stopReason: "end_turn" },
			},
		};
		// Omit the byte count so the RPC client measures the frame itself; a literal 0
		// is rejected as a frame-limit violation.
		for (const handler of notificationHandlers) handler(notification);
	};
	return {
		request: async <T>(method: string, params?: unknown): Promise<T> => {
			log.requests.push({ method, params });
			if (method === "provider.describe") {
				return {
					selectedProtocolVersion: "1.0",
					plugin: { id: pluginId, name: "Lazy", version: "1.0.0" },
					providers: [
						{
							localId: "lazy",
							displayName: "Lazy Provider",
							defaultModelId: "lazy/base",
							configSchema: { type: "object", additionalProperties: true },
							capabilities: { validateConfig: true, listModels: true, chat: true, generate: true },
							limits: {
								maxConcurrentChat: 2,
								maxConcurrentGenerate: 1,
								maxConfigBytes: 4096,
								maxModelPageSize: 20,
							},
						},
					],
				} as T;
			}
			// Operation starts must echo the client-generated operationId, otherwise the
			// RPC client rejects the accept as an invalid response.
			const operationId = isRecord(params) ? String(params.operationId ?? "") : "";
			// The event must land after this accept response has been processed; the RPC
			// client rejects any event that arrives before the operation is accepted.
			setTimeout(() => emitDone(operationId), 0);
			return { operationId, accepted: true } as T;
		},
		notify: async () => undefined,
		quarantine: () => undefined,
		onNotification: (handler: (notification: never, bodyBytes?: number) => void) => {
			notificationHandlers.add(handler as (notification: unknown, bytes?: number) => void);
			return () =>
				notificationHandlers.delete(handler as (notification: unknown, bytes?: number) => void);
		},
		onClose: () => () => undefined,
	};
}

function registryWithLazyProvider(log: RuntimeCallLog, options: { failActivation?: boolean } = {}) {
	const registry = new PluginProviderRegistry();
	registry.setRemoteProviderAdapterFactory(
		createPluginProviderAdapterFactory({
			resolveRuntime: async (id) => {
				log.activations.push(id);
				if (options.failActivation) throw new Error("runtime refused to start");
				return fakeRuntime(log);
			},
		}),
	);
	registry.register({
		kind: "executable-plugin",
		pluginId,
		localId: "lazy",
		providerInstanceId: `${pluginId}/lazy`,
		providerPrefix: "lazy",
		displayName: "Lazy Provider",
		defaultModelId: "lazy/base",
		capabilities: { chat: true, generate: true, mayLeakXmlToolCalls: true },
		models: [
			{
				id: "lazy/base",
				displayName: "Lazy Base",
				capabilities: {
					chat: true,
					generate: true,
					streaming: true,
					tools: false,
					sessionMode: "stateless",
				},
			},
		],
	});
	return registry;
}

function chatParams(): Parameters<
	NonNullable<ReturnType<PluginProviderRegistry["resolveProvider"]>["adapter"]>["chat"]
>[0] {
	return {
		conversationId: "conv-1",
		content: "hi",
		model: "lazy:lazy/base",
		cwd: "/tmp",
		history: [],
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
	};
}

describe("plugin provider adapter factory", () => {
	test("builds an adapter without starting the plugin runtime", () => {
		const log: RuntimeCallLog = { activations: [], requests: [] };
		const registry = registryWithLazyProvider(log);

		const adapter = registry.resolveProvider("lazy:lazy/base").adapter;

		expect(adapter).toBeDefined();
		// The whole point of deferring: no process was spawned to resolve a model.
		expect(log.activations).toEqual([]);
		expect(log.requests).toEqual([]);
	});

	test("carries mayLeakXmlToolCalls through to the Agent Loop", () => {
		const log: RuntimeCallLog = { activations: [], requests: [] };
		const registry = registryWithLazyProvider(log);

		const adapter = registry.resolveProvider("lazy:lazy/base").adapter;

		// The loop reads this to decide whether to run XML tool-call recovery.
		expect(adapter?.mayLeakXmlToolCalls).toBe(true);
	});

	test("activates and handshakes once on first use, even under concurrency", async () => {
		const log: RuntimeCallLog = { activations: [], requests: [] };
		const registry = registryWithLazyProvider(log);
		const adapter = registry.resolveProvider("lazy:lazy/base").adapter;
		if (!adapter) throw new Error("adapter was not created");

		// Two narrators resolving the same provider at once must not race into two
		// activations or two handshakes.
		await Promise.all([adapter.chat(chatParams()).next(), adapter.chat(chatParams()).next()]);

		expect(log.activations).toEqual([pluginId]);
		const describes = log.requests.filter((call) => call.method === "provider.describe");
		expect(describes).toHaveLength(1);
	});

	test("reuses the activated runtime on later calls", async () => {
		const log: RuntimeCallLog = { activations: [], requests: [] };
		const registry = registryWithLazyProvider(log);
		const adapter = registry.resolveProvider("lazy:lazy/base").adapter;
		if (!adapter) throw new Error("adapter was not created");

		await adapter.chat(chatParams()).next();
		await adapter.chat(chatParams()).next();

		expect(log.activations).toEqual([pluginId]);
	});

	test("surfaces activation failure to the caller", async () => {
		const log: RuntimeCallLog = { activations: [], requests: [] };
		const registry = registryWithLazyProvider(log, { failActivation: true });
		const adapter = registry.resolveProvider("lazy:lazy/base").adapter;
		if (!adapter) throw new Error("adapter was not created");

		await expect(adapter.chat(chatParams()).next()).rejects.toThrow("runtime refused to start");
	});

	test("retries activation after an earlier failure", async () => {
		const log: RuntimeCallLog = { activations: [], requests: [] };
		let fail = true;
		const registry = new PluginProviderRegistry();
		registry.setRemoteProviderAdapterFactory(
			createPluginProviderAdapterFactory({
				resolveRuntime: async (id) => {
					log.activations.push(id);
					if (fail) throw new Error("not yet");
					return fakeRuntime(log);
				},
			}),
		);
		registry.register({
			kind: "executable-plugin",
			pluginId,
			localId: "lazy",
			providerInstanceId: `${pluginId}/lazy`,
			providerPrefix: "lazy",
			displayName: "Lazy Provider",
			defaultModelId: "lazy/base",
		});
		const adapter = registry.resolveProvider("lazy:lazy/base").adapter;
		if (!adapter) throw new Error("adapter was not created");

		await expect(adapter.chat(chatParams()).next()).rejects.toThrow("not yet");
		// A failed activation must not latch: the plugin may simply have been starting.
		fail = false;
		await adapter.chat(chatParams()).next();

		expect(log.activations).toEqual([pluginId, pluginId]);
	});

	test("applies a factory installed after registration", () => {
		const log: RuntimeCallLog = { activations: [], requests: [] };
		const registry = new PluginProviderRegistry();
		registry.register({
			kind: "executable-plugin",
			pluginId,
			localId: "lazy",
			providerInstanceId: `${pluginId}/lazy`,
			providerPrefix: "lazy",
			displayName: "Lazy Provider",
			defaultModelId: "lazy/base",
		});

		// Registration happens during a catalog refresh, which can precede the runtime
		// wiring; the registry singleton is built at module load. Until a factory is
		// installed, resolution still succeeds but yields no adapter.
		expect(registry.resolveProvider("lazy:lazy/base").adapter).toBeUndefined();
		expect(() => registry.get(`${pluginId}/lazy`)?.createAdapter()).toThrow(
			"No adapter factory is registered",
		);

		registry.setRemoteProviderAdapterFactory(
			createPluginProviderAdapterFactory({
				resolveRuntime: async (id) => {
					log.activations.push(id);
					return fakeRuntime(log);
				},
			}),
		);

		expect(registry.resolveProvider("lazy:lazy/base").adapter).toBeDefined();
	});

	test("rejects non-plugin entries", () => {
		const factory = createPluginProviderAdapterFactory({
			resolveRuntime: async () => fakeRuntime({ activations: [], requests: [] }),
		});
		const registry = new PluginProviderRegistry();
		const entry = registry.register({
			kind: "builtin",
			localId: "builtin-demo",
			providerInstanceId: "builtin/demo",
			providerPrefix: "bidemo",
			displayName: "Builtin Demo",
		});

		expect(() =>
			factory({
				entry,
				config: {} as Readonly<Record<string, JsonValue>>,
				modelCatalog: new Map(),
			}),
		).toThrow("not an executable plugin provider");
	});
});
