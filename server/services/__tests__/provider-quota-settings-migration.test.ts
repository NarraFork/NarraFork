import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sqlite } from "@server/db";
import { getProviderKeyStore } from "@server/lib/provider-keys";
import { openSecretRecord, sealSecretRecord } from "@server/lib/secret-store";
import { type CustomApiProviderConfig, saveSettings, settings } from "@server/lib/settings";
import { quotaKeyOwner } from "@server/lib/settings/provider-keys-projection";
import type { PluginSettingsStore, PluginStoreOperation } from "../plugin-settings-store";
import {
	LEGACY_QUOTA_PACKAGE_HASH,
	LEGACY_QUOTA_SETTINGS_DECLARATION,
} from "../provider-quota-settings-compat";
import {
	assertQuotaCompatibilityIdle,
	beginQuotaCompatibilitySave,
	projectQuotaSettingsInto,
	quotaCompatibilityTokenIntents,
	recoverQuotaCompatibilitySave,
} from "../provider-quota-settings-compat-save";
import {
	ensureQuotaSettingsMigration,
	quotaSettingsReceiptAddress,
} from "../provider-quota-settings-migration";
import { forgetQuotaSettingsProjection } from "../provider-quota-settings-projection";
import { ProviderSettingsConfigPolicy } from "../provider-settings-config-policy";
import {
	readProviderSettingsCoreContext,
	settingsConfigContext,
} from "../provider-settings-context";
import { openProviderSetting, ProviderSettingsData } from "../provider-settings-data";
import { createSqlitePluginSettingsStore } from "../sqlite-plugin-settings-store";

const pluginId = "io.narrafork.provider-quota",
	providerId = "migration-fixture",
	installationId = "fixture-installation";
const store = createSqlitePluginSettingsStore(sqlite),
	savedProviders = structuredClone(settings.customApiProviders);
const address = {
	pluginId,
	contributionId: "site-account",
	targetKind: "custom-api" as const,
	targetId: providerId,
};
const migration = {
	pluginId,
	version: "1.0.3",
	hash: LEGACY_QUOTA_PACKAGE_HASH,
	installationId,
	providerId,
	declaration: LEGACY_QUOTA_SETTINGS_DECLARATION,
};
const operationAddress = {
	pluginId,
	ownerKind: "host-operation" as const,
	scopeType: "provider" as const,
	scopeId: JSON.stringify(["custom-api", providerId]),
	key: "quota-settings-compat-save-v1",
};
function configContext(installation = installationId) {
	return settingsConfigContext(
		pluginId,
		installation,
		readProviderSettingsCoreContext("custom-api", providerId),
	);
}
async function saveExtension(
	values = { useSiteAccount: true, siteUrl: "https://site.invalid/team/v1", userId: "alice" },
	token = "extension-token",
	targetStore: PluginSettingsStore = store,
	options?: PluginStoreOperation,
) {
	const context = configContext(),
		view = new ProviderSettingsConfigPolicy(LEGACY_QUOTA_SETTINGS_DECLARATION).view(context),
		row = await store.getSetting(address);
	return new ProviderSettingsData(targetStore).save(
		context,
		LEGACY_QUOTA_SETTINGS_DECLARATION,
		{
			schemaVersion: 1,
			schemaFingerprint: view.schemaFingerprint,
			expectedRevision: row?.revision ?? 0,
			expectedBindingRevision: view.bindingRevision,
			values,
			secrets: { token: { operation: "set", value: token } },
		},
		options,
	);
}
function fixtureSettings() {
	const customApiProviders = settings.customApiProviders;
	if (
		!customApiProviders ||
		customApiProviders.length !== 1 ||
		customApiProviders[0].id !== providerId
	)
		throw new Error("missing migration provider fixture");
	return { ...settings, customApiProviders };
}
async function baseline() {
	const before = structuredClone(fixtureSettings());
	await projectQuotaSettingsInto(before);
	return before;
}
function commitBarrier() {
	let enter!: () => void, release!: () => void;
	const entered = new Promise<void>((resolve) => {
			enter = resolve;
		}),
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
	const delayed: PluginSettingsStore = {
		...store,
		async commit(input, options) {
			if (input.setting) {
				enter();
				await gate;
			}
			return store.commit(input, options);
		},
	};
	return { delayed, entered, release };
}
function provider(): CustomApiProviderConfig {
	return {
		id: providerId,
		name: "Fixture",
		prefix: "migration-fixture",
		apiKey: "fixture-inference",
		baseUrl: "https://site.invalid/team/v1",
		protocol: "completions-compatible",
		defaultModel: "",
		quotaUserId: "alice",
		quotaAccessToken: "fixture-account-token",
	};
}
beforeEach(() => {
	for (const table of [
		"plugin_provider_settings",
		"plugin_resource_entries",
		"plugin_resource_budgets",
	])
		sqlite.run(`DELETE FROM ${table} WHERE plugin_id=?`, [pluginId]);
	forgetQuotaSettingsProjection(providerId);
	const next = structuredClone(settings);
	next.customApiProviders = [provider()];
	saveSettings(next);
});
afterEach(() => {
	sqlite.run("DROP TRIGGER IF EXISTS fail_quota_config");
	sqlite.run("DROP TRIGGER IF EXISTS fail_quota_retirement");
	for (const table of [
		"plugin_provider_settings",
		"plugin_resource_entries",
		"plugin_resource_budgets",
	])
		sqlite.run(`DELETE FROM ${table} WHERE plugin_id=?`, [pluginId]);
	forgetQuotaSettingsProjection(providerId);
	const next = structuredClone(settings);
	next.customApiProviders = savedProviders;
	saveSettings(next);
});

describe("trusted site settings migration", () => {
	test.each([
		false,
		true,
	])("an absent provider collection blocks migration without changing saved data (migrated=%s)", async (migrated) => {
		if (migrated) await ensureQuotaSettingsMigration(migration, store);
		const providers = fixtureSettings().customApiProviders,
			row = await store.getSetting(address),
			receiptAddress = quotaSettingsReceiptAddress(pluginId, providerId),
			receipt = await store.getResource(receiptAddress);
		settings.customApiProviders = undefined;
		try {
			expect(() => readProviderSettingsCoreContext("custom-api", providerId)).toThrow(
				expect.objectContaining({ code: "PROVIDER_SETTINGS_TARGET_UNAVAILABLE" }),
			);
			await expect(ensureQuotaSettingsMigration(migration, store)).rejects.toMatchObject({
				code: "PROVIDER_SETTINGS_MIGRATION_REQUIRED",
			});
			expect(await store.getSetting(address)).toEqual(row);
			expect(await store.getResource(receiptAddress)).toEqual(receipt);
			expect(getProviderKeyStore().firstKey(quotaKeyOwner(providerId))).toBe(
				"fixture-account-token",
			);
		} finally {
			settings.customApiProviders = providers;
		}
	});
	test("a provider collection removed before migration commit leaves settings and receipt unwritten", async () => {
		const providers = fixtureSettings().customApiProviders;
		const interrupted: PluginSettingsStore = {
			...store,
			commit(input, options) {
				settings.customApiProviders = undefined;
				return store.commit(input, options);
			},
		};
		try {
			await expect(ensureQuotaSettingsMigration(migration, interrupted)).rejects.toMatchObject({
				code: "PLUGIN_SETTINGS_STORE_UNAVAILABLE",
			});
			expect(await store.getSetting(address)).toBeNull();
			expect(await store.getResource(quotaSettingsReceiptAddress(pluginId, providerId))).toBeNull();
			expect(getProviderKeyStore().firstKey(quotaKeyOwner(providerId))).toBe(
				"fixture-account-token",
			);
		} finally {
			settings.customApiProviders = providers;
		}
	});
	test("retains token and old fallback tenant root, commits receipt, and does not grant capabilities", async () => {
		const old = fixtureSettings().customApiProviders[0],
			token = getProviderKeyStore().firstKey(quotaKeyOwner(providerId));
		await ensureQuotaSettingsMigration(migration, store);
		const row = await store.getSetting(address);
		if (!row) throw Error("missing migration");
		expect(openProviderSetting(row).config.values).toEqual({
			useSiteAccount: true,
			siteUrl: "https://site.invalid/team",
			userId: "alice",
		});
		expect(openProviderSetting(row).secrets).toEqual({ token: "fixture-account-token" });
		expect(
			await store.getResource(quotaSettingsReceiptAddress(pluginId, providerId)),
		).toMatchObject({ state: "active", revision: 1 });
		expect(fixtureSettings().customApiProviders[0]).toEqual(old);
		expect(getProviderKeyStore().firstKey(quotaKeyOwner(providerId))).toBe(token);
		await ensureQuotaSettingsMigration(migration, store);
		expect(await store.getSetting(address)).toEqual(row);
		expect(
			sqlite
				.query("SELECT 1 FROM integration_authorities WHERE integration_id=? LIMIT 1")
				.get(pluginId),
		).toBeNull();
	});
	test("forged package cannot import old secret; explicit deletion never revives from legacy source", async () => {
		await expect(
			ensureQuotaSettingsMigration({ ...migration, hash: "f".repeat(64) }, store),
		).rejects.toMatchObject({ code: "PROVIDER_SETTINGS_MIGRATION_REQUIRED" });
		expect(await store.getSetting(address)).toBeNull();
		await ensureQuotaSettingsMigration(migration, store);
		const data = new ProviderSettingsData(store),
			ctx = settingsConfigContext(
				pluginId,
				installationId,
				readProviderSettingsCoreContext("custom-api", providerId),
			);
		await data.remove(ctx, LEGACY_QUOTA_SETTINGS_DECLARATION, 1);
		await ensureQuotaSettingsMigration(migration, store);
		expect(await store.getSetting(address)).toMatchObject({
			state: "deleted",
			revision: 2,
			secretsEnvelope: null,
		});
	});
	test("failed SQL migration preserves sources and is retryable", async () => {
		sqlite.run(
			"CREATE TEMP TRIGGER fail_quota_config BEFORE INSERT ON plugin_provider_settings BEGIN SELECT RAISE(ABORT,'fixture');END",
		);
		await expect(ensureQuotaSettingsMigration(migration, store)).rejects.toThrow();
		expect(await store.getSetting(address)).toBeNull();
		expect(await store.getResource(quotaSettingsReceiptAddress(pluginId, providerId))).toBeNull();
		expect(getProviderKeyStore().firstKey(quotaKeyOwner(providerId))).toBe("fixture-account-token");
		sqlite.run("DROP TRIGGER fail_quota_config");
		await ensureQuotaSettingsMigration(migration, store);
		expect((await store.getSetting(address))?.revision).toBe(1);
	});
	test("legacy mixed save journals intent and recovers after files succeed but SQL fails", async () => {
		await ensureQuotaSettingsMigration(migration, store);
		const before = structuredClone(fixtureSettings());
		await projectQuotaSettingsInto(before);
		const next = structuredClone(before);
		next.customApiProviders[0].quotaUserId = "bob";
		next.customApiProviders[0].quotaAccessToken = "fixture-bob-token";
		const finish = await beginQuotaCompatibilitySave(
			before,
			next,
			quotaCompatibilityTokenIntents(next.customApiProviders),
		);
		await expect(recoverQuotaCompatibilitySave(providerId, store)).rejects.toMatchObject({
			code: "PROVIDER_SETTINGS_SAVE_PENDING",
		});
		saveSettings(next);
		sqlite.run(
			"CREATE TEMP TRIGGER fail_quota_config BEFORE UPDATE ON plugin_provider_settings BEGIN SELECT RAISE(ABORT,'fixture');END",
		);
		await expect(finish()).rejects.toThrow();
		finish.abort();
		const preserved = await store.getSetting(address);
		if (!preserved) throw Error("missing preserved settings");
		expect(openProviderSetting(preserved).secrets.token).toBe("fixture-account-token");
		sqlite.run("DROP TRIGGER fail_quota_config");
		await recoverQuotaCompatibilitySave(providerId, store);
		const row = await store.getSetting(address);
		if (!row) throw Error("missing recovered settings");
		expect(openProviderSetting(row).secrets.token).toBe("fixture-bob-token");
		expect(openProviderSetting(row).config.values.userId).toBe("bob");
	});
	test("partial key/file save stays blocked until an admin retry replays the bounded intended fields", async () => {
		await ensureQuotaSettingsMigration(migration, store);
		const before = structuredClone(fixtureSettings());
		await projectQuotaSettingsInto(before);
		const next = structuredClone(before);
		next.customApiProviders[0].quotaUserId = "bob";
		next.customApiProviders[0].quotaAccessToken = "fixture-bob-token";
		const finish = await beginQuotaCompatibilitySave(
			before,
			next,
			quotaCompatibilityTokenIntents(next.customApiProviders),
		);
		const keys = getProviderKeyStore(),
			key = keys.list(quotaKeyOwner(providerId))[0];
		keys.update(key.id, { apiKey: "fixture-bob-token" });
		finish.abort();
		await expect(recoverQuotaCompatibilitySave(providerId, store)).rejects.toMatchObject({
			code: "PROVIDER_SETTINGS_SAVE_PENDING",
		});
		await recoverQuotaCompatibilitySave(providerId, store, true);
		expect(fixtureSettings().customApiProviders[0].quotaUserId).toBe("bob");
		const recovered = await store.getSetting(address);
		if (!recovered) throw Error("missing recovered settings");
		expect(openProviderSetting(recovered).secrets.token).toBe("fixture-bob-token");
	});
});

test("dormant quota settings never create an unrecoverable compatibility journal", async () => {
	await ensureQuotaSettingsMigration(migration, store);
	sqlite.run("UPDATE plugin_provider_settings SET state='dormant' WHERE plugin_id=?", [pluginId]);
	const before = structuredClone(fixtureSettings());
	await projectQuotaSettingsInto(before);
	const coreEdit = structuredClone(before);
	coreEdit.customApiProviders[0].baseUrl = "https://changed.invalid/v1";
	const finish = await beginQuotaCompatibilitySave(before, coreEdit);
	saveSettings(coreEdit);
	await finish();
	await projectQuotaSettingsInto(structuredClone(settings));
	expect(await store.getSetting(address)).toMatchObject({ state: "dormant", revision: 1 });
	expect(getProviderKeyStore().firstKey(quotaKeyOwner(providerId))).toBe("fixture-account-token");
	const siteEdit = structuredClone(coreEdit);
	siteEdit.customApiProviders[0].quotaUserId = "another-account";
	await expect(beginQuotaCompatibilitySave(coreEdit, siteEdit)).rejects.toMatchObject({
		code: "PROVIDER_SETTINGS_REBIND_REQUIRED",
	});
	const rows = sqlite
		.query(
			"SELECT 1 FROM plugin_resource_entries WHERE plugin_id=? AND owner_kind='host-operation' AND state='active'",
		)
		.all(pluginId);
	expect(rows).toHaveLength(0);
});

describe("legacy PATCH intent and concurrent SQL boundaries", () => {
	test("omitted legacy collections are empty snapshots and do not overwrite saved providers", async () => {
		const saved = structuredClone(settings),
			keys = getProviderKeyStore().all(),
			empty = { ...structuredClone(settings), customApiProviders: undefined };
		await projectQuotaSettingsInto(empty);
		expect(empty.customApiProviders).toBeUndefined();
		for (const [before, next] of [
			[empty, empty],
			[empty, saved],
			[saved, empty],
		]) {
			const finish = await beginQuotaCompatibilitySave(before, next);
			try {
				await finish();
			} finally {
				finish.abort();
			}
		}
		expect(settings).toEqual(saved);
		expect(getProviderKeyStore().all()).toEqual(keys);
		expect(await store.getSetting(address)).toBeNull();
		expect(await store.getResource(operationAddress)).toBeNull();
		expect(() => assertQuotaCompatibilityIdle(providerId)).not.toThrow();
	});
	test("a missing provider collection keeps recovery pending and preserves the saved journal", async () => {
		await ensureQuotaSettingsMigration(migration, store);
		const before = await baseline(),
			next = structuredClone(before);
		next.customApiProviders[0].quotaAccessToken = "pending-recovery-token";
		const finish = await beginQuotaCompatibilitySave(
			before,
			next,
			quotaCompatibilityTokenIntents(next.customApiProviders),
		);
		try {
			saveSettings(next);
		} finally {
			finish.abort();
		}
		const providers = fixtureSettings().customApiProviders,
			row = await store.getSetting(address),
			operation = await store.getResource(operationAddress);
		expect(operation).toMatchObject({ state: "active" });
		settings.customApiProviders = undefined;
		try {
			await expect(recoverQuotaCompatibilitySave(providerId, store, true)).rejects.toMatchObject({
				code: "PROVIDER_SETTINGS_SAVE_PENDING",
			});
			expect(await store.getSetting(address)).toEqual(row);
			expect(await store.getResource(operationAddress)).toEqual(operation);
			expect(getProviderKeyStore().firstKey(quotaKeyOwner(providerId))).toBe(
				"pending-recovery-token",
			);
		} finally {
			settings.customApiProviders = providers;
		}
	});
	test("ordinary concurrent projections do not reserve writes when there is no WAL", async () => {
		await ensureQuotaSettingsMigration(migration, store);
		const views = await Promise.all([baseline(), baseline(), baseline()]);
		for (const view of views)
			expect(view.customApiProviders[0].quotaAccessToken).toBe("fixture-account-token");
	});

	test("an explicit token update equal to the old file backup still commits its newer SQL intent", async () => {
		await ensureQuotaSettingsMigration(migration, store);
		await saveExtension({
			useSiteAccount: true,
			siteUrl: "https://site.invalid/team",
			userId: "alice",
		});
		const before = await baseline(),
			next = structuredClone(before);
		// Match every persisted core input, while changing SQL's newer extension token.
		Object.assign(next.customApiProviders[0], fixtureSettings().customApiProviders[0]);
		next.customApiProviders[0].quotaSiteUrl = fixtureSettings().customApiProviders[0].quotaSiteUrl;
		const finish = await beginQuotaCompatibilitySave(
			before,
			next,
			quotaCompatibilityTokenIntents(next.customApiProviders),
		);
		try {
			saveSettings(next);
			await finish();
		} finally {
			finish.abort();
		}
		const row = await store.getSetting(address);
		if (!row) throw Error("missing restored explicit token");
		expect(row.revision).toBe(3);
		expect(openProviderSetting(row).secrets.token).toBe("fixture-account-token");
	});

	test("an admin repair projects the repaired core instead of returning the stale pre-repair clone", async () => {
		await ensureQuotaSettingsMigration(migration, store);
		const before = await baseline(),
			next = structuredClone(before);
		next.customApiProviders[0].protocol = "anthropic-messages";
		next.customApiProviders[0].quotaAccessToken = "partial-core-token";
		const finish = await beginQuotaCompatibilitySave(
			before,
			next,
			quotaCompatibilityTokenIntents(next.customApiProviders),
		);
		const keys = getProviderKeyStore(),
			key = keys.list(quotaKeyOwner(providerId))[0];
		keys.update(key.id, { apiKey: "partial-core-token" });
		finish.abort();
		const current = structuredClone(fixtureSettings());
		await projectQuotaSettingsInto(current, true);
		expect(current.customApiProviders[0].protocol).toBe("anthropic-messages");
		expect(current.customApiProviders[0].quotaAccessToken).toBe("partial-core-token");
		const nextSave = await beginQuotaCompatibilitySave(current, structuredClone(current));
		nextSave.abort();
	});

	test("preserves an exact extension /v1 root and requires explicit token authorization for a core change", async () => {
		await ensureQuotaSettingsMigration(migration, store);
		await saveExtension();
		const before = await baseline(),
			next = structuredClone(before),
			row = await store.getSetting(address),
			saved = structuredClone(settings);
		next.customApiProviders[0].protocol = "anthropic-messages";
		for (const raw of [{ id: providerId }, { id: providerId, quotaAccessToken: "********" }]) {
			await expect(
				beginQuotaCompatibilitySave(before, next, quotaCompatibilityTokenIntents([raw])),
			).rejects.toMatchObject({
				code: "PROVIDER_SETTINGS_SECRET_REBIND_REQUIRED",
			});
			expect(settings).toEqual(saved);
			expect(await store.getSetting(address)).toEqual(row);
			expect(await store.getResource(operationAddress)).toBeNull();
		}
		const finish = await beginQuotaCompatibilitySave(
			before,
			next,
			quotaCompatibilityTokenIntents([{ id: providerId, quotaAccessToken: "extension-token" }]),
		);
		try {
			saveSettings(next);
			await finish();
		} finally {
			finish.abort();
		}
		const updated = await store.getSetting(address);
		if (!updated) throw Error("missing exact root");
		expect(openProviderSetting(updated).config.values.siteUrl).toBe("https://site.invalid/team/v1");
		expect(openProviderSetting(updated).secrets.token).toBe("extension-token");
	});

	test("a copied or masked token never authorizes an address, account or core binding change", async () => {
		await ensureQuotaSettingsMigration(migration, store);
		await saveExtension();
		const before = await baseline(),
			saved = structuredClone(settings),
			row = await store.getSetting(address);
		for (const edit of [
			{ quotaSiteUrl: "https://site.invalid/team" },
			{ quotaUserId: "bob" },
			{ baseUrl: "https://other.invalid/team/v1" },
			{ apiKey: "changed-inference-key" },
			{ proxy: { mode: "direct" as const } },
			{ tlsRejectUnauthorized: false },
			{ codexAccountId: "other-account" },
		]) {
			const next = structuredClone(before);
			Object.assign(next.customApiProviders[0], edit);
			await expect(
				beginQuotaCompatibilitySave(
					before,
					next,
					quotaCompatibilityTokenIntents([{ id: providerId }]),
				),
			).rejects.toMatchObject({
				code: "PROVIDER_SETTINGS_SECRET_REBIND_REQUIRED",
			});
			expect(settings).toEqual(saved);
			expect(await store.getSetting(address)).toEqual(row);
			expect(await store.getResource(operationAddress)).toBeNull();
		}
	});

	test("explicit clear remains clear while authorizing a changed core binding", async () => {
		await ensureQuotaSettingsMigration(migration, store);
		const before = await baseline(),
			next = structuredClone(before);
		next.customApiProviders[0].protocol = "anthropic-messages";
		next.customApiProviders[0].quotaAccessToken = "";
		const finish = await beginQuotaCompatibilitySave(
			before,
			next,
			quotaCompatibilityTokenIntents([{ id: providerId, quotaAccessToken: "" }]),
		);
		try {
			saveSettings(next);
			await finish();
		} finally {
			finish.abort();
		}
		const updated = await store.getSetting(address);
		if (!updated) throw Error("missing cleared setting");
		expect(openProviderSetting(updated).secrets).toEqual({});
		expect(getProviderKeyStore().firstKey(quotaKeyOwner(providerId))).toBeUndefined();
	});

	test("rejects revision 1 projection after revision 2 is saved, before creating WAL or changing files", async () => {
		await ensureQuotaSettingsMigration(migration, store);
		const before = await baseline(),
			next = structuredClone(before);
		next.customApiProviders[0].quotaAccessToken = "old-snapshot-edit";
		await saveExtension(undefined, "new-api-token");
		const row = await store.getSetting(address),
			saved = structuredClone(settings);
		await expect(
			beginQuotaCompatibilitySave(
				before,
				next,
				quotaCompatibilityTokenIntents(next.customApiProviders),
			),
		).rejects.toMatchObject({
			code: "PROVIDER_SETTINGS_REVISION_CONFLICT",
		});
		expect(settings).toEqual(saved);
		expect(await store.getSetting(address)).toEqual(row);
		expect(await store.getResource(operationAddress)).toBeNull();
		// JSON/structured clones cannot forge the host-only original revision.
		await expect(
			beginQuotaCompatibilitySave(
				structuredClone(await baseline()),
				next,
				quotaCompatibilityTokenIntents(next.customApiProviders),
			),
		).rejects.toMatchObject({
			code: "PROVIDER_SETTINGS_REVISION_CONFLICT",
		});
	});

	test("a new API save delayed at real SQL commit cannot cross an active legacy transaction", async () => {
		await ensureQuotaSettingsMigration(migration, store);
		const before = await baseline(),
			next = structuredClone(before),
			barrier = commitBarrier();
		const raced = saveExtension(undefined, "racing-api-token", barrier.delayed, {
			assertCurrent: () => assertQuotaCompatibilityIdle(providerId),
		});
		await barrier.entered;
		next.customApiProviders[0].quotaAccessToken = "legacy-winner-token";
		const finish = await beginQuotaCompatibilitySave(
			before,
			next,
			quotaCompatibilityTokenIntents(next.customApiProviders),
		);
		try {
			barrier.release();
			await expect(raced).rejects.toThrow();
			expect((await store.getSetting(address))?.revision).toBe(1);
			saveSettings(next);
			await finish();
		} finally {
			barrier.release();
			finish.abort();
		}
		const row = await store.getSetting(address);
		if (!row) throw Error("missing winning save");
		expect(openProviderSetting(row).secrets.token).toBe("legacy-winner-token");
	});

	test("recovery holds the reservation through the final SQL commit", async () => {
		await ensureQuotaSettingsMigration(migration, store);
		const before = await baseline(),
			next = structuredClone(before);
		next.customApiProviders[0].quotaAccessToken = "recovering-token";
		const finish = await beginQuotaCompatibilitySave(
			before,
			next,
			quotaCompatibilityTokenIntents(next.customApiProviders),
		);
		saveSettings(next);
		finish.abort();
		const barrier = commitBarrier(),
			recovery = recoverQuotaCompatibilitySave(providerId, barrier.delayed);
		await barrier.entered;
		try {
			finish.abort(); // A stale cleanup callback cannot release recovery's newer reservation.
			await expect(
				saveExtension(undefined, "racing-token", store, {
					assertCurrent: () => assertQuotaCompatibilityIdle(providerId),
				}),
			).rejects.toThrow();
			expect(() => assertQuotaCompatibilityIdle(providerId)).toThrow();
		} finally {
			barrier.release();
			await recovery;
		}
		expect(() => assertQuotaCompatibilityIdle(providerId)).not.toThrow();
		const row = await store.getSetting(address);
		if (!row) throw Error("missing recovered save");
		expect(openProviderSetting(row).secrets.token).toBe("recovering-token");
	});

	test("superseded WAL preserves newer SQL and archives earlier saved credentials across retirement failure", async () => {
		await ensureQuotaSettingsMigration(migration, store);
		const before = await baseline(),
			next = structuredClone(before);
		next.customApiProviders[0].quotaUserId = "bob";
		next.customApiProviders[0].quotaAccessToken = "earlier-saved-token";
		const finish = await beginQuotaCompatibilitySave(
			before,
			next,
			quotaCompatibilityTokenIntents(next.customApiProviders),
		);
		saveSettings(next);
		sqlite.run(
			"CREATE TEMP TRIGGER fail_quota_config BEFORE UPDATE ON plugin_provider_settings BEGIN SELECT RAISE(ABORT,'fixture');END",
		);
		await expect(finish()).rejects.toThrow();
		finish.abort();
		sqlite.run("DROP TRIGGER fail_quota_config");
		await saveExtension(
			{ useSiteAccount: true, siteUrl: "https://new.invalid/tenant/v1", userId: "charlie" },
			"newer-token",
		);
		const newer = await store.getSetting(address);
		sqlite.run(
			"CREATE TEMP TRIGGER fail_quota_retirement BEFORE UPDATE ON plugin_resource_entries WHEN NEW.key='quota-settings-compat-save-v1' AND NEW.state='deleted' BEGIN SELECT RAISE(ABORT,'fixture');END",
		);
		await expect(recoverQuotaCompatibilitySave(providerId, store, true)).rejects.toThrow();
		expect(await store.getSetting(address)).toEqual(newer);
		sqlite.run("DROP TRIGGER fail_quota_retirement");
		await recoverQuotaCompatibilitySave(providerId, store, true);
		expect(await store.getSetting(address)).toEqual(newer);
		expect(await store.getResource(operationAddress)).toMatchObject({ state: "deleted" });
		expect(getProviderKeyStore().firstKey(quotaKeyOwner(providerId))).toBe("earlier-saved-token");
		const archiveAddress = { ...operationAddress, key: `${operationAddress.key}-retained-1` },
			archive = await store.getResource(archiveAddress);
		if (!archive) throw Error("missing retained evidence");
		const plain = openSecretRecord(archive.valueText, JSON.stringify(archiveAddress));
		try {
			expect(JSON.parse(plain.toString("utf8"))).toMatchObject({
				terminalReason: "superseded",
				next: { quotaAccessToken: "earlier-saved-token" },
			});
		} finally {
			plain.fill(0);
		}
		const projected = await baseline();
		expect(projected.customApiProviders[0].quotaAccessToken).toBe("newer-token");
		// A subsequent compatibility save must not overwrite the only retained earlier credential.
		const later = structuredClone(projected);
		later.customApiProviders[0].quotaAccessToken = "later-token";
		const laterFinish = await beginQuotaCompatibilitySave(
			projected,
			later,
			quotaCompatibilityTokenIntents(later.customApiProviders),
		);
		try {
			saveSettings(later);
			await laterFinish();
		} finally {
			laterFinish.abort();
		}
		expect(await store.getResource(archiveAddress)).toEqual(archive);
	});

	test("a pre-upgrade WAL with unknown token intent is archived rather than inventing an explicit set", async () => {
		await ensureQuotaSettingsMigration(migration, store);
		const before = await baseline(),
			next = structuredClone(before);
		next.customApiProviders[0].quotaUserId = "bob";
		next.customApiProviders[0].quotaAccessToken = "pre-upgrade-saved-token";
		const finish = await beginQuotaCompatibilitySave(
			before,
			next,
			quotaCompatibilityTokenIntents(next.customApiProviders),
		);
		saveSettings(next);
		finish.abort();
		const operation = await store.getResource(operationAddress),
			row = await store.getSetting(address);
		if (!operation) throw Error("missing WAL");
		const plain = openSecretRecord(operation.valueText, JSON.stringify(operationAddress));
		let legacy: string;
		try {
			const journal = JSON.parse(plain.toString("utf8"));
			journal.version = 1;
			delete journal.tokenIntent;
			const payload = Buffer.from(JSON.stringify(journal));
			try {
				legacy = sealSecretRecord(payload, JSON.stringify(operationAddress));
			} finally {
				payload.fill(0);
			}
		} finally {
			plain.fill(0);
		}
		await store.commit({
			resource: {
				address: operationAddress,
				expectedRevision: operation.revision,
				value: {
					installationId,
					bindingFingerprint: operation.bindingFingerprint,
					state: "active",
					valueText: legacy,
				},
			},
		});
		await recoverQuotaCompatibilitySave(providerId, store, true);
		expect(await store.getSetting(address)).toEqual(row);
		expect(getProviderKeyStore().firstKey(quotaKeyOwner(providerId))).toBe(
			"pre-upgrade-saved-token",
		);
		const archiveAddress = { ...operationAddress, key: `${operationAddress.key}-retained-2` },
			archive = await store.getResource(archiveAddress);
		if (!archive) throw Error("missing legacy evidence");
		const retained = openSecretRecord(archive.valueText, JSON.stringify(archiveAddress));
		try {
			expect(JSON.parse(retained.toString("utf8"))).toMatchObject({
				terminalReason: "legacy-intent-unknown",
				next: { quotaAccessToken: "pre-upgrade-saved-token" },
			});
		} finally {
			retained.fill(0);
		}
		await baseline();
	});

	test("a dormant old-installation WAL is retained without replaying partial core files or blocking reads", async () => {
		await ensureQuotaSettingsMigration(migration, store);
		const before = await baseline(),
			next = structuredClone(before);
		next.customApiProviders[0].quotaUserId = "bob";
		next.customApiProviders[0].quotaAccessToken = "partial-token";
		const finish = await beginQuotaCompatibilitySave(
			before,
			next,
			quotaCompatibilityTokenIntents(next.customApiProviders),
		);
		const keys = getProviderKeyStore(),
			key = keys.list(quotaKeyOwner(providerId))[0];
		keys.update(key.id, { apiKey: "partial-token" });
		finish.abort();
		sqlite.run("UPDATE plugin_provider_settings SET state='dormant' WHERE plugin_id=?", [pluginId]);
		const dormant = await store.getSetting(address);
		await recoverQuotaCompatibilitySave(providerId, store, true);
		expect(await store.getSetting(address)).toEqual(dormant);
		expect(fixtureSettings().customApiProviders[0].quotaUserId).toBe("alice");
		expect(keys.firstKey(quotaKeyOwner(providerId))).toBe("partial-token");
		expect(await store.getResource(operationAddress)).toMatchObject({ state: "deleted" });
		await baseline();
		const context = configContext("replacement-installation"),
			view = new ProviderSettingsConfigPolicy(LEGACY_QUOTA_SETTINGS_DECLARATION).view(context);
		await new ProviderSettingsData(store).rebind(context, LEGACY_QUOTA_SETTINGS_DECLARATION, {
			expectedRevision: 1,
			schemaFingerprint: view.schemaFingerprint,
			expectedBindingRevision: view.bindingRevision,
		});
		const projected = await baseline();
		expect(projected.customApiProviders[0].quotaAccessToken).toBe("fixture-account-token");
		expect(await store.getSetting(address)).toMatchObject({
			revision: 2,
			installationId: "replacement-installation",
		});
	});
});
