import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { getNarraforkPath } from "../narrafork-home";
import { createPersistedCredentialCache } from "../persisted-credential-cache";
import { keyQuotaBlockedUntil } from "../provider-key-quota";
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
