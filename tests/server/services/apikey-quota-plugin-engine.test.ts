import { describe, expect, test } from "bun:test";
import { BalanceProbeRequestError } from "@server/lib/provider-balance-adapters";
import type { CustomApiProviderConfig } from "@server/lib/settings";
import {
	type ApikeyQuotaEngineOptions,
	createApikeyQuotaEngine,
	type QuotaPluginRuntime,
} from "@server/services/apikey-quota-plugin-engine";
import { APIKEY_QUOTA_TOOL_ID } from "@shared/apikey-quota-plugin";

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

const okProbe = () =>
	JSON.stringify({
		status: "ok",
		adapter: "sub2api",
		root: "https://relay.example.com",
		balance: { scope: "wallet", unlimited: false, amounts: [{ unit: "USD", remaining: 12.5 }] },
	});

interface Harness {
	calls: Array<{ method: string; params: Record<string, unknown> }>;
	fallbackCalls: string[];
	starts: number;
	shutdowns: number;
}

/**
 * A fake plugin process plus a fake bundled engine. The runtime boundary is exactly what
 * the real child process provides (`start`/`request`/`shutdown`), so the engine's decision
 * table is covered without spawning anything.
 */
function setup(
	respond: (input: Record<string, unknown>) => unknown,
	options: {
		enabled?: boolean;
		startThrows?: Error;
		requestThrows?: Error;
		skipRuntime?: boolean;
	} = {},
) {
	const state: Harness = { calls: [], fallbackCalls: [], starts: 0, shutdowns: 0 };
	const runtime: QuotaPluginRuntime = {
		start: async () => {
			state.starts += 1;
			if (options.startThrows) throw options.startThrows;
		},
		request: async <T = unknown>(method: string, params?: unknown): Promise<T> => {
			state.calls.push({ method, params: params as Record<string, unknown> });
			if (options.requestThrows) throw options.requestThrows;
			const input = (params as { input?: Record<string, unknown> })?.input ?? {};
			return { output: JSON.stringify(respond(input)) } as T;
		},
		shutdown: async () => {
			state.shutdowns += 1;
		},
	};
	let enabled = options.enabled ?? true;
	const engineOptions: ApikeyQuotaEngineOptions = {
		isEnabled: () => enabled,
		// `undefined` models a host where the package is not present.
		createRuntime: options.skipRuntime
			? () => undefined as unknown as QuotaPluginRuntime
			: () => runtime,
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
	const engine = createApikeyQuotaEngine(engineOptions);
	return {
		state,
		engine,
		setEnabled: (value: boolean) => {
			enabled = value;
		},
	};
}

describe("apikey-quota builtin engine", () => {
	test("is enabled by default, so a probe goes through the plugin", async () => {
		const { state, engine } = setup(() => JSON.parse(okProbe()));

		const found = await engine.probe({ config: config(), signal: signal() });

		expect(found).toEqual({
			adapter: "sub2api",
			root: "https://relay.example.com",
			balance: { scope: "wallet", unlimited: false, amounts: [{ unit: "USD", remaining: 12.5 }] },
		});
		expect(state.starts).toBe(1);
		expect(state.calls[0]?.method).toBe("tools.invoke");
		expect(state.calls[0]?.params).toMatchObject({ contributionId: APIKEY_QUOTA_TOOL_ID });
		// The bundled adapters must not run when the plugin answered.
		expect(state.fallbackCalls).toEqual([]);
	});

	test("reuses one plugin process across probes", async () => {
		const { state, engine } = setup(() => JSON.parse(okProbe()));

		await engine.probe({ config: config(), signal: signal() });
		await engine.probe({ config: config(), signal: signal() });

		expect(state.starts).toBe(1);
		expect(state.calls).toHaveLength(2);
	});

	test("falls back to the bundled adapters once the user turns the switch off", async () => {
		const { state, engine, setEnabled } = setup(() => JSON.parse(okProbe()));

		await engine.probe({ config: config(), signal: signal() });
		expect(state.calls).toHaveLength(1);

		setEnabled(false);
		const found = await engine.probe({ config: config(), signal: signal() });

		// No error surfaces, the same DTO comes back, and the plugin is not consulted.
		expect(found?.adapter).toBe("new-api");
		expect(state.calls).toHaveLength(1);
		expect(state.fallbackCalls).toEqual(["probe"]);
		// The process is stopped as soon as the switch is read.
		expect(state.shutdowns).toBe(1);
	});

	test("starts disabled when the setting is off and never touches the plugin", async () => {
		const { state, engine } = setup(() => JSON.parse(okProbe()), { enabled: false });

		await engine.probe({ config: config(), signal: signal() });

		expect(state.starts).toBe(0);
		expect(state.calls).toEqual([]);
		expect(state.fallbackCalls).toEqual(["probe"]);
	});

	test("forwards the connection facts the plugin needs, and no more", async () => {
		const { state, engine } = setup(() => ({ status: "unsupported" }));

		await engine.probe({ config: config(), signal: signal() });

		expect(state.calls[0]?.params).toMatchObject({
			contributionId: APIKEY_QUOTA_TOOL_ID,
			input: {
				mode: "probe",
				baseUrl: "https://relay.example.com/v1",
				apiKey: "sk-secret",
				headers: { "X-Tenant": "t1" },
				// `config.proxy` is an override policy; the plugin must receive a resolved URL,
				// otherwise it would silently ignore a corporate proxy after the switch.
				proxy: "http://127.0.0.1:7890",
				tlsRejectUnauthorized: false,
			},
		});
		const input = (state.calls[0]?.params as { input: Record<string, unknown> }).input;
		expect(typeof input.userAgent).toBe("string");
		expect(input).not.toHaveProperty("id");
		expect(input).not.toHaveProperty("defaultModel");
	});

	test("treats 'unsupported' as authoritative and still skips the bundled path", async () => {
		const { state, engine } = setup(() => ({ status: "unsupported" }));

		await expect(engine.probe({ config: config(), signal: signal() })).resolves.toBeNull();
		expect(state.fallbackCalls).toEqual([]);
	});

	test("maps a plugin 'failed' answer onto the existing transient error", async () => {
		const { state, engine } = setup(() => ({ status: "failed", kind: "transient" }));

		const error = await engine.probe({ config: config(), signal: signal() }).catch((e) => e);

		expect(error).toBeInstanceOf(BalanceProbeRequestError);
		expect((error as BalanceProbeRequestError).kind).toBe("transient");
		expect(state.fallbackCalls).toEqual([]);
	});

	test("refreshes through the plugin with the discovered endpoint", async () => {
		const { state, engine } = setup(() => ({
			status: "ok",
			balance: { scope: "key", unlimited: false, amounts: [{ unit: "USD", remaining: 1 }] },
		}));

		const balance = await engine.refresh({
			config: config(),
			signal: signal(),
			adapter: "new-api",
			root: "https://relay.example.com",
		});

		expect(balance.amounts).toEqual([{ unit: "USD", remaining: 1 }]);
		expect((state.calls[0]?.params as { input: Record<string, unknown> }).input).toMatchObject({
			mode: "refresh",
			adapter: "new-api",
			root: "https://relay.example.com",
		});
		expect(state.fallbackCalls).toEqual([]);
	});

	test("falls back when the plugin package is not shipped", async () => {
		const { state, engine } = setup(() => JSON.parse(okProbe()), { skipRuntime: true });

		await engine.probe({ config: config(), signal: signal() });

		expect(state.calls).toEqual([]);
		expect(state.fallbackCalls).toEqual(["probe"]);
	});

	test("falls back when the plugin process cannot start", async () => {
		const { state, engine } = setup(() => JSON.parse(okProbe()), {
			startThrows: new Error("spawn failed"),
		});

		await engine.probe({ config: config(), signal: signal() });

		expect(state.fallbackCalls).toEqual(["probe"]);
	});

	test("falls back and drops the process when a call fails", async () => {
		const { state, engine } = setup(() => JSON.parse(okProbe()), {
			requestThrows: new Error("plugin crashed"),
		});

		await engine.probe({ config: config(), signal: signal() });

		expect(state.fallbackCalls).toEqual(["probe"]);
		expect(state.shutdowns).toBe(1);
	});

	test("falls back when the plugin output does not match the contract", async () => {
		const { state, engine } = setup(() => ({ status: "ok", balance: { scope: "bogus" } }));

		await engine.probe({ config: config(), signal: signal() });

		expect(state.fallbackCalls).toEqual(["probe"]);
	});

	test("falls back when a probe answer is missing its discovered endpoint", async () => {
		const { state, engine } = setup(() => ({
			status: "ok",
			balance: { scope: "key", unlimited: true, amounts: [] },
		}));

		await engine.probe({ config: config(), signal: signal() });

		// Without adapter/root the discovery cannot be persisted or refreshed, so the
		// bundled path runs rather than caching an unusable endpoint.
		expect(state.fallbackCalls).toEqual(["probe"]);
	});

	test("dispose stops the plugin process", async () => {
		const { state, engine } = setup(() => JSON.parse(okProbe()));

		await engine.probe({ config: config(), signal: signal() });
		await engine.dispose();

		expect(state.shutdowns).toBe(1);
	});
});
