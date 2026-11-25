import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { getNarraforkPath } from "../narrafork-home";
import * as outbound from "../net/outbound-fetch";
import {
	buildNugQuotaCache,
	getAllNugCachedQuotas,
	getNugCachedQuota,
	getNugQuotaSnapshot,
	isNugQuotaRefreshing,
	refreshNugQuota,
	setNugCachedQuota,
	updateNugQuotaByPrefix,
} from "../nug-quota-cache";
import { streamQuotaIdentity, streamQuotaIdentityForPrefix } from "../provider-key-subjects";
import { getProviderKeyStore, nugKeyOwner } from "../provider-keys";
import { saveSettings, settings } from "../settings";
import { readQuotaSnapshots, refreshQuotaSnapshots } from "../sourcing/quota-snapshots";
import { quotaStore, STREAM_QUOTA_SOURCE } from "../sourcing/quota-store";
import { getServiceTemplate } from "../sourcing/templates";

const original = structuredClone(settings);
const originalFetch = globalThis.fetch;
const providerId = "nug-quota-test";

function useProvider() {
	saveSettings({
		...settings,
		nugProviders: [
			{
				id: providerId,
				name: "NUG quota",
				prefix: "nug-quota",
				baseUrl: "https://nug.example",
				apiKey: "key-one",
				defaultModel: "model",
			},
		],
	});
	const config = settings.nugProviders?.[0];
	if (!config) throw new Error("NUG test provider was not saved");
	return config;
}

function reportNugQuota(
	prefix: string,
	balance: number | null,
	detail?: string | null,
	extra?: unknown,
	identity = streamQuotaIdentityForPrefix(prefix),
): void {
	updateNugQuotaByPrefix(prefix, balance, detail, extra, identity);
}

afterEach(() => {
	for (const key of getProviderKeyStore().list(nugKeyOwner(providerId))) {
		quotaStore.remove(key.id);
		quotaStore.remove(key.id, STREAM_QUOTA_SOURCE);
	}
	quotaStore.remove(providerId);
	getProviderKeyStore().removeProvider(nugKeyOwner(providerId));
	saveSettings(original);
	globalThis.fetch = originalFetch;
});

describe("NUG quota snapshots", () => {
	test("legacy quotas round-trip field for field and stream updates stay partial", async () => {
		useProvider();
		setNugCachedQuota(
			providerId,
			buildNugQuotaCache({
				balance: 12,
				totalGranted: 30,
				detailedQuotaBalance: "wallet details",
				extra: { region: "test" },
			}),
		);
		expect(getAllNugCachedQuotas()).toEqual({
			[providerId]: {
				balance: 12,
				totalGranted: 30,
				detailedQuotaBalance: "wallet details",
				extra: { region: "test" },
			},
		});
		const credentialId = getProviderKeyStore().list(nugKeyOwner(providerId))[0]?.id ?? providerId;
		expect(quotaStore.peek(credentialId)?.balances).toEqual([
			{ unit: "", remaining: 12, total: 30 },
		]);

		reportNugQuota("nug-quota", 7);
		expect(getNugCachedQuota(providerId)).toEqual({
			balance: 7,
			totalGranted: 30,
			detailedQuotaBalance: "wallet details",
			extra: { region: "test" },
			fetchedAt: expect.any(Number),
		});
		await quotaStore.flush();
		expect(existsSync(getNarraforkPath("nug-quotas.json"))).toBe(false);
	});

	test("a non-first inference key owns stream balances without replacing its direct probe", () => {
		const config = useProvider();
		const store = getProviderKeyStore();
		const first = store.list(nugKeyOwner(providerId))[0];
		if (!first) throw new Error("Missing first NUG key");
		const second = store.add(nugKeyOwner(providerId), { apiKey: "key-two" });
		const expected = streamQuotaIdentityForPrefix("nug-quota", second.id);
		quotaStore.set(second.id, JSON.stringify([config.baseUrl, second.apiKey]), {
			fetchedAt: Date.now(),
			scope: "key",
			windows: [],
			balances: [{ unit: "", remaining: 22 }],
		});
		store.reorder(nugKeyOwner(providerId), [second.id, first.id]);
		store.reorder(nugKeyOwner(providerId), [first.id, second.id]);
		reportNugQuota("nug-quota", 7, null, undefined, expected);
		expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(7);
		expect(quotaStore.peek(second.id)?.balances[0]?.remaining).toBe(22);
		expect(quotaStore.peek(first.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
		store.update(second.id, { apiKey: "key-replaced" });
		reportNugQuota("nug-quota", 99, null, undefined, expected);
		expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(7);
	});

	test("storage follows the first credential and rejects a late old-key publication", () => {
		const config = structuredClone(useProvider());
		const second = getProviderKeyStore().add(nugKeyOwner(providerId), { apiKey: "key-two" });
		getProviderKeyStore().reorder(nugKeyOwner(providerId), [second.id]);
		setNugCachedQuota(providerId, buildNugQuotaCache({ balance: 5, totalGranted: 10 }));
		expect(quotaStore.peek(second.id)?.balances[0]?.remaining).toBe(5);
		expect(getNugCachedQuota(providerId)?.balance).toBe(5);

		// An answer fetched with key-one cannot replace key-two's snapshot.
		setNugCachedQuota(providerId, buildNugQuotaCache({ balance: 99 }), config);
		expect(getNugCachedQuota(providerId)?.balance).toBe(5);
		getProviderKeyStore().update(second.id, { apiKey: "key-other" });
		expect(getNugCachedQuota(providerId)).toBeUndefined();
		quotaStore.remove(second.id);
	});

	test("a stream event from before a provider identity change is discarded", () => {
		const config = structuredClone(useProvider());
		const expectedIdentity = streamQuotaIdentity(config);
		saveSettings({ ...settings, nugProviders: [{ ...config, apiKey: "key-replacement" }] });
		reportNugQuota("nug-quota", 99, null, undefined, expectedIdentity);
		expect(getNugCachedQuota(providerId)).toBeUndefined();
		updateNugQuotaByPrefix("nug-quota", 100, null, undefined, undefined);
		expect(getNugCachedQuota(providerId)).toBeUndefined();
	});

	test("second-key probes use that key's transport and cannot replace the first view or a new identity", async () => {
		useProvider();
		const store = getProviderKeyStore();
		const first = store.list(nugKeyOwner(providerId))[0];
		if (!first) throw new Error("Missing first NUG key");
		const second = store.add(nugKeyOwner(providerId), {
			apiKey: "key-two",
			network: { proxy: { mode: "custom", url: "http://second.proxy:8080" } },
		});
		let gate: ReturnType<typeof Promise.withResolvers<Response>> | undefined;
		const transport = spyOn(outbound, "outboundFetch").mockImplementation(
			async (_url, init, options) => {
				const auth = new Headers(init?.headers).get("Authorization");
				if (auth === "Bearer key-one") return Response.json({ balance: 9, totalGranted: 10 });
				expect(auth).toBe("Bearer key-two");
				expect(options?.proxyUrl).toBe("http://second.proxy:8080");
				return gate ? gate.promise : Response.json({ balance: 20, totalGranted: 30 });
			},
		);
		try {
			await refreshNugQuota(providerId);
			gate = Promise.withResolvers<Response>();
			const probing = refreshQuotaSnapshots({ groupId: providerId, credentialId: second.id });
			expect(isNugQuotaRefreshing(providerId, second.id)).toBe(true);
			expect(isNugQuotaRefreshing(providerId)).toBe(false);
			expect(
				readQuotaSnapshots(true, false).entries.find((entry) => entry.credentialId === second.id)
					?.refreshing,
			).toBe(true);
			gate.resolve(Response.json({ balance: 20, totalGranted: 30 }));
			await probing;
			expect(getNugCachedQuota(providerId)?.balance).toBe(9);
			expect(getNugQuotaSnapshot(providerId, second.id)?.snapshot?.balances[0]?.remaining).toBe(20);
			reportNugQuota(
				"nug-quota",
				7,
				null,
				undefined,
				streamQuotaIdentityForPrefix("nug-quota", second.id),
			);
			const entries = readQuotaSnapshots(true, false).entries.filter(
				(entry) => entry.credentialId === second.id,
			);
			expect(
				entries.find((entry) => entry.source === "probe")?.snapshot?.balances[0]?.remaining,
			).toBe(20);
			expect(
				entries.find((entry) => entry.source === "quota_balance")?.snapshot?.balances[0]?.remaining,
			).toBe(7);
			for (const change of ["network", "headers", "key"] as const) {
				const late = Promise.withResolvers<Response>();
				transport.mockImplementation(async () => late.promise);
				const stale = refreshQuotaSnapshots({ groupId: providerId, credentialId: second.id });
				if (change === "network")
					store.update(second.id, { network: { proxy: { mode: "direct" } } });
				else if (change === "headers")
					store.update(second.id, {
						network: { proxy: { mode: "direct" }, extraHeaders: { "X-Key-Route": "new" } },
					});
				else store.update(second.id, { apiKey: "key-replaced" });
				expect(getNugQuotaSnapshot(providerId, second.id)?.snapshot).toBeUndefined();
				transport.mockImplementation(async () => Response.json({ balance: 30, totalGranted: 40 }));
				await refreshQuotaSnapshots({ groupId: providerId, credentialId: second.id });
				late.resolve(Response.json({ balance: 99, totalGranted: 100 }));
				await stale;
				expect(getNugQuotaSnapshot(providerId, second.id)?.snapshot?.balances[0]?.remaining).toBe(
					30,
				);
				expect(getNugCachedQuota(providerId)?.balance).toBe(9);
			}
		} finally {
			transport.mockRestore();
		}
	});

	test("the nug template probes into the shared shape", async () => {
		useProvider();
		globalThis.fetch = (async () =>
			Response.json({
				balance: 4,
				totalGranted: 9,
				detailedQuotaBalance: "details",
			})) as unknown as typeof fetch;
		const credentialId = getProviderKeyStore().list(nugKeyOwner(providerId))[0]?.id ?? providerId;
		await getServiceTemplate("nug").probeQuota?.({ id: providerId } as never, credentialId);
		const snapshot = quotaStore.peek(credentialId);
		expect(snapshot?.scope).toBe("wallet");
		expect(snapshot?.windows).toEqual([]);
		expect(snapshot?.balances).toEqual([{ unit: "", remaining: 4, total: 9 }]);
		expect(snapshot?.detail).toEqual({
			balance: 4,
			totalGranted: 9,
			detailedQuotaBalance: "details",
		});
	});
});
