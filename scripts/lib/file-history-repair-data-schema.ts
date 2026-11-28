import type { Database } from "bun:sqlite";

/** This offline tool deliberately supports only the reviewed, current history schema. */
export const HISTORY_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
	file_change_blobs:
		"id:t!p digest:t! size_bytes:i! storage_key:t! status:t! lease_until:t gc_generation:i! created_at:t! updated_at:t!",
	file_change_storage_budgets:
		"id:t!p namespace_key:t! status:t! used_bytes:i! reserved_bytes:i! quota_bytes:i! generation:i! reconciled_at:t updated_at:t!",
	file_change_blob_reservations:
		"id:t!p budget_id:t! owner_epoch:t! generation:i! expected_size:i! status:t! blob_digest:t published:i created_at:t! settled_at:t",
	file_change_operations:
		"id:t!p journal_seq:i execution_segment_id:t evidence_version:i! source_instance_id:t! source_kind:t! source_id:t! attempt:i! request_digest:t expected_effect_count:i workspace_lease_id:t editor_raw_snapshot_revision:r prepared_effect_count:i! evidence_bytes:i! settled_effect_count:i! unresolved_effect_count:i! tool_call_id:t tool_use_id:t background_task_id:t narrator_id:t project_id:t owner_user_id:t actor_subject_key:t! actor_json:t! initiator_subject_key:t execution_binding_json:t execution_outcome:t! effect_outcome:t! settlement:t! attribution_grade:t! coverage:t! parent_operation_id:t reason:t lease_until:t started_at:t! finished_at:t updated_at:t!",
	file_change_effects:
		"id:t!p operation_id:t! journal_seq:i scope_id:t! file_key:t! identity_json:t! scope_revision:i mutation_id:t! request_digest:t! phase:t! before_state_json:t! intended_after_state_json:t! observed_after_state_json:t! before_blob_digest:t intended_after_blob_digest:t observed_after_blob_digest:t disk_outcome:t outcome:t! settlement:t! attribution_grade:t! attribution_ceiling:t execution_confirmed:i! execution_receipt_json:t execution_receipt_digest:t lines_added:i lines_removed:i created_at:t! updated_at:t!",
	snapshot_captures:
		"id:t!p scope_id:t! operation_id:t tree_hash:t snapshot_commit_sha:t coverage:t! temporal_consistency:t! policy_version:i! ignore_policy_digest:t manifest_blob_digest:t omitted_count:i reason:t started_at:t! finished_at:t",
	revert_operations:
		"id:t!p protocol_version:i! narrator_id:t project_id:t requested_by_subject_key:t! idempotency_key:t! request_digest:t! kind:t! scope:t! selector_kind:t! selector_blob_digest:t plan_blob_digest:t history_manifest_blob_digest:t plan_hash:t expected_message_version:i parent_revert_id:t status:t! file_count:i! applied_file_count:i! coverage_complete:i! reason:t expires_at:t! lease_until:t created_at:t! updated_at:t!",
	revert_operation_files:
		"id:t!p revert_operation_id:t! scope_id:t! file_key:t! identity_json:t! sequence:i! expected_state_json:t! desired_state_json:t! observed_after_state_json:t before_blob_digest:t desired_blob_digest:t observed_after_blob_digest:t compensation_after_state_json:t compensation_after_blob_digest:t apply_mutation_id:t! apply_request_digest:t! compensate_mutation_id:t compensate_request_digest:t status:t! receipt_json:t reason:t updated_at:t!",
	file_change_scopes:
		"id:t!p source_instance_id:t! device_id:t! workspace_instance_id:t! canonical_root:t! display_root:t! path_flavor:t! status:t! root_identity_json:t revision:i! fencing_token:i! active_lease_id:t active_lease_epoch:t active_lease_started_at:t active_mutation_count:i! created_at:t! updated_at:t!",
	workspace_write_leases:
		"lease_id:t!p scope_id:t! device_id:t! owner_epoch:t! execution_class:t! runtime_epoch:t! runtime_generation:i! fencing_token:i! scope_revision:i! path_flavor:t! status:t! ranges_json:t! mutation_manifest_json:t! execution_ended_at:t termination_evidence_json:t created_at:t! updated_at:t!",
	file_history_clock: "id:i!p last_seq:i!",
});

const DEFAULTS: Readonly<Record<string, Record<string, string>>> = {
	file_change_blobs: { status: "'staging'", gc_generation: "0" },
	file_change_storage_budgets: {
		status: "'unverified'",
		used_bytes: "0",
		reserved_bytes: "0",
		generation: "0",
	},
	file_change_blob_reservations: { generation: "0", status: "'reserved'" },
	file_change_operations: {
		evidence_version: "2",
		prepared_effect_count: "0",
		evidence_bytes: "0",
		settled_effect_count: "0",
		unresolved_effect_count: "0",
		execution_outcome: "'running'",
		effect_outcome: "'pending'",
		settlement: "'preparing'",
		attribution_grade: "'unknown'",
		coverage: "'unavailable'",
	},
	file_change_effects: {
		outcome: "'pending'",
		settlement: "'preparing'",
		attribution_grade: "'unknown'",
		execution_confirmed: "false",
	},
	snapshot_captures: { coverage: "'unavailable'", temporal_consistency: "'unknown'" },
	revert_operations: {
		protocol_version: "2",
		status: "'planned'",
		file_count: "0",
		applied_file_count: "0",
		coverage_complete: "false",
	},
	revert_operation_files: { status: "'prepared'" },
	file_change_scopes: {
		status: "'needs_verification'",
		revision: "0",
		fencing_token: "0",
		active_mutation_count: "0",
	},
	workspace_write_leases: { execution_class: "'unknown'" },
	file_history_clock: { last_seq: "0" },
};

export const HISTORY_WRITABLE_TABLES = Object.freeze([
	"file_change_effects",
	"revert_operation_files",
	"snapshot_captures",
	"revert_operations",
	"file_change_blob_reservations",
	"file_change_blobs",
	"file_change_storage_budgets",
] as const);

export interface HistoryForeignKey {
	from: string;
	table: string;
	to: string;
	on_delete: string;
	on_update: string;
	seq: number;
	match: string;
}

const EXPECTED_FOREIGN_KEYS: Readonly<Record<string, string[]>> = {
	file_change_blobs: [],
	file_change_storage_budgets: [],
	file_history_clock: [],
	file_change_scopes: [],
	workspace_write_leases: ["scope_id:file_change_scopes:id"],
	file_change_blob_reservations: [
		"budget_id:file_change_storage_budgets:id",
		"blob_digest:file_change_blobs:digest",
	],
	file_change_operations: [
		"narrator_id:narrators:id:SET NULL",
		"project_id:projects:id:SET NULL",
		"owner_user_id:users:id:SET NULL",
	],
	file_change_effects: [
		"operation_id:file_change_operations:id",
		"scope_id:file_change_scopes:id",
		"before_blob_digest:file_change_blobs:digest",
		"intended_after_blob_digest:file_change_blobs:digest",
		"observed_after_blob_digest:file_change_blobs:digest",
	],
	snapshot_captures: [
		"scope_id:file_change_scopes:id",
		"operation_id:file_change_operations:id",
		"manifest_blob_digest:file_change_blobs:digest",
	],
	revert_operations: [
		"narrator_id:narrators:id:SET NULL",
		"project_id:projects:id:SET NULL",
		"selector_blob_digest:file_change_blobs:digest",
		"plan_blob_digest:file_change_blobs:digest",
		"history_manifest_blob_digest:file_change_blobs:digest",
	],
	revert_operation_files: [
		"revert_operation_id:revert_operations:id",
		"scope_id:file_change_scopes:id",
		"before_blob_digest:file_change_blobs:digest",
		"desired_blob_digest:file_change_blobs:digest",
		"observed_after_blob_digest:file_change_blobs:digest",
		"compensation_after_blob_digest:file_change_blobs:digest",
	],
};

export interface HistorySchema {
	version: number;
	foreignKeys: Record<string, HistoryForeignKey[]>;
	blobReferenceRoots: number;
}
export interface SchemaAccess {
	read<T>(sql: string, bindings?: (string | number | null)[]): T[];
	check(phase: string): void;
	fail(code: string, message: string): never;
}
interface Column {
	name: string;
	type: string;
	notnull: number;
	pk: number;
	hidden: number;
	dflt_value: string | null;
}
interface SchemaObject {
	name: string;
	tbl_name: string;
	type: string;
	sql: string | null;
	bytes: number | null;
}

const IDENTIFIER = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
export function quoteHistoryIdentifier(value: string): string {
	if (!IDENTIFIER.test(value)) throw new Error("Unsupported schema identifier");
	return `"${value}"`;
}

/** Schema-only discovery; this never reads rows from unrelated application tables. */
export function inspectHistorySchema(db: Database, access: SchemaAccess): HistorySchema {
	const fail: (message: string) => never = (message) => access.fail("unsupported_schema", message);
	if (access.read("SELECT 1 FROM sqlite_temp_master LIMIT 1").length)
		fail("Temporary schema objects are not supported");
	const attached = access.read<{ name: string }>("PRAGMA database_list");
	if (attached.some((row) => row.name !== "main" && row.name !== "temp"))
		fail("Attached databases are not supported");
	const supportedNames = Object.keys(HISTORY_COLUMNS);
	const objects = access.read<SchemaObject>(
		`SELECT CASE WHEN length(CAST(name AS BLOB)) <= 256 THEN name ELSE NULL END AS name,
		CASE WHEN length(CAST(tbl_name AS BLOB)) <= 256 THEN tbl_name ELSE NULL END AS tbl_name,
		type, length(CAST(sql AS BLOB)) AS bytes,
		CASE WHEN type = 'table' AND name IN (${supportedNames.map(() => "?").join(",")})
		AND length(CAST(sql AS BLOB)) <= 65536 THEN sql ELSE NULL END AS sql
		FROM sqlite_master ORDER BY rowid LIMIT 8193`,
		supportedNames,
	);
	if (objects.length > 8192) fail("Schema object budget exceeded");
	if (objects.some((row) => typeof row.name !== "string" || typeof row.tbl_name !== "string"))
		fail("Schema identifier budget exceeded");
	const writable = new Set<string>(HISTORY_WRITABLE_TABLES);
	for (const object of objects) {
		if (object.type === "trigger" && writable.has(object.tbl_name))
			fail(`Triggers on ${object.tbl_name} are not supported`);
	}
	const tables = objects.filter((row) => row.type === "table");
	if (tables.length > 512) fail("Schema table budget exceeded");
	const foreignKeys: Record<string, HistoryForeignKey[]> = {};
	let blobReferenceRoots = 0;
	for (const table of tables) {
		access.check("schema_table");
		// Unrelated FTS shadow tables have no FK roots. Their rows are never inspected.
		if (!IDENTIFIER.test(table.name)) fail("Unsupported table identifier");
		const fks = access.read<HistoryForeignKey>(
			`SELECT seq, on_delete, on_update, "match",
			CASE WHEN length(CAST("from" AS BLOB)) <= 256 THEN "from" ELSE NULL END AS "from",
			CASE WHEN length(CAST("table" AS BLOB)) <= 256 THEN "table" ELSE NULL END AS "table",
			CASE WHEN length(CAST("to" AS BLOB)) <= 256 THEN "to" ELSE NULL END AS "to"
			FROM pragma_foreign_key_list(?) LIMIT 65`,
			[table.name],
		);
		if (
			fks.length > 64 ||
			fks.some(
				(fk) =>
					typeof fk.from !== "string" || typeof fk.table !== "string" || typeof fk.to !== "string",
			)
		)
			fail("Foreign-key metadata budget exceeded or implicit target unsupported");
		if (Object.hasOwn(HISTORY_COLUMNS, table.name)) foreignKeys[table.name] = fks;
		for (const fk of fks) {
			if (fk.table === "file_change_blobs") blobReferenceRoots++;
			if (writable.has(fk.table)) {
				const key = `${fk.from}:${fk.table}:${fk.to}${fk.on_delete === "SET NULL" ? ":SET NULL" : ""}`;
				const expected = EXPECTED_FOREIGN_KEYS[table.name] ?? [];
				const retainedAuditReference =
					(table.name === "file_attributions" &&
						key === "effect_id:file_change_effects:id:SET NULL") ||
					(table.name === "file_change_rollups" && key === "last_effect_id:file_change_effects:id");
				if (!expected.includes(key) && !retainedAuditReference)
					fail("Unknown inbound reference to a writable history table");
				if (!safeForeignKey(fk, fk.on_delete === "SET NULL" ? "SET NULL" : "NO ACTION"))
					fail("Unsafe inbound history foreign-key action");
			}
		}
	}
	for (const [table, definition] of Object.entries(HISTORY_COLUMNS)) {
		access.check("schema_contract");
		const entry = tables.find((candidate) => candidate.name === table);
		if (!entry?.sql || entry.bytes === null || entry.bytes > 65536)
			fail(`Missing or oversized supported table ${table}`);
		if (
			!/^[\s]*CREATE\s+TABLE\s/i.test(entry.sql) ||
			/\b(CHECK|GENERATED|COLLATE|DEFERRABLE|WITHOUT|STRICT|AUTOINCREMENT)\b|\/\*|--/i.test(
				entry.sql,
			)
		)
			fail(`Unsupported table clauses on ${table}`);
		const columns = readColumns(access, table);
		const expected = definition.split(" ");
		if (columns.length !== expected.length) fail(`Unexpected columns on ${table}`);
		for (const token of expected) {
			const [name, flags = ""] = token.split(":");
			const column = columns.find((candidate) => candidate.name === name);
			const types: Record<string, string> = { t: "TEXT", i: "INTEGER", r: "REAL" };
			const type = types[flags.charAt(0)];
			if (
				!column ||
				column.type.toUpperCase() !== type ||
				column.notnull !== Number(flags.includes("!")) ||
				column.pk !== Number(flags.includes("p")) ||
				column.hidden !== 0 ||
				column.dflt_value !== (DEFAULTS[table]?.[name] ?? null)
			)
				fail(`Unsupported column contract on ${table}`);
		}
		const indexes = access.read<{ name: string; partial: number }>(
			"SELECT * FROM pragma_index_list(?) LIMIT 65",
			[table],
		);
		if (indexes.length > 64) fail("Index metadata budget exceeded");
		for (const index of indexes) {
			const parts = access.read<{ name: string | null; key: number; coll: string }>(
				"SELECT * FROM pragma_index_xinfo(?) LIMIT 65",
				[index.name],
			);
			if (
				index.partial !== 0 ||
				parts.length > 64 ||
				parts.some((part) => part.key === 1 && (part.name === null || part.coll !== "BINARY"))
			)
				fail(`Unsupported expression, partial or collation index on ${table}`);
		}
		const fks = foreignKeys[table] ?? [];
		const expectedFks = EXPECTED_FOREIGN_KEYS[table] ?? [];
		if (fks.length !== expectedFks.length) fail(`Unexpected foreign keys on ${table}`);
		for (const fk of fks) {
			const key = `${fk.from}:${fk.table}:${fk.to}${fk.on_delete === "SET NULL" ? ":SET NULL" : ""}`;
			if (
				!expectedFks.includes(key) ||
				!safeForeignKey(fk, fk.on_delete === "SET NULL" ? "SET NULL" : "NO ACTION")
			)
				fail(`Unsupported foreign-key contract on ${table}`);
			assertUniqueLookup(access, fk.table, fk.to);
		}
	}
	assertUniqueLookup(access, "file_change_blobs", "digest");
	assertUniqueLookup(access, "file_change_storage_budgets", "namespace_key");
	const version = access.read<{ schema_version: number }>("PRAGMA schema_version")[0]
		?.schema_version;
	if (typeof version !== "number" || !Number.isSafeInteger(version))
		return fail("Invalid schema version");
	// The caller owns connections; discovery never changes a connection PRAGMA.
	void db;
	return { version, foreignKeys, blobReferenceRoots };
}

function safeForeignKey(fk: HistoryForeignKey, deletion = "NO ACTION"): boolean {
	return (
		fk.seq === 0 && fk.on_update === "NO ACTION" && fk.on_delete === deletion && fk.match === "NONE"
	);
}

function readColumns(access: SchemaAccess, table: string): Column[] {
	const rows = access.read<Column & { invalid: number }>(
		`SELECT CASE WHEN length(CAST(name AS BLOB)) <= 256 THEN name ELSE NULL END AS name,
		CASE WHEN length(CAST(type AS BLOB)) <= 64 THEN type ELSE NULL END AS type,
		"notnull", pk, hidden,
		CASE WHEN length(CAST(dflt_value AS BLOB)) <= 256 THEN dflt_value ELSE NULL END AS dflt_value,
		CASE WHEN length(CAST(name AS BLOB)) > 256 OR length(CAST(type AS BLOB)) > 64
		OR length(CAST(dflt_value AS BLOB)) > 256 THEN 1 ELSE 0 END AS invalid
		FROM pragma_table_xinfo(?) LIMIT 97`,
		[table],
	);
	if (rows.length > 96 || rows.some((row) => row.invalid !== 0))
		access.fail("unsupported_schema", "Column metadata budget exceeded");
	return rows;
}

function assertUniqueLookup(access: SchemaAccess, table: string, column: string): void {
	const columns = readColumns(access, table);
	if (columns.length > 96)
		access.fail("unsupported_schema", "Parent column metadata budget exceeded");
	if (columns.filter((entry) => entry.pk > 0).length === 1) {
		if (
			columns.some(
				(entry) =>
					entry.name === column && entry.pk === 1 && entry.type.toUpperCase() === "INTEGER",
			)
		)
			return;
	}
	const indexes = access.read<{ name: string; unique: number; partial: number }>(
		"SELECT * FROM pragma_index_list(?) LIMIT 65",
		[table],
	);
	if (indexes.length > 64) access.fail("unsupported_schema", "Index metadata budget exceeded");
	for (const index of indexes) {
		if (index.unique !== 1 || index.partial !== 0) continue;
		const parts = access.read<{ name: string | null; key: number; coll: string }>(
			"SELECT * FROM pragma_index_xinfo(?) LIMIT 65",
			[index.name],
		);
		const keys = parts.filter((entry) => entry.key === 1);
		if (
			parts.length <= 64 &&
			keys.length === 1 &&
			keys[0]?.name === column &&
			keys[0]?.coll === "BINARY"
		)
			return;
	}
	access.fail("unsupported_schema", "A targeted foreign-key lookup lacks a supported unique index");
}
