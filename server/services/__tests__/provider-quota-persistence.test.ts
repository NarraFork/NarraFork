import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { sqlite } from "@server/db";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import {
	createProviderQuotaPersistence,
	type PersistedProviderQuota,
	type ProviderQuotaPersistenceContext,
	parsePersistedProviderQuota,
} from "../provider-quota-persistence";
import { createSqlitePluginSettingsStore } from "../sqlite-plugin-settings-store";
import { quotaResult } from "./provider-quota-fixtures";

const cacheFile = getNarraforkPath("provider-quota-cache.json"),
	pluginId = "third.party.quota",
	sqlStore = createSqlitePluginSettingsStore(sqlite);
const context: ProviderQuotaPersistenceContext = {
	pluginId,
	installationId: "installation-1",
	sourceId: `${pluginId}/generic`,
	sourceRevision: "revision-1",
	providerId: "provider-1",
};
function value(): PersistedProviderQuota {
	return {
		sourceId: context.sourceId,
		sourceRevision: context.sourceRevision,
		status: "supported",
		data: quotaResult().data,
		cursor: "protocol-cursor",
		fetchedAt: 1,
		attemptedAt: 1,
	};
}
const factory = () => createProviderQuotaPersistence({ store: async () => sqlStore });
afterEach(async () => {
	await rm(cacheFile, { force: true });
	for (const table of ["plugin_resource_entries", "plugin_resource_budgets"])
		sqlite.run(`DELETE FROM ${table} WHERE plugin_id=?`, [pluginId]);
});
test("persists host projection and plugin cursor separately, bound to source/installation/credential", async () => {
	const first = factory(),
		identity = "SECRET-API-KEY-and-proxy-password";
	first.save("provider-1", identity, value(), context);
	await first.flush();
	const rows = sqlite
		.query(
			"SELECT owner_kind,value_text FROM plugin_resource_entries WHERE plugin_id=? ORDER BY owner_kind",
		)
		.all(pluginId) as { owner_kind: string; value_text: string }[];
	expect(rows).toHaveLength(2);
	expect(JSON.stringify(rows)).not.toContain(identity);
	expect(rows.find((r) => r.owner_kind === "host-projection")?.value_text).not.toContain(
		"protocol-cursor",
	);
	expect(rows.find((r) => r.owner_kind === "plugin")?.value_text).toContain("protocol-cursor");
	const fresh = factory();
	expect(await fresh.load("provider-1", identity, context)).toEqual(value());
	expect(await fresh.load("provider-1", "other", context)).toBeUndefined();
	expect(
		await factory().load("provider-1", identity, { ...context, installationId: "other" }),
	).toBeUndefined();
	await expect(readFile(cacheFile)).rejects.toThrow();
});
test("legacy keyed cache is read-only, promoted only for a matching source and never after tombstone", async () => {
	const identity = "fixture-key",
		salt = "a".repeat(64),
		legacy = JSON.stringify({
			version: 1,
			salt,
			entries: {
				"provider-1": {
					fingerprint: createHmac("sha256", salt).update(identity).digest("hex"),
					savedAt: 1,
					value: value(),
				},
			},
		});
	await writeFile(cacheFile, legacy);
	const store = factory();
	expect(await store.load("provider-1", identity, context)).toEqual(value());
	await store.flush();
	expect(await readFile(cacheFile, "utf8")).toBe(legacy);
	store.remove("provider-1");
	await store.flush();
	expect(await factory().load("provider-1", identity, context)).toBeUndefined();
	expect(await readFile(cacheFile, "utf8")).toBe(legacy);
});
test("late load cannot overwrite new values or resurrect a removed subject", async () => {
	let release!: (value: unknown) => void;
	const delayed = new Promise<unknown>((resolve) => {
		release = resolve;
	});
	const store = createProviderQuotaPersistence({
		store: async () => sqlStore,
		legacyRead: async () => delayed,
	});
	const loading = store.load("provider-1", "fixture", context);
	store.remove("provider-1");
	release(value());
	expect(await loading).toBeUndefined();
	expect(store.restore("provider-1", "fixture")).toBeUndefined();
	await store.flush();
	let legacyReads = 0;
	const restarted = createProviderQuotaPersistence({
		store: async () => sqlStore,
		legacyRead: async () => {
			legacyReads++;
			return value();
		},
	});
	expect(await restarted.load("provider-1", "fixture", context)).toBeUndefined();
	expect(legacyReads).toBe(0);
});
test("memory and queue limits stay bounded and newest values remain restorable", async () => {
	const store = factory();
	for (let i = 0; i < 300; i++)
		store.save(`p-${i}`, `fixture-${i}`, value(), { ...context, providerId: `p-${i}` });
	await store.flush();
	expect(store.restore("p-0", "fixture-0")).toBeUndefined();
	expect(store.restore("p-299", "fixture-299")).toEqual(value());
	const total = sqlite
		.query(
			"SELECT resource_bytes AS bytes,resource_count AS count FROM plugin_resource_budgets WHERE plugin_id=?",
		)
		.get(pluginId) as { bytes: number; count: number };
	expect(total.bytes).toBeLessThan(8 * 1024 * 1024);
	expect(total.count).toBeLessThanOrEqual(514);
});
test("malformed or unsupported snapshots remain unknown", async () => {
	for (const raw of [
		null,
		{},
		{ ...value(), data: null },
		{ ...value(), data: { amounts: [], windows: [], details: "x".repeat(20000) } },
	])
		expect(parsePersistedProviderQuota(raw)).toBeNull();
	await writeFile(cacheFile, "broken");
	expect(await factory().load("provider-1", "fixture", context)).toBeUndefined();
	expect(await readFile(cacheFile, "utf8")).toBe("broken");
});

test("flush waits for an admitted restore and its resource promotion", async () => {
	let release!: (value: unknown) => void;
	const delayed = new Promise<unknown>((resolve) => {
		release = resolve;
	});
	const store = createProviderQuotaPersistence({
		store: async () => sqlStore,
		legacyRead: async () => delayed,
	});
	const loading = store.load("provider-1", "fixture", context);
	let flushed = false;
	const flush = store.flush().then(() => {
		flushed = true;
	});
	await Promise.resolve();
	expect(flushed).toBe(false);
	release(value());
	await loading;
	await flush;
	expect(flushed).toBe(true);
	expect(await factory().load("provider-1", "fixture", context)).toEqual(value());
});
