import { describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { CredentialNetwork } from "@shared/credential-network";
import { tokenDanceQuotaIdentity } from "../../services/tokendance-service";
import { commandCodeQuotaIdentity } from "../commandcode-usage";
import { customApiStreamQuotaIdentity } from "../custom-api-quota-cache";
import { deepSeekQuotaIdentity } from "../deepseek-balance-cache";
import { kimiQuotaIdentity } from "../kimi-usage-cache";
import { getNarraforkPath } from "../narrafork-home";
import { nugQuotaIdentity } from "../nug-quota-cache";
import { opencodeQuotaIdentity } from "../opencode-usage-cache";
import { createPersistedCredentialCache } from "../persisted-credential-cache";
import { providerBalanceQuotaIdentity } from "../provider-balance-cache";
import { keyQuotaBlockedUntil } from "../provider-key-quota";
import { withProviderKey } from "../provider-keys";
import { settings } from "../settings";
import {
	importLegacyQuotaCache,
	QuotaStore,
	quotaStore,
	STREAM_QUOTA_SOURCE,
} from "../sourcing/quota-store";

const snapshot = (usedRatio: number | null, resetsAt: number | null) => ({
	fetchedAt: 100,
	scope: "subscription" as const,
	windows: [{ kind: "5h" as const, usedRatio, resetsAt }],
	balances: [],
});

const quotaConfig = {
	id: "quota-network-key",
	name: "Quota identity",
	prefix: "quota-identity",
	baseUrl: "https://quota.example/v1",
	apiKey: "quota-network-secret",
	defaultModel: "model",
	protocol: "anthropic-messages" as const,
	disabled: false,
	generation: 1,
};

const quotaSources = [
	{ name: "kimi", identity: kimiQuotaIdentity },
	{ name: "opencode", identity: opencodeQuotaIdentity },
	{ name: "deepseek", identity: deepSeekQuotaIdentity },
	{
		name: "provider-balance",
		identity: (config: typeof quotaConfig) => providerBalanceQuotaIdentity(config, settings.proxy),
	},
	{ name: "nug", identity: nugQuotaIdentity },
	{ name: "commandcode", identity: commandCodeQuotaIdentity },
	{ name: "tokendance", identity: tokenDanceQuotaIdentity },
	{ name: "custom-stream", identity: customApiStreamQuotaIdentity, source: STREAM_QUOTA_SOURCE },
];

const keyNetworks: Array<{ name: string; network: CredentialNetwork }> = [
	{ name: "proxy", network: { proxy: { mode: "custom", url: "http://proxy.example:8080" } } },
	{ name: "UA mode", network: { userAgentMode: "codex" } },
	{
		name: "custom UA",
		network: { userAgentMode: "custom", customUserAgent: "quota-test-agent" },
	},
	{ name: "headers", network: { extraHeaders: { "X-Account": "other-network" } } },
];

for (const { name, identity, source } of quotaSources) {
	describe(`${name} quota identity`, () => {
		for (const change of keyNetworks) {
			test(`a credential ${change.name} change makes the old allowance unknown`, () => {
				const store = new QuotaStore();
				const held = snapshot(1, 500);
				store.set(quotaConfig.id, identity(quotaConfig), held, false, source);
				const changed = withProviderKey(quotaConfig, {
					apiKey: quotaConfig.apiKey,
					network: change.network,
				});
				expect(store.peekForIdentity(quotaConfig.id, identity(changed), source)).toBeUndefined();
				expect(store.peekForIdentity(quotaConfig.id, identity(quotaConfig), source)).toBe(held);
			});
		}

		test("an endpoint or TokenDance generation change makes the old allowance unknown", () => {
			const store = new QuotaStore();
			store.set(quotaConfig.id, identity(quotaConfig), snapshot(1, 500), false, source);
			const changed =
				name === "tokendance"
					? { ...quotaConfig, generation: 2 }
					: { ...quotaConfig, baseUrl: "https://quota.example/another-tenant/v1" };
			expect(store.peekForIdentity(quotaConfig.id, identity(changed), source)).toBeUndefined();
		});

		test("a restarted store cannot restore another credential network's fingerprint", async () => {
			const file = `quota-network-${name}-${crypto.randomUUID()}.json`;
			const store = new QuotaStore(createPersistedCredentialCache(file, (raw) => raw as never));
			const held = snapshot(1, 500);
			store.set(quotaConfig.id, identity(quotaConfig), held, true, source);
			await store.flush();
			const restarted = new QuotaStore(createPersistedCredentialCache(file, (raw) => raw as never));
			const changed = withProviderKey(quotaConfig, {
				apiKey: quotaConfig.apiKey,
				network: { proxy: { mode: "custom", url: "http://another-network.example:8080" } },
			});
			expect(restarted.get(quotaConfig.id, identity(changed), undefined, source)).toBeUndefined();
			expect(restarted.get(quotaConfig.id, identity(quotaConfig), undefined, source)).toEqual(held);
		});

		test("TLS and global proxy changes cannot read the previous allowance", () => {
			settings.proxy = { mode: "direct" };
			const store = new QuotaStore();
			const original = identity(quotaConfig);
			store.set(quotaConfig.id, original, snapshot(1, 500), false, source);
			const changed = { ...quotaConfig, tlsRejectUnauthorized: false };
			expect(store.peekForIdentity(quotaConfig.id, identity(changed), source)).toBeUndefined();
			settings.proxy = { mode: "custom", url: "http://global-proxy.example:8080" };
			expect(store.peekForIdentity(quotaConfig.id, identity(quotaConfig), source)).toBeUndefined();
		});

		test("key rotation invalidates the snapshot; header ordering alone does not", () => {
			const store = new QuotaStore();
			const config = { ...quotaConfig, extraHeaders: { "X-One": "1", "X-Two": "2" } };
			const held = snapshot(1, 500);
			store.set(config.id, identity(config), held, false, source);
			expect(
				store.peekForIdentity(config.id, identity({ ...config, apiKey: "rotated" }), source),
			).toBeUndefined();
			expect(
				store.peekForIdentity(
					config.id,
					identity({ ...config, extraHeaders: { "X-Two": "2", "X-One": "1" } }),
					source,
				),
			).toBe(held);
		});
	});
}

describe("quota store", () => {
	test("persists snapshots as fingerprints only, and reads them back under the same identity", async () => {
		const file = `quota-store-test-${crypto.randomUUID()}.json`;
		const store = new QuotaStore(createPersistedCredentialCache(file, (raw) => raw as never));
		store.set("key-1", '["https://api.kimi.com/coding/v1","sk-secret"]', snapshot(0.4, null));
		await store.flush();
		const raw = readFileSync(getNarraforkPath(file), "utf-8");
		expect(raw).not.toContain("sk-secret");
		expect(raw).not.toContain("api.kimi.com");
		const restarted = new QuotaStore(createPersistedCredentialCache(file, (raw) => raw as never));
		expect(
			restarted.get("key-1", '["https://api.kimi.com/coding/v1","sk-secret"]')?.fetchedAt,
		).toBe(100);
		expect(restarted.get("key-1", '["https://api.kimi.ai/coding/v1","sk-secret"]')).toBeUndefined();
		expect(store.get("key-1", "never-saved")).toBeUndefined();
	});

	test("a changed identity invalidates even the in-memory snapshot", () => {
		const store = new QuotaStore();
		store.set("key-2", "identity-a", snapshot(0.5, null));
		expect(store.get("key-2", "identity-a")).toBeDefined();
		expect(store.get("key-2", "identity-b")).toBeUndefined();
		expect(store.peek("key-2")).toBeUndefined();
	});

	test("identity-aware peek is read-only and never restores a cold or mismatched entry", () => {
		const held = snapshot(0.5, 500);
		const persisted = {
			restore: mock(() => held),
			save: mock(() => {}),
			remove: mock(() => {}),
			flush: mock(() => Promise.resolve()),
		};
		const store = new QuotaStore(persisted);
		expect(store.peekForIdentity("key-peek", "identity-a")).toBeUndefined();
		store.set("key-peek", "identity-a", held, false);
		expect(store.peekForIdentity("key-peek", "identity-a")).toBe(held);
		expect(store.peekForIdentity("key-peek", "identity-b")).toBeUndefined();
		// A mismatched read does not evict the valid identity or alter legacy peek.
		expect(store.peekForIdentity("key-peek", "identity-a")).toBe(held);
		expect(store.peek("key-peek")).toBe(held);
		expect(persisted.restore).not.toHaveBeenCalled();
		expect(persisted.save).not.toHaveBeenCalled();
		expect(persisted.remove).not.toHaveBeenCalled();
		expect(persisted.flush).not.toHaveBeenCalled();
	});

	test("identity-aware peek does not restore disk snapshots until an explicit get warms memory", async () => {
		const file = `quota-store-peek-${crypto.randomUUID()}.json`;
		const store = new QuotaStore(createPersistedCredentialCache(file, (raw) => raw as never));
		store.set("key-cold", "identity-a", snapshot(0.4, null));
		await store.flush();
		const restarted = new QuotaStore(createPersistedCredentialCache(file, (raw) => raw as never));
		expect(restarted.peekForIdentity("key-cold", "identity-a")).toBeUndefined();
		expect(restarted.peek("key-cold")).toBeUndefined();
		const restored = restarted.get("key-cold", "identity-a");
		expect(restored).toEqual(snapshot(0.4, null));
		expect(restarted.peekForIdentity("key-cold", "identity-a")).toBe(restored);
	});

	test("identity-aware peek keeps probe and stream namespaces independent without fallback", () => {
		const store = new QuotaStore();
		const probe = snapshot(1, 500);
		const stream = { ...snapshot(0, null), detail: { quotaBalance: "12.5" } };
		store.set("key-peek-sources", "probe-identity", probe, false);
		expect(
			store.peekForIdentity("key-peek-sources", "probe-identity", STREAM_QUOTA_SOURCE),
		).toBeUndefined();
		store.set("key-peek-sources", "stream-identity", stream, false, STREAM_QUOTA_SOURCE);
		expect(store.peekForIdentity("key-peek-sources", "probe-identity")).toBe(probe);
		expect(store.peekForIdentity("key-peek-sources", "stream-identity", STREAM_QUOTA_SOURCE)).toBe(
			stream,
		);
		expect(store.peekForIdentity("key-peek-sources", "stream-identity")).toBeUndefined();
		expect(
			store.peekForIdentity("key-peek-sources", "probe-identity", STREAM_QUOTA_SOURCE),
		).toBeUndefined();
		expect(store.peek("key-peek-sources")).toBe(probe);
		expect(store.peek("key-peek-sources", STREAM_QUOTA_SOURCE)).toBe(stream);
		store.forget("key-peek-sources");
		expect(store.peekForIdentity("key-peek-sources", "probe-identity")).toBeUndefined();
		expect(store.peekForIdentity("key-peek-sources", "stream-identity", STREAM_QUOTA_SOURCE)).toBe(
			stream,
		);
	});

	test("probe and stream snapshots coexist under one credential and purge independently", async () => {
		const file = `quota-store-sources-${crypto.randomUUID()}.json`;
		const store = new QuotaStore(createPersistedCredentialCache(file, (raw) => raw as never));
		store.set("key-sources", "probe-identity", snapshot(1, 500));
		store.set(
			"key-sources",
			"stream-identity",
			{ ...snapshot(0, null), detail: { quotaBalance: "12.5" } },
			true,
			STREAM_QUOTA_SOURCE,
		);
		expect(store.get("key-sources", "probe-identity")?.windows[0]?.usedRatio).toBe(1);
		expect(
			store.get("key-sources", "stream-identity", undefined, STREAM_QUOTA_SOURCE)?.detail,
		).toEqual({ quotaBalance: "12.5" });
		store.remove("key-sources", STREAM_QUOTA_SOURCE);
		expect(store.peek("key-sources")?.windows[0]?.usedRatio).toBe(1);
		await store.flush();
		const restarted = new QuotaStore(createPersistedCredentialCache(file, (raw) => raw as never));
		expect(restarted.get("key-sources", "probe-identity")?.windows[0]?.usedRatio).toBe(1);
		expect(
			restarted.get("key-sources", "stream-identity", undefined, STREAM_QUOTA_SOURCE),
		).toBeUndefined();
	});

	test("unpersisted states stay in memory only; unpersist drops the disk copy", async () => {
		const file = `quota-store-test-${crypto.randomUUID()}.json`;
		const store = new QuotaStore(createPersistedCredentialCache(file, (raw) => raw as never));
		store.set("key-3", "id", snapshot(0, null), false);
		await store.flush();
		expect(existsSync(getNarraforkPath(file))).toBe(false);
		store.set("key-3", "id", snapshot(0, null));
		await store.flush();
		store.unpersist("key-3");
		await store.flush();
		const restarted = new QuotaStore(createPersistedCredentialCache(file, (raw) => raw as never));
		expect(restarted.get("key-3", "id")).toBeUndefined();
		// Still visible in this process.
		expect(store.get("key-3", "id")).toBeDefined();
	});

	test("a used-up window with a future reset blocks the key; others do not", () => {
		const reset = Date.now() + 60_000;
		quotaStore.set("pool-used-up", "id", snapshot(1, reset));
		quotaStore.set("pool-fresh", "id", snapshot(0.99, reset));
		quotaStore.set("pool-expired", "id", snapshot(1, Date.now() - 1));
		quotaStore.set("pool-unknown-reset", "id", snapshot(1, null));
		expect(keyQuotaBlockedUntil("pool-used-up")).toBe(reset);
		expect(keyQuotaBlockedUntil("pool-fresh")).toBeUndefined();
		expect(keyQuotaBlockedUntil("pool-expired")).toBeUndefined();
		expect(keyQuotaBlockedUntil("pool-unknown-reset")).toBeUndefined();
		expect(keyQuotaBlockedUntil("pool-never-probed")).toBeUndefined();
	});

	test("imports a legacy cache under the new ids and deletes the old file", async () => {
		const file = `legacy-usage-${crypto.randomUUID()}.json`;
		const legacy = createPersistedCredentialCache(file, (raw) => raw as { value: number });
		legacy.save("provider-id", "identity-old", { value: 7 });
		await legacy.flush();
		const store = new QuotaStore();
		await importLegacyQuotaCache(
			file,
			(raw) => raw as { value: number },
			[
				{ legacyKey: "provider-id", id: "key-id", identity: "identity-old" },
				{ legacyKey: "provider-id", id: "other-key", identity: "identity-new" },
			],
			(value) => ({ ...snapshot(0, null), balances: [{ unit: "USD", remaining: value.value }] }),
			store,
		);
		expect(store.get("key-id", "identity-old")?.balances[0]?.remaining).toBe(7);
		// A different identity never inherits the previous account's numbers.
		expect(store.get("other-key", "identity-new")).toBeUndefined();
		expect(existsSync(getNarraforkPath(file))).toBe(false);
	});

	test("an unreadable legacy file is discarded rather than blocking startup", () => {
		const file = `legacy-broken-${crypto.randomUUID()}.json`;
		importLegacyQuotaCache(
			file,
			(raw) => raw as never,
			[],
			() => null,
			new QuotaStore(),
		);
		expect(existsSync(getNarraforkPath(file))).toBe(false);
	});
});
