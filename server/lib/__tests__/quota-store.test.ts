import { describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

// Per-field transport semantics live in quota-identity.test.ts. Each source still
// exercises its real serializer, key composition and store namespace here.
for (const { name, identity, source } of quotaSources) {
	test(`${name}: effective credential identity guards its quota snapshot`, () => {
		const store = new QuotaStore();
		const held = snapshot(1, 500);
		const original = identity(quotaConfig);
		store.set(quotaConfig.id, original, held, false, source);
		const changed = withProviderKey(quotaConfig, {
			apiKey: quotaConfig.apiKey,
			network: { extraHeaders: { "X-Account": "other-network" } },
		});
		expect(store.peekForIdentity(quotaConfig.id, identity(changed), source)).toBeUndefined();
		expect(
			store.peekForIdentity(
				quotaConfig.id,
				identity({ ...quotaConfig, apiKey: "rotated" }),
				source,
			),
		).toBeUndefined();
		expect(
			store.peekForIdentity(
				quotaConfig.id,
				identity(
					name === "tokendance"
						? { ...quotaConfig, generation: 2 }
						: { ...quotaConfig, baseUrl: "https://quota.example/another-tenant/v1" },
				),
				source,
			),
		).toBeUndefined();
		expect(store.peekForIdentity(quotaConfig.id, original, source)).toEqual(held);
	});
}

describe("quota store", () => {
	test("restart restores only matching fingerprints, with cold peeks and independent persisted slots", async () => {
		const file = `quota-store-test-${crypto.randomUUID()}.json`;
		const store = new QuotaStore(createPersistedCredentialCache(file, (raw) => raw as never));
		const identity = kimiQuotaIdentity(quotaConfig);
		const held = snapshot(0.4, null);
		const stream = { ...snapshot(0, null), detail: { quotaBalance: "12.5" } };
		// In-progress states never create a file.
		store.set("memory-only", identity, held, false);
		await store.flush();
		expect(existsSync(getNarraforkPath(file))).toBe(false);
		store.set(quotaConfig.id, identity, held);
		store.set(quotaConfig.id, "stream-identity", stream, true, STREAM_QUOTA_SOURCE);
		store.set("purged-stream", identity, held);
		store.set("purged-stream", "stream-identity", stream, true, STREAM_QUOTA_SOURCE);
		store.set("unpersisted", identity, held);
		await store.flush();
		store.remove("purged-stream", STREAM_QUOTA_SOURCE);
		expect(store.peek("purged-stream", STREAM_QUOTA_SOURCE)).toBeUndefined();
		expect(store.peek("purged-stream")).toEqual(held);
		store.unpersist("unpersisted");
		await store.flush();
		expect(store.get("unpersisted", identity)).toEqual(held);
		const raw = readFileSync(getNarraforkPath(file), "utf-8");
		expect(raw).not.toContain(quotaConfig.apiKey);
		expect(raw).not.toContain(quotaConfig.baseUrl);
		const restarted = new QuotaStore(createPersistedCredentialCache(file, (raw) => raw as never));
		expect(restarted.peekForIdentity(quotaConfig.id, identity)).toBeUndefined();
		expect(restarted.peek(quotaConfig.id)).toBeUndefined();
		const changed = withProviderKey(quotaConfig, {
			apiKey: quotaConfig.apiKey,
			network: { proxy: { mode: "custom", url: "http://another-network.example:8080" } },
		});
		expect(restarted.get(quotaConfig.id, kimiQuotaIdentity(changed))).toBeUndefined();
		expect(restarted.get(quotaConfig.id, identity)).toEqual(held);
		expect(restarted.peekForIdentity(quotaConfig.id, identity)).toEqual(held);
		expect(
			restarted.get(quotaConfig.id, "stream-identity", undefined, STREAM_QUOTA_SOURCE),
		).toEqual(stream);
		expect(restarted.get("purged-stream", identity)).toEqual(held);
		expect(
			restarted.get("purged-stream", "stream-identity", undefined, STREAM_QUOTA_SOURCE),
		).toBeUndefined();
		for (const id of ["memory-only", "unpersisted"])
			expect(restarted.get(id, identity)).toBeUndefined();
		expect(
			restarted.get(
				quotaConfig.id,
				kimiQuotaIdentity({ ...quotaConfig, baseUrl: "https://other.example/v1" }),
			),
		).toBeUndefined();
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
		expect(store.peekForIdentity("key-peek", "identity-a")).toEqual(held);
		expect(store.peekForIdentity("key-peek", "identity-b")).toBeUndefined();
		// A mismatched read does not evict the valid identity or alter legacy peek.
		expect(store.peekForIdentity("key-peek", "identity-a")).toEqual(held);
		expect(store.peek("key-peek")).toEqual(held);
		expect(persisted.restore).not.toHaveBeenCalled();
		expect(persisted.save).not.toHaveBeenCalled();
		expect(persisted.remove).not.toHaveBeenCalled();
		expect(persisted.flush).not.toHaveBeenCalled();
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
		expect(store.peekForIdentity("key-peek-sources", "probe-identity")).toEqual(probe);
		expect(
			store.peekForIdentity("key-peek-sources", "stream-identity", STREAM_QUOTA_SOURCE),
		).toEqual(stream);
		expect(store.peekForIdentity("key-peek-sources", "stream-identity")).toBeUndefined();
		expect(
			store.peekForIdentity("key-peek-sources", "probe-identity", STREAM_QUOTA_SOURCE),
		).toBeUndefined();
		expect(store.peek("key-peek-sources")).toEqual(probe);
		expect(store.peek("key-peek-sources", STREAM_QUOTA_SOURCE)).toEqual(stream);
		store.forget("key-peek-sources");
		expect(store.peekForIdentity("key-peek-sources", "probe-identity")).toBeUndefined();
		expect(
			store.peekForIdentity("key-peek-sources", "stream-identity", STREAM_QUOTA_SOURCE),
		).toEqual(stream);
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

	test("a corrupt legacy JSON file is discarded without importing a snapshot", async () => {
		const file = `legacy-broken-${crypto.randomUUID()}.json`;
		const path = getNarraforkPath(file);
		writeFileSync(path, '{"version":1,"entries":');
		expect(existsSync(path)).toBe(true);
		const store = new QuotaStore();
		await importLegacyQuotaCache(
			file,
			(raw) => raw as { value: number },
			[{ legacyKey: "provider-id", id: "key-id", identity: "identity-old" }],
			(value) => ({ ...snapshot(0, null), balances: [{ unit: "USD", remaining: value.value }] }),
			store,
		);
		expect(store.get("key-id", "identity-old")).toBeUndefined();
		expect(existsSync(path)).toBe(false);
	});
});
