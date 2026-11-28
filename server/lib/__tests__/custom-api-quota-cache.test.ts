import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
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
import { legacyQuotaFixture, required } from "./provider-quota-legacy-fixture";

const original = structuredClone(settings);
const providerId = "custom-quota-test";
let fixture: ReturnType<typeof legacyQuotaFixture> | undefined;

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
	fixture = legacyQuotaFixture(settings.customApiProviders);
}

function captureQuota(credentialId = getProviderKeyStore().listGroup(providerId)[0]?.id) {
	return {
		identity: required(streamQuotaIdentityForRequest("custom-quota", { credentialId })),
		generation: required(required(fixture).service.peekKey(required(credentialId))).generation,
	};
}

function reportQuota(
	prefix: string,
	balance: string | null,
	detail?: string | null,
	capture = captureQuota(),
): void {
	updateCustomApiQuotaByPrefix(prefix, balance, detail, capture.identity, capture.generation);
}

function expectLateQuotaRejected(capture: ReturnType<typeof captureQuota>): void {
	const config = settings.customApiProviders?.[0];
	if (!config) throw new Error("custom quota test provider missing");
	const key = getProviderKeyStore().listGroup(config.id)[0];
	const effectiveConfig = key ? withProviderKey(config, key) : config;
	expect(streamQuotaIdentityForRequest("custom-quota", { credentialId: key?.id })).not.toBe(
		capture.identity,
	);
	reportQuota("custom-quota", "99", null, capture);
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
	fixture?.dispose();
	fixture = undefined;
	mock.restore();
	saveSettings(original);
});

describe("response quota_balance snapshots", () => {
	test("raw strings, null and the settings DTO survive exactly", async () => {
		useProvider();
		const capture = captureQuota();
		reportQuota("custom-quota", "站点额度 75%", "line one\nline two", capture);
		expect(getAllCustomApiCachedQuotas()).toEqual({
			[providerId]: {
				generation: capture.generation,
				quotaBalance: "站点额度 75%",
				detailedQuotaBalance: "line one\nline two",
				fetchedAt: expect.any(Number),
			},
		});
		expect(quotaStore.peek(providerId, STREAM_QUOTA_SOURCE)?.balances).toEqual([
			{ unit: "", remaining: null },
		]);
		expect(quotaStore.peek(providerId, STREAM_QUOTA_SOURCE)?.detail).toEqual({
			generation: capture.generation,
			quotaBalance: "站点额度 75%",
			detailedQuotaBalance: "line one\nline two",
		});

		reportQuota("custom-quota", "0", null);
		expect(quotaStore.peek(providerId, STREAM_QUOTA_SOURCE)?.balances).toEqual([
			{ unit: "", remaining: 0 },
		]);
		reportQuota("custom-quota", null, null);
		expect(getCustomApiCachedQuota(providerId)).toEqual({
			generation: capture.generation,
			quotaBalance: null,
			detailedQuotaBalance: null,
			fetchedAt: expect.any(Number),
		});
		expect(quotaStore.peek(providerId, STREAM_QUOTA_SOURCE)?.balances).toEqual([]);
		required(fixture).setEnabled(false);
		reportQuota("custom-quota", "99", "late disabled-source balance", capture);
		expect(getCustomApiCachedQuota(providerId)).toBeUndefined();
		expect(getAllCustomApiCachedQuotas()).toEqual({});
		await quotaStore.flush();
		expect(existsSync(getNarraforkPath("custom-api-quotas.json"))).toBe(false);
	});

	test("stream balances remain on the selected key after reorder and never replace its probe", () => {
		useProvider();
		const store = getProviderKeyStore();
		const first = store.list(providerId)[0];
		if (!first) throw new Error("Missing first test key");
		const second = store.add(providerId, { apiKey: "key-two" });
		const capture = captureQuota(second.id);
		const reset = Date.now() + 60_000;
		quotaStore.set(second.id, "probe", {
			fetchedAt: Date.now(),
			scope: "key",
			balances: [],
			windows: [{ kind: "weekly", usedRatio: 1, resetsAt: reset }],
		});
		store.reorder(providerId, [second.id, first.id]);
		store.reorder(providerId, [first.id, second.id]);
		reportQuota("custom-quota", "7", null, capture);
		expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(7);
		expect(quotaStore.peek(first.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
		expect(keyQuotaBlockedUntil(second.id)).toBe(reset);
		store.update(second.id, { apiKey: "key-replaced" });
		reportQuota("custom-quota", "99", null, capture);
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
		const capture = captureQuota(second.id);
		reportQuota("custom-quota", "0", "second account", capture);
		expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)?.balances).toEqual([
			{ unit: "", remaining: 0 },
		]);
		expect(getCustomApiCachedQuota(providerId)?.quotaBalance).toBe("11");
		expect(getAllCustomApiCachedQuotas()[providerId]?.detailedQuotaBalance).toBe("first account");
		// Rotating A does not change B's effective request identity or generation.
		getProviderKeyStore().update(providerId, { apiKey: "first-replaced" });
		expect(captureQuota(second.id)).toEqual(capture);
		reportQuota("custom-quota", "2", null, capture);
		expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(2);
	});

	for (const change of ["key", "network", "removed"] as const) {
		test(`a secondary credential's late quota after ${change} never reaches either key`, () => {
			useProvider();
			const second = getProviderKeyStore().add(providerId, { apiKey: "key-two" });
			const capture = captureQuota(second.id);
			if (change === "key") getProviderKeyStore().update(second.id, { apiKey: "changed" });
			else if (change === "network")
				getProviderKeyStore().update(second.id, {
					network: { userAgentMode: "custom", customUserAgent: "changed-agent" },
				});
			else getProviderKeyStore().remove(second.id);
			reportQuota("custom-quota", "0", null, capture);
			expect(quotaStore.peek(providerId, STREAM_QUOTA_SOURCE)).toBeUndefined();
			expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
		});
	}

	test("stream identity reads and explicit-key updates never initialize credentials or restore quota", async () => {
		useProvider();
		const second = getProviderKeyStore().add(providerId, { apiKey: "key-two" });
		const capture = captureQuota(second.id);
		const keys = await import("../provider-keys");
		const initialize = spyOn(keys, "getProviderKeyStore").mockImplementation(() => {
			throw new Error("stream attribution initialized credentials");
		});
		const restore = spyOn(quotaStore, "get").mockImplementation(() => {
			throw new Error("stream attribution restored quota");
		});
		try {
			const identity = streamQuotaIdentityForRequest("custom-quota", { credentialId: second.id });
			expect(identity).toBe(capture.identity);
			updateCustomApiQuotaByPrefix("custom-quota", "2", null, identity, capture.generation);
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
		const { generation } = captureQuota();
		for (const credentialId of ["unknown-key", "", "another-provider-key"]) {
			const identity = streamQuotaIdentityForRequest("custom-quota", { credentialId });
			expect(identity).toBeUndefined();
			updateCustomApiQuotaByPrefix("custom-quota", "0", null, identity, generation);
			expect(quotaStore.peek(providerId, STREAM_QUOTA_SOURCE)).toBeUndefined();
		}
	});

	test("an explicit quota key selects a promoted backup while billing still names its disabled predecessor", () => {
		useProvider();
		const store = getProviderKeyStore();
		const first = required(store.listGroup(providerId)[0]);
		expect(first.id).toBe(providerId);
		const backup = store.add(providerId, { apiKey: "promoted-backup" });
		store.update(first.id, { disabled: true });
		store.reorder(providerId, [backup.id, first.id]);
		const capture = captureQuota(backup.id);
		const info = { credentialId: providerId, quotaCredentialId: backup.id };
		expect(streamQuotaIdentityForRequest("custom-quota", info)).toBe(capture.identity);
		// The ambiguous billing id on its own must still be rejected.
		expect(
			streamQuotaIdentityForRequest("custom-quota", { credentialId: providerId }),
		).toBeUndefined();
		expect(
			streamQuotaIdentityForRequest("custom-quota", {
				...info,
				validateDiagnosticCredential: () => false,
			}),
		).toBeUndefined();
		reportQuota("custom-quota", "6", null, capture);
		expect(quotaStore.peek(backup.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(6);
		expect(quotaStore.peek(first.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
	});

	test("explicit quota keys never borrow a group alias, disabled key, unknown key or another prefix", () => {
		useProvider();
		const store = getProviderKeyStore();
		const first = required(store.listGroup(providerId)[0]);
		store.remove(first.id);
		const only = store.add(providerId, { id: "explicit-quota-key", apiKey: "key-one" });
		const disabled = store.add(providerId, { apiKey: "disabled-quota-key" });
		store.update(disabled.id, { disabled: true });
		expect(store.get(disabled.id)?.disabled).toBe(true);
		const capture = captureQuota(only.id);
		const foreignOwner = "other-custom-quota-owner";
		const foreign = store.add(foreignOwner, { apiKey: only.apiKey });
		try {
			for (const quotaCredentialId of [providerId, "unknown-key", "", disabled.id, foreign.id]) {
				const identity = streamQuotaIdentityForRequest("custom-quota", {
					credentialId: only.id,
					quotaCredentialId,
				});
				expect(identity).toBeUndefined();
				updateCustomApiQuotaByPrefix("custom-quota", "99", null, identity, capture.generation);
				expect(quotaStore.peek(only.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
			}
			expect(
				streamQuotaIdentityForRequest("missing-prefix", {
					credentialId: providerId,
					quotaCredentialId: only.id,
				}),
			).toBeUndefined();
		} finally {
			store.removeGroup(foreignOwner);
		}
	});

	test("a deleted explicit quota key cannot follow a new key with the same secret", () => {
		useProvider();
		const store = getProviderKeyStore();
		const first = required(store.listGroup(providerId)[0]);
		const info = { credentialId: providerId, quotaCredentialId: first.id };
		expect(streamQuotaIdentityForRequest("custom-quota", info)).toBeString();
		store.remove(first.id);
		const replacement = store.add(providerId, { apiKey: first.apiKey });
		expect(replacement.id).not.toBe(first.id);
		expect(streamQuotaIdentityForRequest("custom-quota", info)).toBeUndefined();
		expect(
			streamQuotaIdentityForRequest("custom-quota", {
				...info,
				quotaCredentialId: replacement.id,
			}),
		).toBeString();
	});

	test("purging a pooled provider removes all recorded stream keys but retains their probe slots", () => {
		useProvider();
		reportQuota("custom-quota", "11");
		const second = getProviderKeyStore().add(providerId, { apiKey: "key-two" });
		reportQuota("custom-quota", "2", null, captureQuota(second.id));
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
			const capture = captureQuota(key.id);
			getProviderKeyStore().update(key.id, { network });
			expectLateQuotaRejected(capture);
		});
	}

	test("a late event after a global proxy change cannot publish a new-network snapshot", () => {
		useProvider();
		settings.proxy = { mode: "direct" };
		reportQuota("custom-quota", "12");
		const capture = captureQuota();
		settings.proxy = { mode: "custom", url: "http://new-global-proxy.example:8080" };
		expectLateQuotaRejected(capture);
	});

	test("a late event cannot follow a same-secret replacement of the first credential", () => {
		useProvider();
		reportQuota("custom-quota", "12");
		const capture = captureQuota();
		const replacement = getProviderKeyStore().add(providerId, { apiKey: "key-one" });
		getProviderKeyStore().reorder(providerId, [replacement.id]);
		expectLateQuotaRejected(capture);
	});

	test("a late event cannot follow a first-key secret edit hidden by the settings projection", () => {
		useProvider();
		const key = getProviderKeyStore().listGroup(providerId)[0];
		if (!key) throw new Error("custom quota test key missing");
		reportQuota("custom-quota", "12");
		const capture = captureQuota();
		getProviderKeyStore().update(key.id, { apiKey: "key-secret-edited" });
		expectLateQuotaRejected(capture);
	});

	test("an event from before a provider identity change cannot write the replacement key", () => {
		useProvider();
		const current = settings.customApiProviders?.[0];
		if (!current) throw new Error("custom quota test provider missing");
		const capture = captureQuota();
		saveSettings({
			...settings,
			customApiProviders: [{ ...current, apiKey: "key-replacement" }],
		});
		reportQuota("custom-quota", "old-key balance", null, capture);
		expect(getCustomApiCachedQuota(providerId)).toBeUndefined();
		// A request whose identity could not be captured is not fail-open either.
		updateCustomApiQuotaByPrefix(
			"custom-quota",
			"unknown-source",
			null,
			undefined,
			captureQuota().generation,
		);
		expect(getCustomApiCachedQuota(providerId)).toBeUndefined();
	});
});
