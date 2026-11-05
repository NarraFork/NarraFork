import { describe, expect, test } from "bun:test";
import type { ProviderEndpointPolicy } from "@shared/provider-endpoints";
import { EndpointPool, type EndpointPoolConfig } from "../endpoint-pool";

const A = "https://a.example.com/v1";
const B = "https://b.example.com/v1";
const C = "https://c.example.com/v1";

function makePool(probe?: (url: string) => Promise<number>) {
	let now = 1_000_000;
	const pool = new EndpointPool({
		now: () => now,
		autoProbe: false,
		probe: probe ? (url) => probe(url) : async () => 1,
	});
	return {
		pool,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

function config(policy?: ProviderEndpointPolicy, mirrors = [B]): EndpointPoolConfig {
	return { id: "p1", baseUrl: A, baseUrls: mirrors, endpointPolicy: policy };
}

/** Fake transport: per-host behavior, records every URL it was asked for. */
function transport(behavior: Record<string, number | Error>) {
	const calls: string[] = [];
	const fetch = async (input: string | URL | Request, _init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		const host = new URL(url).host;
		const outcome = behavior[host] ?? 200;
		if (outcome instanceof Error) throw outcome;
		return new Response("body", { status: outcome });
	};
	return { calls, fetch };
}

describe("EndpointPool.fetch", () => {
	test("single-URL providers pass straight through", async () => {
		const { pool } = makePool();
		const t = transport({});
		await pool.fetch({ id: "solo", baseUrl: A }, `${A}/messages`, undefined, t.fetch);
		expect(t.calls).toEqual([`${A}/messages`]);
	});

	test("fails over on a network error and keeps the path suffix", async () => {
		const { pool } = makePool();
		const t = transport({ "a.example.com": new Error("ECONNREFUSED") });
		const res = await pool.fetch(
			config(),
			`${A}/messages?beta=true`,
			{ method: "POST", body: "{}" },
			t.fetch,
		);
		expect(res.status).toBe(200);
		expect(t.calls).toEqual([`${A}/messages?beta=true`, `${B}/messages?beta=true`]);
		// The failed endpoint is cooling down, so the next request starts on the mirror.
		expect(pool.order(config())).toEqual([B, A]);
	});

	test("cooled-down endpoints return to rotation after the cooldown", async () => {
		const { pool, advance } = makePool();
		const t = transport({ "a.example.com": new Error("reset") });
		await pool.fetch(
			config({ strategy: "ordered", cooldownSec: 10 }),
			`${A}/x`,
			undefined,
			t.fetch,
		);
		expect(pool.order(config({ strategy: "ordered", cooldownSec: 10 }))).toEqual([B, A]);
		advance(10_001);
		expect(pool.order(config({ strategy: "ordered", cooldownSec: 10 }))).toEqual([A, B]);
	});

	test("5xx fails over only when enabled", async () => {
		const on = makePool();
		const t1 = transport({ "a.example.com": 502 });
		const res1 = await on.pool.fetch(config(), `${A}/x`, undefined, t1.fetch);
		expect(res1.status).toBe(200);
		expect(t1.calls).toHaveLength(2);

		const off = makePool();
		const t2 = transport({ "a.example.com": 502 });
		const res2 = await off.pool.fetch(
			config({ failoverOn: { serverError: false } }),
			`${A}/x`,
			undefined,
			t2.fetch,
		);
		expect(res2.status).toBe(502);
		expect(t2.calls).toHaveLength(1);
	});

	test("4xx does not fail over by default and never marks the endpoint unhealthy", async () => {
		const { pool } = makePool();
		const t = transport({ "a.example.com": 401 });
		const res = await pool.fetch(config(), `${A}/x`, undefined, t.fetch);
		expect(res.status).toBe(401);
		expect(t.calls).toHaveLength(1);

		const t2 = transport({ "a.example.com": 401 });
		const policy = { failoverOn: { clientError: true } };
		const res2 = await pool.fetch(config(policy), `${A}/x`, undefined, t2.fetch);
		expect(res2.status).toBe(200);
		expect(t2.calls).toHaveLength(2);
		expect(pool.status(config(policy)).endpoints.every((e) => e.healthy)).toBe(true);
	});

	test("returns the last response when every endpoint fails", async () => {
		const { pool } = makePool();
		const t = transport({ "a.example.com": 503, "b.example.com": 429 });
		const res = await pool.fetch(config(), `${A}/x`, undefined, t.fetch);
		expect(res.status).toBe(429);
		expect(t.calls).toHaveLength(2);
	});

	test("a caller abort is rethrown without trying other endpoints", async () => {
		const { pool } = makePool();
		const controller = new AbortController();
		const calls: string[] = [];
		const fetch = async (input: string | URL | Request) => {
			calls.push(String(input));
			controller.abort();
			throw new DOMException("aborted", "AbortError");
		};
		await expect(
			pool.fetch(config(), `${A}/x`, { signal: controller.signal }, fetch),
		).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});

	test("fails over on a header timeout only when that condition is enabled", async () => {
		const { pool } = makePool();
		const calls: string[] = [];
		const fetch = (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			calls.push(url);
			if (url.startsWith(B)) return Promise.resolve(new Response("ok"));
			return new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			});
		};
		const res = await pool.fetch(
			config({ headerTimeoutMs: 20, failoverOn: { timeout: true } }),
			`${A}/x`,
			undefined,
			fetch,
		);
		expect(res.status).toBe(200);
		expect(calls).toEqual([`${A}/x`, `${B}/x`]);
		expect(
			pool.status(config({ headerTimeoutMs: 20, failoverOn: { timeout: true } })).endpoints[0]
				?.lastError,
		).toContain("No response headers");
	});

	test("streamed request bodies are not replayed", async () => {
		const { pool } = makePool();
		const t = transport({ "a.example.com": new Error("reset") });
		const body = new ReadableStream({
			start(c) {
				c.close();
			},
		});
		await expect(pool.fetch(config(), `${A}/x`, { method: "POST", body }, t.fetch)).rejects.toThrow(
			"reset",
		);
		expect(t.calls).toHaveLength(1);
	});

	test("URLs outside the configured endpoints pass through", async () => {
		const { pool } = makePool();
		const t = transport({});
		await pool.fetch(config(), "https://other.example.com/x", undefined, t.fetch);
		await pool.fetch(config(), `${A}extra/x`, undefined, t.fetch);
		expect(t.calls).toEqual(["https://other.example.com/x", `${A}extra/x`]);
	});

	test("a path appended to the primary (e.g. /v1 fallback) is kept on mirrors", async () => {
		const { pool } = makePool();
		const t = transport({ "a.example.com": new Error("down") });
		const cfg = { id: "p2", baseUrl: "https://a.example.com", baseUrls: ["https://b.example.com"] };
		await pool.fetch(cfg, "https://a.example.com/v1/messages", undefined, t.fetch);
		expect(t.calls[1]).toBe("https://b.example.com/v1/messages");
	});
});

describe("EndpointPool ordering", () => {
	const latencies: Record<string, number> = { [A]: 300, [B]: 100, [C]: 250 };
	const probe = async (url: string) => latencies[url] ?? 1;

	test("lowest-latency ranks by probe latency", async () => {
		const { pool } = makePool(probe);
		const cfg = config({ strategy: "lowest-latency" }, [B, C]);
		await pool.probeAll(cfg);
		expect(pool.order(cfg)).toEqual([B, C, A]);
	});

	test("ordered ignores latency", async () => {
		const { pool } = makePool(probe);
		const cfg = config({ strategy: "ordered" }, [B, C]);
		await pool.probeAll(cfg);
		expect(pool.order(cfg)).toEqual([A, B, C]);
	});

	test("sticky keeps the primary until data shows a big enough gain", async () => {
		const { pool } = makePool(async (url) => (url === A ? 120 : 100));
		const cfg = config({ strategy: "sticky", stickySwitchRatio: 0.3 });
		// No measurements yet: configured order.
		expect(pool.order(cfg)[0]).toBe(A);
		await pool.probeAll(cfg);
		// B is only ~17% faster: stay on A.
		expect(pool.order(cfg)[0]).toBe(A);
	});

	test("sticky switches when another endpoint is faster by the ratio", async () => {
		const { pool } = makePool(async (url) => (url === A ? 300 : 100));
		const cfg = config({ strategy: "sticky", stickySwitchRatio: 0.3 });
		expect(pool.order(cfg)[0]).toBe(A);
		await pool.probeAll(cfg);
		expect(pool.order(cfg)[0]).toBe(B);
		// And then sticks to B.
		expect(pool.order(cfg)[0]).toBe(B);
	});

	test("failed probes take an endpoint out of rotation", async () => {
		const { pool } = makePool(async (url) => {
			if (url === A) throw new Error("ECONNREFUSED");
			return 50;
		});
		const cfg = config({ strategy: "ordered" });
		await pool.probeAll(cfg);
		expect(pool.order(cfg)).toEqual([B, A]);
		const status = pool.status(cfg);
		expect(status.endpoints[0]).toMatchObject({ url: A, healthy: false });
		expect(status.endpoints[0]?.lastError).toContain("probe:");
		expect(status.endpoints[1]).toMatchObject({ url: B, healthy: true, probeLatencyMs: 50 });
	});

	test("changing the URL list keeps measurements for URLs that remain", async () => {
		const { pool } = makePool(probe);
		await pool.probeAll(config({}, [B]));
		const status = pool.status(config({}, [B, C]));
		// New signature has no live state yet: status reports nothing measured.
		expect(status.endpoints.map((e) => e.probeLatencyMs)).toEqual([null, null, null]);
		pool.order(config({}, [B, C]));
		const after = pool.status(config({}, [B, C]));
		expect(after.endpoints.map((e) => e.probeLatencyMs)).toEqual([300, 100, null]);
	});
});

describe("EndpointPool review fixes", () => {
	test("by default a slow response is awaited, never resent to a mirror", async () => {
		const { pool } = makePool();
		const calls: string[] = [];
		const fetch = async (input: string | URL | Request) => {
			calls.push(String(input));
			await new Promise((resolve) => setTimeout(resolve, 40));
			return new Response("ok");
		};
		// Even with a tiny header timeout: the timeout condition is off unless opted in.
		const res = await pool.fetch(config({ headerTimeoutMs: 10 }), `${A}/x`, undefined, fetch);
		expect(res.status).toBe(200);
		expect(calls).toEqual([`${A}/x`]);
	});

	test("a disabled condition is reported but does not cool the endpoint down", async () => {
		const { pool } = makePool();
		const cfg = config({ strategy: "ordered", failoverOn: { rateLimit: false } });
		const t = transport({ "a.example.com": 429 });
		const res = await pool.fetch(cfg, `${A}/x`, undefined, t.fetch);
		expect(res.status).toBe(429);
		expect(t.calls).toHaveLength(1);
		// Traffic stays on the primary for the next request.
		expect(pool.order(cfg)).toEqual([A, B]);
		expect(pool.status(cfg).endpoints[0]).toMatchObject({ healthy: true, lastError: "HTTP 429" });
	});

	test("probe failures cool an endpoint down even with the header timeout disabled", async () => {
		const { pool } = makePool(async (url) => {
			if (url === A) {
				const error = new Error("timed out");
				error.name = "TimeoutError";
				throw error;
			}
			return 30;
		});
		const cfg = config({ strategy: "ordered" });
		await pool.probeAll(cfg);
		expect(pool.order(cfg)).toEqual([B, A]);
	});

	test("idle pools are forgotten, so deleted providers do not linger", async () => {
		const { pool, advance } = makePool();
		await pool.probeAll(config());
		expect(pool.status(config()).endpoints[0]?.probeLatencyMs).toBe(1);
		advance(31 * 60_000);
		pool.tick();
		expect(pool.status(config()).endpoints[0]?.probeLatencyMs).toBeNull();
	});
});
