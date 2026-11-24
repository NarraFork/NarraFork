import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	getAllCustomApiCachedQuotas,
	getCustomApiCachedQuota,
	purgeCustomApiQuotaCache,
	updateCustomApiQuotaByPrefix,
} from "../custom-api-quota-cache";
import { getNarraforkPath } from "../narrafork-home";
import { keyQuotaBlockedUntil } from "../provider-key-quota";
import { streamQuotaIdentity, streamQuotaIdentityForPrefix } from "../provider-key-subjects";
import { getProviderKeyStore } from "../provider-keys";
import { saveSettings, settings } from "../settings";
import { quotaStore, STREAM_QUOTA_SOURCE } from "../sourcing/quota-store";

const original = structuredClone(settings);
const providerId = "custom-quota-test";

function useProvider() {
	saveSettings({
		...settings,
		customApiProviders: [
			{
				id: providerId,
				name: "Custom quota",
				prefix: "custom-quota",
				baseUrl: "https://relay.example/v1",
				apiKey: "key-one",
				defaultModel: "model",
				protocol: "completions-compatible",
			},
		],
	});
}

function reportQuota(
	prefix: string,
	balance: string | null,
	detail?: string | null,
	identity = streamQuotaIdentityForPrefix(prefix),
): void {
	updateCustomApiQuotaByPrefix(prefix, balance, detail, identity);
}

afterEach(() => {
	for (const key of getProviderKeyStore().list(providerId)) {
		quotaStore.remove(key.id);
		quotaStore.remove(key.id, STREAM_QUOTA_SOURCE);
	}
	quotaStore.remove(providerId);
	quotaStore.remove(providerId, STREAM_QUOTA_SOURCE);
	getProviderKeyStore().removeProvider(providerId);
	saveSettings(original);
});

describe("response quota_balance snapshots", () => {
	test("raw strings, null and the settings DTO survive exactly", async () => {
		useProvider();
		reportQuota("custom-quota", "站点额度 75%", "line one\nline two");
		expect(getAllCustomApiCachedQuotas()).toEqual({
			[providerId]: {
				quotaBalance: "站点额度 75%",
				detailedQuotaBalance: "line one\nline two",
				fetchedAt: expect.any(Number),
			},
		});
		expect(quotaStore.peek(providerId, STREAM_QUOTA_SOURCE)?.balances).toEqual([
			{ unit: "", remaining: null },
		]);
		expect(quotaStore.peek(providerId, STREAM_QUOTA_SOURCE)?.detail).toEqual({
			quotaBalance: "站点额度 75%",
			detailedQuotaBalance: "line one\nline two",
		});

		reportQuota("custom-quota", "0", null);
		expect(quotaStore.peek(providerId, STREAM_QUOTA_SOURCE)?.balances).toEqual([
			{ unit: "", remaining: 0 },
		]);
		reportQuota("custom-quota", null, null);
		expect(getCustomApiCachedQuota(providerId)).toEqual({
			quotaBalance: null,
			detailedQuotaBalance: null,
			fetchedAt: expect.any(Number),
		});
		expect(quotaStore.peek(providerId, STREAM_QUOTA_SOURCE)?.balances).toEqual([]);
		await quotaStore.flush();
		expect(existsSync(getNarraforkPath("custom-api-quotas.json"))).toBe(false);
	});

	test("the first credential owns the snapshot and key changes withdraw it", () => {
		useProvider();
		const second = getProviderKeyStore().add(providerId, { apiKey: "key-two" });
		getProviderKeyStore().reorder(providerId, [second.id]);
		reportQuota("custom-quota", "12.5", "details");
		expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)?.balances).toEqual([
			{ unit: "", remaining: 12.5 },
		]);
		expect(getCustomApiCachedQuota(providerId)?.quotaBalance).toBe("12.5");
		getProviderKeyStore().update(second.id, { apiKey: "key-other" });
		expect(getCustomApiCachedQuota(providerId)).toBeUndefined();
		quotaStore.remove(second.id);
	});

	test("settings reads and purges never evict the direct probe's exhaustion window", () => {
		useProvider();
		const resetsAt = Date.now() + 60_000;
		quotaStore.set(providerId, "opencode-transport-identity", {
			fetchedAt: Date.now(),
			scope: "subscription",
			windows: [{ kind: "weekly", usedRatio: 1, resetsAt }],
			balances: [],
			detail: { rolling: null, weekly: null, monthly: null },
		});
		reportQuota("custom-quota", "12.5", "stream details");
		expect(getAllCustomApiCachedQuotas()[providerId]?.quotaBalance).toBe("12.5");
		expect(keyQuotaBlockedUntil(providerId)).toBe(resetsAt);
		purgeCustomApiQuotaCache([providerId]);
		expect(keyQuotaBlockedUntil(providerId)).toBe(resetsAt);
		expect(getCustomApiCachedQuota(providerId)).toBeUndefined();
	});

	test("an event from before a provider identity change cannot write the replacement key", () => {
		useProvider();
		const current = settings.customApiProviders?.[0];
		if (!current) throw new Error("custom quota test provider missing");
		const expectedIdentity = streamQuotaIdentity(current);
		saveSettings({
			...settings,
			customApiProviders: [{ ...current, apiKey: "key-replacement" }],
		});
		reportQuota("custom-quota", "old-key balance", null, expectedIdentity);
		expect(getCustomApiCachedQuota(providerId)).toBeUndefined();
		// A request whose identity could not be captured is not fail-open either.
		updateCustomApiQuotaByPrefix("custom-quota", "unknown-source", null, undefined);
		expect(getCustomApiCachedQuota(providerId)).toBeUndefined();
	});
});
