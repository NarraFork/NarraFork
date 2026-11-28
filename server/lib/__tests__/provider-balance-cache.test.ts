import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { readFileSync } from "node:fs";
import type { ProviderQuotaData, QuotaQueryResult } from "@shared/provider-quota";
import { parseSub2ApiBalance, relayQuotaData } from "../../../plugins/provider-quota/src/relay";
import { parsePersistedProviderQuota } from "../../services/provider-quota-persistence";
import { clearKeyCooldown, reportKeyFault, selectProviderKey } from "../agent/pooled-provider";
import { ApiError } from "../agent/types";
import { refreshAllDeepSeekBalances } from "../deepseek-balance-cache";
import { refreshAllKimiUsages } from "../kimi-usage-cache";
import type { outboundFetch } from "../net/outbound-fetch";
import { refreshAllOpencodeUsages } from "../opencode-usage-cache";
import { createPersistedCredentialCache } from "../persisted-credential-cache";
import {
	isProviderBalanceCandidate,
	providerBalanceCache,
	toProviderBalanceSnapshot,
} from "../provider-balance-cache";
import { getProviderKeyStore } from "../provider-keys";
import { settings } from "../settings";
import {
	archivedQuotaFixture,
	bindLegacyQuotaService,
	closeQuotaTestPackage,
	deferred,
	httpQuotaFixture,
	legacyQuotaFixture,
	quotaConfig,
	quotaSnapshot,
	required,
	walletQuota,
} from "./provider-quota-legacy-fixture";

let fixture: ReturnType<typeof legacyQuotaFixture>;
let testProviderId = "relay-test";
const originalProxy = settings.proxy;
beforeEach(() => {
	testProviderId = "relay-test";
	fixture = legacyQuotaFixture();
});
afterEach(() => {
	fixture.dispose();
	settings.proxy = originalProxy;
	mock.restore();
});

describe("provider balance compatibility facade", () => {
	test("only the legacy view excludes dedicated endpoints; the generic directory includes them", () => {
		expect(isProviderBalanceCandidate(quotaConfig())).toBe(true);
		for (const baseUrl of [
			"https://api.deepseek.com",
			"https://api.kimi.com",
			"https://opencode.ai/zen/go/v1",
		]) {
			expect(isProviderBalanceCandidate(quotaConfig({ baseUrl }))).toBe(false);
		}
		expect(isProviderBalanceCandidate(quotaConfig({ disabled: true }))).toBe(false);
		expect(isProviderBalanceCandidate(quotaConfig({ apiKey: "" }))).toBe(false);
	});

	test("translates format, currency, subscription metadata and window hints without private cursor state", () => {
		const result = toProviderBalanceSnapshot(
			quotaSnapshot({
				data: {
					format: "new-api",
					scope: "subscription",
					unlimited: false,
					windows: [],
					planName: "Test plan",
					expiresAt: "2026-12-01T00:00:00Z",
					amounts: [
						{
							id: "amount:0",
							unit: "QUOTA",
							remaining: 17,
							used: 3,
							total: 20,
							window: "daily",
							windowStart: "2026-10-31T00:00:00Z",
						},
					],
				},
			}),
		);
		expect(result).toMatchObject({
			adapter: "new-api",
			status: "supported",
			balance: {
				scope: "subscription",
				unlimited: false,
				planName: "Test plan",
				expiresAt: "2026-12-01T00:00:00Z",
				amounts: [
					{
						unit: "QUOTA",
						remaining: 17,
						used: 3,
						total: 20,
						window: "daily",
						windowStart: "2026-10-31T00:00:00Z",
					},
				],
			},
		});
		expect(result).not.toHaveProperty("cursor");
		expect(result.balance?.amounts[0]).not.toHaveProperty("id");
	});

	test("normalizing Sub2API windows retains finite limits and subscription metadata; zero means no cap", () => {
		const balance = parseSub2ApiBalance({
			mode: "unrestricted",
			isValid: true,
			unit: "USD",
			planName: "Plan",
			subscription: {
				daily_limit_usd: 10,
				daily_usage_usd: 1,
				weekly_limit_usd: 50,
				weekly_usage_usd: 5,
				monthly_limit_usd: 0,
				monthly_usage_usd: 0,
				weekly_window_start: "2026-11-09T00:00:00+08:00",
				expires_at: "2027-01-01T00:00:00+08:00",
			},
		});
		if (!balance) throw new Error("expected subscription balance");
		const data = relayQuotaData(balance, "sub2api");
		expect(data.windows).toHaveLength(2);
		const result = toProviderBalanceSnapshot(quotaSnapshot({ data }));
		expect(result.status).toBe("supported");
		expect(result.balance).toEqual(balance);
		expect(result.balance?.amounts).toEqual([
			{ unit: "USD", remaining: 9, used: 1, total: 10, window: "daily" },
			{
				unit: "USD",
				remaining: 45,
				used: 5,
				total: 50,
				window: "weekly",
				windowStart: "2026-11-08T16:00:00.000Z",
			},
		]);
		expect(result.balance).toMatchObject({
			planName: "Plan",
			expiresAt: "2026-12-31T16:00:00.000Z",
		});
		expect(data.windows.every((window) => window.remaining !== 0)).toBe(true);
	});

	test("legacy projection validates new semantic fields before its explicit DTO projection", () => {
		for (const invalid of [
			{ id: "amount:0", unit: "USD", remaining: 1, display: "hidden" },
			{ id: "amount:0", unit: "USD", remaining: 1, quota: "optional" },
			{ id: "amount:0", unit: "USD", remaining: 1, remainingText: "2.00" },
			{ id: "amount:0", unit: "USD", remaining: 1, apiKey: "private-key" },
		]) {
			const result = toProviderBalanceSnapshot(
				quotaSnapshot({
					data: { ...walletQuota, amounts: [invalid] } as unknown as ProviderQuotaData,
				}),
			);
			expect(result).toMatchObject({ status: "error", balance: null, error: "invalid_response" });
			expect(JSON.stringify(result)).not.toContain("private-key");
		}
	});

	test("unknown amounts and third-party formats do not turn into zero or unlimited", () => {
		const result = toProviderBalanceSnapshot(
			quotaSnapshot({
				data: {
					...walletQuota,
					amounts: [{ id: "amount:0", unit: "USD", remaining: null, used: null, total: null }],
				},
			}),
		);
		expect(result.balance).toEqual({
			scope: "wallet",
			unlimited: false,
			amounts: [{ unit: "USD", remaining: null }],
		});
		expect(
			toProviderBalanceSnapshot(quotaSnapshot({ data: { ...walletQuota, format: "third-party" } }))
				.balance,
		).toBeNull();
	});

	test("reads are nonblocking and schedule only the selected provider", async () => {
		settings.customApiProviders = [quotaConfig(), quotaConfig({ id: "second", prefix: "second" })];
		const pending = deferred<QuotaQueryResult>();
		fixture.query.mockImplementation(() => pending.promise);
		const read = providerBalanceCache.read(testProviderId);
		expect(Object.keys(read)).toEqual([testProviderId]);
		expect(fixture.query).toHaveBeenCalledTimes(1);
		expect(fixture.query.mock.calls[0]?.[1].providerId).toBe(testProviderId);
		pending.resolve({ status: "supported", data: walletQuota, error: null });
		await providerBalanceCache.request(testProviderId);
		expect(providerBalanceCache.peek(testProviderId)?.balance?.amounts[0]?.remaining).toBe(12);
	});

	test("all concurrent facade callers share the generic source job", async () => {
		const pending = deferred<QuotaQueryResult>();
		fixture.query.mockImplementation(() => pending.promise);
		const first = providerBalanceCache.request(testProviderId);
		const second = providerBalanceCache.request(testProviderId);
		providerBalanceCache.read(testProviderId);
		expect(fixture.query).toHaveBeenCalledTimes(1);
		pending.resolve({ status: "supported", data: walletQuota, error: null });
		expect(await second).toEqual(await first);
	});

	test("refreshing keeps a supported balance from the same generation until a result arrives", async () => {
		await providerBalanceCache.request(testProviderId);
		const before = providerBalanceCache.peek(testProviderId);
		fixture.advance(10_000);
		const pending = deferred<QuotaQueryResult>();
		fixture.query.mockImplementation(() => pending.promise);
		const refresh = providerBalanceCache.request(testProviderId);
		expect(fixture.service.peek(testProviderId)?.status).toBe("probing");
		expect(providerBalanceCache.peek(testProviderId)).toMatchObject({
			generation: before?.generation,
			status: "supported",
			balance: before?.balance,
			fetchedAt: before?.fetchedAt,
			error: null,
		});
		pending.resolve({ status: "supported", data: walletQuota, error: null });
		await refresh;
	});

	test("unsupported or unavailable projections hide even a supplied previous good value", () => {
		for (const status of ["unsupported", "unavailable"] as const) {
			expect(toProviderBalanceSnapshot(quotaSnapshot({ status })).balance).toBeNull();
		}
	});

	test("manual cooldown is shared with the generic endpoint and never a second timer", async () => {
		await providerBalanceCache.request(testProviderId);
		expect(providerBalanceCache.manualRetryAfterMs(testProviderId)).toBe(10_000);
		await providerBalanceCache.request(testProviderId);
		expect(fixture.query).toHaveBeenCalledTimes(1);
		fixture.advance(10_000);
		await providerBalanceCache.request(testProviderId);
		expect(fixture.query).toHaveBeenCalledTimes(2);
	});

	test("retains a safe stale balance after errors and respects service retry cadence", async () => {
		await providerBalanceCache.request(testProviderId);
		fixture.advance(60_000);
		fixture.query.mockRejectedValue(new Error("test-secret-key private upstream body"));
		await fixture.service.refreshStale();
		// refreshStale only schedules work; join the shared job before asserting its error.
		await fixture.service.refresh(testProviderId);
		const stale = providerBalanceCache.peek(testProviderId);
		expect(stale).toMatchObject({
			status: "supported",
			error: "request_failed",
			balance: { amounts: [{ remaining: 12 }] },
		});
		expect(JSON.stringify(stale)).not.toMatch(/test-secret-key|private upstream/);
		await fixture.service.refreshStale();
		expect(fixture.query).toHaveBeenCalledTimes(2);
	});

	test("unavailable sources do not expose a previous allowance or fetch through old adapters", async () => {
		await providerBalanceCache.request(testProviderId);
		fixture.revoke();
		expect(providerBalanceCache.peek(testProviderId)).toMatchObject({
			status: "error",
			error: "plugin_not_enabled",
			balance: null,
		});
		await providerBalanceCache.request(testProviderId);
		expect(fixture.query).toHaveBeenCalledTimes(1);
	});

	for (const [field, replacement] of [
		["apiKey", "replacement-key"],
		["baseUrl", "https://other.invalid/v1"],
		["protocol", "responses-compatible"],
		["proxy", { mode: "direct" }],
		["tlsRejectUnauthorized", false],
		["extraHeaders", { "x-quota": "changed" }],
	] as const) {
		test(`${field} changes immediately invalidate the facade generation and balance`, async () => {
			await providerBalanceCache.request(testProviderId);
			const generation = providerBalanceCache.generations()[testProviderId];
			settings.customApiProviders = [quotaConfig({ [field]: replacement })];
			const snapshot = providerBalanceCache.peek(testProviderId);
			expect(snapshot?.generation).not.toBe(generation);
			expect(snapshot?.balance).toBeNull();
		});
	}

	test("renames preserve opaque generations but account reuse never restores an earlier one", () => {
		const generation = providerBalanceCache.generations()[testProviderId];
		settings.customApiProviders = [quotaConfig({ name: "Renamed" })];
		expect(providerBalanceCache.generations()[testProviderId]).toBe(generation);
		settings.customApiProviders = [quotaConfig({ apiKey: "second-key" })];
		const second = providerBalanceCache.generations()[testProviderId];
		expect(second).not.toBe(generation);
		settings.customApiProviders = [quotaConfig()];
		expect(providerBalanceCache.generations()[testProviderId]).not.toBe(generation);
		expect(generation).not.toContain("test-secret-key");
	});

	test("disabled and removed IDs cannot be read or refreshed through the facade", async () => {
		settings.customApiProviders = [quotaConfig({ disabled: true })];
		expect(providerBalanceCache.peek(testProviderId)).toBeNull();
		expect(await providerBalanceCache.request(testProviderId)).toBeNull();
		settings.customApiProviders = [];
		expect(providerBalanceCache.read()).toEqual({});
		expect(fixture.query).not.toHaveBeenCalled();
	});

	test("the compatibility module owns no active transport, persistent cache or timer", () => {
		const source = readFileSync(new URL("../provider-balance-cache.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(
			/outboundFetch|provider-balance-adapters|provider-balance-transport|createPersistedCredentialCache|setTimeout|setInterval|new Map/,
		);
	});
});

const keyProviders = new Set<string>();
afterEach(() => {
	const store = getProviderKeyStore();
	for (const id of keyProviders) {
		for (const key of store.list(id)) clearKeyCooldown(key.id);
		store.removeProvider(id);
	}
	keyProviders.clear();
});
async function replaceWithHttp(
	config: ReturnType<typeof quotaConfig>,
	fetch: typeof outboundFetch,
	persistence?: NonNullable<Parameters<typeof httpQuotaFixture>[1]>["persistence"],
) {
	fixture.dispose();
	mock.restore();
	const f = await httpQuotaFixture([config], { fetch, persistence });
	fixture = f;
	return f;
}

describe("upstream relay discovery lifecycle retained in the service", () => {
	test("successful fallback discovery coalesces and stale reads reuse only its confirmed endpoint", async () => {
		const urls: string[] = [];
		await replaceWithHttp(quotaConfig(), async (url) => {
			urls.push(String(url));
			return String(url).endsWith("/v1/v1/usage")
				? Response.json({ mode: "unrestricted", isValid: true, unit: "USD", balance: 12 })
				: new Response(null, { status: 404 });
		});
		const [a, b] = await Promise.all([
			providerBalanceCache.request(testProviderId),
			providerBalanceCache.request(testProviderId),
		]);
		expect(a).toEqual(b);
		expect(urls.at(-1)).toBe("https://relay.invalid/v1/v1/usage");
		urls.length = 0;
		fixture.advance(60000);
		providerBalanceCache.read(testProviderId);
		await fixture.service.refresh(testProviderId);
		expect(urls).toEqual(["https://relay.invalid/v1/v1/usage"]);
	});
	test("unsupported is discovered once and reads do not probe inside the unsupported backoff", async () => {
		let calls = 0;
		await replaceWithHttp(quotaConfig(), async () => {
			calls++;
			return new Response(null, { status: 404 });
		});
		expect(await providerBalanceCache.request(testProviderId)).toMatchObject({
			status: "unsupported",
			balance: null,
		});
		const count = calls;
		providerBalanceCache.read();
		fixture.advance(60000);
		providerBalanceCache.read();
		expect(calls).toBe(count);
		await providerBalanceCache.request(testProviderId, "probe");
		expect(calls).toBeGreaterThan(count);
	});
	test("relay transient failure preserves last good value only inside the same ten-minute window", async () => {
		let failed = false;
		await replaceWithHttp(quotaConfig(), async () =>
			failed
				? new Response(null, { status: 500 })
				: Response.json({ mode: "unrestricted", isValid: true, unit: "USD", balance: 12 }),
		);
		const fresh = await providerBalanceCache.request(testProviderId);
		failed = true;
		fixture.advance(60000);
		expect(await providerBalanceCache.request(testProviderId, "refresh")).toMatchObject({
			status: "supported",
			error: "request_failed",
			balance: fresh?.balance,
			fetchedAt: fresh?.fetchedAt,
		});
		fixture.advance(540001);
		expect(await providerBalanceCache.request(testProviderId, "refresh")).toMatchObject({
			status: "error",
			error: "request_failed",
			balance: null,
		});
	});
	test("name/prefix/model and header ordering changes preserve the same discovered generation", async () => {
		const config = quotaConfig({ extraHeaders: { "X-B": "b", "X-A": "a" } });
		await replaceWithHttp(config, async () =>
			Response.json({ mode: "unrestricted", isValid: true, unit: "USD", balance: 12 }),
		);
		const fresh = await providerBalanceCache.request(config.id);
		settings.customApiProviders = [
			{
				...config,
				name: "renamed",
				prefix: "new-prefix",
				defaultModel: "other-model",
				extraHeaders: { "X-A": "a", "X-B": "b" },
			},
		];
		expect(providerBalanceCache.peek(config.id)).toEqual(fresh);
	});
	test("optional public metadata timeout keeps already-confirmed raw new-api amounts", async () => {
		fixture.dispose();
		mock.restore();
		fixture = await httpQuotaFixture([quotaConfig()], {
			requestTimeoutMs: 10,
			fetch: async (url) => {
				if (String(url).endsWith("/api/usage/token/"))
					return Response.json({
						code: true,
						data: {
							object: "token_usage",
							unlimited_quota: false,
							total_available: 500000,
							total_used: 100000,
							total_granted: 600000,
						},
					});
				if (String(url).endsWith("/api/status")) return new Promise(() => {});
				return new Response(null, { status: 404 });
			},
		});
		expect(await providerBalanceCache.request(testProviderId)).toMatchObject({
			status: "supported",
			adapter: "new-api",
			balance: { amounts: [{ unit: "QUOTA", remaining: 500000, used: 100000, total: 600000 }] },
		});
	});
});

describe("site account credit through the quota service", () => {
	let site: Awaited<ReturnType<typeof archivedQuotaFixture>>;
	let currentPersistence: NonNullable<Parameters<typeof httpQuotaFixture>[1]>["persistence"];
	let siteNow = Date.now();
	beforeAll(async () => {
		site = await archivedQuotaFixture({
			now: () => siteNow,
			persistence: {
				restore: (key, identity) => currentPersistence?.restore(key, identity),
				save: (key, identity, value) => currentPersistence?.save(key, identity, value),
				remove: (key) => currentPersistence?.remove(key),
				flush: async () => {
					await currentPersistence?.flush();
				},
			},
		});
	});
	beforeEach(() => {
		testProviderId = `site-${crypto.randomUUID().slice(0, 16)}`;
		keyProviders.add(testProviderId);
	});
	const fixture = {
		advance: (ms: number) => {
			siteNow += ms;
		},
	};
	async function replaceWithSite(
		config: ReturnType<typeof quotaConfig>,
		fetch: typeof outboundFetch,
		persistence?: NonNullable<Parameters<typeof httpQuotaFixture>[1]>["persistence"],
	) {
		siteNow = Date.now();
		currentPersistence = persistence;
		site.setTestHttp(fetch);
		bindLegacyQuotaService(site.service);
		await site.prepareProviders([config]);
		return { directory: site.directory, query: spyOn(site.platform.quotaRegistry, "query") };
	}
	afterEach(async () => {
		site?.setProviders([]);
		await currentPersistence?.flush();
		currentPersistence = undefined;
	});
	afterAll(async () => {
		await site?.close();
		await closeQuotaTestPackage();
	});
	const config = () =>
		quotaConfig({
			id: testProviderId,
			quotaSiteUrl: "https://site.invalid",
			quotaAccessToken: "site-token",
			quotaUserId: "42",
		});
	const body = { success: true, data: { quota: 5_000_000, used_quota: 1_000_000, group: "vip" } };
	test("queries the independent site root, reports USD and never sends the inference key", async () => {
		const calls: Array<{ url: string; headers: Headers }> = [];
		await replaceWithSite(config(), async (url, init) => {
			calls.push({ url: String(url), headers: new Headers(init?.headers) });
			return Response.json(body);
		});
		const snapshot = await providerBalanceCache.request(testProviderId);
		expect(calls.map(({ url }) => url)).toEqual(["https://site.invalid/api/user/self"]);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer site-token");
		expect(calls[0]?.headers.get("new-api-user")).toBe("42");
		expect([...required(calls[0]).headers.values()]).not.toContain("Bearer test-secret-key");
		expect(snapshot).toMatchObject({
			status: "supported",
			adapter: "new-api-user",
			balance: {
				scope: "wallet",
				planName: "vip",
				amounts: [{ unit: "USD", remaining: 10, used: 2, total: 12 }],
			},
		});
		expect(JSON.stringify(snapshot)).not.toMatch(/site-token|test-secret-key/);
	});
	test("transient errors preserve credit for at most ten minutes, not indefinitely", async () => {
		let failing = false;
		await replaceWithSite(config(), async () =>
			failing ? new Response(null, { status: 503 }) : Response.json(body),
		);
		const good = await providerBalanceCache.request(testProviderId);
		failing = true;
		fixture.advance(60_000);
		expect(await providerBalanceCache.request(testProviderId, "refresh")).toMatchObject({
			status: "supported",
			error: "request_failed",
			balance: good?.balance,
			fetchedAt: good?.fetchedAt,
		});
		fixture.advance(540_001);
		expect(await providerBalanceCache.request(testProviderId, "refresh")).toMatchObject({
			status: "error",
			error: "request_failed",
			balance: null,
		});
	});
	for (const [status, payload, code] of [
		[401, null, "auth_failed"],
		[403, null, "auth_failed"],
		[200, { success: true, data: { nothing: 1 } }, "invalid_response"],
	] as const) {
		test(`${code}/${status} clears memory and real persistence and later network failure cannot resurrect credit`, async () => {
			const persistence = createPersistedCredentialCache(
				`site-credit-${crypto.randomUUID()}.json`,
				parsePersistedProviderQuota,
			);
			let answer: Response | undefined;
			const f = await replaceWithSite(
				config(),
				async () => answer ?? Response.json(body),
				persistence,
			);
			await providerBalanceCache.request(testProviderId);
			await persistence.flush();
			const identity = required(f.directory.get(testProviderId)).identity;
			expect(persistence.restore(testProviderId, identity)?.data).not.toBeNull();
			answer = payload === null ? new Response(null, { status }) : Response.json(payload);
			fixture.advance(60_000);
			expect(await providerBalanceCache.request(testProviderId, "refresh")).toMatchObject({
				status: "error",
				error: code,
				balance: null,
			});
			await persistence.flush();
			expect(persistence.restore(testProviderId, identity)).toBeUndefined();
			const requests = f.query.mock.calls.length;
			fixture.advance(120_000);
			providerBalanceCache.read();
			expect(f.query).toHaveBeenCalledTimes(requests);
			answer = new Response(null, { status: 503 });
			fixture.advance(60_000);
			expect((await providerBalanceCache.request(testProviderId, "refresh"))?.balance).toBeNull();
		});
	}
	test("partial site configuration fails immediately without falling back to key discovery", async () => {
		let calls = 0;
		await replaceWithSite({ ...config(), quotaUserId: "" }, async () => {
			calls++;
			return Response.json(body);
		});
		expect(await providerBalanceCache.request(testProviderId)).toMatchObject({
			error: "invalid_configuration",
			balance: null,
		});
		expect(calls).toBe(0);
	});
	test("site credit stays usable when all inference keys are disabled", async () => {
		const cfg = { ...config(), id: `site-keys-${crypto.randomUUID()}` };
		keyProviders.add(cfg.id);
		const store = getProviderKeyStore();
		const key = store.add(cfg.id, { apiKey: "disabled-inference-key" });
		store.update(key.id, { disabled: true });
		await replaceWithSite(cfg, async () => Response.json(body));
		expect(await providerBalanceCache.request(cfg.id)).toMatchObject({
			status: "supported",
			adapter: "new-api-user",
			balance: { amounts: [{ remaining: 10 }] },
		});
	});

	test("rotating any site identity retires the previous account projection", async () => {
		await replaceWithSite(config(), async () => Response.json(body));
		await providerBalanceCache.request(testProviderId);
		const service = required(site).platform.providerSettingsService;
		for (const change of [
			{ token: "replacement" },
			{ userId: "99" },
			{ siteUrl: "https://other-site.invalid" },
		]) {
			const before = providerBalanceCache.peek(testProviderId);
			const extension = required(
				(await service.list("custom-api", testProviderId)).find(
					(item) => item.pluginId === required(site).pluginId,
				),
			);
			const current = required(extension.config);
			await service.save(required(site).pluginId, "site-account", "custom-api", testProviderId, {
				schemaVersion: 1,
				schemaFingerprint: current.schemaFingerprint,
				expectedRevision: current.revision,
				expectedBindingRevision: current.bindingRevision,
				values: {
					...current.values,
					...("userId" in change ? { userId: change.userId } : {}),
					...("siteUrl" in change ? { siteUrl: change.siteUrl } : {}),
				},
				// A destination or account change explicitly rebinds the same credential.
				secrets: {
					token: { operation: "set", value: "token" in change ? change.token : "replacement" },
				},
			});
			expect(providerBalanceCache.peek(testProviderId)?.generation).not.toBe(before?.generation);
			expect(providerBalanceCache.peek(testProviderId)?.balance).toBeNull();
		}
	});
});

describe("quota follows actual provider-key selection and transport identity", () => {
	async function setup() {
		const config = quotaConfig({
			id: `selected-${crypto.randomUUID()}`,
			prefix: "selected",
			proxy: { mode: "custom", url: "http://provider.proxy.invalid:8080" },
			userAgentMode: "custom",
			customUserAgent: "provider-agent",
			extraHeaders: { "X-Provider": "keep", "X-Identity": "provider" },
			tlsRejectUnauthorized: false,
		});
		keyProviders.add(config.id);
		const calls: Array<Parameters<typeof outboundFetch>> = [];
		let respond = async (_url: string) =>
			Response.json({ mode: "unrestricted", isValid: true, unit: "USD", balance: 12 });
		const f = await replaceWithHttp(config, async (...args) => {
			calls.push(args);
			return respond(String(args[0]));
		});
		return {
			...f,
			config,
			store: getProviderKeyStore(),
			calls,
			respond(value: typeof respond) {
				respond = value;
			},
			sent() {
				const call = calls.at(-1);
				return {
					url: String(call?.[0]),
					headers: new Headers(call?.[1]?.headers),
					init: call?.[1],
					transport: call?.[2],
				};
			},
		};
	}
	test("selected first key overrides proxy, User-Agent and headers without mutating provider settings", async () => {
		const f = await setup();
		const original = structuredClone(f.config);
		const key = f.store.add(f.config.id, {
			apiKey: f.config.apiKey,
			network: {
				proxy: { mode: "custom", url: "http://first.proxy.invalid:8080" },
				userAgentMode: "custom",
				customUserAgent: "first-key-agent",
				extraHeaders: { "X-Identity": "first-key", Host: "must-not-leave" },
			},
		});
		expect(selectProviderKey(f.config.id)?.id).toBe(key.id);
		expect(await providerBalanceCache.request(f.config.id)).toMatchObject({ status: "supported" });
		const sent = f.sent();
		expect(sent.headers.get("authorization")).toBe(`Bearer ${f.config.apiKey}`);
		expect(sent.headers.get("user-agent")).toBe("first-key-agent");
		expect(sent.headers.get("x-provider")).toBe("keep");
		expect(sent.headers.get("x-identity")).toBe("first-key");
		expect(sent.headers.has("host")).toBe(false);
		expect(sent.init).toMatchObject({ method: "GET", redirect: "error" });
		expect(sent.transport).toEqual({
			proxyUrl: "http://first.proxy.invalid:8080",
			tlsRejectUnauthorized: false,
			retryPolicy: "never",
		});
		expect(f.config).toEqual(original);
	});
	for (const unavailable of ["disabled", "cooling-down"] as const) {
		test(`${unavailable} first key selects the next key and its own discovery/network`, async () => {
			const f = await setup();
			const first = f.store.add(f.config.id, { apiKey: f.config.apiKey });
			f.respond(async (url) =>
				url.endsWith("/v1/v1/usage")
					? Response.json({ mode: "unrestricted", isValid: true, unit: "USD", balance: 12 })
					: new Response(null, { status: 404 }),
			);
			const before = await providerBalanceCache.request(f.config.id);
			expect(f.sent().url).toBe("https://relay.invalid/v1/v1/usage");
			const second = f.store.add(f.config.id, {
				apiKey: "second-key",
				network: {
					proxy: { mode: "direct" },
					userAgentMode: "custom",
					customUserAgent: "second-key-agent",
					extraHeaders: { "X-Identity": "second-key" },
				},
			});
			if (unavailable === "disabled") f.store.update(first.id, { disabled: true });
			else reportKeyFault(first, new ApiError(429, "rate limited"));
			expect(selectProviderKey(f.config.id)?.id).toBe(second.id);
			expect(providerBalanceCache.peek(f.config.id)?.balance).toBeNull();
			expect(providerBalanceCache.peek(f.config.id)?.generation).not.toBe(before?.generation);
			f.respond(async () =>
				Response.json({ mode: "unrestricted", isValid: true, unit: "USD", balance: 23 }),
			);
			expect(
				(await providerBalanceCache.request(f.config.id, "refresh"))?.balance?.amounts[0]
					?.remaining,
			).toBe(23);
			const sent = f.sent();
			expect(sent.url).toBe("https://relay.invalid/v1/usage");
			expect(sent.headers.get("authorization")).toBe("Bearer second-key");
			expect(sent.headers.get("user-agent")).toBe("second-key-agent");
			expect(sent.headers.get("x-provider")).toBe("keep");
			expect(sent.transport?.proxyUrl).toBeUndefined();
		});
	}
	for (const field of ["proxy", "userAgent", "headers"] as const) {
		test(`editing selected key ${field} retires its allowance and discovered root`, async () => {
			const f = await setup();
			const key = f.store.add(f.config.id, { apiKey: f.config.apiKey });
			f.respond(async (url) =>
				url.endsWith("/v1/v1/usage")
					? Response.json({ mode: "unrestricted", isValid: true, unit: "USD", balance: 12 })
					: new Response(null, { status: 404 }),
			);
			const before = await providerBalanceCache.request(f.config.id);
			f.store.update(key.id, {
				network:
					field === "proxy"
						? { proxy: { mode: "direct" } }
						: field === "userAgent"
							? { userAgentMode: "custom", customUserAgent: "updated-agent" }
							: { extraHeaders: { "X-Identity": "updated-device" } },
			});
			expect(providerBalanceCache.peek(f.config.id)?.generation).not.toBe(before?.generation);
			expect(providerBalanceCache.peek(f.config.id)?.balance).toBeNull();
			f.respond(async () =>
				Response.json({ mode: "unrestricted", isValid: true, unit: "USD", balance: 25 }),
			);
			expect(
				(await providerBalanceCache.request(f.config.id, "refresh"))?.balance?.amounts[0]
					?.remaining,
			).toBe(25);
			expect(f.sent().url).toBe("https://relay.invalid/v1/usage");
			if (field === "proxy") expect(f.sent().transport?.proxyUrl).toBeUndefined();
			if (field === "userAgent") expect(f.sent().headers.get("user-agent")).toBe("updated-agent");
			if (field === "headers") expect(f.sent().headers.get("x-identity")).toBe("updated-device");
		});
	}
	test("network-only rotation aborts the old round and rejects its late amount", async () => {
		const f = await setup();
		const key = f.store.add(f.config.id, { apiKey: f.config.apiKey });
		const pending = deferred<Response>();
		const started = deferred<void>();
		f.respond(() => {
			started.resolve();
			return pending.promise;
		});
		const old = providerBalanceCache.request(f.config.id);
		await started.promise;
		const oldSignal = f.sent().init?.signal;
		f.store.update(key.id, { network: { extraHeaders: { "X-Identity": "new-device" } } });
		providerBalanceCache.generations();
		expect(oldSignal?.aborted).toBe(true);
		f.respond(async () =>
			Response.json({ mode: "unrestricted", isValid: true, unit: "USD", balance: 26 }),
		);
		const current = await providerBalanceCache.request(f.config.id);
		expect(await old).toBeNull();
		pending.resolve(
			Response.json({ mode: "unrestricted", isValid: true, unit: "USD", balance: 999 }),
		);
		await Promise.resolve();
		expect(providerBalanceCache.peek(f.config.id)).toEqual(current);
		expect(current?.balance?.amounts[0]?.remaining).toBe(26);
		expect(f.sent().headers.get("x-identity")).toBe("new-device");
	});
	test("all disabled keys cannot fall back to the projected settings secret", async () => {
		const f = await setup();
		const key = f.store.add(f.config.id, { apiKey: f.config.apiKey });
		await providerBalanceCache.request(f.config.id);
		f.store.update(key.id, { disabled: true });
		const count = f.calls.length;
		expect(selectProviderKey(f.config.id)).toBeUndefined();
		expect(providerBalanceCache.peek(f.config.id)?.balance ?? null).toBeNull();
		expect((await providerBalanceCache.request(f.config.id))?.balance ?? null).toBeNull();
		providerBalanceCache.read();
		providerBalanceCache.discoverPending();
		expect(f.calls).toHaveLength(count);
	});
	test("all cooling keys preserve earliest-recovery selection rather than settings order", async () => {
		const f = await setup();
		const first = f.store.add(f.config.id, { apiKey: f.config.apiKey });
		const second = f.store.add(f.config.id, { apiKey: "second-key" });
		const now = Date.now();
		reportKeyFault(first, new ApiError(402, "quota exhausted"), now);
		reportKeyFault(second, new ApiError(429, "rate limited"), now);
		expect(selectProviderKey(f.config.id)?.id).toBe(second.id);
		await providerBalanceCache.request(f.config.id);
		expect(
			f.calls.some(
				(call) => new Headers(call[1]?.headers).get("authorization") === "Bearer second-key",
			),
		).toBe(true);
	});
	for (const unreadable of [false, true])
		test(`${unreadable ? "unreadable" : "empty"} key store preserves single-key credential and network`, async () => {
			const f = await setup();
			if (unreadable)
				f.store.add(f.config.id, { apiKey: "stored-key", network: { proxy: { mode: "direct" } } });
			const own = Object.getOwnPropertyDescriptor(f.store, "readable");
			if (unreadable)
				Object.defineProperty(f.store, "readable", { value: false, configurable: true });
			try {
				expect(await providerBalanceCache.request(f.config.id)).toMatchObject({
					status: "supported",
				});
				expect(f.sent().headers.get("authorization")).toBe(`Bearer ${f.config.apiKey}`);
				expect(f.sent().headers.get("user-agent")).toBe("provider-agent");
				expect(f.sent().transport?.proxyUrl).toBe("http://provider.proxy.invalid:8080");
			} finally {
				if (unreadable) {
					if (own) Object.defineProperty(f.store, "readable", own);
					else Reflect.deleteProperty(f.store, "readable");
				}
			}
		});
});

for (const [name, baseUrl, refreshAll] of [
	["DeepSeek", "https://api.deepseek.com", refreshAllDeepSeekBalances],
	["Kimi", "https://api.kimi.com", refreshAllKimiUsages],
	["OpenCode", "https://opencode.ai/zen/go/v1", refreshAllOpencodeUsages],
] as const) {
	test(`${name} bulk refresh visits every target without overflowing the shared queue`, async () => {
		fixture.dispose();
		mock.restore();
		const providers = Array.from({ length: 136 }, (_, index) =>
			quotaConfig({
				id: `bulk-${index}`,
				prefix: `bulk-${index}`,
				baseUrl,
			}),
		);
		fixture = legacyQuotaFixture(providers, walletQuota, { maxConcurrent: 1, maxQueued: 1 });
		await refreshAll({ manual: true });
		expect(fixture.query).toHaveBeenCalledTimes(providers.length);
		for (const { id } of providers) {
			expect(fixture.service.peek(id)?.status).toBe("supported");
		}
		expect(fixture.service.getDiagnostics()).toMatchObject({ active: 0, queued: 0 });
	});

	test(`${name} bulk refresh rejects admission failure instead of reporting success`, async () => {
		fixture.dispose();
		mock.restore();
		fixture = legacyQuotaFixture(
			[
				quotaConfig({ id: "target", prefix: "target", baseUrl }),
				quotaConfig({ id: "busy-a", prefix: "busy-a" }),
				quotaConfig({ id: "busy-b", prefix: "busy-b" }),
			],
			walletQuota,
			{ maxConcurrent: 1, maxQueued: 1 },
		);
		fixture.query.mockImplementation(() => new Promise(() => {}));
		void fixture.service.refresh("busy-a");
		void fixture.service.refresh("busy-b");
		expect(fixture.service.getDiagnostics()).toMatchObject({ active: 1, queued: 1 });
		await expect(refreshAll({ manual: true })).rejects.toThrow("queue_full");
		expect(fixture.query).toHaveBeenCalledTimes(1);
		expect(fixture.service.peek("target")?.status).toBe("pending");
	});
}
