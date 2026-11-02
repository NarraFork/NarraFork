import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { builtinProviderBalanceEngine } from "@server/lib/provider-balance-engine";
import type { CustomApiProviderConfig } from "@server/lib/settings";
import { createApikeyQuotaEngine } from "@server/services/apikey-quota-plugin-engine";
import { PluginManager } from "@server/services/plugin-manager";
import { pluginPlatformServices } from "@server/services/plugin-platform-services";
import type { ProviderBalanceData } from "@shared/provider-balance";

/**
 * End-to-end parity between the two implementations of one engine interface.
 *
 * Both are driven against the *same* mock relay, with the *same* provider config, and must
 * produce identical results. This is the check that a fallback cannot hide: if the plugin
 * were unable to express something the bundled adapters can, these cases would diverge
 * rather than quietly succeeding through the bundled path (the plugin is healthy here, so
 * the engine never consults it).
 */
const payloads = {
	"sub2api wallet": {
		mode: "unrestricted",
		isValid: true,
		balance: 12.5,
		unit: "USD",
	},
	"sub2api quota limited": {
		mode: "quota_limited",
		isValid: true,
		quota: { remaining: 5, used: 5, limit: 10, unit: "USD" },
		rate_limits: [
			{ window: "5h", remaining: 1, used: 1, limit: 2 },
			{ window: "1d", remaining: 3, used: 1, limit: 4 },
		],
	},
	"sub2api subscription": {
		mode: "unrestricted",
		isValid: true,
		unit: "USD",
		remaining: 10,
		planName: "Pro",
		subscription: {
			expires_at: "2030-01-01T00:00:00Z",
			daily_limit_usd: 10,
			daily_usage_usd: 2,
			weekly_limit_usd: 40,
			weekly_usage_usd: 4,
			weekly_window_start: "2029-12-25T00:00:00Z",
		},
	},
} as const;

/**
 * The engine under test is wired to the *real* plugin manager, so the plugin is reached through
 * the same activation + tool-registry path production uses. Without that, the engine would find
 * no registered tool, silently answer from the bundled adapters, and this whole file would be
 * comparing the bundled engine with itself.
 */
let managerPromise: Promise<PluginManager> | undefined;

function sharedManager(): Promise<PluginManager> {
	// No explicit root/catalog/coordinator: the manager then takes the shared platform services,
	// which is what the singleton host instance does, so `pluginPlatformServices.toolRegistry`
	// is the registry the manager populates.
	managerPromise ??= (async () => {
		const manager = new PluginManager({ disabled: false });
		await manager.initialize();
		return manager;
	})();
	return managerPromise;
}

async function pluginEngine() {
	const manager = await sharedManager();
	return createApikeyQuotaEngine({
		tools: pluginPlatformServices.toolRegistry,
		activator: manager,
	});
}

/** Same engine, but the plugin is disabled so the bundled adapters must answer. */
async function disabledPluginEngine() {
	const manager = await sharedManager();
	await manager.disable("com.narrafork.apikey-quota");
	const engine = createApikeyQuotaEngine({
		tools: pluginPlatformServices.toolRegistry,
		activator: manager,
	});
	return {
		...engine,
		probe: engine.probe.bind(engine),
		refresh: engine.refresh.bind(engine),
		async dispose() {
			await manager.enable("com.narrafork.apikey-quota");
			await engine.dispose();
		},
	};
}

const config = (baseUrl: string): CustomApiProviderConfig => ({
	id: "relay-parity",
	name: "relay-parity",
	prefix: "relay-parity",
	baseUrl,
	protocol: "completions-compatible",
	apiKey: "sk-parity",
	defaultModel: "m",
});

describe("plugin and bundled engine parity over one mock relay", () => {
	let server: ReturnType<typeof Bun.serve>;
	let body: unknown = null;
	let requests: string[] = [];

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			fetch: (request) => {
				const url = new URL(request.url);
				requests.push(url.pathname);
				if (url.pathname === "/v1/usage" && body !== null) return Response.json(body);
				if (url.pathname === "/api/usage/token/" && body !== null) {
					return Response.json({ code: true, data: body });
				}
				return new Response("not found", { status: 404 });
			},
		});
	});

	afterAll(async () => {
		server.stop(true);
		const manager = await managerPromise?.catch(() => undefined);
		await manager?.shutdown();
	});

	for (const [name, payload] of Object.entries(payloads)) {
		test(`${name}: probe yields the same discovery and balance`, async () => {
			body = payload;
			requests = [];
			const base = `http://127.0.0.1:${server.port}/v1`;
			const plugin = await pluginEngine();
			try {
				const viaPlugin = await plugin.probe({
					config: config(base),
					signal: AbortSignal.timeout(20_000),
				});
				const viaBuiltin = await builtinProviderBalanceEngine.probe({
					config: config(base),
					signal: AbortSignal.timeout(20_000),
				});
				expect(viaPlugin).toEqual(viaBuiltin);
				expect(viaPlugin?.balance).not.toBeNull();
			} finally {
				await plugin.dispose();
			}
		});
	}

	test("sub2api refresh matches the bundled refresh", async () => {
		body = payloads["sub2api subscription"];
		const base = `http://127.0.0.1:${server.port}/v1`;
		const root = `http://127.0.0.1:${server.port}`;
		const plugin = await pluginEngine();
		try {
			const viaPlugin = await plugin.refresh({
				config: config(base),
				signal: AbortSignal.timeout(20_000),
				adapter: "sub2api",
				root,
			});
			const viaBuiltin = await builtinProviderBalanceEngine.refresh({
				config: config(base),
				signal: AbortSignal.timeout(20_000),
				adapter: "sub2api",
				root,
			});
			expect(viaPlugin).toEqual(viaBuiltin);
		} finally {
			await plugin.dispose();
		}
	});

	test("an origin without a quota endpoint is 'unsupported' in both", async () => {
		body = null;
		const base = `http://127.0.0.1:${server.port}/v1`;
		const plugin = await pluginEngine();
		try {
			const viaPlugin = await plugin.probe({
				config: config(base),
				signal: AbortSignal.timeout(20_000),
			});
			const viaBuiltin = await builtinProviderBalanceEngine.probe({
				config: config(base),
				signal: AbortSignal.timeout(20_000),
			});
			expect(viaPlugin).toBeNull();
			expect(viaBuiltin).toBeNull();
		} finally {
			await plugin.dispose();
		}
	});

	test("a 500 response is a transient failure in both", async () => {
		const failing = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) });
		const base = `http://127.0.0.1:${failing.port}/v1`;
		const plugin = await pluginEngine();
		try {
			const pluginError = await plugin
				.probe({ config: config(base), signal: AbortSignal.timeout(20_000) })
				.catch((error) => error);
			const builtinError = await builtinProviderBalanceEngine
				.probe({ config: config(base), signal: AbortSignal.timeout(20_000) })
				.catch((error) => error);

			// Both surface the same named transport error, so the cache classifies them alike.
			expect(pluginError?.name).toBe(builtinError?.name);
			expect(pluginError?.kind).toBe(builtinError?.kind);
		} finally {
			await plugin.dispose();
			failing.stop(true);
		}
	});

	test("a non-JSON content type is 'unsupported' in both", async () => {
		const html = Bun.serve({
			port: 0,
			fetch: () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
		});
		const base = `http://127.0.0.1:${html.port}/v1`;
		const plugin = await pluginEngine();
		try {
			const viaPlugin = await plugin.probe({
				config: config(base),
				signal: AbortSignal.timeout(20_000),
			});
			const viaBuiltin = await builtinProviderBalanceEngine.probe({
				config: config(base),
				signal: AbortSignal.timeout(20_000),
			});
			expect(viaPlugin).toBeNull();
			expect(viaBuiltin).toBeNull();
		} finally {
			await plugin.dispose();
			html.stop(true);
		}
	});

	test("an oversized body is rejected as transient by both, without buffering it whole", async () => {
		// 96 KiB of valid-JSON padding exceeds the 64 KiB cap.
		const oversized = Bun.serve({
			port: 0,
			fetch: () =>
				Response.json({
					mode: "unrestricted",
					isValid: true,
					unit: "USD",
					balance: 1,
					pad: "x".repeat(96 * 1024),
				}),
		});
		const base = `http://127.0.0.1:${oversized.port}/v1`;
		const plugin = await pluginEngine();
		try {
			const pluginError = await plugin
				.probe({ config: config(base), signal: AbortSignal.timeout(20_000) })
				.catch((error) => error);
			const builtinError = await builtinProviderBalanceEngine
				.probe({ config: config(base), signal: AbortSignal.timeout(20_000) })
				.catch((error) => error);
			expect(pluginError?.kind).toBe("transient");
			expect(builtinError?.kind).toBe("transient");
		} finally {
			await plugin.dispose();
			oversized.stop(true);
		}
	});

	test("a disabled plugin answers with the same data as the bundled engine", async () => {
		body = payloads["sub2api wallet"];
		const base = `http://127.0.0.1:${server.port}/v1`;
		const disabled = await disabledPluginEngine();
		try {
			const viaDisabled = await disabled.probe({
				config: config(base),
				signal: AbortSignal.timeout(20_000),
			});
			const viaBuiltin = await builtinProviderBalanceEngine.probe({
				config: config(base),
				signal: AbortSignal.timeout(20_000),
			});
			expect(viaDisabled).toEqual(viaBuiltin);
		} finally {
			await disabled.dispose();
		}
	});

	test("both report the same wallet amount for the sub2api wallet payload", async () => {
		body = payloads["sub2api wallet"];
		const base = `http://127.0.0.1:${server.port}/v1`;
		const plugin = await pluginEngine();
		try {
			const found = await plugin.probe({
				config: config(base),
				signal: AbortSignal.timeout(20_000),
			});
			const expected: ProviderBalanceData = {
				scope: "wallet",
				unlimited: false,
				amounts: [{ unit: "USD", remaining: 12.5 }],
			};
			expect(found?.balance).toEqual(expected);
		} finally {
			await plugin.dispose();
		}
	});
});

/**
 * The per-request timeout crosses the process boundary, so it must mean the same thing on both
 * sides. These cases pin the semantics rather than the exact milliseconds: a short bound aborts
 * a slow upstream in both engines, and a value far above the plugin's old 60 s ceiling is not
 * silently shortened.
 */
describe("per-request timeout means the same thing in both engines", () => {
	const slowRelay = () =>
		Bun.serve({
			port: 0,
			fetch: async () => {
				await Bun.sleep(1_500);
				return Response.json({ mode: "unrestricted", isValid: true, balance: 1, unit: "USD" });
			},
		});

	for (const [label, timeoutMs] of [
		["a short 300 ms bound", 300],
		["a value above the old 60 s clamp", 90_000],
	] as const) {
		test(`${label} is classified the same by both engines`, async () => {
			const slow = slowRelay();
			const base = `http://127.0.0.1:${slow.port}/v1`;
			const plugin = await pluginEngine();
			const started = performance.now();
			try {
				const pluginOutcome = await plugin
					.probe({
						config: config(base),
						signal: AbortSignal.timeout(20_000),
						requestTimeoutMs: timeoutMs,
					})
					.then(
						(value) => ({ ok: true, value }),
						(error) => ({ ok: false, kind: error?.kind, name: error?.name }),
					);
				const elapsed = performance.now() - started;
				const builtinOutcome = await builtinProviderBalanceEngine
					.probe({
						config: config(base),
						signal: AbortSignal.timeout(20_000),
						requestTimeoutMs: timeoutMs,
					})
					.then(
						(value) => ({ ok: true, value }),
						(error) => ({ ok: false, kind: error?.kind, name: error?.name }),
					);

				expect(pluginOutcome).toEqual(builtinOutcome);
				if (timeoutMs < 1_000) {
					// A short bound must actually bound the round, not be rounded up to a second.
					expect(elapsed).toBeLessThan(1_400);
				}
			} finally {
				await plugin.dispose();
				slow.stop(true);
			}
		}, 20_000);
	}
});

/**
 * A configured proxy is an egress policy, not a performance hint. It cannot be tested over a
 * loopback relay (the host exempts loopback from proxying in both engines, so a local target
 * never proves anything), so it is pinned at the boundary itself: the plugin's request builder
 * must hand the host-supplied proxy to `fetch`. Dropping it would send a corporate deployment
 * straight to provider origins after the switch.
 */
describe("host egress policy is handed to the plugin transport verbatim", () => {
	// Runtime-built specifier: the plugin entry is plain JS with no type declarations, exactly
	// as the release validator loads it.
	const pluginEntry = `${process.cwd()}/server/builtin-plugins/apikey-quota/server/index.js`;
	const plugin = () =>
		import(pluginEntry) as Promise<{
			probeProviderBalance: (
				input: Record<string, unknown>,
				signal: AbortSignal,
				fetcher: (url: string, init: Record<string, unknown>) => Promise<Response>,
			) => Promise<{ balance?: unknown } | null>;
			parseToolInput: (raw: Record<string, unknown>) => Record<string, unknown>;
		}>;

	test("the resolved proxy and the timeout reach fetch options unchanged", async () => {
		const { probeProviderBalance } = await plugin();
		const seen: Array<Record<string, unknown>> = [];
		const fetcher = async (_url: string, init: Record<string, unknown>) => {
			seen.push(init);
			return Response.json({ mode: "unrestricted", isValid: true, balance: 3, unit: "USD" });
		};
		const result = await probeProviderBalance(
			{
				mode: "probe",
				baseUrl: "https://relay.example.test/v1",
				apiKey: "sk-parity",
				proxy: "http://proxy.corp.example:3128",
				tlsRejectUnauthorized: false,
				timeoutMs: 90_000,
			},
			AbortSignal.timeout(20_000),
			fetcher,
		);
		expect(result?.balance).toMatchObject({ scope: "wallet" });
		expect(seen[0]?.proxy).toBe("http://proxy.corp.example:3128");
		expect(seen[0]?.tls).toEqual({ rejectUnauthorized: false });
	});

	test("the wire input keeps every connection fact the host sent", async () => {
		const { parseToolInput } = await plugin();
		const parsed = parseToolInput({
			mode: "probe",
			baseUrl: "https://relay.example.test/v1",
			apiKey: "sk-parity",
			headers: { "X-Tenant": "a" },
			userAgent: "ua/1",
			proxy: "http://proxy.corp.example:3128",
			tlsRejectUnauthorized: false,
			timeoutMs: 90_000,
		});
		// This is the exact set the host put in `connectionFields`; a field silently dropped
		// here would change egress or timing without any error surfacing.
		expect(parsed).toMatchObject({
			proxy: "http://proxy.corp.example:3128",
			userAgent: "ua/1",
			headers: { "X-Tenant": "a" },
			tlsRejectUnauthorized: false,
			timeoutMs: 90_000,
		});
	});

	test("no proxy in the input means no proxy in fetch options", async () => {
		const { probeProviderBalance } = await plugin();
		const seen: Array<Record<string, unknown>> = [];
		const fetcher = async (_url: string, init: Record<string, unknown>) => {
			seen.push(init);
			return Response.json({ mode: "unrestricted", isValid: true, balance: 3, unit: "USD" });
		};
		await probeProviderBalance(
			{ mode: "probe", baseUrl: "https://relay.example.test/v1", apiKey: "sk-parity" },
			AbortSignal.timeout(20_000),
			fetcher,
		);
		expect(seen[0]).not.toHaveProperty("proxy");
	});
});
