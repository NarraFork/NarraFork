import { afterEach, expect, test } from "bun:test";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import {
	createProviderQuotaPersistence,
	type PersistedProviderQuota,
	parsePersistedProviderQuota,
} from "../provider-quota-persistence";
import { quotaResult } from "./provider-quota-fixtures";

// tests/preload.ts has already installed and verified a private NARRAFORK_HOME.
const cacheFile = getNarraforkPath("provider-quota-cache.json");
afterEach(async () => {
	await rm(cacheFile, { force: true });
});
function value(): PersistedProviderQuota {
	return {
		sourceId: "third.party/generic",
		sourceRevision: "install-1",
		status: "supported",
		data: quotaResult().data,
		fetchedAt: 1,
		attemptedAt: 1,
	};
}

test("persistence uses keyed identities, validates reloads, and never serializes credentials", async () => {
	const first = createProviderQuotaPersistence();
	first.save("provider-1", "SECRET-API-KEY-and-proxy-password", value());
	await first.flush();
	const raw = await readFile(cacheFile, "utf-8");
	expect(raw).not.toContain("SECRET-API-KEY");
	expect(raw).not.toContain("proxy-password");
	const fresh = createProviderQuotaPersistence();
	expect(fresh.restore("provider-1", "SECRET-API-KEY-and-proxy-password")).toEqual(value());
	expect(fresh.restore("provider-1", "different-credential")).toBeUndefined();
	await fresh.flush();
});

test("write-side LRU budget stays below 1MiB and 256 records, keeping newest rebuildable values", async () => {
	const store = createProviderQuotaPersistence();
	const large = value();
	large.data = {
		amounts: Array.from({ length: 32 }, (_, i) => ({
			id: String(i),
			label: "x".repeat(100),
			unit: "CREDITS",
			remaining: 1,
		})),
		windows: [],
		details: "d".repeat(4_000),
	};
	for (let i = 0; i < 350; i++) store.save(`provider-${i}`, `private-identity-${i}`, large);
	await store.flush();
	expect((await stat(cacheFile)).size).toBeLessThanOrEqual(1024 * 1024);
	const raw = JSON.parse(await readFile(cacheFile, "utf-8"));
	expect(Object.keys(raw.entries).length).toBeLessThanOrEqual(256);
	expect(store.restore("provider-0", "private-identity-0")).toBeUndefined();
	expect(store.restore("provider-349", "private-identity-349")).toEqual(large);
	const restarted = createProviderQuotaPersistence();
	restarted.save("after-restart", "new-identity", large);
	await restarted.flush();
	expect((await stat(cacheFile)).size).toBeLessThanOrEqual(1024 * 1024);
});

test("malformed and oversized values are unknown, not zero or unlimited", async () => {
	for (const malformed of [
		null,
		{},
		{ ...value(), data: null },
		{
			...value(),
			data: { amounts: [{ unit: "USD", remaining: Number.POSITIVE_INFINITY }], windows: [] },
		},
		{ ...value(), data: { amounts: [], windows: [], details: "x".repeat(20_000) } },
	]) {
		expect(parsePersistedProviderQuota(malformed)).toBeNull();
	}
	await writeFile(cacheFile, "{broken json");
	const store = createProviderQuotaPersistence();
	expect(store.restore("provider", "identity")).toBeUndefined();
	store.save("provider", "identity", value());
	await store.flush();
	expect(store.restore("provider", "identity")?.data?.amounts[0]?.remaining).toBe(42);
});

test("malformed prefix rows cannot hide loaded records from the write-side byte budget", async () => {
	const rows: Record<string, unknown> = {};
	for (let i = 0; i < 256; i++) rows[`malformed-${i}`] = { savedAt: i, value: value() };
	const loaded = value();
	loaded.data = { amounts: [], windows: [], details: "x".repeat(3_000) };
	for (let i = 0; i < 200; i++)
		rows[`loaded-${i}`] = { fingerprint: "a".repeat(64), savedAt: i, value: loaded };
	await writeFile(cacheFile, JSON.stringify({ version: 1, salt: "a".repeat(64), entries: rows }));
	expect((await stat(cacheFile)).size).toBeLessThan(1024 * 1024);
	const store = createProviderQuotaPersistence();
	const large = value();
	large.data = {
		amounts: Array.from({ length: 32 }, (_, i) => ({
			id: String(i),
			label: "x".repeat(100),
			unit: "CREDITS",
			remaining: 1,
		})),
		windows: [],
		details: "d".repeat(4_000),
	};
	for (let i = 0; i < 60; i++) store.save(`new-${i}`, `new-identity-${i}`, large);
	await store.flush();
	expect((await stat(cacheFile)).size).toBeLessThanOrEqual(1024 * 1024);
	expect(
		Object.keys(JSON.parse(await readFile(cacheFile, "utf-8")).entries).length,
	).toBeLessThanOrEqual(256);
	expect(store.restore("new-59", "new-identity-59")).toEqual(large);
});
