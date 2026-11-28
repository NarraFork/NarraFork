/** Plugin queries own quota normalization; legacy views and routing read the same service snapshot. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { type CustomApiQuotaTarget, providerQuotaSourceSchema } from "@shared/provider-quota";
import { QuotaQueryError } from "../../../plugins/provider-quota/src/errors";
import { parseKimiUsagesResponse } from "../../../plugins/provider-quota/src/kimi";
import { parseOpencodeUsageResponse } from "../../../plugins/provider-quota/src/opencode";
import {
	PLUGIN_ID,
	QUOTA_PROTOCOL_VERSION,
	type QuotaErrorCode,
} from "../../../plugins/provider-quota/src/protocol";
import { queryQuota, QUOTA_SOURCES } from "../../../plugins/provider-quota/src/query";
import { PluginProviderConnectionService } from "../../services/plugin-provider-connection-service";
import { parsePersistedProviderQuota } from "../../services/provider-quota-persistence";
import {
	type ProviderQuotaServiceOptions,
	toQuotaSnapshot,
} from "../../services/provider-quota-service";
import {
	keyCooldown,
	resetProviderKeyRuntimeForTests,
	selectProviderKey,
} from "../agent/pooled-provider";
import {
	getDeepSeekQuotaSnapshot,
	isDeepSeekQuotaRefreshing,
	refreshDeepSeekBalance,
	syncDeepSeekBalanceCache,
} from "../deepseek-balance-cache";
import { getKimiCachedUsage, getKimiKeyUsages, refreshKimiKeyUsage } from "../kimi-usage-cache";
import { getNarraforkPath } from "../narrafork-home";
import {
	getOpencodeKeyUsages,
	refreshOpencodeKeyUsage,
	syncOpencodeUsageCache,
} from "../opencode-usage-cache";
import { createPersistedCredentialCache } from "../persisted-credential-cache";
import { providerBalanceCache } from "../provider-balance-cache";
import { keyQuotaBlockedUntil } from "../provider-key-quota";
import { firstCredential } from "../provider-key-subjects";
import { getProviderKeyStore } from "../provider-keys";
import { type CustomApiProviderConfig, saveSettings, settings } from "../settings";
import { readQuotaSnapshots, refreshQuotaSnapshots } from "../sourcing/quota-snapshots";
import {
	deferred,
	legacyQuotaFixture,
	required,
	walletQuota,
} from "./provider-quota-legacy-fixture";

const originalSettings = structuredClone(settings);
const RESET_5H = new Date(Date.now() + 60 * 60_000).toISOString();
const RESET_WEEK = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString();
const RESET_MONTH = new Date(Date.now() + 12 * 24 * 60 * 60_000).toISOString();
let respond: (
	url: string,
	init: RequestInit,
	transport?: { proxyUrl?: string },
) => Promise<Response>;
type PluginFixture = ReturnType<typeof legacyQuotaFixture> & { keyId: string };
let fixture: PluginFixture | undefined;
const ids = new Set<string>();
const files = new Set<string>();
const caches = new Set<NonNullable<ProviderQuotaServiceOptions["persistence"]>>();

function provider(
	id: string,
	baseUrl: string,
	apiKey = "sk-one",
	protocol: CustomApiProviderConfig["protocol"] = "completions-compatible",
): CustomApiProviderConfig {
	return { id, name: id, prefix: id, baseUrl, apiKey, defaultModel: "model", protocol };
}
function saved(id: string) {
	return required(settings.customApiProviders?.find((config) => config.id === id));
}
function persistence(name: string) {
	files.add(name);
	const cache = createPersistedCredentialCache(name, parsePersistedProviderQuota);
	caches.add(cache);
	return cache;
}

/** Exercise the actual plugin protocol and host-owned credential/network connection, without a runtime. */
function pluginFixture(
	config: CustomApiProviderConfig,
	contributionId: "kimi" | "opencode" | "deepseek" | "relay",
	cache?: ProviderQuotaServiceOptions["persistence"],
): PluginFixture {
	fixture?.dispose();
	mock.restore();
	ids.add(config.id);
	saveSettings({ ...settings, customApiProviders: [config] });
	const current = saved(config.id);
	// Attach the source before adding connections, so persisted snapshots match its revision on restore.
	const f = legacyQuotaFixture([], walletQuota, { persistence: cache });
	f.source.id = `${PLUGIN_ID}/${contributionId}`;
	f.source.pluginId = PLUGIN_ID;
	f.source.contributionId = contributionId;
	f.source.declaration = providerQuotaSourceSchema.parse(
		QUOTA_SOURCES.find((source) => source.id === contributionId),
	);
	settings.customApiProviders = [current];
	f.advance(Date.now() - 1_000_000);
	f.service.sync();
	const connection = new PluginProviderConnectionService({
		directory: f.directory,
		fetch: (url, init, transport) => respond(String(url), init ?? {}, transport),
	});
	const principal = {
		pluginId: PLUGIN_ID,
		installationId: "quota-probes-test",
		runtimeId: "quota-probes-test",
		runtimeGeneration: 1,
	};
	f.query.mockImplementation(async (source, target, options) => {
		const live = required(f.directory.getTarget(target as CustomApiQuotaTarget)).target;
		const deadlineAt = Date.now() + 5000;
		const lease = connection.issue({
			principal,
			target: live,
			source: source.declaration,
			deadlineAt,
			signal: options.signal,
			isCurrent: () => f.service.capabilityEnabled(),
		});
		try {
			return await queryQuota(
				{
					protocolVersion: QUOTA_PROTOCOL_VERSION,
					contributionId: source.contributionId,
					target: live,
					reference: lease.reference,
					deadlineAt,
					mode: options.mode,
					...(options.cursor ? { cursor: options.cursor } : {}),
				},
				async (request, signal) => {
					if (typeof request === "string" || !(signal instanceof AbortSignal))
						throw new Error("Unexpected settings connection in provider quota fixture");
					try {
						return await connection.request(request, principal, signal);
					} catch (error) {
						throw new QuotaQueryError(
							error instanceof Error && "code" in error
								? (error.code as QuotaErrorCode)
								: "request_failed",
						);
					}
				},
				options.signal,
			);
		} finally {
			lease.release();
		}
	});
	const result = {
		...f,
		keyId: required(getProviderKeyStore().listGroup(config.id)[0]).id,
		dispose() {
			connection.dispose();
			f.dispose();
		},
	};
	fixture = result;
	return result;
}

beforeEach(() => {
	resetProviderKeyRuntimeForTests();
	settings.proxy = { mode: "direct" };
	respond = async () => new Response(null, { status: 500 });
});
afterEach(async () => {
	fixture?.dispose();
	fixture = undefined;
	mock.restore();
	for (const id of ids) getProviderKeyStore().removeProvider(id);
	ids.clear();
	saveSettings(structuredClone(originalSettings));
	await Promise.all([...caches].map((cache) => cache.flush()));
	caches.clear();
	for (const file of files) await rm(getNarraforkPath(file), { force: true });
	files.clear();
});

const kimiBody = {
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
const opencodeBody = {
	usage: {
		rolling: { status: "ok", percent: 37, resetsAt: RESET_5H },
		weekly: { status: "rate-limited", percent: 100, resetsAt: RESET_WEEK },
		monthly: { status: "ok", percent: 12, resetsAt: RESET_MONTH },
		balance: 4.5,
	},
};
const deepSeekBody = {
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

// The retired host JSON importers are replaced by the service's source- and identity-bound persistence.
describe("plugin snapshot persistence", () => {
	for (const source of ["opencode", "deepseek"] as const) {
		test(`${source} restores its credential snapshot without probing and rejects foreign identity or revision`, async () => {
			const config = provider(
				`${source}-persisted`,
				source === "opencode" ? "https://opencode.ai/zen/go/v1" : "https://api.deepseek.com/v1",
			);
			const filename = `quota-probes-${source}-${crypto.randomUUID()}.json`;
			const cache = persistence(filename);
			respond = async () => Response.json(source === "opencode" ? opencodeBody : deepSeekBody);
			const first = pluginFixture(config, source, cache);
			const observed = required(await first.service.refreshKey(first.keyId));
			await cache.flush();
			expect(readFileSync(getNarraforkPath(filename), "utf8")).not.toContain("sk-one");
			const restored = pluginFixture(saved(config.id), source, persistence(filename));
			const snapshot = required(restored.service.peekKey(restored.keyId));
			expect(snapshot).toMatchObject({
				providerId: config.id,
				keyId: restored.keyId,
				sourceId: `${PLUGIN_ID}/${source}`,
				status: "supported",
				data: observed.data,
			});
			expect(snapshot.generation).not.toBe(observed.generation);
			expect(restored.query).not.toHaveBeenCalled();
			if (source === "opencode") {
				expect(toQuotaSnapshot(snapshot)?.scope).toBe("subscription");
				expect(getOpencodeKeyUsages()[restored.keyId]?.rolling?.percent).toBe(37);
			} else {
				expect(toQuotaSnapshot(snapshot)?.scope).toBe("wallet");
				expect(getDeepSeekQuotaSnapshot(config.id, restored.keyId)?.balances[0]?.remaining).toBe(
					12.5,
				);
			}
			getProviderKeyStore().update(restored.keyId, { apiKey: "foreign-account" });
			expect(restored.service.peekKey(restored.keyId)?.data).toBeNull();
			getProviderKeyStore().update(restored.keyId, { apiKey: "sk-one" });
			expect(restored.service.peekKey(restored.keyId)?.data).toEqual(observed.data);
			restored.source.revision = "revision-2";
			restored.service.invalidateSources();
			expect(restored.service.peekKey(restored.keyId)?.data).toBeNull();
			expect(restored.query).not.toHaveBeenCalled();
		});
	}
});

describe("Kimi Code plugin quota", () => {
	test("windows and scope survive the plugin protocol and the legacy projection", async () => {
		const config = provider("kimi-probe", "https://api.kimi.com/coding/v1");
		const f = pluginFixture(config, "kimi");
		respond = async () => Response.json(kimiBody);
		await refreshKimiKeyUsage(f.keyId);
		const observed = required(f.service.peekKey(f.keyId));
		const snapshot = required(toQuotaSnapshot(observed));
		expect(observed).toMatchObject({
			providerId: config.id,
			keyId: f.keyId,
			sourceId: `${PLUGIN_ID}/kimi`,
			status: "supported",
		});
		expect(observed.generation).toBe(f.directory.getKey(f.keyId)?.target.generation);
		expect(snapshot.scope).toBe("subscription");
		expect(snapshot.error).toBeUndefined();
		expect(snapshot.windows).toEqual([
			{
				kind: "5h",
				usedRatio: 1,
				resetsAt: Date.parse(RESET_5H),
				used: 100,
				total: 100,
				remaining: 0,
			},
			{ kind: "weekly", usedRatio: 0.55, resetsAt: Date.parse(RESET_WEEK), used: 55, total: 100 },
			{ kind: "monthly", usedRatio: 0.1, resetsAt: Date.parse(RESET_MONTH), used: 10, total: 100 },
			{
				kind: "other",
				label: "1d",
				usedRatio: 0.5,
				resetsAt: Date.parse(RESET_WEEK),
				used: 1,
				total: 2,
			},
		]);
		expect(snapshot.balances).toEqual([]);
		expect(getKimiKeyUsages()[f.keyId]).toEqual({
			...parseKimiUsagesResponse(kimiBody),
			fetchedAt: snapshot.fetchedAt,
			error: null,
		});
		expect(keyQuotaBlockedUntil(f.keyId)).toBe(Date.parse(RESET_5H));
	});

	test("a remaining-only empty window blocks the key", async () => {
		const f = pluginFixture(provider("kimi-remaining", "https://api.kimi.ai/coding/v1"), "kimi");
		respond = async () =>
			Response.json({ usage: { remaining: 0, limit: 100, resetTime: RESET_WEEK } });
		await refreshKimiKeyUsage(f.keyId);
		expect(toQuotaSnapshot(f.service.peekKey(f.keyId))?.windows[0]?.usedRatio).toBe(1);
		expect(keyQuotaBlockedUntil(f.keyId)).toBe(Date.parse(RESET_WEEK));
	});

	test("changing the credential or endpoint withdraws cached allowance until it is refreshed", async () => {
		const config = provider("kimi-identity", "https://api.kimi.com/coding/v1");
		const f = pluginFixture(config, "kimi");
		respond = async () => Response.json(kimiBody);
		await refreshKimiKeyUsage(f.keyId);
		const generation = required(f.service.peekKey(f.keyId)).generation;
		expect(getKimiCachedUsage(config.id)?.fiveHour?.used).toBe(100);
		getProviderKeyStore().update(f.keyId, { apiKey: "sk-other-account" });
		expect(getKimiCachedUsage(config.id)?.fiveHour).toBeNull();
		expect(f.service.peekKey(f.keyId)?.generation).not.toBe(generation);
		expect(keyQuotaBlockedUntil(f.keyId)).toBeUndefined();
		getProviderKeyStore().update(f.keyId, { apiKey: "sk-one" });
		await refreshKimiKeyUsage(f.keyId);
		expect(getKimiCachedUsage(config.id)?.fiveHour?.used).toBe(100);
		saved(config.id).baseUrl = "https://api.kimi.ai/coding/v1";
		expect(getKimiCachedUsage(config.id)?.fiveHour).toBeNull();
		expect(f.service.peekKey(f.keyId)?.data).toBeNull();
	});

	for (const change of ["credential", "global-proxy"] as const) {
		test(`a late answer for the replaced ${change} cannot publish under the new generation`, async () => {
			const config = provider(`kimi-late-${change}`, "https://api.kimi.com/coding/v1");
			const f = pluginFixture(config, "kimi");
			const began = deferred<void>();
			const gate = deferred<Response>();
			respond = () => {
				began.resolve();
				return gate.promise;
			};
			const refresh = refreshKimiKeyUsage(f.keyId);
			await began.promise;
			const oldGeneration = required(f.service.peekKey(f.keyId)).generation;
			if (change === "credential")
				getProviderKeyStore().update(f.keyId, { apiKey: "sk-replacement" });
			else settings.proxy = { mode: "custom", url: "http://replacement-proxy.example:8080" };
			expect(f.service.peekKey(f.keyId)?.generation).not.toBe(oldGeneration);
			gate.resolve(Response.json(kimiBody));
			await refresh;
			expect(getKimiCachedUsage(config.id)?.fiveHour).toBeNull();
			expect(f.service.peekKey(f.keyId)?.data).toBeNull();
			expect(keyQuotaBlockedUntil(f.keyId)).toBeUndefined();
		});
	}

	test("a network-only key edit withdraws the cached allowance", async () => {
		const config = provider("kimi-network", "https://api.kimi.com/coding/v1");
		const f = pluginFixture(config, "kimi");
		respond = async () => Response.json(kimiBody);
		await refreshKimiKeyUsage(f.keyId);
		expect(getKimiCachedUsage(config.id)?.fiveHour?.used).toBe(100);
		getProviderKeyStore().update(f.keyId, {
			network: { extraHeaders: { "X-Account": "network-two" } },
		});
		expect(getKimiCachedUsage(config.id)?.fiveHour).toBeNull();
		expect(keyQuotaBlockedUntil(f.keyId)).toBeUndefined();
	});

	test("the production template refresh returns a standard snapshot from the plugin owner", async () => {
		const config = provider("kimi-template", "https://api.kimi.com/coding/v1");
		const f = pluginFixture(config, "kimi");
		respond = async () => Response.json(kimiBody);
		const [snapshot] = await refreshQuotaSnapshots({ groupId: config.id, credentialId: f.keyId });
		expect(snapshot).toMatchObject({
			scope: "subscription",
			balances: [],
			windows: [
				{ kind: "5h", usedRatio: 1, resetsAt: Date.parse(RESET_5H) },
				{ kind: "weekly", usedRatio: 0.55, resetsAt: Date.parse(RESET_WEEK) },
				{ kind: "monthly", usedRatio: 0.1, resetsAt: Date.parse(RESET_MONTH) },
				{ kind: "other", label: "1d", usedRatio: 0.5, resetsAt: Date.parse(RESET_WEEK) },
			],
		});
		expect(Number.isFinite(snapshot?.fetchedAt)).toBe(true);
		expect(snapshot).not.toHaveProperty("fiveHour");
		expect(snapshot).toEqual(toQuotaSnapshot(f.service.peekKey(f.keyId)));
		expect(keyQuotaBlockedUntil(f.keyId)).toBe(Date.parse(RESET_5H));
	});
});

describe("OpenCode Go plugin quota", () => {
	test("windows and informational wallet survive projection; rate-limited counts as used up", async () => {
		const f = pluginFixture(provider("oc-probe", "https://opencode.ai/zen/go/v1"), "opencode");
		respond = async () => Response.json(opencodeBody);
		await refreshOpencodeKeyUsage(f.keyId);
		const observed = required(f.service.peekKey(f.keyId));
		const snapshot = required(toQuotaSnapshot(observed));
		expect(snapshot.scope).toBe("subscription");
		expect(snapshot.windows).toEqual([
			{ kind: "5h", usedRatio: 0.37, resetsAt: Date.parse(RESET_5H), status: "ok" },
			{ kind: "weekly", usedRatio: 1, resetsAt: Date.parse(RESET_WEEK), status: "rate-limited" },
			{ kind: "monthly", usedRatio: 0.12, resetsAt: Date.parse(RESET_MONTH), status: "ok" },
		]);
		expect(snapshot.balances).toEqual([
			{ id: "balance:USD", unit: "USD", remaining: 4.5, quota: "none" },
		]);
		expect(getOpencodeKeyUsages()[f.keyId]).toEqual({
			...parseOpencodeUsageResponse(opencodeBody),
			generation: observed.generation,
			fetchedAt: snapshot.fetchedAt,
			error: null,
		});
		expect(keyQuotaBlockedUntil(f.keyId)).toBe(Date.parse(RESET_WEEK));
		expect(getOpencodeKeyUsages()[f.keyId]?.balance).toBe(4.5);
	});

	test("the pool skips a used-up key and uses the next credential through its own connection", async () => {
		const config = provider("oc-pool", "https://opencode.ai/zen/go/v1");
		const f = pluginFixture(config, "opencode");
		const second = getProviderKeyStore().add(config.id, { apiKey: "sk-two" });
		respond = async (_url, init) =>
			Response.json({
				usage: {
					rolling:
						new Headers(init.headers).get("Authorization") === "Bearer sk-one"
							? { status: "rate-limited", percent: 100, resetsAt: RESET_5H }
							: { status: "ok", percent: 10, resetsAt: RESET_5H },
				},
			});
		await Promise.all([refreshOpencodeKeyUsage(f.keyId), refreshOpencodeKeyUsage(second.id)]);
		expect(keyCooldown(f.keyId)).toEqual({ until: Date.parse(RESET_5H), reason: "quota" });
		expect(keyCooldown(second.id)).toBeUndefined();
		expect(selectProviderKey(config.id, "new-session")?.id).toBe(second.id);
		expect(f.service.peekKey(second.id)?.data?.windows[0]?.usedPercent).toBe(10);
	});

	test("replacing a credential drops exhaustion and reverting restores the persisted plugin observation", async () => {
		const cache = persistence(`quota-probes-restore-${crypto.randomUUID()}.json`);
		const f = pluginFixture(
			provider("oc-restore", "https://opencode.ai/zen/go/v1"),
			"opencode",
			cache,
		);
		respond = async () =>
			Response.json({
				usage: { rolling: { status: "rate-limited", percent: 100, resetsAt: RESET_5H } },
			});
		await refreshOpencodeKeyUsage(f.keyId);
		expect(keyQuotaBlockedUntil(f.keyId)).toBe(Date.parse(RESET_5H));
		await cache.flush();
		getProviderKeyStore().update(f.keyId, { apiKey: "sk-other" });
		syncOpencodeUsageCache();
		expect(keyQuotaBlockedUntil(f.keyId)).toBeUndefined();
		getProviderKeyStore().update(f.keyId, { apiKey: "sk-one" });
		syncOpencodeUsageCache();
		expect(keyQuotaBlockedUntil(f.keyId)).toBe(Date.parse(RESET_5H));
		expect(f.query).toHaveBeenCalledTimes(1);
	});

	test("a rate-limited window with no percent still blocks the key", async () => {
		const f = pluginFixture(provider("oc-status", "https://opencode.ai/zen/go/v1"), "opencode");
		respond = async () =>
			Response.json({ usage: { rolling: { status: "rate-limited", resetsAt: RESET_5H } } });
		await refreshOpencodeKeyUsage(f.keyId);
		expect(toQuotaSnapshot(f.service.peekKey(f.keyId))?.windows[0]?.usedRatio).toBe(1);
		expect(keyQuotaBlockedUntil(f.keyId)).toBe(Date.parse(RESET_5H));
	});
});

describe("DeepSeek plugin quota", () => {
	test("balances retain currency, exact strings and distinct summary/detail identifiers", async () => {
		const config = provider("ds-probe", "https://api.deepseek.com/v1");
		const f = pluginFixture(config, "deepseek");
		respond = async () => Response.json(deepSeekBody);
		const cache = await refreshDeepSeekBalance(config.id);
		const observed = required(f.service.peekKey(f.keyId));
		const snapshot = required(toQuotaSnapshot(observed));
		expect(snapshot.scope).toBe("wallet");
		expect(snapshot.windows).toEqual([]);
		expect(snapshot.balances).toEqual([
			{
				id: "balance:CNY",
				label: "Total balance",
				display: "summary",
				quota: "alternative",
				unit: "CNY",
				remaining: 12.5,
				remainingText: "12.50",
			},
			{
				id: "granted:CNY",
				label: "Granted balance",
				display: "detail",
				quota: "none",
				unit: "CNY",
				remaining: 2.5,
				remainingText: "2.50",
			},
			{
				id: "topped-up:CNY",
				label: "Topped-up balance",
				display: "detail",
				quota: "none",
				unit: "CNY",
				remaining: 10,
				remainingText: "10.00",
			},
		]);
		expect(cache).toEqual({
			generation: observed.generation,
			isAvailable: true,
			balanceInfos: [
				{
					currency: "CNY",
					totalBalance: "12.50",
					grantedBalance: "2.50",
					toppedUpBalance: "10.00",
				},
			],
			fetchedAt: snapshot.fetchedAt,
			error: null,
		});
	});

	test("the balance is stored under the group's first credential after reorder", async () => {
		const config = provider("ds-first", "https://api.deepseek.com/v1");
		const f = pluginFixture(config, "deepseek");
		const second = getProviderKeyStore().add(config.id, { apiKey: "sk-two" });
		getProviderKeyStore().reorder(config.id, [second.id]);
		expect(firstCredential(saved(config.id)).id).toBe(second.id);
		respond = async () => Response.json(deepSeekBody);
		await refreshQuotaSnapshots({ groupId: config.id, credentialId: second.id });
		expect(f.service.peekKey(second.id)?.data?.amounts[0]?.remaining).toBe(12.5);
		expect(f.service.peekKey(f.keyId)?.data).toBeNull();
		expect(getDeepSeekQuotaSnapshot(config.id, second.id)?.balances).toHaveLength(3);
	});

	test("second-key probes use its own route and reject late credential or network results", async () => {
		const config = provider("ds-per-key", "https://api.deepseek.com/v1");
		const f = pluginFixture(config, "deepseek");
		const store = getProviderKeyStore();
		const second = store.add(config.id, {
			apiKey: "sk-two",
			network: { proxy: { mode: "custom", url: "http://second.proxy:8080" } },
		});
		const balance = (amount: string) =>
			Response.json({
				is_available: true,
				balance_infos: [
					{
						currency: "USD",
						total_balance: amount,
						granted_balance: "0",
						topped_up_balance: amount,
					},
				],
			});
		respond = async () => balance("9");
		await refreshDeepSeekBalance(config.id);
		const began = deferred<void>();
		const gate = deferred<Response>();
		respond = (_url, init, transport) => {
			expect(new Headers(init.headers).get("Authorization")).toBe("Bearer sk-two");
			expect(transport?.proxyUrl).toBe("http://second.proxy:8080");
			began.resolve();
			return gate.promise;
		};
		const probing = refreshQuotaSnapshots({ groupId: config.id, credentialId: second.id });
		await began.promise;
		expect(isDeepSeekQuotaRefreshing(config.id, second.id)).toBe(true);
		expect(isDeepSeekQuotaRefreshing(config.id)).toBe(false);
		expect(
			readQuotaSnapshots(true, false).entries.find((entry) => entry.credentialId === second.id)
				?.refreshing,
		).toBe(true);
		gate.resolve(balance("20"));
		await probing;
		expect(getDeepSeekQuotaSnapshot(config.id)?.balances[0]?.remaining).toBe(9);
		expect(f.service.peekKeyForSelection(second.id)?.data?.amounts[0]?.remaining).toBe(20);
		expect(
			readQuotaSnapshots(true, false).entries.find((entry) => entry.credentialId === second.id)
				?.snapshot?.balances[0]?.remaining,
		).toBe(20);
		for (const change of ["network", "headers", "key"] as const) {
			f.advance(10_000);
			const started = deferred<void>();
			const late = deferred<Response>();
			respond = () => {
				started.resolve();
				return late.promise;
			};
			const stale = refreshQuotaSnapshots({ groupId: config.id, credentialId: second.id });
			await started.promise;
			const previousGeneration = required(f.service.peekKey(second.id)).generation;
			if (change === "network") store.update(second.id, { network: { proxy: { mode: "direct" } } });
			else if (change === "headers")
				store.update(second.id, {
					network: { proxy: { mode: "direct" }, extraHeaders: { "X-Key-Route": "new" } },
				});
			else store.update(second.id, { apiKey: "sk-replaced" });
			expect(f.service.peekKey(second.id)?.data).toBeNull();
			expect(f.service.peekKey(second.id)?.generation).not.toBe(previousGeneration);
			respond = async () => balance("30");
			await refreshQuotaSnapshots({ groupId: config.id, credentialId: second.id });
			late.resolve(balance("99"));
			await stale;
			expect(getDeepSeekQuotaSnapshot(config.id, second.id)?.balances[0]?.remaining).toBe(30);
			expect(getDeepSeekQuotaSnapshot(config.id)?.balances[0]?.remaining).toBe(9);
		}
	});

	test("the first credential uses its own proxy", async () => {
		const config = provider("ds-proxy", "https://api.deepseek.com/v1");
		const f = pluginFixture(config, "deepseek");
		getProviderKeyStore().update(f.keyId, {
			network: { proxy: { mode: "custom", url: "http://key.proxy.invalid:8080" } },
		});
		let proxyUrl: string | undefined;
		respond = async (_url, _init, transport) => {
			proxyUrl = transport?.proxyUrl;
			return Response.json(deepSeekBody);
		};
		await refreshDeepSeekBalance(config.id);
		expect(proxyUrl).toBe("http://key.proxy.invalid:8080");
		expect(f.service.peekKey(f.keyId)?.data?.amounts[0]?.remaining).toBe(12.5);
	});

	test("the supported Anthropic preset uses the same DeepSeek balance endpoint", async () => {
		const config = provider(
			"ds-anthropic",
			"https://api.deepseek.com/anthropic",
			"sk-one",
			"anthropic-messages",
		);
		const f = pluginFixture(config, "deepseek");
		let requested = "";
		respond = async (url) => {
			requested = url;
			return Response.json(deepSeekBody);
		};
		syncDeepSeekBalanceCache();
		await refreshDeepSeekBalance(config.id);
		expect(requested).toBe("https://api.deepseek.com/user/balance");
		expect(f.service.peekKey(f.keyId)?.data?.amounts[0]?.unit).toBe("CNY");
	});
});

describe("relay and site plugin quota", () => {
	test("a changed endpoint and source cannot reuse another family's snapshot", async () => {
		const config = provider("relay-switch", "https://relay.example/v1");
		const f = pluginFixture(config, "relay");
		respond = async () =>
			Response.json({ mode: "unrestricted", isValid: true, balance: 12, unit: "USD" });
		expect((await providerBalanceCache.request(config.id))?.status).toBe("supported");
		const generation = required(f.service.peekKey(f.keyId)).generation;
		saved(config.id).baseUrl = "https://api.kimi.com/coding/v1";
		f.source.contributionId = "kimi";
		f.source.id = `${PLUGIN_ID}/kimi`;
		f.source.declaration = providerQuotaSourceSchema.parse(
			QUOTA_SOURCES.find((source) => source.id === "kimi"),
		);
		f.service.invalidateSources();
		expect(providerBalanceCache.peek(config.id)?.balance).toBeNull();
		expect(f.service.peekKey(f.keyId)?.generation).not.toBe(generation);
		respond = async () => Response.json(kimiBody);
		await f.service.refreshKey(f.keyId);
		expect(toQuotaSnapshot(f.service.peekKey(f.keyId))?.scope).toBe("subscription");
		saved(config.id).baseUrl = config.baseUrl;
		f.source.contributionId = "relay";
		f.source.id = `${PLUGIN_ID}/relay`;
		f.source.declaration = providerQuotaSourceSchema.parse(
			QUOTA_SOURCES.find((source) => source.id === "relay"),
		);
		f.service.invalidateSources();
		expect(providerBalanceCache.peek(config.id)?.balance).toBeNull();
		respond = async () =>
			Response.json({ mode: "unrestricted", isValid: true, balance: 12, unit: "USD" });
		await providerBalanceCache.request(config.id);
		expect(providerBalanceCache.peek(config.id)?.balance?.amounts[0]?.remaining).toBe(12);
		expect(f.query).toHaveBeenCalledTimes(3);
	});

	test("key balance preserves amount IDs and the endpoint remains an owner-private cursor", async () => {
		const config = provider("relay", "https://relay.example/v1");
		const f = pluginFixture(config, "relay");
		respond = async () =>
			Response.json({ mode: "unrestricted", isValid: true, balance: 12, unit: "USD" });
		const observed = required(await f.service.refreshKey(f.keyId));
		const snapshot = required(toQuotaSnapshot(observed));
		expect(snapshot.scope).toBe("wallet");
		expect(snapshot.balances).toMatchObject([{ id: "amount:0", unit: "USD", remaining: 12 }]);
		expect(observed.data?.format).toBe("sub2api");
		expect(observed).not.toHaveProperty("cursor");
		f.advance(10_000);
		await f.service.refreshKey(f.keyId);
		expect(f.query.mock.calls[1]?.[2]).toMatchObject({
			mode: "refresh",
			cursor: JSON.stringify({ adapter: "sub2api", root: "https://relay.example" }),
		});
	});

	test("site account quota keeps its provider scope, plan, totals and stream incompatibility", async () => {
		const config = {
			...provider("site", "https://relay.example/v1"),
			quotaSiteUrl: "https://relay.example",
			quotaAccessToken: "site-token",
			quotaUserId: "42",
		};
		const f = pluginFixture(config, "relay");
		respond = async () =>
			Response.json({
				success: true,
				data: { quota: 5_000_000, used_quota: 1_000_000, group: "vip" },
			});
		const observed = required(await f.service.refresh(config.id));
		const snapshot = required(toQuotaSnapshot(observed));
		expect(observed).toMatchObject({
			providerId: config.id,
			pushCompatible: false,
			status: "supported",
		});
		expect(observed.keyId).toBeUndefined();
		expect(snapshot.scope).toBe("wallet");
		expect(snapshot.plan).toBe("vip");
		expect(snapshot.balances).toMatchObject([
			{ id: "amount:0", unit: "USD", remaining: 10, total: 12 },
		]);
		for (const admin of [false, true]) {
			const entries = readQuotaSnapshots(admin, false).entries.filter(
				(entry) => entry.groupId === config.id,
			);
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({
				credentialId: null,
				primary: true,
				source: "probe",
				generation: observed.generation,
			});
		}
	});
});
