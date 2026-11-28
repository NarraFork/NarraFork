import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
	isBoundedProviderSettingsData,
	PROVIDER_SETTINGS_VALUE_LIMITS,
} from "../../shared/provider-settings-values";
import { openBundle } from "../lib/credential-transfer/bundle";
import { sealSecretRecord, secretRecordKeyId } from "../lib/secret-store";
import {
	type PluginSettingAddress,
	parseSettingAddress,
	settingRowId,
} from "../services/plugin-settings-store";
import { providerSettingsStoredConfigSchema } from "../services/provider-settings-config-policy";
import {
	openProviderSetting,
	providerSettingRecordBinding,
} from "../services/provider-settings-data";
import { createSqlitePluginSettingsStore } from "../services/sqlite-plugin-settings-store";
import { openDatabase } from "./connection";
import { PROVIDER_SETTINGS_TRANSFER_LIMITS, type SnapshotBuildResult } from "./snapshot-protocol";

export interface ProviderSettingsImportStageInput {
	sealedPath?: string;
	passphrase?: string;
	mappings: Array<{ kind: string; from: string; to: string }>;
	expectedCount: number;
}
function invalid(): never {
	throw Error("Provider settings import is invalid or incomplete");
}
function key(kind: string, id: string): string {
	return JSON.stringify([kind, id]);
}
/** Dedicated-process only. No application database handle or main-thread fallback. */
export async function prepareProviderSettingsImport(
	source: string,
	output: string,
	input: ProviderSettingsImportStageInput,
): Promise<SnapshotBuildResult> {
	if (
		resolve(source) === resolve(output) ||
		!Number.isInteger(input.expectedCount) ||
		input.expectedCount < 0 ||
		input.expectedCount > PROVIDER_SETTINGS_TRANSFER_LIMITS.records ||
		!Array.isArray(input.mappings) ||
		input.mappings.length > 4096
	)
		return invalid();
	const mappings = new Map<string, string>();
	for (const mapping of input.mappings) {
		const address = parseSettingAddress({
			pluginId: "import.validation",
			contributionId: "import",
			targetKind: mapping.kind,
			targetId: mapping.from,
		});
		parseSettingAddress({ ...address, targetId: mapping.to });
		const sourceKey = key(mapping.kind, mapping.from);
		if (mappings.has(sourceKey)) return invalid();
		mappings.set(sourceKey, mapping.to);
	}
	let rawSealed: string | undefined;
	if (input.sealedPath) {
		if (
			typeof input.sealedPath !== "string" ||
			input.sealedPath.length > 4096 ||
			!input.passphrase ||
			input.passphrase.length > 4096
		)
			return invalid();
		const file = await open(input.sealedPath, "r");
		try {
			const info = await file.stat();
			if (!info.isFile() || info.size > 8 * 1024 * 1024) return invalid();
			const data = Buffer.alloc(info.size + 1);
			let offset = 0;
			while (offset < data.length) {
				const { bytesRead } = await file.read(data, offset, data.length - offset, null);
				if (!bytesRead) break;
				offset += bytesRead;
			}
			if (offset !== info.size) return invalid();
			rawSealed = data.subarray(0, offset).toString("utf8");
		} finally {
			await file.close();
		}
	}
	const bundle = rawSealed ? await openBundle(rawSealed, input.passphrase as string) : undefined;
	const items = new Map<string, { metadata: string; secrets: Record<string, string> }>();
	for (const item of bundle?.items ?? []) {
		if (
			item.kind !== "provider-settings" ||
			items.has(item.id) ||
			!item.data ||
			typeof item.data !== "object"
		)
			return invalid();
		const data = item.data as { metadata: string; secrets: Record<string, string> };
		if (
			typeof data.metadata !== "string" ||
			Buffer.byteLength(data.metadata) > PROVIDER_SETTINGS_VALUE_LIMITS.requestBytes ||
			!isBoundedProviderSettingsData(data.secrets, PROVIDER_SETTINGS_VALUE_LIMITS.combinedBytes)
		)
			return invalid();
		items.set(item.id, data);
	}
	try {
		await stat(output);
		throw Error("Provider settings staging file already exists");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const src = new Database(source, { readonly: true });
	let out: Database | undefined;
	try {
		const addresses = src
			.query(
				"SELECT plugin_id AS pluginId,contribution_id AS contributionId,target_kind AS targetKind,target_id AS targetId,id FROM plugin_provider_settings ORDER BY id LIMIT ?",
			)
			.all(PROVIDER_SETTINGS_TRANSFER_LIMITS.records + 1) as Array<
			PluginSettingAddress & { id: string }
		>;
		if (addresses.length !== input.expectedCount) return invalid();
		out = new Database(output);
		out.run("PRAGMA journal_mode=WAL");
		out.run("ATTACH DATABASE ? AS source", [source]);
		out.run(
			"CREATE TABLE plugin_provider_settings AS SELECT * FROM source.plugin_provider_settings WHERE 0",
		);
		out.run("CREATE UNIQUE INDEX staged_setting_id ON plugin_provider_settings(id)");
		out.run(
			"CREATE TABLE plugin_resource_budgets(plugin_id TEXT PRIMARY KEY,resource_bytes INTEGER NOT NULL,resource_count INTEGER NOT NULL,settings_count INTEGER NOT NULL,updated_at TEXT NOT NULL)",
		);
		out.run("DETACH DATABASE source");
		const reader = createSqlitePluginSettingsStore(src),
			writer = createSqlitePluginSettingsStore(out);
		const importInstallation = `import-${randomUUID()}`;
		let bytes = 0,
			imported = 0,
			skipped = 0;
		for (const { id, ...address } of addresses) {
			const row = await reader.getSetting(address);
			if (!row || row.id !== id || row.secretsEnvelope !== null || row.keyId !== null)
				return invalid();
			bytes += Buffer.byteLength(row.configText);
			if (bytes > PROVIDER_SETTINGS_TRANSFER_LIMITS.bytes) return invalid();
			const item = items.get(id);
			if (item) items.delete(id);
			// An absent core target is a retained, dormant address, never permission to discard data.
			const targetId = mappings.get(key(row.targetKind, row.targetId)) ?? row.targetId;
			const nextAddress = { ...address, targetId };
			if (row.state === "deleted") {
				if (item || row.configText !== "") return invalid();
				if (await writer.getSetting(nextAddress)) {
					skipped++;
					continue;
				}
				await writer.commit({
					setting: {
						address: nextAddress,
						expectedRevision: 0,
						value: {
							installationId: importInstallation,
							state: "deleted",
							schemaVersion: row.schemaVersion,
							schemaFingerprint: row.schemaFingerprint,
							bindingFingerprint: row.bindingFingerprint,
							configText: "",
							secretsEnvelope: null,
							keyId: null,
						},
					},
				});
				imported++;
				continue;
			}
			let config: unknown;
			try {
				config = JSON.parse(row.configText);
			} catch {
				return invalid();
			}
			if (!isBoundedProviderSettingsData(config, PROVIDER_SETTINGS_VALUE_LIMITS.requestBytes))
				return invalid();
			const parsed = providerSettingsStoredConfigSchema.safeParse(config);
			if (!parsed.success) return invalid();
			if (
				parsed.data.revision !== row.revision ||
				parsed.data.schemaVersion !== row.schemaVersion ||
				parsed.data.schemaFingerprint !== row.schemaFingerprint
			)
				return invalid();
			const expectedMetadata = JSON.stringify([address, row.revision, row.configText]);
			if (item && item.metadata !== expectedMetadata) return invalid();
			const secrets = item?.secrets ?? {};
			if (
				Object.keys(parsed.data.secrets).sort().join("\0") !==
				Object.keys(secrets).sort().join("\0")
			)
				return invalid();
			for (const [field, value] of Object.entries(secrets)) {
				if (
					typeof value !== "string" ||
					Buffer.byteLength(value) !== parsed.data.secrets[field].bytes ||
					[...value].length !== parsed.data.secrets[field].characters
				)
					return invalid();
			}
			if (Object.keys(secrets).length) bytes += Buffer.byteLength(JSON.stringify(secrets));
			if (bytes > PROVIDER_SETTINGS_TRANSFER_LIMITS.bytes) return invalid();
			if (await writer.getSetting(nextAddress)) {
				skipped++;
				continue;
			}
			const configText = JSON.stringify({ ...parsed.data, revision: 1 });
			const identity = {
				id: settingRowId(nextAddress),
				installationId: importInstallation,
				revision: 1,
				schemaFingerprint: row.schemaFingerprint,
				bindingFingerprint: row.bindingFingerprint,
				configText,
			};
			let envelope: string | null = null,
				keyId: string | null = null;
			if (Object.keys(secrets).length) {
				const plain = Buffer.from(JSON.stringify(secrets));
				try {
					envelope = sealSecretRecord(plain, providerSettingRecordBinding(identity));
					keyId = secretRecordKeyId(envelope);
				} finally {
					plain.fill(0);
				}
			}
			const result = await writer.commit({
				setting: {
					address: nextAddress,
					expectedRevision: 0,
					value: {
						installationId: importInstallation,
						state: "dormant",
						schemaVersion: row.schemaVersion,
						schemaFingerprint: row.schemaFingerprint,
						bindingFingerprint: row.bindingFingerprint,
						configText,
						secretsEnvelope: envelope,
						keyId,
					},
				},
			});
			if (!result.setting) return invalid();
			openProviderSetting(result.setting);
			imported++;
		}
		if (items.size) return invalid();
		return { ok: true, providerSettingsCount: imported, providerSettingsSkipped: skipped };
	} finally {
		out?.close();
		src.close();
	}
}

/** Runs in the dedicated transfer process after an explicitly authorized provider clear.
 * Tombstones and budget deltas commit in small batches; interruption is safe to retry.
 */
export function clearProviderSettingsData(path: string): SnapshotBuildResult {
	const db = openDatabase(path);
	let cleared = 0,
		settingsAfter = "",
		resourcesAfter = "";
	try {
		for (let page = 0; page < 10000; page++) {
			const settings = db
				.query(
					"SELECT id,revision FROM plugin_provider_settings WHERE state != 'deleted' AND id > ? ORDER BY id LIMIT 50",
				)
				.all(settingsAfter) as Array<{ id: string; revision: number }>;
			if (!settings.length) break;
			settingsAfter = settings[settings.length - 1].id;
			db.transaction(() => {
				for (const row of settings) {
					if (row.revision >= Number.MAX_SAFE_INTEGER - 1) invalid();
					db.run(
						"UPDATE plugin_provider_settings SET state='deleted',config_text='',secrets_envelope=NULL,key_id=NULL,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
						[new Date().toISOString(), row.id, row.revision],
					);
				}
			}).immediate();
			cleared += settings.length;
			if (page === 9999) throw Error("Provider clear budget exceeded; retry to continue");
		}
		for (let page = 0; page < 10000; page++) {
			const rows = db
				.query(
					"SELECT id,plugin_id AS pluginId,bytes,revision FROM plugin_resource_entries WHERE scope_type IN ('provider','credential') AND state!='deleted' AND id > ? ORDER BY id LIMIT 50",
				)
				.all(resourcesAfter) as Array<{
				id: string;
				pluginId: string;
				bytes: number;
				revision: number;
			}>;
			if (!rows.length) break;
			resourcesAfter = rows[rows.length - 1].id;
			db.transaction(() => {
				for (const row of rows) {
					if (row.revision >= Number.MAX_SAFE_INTEGER - 1) invalid();
					const update = db.run(
						"UPDATE plugin_resource_entries SET state='deleted',value_text='',bytes=0,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
						[new Date().toISOString(), row.id, row.revision],
					);
					if (update.changes)
						db.run(
							"UPDATE plugin_resource_budgets SET resource_bytes=resource_bytes-?,updated_at=? WHERE plugin_id=?",
							[row.bytes, new Date().toISOString(), row.pluginId],
						);
				}
			}).immediate();
			if (page === 9999) throw Error("Provider resource clear budget exceeded; retry to continue");
		}
		return { ok: true, providerSettingsCount: cleared };
	} finally {
		db.close();
	}
}
