import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqlite } from "@server/db";
import { resetSecretStoreForTests } from "@server/lib/secret-store";
import type { ProviderSettingsConfigContext } from "../provider-settings-config-policy";
import { ProviderSettingsData } from "../provider-settings-data";
import { createSqlitePluginSettingsStore } from "../sqlite-plugin-settings-store";

const originalHome = process.env.NARRAFORK_HOME;
let home: string, context: ProviderSettingsConfigContext;
const store = createSqlitePluginSettingsStore(sqlite);
const declaration = {
	id: "options",
	title: "Options",
	schemaVersion: 1,
	targetKinds: ["custom-api"],
	configSchema: {
		type: "object",
		additionalProperties: false,
		properties: { label: { type: "string" }, token: { type: "string", writeOnly: true } },
	},
};
const service = new ProviderSettingsData(store);
function address() {
	return {
		pluginId: context.pluginId,
		contributionId: "options",
		targetKind: "custom-api" as const,
		targetId: "provider-1",
	};
}
async function request(
	values: Record<string, string> = { label: "fixture" },
	secrets: Record<string, unknown> = {},
) {
	const view = await service.read(context, declaration);
	return {
		schemaVersion: 1,
		schemaFingerprint: view.schemaFingerprint,
		expectedRevision: view.revision,
		expectedBindingRevision: view.bindingRevision,
		values,
		secrets,
	};
}
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "nf-settings-data-test-"));
	process.env.NARRAFORK_HOME = home;
	resetSecretStoreForTests();
	context = {
		pluginId: `com.example.data-${crypto.randomUUID()}`,
		installationId: "installation-1",
		target: { kind: "custom-api", id: "provider-1" },
		identityRevision: "binding-1",
	};
});
afterEach(() => {
	sqlite.run("DROP TRIGGER IF EXISTS fail_settings_save");
	for (const table of [
		"plugin_provider_settings",
		"plugin_resource_entries",
		"plugin_resource_budgets",
	])
		sqlite.run(`DELETE FROM ${table} WHERE plugin_id = ?`, [context.pluginId]);
	process.env.NARRAFORK_HOME = originalHome;
	resetSecretStoreForTests();
	rmSync(home, { recursive: true, force: true });
});

describe("encrypted provider settings data", () => {
	test("stores no plaintext secret, survives service reload and reencrypts retained secrets with the new revision", async () => {
		const first = await service.save(
			context,
			declaration,
			await request(
				{ label: "one" },
				{ token: { operation: "set", value: "fictional-stored-token" } },
			),
		);
		expect(first.secrets).toEqual({ token: { isSet: true } });
		const stored = await store.getSetting(address());
		expect(JSON.stringify(stored)).not.toContain("fictional-stored-token");
		const reload = new ProviderSettingsData(createSqlitePluginSettingsStore(sqlite));
		expect(await reload.read(context, declaration)).toEqual(first);
		expect(await reload.readPublic(context, declaration)).toEqual({
			revision: 1,
			values: { label: "one" },
		});
		const second = await reload.save(context, declaration, await request({ label: "two" }));
		expect(second.revision).toBe(2);
		expect(second.secrets.token.isSet).toBe(true);
		expect((await store.getSetting(address()))?.secretsEnvelope).not.toBe(stored?.secretsEnvelope);
	});
	test("unknown local keys block reads and replacement writes while retaining original bytes", async () => {
		await service.save(
			context,
			declaration,
			await request(
				{ label: "one" },
				{ token: { operation: "set", value: "fictional-stored-token" } },
			),
		);
		const next = await request(
				{ label: "replacement" },
				{ token: { operation: "set", value: "replacement-token" } },
			),
			before = await store.getSetting(address()),
			key = readFileSync(join(home, "secret.key"));
		rmSync(join(home, "secret.key"));
		await expect(service.read(context, declaration)).rejects.toMatchObject({
			code: "SECRET_RECORD_KEY_UNAVAILABLE",
		});
		await expect(service.save(context, declaration, next)).rejects.toMatchObject({
			code: "SECRET_RECORD_KEY_UNAVAILABLE",
		});
		expect(await store.getSetting(address())).toEqual(before);
		writeFileSync(join(home, "secret.key"), key);
		expect((await service.read(context, declaration)).secrets.token.isSet).toBe(true);
	});
	test("config tampering and moving an envelope across targets fail authentication", async () => {
		await service.save(
			context,
			declaration,
			await request(
				{ label: "original" },
				{ token: { operation: "set", value: "fictional-stored-token" } },
			),
		);
		const row = await store.getSetting(address());
		if (!row) throw Error("missing fixture");
		sqlite.run("UPDATE plugin_provider_settings SET config_text = ? WHERE id = ?", [
			row.configText.replace("original", "modified"),
			row.id,
		]);
		await expect(service.read(context, declaration)).rejects.toMatchObject({
			code: "SECRET_RECORD_AUTH_FAILED",
		});
		sqlite.run("UPDATE plugin_provider_settings SET config_text = ? WHERE id = ?", [
			row.configText,
			row.id,
		]);
		const other = { ...context, target: { kind: "custom-api" as const, id: "provider-2" } };
		const view = await service.read(other, declaration);
		await service.save(other, declaration, {
			schemaVersion: 1,
			schemaFingerprint: view.schemaFingerprint,
			expectedRevision: 0,
			expectedBindingRevision: view.bindingRevision,
			values: { label: "other" },
			secrets: { token: { operation: "set", value: "other-token" } },
		});
		sqlite.run(
			"UPDATE plugin_provider_settings SET secrets_envelope = ?, key_id = ? WHERE plugin_id = ? AND target_id = ?",
			[row.secretsEnvelope, row.keyId, context.pluginId, "provider-2"],
		);
		await expect(service.read(other, declaration)).rejects.toMatchObject({
			code: "SECRET_RECORD_AUTH_FAILED",
		});
	});
	test("database failure preserves prior config, ciphertext and revision", async () => {
		await service.save(
			context,
			declaration,
			await request(
				{ label: "original" },
				{ token: { operation: "set", value: "fictional-stored-token" } },
			),
		);
		const before = await store.getSetting(address()),
			next = await request({ label: "changed" }, { token: { operation: "clear" } });
		sqlite.run(
			"CREATE TEMP TRIGGER fail_settings_save BEFORE UPDATE ON plugin_provider_settings BEGIN SELECT RAISE(ABORT, 'fixture'); END",
		);
		await expect(service.save(context, declaration, next)).rejects.toMatchObject({
			code: "PLUGIN_SETTINGS_STORE_UNAVAILABLE",
		});
		expect(await store.getSetting(address())).toEqual(before);
	});
	test("retained values require explicit current-binding consent and rebind never grants permissions", async () => {
		await service.save(
			context,
			declaration,
			await request(
				{ label: "retained" },
				{ token: { operation: "set", value: "fictional-stored-token" } },
			),
		);
		const before = await store.getSetting(address()),
			nextContext = { ...context, installationId: "new-installation" };
		const view = await service.read(nextContext, declaration);
		expect(view).toMatchObject({
			status: "dormant",
			values: { label: "retained" },
			secrets: { token: { isSet: true } },
		});
		const confirmation = {
			expectedRevision: view.revision,
			schemaFingerprint: view.schemaFingerprint,
			expectedBindingRevision: view.bindingRevision,
		};
		await expect(
			service.rebind(nextContext, declaration, {
				...confirmation,
				expectedBindingRevision: "c".repeat(64),
			}),
		).rejects.toMatchObject({ code: "PROVIDER_SETTINGS_BINDING_CHANGED" });
		expect(await store.getSetting(address())).toEqual(before);
		const rebound = await service.rebind(nextContext, declaration, confirmation);
		expect(rebound).toMatchObject({
			revision: 2,
			status: "ready",
			values: { label: "retained" },
			secrets: { token: { isSet: true } },
		});
		expect(await service.readPublic(nextContext, declaration)).toEqual({
			revision: 2,
			values: { label: "retained" },
		});
		await expect(
			service.rebind(nextContext, declaration, { ...confirmation, expectedRevision: 2 }),
		).rejects.toMatchObject({ code: "PROVIDER_SETTINGS_DATA_UNAVAILABLE" });
		expect(
			sqlite
				.query("SELECT 1 FROM integration_authorities WHERE integration_id=? LIMIT 1")
				.get(context.pluginId),
		).toBeNull();
	});

	test("delete remains a tombstone; explicit recreation does not recover an old secret", async () => {
		await service.save(
			context,
			declaration,
			await request(
				{ label: "original" },
				{ token: { operation: "set", value: "fictional-stored-token" } },
			),
		);
		const stale = await request({ label: "stale" });
		await service.remove(context, declaration, 1);
		expect(await store.getSetting(address())).toMatchObject({
			state: "deleted",
			revision: 2,
			configText: "",
			secretsEnvelope: null,
		});
		await expect(service.save(context, declaration, stale)).rejects.toMatchObject({
			code: "PROVIDER_SETTINGS_REVISION_CONFLICT",
		});
		const recreated = await service.save(context, declaration, await request({ label: "fresh" }));
		expect(recreated).toMatchObject({
			revision: 3,
			values: { label: "fresh" },
			secrets: { token: { isSet: false } },
		});
	});
});

test("a new installation can explicitly recreate a tombstone with no inherited secret", async () => {
	await service.save(
		context,
		declaration,
		await request({ label: "old" }, { token: { operation: "set", value: "fictional-old-token" } }),
	);
	await service.remove(context, declaration, 1);
	context = { ...context, installationId: "after-reinstall" };
	const view = await service.save(context, declaration, await request({ label: "new" }));
	expect(view).toMatchObject({
		revision: 3,
		values: { label: "new" },
		secrets: { token: { isSet: false } },
	});
	expect(await store.getSetting(address())).toMatchObject({
		installationId: "after-reinstall",
		secretsEnvelope: null,
	});
});

test("explicit target move authenticates both revisions and atomically retires the old address", async () => {
	await service.save(
		context,
		declaration,
		await request(
			{ label: "kept" },
			{ token: { operation: "set", value: "fictional-moved-token" } },
		),
	);
	const source = await store.getSetting(address());
	const target = {
		...context,
		target: { kind: "custom-api" as const, id: "provider-2" },
		identityRevision: "binding-2",
	};
	const targetAddress = { ...address(), targetId: "provider-2" };
	const view = await service.read(target, declaration);
	const confirmation = {
		expectedRevision: view.revision,
		schemaFingerprint: view.schemaFingerprint,
		expectedBindingRevision: view.bindingRevision,
		source: { targetId: "provider-1", expectedRevision: 1 },
	};
	await expect(
		service.rebind(target, declaration, {
			...confirmation,
			source: { ...confirmation.source, expectedRevision: 2 },
		}),
	).rejects.toMatchObject({ code: "PROVIDER_SETTINGS_REVISION_CONFLICT" });
	sqlite.run(
		"CREATE TEMP TRIGGER fail_settings_save BEFORE UPDATE ON plugin_provider_settings WHEN NEW.state='deleted' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
	);
	await expect(service.rebind(target, declaration, confirmation)).rejects.toMatchObject({
		code: "PLUGIN_SETTINGS_STORE_UNAVAILABLE",
	});
	expect(await store.getSetting(targetAddress)).toBeNull();
	expect(await store.getSetting(address())).toEqual(source);
	sqlite.run("DROP TRIGGER fail_settings_save");
	const moved = await service.rebind(target, declaration, confirmation);
	expect(moved).toMatchObject({
		revision: 1,
		values: { label: "kept" },
		secrets: { token: { isSet: true } },
	});
	expect((await service.readBound(target, declaration)).secrets.token).toBe(
		"fictional-moved-token",
	);
	expect((await store.getSetting(targetAddress))?.secretsEnvelope).not.toBe(
		source?.secretsEnvelope,
	);
	expect(await store.getSetting(address())).toMatchObject({
		state: "deleted",
		revision: 2,
		secretsEnvelope: null,
	});
	await expect(service.rebind(target, declaration, confirmation)).rejects.toThrow();
	expect(
		sqlite
			.query("SELECT settings_count AS count FROM plugin_resource_budgets WHERE plugin_id=?")
			.get(context.pluginId),
	).toEqual({ count: 2 });
});
