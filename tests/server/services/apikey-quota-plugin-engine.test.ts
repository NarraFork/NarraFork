import { describe, expect, test } from "bun:test";
import { BalanceProbeRequestError } from "@server/lib/provider-balance-adapters";
import type { CustomApiProviderConfig } from "@server/lib/settings";
import { createApikeyQuotaEngine } from "@server/services/apikey-quota-plugin-engine";
import {
	type PluginToolDescriptor,
	type PluginToolInvocationOptions,
	PluginToolRegistryError,
	type PluginToolResult,
} from "@server/services/plugin-tool-registry";
import { APIKEY_QUOTA_PLUGIN_ID, APIKEY_QUOTA_TOOL_ID } from "@shared/apikey-quota-plugin";

const FULL_ID = `${APIKEY_QUOTA_PLUGIN_ID}/${APIKEY_QUOTA_TOOL_ID}`;

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

type Answer = (input: Record<string, unknown>) => PluginToolResult | Promise<PluginToolResult>;

interface Harness {
	invocations: Array<{
		fullId: string;
		input: Record<string, unknown>;
		options?: PluginToolInvocationOptions;
	}>;
	fallbackCalls: string[];
}

const DESCRIPTOR = {
	pluginId: APIKEY_QUOTA_PLUGIN_ID,
	contributionId: APIKEY_QUOTA_TOOL_ID,
	fullId: FULL_ID,
	title: "Query API key quota",
	status: "available",
} as PluginToolDescriptor;

/**
 * A fake tool registry plus a fake bundled engine. The registry is what the real host
 * exposes, so these tests cover the engine's decision table without spawning a plugin.
 */
function setup(answer: Answer, options: { available?: boolean; invokeThrows?: Error } = {}) {
	const available = options.available ?? true;
	const state: Harness = { invocations: [], fallbackCalls: [] };
	const engine = createApikeyQuotaEngine({
		toolRegistry: {
			list: (pluginId?: string) =>
				available && (!pluginId || pluginId === APIKEY_QUOTA_PLUGIN_ID) ? [DESCRIPTOR] : [],
			invoke: async (
				fullId: string,
				input: Record<string, unknown>,
				invocationOptions?: PluginToolInvocationOptions,
			) => {
				state.invocations.push({ fullId, input, options: invocationOptions });
				if (options.invokeThrows) throw options.invokeThrows;
				return answer(input);
			},
		},
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
	});
	return { state, engine };
}

const okProbe = () =>
	JSON.stringify({
		status: "ok",
		adapter: "sub2api",
		root: "https://relay.example.com",
		balance: { scope: "wallet", unlimited: false, amounts: [{ unit: "USD", remaining: 12.5 }] },
	});

describe("apikey-quota plugin engine", () => {
	test("uses a successful probe answer and skips the bundled path", async () => {
		const { state, engine } = setup(() => ({ output: okProbe() }));

		const found = await engine.probe({ config: config(), signal: signal() });

		expect(found).toEqual({
			adapter: "sub2api",
			root: "https://relay.example.com",
			balance: { scope: "wallet", unlimited: false, amounts: [{ unit: "USD", remaining: 12.5 }] },
		});
		expect(state.fallbackCalls).toEqual([]);
		expect(state.invocations).toHaveLength(1);
	});

	test("forwards the connection facts the plugin needs, and no more", async () => {
		const { state, engine } = setup(() => ({ output: JSON.stringify({ status: "unsupported" }) }));

		await engine.probe({ config: config(), signal: signal() });

		const call = state.invocations[0];
		expect(call?.fullId).toBe(FULL_ID);
		expect(call?.input).toMatchObject({
			mode: "probe",
			baseUrl: "https://relay.example.com/v1",
			apiKey: "sk-secret",
			headers: { "X-Tenant": "t1" },
			proxy: "http://127.0.0.1:7890",
			tlsRejectUnauthorized: false,
		});
		expect(typeof call?.input.userAgent).toBe("string");
		expect(call?.input).not.toHaveProperty("id");
		expect(call?.input).not.toHaveProperty("defaultModel");
		// `config.proxy` is an override policy; the plugin must receive a resolved URL,
		// otherwise it would silently ignore a corporate proxy after the switch.
		expect(call?.input.proxy).toBe("http://127.0.0.1:7890");
		// A background principal is what a host-initiated call must use.
		expect(call?.options).toMatchObject({
			invocation: { kind: "plugin_background", source: "internal" },
			permission: { behavior: "allow" },
		});
	});

	test("treats 'unsupported' as authoritative and still skips the bundled path", async () => {
		const { state, engine } = setup(() => ({ output: JSON.stringify({ status: "unsupported" }) }));

		await expect(engine.probe({ config: config(), signal: signal() })).resolves.toBeNull();
		expect(state.fallbackCalls).toEqual([]);
	});

	test("maps a plugin 'failed' answer onto the existing transient error", async () => {
		const { state, engine } = setup(() => ({
			output: JSON.stringify({ status: "failed", kind: "transient" }),
		}));

		const error = await engine.probe({ config: config(), signal: signal() }).catch((e) => e);

		expect(error).toBeInstanceOf(BalanceProbeRequestError);
		expect((error as BalanceProbeRequestError).kind).toBe("transient");
		expect(state.fallbackCalls).toEqual([]);
	});

	test("refreshes through the plugin with the discovered endpoint", async () => {
		const { state, engine } = setup(() => ({
			output: JSON.stringify({
				status: "ok",
				balance: { scope: "key", unlimited: false, amounts: [{ unit: "USD", remaining: 1 }] },
			}),
		}));

		const balance = await engine.refresh({
			config: config(),
			signal: signal(),
			adapter: "new-api",
			root: "https://relay.example.com",
		});

		expect(balance.amounts).toEqual([{ unit: "USD", remaining: 1 }]);
		expect(state.invocations[0]?.input).toMatchObject({
			mode: "refresh",
			adapter: "new-api",
			root: "https://relay.example.com",
		});
		expect(state.fallbackCalls).toEqual([]);
	});

	test("falls back to the bundled engine when the plugin is not installed", async () => {
		const { state, engine } = setup(() => ({ output: "{}" }), { available: false });

		await engine.probe({ config: config(), signal: signal() });

		expect(state.invocations).toEqual([]);
		expect(state.fallbackCalls).toEqual(["probe"]);
	});

	test("falls back when the plugin output does not match the contract", async () => {
		const { state, engine } = setup(() => ({
			output: JSON.stringify({ status: "ok", balance: { scope: "bogus" } }),
		}));

		await engine.probe({ config: config(), signal: signal() });

		expect(state.fallbackCalls).toEqual(["probe"]);
	});

	test("falls back when the plugin answers with a non-JSON payload", async () => {
		const { state, engine } = setup(() => ({ output: "not json" }));

		await engine.probe({ config: config(), signal: signal() });

		expect(state.fallbackCalls).toEqual(["probe"]);
	});

	test("falls back when the runtime is unavailable", async () => {
		const { state, engine } = setup(() => ({ output: "{}" }), {
			invokeThrows: new PluginToolRegistryError("HOST_UNAVAILABLE", "runtime not active", true),
		});

		await engine.probe({ config: config(), signal: signal() });

		expect(state.fallbackCalls).toEqual(["probe"]);
	});

	test("falls back when a probe answer is missing its discovered endpoint", async () => {
		const { state, engine } = setup(() => ({
			output: JSON.stringify({
				status: "ok",
				balance: { scope: "key", unlimited: true, amounts: [] },
			}),
		}));

		await engine.probe({ config: config(), signal: signal() });

		// Without adapter/root the discovery cannot be persisted or refreshed, so the
		// bundled path runs rather than caching an unusable endpoint.
		expect(state.fallbackCalls).toEqual(["probe"]);
	});
});
