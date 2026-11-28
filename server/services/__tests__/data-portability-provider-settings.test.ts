import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSettingsTargetKind } from "../../../shared/provider-settings";

const previousHome = process.env.NARRAFORK_HOME;
const home = mkdtempSync(join(tmpdir(), "nf-portability-settings-"));
process.env.NARRAFORK_HOME = home;
const { sqlite } = await import("../../db");
const { settings, saveSettings } = await import("../../lib/settings");
const { getProviderKeyStore } = await import("../../lib/provider-keys");
const { resetSecretStoreForTests } = await import("../../lib/secret-store");
const { ProviderSettingsData, openProviderSetting } = await import("../provider-settings-data");
const { createSqlitePluginSettingsStore } = await import("../sqlite-plugin-settings-store");
const { exportData, previewImport, getPreview, applyImport, clearData } = await import(
	"../data-portability"
);
const store = createSqlitePluginSettingsStore(sqlite),
	data = new ProviderSettingsData(store);
const pluginId = "com.example.portable",
	passphrase = "fixture transfer passphrase";
const selection = { requests: false, sessions: false, providers: true };
const declaration = {
	id: "options",
	title: "Options",
	schemaVersion: 1,
	targetKinds: ["custom-api", "nug", "platform", "executable-plugin"],
	configSchema: {
		type: "object",
		additionalProperties: false,
		properties: { label: { type: "string" }, token: { type: "string", writeOnly: true } },
	},
};
const context = (id: string, kind: ProviderSettingsTargetKind = "custom-api") => ({
	pluginId,
	installationId: "source-installation",
	target: { kind, id },
	identityRevision: "source-identity",
});
const address = (id: string, kind: ProviderSettingsTargetKind = "custom-api") => ({
	pluginId,
	contributionId: "options",
	targetKind: kind,
	targetId: id,
});
function provider(id: string, prefix: string, key: string, base = "https://source.invalid/v1") {
	return {
		id,
		name: prefix,
		prefix,
		protocol: "completions-compatible" as const,
		apiKey: key,
		baseUrl: base,
		defaultModel: "",
	};
}
function setProviders(providers: ReturnType<typeof provider>[]) {
	for (const key of getProviderKeyStore().all())
		getProviderKeyStore().removeProvider(key.providerId);
	const next = structuredClone(settings);
	next.customApiProviders = providers;
	next.nugProviders = [];
	next.commandCode = undefined;
	next.tokendance = undefined;
	next.codex = undefined;
	saveSettings(next);
}
function resetRows() {
	for (const table of [
		"plugin_provider_settings",
		"plugin_resource_entries",
		"plugin_resource_budgets",
	])
		sqlite.run(`DELETE FROM ${table}`);
}
async function save(
	id: string,
	label: string,
	token: string,
	kind: ProviderSettingsTargetKind = "custom-api",
) {
	const ctx = context(id, kind),
		view = await data.read(ctx, declaration);
	return data.save(ctx, declaration, {
		schemaVersion: 1,
		schemaFingerprint: view.schemaFingerprint,
		expectedRevision: view.revision,
		expectedBindingRevision: view.bindingRevision,
		values: { label },
		secrets: { token: { operation: "set", value: token } },
	});
}
function bytes(buffer: Buffer): ArrayBuffer {
	return buffer.buffer.slice(
		buffer.byteOffset,
		buffer.byteOffset + buffer.byteLength,
	) as ArrayBuffer;
}
async function source() {
	setProviders([provider("source-id", "source", "fixture-inference-key")]);
	await save("source-id", "source label", "fixture-extension-token");
	return readFile((await exportData(selection, { passphrase })).zipPath);
}
beforeEach(() => {
	resetRows();
	setProviders([]);
});
afterAll(() => {
	process.env.NARRAFORK_HOME = previousHome;
	resetSecretStoreForTests();
	try {
		rmSync(home, { recursive: true, force: true });
	} catch {
		/* Test DB is still open on Windows. */
	}
});

describe("provider extensions in portable archives", () => {
	test("v3 snapshot contains no host ciphertext or key identity, and secrets require the sealed companion", async () => {
		const zip = await source(),
			preview = await previewImport(bytes(zip), "source.zip"),
			privatePreview = getPreview(preview.token);
		expect(preview.version).toBe(3);
		expect(preview.providerSettingsCount).toBe(1);
		const snapshot = new Database(privatePreview.snapshotPath, { readonly: true });
		try {
			const row = snapshot
				.query("SELECT secrets_envelope,key_id,config_text FROM plugin_provider_settings")
				.get() as { secrets_envelope: null; key_id: null; config_text: string };
			expect(row.secrets_envelope).toBeNull();
			expect(row.key_id).toBeNull();
			expect(row.config_text).not.toContain("fixture-extension-token");
		} finally {
			snapshot.close();
		}
		expect(privatePreview.providerSettingsSealedPath).toBeDefined();
		const sealed = await readFile(privatePreview.providerSettingsSealedPath as string, "utf8");
		expect(sealed).not.toContain("fixture-extension-token");
		await expect(exportData(selection)).rejects.toThrow();
	});
	test("cross-key import remaps provider identity, reencrypts secrets and keeps imported settings dormant without grants", async () => {
		const zip = await source(),
			sourceKey = readFileSync(join(home, "secret.key")),
			sourceRow = await store.getSetting(address("source-id"));
		resetRows();
		writeFileSync(join(home, "secret.key"), `${randomBytes(32).toString("base64")}\n`);
		resetSecretStoreForTests();
		setProviders([
			provider("source-id", "local", "local-inference-key", "https://local.invalid/v1"),
		]);
		await save("source-id", "local unchanged", "local-extension-token");
		const local = await store.getSetting(address("source-id"));
		const preview = await previewImport(bytes(zip), "move.zip");
		const result = await applyImport(preview.token, { include: selection, passphrase });
		expect(result.providerSettingsImported).toBe(1);
		const imported = settings.customApiProviders.find(
			(p) => p.baseUrl === "https://source.invalid/v1",
		);
		if (!imported) throw Error("missing imported provider");
		expect(imported.id).not.toBe("source-id");
		expect(await store.getSetting(address("source-id"))).toEqual(local);
		const row = await store.getSetting(address(imported.id));
		if (!row) throw Error("missing imported settings");
		expect(row.state).toBe("dormant");
		expect(row.installationId).not.toBe("source-installation");
		expect(row.keyId).not.toBe(sourceRow?.keyId);
		expect(openProviderSetting(row).secrets).toEqual({ token: "fixture-extension-token" });
		expect(openProviderSetting(row).config.values).toEqual({ label: "source label" });
		expect(readFileSync(join(home, "secret.key"))).not.toEqual(sourceKey);
		expect(
			sqlite
				.query("SELECT COUNT(*) AS n FROM integration_authorities WHERE integration_id=?")
				.get(pluginId),
		).toEqual({ n: 0 });
		const beforeBudget = sqlite
			.query("SELECT settings_count FROM plugin_resource_budgets WHERE plugin_id=?")
			.get(pluginId);
		const again = await previewImport(bytes(zip), "repeat.zip");
		expect(await applyImport(again.token, { include: selection, passphrase })).toMatchObject({
			providerSettingsImported: 0,
			providerSettingsSkipped: 1,
			providerSettingsConflicts: 1,
		});
		expect(await store.getSetting(address(imported.id))).toEqual(row);
		expect(
			sqlite
				.query("SELECT settings_count FROM plugin_resource_budgets WHERE plugin_id=?")
				.get(pluginId),
		).toEqual(beforeBudget);
	});
	test("same-endpoint custom provider receives its missing extension under the local stable id", async () => {
		const zip = await source();
		resetRows();
		setProviders([provider("local-id", "local", "fixture-inference-key")]);
		const preview = await previewImport(bytes(zip), "same-endpoint.zip");
		expect(await applyImport(preview.token, { include: selection, passphrase })).toMatchObject({
			providersAdded: 0,
			providerSettingsImported: 1,
			providerSettingsSkipped: 0,
			providerSettingsConflicts: 0,
		});
		expect(settings.customApiProviders.map((p) => p.id)).toEqual(["local-id"]);
		expect(await store.getSetting(address("source-id"))).toBeNull();
		const row = await store.getSetting(address("local-id"));
		if (!row) throw Error("missing merged extension");
		expect(row.state).toBe("dormant");
		expect(openProviderSetting(row).config.values).toEqual({ label: "source label" });
		expect(openProviderSetting(row).secrets).toEqual({ token: "fixture-extension-token" });
	});

	for (const kind of ["custom-api", "nug"] as const) {
		for (const localState of ["active", "deleted"] as const) {
			test(`${kind} same-endpoint import keeps local ${localState} extension and reports its conflict`, async () => {
				const selectProvider = (id: string) => {
					setProviders(kind === "custom-api" ? [provider(id, id, "same-inference-key")] : []);
					if (kind === "nug") {
						const next = structuredClone(settings);
						next.nugProviders = [provider(id, id, "same-inference-key")];
						saveSettings(next);
					}
				};
				selectProvider("source-id");
				await save("source-id", "source label", "source-token", kind);
				const zip = await readFile((await exportData(selection, { passphrase })).zipPath);
				resetRows();
				selectProvider("local-id");
				const saved = await save("local-id", "local label", "local-token", kind);
				if (localState === "deleted")
					await data.remove(context("local-id", kind), declaration, saved.revision);
				const local = await store.getSetting(address("local-id", kind));
				const preview = await previewImport(bytes(zip), "local-conflict.zip");
				expect(await applyImport(preview.token, { include: selection, passphrase })).toMatchObject({
					providersAdded: 0,
					providerSettingsImported: 0,
					providerSettingsSkipped: 1,
					providerSettingsConflicts: 1,
				});
				expect(await store.getSetting(address("local-id", kind))).toEqual(local);
				expect(await store.getSetting(address("source-id", kind))).toBeNull();
				expect(
					sqlite
						.query("SELECT settings_count FROM plugin_resource_budgets WHERE plugin_id=?")
						.get(pluginId),
				).toEqual({ settings_count: 1 });
			});
		}
	}

	test("existing singleton receives a missing extension while its local provider credentials stay unchanged", async () => {
		let next = structuredClone(settings);
		next.commandCode = { apiKey: "source-command-key" };
		next.tokendance = { apiKey: "source-token-key", disabled: false, generation: 1 };
		next.codex = { loadBalancingMode: "priority" };
		saveSettings(next);
		for (const id of ["commandcode:singleton", "tokendance:singleton", "codex:pool"])
			await save(id, id, "source-extension-token", "platform");
		const zip = await readFile((await exportData(selection, { passphrase })).zipPath);
		resetRows();
		setProviders([]);
		next = structuredClone(settings);
		next.commandCode = { apiKey: "local-command-key" };
		next.tokendance = { apiKey: "local-token-key", disabled: false, generation: 2 };
		next.codex = { loadBalancingMode: "balanced" };
		saveSettings(next);
		const localKeys = getProviderKeyStore().all();
		const preview = await previewImport(bytes(zip), "singleton.zip");
		expect(await applyImport(preview.token, { include: selection, passphrase })).toMatchObject({
			providersAdded: 0,
			keysImported: 0,
			providerSettingsImported: 3,
			providerSettingsSkipped: 0,
		});
		expect(settings.codex?.loadBalancingMode).toBe("balanced");
		expect(getProviderKeyStore().all()).toEqual(localKeys);
		for (const id of ["commandcode:singleton", "tokendance:singleton", "codex:pool"]) {
			const row = await store.getSetting(address(id, "platform"));
			if (!row) throw Error("missing singleton extension");
			expect(row.state).toBe("dormant");
			expect(openProviderSetting(row).secrets).toEqual({ token: "source-extension-token" });
		}
	});

	test("all target kinds, Codex credentials/pool, CLI singleton and orphan tombstones round-trip without core targets", async () => {
		const targets: Array<{ kind: ProviderSettingsTargetKind; id: string }> = [
			{ kind: "custom-api", id: "orphan-custom" },
			{ kind: "nug", id: "orphan-nug" },
			{ kind: "platform", id: "codex:credential:source-account" },
			{ kind: "platform", id: "codex:pool" },
			{ kind: "platform", id: "commandcode:singleton" },
			{ kind: "platform", id: "tokendance:singleton" },
			{ kind: "executable-plugin", id: "source-provider-generation" },
		];
		for (const { kind, id } of targets) await save(id, `label:${id}`, `secret:${id}`, kind);
		const retired = { kind: "executable-plugin", id: "retired-provider-generation" } as const;
		const old = await save(retired.id, "old installation", "removed-secret", retired.kind);
		await data.remove(context(retired.id, retired.kind), declaration, old.revision);
		const zip = await readFile((await exportData(selection, { passphrase })).zipPath);
		const preview = await previewImport(bytes(zip), "orphan-targets.zip");
		expect(preview.version).toBe(3);
		expect(preview.providerSettingsCount).toBe(targets.length + 1);
		expect(preview.providerSettingsTargets).toHaveLength(targets.length + 1);
		for (const target of [...targets, retired])
			expect(preview.providerSettingsTargets).toContainEqual(target);
		resetRows();
		setProviders([]);
		// A matching display name is not authority to attach the retained source address.
		const local = provider("different-local-id", "local", "local-key", "https://local.invalid");
		local.name = "orphan-custom";
		setProviders([local]);
		const localKeys = getProviderKeyStore().all();
		expect(await applyImport(preview.token, { include: selection, passphrase })).toMatchObject({
			providersAdded: 0,
			keysImported: 0,
			providerSettingsImported: targets.length + 1,
			providerSettingsSkipped: 0,
		});
		for (const { kind, id } of targets) {
			const row = await store.getSetting(address(id, kind));
			if (!row) throw Error("missing retained extension");
			expect(row.state).toBe("dormant");
			expect(row.installationId).toMatch(/^import-/);
			expect(openProviderSetting(row).config.values).toEqual({ label: `label:${id}` });
			expect(openProviderSetting(row).secrets).toEqual({ token: `secret:${id}` });
		}
		const tombstone = await store.getSetting(address(retired.id, retired.kind));
		expect(tombstone).toMatchObject({
			state: "deleted",
			configText: "",
			secretsEnvelope: null,
			keyId: null,
		});
		expect(tombstone?.installationId).toMatch(/^import-/);
		expect(await store.getSetting(address("different-local-id"))).toBeNull();
		expect(settings.customApiProviders.map((p) => p.id)).toEqual(["different-local-id"]);
		expect(settings.nugProviders).toHaveLength(0);
		expect(settings.codex).toBeUndefined();
		expect(settings.commandCode).toBeUndefined();
		expect(settings.tokendance).toBeUndefined();
		expect(getProviderKeyStore().all()).toEqual(localKeys);
		expect(
			sqlite
				.query("SELECT COUNT(*) AS n FROM integration_authorities WHERE integration_id=?")
				.get(pluginId),
		).toEqual({ n: 0 });
		const exportedAgain = await readFile((await exportData(selection, { passphrase })).zipPath);
		const secondPreview = await previewImport(bytes(exportedAgain), "retained.zip");
		expect(secondPreview.providerSettingsCount).toBe(targets.length + 1);
		expect(secondPreview.providerSettingsTargets).toEqual(preview.providerSettingsTargets);
	});

	test("wrong passphrases and missing sealed settings leave both core providers and extension rows unchanged", async () => {
		const zip = await source();
		resetRows();
		setProviders([]);
		const preview = await previewImport(bytes(zip), "wrong.zip");
		await expect(
			applyImport(preview.token, { include: selection, passphrase: "wrong fixture phrase" }),
		).rejects.toThrow();
		expect(settings.customApiProviders).toHaveLength(0);
		expect((await store.listSettings(pluginId)).items).toHaveLength(0);
		const second = await previewImport(bytes(zip), "missing.zip"),
			privatePreview = getPreview(second.token);
		rmSync(privatePreview.providerSettingsSealedPath as string);
		await expect(applyImport(second.token, { include: selection, passphrase })).rejects.toThrow();
		expect(settings.customApiProviders).toHaveLength(0);
		expect((await store.listSettings(pluginId)).items).toHaveLength(0);
	});
	test("provider clear tombstones extensions and resource state, and requests-only export excludes them", async () => {
		await source();
		await store.commit({
			resource: {
				address: {
					pluginId,
					ownerKind: "host-projection",
					scopeType: "provider",
					scopeId: "provider-scope",
					key: "quota",
				},
				expectedRevision: 0,
				value: {
					installationId: "source-installation",
					bindingFingerprint: "b".repeat(64),
					state: "active",
					valueText: '{"balance":12}',
				},
			},
		});
		const zip = await readFile(
			(await exportData({ requests: true, sessions: false, providers: false })).zipPath,
		);
		const preview = await previewImport(bytes(zip), "requests.zip"),
			snapshot = new Database(getPreview(preview.token).snapshotPath, { readonly: true });
		try {
			expect(
				snapshot
					.query("SELECT name FROM sqlite_master WHERE name='plugin_provider_settings'")
					.get(),
			).toBeNull();
		} finally {
			snapshot.close();
		}
		await clearData("providers");
		expect(await store.getSetting(address("source-id"))).toMatchObject({
			state: "deleted",
			configText: "",
			secretsEnvelope: null,
		});
		expect(
			sqlite
				.query("SELECT state,value_text,bytes FROM plugin_resource_entries WHERE plugin_id=?")
				.get(pluginId),
		).toEqual({ state: "deleted", value_text: "", bytes: 0 });
	});
});
