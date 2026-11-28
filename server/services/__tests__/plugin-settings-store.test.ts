import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sqlite } from "@server/db";
import { sealSecretRecord, secretRecordKeyId } from "@server/lib/secret-store";
import {
	PLUGIN_SETTINGS_STORE_LIMITS,
	type PluginResourceMutation,
	type PluginSettingMutation,
} from "../plugin-settings-store";
import { selectPluginSettingsStoreBackend } from "../plugin-settings-store-provider";
import { createSqlitePluginSettingsStore } from "../sqlite-plugin-settings-store";

const store = createSqlitePluginSettingsStore(sqlite);
let pluginId: string;
beforeEach(() => {
	pluginId = `com.example.storage-${crypto.randomUUID()}`;
});
afterEach(() => {
	sqlite.run("DROP TRIGGER IF EXISTS fail_plugin_receipt");
	for (const table of [
		"plugin_provider_settings",
		"plugin_resource_entries",
		"plugin_resource_budgets",
	])
		sqlite.run(`DELETE FROM ${table} WHERE plugin_id = ?`, [pluginId]);
});
function setting(target = "provider-1"): PluginSettingMutation {
	const sealed = sealSecretRecord(
		Buffer.from('{"token":"fictional-store-token"}'),
		"fixture-bound-record",
	);
	return {
		address: {
			pluginId,
			contributionId: "preferences",
			targetKind: "custom-api",
			targetId: target,
		},
		expectedRevision: 0,
		value: {
			installationId: "installation-1",
			state: "active",
			schemaVersion: 1,
			schemaFingerprint: "a".repeat(64),
			bindingFingerprint: "b".repeat(64),
			configText: '{"label":"fixture"}',
			secretsEnvelope: sealed,
			keyId: secretRecordKeyId(sealed),
		},
	};
}
function resource(
	key = "cursor",
	ownerKind: PluginResourceMutation["address"]["ownerKind"] = "plugin",
): PluginResourceMutation {
	return {
		address: {
			pluginId,
			ownerKind,
			scopeType: "provider",
			scopeId: '["custom-api","provider-1"]',
			key,
		},
		expectedRevision: 0,
		value: {
			installationId: "installation-1",
			bindingFingerprint: "b".repeat(64),
			state: "active",
			valueText: '{"next":2}',
		},
	};
}
function budget() {
	return sqlite
		.query(
			"SELECT resource_bytes AS bytes,resource_count AS resources,settings_count AS settings FROM plugin_resource_budgets WHERE plugin_id = ?",
		)
		.get(pluginId);
}

describe("atomic plugin settings SQL store", () => {
	test("commits configuration, protected bytes and a host receipt together and lists only metadata", async () => {
		const s = setting(),
			r = resource("migration-v1", "host-migration");
		const result = await store.commit({ setting: s, resource: r });
		expect(result.setting?.revision).toBe(1);
		expect(result.resource?.revision).toBe(1);
		expect(await store.getSetting(s.address)).toEqual(result.setting ?? null);
		expect(await store.getResource(r.address)).toEqual(result.resource ?? null);
		const settings = await store.listSettings(pluginId),
			resources = await store.listResources({ ...r.address });
		expect(settings.items).toHaveLength(1);
		expect(settings.items[0]).not.toHaveProperty("configText");
		expect(settings.items[0]).not.toHaveProperty("secretsEnvelope");
		expect(resources.items[0]).not.toHaveProperty("valueText");
		expect(JSON.stringify(settings)).not.toContain("fictional-store-token");
		expect(budget()).toEqual({
			bytes: Buffer.byteLength(r.value.valueText),
			resources: 1,
			settings: 1,
		});
	});
	test("a receipt failure rolls back the already-written settings row and budget", async () => {
		const s = setting(),
			r = resource("receipt", "host-migration");
		sqlite.run(
			"CREATE TEMP TRIGGER fail_plugin_receipt BEFORE INSERT ON plugin_resource_entries BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
		);
		await expect(store.commit({ setting: s, resource: r })).rejects.toMatchObject({
			code: "PLUGIN_SETTINGS_STORE_UNAVAILABLE",
		});
		expect(await store.getSetting(s.address)).toBeNull();
		expect(await store.getResource(r.address)).toBeNull();
		expect(budget()).toBeNull();
		sqlite.run("DROP TRIGGER fail_plugin_receipt");
		expect((await store.commit({ setting: s, resource: r })).setting?.revision).toBe(1);
	});
	test("stale setting or receipt revisions never leave partial writes or change counts", async () => {
		const s = setting(),
			r = resource("receipt", "host-migration");
		await store.commit({ setting: s, resource: r });
		const before = budget();
		await expect(
			store.commit({
				setting: {
					...s,
					expectedRevision: 1,
					value: { ...s.value, configText: '{"label":"new"}' },
				},
				resource: r,
			}),
		).rejects.toMatchObject({ code: "PLUGIN_SETTINGS_REVISION_CONFLICT" });
		expect((await store.getSetting(s.address))?.configText).toBe(s.value.configText);
		expect(budget()).toEqual(before);
		const results = await Promise.allSettled(
			[0, 1].map((i) =>
				store.commit({
					setting: {
						...s,
						expectedRevision: 1,
						value: { ...s.value, configText: JSON.stringify({ winner: i }) },
					},
				}),
			),
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
		expect((await store.getSetting(s.address))?.revision).toBe(2);
	});
	test("deletion retains a revision tombstone and frees bytes without allowing create-only resurrection", async () => {
		const s = setting(),
			r = resource();
		await store.commit({ setting: s });
		await store.commit({ resource: r });
		const next = await store.commit({
			setting: {
				...s,
				expectedRevision: 1,
				value: { ...s.value, state: "deleted", configText: "", secretsEnvelope: null, keyId: null },
			},
		});
		expect(next.setting).toMatchObject({
			state: "deleted",
			revision: 2,
			secretsEnvelope: null,
			configText: "",
		});
		await store.commit({
			resource: {
				...r,
				expectedRevision: 1,
				value: { ...r.value, state: "deleted", valueText: "" },
			},
		});
		expect(budget()).toEqual({ bytes: 0, resources: 1, settings: 1 });
		await expect(store.commit({ setting: s })).rejects.toMatchObject({
			code: "PLUGIN_SETTINGS_REVISION_CONFLICT",
		});
		await expect(store.commit({ resource: r })).rejects.toMatchObject({
			code: "PLUGIN_SETTINGS_REVISION_CONFLICT",
		});
	});
	test("owner and target namespaces cannot collide even with identical local names", async () => {
		const s = setting();
		await store.commit({ setting: s });
		const otherKind = { ...s, address: { ...s.address, targetKind: "nug" as const } };
		await store.commit({ setting: otherKind });
		expect((await store.listSettings(pluginId)).items).toHaveLength(2);
		for (const kind of ["plugin", "host-projection", "host-migration", "host-operation"] as const)
			await store.commit({ resource: resource("same", kind) });
		expect(budget()).toMatchObject({ resources: 4 });
		await expect(
			store.commit({ setting: setting("provider-2"), resource: resource("arbitrary") }),
		).rejects.toMatchObject({ code: "PLUGIN_SETTINGS_STORE_INVALID" });
		expect(
			(
				await store.listResources({
					pluginId,
					ownerKind: "plugin",
					scopeType: "provider",
					scopeId: '["custom-api","provider-1"]',
				})
			).items,
		).toHaveLength(1);
	});
	test("page cursors have hard limits and never include protected data", async () => {
		for (let i = 0; i < 52; i++) await store.commit({ resource: resource(`k${i}`) });
		const { key: _key, ...scope } = resource().address;
		const a = await store.listResources(scope),
			b = await store.listResources(scope, { cursor: a.nextCursor ?? undefined });
		expect(a.items).toHaveLength(50);
		expect(b.items).toHaveLength(2);
		expect(b.nextCursor).toBeNull();
		expect(new Set([...a.items, ...b.items].map((row) => row.id)).size).toBe(52);
		await expect(store.listSettings(pluginId, { limit: 51 })).rejects.toMatchObject({
			code: "PLUGIN_SETTINGS_STORE_INVALID",
		});
		await expect(store.listResources(scope, { cursor: "injected" })).rejects.toMatchObject({
			code: "PLUGIN_SETTINGS_STORE_INVALID",
		});
	});
	test("entry and incremental plugin budgets reject the entire transaction", async () => {
		const r = resource();
		await expect(
			store.commit({ resource: { ...r, value: { ...r.value, valueText: "配".repeat(30000) } } }),
		).rejects.toMatchObject({ code: "PLUGIN_SETTINGS_STORE_INVALID" });
		await store.commit({ resource: r });
		sqlite.run("UPDATE plugin_resource_budgets SET resource_bytes = ? WHERE plugin_id = ?", [
			PLUGIN_SETTINGS_STORE_LIMITS.pluginBytes,
			pluginId,
		]);
		const s = setting();
		await expect(
			store.commit({ setting: s, resource: resource("next", "host-projection") }),
		).rejects.toMatchObject({ code: "PLUGIN_SETTINGS_QUOTA_EXCEEDED" });
		expect(await store.getSetting(s.address)).toBeNull();
		expect(budget()).toMatchObject({
			bytes: PLUGIN_SETTINGS_STORE_LIMITS.pluginBytes,
			resources: 1,
			settings: 0,
		});
	});
	test("invalid ciphertext metadata and cancelled operations do not write", async () => {
		const s = setting();
		await expect(
			store.commit({ setting: { ...s, value: { ...s.value, keyId: "c".repeat(64) } } }),
		).rejects.toMatchObject({ code: "PLUGIN_SETTINGS_STORE_INVALID" });
		await expect(
			store.commit({ setting: { ...s, value: { ...s.value, secretsEnvelope: "plaintext" } } }),
		).rejects.toMatchObject({ code: "PLUGIN_SETTINGS_STORE_INVALID" });
		const controller = new AbortController();
		controller.abort();
		await expect(store.commit({ setting: s }, { signal: controller.signal })).rejects.toThrow();
		expect(budget()).toBeNull();
	});
	test("PostgreSQL selection cannot use or import a SQLite fallback", () => {
		expect(() =>
			selectPluginSettingsStoreBackend({ readBackend: "postgres", writeBackend: "postgres" }),
		).toThrow();
		expect(() =>
			selectPluginSettingsStoreBackend({ readBackend: "sqlite", writeBackend: "postgres" }, store),
		).toThrow();
		expect(
			selectPluginSettingsStoreBackend(
				{ readBackend: "postgres", writeBackend: "postgres" },
				store,
			),
		).toBe(store);
		expect(
			selectPluginSettingsStoreBackend({ readBackend: "sqlite", writeBackend: "sqlite" }, store),
		).toBe("sqlite");
	});
});
