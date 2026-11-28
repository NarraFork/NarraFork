import {
	PLUGIN_SETTINGS_STORE_LIMITS,
	type PluginResourceAddress,
	type PluginResourceMutation,
	type PluginResourceRecord,
	type PluginResourceScope,
	type PluginResourceSummary,
	type PluginSettingAddress,
	type PluginSettingMutation,
	type PluginSettingRecord,
	type PluginSettingSummary,
	PluginSettingsStoreError,
	type PluginStorePage,
	parseResourceAddress,
	parseSettingAddress,
	parseStorePluginId,
	prepareResourceMutation,
	prepareSettingMutation,
	resourceRowId,
	settingRowId,
	storePageOptions,
} from "./plugin-settings-store";

export interface PluginStoreStatement {
	text: string;
	params: (string | number | null)[];
}
export type PluginStoreRows = Record<string, unknown>[];
/** Pure bounded statement plans. SQLite drives synchronously within a transaction; PG awaits each step. */
export type PluginStorePlan<T> = Generator<PluginStoreStatement, T, PluginStoreRows>;
const settingColumns = {
	id: "id",
	pluginId: "plugin_id",
	contributionId: "contribution_id",
	targetKind: "target_kind",
	targetId: "target_id",
	installationId: "installation_id",
	state: "state",
	schemaVersion: "schema_version",
	schemaFingerprint: "schema_fingerprint",
	bindingFingerprint: "binding_fingerprint",
	revision: "revision",
	configText: "config_text",
	secretsEnvelope: "secrets_envelope",
	keyId: "key_id",
	createdAt: "created_at",
	updatedAt: "updated_at",
} as const;
const resourceColumns = {
	id: "id",
	pluginId: "plugin_id",
	ownerKind: "owner_kind",
	scopeType: "scope_type",
	scopeId: "scope_id",
	key: "key",
	installationId: "installation_id",
	bindingFingerprint: "binding_fingerprint",
	revision: "revision",
	state: "state",
	valueText: "value_text",
	bytes: "bytes",
	createdAt: "created_at",
	updatedAt: "updated_at",
} as const;
function projection(columns: Record<string, string>, omit: string[] = []): string {
	return Object.entries(columns)
		.filter(([key]) => !omit.includes(key))
		.map(([key, column]) => `"${column}" AS "${key}"`)
		.join(",");
}
const settingProjection = projection(settingColumns),
	resourceProjection = projection(resourceColumns);
const settingSummaryProjection = projection(settingColumns, ["configText", "secretsEnvelope"]),
	resourceSummaryProjection = projection(resourceColumns, ["valueText"]);
function statement(text: string, ...params: PluginStoreStatement["params"]): PluginStoreStatement {
	return { text, params };
}
function conflict(): never {
	throw new PluginSettingsStoreError("PLUGIN_SETTINGS_REVISION_CONFLICT");
}
function unavailable(): never {
	throw new PluginSettingsStoreError("PLUGIN_SETTINGS_STORE_UNAVAILABLE");
}
function number(value: unknown): number {
	const result =
		typeof value === "bigint" ||
		(typeof value === "string" && /^(?:0|[1-9][0-9]{0,15})$/.test(value))
			? Number(value)
			: value;
	if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0)
		return unavailable();
	return result;
}
function setting(row: Record<string, unknown>): PluginSettingRecord {
	const address = parseSettingAddress({
		pluginId: row.pluginId,
		contributionId: row.contributionId,
		targetKind: row.targetKind,
		targetId: row.targetId,
	});
	const revision = number(row.revision),
		schemaVersion = number(row.schemaVersion);
	const value = prepareSettingMutation({
		address,
		expectedRevision: revision,
		value: {
			installationId: row.installationId,
			state: row.state,
			schemaVersion,
			schemaFingerprint: row.schemaFingerprint,
			bindingFingerprint: row.bindingFingerprint,
			configText: row.configText,
			secretsEnvelope: row.secretsEnvelope,
			keyId: row.keyId,
		} as PluginSettingMutation["value"],
	}).value;
	if (
		row.id !== settingRowId(address) ||
		revision < 1 ||
		typeof row.createdAt !== "string" ||
		typeof row.updatedAt !== "string"
	)
		return unavailable();
	return {
		...address,
		...value,
		id: row.id,
		revision,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}
function resource(row: Record<string, unknown>): PluginResourceRecord {
	const address = parseResourceAddress({
		pluginId: row.pluginId,
		ownerKind: row.ownerKind,
		scopeType: row.scopeType,
		scopeId: row.scopeId,
		key: row.key,
	});
	const revision = number(row.revision),
		bytes = number(row.bytes);
	const value = prepareResourceMutation({
		address,
		expectedRevision: revision,
		value: {
			installationId: row.installationId,
			bindingFingerprint: row.bindingFingerprint,
			state: row.state,
			valueText: row.valueText,
		} as PluginResourceMutation["value"],
	}).value;
	if (
		row.id !== resourceRowId(address) ||
		revision < 1 ||
		bytes !== Buffer.byteLength(value.valueText) ||
		typeof row.createdAt !== "string" ||
		typeof row.updatedAt !== "string"
	)
		return unavailable();
	return {
		...address,
		...value,
		id: row.id,
		revision,
		bytes,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}
export function* readSetting(
	address: PluginSettingAddress,
): PluginStorePlan<PluginSettingRecord | null> {
	const valid = parseSettingAddress(address),
		id = settingRowId(valid);
	const rows = yield statement(
		`SELECT ${settingProjection} FROM plugin_provider_settings WHERE id = ? AND plugin_id = ? LIMIT 1`,
		id,
		valid.pluginId,
	);
	return rows[0] ? setting(rows[0]) : null;
}
export function* readResource(
	address: PluginResourceAddress,
): PluginStorePlan<PluginResourceRecord | null> {
	const valid = parseResourceAddress(address),
		id = resourceRowId(valid);
	const rows = yield statement(
		`SELECT ${resourceProjection} FROM plugin_resource_entries WHERE id = ? AND plugin_id = ? LIMIT 1`,
		id,
		valid.pluginId,
	);
	return rows[0] ? resource(rows[0]) : null;
}
export function* pageSettings(
	plugin: string,
	options: { cursor?: string; limit?: number } = {},
): PluginStorePlan<PluginStorePage<PluginSettingSummary>> {
	const id = parseStorePluginId(plugin),
		{ cursor, limit } = storePageOptions(options);
	const rows = yield statement(
		`SELECT ${settingSummaryProjection} FROM plugin_provider_settings WHERE plugin_id = ? AND id > ? ORDER BY id LIMIT ?`,
		id,
		cursor,
		limit + 1,
	);
	const items = rows.slice(0, limit).map(
		(row) =>
			({
				...row,
				revision: number(row.revision),
				schemaVersion: number(row.schemaVersion),
			}) as PluginSettingSummary,
	);
	return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}
export function* pageResources(
	scope: PluginResourceScope,
	options: { cursor?: string; limit?: number } = {},
): PluginStorePlan<PluginStorePage<PluginResourceSummary>> {
	const valid = parseResourceAddress({ ...scope, key: "placeholder" }),
		{ cursor, limit } = storePageOptions(options);
	const rows = yield statement(
		`SELECT ${resourceSummaryProjection} FROM plugin_resource_entries WHERE plugin_id = ? AND owner_kind = ? AND scope_type = ? AND scope_id = ? AND id > ? ORDER BY id LIMIT ?`,
		valid.pluginId,
		valid.ownerKind,
		valid.scopeType,
		valid.scopeId,
		cursor,
		limit + 1,
	);
	const items = rows.slice(0, limit).map(
		(row) =>
			({
				...row,
				revision: number(row.revision),
				bytes: number(row.bytes),
			}) as PluginResourceSummary,
	);
	return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}
function insertOrUpdate(
	table: "plugin_provider_settings" | "plugin_resource_entries",
	columns: Record<string, string>,
	record: PluginSettingRecord | PluginResourceRecord,
	oldRevision: number,
): PluginStoreStatement {
	const data = record as unknown as Record<string, string | number | null>;
	const entries = Object.entries(columns);
	if (!oldRevision)
		return {
			text: `INSERT INTO ${table} (${entries.map(([, column]) => `"${column}"`).join(",")}) VALUES (${entries.map(() => "?").join(",")}) RETURNING id`,
			params: entries.map(([key]) => data[key]),
		};
	const updates = entries.filter(([key]) => !["id", "createdAt"].includes(key));
	return {
		text: `UPDATE ${table} SET ${updates.map(([, column]) => `"${column}" = ?`).join(",")} WHERE id = ? AND revision = ? RETURNING id`,
		params: [...updates.map(([key]) => data[key]), record.id, oldRevision],
	};
}
export function* commitPluginData(
	input: {
		setting?: PluginSettingMutation;
		resource?: PluginResourceMutation;
		retiredSetting?: PluginSettingMutation;
	},
	dialect: "sqlite" | "postgres",
): PluginStorePlan<{ setting?: PluginSettingRecord; resource?: PluginResourceRecord }> {
	const settings = input.setting ? prepareSettingMutation(input.setting) : undefined;
	const resources = input.resource ? prepareResourceMutation(input.resource) : undefined;
	const retired = input.retiredSetting ? prepareSettingMutation(input.retiredSetting) : undefined;
	if (
		retired &&
		(!settings ||
			resources ||
			retired.address.pluginId !== settings.address.pluginId ||
			retired.address.contributionId !== settings.address.contributionId ||
			retired.address.targetKind !== settings.address.targetKind ||
			settingRowId(retired.address) === settingRowId(settings.address) ||
			retired.expectedRevision < 1 ||
			retired.value.state !== "deleted" ||
			retired.value.configText !== "" ||
			retired.value.secretsEnvelope !== null ||
			retired.value.keyId !== null)
	)
		throw new PluginSettingsStoreError("PLUGIN_SETTINGS_STORE_INVALID");
	if (!settings && !resources) throw new PluginSettingsStoreError("PLUGIN_SETTINGS_STORE_INVALID");
	if (
		settings &&
		resources &&
		(settings.address.pluginId !== resources.address.pluginId ||
			resources.address.ownerKind === "plugin")
	)
		throw new PluginSettingsStoreError("PLUGIN_SETTINGS_STORE_INVALID");
	const plugin = settings?.address.pluginId ?? resources?.address.pluginId;
	if (!plugin) throw new PluginSettingsStoreError("PLUGIN_SETTINGS_STORE_INVALID");
	const now = new Date().toISOString();
	yield statement(
		"INSERT INTO plugin_resource_budgets (plugin_id,resource_bytes,resource_count,settings_count,updated_at) VALUES (?,0,0,0,?) ON CONFLICT (plugin_id) DO NOTHING",
		plugin,
		now,
	);
	const budgets = yield statement(
		`SELECT resource_bytes AS "bytes",resource_count AS "resources",settings_count AS "settings" FROM plugin_resource_budgets WHERE plugin_id = ? LIMIT 1${dialect === "postgres" ? " FOR UPDATE" : ""}`,
		plugin,
	);
	if (!budgets[0]) return unavailable();
	let bytes = number(budgets[0].bytes),
		resourceCount = number(budgets[0].resources),
		settingsCount = number(budgets[0].settings);
	const result: { setting?: PluginSettingRecord; resource?: PluginResourceRecord } = {};
	let retiredRecord: PluginSettingRecord | undefined;
	for (const mutation of [settings, retired]) {
		if (!mutation) continue;
		const id = settingRowId(mutation.address);
		const rows = yield statement(
			'SELECT revision,created_at AS "createdAt" FROM plugin_provider_settings WHERE id = ? LIMIT 1',
			id,
		);
		const old = rows[0],
			revision = old ? number(old.revision) : 0;
		if (revision !== mutation.expectedRevision || revision >= Number.MAX_SAFE_INTEGER - 1)
			conflict();
		if (!old) settingsCount++;
		const record: PluginSettingRecord = {
			...mutation.address,
			...mutation.value,
			id,
			revision: revision + 1,
			createdAt: old ? String(old.createdAt) : now,
			updatedAt: now,
		};
		if (mutation === settings) result.setting = record;
		else retiredRecord = record;
	}
	if (resources) {
		const id = resourceRowId(resources.address);
		const rows = yield statement(
			'SELECT revision,bytes,created_at AS "createdAt" FROM plugin_resource_entries WHERE id = ? LIMIT 1',
			id,
		);
		const old = rows[0],
			revision = old ? number(old.revision) : 0;
		if (revision !== resources.expectedRevision || revision >= Number.MAX_SAFE_INTEGER - 1)
			conflict();
		const newBytes = Buffer.byteLength(resources.value.valueText);
		bytes += newBytes - (old ? number(old.bytes) : 0);
		if (!old) resourceCount++;
		result.resource = {
			...resources.address,
			...resources.value,
			id,
			revision: revision + 1,
			bytes: newBytes,
			createdAt: old ? String(old.createdAt) : now,
			updatedAt: now,
		};
	}
	if (
		bytes < 0 ||
		bytes > PLUGIN_SETTINGS_STORE_LIMITS.pluginBytes ||
		resourceCount > PLUGIN_SETTINGS_STORE_LIMITS.resourceCount ||
		settingsCount > PLUGIN_SETTINGS_STORE_LIMITS.settingsCount
	)
		throw new PluginSettingsStoreError("PLUGIN_SETTINGS_QUOTA_EXCEEDED");
	if (result.setting) {
		const rows = yield insertOrUpdate(
			"plugin_provider_settings",
			settingColumns,
			result.setting,
			settings?.expectedRevision ?? 0,
		);
		if (rows.length !== 1) conflict();
	}
	if (retiredRecord && retired) {
		const rows = yield insertOrUpdate(
			"plugin_provider_settings",
			settingColumns,
			retiredRecord,
			retired.expectedRevision,
		);
		if (rows.length !== 1) conflict();
	}
	if (result.resource) {
		const rows = yield insertOrUpdate(
			"plugin_resource_entries",
			resourceColumns,
			result.resource,
			resources?.expectedRevision ?? 0,
		);
		if (rows.length !== 1) conflict();
	}
	yield statement(
		"UPDATE plugin_resource_budgets SET resource_bytes = ?,resource_count = ?,settings_count = ?,updated_at = ? WHERE plugin_id = ?",
		bytes,
		resourceCount,
		settingsCount,
		now,
		plugin,
	);
	return result;
}
