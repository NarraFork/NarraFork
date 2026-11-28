import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { AuthSessionStore } from "../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";
import * as outbound from "../net/outbound-fetch";
import { type CustomApiProviderConfig, settings } from "../settings";

/**
 * The POST refresh route runs `requireAdmin`, which authorizes against the LIVE role read
 * through the session store, never the token's `role` claim. The middleware below only sets
 * `c.get("user")`, so this seam resolves each principal's role by actor id. The two roles
 * carry distinct subs (below) so a single test can exercise both without the lookup (or its
 * cache) colliding. Without the seam a non-admin would 401 USER_GONE instead of 403.
 */
const OPENCODE_ADMIN_ID = "opencode-admin";
const OPENCODE_USER_ID = "opencode-user";
const sessionStoreSeam: AuthSessionStore = {
	...authSessionStore,
	findSessionState: async (id) => ({
		id,
		role: id === OPENCODE_ADMIN_ID ? "admin" : "user",
		tokenVersion: 0,
	}),
};
setAuthStores({ session: sessionStoreSeam, mfa: authMfaStore });

const originalProviders = settings.customApiProviders;
const originalProxy = settings.proxy;

/** Shape as served by `GET /zen/go/v1/usage` (percent is the share already SPENT). */
const body = {
	usage: {
		rolling: { status: "ok", percent: 37, resetsAt: "2026-10-15T17:56:27.780Z" },
		weekly: { status: "ok", percent: 12, resetsAt: "2026-10-19T00:00:00.000Z" },
		monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-11-15T12:39:31.000Z" },
	},
};

const provider = (): CustomApiProviderConfig => ({
	id: "opencode-test",
	name: "OpenCode Go",
	prefix: "ocg-test",
	protocol: "completions-compatible",
	defaultModel: "glm-5.1",
	baseUrl: "https://opencode.ai/zen/go/v1",
	apiKey: "secret-test-key",
});

let respond: () => Promise<Response> = async () => Response.json(body);

const {
	getOpencodeKeyUsages,
	getOpencodeCachedUsage,
	isOpencodeCustomApiProvider,
	isOpencodeUsageDue,
	noteOpencodeUsageActivity,
	OPENCODE_ACTIVITY_REFRESH_MIN_MS,
	opencodeUsageUrl,
	parseOpencodeUsageResponse,
	refreshAllOpencodeUsages,
	refreshOpencodeUsage,
	refreshStaleOpencodeUsages,
	syncOpencodeUsageCache,
} = await import("../opencode-usage-cache");
const { quotaSnapshotRoutes } = await import("../../routes/quota-snapshots");

beforeEach(() => {
	settings.customApiProviders = [];
	syncOpencodeUsageCache();
	settings.customApiProviders = [provider()];
	settings.proxy = { mode: "direct" };
	respond = async () => Response.json(body);
	spyOn(outbound, "outboundFetch").mockImplementation(async () => respond());
});
afterEach(() => mock.restore());
afterAll(() => {
	setAuthStores(undefined);
	settings.customApiProviders = originalProviders;
	settings.proxy = originalProxy;
	syncOpencodeUsageCache();
});

function deferred() {
	let resolve!: (value: Response) => void;
	const promise = new Promise<Response>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function appForRole(role: "admin" | "user") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		const sub = role === "admin" ? OPENCODE_ADMIN_ID : OPENCODE_USER_ID;
		c.set("user", { sub, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		c.set("auth", { type: "session", user: c.get("user") });
		await next();
	});
	app.onError((error) => {
		const status = (error as { statusCode?: number }).statusCode;
		return new Response("denied", { status: status ?? 500 });
	});
	app.route("/api/quota-snapshots", quotaSnapshotRoutes);
	return app;
}

describe("OpenCode Go usage", () => {
	test("only enabled Go plan endpoints qualify, never the Zen or relay paths", () => {
		for (const suffix of ["", "/"]) {
			expect(
				isOpencodeCustomApiProvider({ baseUrl: `https://opencode.ai/zen/go/v1${suffix}` }),
			).toBe(true);
			expect(
				isOpencodeCustomApiProvider({ baseUrl: `https://opencode.ai/inference/go/v1${suffix}` }),
			).toBe(true);
		}
		// An explicit default port is elided by the URL parser, so it is the same endpoint.
		expect(isOpencodeCustomApiProvider({ baseUrl: "https://opencode.ai:443/zen/go/v1" })).toBe(
			true,
		);
		for (const baseUrl of [
			// Pay-as-you-go Zen has no plan allowance to report.
			"https://opencode.ai/zen/v1",
			"https://opencode.ai/inference/v1",
			"https://opencode.ai/zen/go/v2",
			"http://opencode.ai/zen/go/v1",
			"https://opencode.ai.evil.test/zen/go/v1",
			"https://evil.opencode.ai.test/zen/go/v1",
			"https://opencode.ai:444/zen/go/v1",
			"https://key@opencode.ai/zen/go/v1",
			"https://opencode.ai/zen/go/v1?api_key=secret",
			"https://example.com/zen/go/v1",
			"invalid",
		]) {
			expect(isOpencodeCustomApiProvider({ baseUrl })).toBe(false);
		}
		expect(isOpencodeCustomApiProvider({ baseUrl: provider().baseUrl, disabled: true })).toBe(
			false,
		);
	});

	test("derives the usage endpoint from the configured base URL", () => {
		expect(opencodeUsageUrl("https://opencode.ai/zen/go/v1")).toBe(
			"https://opencode.ai/zen/go/v1/usage",
		);
		expect(opencodeUsageUrl("https://opencode.ai/inference/go/v1/")).toBe(
			"https://opencode.ai/inference/go/v1/usage",
		);
	});

	test("parses the three windows and tolerates a missing or unknown field", () => {
		expect(parseOpencodeUsageResponse(body)).toEqual({
			rolling: { status: "ok", percent: 37, resetsAt: "2026-10-15T17:56:27.780Z" },
			weekly: { status: "ok", percent: 12, resetsAt: "2026-10-19T00:00:00.000Z" },
			monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-11-15T12:39:31.000Z" },
		});
		// A renamed window or a new field must cost one line of the display, not the
		// whole refresh: the endpoint is undocumented and may change shape.
		expect(
			parseOpencodeUsageResponse({
				usage: { rolling: { status: "weird", percent: 130, resetsAt: "not a date" } },
			}),
		).toEqual({
			rolling: { status: null, percent: 100, resetsAt: null },
			weekly: null,
			monthly: null,
		});
		expect(parseOpencodeUsageResponse({ usage: { rolling: null } })).toEqual({
			rolling: null,
			weekly: null,
			monthly: null,
		});
		expect(parseOpencodeUsageResponse({ usage: {} })).toEqual({
			rolling: null,
			weekly: null,
			monthly: null,
		});
		// Structurally wrong envelopes are rejected rather than parsed into nonsense.
		for (const invalid of [null, {}, { usage: null }, { usage: "x" }]) {
			expect(() => parseOpencodeUsageResponse(invalid)).toThrow();
		}
	});

	test("uses the provider's base URL, bearer and proxy/TLS, and disallows redirects", async () => {
		settings.customApiProviders = [
			{
				...provider(),
				proxy: { mode: "custom", url: "http://localhost:1234" },
				tlsRejectUnauthorized: false,
			},
		];
		const fetchSpy = spyOn(outbound, "outboundFetch").mockImplementation(async () => respond());
		await refreshOpencodeUsage("opencode-test");
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://opencode.ai/zen/go/v1/usage",
			expect.objectContaining({
				headers: {
					Authorization: "Bearer secret-test-key",
					"x-api-key": "secret-test-key",
					Accept: "application/json",
				},
				redirect: "error",
				signal: expect.any(AbortSignal),
			}),
			{ proxyUrl: "http://localhost:1234", tlsRejectUnauthorized: false, retryPolicy: "never" },
		);
	});

	test("coalesces concurrent refresh and bulk/stale readers", async () => {
		const pending = deferred();
		respond = () => pending.promise;
		const fetchSpy = spyOn(outbound, "outboundFetch").mockImplementation(async () => respond());
		const first = refreshOpencodeUsage("opencode-test");
		expect(refreshOpencodeUsage("opencode-test")).toBe(first);
		const bulk = refreshAllOpencodeUsages();
		const stale = refreshStaleOpencodeUsages();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		pending.resolve(Response.json(body));
		await Promise.all([first, bulk, stale]);
		await refreshStaleOpencodeUsages();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	test("60s SWR keeps stale percentages on failure but replaces the error text", async () => {
		let now = 100_000;
		spyOn(Date, "now").mockImplementation(() => now);
		const fetchSpy = spyOn(outbound, "outboundFetch").mockImplementation(async () => respond());
		await refreshOpencodeUsage("opencode-test");
		now += 59_999;
		await refreshStaleOpencodeUsages();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		now++;
		respond = async () => {
			throw new Error("secret-test-key upstream private error");
		};
		await refreshStaleOpencodeUsages();
		const cache = getOpencodeKeyUsages()["opencode-test"];
		expect(cache?.rolling?.percent).toBe(37);
		// Never copy transport exceptions, response text, or credentials to the API.
		expect(cache?.error).toBe("OpenCode usage request failed");
		expect(cache?.fetchedAt).toBe(now);
		await refreshStaleOpencodeUsages();
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	for (const change of [
		"apiKey",
		"baseUrl",
		"disabled",
		"proxy",
		"tls",
		"globalProxy",
		"remove",
	] as const) {
		test(`${change} invalidates the cache and rejects a late old request`, async () => {
			const pending = deferred();
			respond = () => pending.promise;
			const first = refreshOpencodeUsage("opencode-test");
			const config = settings.customApiProviders?.[0];
			if (!config) throw new Error("missing fixture");
			if (change === "apiKey") config.apiKey = "new-account";
			if (change === "baseUrl") config.baseUrl = "https://opencode.ai/inference/go/v1";
			if (change === "disabled") config.disabled = true;
			if (change === "proxy") config.proxy = { mode: "direct" };
			if (change === "tls") config.tlsRejectUnauthorized = false;
			if (change === "globalProxy")
				settings.proxy = { mode: "custom", url: "http://localhost:4321" };
			if (change === "remove") settings.customApiProviders = [];
			const current = getOpencodeKeyUsages();
			expect(current["opencode-test"]?.rolling ?? null).toBeNull();
			pending.resolve(Response.json(body));
			expect(await first).toBeNull();
			expect(getOpencodeKeyUsages()["opencode-test"]?.rolling ?? null).toBeNull();
		});
	}

	test("switching protocol keeps the allowance: it does not change what the endpoint returns", async () => {
		await refreshOpencodeUsage("opencode-test");
		const fetchSpy = spyOn(outbound, "outboundFetch").mockImplementation(async () => respond());
		// Count relative to here: `beforeEach` installs a spy and the refresh above ran
		// through it, so an absolute call count would be pre-loaded.
		const callsSoFar = fetchSpy.mock.calls.length;
		// The `opencode` preset serves all three protocols from one base URL, so an admin
		// switching format must not blank the indicator nor spend an upstream call. Were
		// `protocol` part of the identity, this would rotate the generation, reset the entry
		// to `fetchedAt: 0`, and make the stale sweep below re-fetch it.
		settings.customApiProviders = [{ ...provider(), protocol: "anthropic-messages" }];
		expect(getOpencodeKeyUsages()["opencode-test"]?.rolling?.percent).toBe(37);
		await refreshStaleOpencodeUsages();
		expect(fetchSpy.mock.calls.length).toBe(callsSoFar);
	});

	test("unrelated display edits retain the existing allowance", async () => {
		await refreshOpencodeUsage("opencode-test");
		settings.customApiProviders = [{ ...provider(), name: "Renamed" }];
		expect(getOpencodeCachedUsage("opencode-test")?.rolling?.percent).toBe(37);
	});

	test("a completed allowance disappears on credential change, disable and removal", async () => {
		await refreshOpencodeUsage("opencode-test");
		expect(getOpencodeKeyUsages()["opencode-test"]?.rolling?.percent).toBe(37);
		settings.customApiProviders = [{ ...provider(), apiKey: "other-account" }];
		expect(getOpencodeKeyUsages()["opencode-test"]?.rolling ?? null).toBeNull();
		await refreshOpencodeUsage("opencode-test");
		settings.customApiProviders = [{ ...provider(), disabled: true }];
		expect(getOpencodeKeyUsages()).toEqual({});
		settings.customApiProviders = [];
		expect(await refreshOpencodeUsage("opencode-test")).toBeNull();
	});

	test("missing credentials and non-Go providers never trigger transport", async () => {
		settings.customApiProviders = [
			{ ...provider(), apiKey: "" },
			{ ...provider(), id: "third-party", baseUrl: "https://example.com/v1" },
			{ ...provider(), id: "zen", baseUrl: "https://opencode.ai/zen/v1" },
		];
		const fetchSpy = spyOn(outbound, "outboundFetch").mockImplementation(async () => respond());
		await refreshAllOpencodeUsages();
		expect(getOpencodeKeyUsages()).toEqual({});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("an old finalizer cannot clear the replacement request's inflight slot", async () => {
		const old = deferred();
		respond = () => old.promise;
		const first = refreshOpencodeUsage("opencode-test");
		settings.customApiProviders = [{ ...provider(), apiKey: "new" }];
		const current = deferred();
		respond = () => current.promise;
		const second = refreshOpencodeUsage("opencode-test");
		old.resolve(Response.json(body));
		await first;
		expect(refreshOpencodeUsage("opencode-test")).toBe(second);
		current.resolve(Response.json({ usage: { rolling: { status: "ok", percent: 5 } } }));
		expect((await second)?.rolling?.percent).toBe(5);
	});

	test("bounds declared and streamed response size and fails safely on bad payloads", async () => {
		for (const response of [
			new Response("private secret-test-key", { status: 401 }),
			new Response("private secret-test-key", { status: 403 }),
			new Response("not json"),
			new Response("{}"),
			// Structurally invalid payloads: rejected by the parser, not the size guard.
		]) {
			respond = async () => response;
			const cache = await refreshOpencodeUsage("opencode-test");
			expect(cache?.error).toBe("OpenCode usage request failed");
			expect(JSON.stringify(cache)).not.toContain("secret-test-key");
		}
	});

	/**
	 * The size guard needs payloads that are VALID usage JSON and merely too big.
	 *
	 * A malformed oversized body proves nothing: it would be rejected by the parser
	 * even with the guard deleted, so the assertion could never fail. (The DeepSeek
	 * suite this was modelled on has exactly that hole — it feeds `"{}"` behind a
	 * declared length and 70k zero bytes as a stream, both of which fail parsing on
	 * their own.) These fixtures keep the size guard the only reason to reject, and
	 * carry a DIFFERENT percentage so that applying them would be observable.
	 */
	test("rejects an oversized declared length and an oversized streamed body", async () => {
		await refreshOpencodeUsage("opencode-test");
		expect(getOpencodeKeyUsages()["opencode-test"]?.rolling?.percent).toBe(37);

		// A small, valid body that LIES about its length: only the declared-length branch
		// can refuse it, since the body itself would parse fine.
		const lying = new Response(JSON.stringify({ ...body, padding: " ".repeat(0) }), {
			headers: { "content-length": "65537" },
		});
		expect(lying.headers.get("content-length")).toBe("65537");
		respond = async () => lying;
		expect((await refreshOpencodeUsage("opencode-test"))?.error).toBe(
			"OpenCode usage request failed",
		);

		// With no declared length the cap has to be enforced while streaming. The payload
		// is valid JSON reporting 99% used, so a guard that let it through would show 99.
		const oversized = JSON.stringify({
			...body,
			usage: { ...body.usage, rolling: { status: "ok", percent: 99, resetsAt: null } },
			padding: " ".repeat(70_000),
		});
		const streamed = new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(oversized));
					controller.close();
				},
			}),
		);
		expect(streamed.headers.get("content-length")).toBeNull();
		respond = async () => streamed;
		await refreshOpencodeUsage("opencode-test");

		const cache = getOpencodeKeyUsages()["opencode-test"];
		expect(cache?.error).toBe("OpenCode usage request failed");
		// The oversized body was never applied: the previous allowance survived, so an
		// under-reported length cannot smuggle a truncated reading into the display.
		expect(cache?.rolling?.percent).toBe(37);
	});

	test("the 15s deadline covers both a stalled transport and a stalled response body", async () => {
		// Shrink only this deadline: waiting 15s for real would dominate the suite.
		const originalTimeout = globalThis.setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
			ms: number,
		) => originalTimeout(callback, ms === 15_000 ? 5 : ms)) as typeof setTimeout);

		// Transport that never answers.
		respond = () => new Promise(() => {});
		expect((await refreshOpencodeUsage("opencode-test"))?.error).not.toBeNull();

		// Transport that answers with a body which never produces a chunk: the abort
		// must reach the reader, or this refresh would hold its slot forever.
		let cancelled = false;
		respond = async () =>
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
			);
		expect((await refreshOpencodeUsage("opencode-test"))?.error).not.toBeNull();
		expect(cancelled).toBe(true);
		expect(timer.mock.calls.some(([, ms]) => ms === 15_000)).toBe(true);
	});

	test("GET answers from the snapshot without waiting on upstream", async () => {
		const pending = deferred();
		respond = () => pending.promise;
		// A cold read must not block on the upstream call it just started.
		const cold = await appForRole("user").request("/api/quota-snapshots");
		expect(
			(await cold.json()).entries.find(
				(entry: { groupId: string }) => entry.groupId === "opencode-test",
			),
		).toMatchObject({ snapshot: null, credentialId: null });
		pending.resolve(Response.json(body));
		await refreshAllOpencodeUsages();
		const warm = await appForRole("user").request("/api/quota-snapshots");
		const entry = (await warm.json()).entries.find(
			(entry: { groupId: string }) => entry.groupId === "opencode-test",
		);
		expect(entry.snapshot.windows).toContainEqual({
			kind: "5h",
			usedRatio: 0.37,
			resetsAt: Date.parse(body.usage.rolling.resetsAt),
		});
		expect(entry.snapshot.hasError).toBe(false);
	});

	test("a failed refresh becomes hasError for users and stays visible only to admins", async () => {
		respond = async () => {
			throw new Error("upstream said https://internal.example (key sk-live-abc)");
		};
		await refreshAllOpencodeUsages();

		const userBody = await (await appForRole("user").request("/api/quota-snapshots")).text();
		const userEntry = JSON.parse(userBody).entries.find(
			(entry: { groupId: string }) => entry.groupId === "opencode-test",
		).snapshot;
		expect(userEntry).toMatchObject({ hasError: true });
		expect(userEntry.error).toBe("quota_unavailable");
		// The failure text is the deployment's business, not the reader's.
		expect(userBody).not.toContain("internal.example");
		expect(userBody).not.toContain("sk-live-abc");

		const adminEntry = JSON.parse(
			await (await appForRole("admin").request("/api/quota-snapshots")).text(),
		).entries.find((entry: { groupId: string }) => entry.groupId === "opencode-test").snapshot;
		// Administrators also receive only a fixed safe error code.
		expect(adminEntry).toMatchObject({ error: "quota_unavailable", hasError: true });
	});

	test("POST refresh is admin-only", async () => {
		expect(
			(await appForRole("user").request("/api/quota-snapshots/refresh", { method: "POST" })).status,
		).toBe(403);
		expect(
			(await appForRole("admin").request("/api/quota-snapshots/refresh", { method: "POST" }))
				.status,
		).toBe(200);
	});

	test("settings retires legacy quota generations for users and admins without exposing credentials", async () => {
		const { settingsRoutes } = await import("../../routes/settings");
		for (const role of ["user", "admin"] as const) {
			const app = appForRole(role);
			app.route("/api/settings", settingsRoutes);
			const response = await app.request("/api/settings");
			expect(response.status).toBe(200);
			const projection = await response.json();
			expect(projection).not.toHaveProperty("opencodeUsageGenerations");
			expect(projection).not.toHaveProperty("deepseekBalanceGenerations");
			expect(projection.customApiProviders[0].apiKey).not.toBe(provider().apiKey);
		}
		// Legacy source-specific generations are no longer part of the settings response.
		expect(settings).not.toHaveProperty("opencodeUsageGenerations");
		expect(settings.customApiProviders?.[0]).not.toHaveProperty("generation");
	});
});

describe("OpenCode Go usage: optional fields and refresh policy", () => {
	test("reads absolute amounts and a balance when present, and derives percent only from them", () => {
		const parsed = parseOpencodeUsageResponse({
			usage: {
				rolling: { status: "ok", used: 1.5, limit: 6, resetsAt: 1_792_500_000 },
				weekly: { status: "rate-limited", percent: 100, used: "15", quota: "15" },
				monthly: { percent: 40 },
				balance: { amount: 12.34 },
			},
		});
		expect(parsed.rolling).toEqual({
			status: "ok",
			percent: 25,
			resetsAt: new Date(1_792_500_000 * 1000).toISOString(),
			used: 1.5,
			limit: 6,
		});
		expect(parsed.weekly).toMatchObject({ percent: 100, used: 15, limit: 15 });
		expect(parsed.monthly).toEqual({ status: null, percent: 40, resetsAt: null });
		expect(parsed.balance).toBe(12.34);
	});

	test("a zero limit or a lone amount never fabricates a ratio", () => {
		const parsed = parseOpencodeUsageResponse({
			usage: { rolling: { status: "ok", used: 3, limit: 0 }, weekly: { used: 3 } },
		});
		expect(parsed.rolling).toEqual({ status: "ok", percent: null, resetsAt: null });
		expect(parsed.weekly).toBeNull();
		expect(parsed).not.toHaveProperty("balance");
	});

	const cacheAt = (fetchedAt: number, rollingReset: string | null = null) => ({
		generation: "g",
		fetchedAt,
		error: null,
		rolling: { status: "ok" as const, percent: 10, resetsAt: rollingReset },
		weekly: null,
		monthly: null,
	});

	test("failures back off exponentially up to ten minutes", () => {
		const fetchedAt = 1_000_000;
		const due = (failures: number, after: number) =>
			isOpencodeUsageDue({ cache: cacheAt(fetchedAt), failures }, fetchedAt + after);
		expect(due(1, 59_999)).toBe(false);
		expect(due(1, 60_000)).toBe(true);
		expect(due(2, 119_999)).toBe(false);
		expect(due(2, 120_000)).toBe(true);
		expect(due(10, 599_999)).toBe(false);
		expect(due(10, 600_000)).toBe(true);
	});

	test("a window that reset since the fetch makes the entry due early", () => {
		const fetchedAt = Date.parse("2026-10-19T12:00:00Z");
		const entry = { cache: cacheAt(fetchedAt, "2026-10-19T12:00:10Z"), failures: 0 };
		expect(isOpencodeUsageDue(entry, fetchedAt + 5_000)).toBe(false);
		expect(isOpencodeUsageDue(entry, fetchedAt + 10_000)).toBe(true);
	});

	test("request activity schedules one throttled refresh per provider", async () => {
		const timers: Array<() => void> = [];
		const delays: number[] = [];
		const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
			fn: () => void,
			delay: number,
		) => {
			timers.push(fn);
			delays.push(delay);
			return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
		}) as unknown as typeof setTimeout);
		const fetchSpy = spyOn(outbound, "outboundFetch").mockImplementation(async () => respond());
		try {
			noteOpencodeUsageActivity("ocg-test");
			noteOpencodeUsageActivity("opencode-test");
			noteOpencodeUsageActivity("not-a-provider");
			expect(timers).toHaveLength(1);
			// Never fetched: no throttle to wait out.
			expect(delays[0]).toBe(0);
			timeoutSpy.mockRestore();
			timers[0]?.();
			await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(getOpencodeCachedUsage("opencode-test")?.fetchedAt).toBeGreaterThan(0);
		} finally {
			timeoutSpy.mockRestore();
		}
		// Right after a fetch the next nudge waits out the throttle.
		const later: number[] = [];
		const again = spyOn(globalThis, "setTimeout").mockImplementation(((
			_fn: () => void,
			delay: number,
		) => {
			later.push(delay);
			return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
		}) as unknown as typeof setTimeout);
		try {
			noteOpencodeUsageActivity("ocg-test");
			expect(later[0]).toBeGreaterThan(OPENCODE_ACTIVITY_REFRESH_MIN_MS - 1_000);
		} finally {
			again.mockRestore();
		}
	});
});
