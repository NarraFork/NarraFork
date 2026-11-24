import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { getNarraforkPath } from "../narrafork-home";
import {
	buildNugQuotaCache,
	getAllNugCachedQuotas,
	getNugCachedQuota,
	setNugCachedQuota,
	updateNugQuotaByPrefix,
} from "../nug-quota-cache";
import { streamQuotaIdentity, streamQuotaIdentityForPrefix } from "../provider-key-subjects";
import { getProviderKeyStore, nugKeyOwner } from "../provider-keys";
import { saveSettings, settings } from "../settings";
import { quotaStore } from "../sourcing/quota-store";
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
	for (const key of getProviderKeyStore().list(nugKeyOwner(providerId))) quotaStore.remove(key.id);
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

	test("the nug template probes into the shared shape", async () => {
		const config = useProvider();
		globalThis.fetch = (async () =>
			Response.json({
				balance: 4,
				totalGranted: 9,
				detailedQuotaBalance: "details",
			})) as unknown as typeof fetch;
		const snapshot = await getServiceTemplate("nug").probeQuota?.(
			{} as never,
			{ id: providerId, providerId, config },
			AbortSignal.timeout(1000),
		);
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
