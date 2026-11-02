import { describe, expect, test } from "bun:test";
import { BalanceProbeRequestError } from "@server/lib/provider-balance-adapters";
import type { CustomApiProviderConfig } from "@server/lib/settings";
import {
	type ApikeyQuotaEngineOptions,
	createApikeyQuotaEngine,
	type QuotaPluginActivator,
	type QuotaToolInvoker,
} from "@server/services/apikey-quota-plugin-engine";

const config = (): CustomApiProviderConfig => ({
	id: "relay1",
	name: "relay1",
	prefix: "relay1",
	baseUrl: "https://relay.example.com/v1",
	protocol: "completions-compatible",
	apiKey: "sk-secret",
	defaultModel: "m",
	extraHeaders: { "X-Tenant": "t1" },
	userAgentMode: "narrafork",
	proxy: { mode: "custom", url: "http://127.0.0.1:7890" },
	tlsRejectUnauthorized: false,
});

const signal = () => AbortSignal.timeout(5_000);

const okProbe = () => ({
	status: "ok",
	adapter: "sub2api",
	root: "https://relay.example.com",
	balance: { scope: "wallet", unlimited: false, amounts: [{ unit: "USD", remaining: 12.5 }] },
});

const okRefresh = () => ({
	status: "ok",
	balance: { scope: "wallet", unlimited: false, amounts: [{ unit: "USD", remaining: 3 }] },
});

interface Harness {
	invocations: Array<{ fullId: string; input: Record<string, unknown>; options?: unknown }>;
	activations: string[];
	fallbackCalls: string[];
}

/**
 * A fake tool registry plus a fake activator.
 *
 * The registry is the *only* way the engine may reach the plugin, so this boundary is what the
 * decision table must be proven against: the engine owns no process and no connection.
 */
function setup(
	respond: (input: Record<string, unknown>) => unknown,
	options: {
		activateThrows?: Error;
		invokeThrows?: Error;
		output?: unknown;
		isError?: boolean;
		noActivator?: boolean;
	} = {},
) {
	const state: Harness = { invocations: [], activations: [], fallbackCalls: [] };
	const tools: QuotaToolInvoker = {
		invoke: async (fullId, input, invocationOptions) => {
			state.invocations.push({
				fullId,
				input: input as Record<string, unknown>,
				options: invocationOptions,
			});
			if (options.invokeThrows) throw options.invokeThrows;
			const output = options.output ?? JSON.stringify(respond(input as Record<string, unknown>));
			return {
				output: typeof output === "string" ? output : JSON.stringify(output),
				isError: options.isError,
			};
		},
	};
	const activator: QuotaPluginActivator = {
		activate: async (pluginId) => {
			state.activations.push(pluginId);
			if (options.activateThrows) throw options.activateThrows;
		},
	};
	const engineOptions: ApikeyQuotaEngineOptions = {
		tools,
		...(options.noActivator ? {} : { activator }),
		fallback: {
			id: "fallback",
			probe: async () => {
				state.fallbackCalls.push("probe");
				return {
					adapter: "new-api" as const,
					root: "https://relay.example.com",
					balance: { scope: "key" as const, unlimited: true, amounts: [] },
				};
			},
			refresh: async () => {
				state.fallbackCalls.push("refresh");
				return { scope: "key" as const, unlimited: true, amounts: [] };
			},
		},
		onDiagnostic: () => {},
	};
	return { state, engine: createApikeyQuotaEngine(engineOptions) };
}

describe("apikey-quota builtin engine", () => {
	test("a probe activates the plugin and goes through the shared tool registry", async () => {
		const { state, engine } = setup(okProbe);

		const found = await engine.probe({ config: config(), signal: signal() });

		expect(found).toEqual({
			adapter: "sub2api",
			root: "https://relay.example.com",
			balance: { scope: "wallet", unlimited: false, amounts: [{ unit: "USD", remaining: 12.5 }] },
		});
		// Activation is what registers the tool, and it carries the same activation event the
		// manifest declares for tools so the plugin treats it as a normal tool activation.
		expect(state.activations).toEqual(["com.narrafork.apikey-quota"]);
		expect(state.invocations).toHaveLength(1);
		expect(state.invocations[0]?.fullId).toBe("com.narrafork.apikey-quota/query-balance");
		// Background principal is what makes this a host-internal call rather than a narrator one.
		expect(state.invocations[0]?.options).toMatchObject({
			invocation: { kind: "plugin_background", source: "internal" },
		});
		// The bundled adapters must not run when the plugin answered.
		expect(state.fallbackCalls).toEqual([]);
	});

	test("the connection facts the plugin needs are forwarded", async () => {
		const { state, engine } = setup(okProbe);

		await engine.probe({ config: config(), signal: signal(), requestTimeoutMs: 4_000 });

		expect(state.invocations[0]?.input).toMatchObject({
			mode: "probe",
			baseUrl: "https://relay.example.com/v1",
			apiKey: "sk-secret",
			headers: { "X-Tenant": "t1" },
			proxy: "http://127.0.0.1:7890",
			tlsRejectUnauthorized: false,
			timeoutMs: 4_000,
		});
	});

	test("unsupported is authoritative and does not probe the bundled path", async () => {
		const { state, engine } = setup(() => ({ status: "unsupported" }));

		await expect(engine.probe({ config: config(), signal: signal() })).resolves.toBeNull();
		expect(state.fallbackCalls).toEqual([]);
	});

	test("failed becomes the existing typed probe error", async () => {
		const { state, engine } = setup(() => ({ status: "failed", kind: "unsupported" }));

		const error = await engine
			.probe({ config: config(), signal: signal() })
			.catch((thrown) => thrown);
		expect(error).toBeInstanceOf(BalanceProbeRequestError);
		expect(error.kind).toBe("unsupported");
		expect(state.fallbackCalls).toEqual([]);
	});

	test("a probe answer without adapter/root falls back", async () => {
		const { state, engine } = setup(() => ({ status: "ok", balance: okProbe().balance }));

		await engine.probe({ config: config(), signal: signal() });

		expect(state.fallbackCalls).toEqual(["probe"]);
	});

	test("an unregistered tool falls back to the bundled adapters", async () => {
		const { state, engine } = setup(okProbe, {
			invokeThrows: Object.assign(new Error("Unknown plugin tool"), { code: "NOT_FOUND" }),
		});

		await engine.probe({ config: config(), signal: signal() });

		expect(state.fallbackCalls).toEqual(["probe"]);
	});

	test("a disabled plugin is a deterministic failure, not a fallback", async () => {
		const { state, engine } = setup(okProbe, {
			activateThrows: Object.assign(new Error("Plugin must be enabled"), {
				code: "PLUGIN_NOT_ENABLED",
			}),
		});

		const error = await engine
			.probe({ config: config(), signal: signal() })
			.catch((thrown) => thrown);

		expect(error).toBeInstanceOf(BalanceProbeRequestError);
		expect(error.kind).toBe("plugin_disabled");
		// The plugin owns the capability: answering from the bundled adapters would keep
		// serving quota queries the administrator switched off.
		expect(state.fallbackCalls).toEqual([]);
		expect(state.invocations).toEqual([]);
	});

	test("a plugin disabled between activation and the call is recognised too", async () => {
		const { state, engine } = setup(okProbe, {
			invokeThrows: Object.assign(new Error("Plugin disabled"), { code: "PLUGIN_DISABLED" }),
		});

		const error = await engine
			.probe({ config: config(), signal: signal() })
			.catch((thrown) => thrown);

		expect(error.kind).toBe("plugin_disabled");
		expect(state.invocations).toHaveLength(1);
		expect(state.fallbackCalls).toEqual([]);
	});

	test("refresh reports a disabled plugin the same way", async () => {
		const { state, engine } = setup(okRefresh, {
			activateThrows: Object.assign(new Error("Plugin must be enabled"), {
				code: "PLUGIN_NOT_ENABLED",
			}),
		});

		const error = await engine
			.refresh({
				config: config(),
				signal: signal(),
				adapter: "sub2api",
				root: "https://relay.example.com",
			})
			.catch((thrown) => thrown);

		expect(error.kind).toBe("plugin_disabled");
		expect(state.fallbackCalls).toEqual([]);
	});

	test("an enabled plugin that fails for another reason still falls back", async () => {
		const { state, engine } = setup(okProbe, { activateThrows: new Error("activation failed") });

		await engine.probe({ config: config(), signal: signal() });

		expect(state.invocations).toEqual([]);
		expect(state.fallbackCalls).toEqual(["probe"]);
	});

	test("output that does not match the contract falls back", async () => {
		const { state, engine } = setup(okProbe, { output: { status: "nonsense" } });

		await engine.probe({ config: config(), signal: signal() });

		expect(state.fallbackCalls).toEqual(["probe"]);
	});

	test("an error result from the tool falls back", async () => {
		const { state, engine } = setup(okProbe, { output: "boom", isError: true });

		await engine.probe({ config: config(), signal: signal() });

		expect(state.fallbackCalls).toEqual(["probe"]);
	});

	test("refresh returns the plugin balance", async () => {
		const { state, engine } = setup(okRefresh);

		const balance = await engine.refresh({
			config: config(),
			signal: signal(),
			adapter: "sub2api",
			root: "https://relay.example.com",
		});

		expect(balance).toMatchObject({ scope: "wallet" });
		expect(state.invocations[0]?.input).toMatchObject({
			mode: "refresh",
			adapter: "sub2api",
			root: "https://relay.example.com",
		});
		expect(state.fallbackCalls).toEqual([]);
	});

	test("refresh reports unsupported and failed the same way as probe", async () => {
		const unsupported = setup(() => ({ status: "unsupported" }));
		await expect(
			unsupported.engine.refresh({
				config: config(),
				signal: signal(),
				adapter: "sub2api",
				root: "https://relay.example.com",
			}),
		).rejects.toBeInstanceOf(BalanceProbeRequestError);

		const failed = setup(() => ({ status: "failed", kind: "transient" }));
		const error = await failed.engine
			.refresh({
				config: config(),
				signal: signal(),
				adapter: "sub2api",
				root: "https://relay.example.com",
			})
			.catch((thrown) => thrown);
		expect(error.kind).toBe("transient");
	});

	test("an injected fetch runs in-process instead of crossing the boundary", async () => {
		const { state, engine } = setup(okProbe);

		await engine.probe({
			config: config(),
			signal: signal(),
			fetch: (async () => new Response("{}")) as unknown as typeof fetch,
		});

		// The seam cannot be serialized into a child process, so it never reaches the registry.
		expect(state.invocations).toEqual([]);
		expect(state.fallbackCalls).toEqual(["probe"]);
	});

	test("without an activator the engine still falls back safely", async () => {
		const { state, engine } = setup(okProbe, { noActivator: true });

		await engine.probe({ config: config(), signal: signal() });

		expect(state.invocations).toHaveLength(1);
		expect(state.activations).toEqual([]);
	});
});
