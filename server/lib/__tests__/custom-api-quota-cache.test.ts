import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import type { CredentialNetwork } from "@shared/credential-network";
import {
	customApiStreamQuotaIdentity,
	getAllCustomApiCachedQuotas,
	getCustomApiCachedQuota,
	purgeCustomApiQuotaCache,
	updateCustomApiQuotaByPrefix,
} from "../custom-api-quota-cache";
import { getNarraforkPath } from "../narrafork-home";
import { keyQuotaBlockedUntil } from "../provider-key-quota";
import { streamQuotaIdentityForRequest } from "../provider-key-subjects";
import { getProviderKeyStore, withProviderKey } from "../provider-keys";
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
	identity = streamQuotaIdentityForRequest(prefix, {
		credentialId: getProviderKeyStore().listGroup(providerId)[0]?.id,
	}),
): void {
	updateCustomApiQuotaByPrefix(prefix, balance, detail, identity);
}

function expectLateQuotaRejected(expectedIdentity: string): void {
	const config = settings.customApiProviders?.[0];
	if (!config) throw new Error("custom quota test provider missing");
	const key = getProviderKeyStore().listGroup(config.id)[0];
	const effectiveConfig = key ? withProviderKey(config, key) : config;
	expect(streamQuotaIdentityForRequest("custom-quota", { credentialId: key?.id })).not.toBe(
		expectedIdentity,
	);
	reportQuota("custom-quota", "99", null, expectedIdentity);
	expect(
		quotaStore.peekForIdentity(
			key?.id ?? config.id,
			customApiStreamQuotaIdentity(effectiveConfig),
			STREAM_QUOTA_SOURCE,
		),
	).toBeUndefined();
	expect(getCustomApiCachedQuota(providerId)).toBeUndefined();
	// A newly captured request is still allowed to publish under the new identity.
	reportQuota("custom-quota", "7");
	expect(getCustomApiCachedQuota(providerId)?.quotaBalance).toBe("7");
}

afterEach(() => {
	purgeCustomApiQuotaCache([providerId]);
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

	test("stream balances remain on the selected key after reorder and never replace its probe", () => {
		useProvider();
		const store = getProviderKeyStore();
		const first = store.list(providerId)[0];
		if (!first) throw new Error("Missing first test key");
		const second = store.add(providerId, { apiKey: "key-two" });
		const identity = streamQuotaIdentityForRequest("custom-quota", { credentialId: second.id });
		const reset = Date.now() + 60_000;
		quotaStore.set(second.id, "probe", {
			fetchedAt: Date.now(),
			scope: "key",
			balances: [],
			windows: [{ kind: "weekly", usedRatio: 1, resetsAt: reset }],
		});
		store.reorder(providerId, [second.id, first.id]);
		store.reorder(providerId, [first.id, second.id]);
		reportQuota("custom-quota", "7", null, identity);
		expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(7);
		expect(quotaStore.peek(first.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
		expect(keyQuotaBlockedUntil(second.id)).toBe(reset);
		store.update(second.id, { apiKey: "key-replaced" });
		reportQuota("custom-quota", "99", null, identity);
		expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(7);
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

	test("an explicit secondary credential owns only its stream slot; the DTO still shows first", () => {
		useProvider();
		reportQuota("custom-quota", "11", "first account");
		const second = getProviderKeyStore().add(providerId, { apiKey: "key-two" });
		const identity = streamQuotaIdentityForRequest("custom-quota", { credentialId: second.id });
		updateCustomApiQuotaByPrefix("custom-quota", "0", "second account", identity);
		expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)?.balances).toEqual([
			{ unit: "", remaining: 0 },
		]);
		expect(getCustomApiCachedQuota(providerId)?.quotaBalance).toBe("11");
		expect(getAllCustomApiCachedQuotas()[providerId]?.detailedQuotaBalance).toBe("first account");
		// Rotating A does not change B's effective request identity.
		getProviderKeyStore().update(providerId, { apiKey: "first-replaced" });
		expect(streamQuotaIdentityForRequest("custom-quota", { credentialId: second.id })).toBe(
			identity,
		);
		updateCustomApiQuotaByPrefix("custom-quota", "2", null, identity);
		expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(2);
	});

	for (const change of ["key", "network", "removed"] as const) {
		test(`a secondary credential's late quota after ${change} never reaches either key`, () => {
			useProvider();
			const second = getProviderKeyStore().add(providerId, { apiKey: "key-two" });
			const identity = streamQuotaIdentityForRequest("custom-quota", { credentialId: second.id });
			if (change === "key") getProviderKeyStore().update(second.id, { apiKey: "changed" });
			else if (change === "network")
				getProviderKeyStore().update(second.id, {
					network: { userAgentMode: "custom", customUserAgent: "changed-agent" },
				});
			else getProviderKeyStore().remove(second.id);
			updateCustomApiQuotaByPrefix("custom-quota", "0", null, identity);
			expect(quotaStore.peek(providerId, STREAM_QUOTA_SOURCE)).toBeUndefined();
			expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
		});
	}

	test("stream identity reads and explicit-key updates never initialize credentials or restore quota", async () => {
		useProvider();
		const second = getProviderKeyStore().add(providerId, { apiKey: "key-two" });
		const keys = await import("../provider-keys");
		const initialize = spyOn(keys, "getProviderKeyStore").mockImplementation(() => {
			throw new Error("stream attribution initialized credentials");
		});
		const restore = spyOn(quotaStore, "get").mockImplementation(() => {
			throw new Error("stream attribution restored quota");
		});
		try {
			const identity = streamQuotaIdentityForRequest("custom-quota", { credentialId: second.id });
			expect(identity).toBeDefined();
			updateCustomApiQuotaByPrefix("custom-quota", "2", null, identity);
			expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(2);
			expect(initialize).not.toHaveBeenCalled();
			expect(restore).not.toHaveBeenCalled();
		} finally {
			initialize.mockRestore();
			restore.mockRestore();
		}
	});

	test("an explicit foreign or unknown id cannot fall back to the first credential", () => {
		useProvider();
		for (const credentialId of ["unknown-key", "", "another-provider-key"]) {
			const identity = streamQuotaIdentityForRequest("custom-quota", { credentialId });
			expect(identity).toBeUndefined();
			updateCustomApiQuotaByPrefix("custom-quota", "0", null, identity);
			expect(quotaStore.peek(providerId, STREAM_QUOTA_SOURCE)).toBeUndefined();
		}
	});

	test("purging a pooled provider removes all recorded stream keys but retains their probe slots", () => {
		useProvider();
		reportQuota("custom-quota", "11");
		const second = getProviderKeyStore().add(providerId, { apiKey: "key-two" });
		updateCustomApiQuotaByPrefix(
			"custom-quota",
			"2",
			null,
			streamQuotaIdentityForRequest("custom-quota", { credentialId: second.id }),
		);
		quotaStore.set(
			second.id,
			"probe-only",
			{
				fetchedAt: Date.now(),
				scope: "key",
				windows: [],
				balances: [{ unit: "USD", remaining: 5 }],
			},
			false,
		);
		// A first-key DTO read must not forget which secondary stream slot needs cleanup.
		expect(getCustomApiCachedQuota(providerId)?.quotaBalance).toBe("11");
		purgeCustomApiQuotaCache([providerId]);
		expect(quotaStore.peek(providerId, STREAM_QUOTA_SOURCE)).toBeUndefined();
		expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
		expect(quotaStore.peek(second.id)?.balances[0]?.remaining).toBe(5);
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

	const networkChanges: Array<[string, CredentialNetwork]> = [
		["proxy", { proxy: { mode: "custom", url: "http://new-proxy.example:8080" } }],
		["UA", { userAgentMode: "custom", customUserAgent: "new-stream-agent" }],
		["headers", { extraHeaders: { "X-Account": "new-stream-network" } }],
	];
	for (const [name, network] of networkChanges) {
		test(`a late event after the first key's ${name} changes cannot publish a new-network snapshot`, () => {
			useProvider();
			const key = getProviderKeyStore().listGroup(providerId)[0];
			if (!key) throw new Error("custom quota test key missing");
			reportQuota("custom-quota", "12");
			const expectedIdentity = streamQuotaIdentityForRequest("custom-quota", {
				credentialId: getProviderKeyStore().listGroup(providerId)[0]?.id,
			});
			if (!expectedIdentity) throw new Error("custom stream identity missing");
			getProviderKeyStore().update(key.id, { network });
			expectLateQuotaRejected(expectedIdentity);
		});
	}

	test("a late event after a global proxy change cannot publish a new-network snapshot", () => {
		useProvider();
		settings.proxy = { mode: "direct" };
		reportQuota("custom-quota", "12");
		const expectedIdentity = streamQuotaIdentityForRequest("custom-quota", {
			credentialId: getProviderKeyStore().listGroup(providerId)[0]?.id,
		});
		if (!expectedIdentity) throw new Error("custom stream identity missing");
		settings.proxy = { mode: "custom", url: "http://new-global-proxy.example:8080" };
		expectLateQuotaRejected(expectedIdentity);
	});

	test("a late event cannot follow a same-secret replacement of the first credential", () => {
		useProvider();
		reportQuota("custom-quota", "12");
		const expectedIdentity = streamQuotaIdentityForRequest("custom-quota", {
			credentialId: getProviderKeyStore().listGroup(providerId)[0]?.id,
		});
		if (!expectedIdentity) throw new Error("custom stream identity missing");
		const replacement = getProviderKeyStore().add(providerId, { apiKey: "key-one" });
		getProviderKeyStore().reorder(providerId, [replacement.id]);
		expectLateQuotaRejected(expectedIdentity);
	});

	test("a late event cannot follow a first-key secret edit hidden by the settings projection", () => {
		useProvider();
		const key = getProviderKeyStore().listGroup(providerId)[0];
		if (!key) throw new Error("custom quota test key missing");
		reportQuota("custom-quota", "12");
		const expectedIdentity = streamQuotaIdentityForRequest("custom-quota", {
			credentialId: getProviderKeyStore().listGroup(providerId)[0]?.id,
		});
		if (!expectedIdentity) throw new Error("custom stream identity missing");
		getProviderKeyStore().update(key.id, { apiKey: "key-secret-edited" });
		expectLateQuotaRejected(expectedIdentity);
	});

	test("an event from before a provider identity change cannot write the replacement key", () => {
		useProvider();
		const current = settings.customApiProviders?.[0];
		if (!current) throw new Error("custom quota test provider missing");
		const expectedIdentity = streamQuotaIdentityForRequest("custom-quota", {
			credentialId: getProviderKeyStore().listGroup(providerId)[0]?.id,
		});
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
