import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	getAllCustomApiCachedQuotas,
	getCustomApiCachedQuota,
	updateCustomApiQuotaByPrefix,
} from "../custom-api-quota-cache";
import { getNarraforkPath } from "../narrafork-home";
import { getProviderKeyStore } from "../provider-keys";
import { saveSettings, settings } from "../settings";
import { quotaStore } from "../sourcing/quota-store";

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

afterEach(() => {
	quotaStore.remove(providerId);
	getProviderKeyStore().removeProvider(providerId);
	saveSettings(original);
});

describe("response quota_balance snapshots", () => {
	test("raw strings, null and the settings DTO survive exactly", async () => {
		useProvider();
		updateCustomApiQuotaByPrefix("custom-quota", "站点额度 75%", "line one\nline two");
		expect(getAllCustomApiCachedQuotas()).toEqual({
			[providerId]: {
				quotaBalance: "站点额度 75%",
				detailedQuotaBalance: "line one\nline two",
				fetchedAt: expect.any(Number),
			},
		});
		expect(quotaStore.peek(providerId)?.balances).toEqual([{ unit: "", remaining: null }]);
		expect(quotaStore.peek(providerId)?.detail).toEqual({
			quotaBalance: "站点额度 75%",
			detailedQuotaBalance: "line one\nline two",
		});

		updateCustomApiQuotaByPrefix("custom-quota", "0", null);
		expect(quotaStore.peek(providerId)?.balances).toEqual([{ unit: "", remaining: 0 }]);
		updateCustomApiQuotaByPrefix("custom-quota", null, null);
		expect(getCustomApiCachedQuota(providerId)).toEqual({
			quotaBalance: null,
			detailedQuotaBalance: null,
			fetchedAt: expect.any(Number),
		});
		expect(quotaStore.peek(providerId)?.balances).toEqual([]);
		await quotaStore.flush();
		expect(existsSync(getNarraforkPath("custom-api-quotas.json"))).toBe(false);
	});

	test("the first credential owns the snapshot and key changes withdraw it", () => {
		useProvider();
		const second = getProviderKeyStore().add(providerId, { apiKey: "key-two" });
		getProviderKeyStore().reorder(providerId, [second.id]);
		updateCustomApiQuotaByPrefix("custom-quota", "12.5", "details");
		expect(quotaStore.peek(second.id)?.balances).toEqual([{ unit: "", remaining: 12.5 }]);
		expect(getCustomApiCachedQuota(providerId)?.quotaBalance).toBe("12.5");
		getProviderKeyStore().update(second.id, { apiKey: "key-other" });
		expect(getCustomApiCachedQuota(providerId)).toBeUndefined();
		quotaStore.remove(second.id);
	});
});
