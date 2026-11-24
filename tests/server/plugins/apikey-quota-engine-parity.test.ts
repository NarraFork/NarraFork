import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { parseSub2ApiBalance, relayQuotaData } from "../../../plugins/provider-quota/src/relay";
import { parseNewApiUserQuota } from "../../../plugins/provider-quota/src/site";
import {
	archivedQuotaFixture,
	closeQuotaTestPackage,
	quotaConfig,
	required,
} from "../../../server/lib/__tests__/provider-quota-legacy-fixture";
import type { outboundFetch } from "../../../server/lib/net/outbound-fetch";
import { providerQuotaSourceSchema, quotaQueryParamsSchema } from "../../../shared/provider-quota";

const payloads = {
	"sub2api wallet": { mode: "unrestricted", isValid: true, balance: 12.5, unit: "USD" },
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
};
let server: ReturnType<typeof Bun.serve>;
let f: Awaited<ReturnType<typeof archivedQuotaFixture>>;
let responder: (request: Request) => Response | Promise<Response> = () =>
	new Response(null, { status: 404 });
const calls: Array<Parameters<typeof outboundFetch>> = [];
const paths: string[] = [];
beforeAll(async () => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => {
			paths.push(new URL(request.url).pathname);
			return responder(request);
		},
	});
	f = await archivedQuotaFixture({
		fetch: async (...args) => {
			calls.push(args);
			const url = new URL(String(args[0]));
			if (url.hostname !== "127.0.0.1") return Response.json(payloads["sub2api wallet"]);
			if (url.port !== String(server.port)) throw new Error("Unexpected loopback destination");
			return fetch(args[0], args[1]);
		},
	});
}, 60000);
afterAll(async () => {
	await f?.close();
	server?.stop(true);
	await closeQuotaTestPackage();
});
const config = (baseUrl = `http://127.0.0.1:${server.port}/v1`) =>
	quotaConfig({ id: `parity-${crypto.randomUUID()}`, baseUrl });
async function rpc(
	configValue: ReturnType<typeof config>,
	mode: "probe" | "refresh" = "probe",
	cursor?: string,
) {
	const runtime = required(f.supervisor.get(f.pluginId));
	const trace = spyOn(runtime, "request");
	try {
		const result = await f.rpc(configValue, mode, cursor);
		expect(trace.mock.calls.some(([method]) => method === "quota.query")).toBe(true);
		expect(trace.mock.calls.some(([method]) => method === "tools.invoke")).toBe(false);
		expect(trace.mock.calls.some(([method]) => method === "commands.invoke")).toBe(false);
		expect(f.platform.toolRegistry.list(f.pluginId)).toEqual([]);
		for (const [method, params] of trace.mock.calls)
			if (method === "quota.query") {
				expect(quotaQueryParamsSchema.safeParse(params).success).toBe(true);
				expect(JSON.stringify(params)).not.toMatch(
					/test-secret-key|apiKey|proxy|tlsRejectUnauthorized/,
				);
			}
		return result;
	} finally {
		trace.mockRestore();
	}
}

/** A real bundle/process must match its distributed pure parser, never a retired native fallback. */
describe("archived quota RPC preserves upstream engine parity over real loopback HTTP", () => {
	for (const [name, payload] of Object.entries(payloads))
		test(`${name}: independently compiled RPC equals the parser projection`, async () => {
			responder = () => Response.json(payload);
			const result = await rpc(config());
			expect(result.status).toBe("supported");
			expect(result.data).toEqual(
				relayQuotaData(required(parseSub2ApiBalance(payload)), "sub2api"),
			);
		});
	test("sub2api refresh retains the confirmed root, subscription metadata and amounts", async () => {
		responder = () => Response.json(payloads["sub2api subscription"]);
		const cfg = config();
		const found = await rpc(cfg);
		paths.length = 0;
		const refreshed = await rpc(cfg, "refresh", found.cursor);
		expect(refreshed.data).toEqual(found.data);
		expect(paths).toEqual(["/v1/usage"]);
	});
	test("an origin without a quota endpoint is unsupported without fallback or false zero", async () => {
		responder = () => new Response(null, { status: 404 });
		expect(await rpc(config())).toMatchObject({ status: "unsupported", data: null });
	});
	test("500 is a fixed transient failure and not an unsupported or auth answer", async () => {
		responder = () => new Response("PRIVATE-UPSTREAM-CREDENTIAL", { status: 500 });
		const result = await rpc(config());
		expect(result).toMatchObject({ status: "error", data: null, error: "request_failed" });
		expect(JSON.stringify(result)).not.toContain("PRIVATE-UPSTREAM");
	});
	test("non-JSON HTML is unsupported as it was before migration", async () => {
		responder = () => new Response("<html></html>", { headers: { "content-type": "text/html" } });
		expect(await rpc(config())).toMatchObject({ status: "unsupported", data: null });
	});
	test("an oversized body fails at the bounded Host reader, not whole-body buffering", async () => {
		responder = () => Response.json({ ...payloads["sub2api wallet"], pad: "x".repeat(96 * 1024) });
		expect(await rpc(config())).toMatchObject({
			status: "error",
			data: null,
			error: "request_failed",
		});
	});
	test("disabled plugin denies quota querying instead of returning a native success", async () => {
		await f.manager.disable(f.pluginId);
		const count = calls.length;
		try {
			f.setProviders([config()]);
			expect(
				await f.service.refresh(required(f.directory.primaryEntries()[0]).providerId),
			).toMatchObject({
				status: "unavailable",
				data: null,
			});
			expect(calls).toHaveLength(count);
			expect(f.platform.quotaRegistry.listSources()).toEqual([]);
		} finally {
			await f.manager.enable(f.pluginId);
			await f.manager.activate(f.pluginId);
		}
	});
	test("wallet retains its exact amount", async () => {
		responder = () => Response.json(payloads["sub2api wallet"]);
		expect((await rpc(config())).data).toMatchObject({
			scope: "wallet",
			unlimited: false,
			amounts: [{ unit: "USD", remaining: 12.5 }],
		});
	});
	const siteBody = { success: true, data: { quota: 2500000, used_quota: 500000, group: "pro" } };
	const siteConfig = () => ({
		...config(),
		quotaSiteUrl: `http://127.0.0.1:${server.port}`,
		quotaAccessToken: "site-token",
		quotaUserId: "42",
	});
	test("site probe retains USD credit/group through actual RPC", async () => {
		responder = () => Response.json(siteBody);
		const result = await rpc(siteConfig());
		expect(result.data).toEqual(
			relayQuotaData(required(parseNewApiUserQuota(siteBody)), "new-api-user"),
		);
	});
	test("site rejected token is auth_failed rather than transient", async () => {
		responder = () => new Response(null, { status: 401 });
		expect(await rpc(siteConfig())).toMatchObject({
			status: "error",
			error: "auth_failed",
			data: null,
		});
	});
	test("site missing userId is invalid_configuration and produces no HTTP", async () => {
		const count = calls.length;
		const result = await f.query({ ...siteConfig(), quotaUserId: "" });
		expect(result).toMatchObject({ status: "error", error: "invalid_configuration", data: null });
		expect(calls).toHaveLength(count);
	});
	test("site refresh reuses only the confirmed account root", async () => {
		responder = () => Response.json(siteBody);
		const cfg = siteConfig();
		const found = await rpc(cfg);
		paths.length = 0;
		expect((await rpc(cfg, "refresh", found.cursor)).data).toEqual(found.data);
		expect(paths).toEqual(["/api/user/self"]);
	});
});

describe("per-request timeout and cancellation cross the real process boundary", () => {
	test("a short injected bound stops slow HTTP below one second-scale round", async () => {
		let signal: AbortSignal | undefined;
		// A probe tries several allowed roots; shorten only the fixture's Host timeout,
		// not the production deadline or the end-to-end assertion.
		f.setRequestTimeout(50);
		f.setTestHttp(async (_url, init) => {
			signal = init?.signal ?? undefined;
			return new Promise(() => {});
		});
		try {
			const started = performance.now();
			// Host timeout is projected as a fixed request_failed over generic Host RPC;
			// the actual deadline, abort and released reference remain mandatory.
			expect(await f.rpc(config())).toMatchObject({
				status: "error",
				error: "request_failed",
				data: null,
			});
			expect(performance.now() - started).toBeLessThan(1400);
			expect(signal?.aborted).toBe(true);
			expect(f.connection.activeReferences).toBe(0);
		} finally {
			f.setRequestTimeout();
			f.setTestHttp();
		}
	}, 20000);
	test("normal bounded request may finish after 300ms, but old 90s overrides cannot bypass protocol limits", async () => {
		responder = async () => {
			await Bun.sleep(450);
			return Response.json(payloads["sub2api wallet"]);
		};
		expect(await rpc(config())).toMatchObject({ status: "supported" });
		expect(
			providerQuotaSourceSchema.safeParse({
				id: "slow",
				title: "slow",
				requests: [{ path: "/quota", auth: "bearer" }],
				limits: { requestTimeoutMs: 90000 },
			}).success,
		).toBe(false);
	});
	test("cancellation consumes a delayed response and releases the reference", async () => {
		let signal: AbortSignal | undefined;
		let done!: (response: Response) => void;
		let enter!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		f.setTestHttp(async (_url, init) => {
			signal = init?.signal ?? undefined;
			enter();
			return new Promise((resolve) => {
				done = resolve;
			});
		});
		try {
			const controller = new AbortController();
			const pending = f.rpc(config(), "probe", undefined, controller.signal);
			await entered;
			controller.abort();
			await expect(pending).rejects.toThrow();
			expect(signal?.aborted).toBe(true);
			expect(f.connection.activeReferences).toBe(0);
			let canceled!: () => void;
			const discarded = new Promise<void>((resolve) => {
				canceled = resolve;
			});
			done(
				new Response(
					new ReadableStream({
						cancel() {
							canceled();
						},
					}),
				),
			);
			await discarded;
		} finally {
			f.setTestHttp();
		}
	}, 20000);
});

describe("Host, not the plugin process, applies the unchanged saved egress policy", () => {
	test("saved proxy, TLS and configured User-Agent reach Host HTTP unchanged", async () => {
		const cfg = config("https://relay.corp.invalid/v1");
		cfg.proxy = { mode: "custom", url: "http://proxy.corp.invalid:3128" };
		cfg.tlsRejectUnauthorized = false;
		cfg.userAgentMode = "custom";
		cfg.customUserAgent = "ua/1";
		cfg.extraHeaders = { "X-Tenant": "a" };
		await rpc(cfg);
		const call = required(calls.at(-1));
		expect(call[2]).toEqual({
			proxyUrl: "http://proxy.corp.invalid:3128",
			tlsRejectUnauthorized: false,
			retryPolicy: "never",
		});
		const headers = new Headers(call[1]?.headers);
		expect(headers.get("user-agent")).toBe("ua/1");
		expect(headers.get("x-tenant")).toBe("a");
	});
	test("the wire excludes connection credentials and facts formerly sent into the plugin", async () => {
		const runtime = required(f.supervisor.get(f.pluginId));
		const trace = spyOn(runtime, "request");
		try {
			await f.rpc(config("https://relay.corp.invalid/v1"));
			const wire = JSON.stringify(trace.mock.calls.filter(([method]) => method === "quota.query"));
			expect(wire).not.toMatch(/test-secret-key|apiKey|headers|proxy|tlsRejectUnauthorized/);
		} finally {
			trace.mockRestore();
		}
	});
	test("direct egress has no injected proxy", async () => {
		const cfg = config("https://relay.corp.invalid/v1");
		cfg.proxy = { mode: "direct" };
		await rpc(cfg);
		expect(calls.at(-1)?.[2]?.proxyUrl).toBeUndefined();
	});
});

for (const method of ["tools.invoke", "commands.invoke"])
	test(`archived quota backend rejects ${method} without reaching Host HTTP`, async () => {
		const runtime = required(f.supervisor.get(f.pluginId));
		const count = calls.length;
		await expect(
			runtime.request(
				method,
				{ contributionId: "relay", input: { mode: "probe" } },
				{ timeoutMs: 3000 },
			),
		).rejects.toMatchObject({ code: "-32601" });
		expect(calls).toHaveLength(count);
	});

test("revoked grants remain denied before quota RPC after explicit re-enable", async () => {
	const permissions = await f.manager.getPermissions(f.pluginId);
	await f.manager.replacePermissions(f.pluginId, {
		grants: [],
		expectedRevision: permissions.revision,
		grantedBy: "quota-parity-admin",
	});
	await f.manager.disable(f.pluginId);
	await f.manager.enable(f.pluginId);
	await f.manager.activate(f.pluginId);
	const runtime = required(f.supervisor.get(f.pluginId));
	const trace = spyOn(runtime, "request");
	const count = calls.length;
	try {
		await expect(f.rpc(config())).rejects.toThrow();
		expect(trace.mock.calls.some(([method]) => method === "quota.query")).toBe(false);
		expect(calls).toHaveLength(count);
		expect((await f.manager.getPermissions(f.pluginId)).grants).toEqual([]);
	} finally {
		trace.mockRestore();
	}
});
