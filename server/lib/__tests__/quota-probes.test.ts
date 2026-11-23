/**
 * Every quota probe produces the shared snapshot, and the legacy interfaces are that
 * snapshot converted back — field for field what the pre-snapshot caches returned.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";

const actualOutbound = { ...(await import("../net/outbound-fetch")) };
let respond: (
	url: string,
	init: RequestInit,
	transport?: { proxyUrl?: string },
) => Promise<Response> = async () => new Response(null, { status: 500 });
mock.module("../net/outbound-fetch", () => ({
	...actualOutbound,
	outboundFetch: (url: URL, init: RequestInit, transport?: { proxyUrl?: string }) =>
		respond(String(url), init, transport),
}));

const { getNarraforkPath } = await import("../narrafork-home");
const { createPersistedCredentialCache } = await import("../persisted-credential-cache");
const { getProviderKeyStore } = await import("../provider-keys");
const { keyCooldown, resetProviderKeyRuntimeForTests, selectProviderKey } = await import(
	"../agent/pooled-provider"
);
const { keyQuotaBlockedUntil } = await import("../provider-key-quota");
const { saveSettings, settings } = await import("../settings");
const { quotaStore } = await import("../sourcing/quota-store");
const { getServiceTemplate } = await import("../sourcing/templates");
const {
	getAllKimiCachedUsages,
	getKimiCachedUsage,
	parseKimiUsagesResponse,
	probeKimiQuota,
	refreshKimiKeyUsage,
} = await import("../kimi-usage-cache");
const {
	getAllOpencodeCachedUsages,
	getOpencodeKeyUsages,
	parseOpencodeUsageResponse,
	refreshOpencodeKeyUsage,
	syncOpencodeUsageCache,
} = await import("../opencode-usage-cache");
const { getAllDeepSeekCachedBalances, refreshDeepSeekBalance, syncDeepSeekBalanceCache } =
	await import("../deepseek-balance-cache");
const { probeRelayQuota } = await import("../provider-balance-cache");
const { firstCredential } = await import("../provider-key-subjects");

afterAll(() => {
	mock.module("../net/outbound-fetch", () => actualOutbound);
	mock.restore();
});

const RESET_5H = new Date(Date.now() + 60 * 60_000).toISOString();
const RESET_WEEK = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString();
const RESET_MONTH = new Date(Date.now() + 12 * 24 * 60 * 60_000).toISOString();

function provider(
	id: string,
	baseUrl: string,
	apiKey = "sk-one",
	protocol: "anthropic-messages" | "completions-compatible" = "anthropic-messages",
) {
	return {
		id,
		name: id,
		prefix: id,
		baseUrl,
		apiKey,
		defaultModel: "model",
		protocol,
	};
}

let ids: string[] = [];
function useProvider(config: ReturnType<typeof provider>) {
	ids.push(config.id);
	saveSettings({ ...settings, customApiProviders: [config] });
	return config;
}

/** The entry as settings normalized it: this is what the caches build identities from. */
function saved(id: string) {
	const config = settings.customApiProviders?.find((p) => p.id === id);
	if (!config) throw new Error("provider not saved");
	return config;
}

beforeEach(() => {
	resetProviderKeyRuntimeForTests();
	for (const id of ids) {
		quotaStore.remove(id);
		getProviderKeyStore().removeProvider(id);
	}
	ids = [];
	settings.proxy = { mode: "direct" };
});

describe("legacy cache files", () => {
	test("an OpenCode legacy file moves into the snapshot store and is deleted", async () => {
		useProvider(provider("oc-legacy", "https://opencode.ai/zen/go/v1"));
		const config = saved("oc-legacy");
		const identity = JSON.stringify([
			config.baseUrl,
			config.apiKey,
			config.proxy,
			config.tlsRejectUnauthorized,
			settings.proxy,
		]);
		const legacy = createPersistedCredentialCache<unknown>("opencode-usages.json", (raw) => raw);
		const usage = {
			rolling: { status: "ok" as const, percent: 37, resetsAt: RESET_5H },
			weekly: null,
			monthly: null,
			fetchedAt: Date.now(),
			error: null,
		};
		legacy.save(config.id, identity, usage);
		await legacy.flush();
		syncOpencodeUsageCache();
		await quotaStore.flush();
		expect(quotaStore.peek(config.id)?.windows[0]?.usedRatio).toBe(0.37);
		expect(getOpencodeKeyUsages()[config.id]?.rolling?.percent).toBe(37);
		expect(existsSync(getNarraforkPath("opencode-usages.json"))).toBe(false);
	});

	test("a DeepSeek legacy file moves to the first credential and is deleted", async () => {
		useProvider(provider("ds-legacy", "https://api.deepseek.com/v1"));
		const config = saved("ds-legacy");
		const identity = JSON.stringify([
			config.baseUrl,
			config.protocol,
			config.apiKey,
			config.proxy,
			config.tlsRejectUnauthorized,
			settings.proxy,
		]);
		const legacy = createPersistedCredentialCache<unknown>("deepseek-balances.json", (raw) => raw);
		legacy.save(config.id, identity, {
			isAvailable: true,
			balanceInfos: [
				{
					currency: "USD",
					totalBalance: "3.25",
					grantedBalance: "0",
					toppedUpBalance: "3.25",
				},
			],
			fetchedAt: Date.now(),
			error: null,
		});
		await legacy.flush();
		syncDeepSeekBalanceCache();
		await quotaStore.flush();
		expect(quotaStore.peek(config.id)?.balances[0]?.remaining).toBe(3.25);
		expect(getAllDeepSeekCachedBalances()[config.id]?.balanceInfos[0]?.totalBalance).toBe("3.25");
		expect(existsSync(getNarraforkPath("deepseek-balances.json"))).toBe(false);
	});
});

describe("Kimi Code quota probe", () => {
	const body = {
		usage: { used: 55, limit: 100, resetTime: RESET_WEEK },
		limits: [
			{
				window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
				detail: { used: 100, limit: 100, remaining: 0, resetTime: RESET_5H },
			},
			{
				window: { duration: 1, timeUnit: "TIME_UNIT_MONTH" },
				detail: { used: 10, limit: 100, resetTime: RESET_MONTH },
			},
			{
				window: { duration: 1, timeUnit: "TIME_UNIT_DAY" },
				detail: { used: 1, limit: 2, resetTime: RESET_WEEK },
			},
		],
	};

	test("windows, scope and detail; the legacy cache is the same payload back", async () => {
		const config = useProvider(provider("kimi-probe", "https://api.kimi.com/coding/v1"));
		respond = async () => Response.json(body);
		await refreshKimiKeyUsage(config.id);
		const snapshot = quotaStore.peek(config.id);
		expect(snapshot?.scope).toBe("subscription");
		expect(snapshot?.error).toBeUndefined();
		expect(snapshot?.windows).toEqual([
			{ kind: "5h", usedRatio: 1, resetsAt: Date.parse(RESET_5H) },
			{ kind: "weekly", usedRatio: 0.55, resetsAt: Date.parse(RESET_WEEK) },
			{ kind: "monthly", usedRatio: 0.1, resetsAt: Date.parse(RESET_MONTH) },
			{ kind: "other", label: "1d", usedRatio: 0.5, resetsAt: Date.parse(RESET_WEEK) },
		]);
		expect(snapshot?.balances).toEqual([]);
		expect(snapshot?.detail).toEqual(parseKimiUsagesResponse(body));
		// Field for field what the old cache served.
		expect(getAllKimiCachedUsages()[config.id]).toEqual({
			...parseKimiUsagesResponse(body),
			fetchedAt: snapshot?.fetchedAt ?? 0,
			error: null,
		});
		// The unified probe blocks the used-up 5h window until it resets.
		expect(keyQuotaBlockedUntil(config.id)).toBe(Date.parse(RESET_5H));
	});

	test("a window reporting nothing left is used up even without a used/limit pair", async () => {
		const config = useProvider(provider("kimi-remaining", "https://api.kimi.ai/coding/v1"));
		respond = async () =>
			Response.json({ usage: { remaining: 0, limit: 100, resetTime: RESET_WEEK } });
		await refreshKimiKeyUsage(config.id);
		expect(quotaStore.peek(config.id)?.windows[0]?.usedRatio).toBe(1);
		expect(keyQuotaBlockedUntil(config.id)).toBe(Date.parse(RESET_WEEK));
	});

	test("changing the key or the endpoint withdraws the cached numbers", async () => {
		useProvider(provider("kimi-identity", "https://api.kimi.com/coding/v1"));
		const config = saved("kimi-identity");
		respond = async () => Response.json(body);
		await refreshKimiKeyUsage(config.id);
		expect(getKimiCachedUsage(config.id)).toBeDefined();
		// The first key carries the provider's id, so this is the credential the probe used.
		getProviderKeyStore().update(config.id, { apiKey: "sk-other-account" });
		expect(getKimiCachedUsage(config.id)).toBeUndefined();
		getProviderKeyStore().update(config.id, { apiKey: "sk-one" });
		expect(getKimiCachedUsage(config.id)).toBeDefined();
		saved("kimi-identity").baseUrl = "https://api.kimi.ai/coding/v1";
		expect(getKimiCachedUsage(config.id)).toBeUndefined();
	});

	test("a late answer for a replaced credential is not published", async () => {
		useProvider(provider("kimi-late", "https://api.kimi.com/coding/v1"));
		const config = saved("kimi-late");
		let settle!: (response: Response) => void;
		respond = () =>
			new Promise<Response>((done) => {
				settle = done;
			});
		const refresh = refreshKimiKeyUsage(config.id);
		getProviderKeyStore().update(config.id, { apiKey: "sk-replacement" });
		settle(Response.json(body));
		await refresh;
		expect(getKimiCachedUsage(config.id)).toBeUndefined();
		expect(quotaStore.peek(config.id)).toBeUndefined();
	});

	test("the probe itself is what the kimi-code template exposes", async () => {
		const config = useProvider(provider("kimi-template", "https://api.kimi.com/coding/v1"));
		respond = async () => Response.json(body);
		const template = getServiceTemplate("kimi-code");
		const snapshot = await template.probeQuota?.(
			// The probe needs the credential only.
			{} as never,
			{ id: config.id, providerId: config.id, config },
			AbortSignal.timeout(5_000),
		);
		expect(snapshot?.windows).toEqual(
			(await probeKimiQuota({ id: config.id, providerId: config.id, config })).windows,
		);
	});
});

describe("OpenCode Go quota probe", () => {
	const body = {
		usage: {
			rolling: { status: "ok", percent: 37, resetsAt: RESET_5H },
			weekly: { status: "rate-limited", percent: 100, resetsAt: RESET_WEEK },
			monthly: { status: "ok", percent: 12, resetsAt: RESET_MONTH },
			balance: 4.5,
		},
	};

	test("windows, balance and detail; rate-limited counts as used up", async () => {
		const config = useProvider(provider("oc-probe", "https://opencode.ai/zen/go/v1"));
		respond = async () => Response.json(body);
		await refreshOpencodeKeyUsage(config.id);
		const snapshot = quotaStore.peek(config.id);
		expect(snapshot?.scope).toBe("subscription");
		expect(snapshot?.windows).toEqual([
			{ kind: "5h", usedRatio: 0.37, resetsAt: Date.parse(RESET_5H) },
			{ kind: "weekly", usedRatio: 1, resetsAt: Date.parse(RESET_WEEK) },
			{ kind: "monthly", usedRatio: 0.12, resetsAt: Date.parse(RESET_MONTH) },
		]);
		expect(snapshot?.balances).toEqual([{ unit: "USD", remaining: 4.5 }]);
		expect(snapshot?.detail).toEqual(parseOpencodeUsageResponse(body));
		expect(getAllOpencodeCachedUsages()[config.id]).toEqual({
			...parseOpencodeUsageResponse(body),
			generation: expect.any(String),
			fetchedAt: snapshot?.fetchedAt ?? 0,
			error: null,
		});
		expect(keyQuotaBlockedUntil(config.id)).toBe(Date.parse(RESET_WEEK));
		expect(getOpencodeKeyUsages()[config.id]?.balance).toBe(4.5);
	});

	test("the pool skips a key whose window is used up and serves from the next one", async () => {
		const config = useProvider(provider("oc-pool", "https://opencode.ai/zen/go/v1"));
		const second = getProviderKeyStore().add(config.id, { apiKey: "sk-two" });
		respond = async (_url, init) => {
			const limited = new Headers(init.headers).get("Authorization") === "Bearer sk-one";
			return Response.json({
				usage: {
					rolling: limited
						? { status: "rate-limited", percent: 100, resetsAt: RESET_5H }
						: { status: "ok", percent: 10, resetsAt: RESET_5H },
				},
			});
		};
		await Promise.all([refreshOpencodeKeyUsage(config.id), refreshOpencodeKeyUsage(second.id)]);
		expect(keyCooldown(config.id)).toEqual({ until: Date.parse(RESET_5H), reason: "quota" });
		expect(keyCooldown(second.id)).toBeUndefined();
		expect(selectProviderKey(config.id, "new-session")?.id).toBe(second.id);
	});

	test("replacing a credential drops its exhaustion at once, reverting restores it from disk", async () => {
		const config = useProvider(provider("oc-restore", "https://opencode.ai/zen/go/v1"));
		respond = async () =>
			Response.json({
				usage: { rolling: { status: "rate-limited", percent: 100, resetsAt: RESET_5H } },
			});
		await refreshOpencodeKeyUsage(config.id);
		expect(keyQuotaBlockedUntil(config.id)).toBe(Date.parse(RESET_5H));
		await quotaStore.flush();

		// The pool must not steer around a key that no longer belongs to this account…
		getProviderKeyStore().update(config.id, { apiKey: "sk-other" });
		syncOpencodeUsageCache();
		expect(keyQuotaBlockedUntil(config.id)).toBeUndefined();
		// …and reverting brings the persisted snapshot back without any upstream call.
		getProviderKeyStore().update(config.id, { apiKey: "sk-one" });
		syncOpencodeUsageCache();
		expect(keyQuotaBlockedUntil(config.id)).toBe(Date.parse(RESET_5H));
	});

	test("a rate-limited window with no percent still blocks the key", async () => {
		const config = useProvider(provider("oc-status", "https://opencode.ai/zen/go/v1"));
		respond = async () =>
			Response.json({ usage: { rolling: { status: "rate-limited", resetsAt: RESET_5H } } });
		await refreshOpencodeKeyUsage(config.id);
		expect(quotaStore.peek(config.id)?.windows[0]?.usedRatio).toBe(1);
		expect(keyQuotaBlockedUntil(config.id)).toBe(Date.parse(RESET_5H));
	});
});

describe("DeepSeek quota probe", () => {
	const body = {
		is_available: true,
		balance_infos: [
			{
				currency: "CNY",
				total_balance: "12.50",
				granted_balance: "2.50",
				topped_up_balance: "10.00",
			},
		],
	};

	test("balances by currency; the legacy cache keeps the exact balance strings", async () => {
		const config = useProvider(provider("ds-probe", "https://api.deepseek.com/v1"));
		respond = async () => Response.json(body);
		await refreshDeepSeekBalance(config.id);
		const snapshot = quotaStore.peek(config.id);
		expect(snapshot?.scope).toBe("wallet");
		expect(snapshot?.windows).toEqual([]);
		expect(snapshot?.balances).toEqual([{ unit: "CNY", remaining: 12.5 }]);
		expect(getAllDeepSeekCachedBalances()[config.id]).toEqual({
			generation: expect.any(String),
			isAvailable: true,
			balanceInfos: body.balance_infos.map((info) => ({
				currency: info.currency,
				totalBalance: info.total_balance,
				grantedBalance: info.granted_balance,
				toppedUpBalance: info.topped_up_balance,
			})),
			fetchedAt: snapshot?.fetchedAt ?? 0,
			error: null,
		});
	});

	test("the balance is stored under the group's first credential", async () => {
		const config = useProvider(provider("ds-first", "https://api.deepseek.com/v1"));
		const second = getProviderKeyStore().add(config.id, { apiKey: "sk-two" });
		getProviderKeyStore().reorder(config.id, [second.id]);
		expect(firstCredential(saved(config.id)).id).toBe(second.id);
		respond = async () => Response.json(body);
		await refreshDeepSeekBalance(config.id);
		expect(quotaStore.peek(second.id)?.balances[0]?.remaining).toBe(12.5);
		expect(quotaStore.peek(config.id)).toBeUndefined();
		expect(getAllDeepSeekCachedBalances()[config.id]?.balanceInfos).toHaveLength(1);
	});

	test("the balance request uses the first key's own proxy", async () => {
		const config = useProvider(provider("ds-proxy", "https://api.deepseek.com/v1"));
		getProviderKeyStore().update(config.id, {
			network: { proxy: { mode: "custom", url: "http://key.proxy.invalid:8080" } },
		});
		let proxyUrl: string | undefined;
		respond = async (_url, _init, transport) => {
			proxyUrl = transport?.proxyUrl;
			return Response.json(body);
		};
		await refreshDeepSeekBalance(config.id);
		expect(proxyUrl).toBe("http://key.proxy.invalid:8080");
		expect(quotaStore.peek(config.id)?.balances[0]?.remaining).toBe(12.5);
	});

	test("the Anthropic preset endpoint is a DeepSeek balance source too", async () => {
		const config = useProvider(provider("ds-anthropic", "https://api.deepseek.com/anthropic/v1"));
		let requested = "";
		respond = async (url) => {
			requested = url;
			return Response.json(body);
		};
		syncDeepSeekBalanceCache();
		await refreshDeepSeekBalance(config.id);
		expect(requested).toBe("https://api.deepseek.com/user/balance");
		expect(quotaStore.peek(config.id)?.balances[0]?.unit).toBe("CNY");
	});
});

describe("relay balance after the endpoint changed families", () => {
	test("another source's snapshot under the same credential id is not served as a balance", async () => {
		const { providerBalanceCache } = await import("../provider-balance-cache");
		const config = useProvider(
			provider("relay-switch", "https://relay.example/v1", "sk-one", "completions-compatible"),
		);
		respond = async () =>
			Response.json({ mode: "unrestricted", isValid: true, balance: 12, unit: "USD" });
		expect((await providerBalanceCache.request(config.id))?.status).toBe("supported");
		// A late Kimi refresh writes the same credential id under its own identity.
		quotaStore.set(config.id, '["https://api.kimi.com/coding/v1","sk-one"]', {
			fetchedAt: Date.now(),
			scope: "subscription",
			windows: [{ kind: "5h", usedRatio: 0.4, resetsAt: null }],
			balances: [],
			detail: { fiveHour: null, weekly: null, monthly: null, extraWindows: [] },
		});
		expect(providerBalanceCache.peek(config.id)?.balance).toBeNull();
		// The next read recovers by probing again instead of serving the foreign snapshot.
		providerBalanceCache.read(config.id);
		await providerBalanceCache.request(config.id);
		expect(providerBalanceCache.peek(config.id)?.balance?.amounts[0]?.remaining).toBe(12);
		providerBalanceCache.sync();
	});
});

describe("relay / site quota probe", () => {
	test("key balance: amounts become balances, the endpoint stays in detail", async () => {
		respond = async () =>
			Response.json({ mode: "unrestricted", isValid: true, balance: 12, unit: "USD" });
		const config = provider("relay", "https://relay.example/v1");
		const snapshot = await probeRelayQuota(
			{ id: config.id, providerId: config.id, config },
			AbortSignal.timeout(5_000),
		);
		expect(snapshot.scope).toBe("wallet");
		expect(snapshot.balances).toEqual([{ unit: "USD", remaining: 12 }]);
		expect(snapshot.detail).toMatchObject({
			status: "supported",
			adapter: "sub2api",
			endpoint: { root: "https://relay.example" },
		});
	});

	test("site credit: plan, total and unlimited flags", async () => {
		respond = async () =>
			Response.json({
				success: true,
				data: { quota: 5_000_000, used_quota: 1_000_000, group: "vip" },
			});
		const config = {
			...provider("site", "https://relay.example/v1"),
			quotaSiteUrl: "https://relay.example",
			quotaAccessToken: "site-token",
			quotaUserId: "42",
		};
		const snapshot = await probeRelayQuota(
			{ id: config.id, providerId: config.id, config },
			AbortSignal.timeout(5_000),
		);
		expect(snapshot.scope).toBe("wallet");
		expect(snapshot.plan).toBe("vip");
		expect(snapshot.balances).toEqual([{ unit: "USD", remaining: 10, total: 12 }]);
	});
});
