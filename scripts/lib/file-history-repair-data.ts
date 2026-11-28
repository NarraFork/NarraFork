import type { Database, SQLQueryBindings } from "bun:sqlite";
import {
	HISTORY_WRITABLE_TABLES,
	type HistorySchema,
	inspectHistorySchema,
	quoteHistoryIdentifier as quote,
	type SchemaAccess,
} from "./file-history-repair-data-schema";

export interface RepairIdentity {
	namespaceKey: string;
}
export interface RepairProgress {
	phase: string;
	table?: string;
	processedRows: number;
}
export interface RepairDataOptions {
	batchSize?: number;
	/** Total rows visited across all passes, not a LIMIT silently truncating maintenance. */
	maxRows?: number;
	/** Per state, checked inside SQLite before a JSON value is returned to JavaScript. */
	maxJsonBytes?: number;
	guard?: (phase: string) => void;
	onProgress?: (progress: RepairProgress) => void;
	beforeCommit?: () => void;
	afterCommit?: () => void;
	now?: () => number;
}
export type RepairCommitState = "not_committed" | "committed" | "unknown";
export class FileHistoryRepairDataError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly commitState: RepairCommitState = "not_committed",
	) {
		super(message);
		this.name = "FileHistoryRepairDataError";
	}
}
export interface RepairBudget {
	id: string;
	namespaceKey: string;
	status: string;
	usedBytes: number;
	reservedBytes: number;
	quotaBytes: number;
	generation: number;
	reconciledAt: string | null;
	updatedAt: string;
}
export type RepairCounts = Record<string, number>;
export interface RepairPreflight {
	schemaVersion: number;
	blobReferenceRoots: number;
	namespaceMatches: boolean;
	budget: RepairBudget;
	counts: RepairCounts;
	processedRows: number;
}
export interface RepairVerification extends RepairPreflight {
	verified: true;
}
export interface RepairResult {
	committed: true;
	verified: true;
	schemaVersion: number;
	blobReferenceRoots: number;
	beforeBudget: RepairBudget;
	afterBudget: RepairBudget;
	counts: RepairCounts;
	processedRows: number;
}

export const FILE_HISTORY_REPAIR_DATA_LIMITS = Object.freeze({
	batchSize: 128,
	maximumBatchSize: 512,
	maxRows: 10_000_000,
	maximumRows: 100_000_000,
	maxJsonBytes: 8192,
	maximumJsonBytes: 65536,
	maximumQueries: 2_000_000,
});
const LIMITS = FILE_HISTORY_REPAIR_DATA_LIMITS;
const BUDGET_ID = "file-change-blobs";
const EXPIRED_JSON = '{"kind":"unknown","reason":"expired"}';
const DIGEST = /^[a-f0-9]{64}$/;
const ATTRIBUTION = ["measured", "observed_ambiguous", "unknown"];
const COVERAGE = ["complete", "partial", "unavailable", "legacy_unknown"];
const REASONS = new Set([
	"legacy_unverified",
	"capture_failed",
	"history_unavailable",
	"capture_incomplete",
	"capture_concurrent",
	"missing_before",
	"missing_after",
	"unreadable",
	"unsupported_object",
	"unsupported_backend",
	"target_unverified",
	"result_unknown",
	"content_changed",
	"quota_exceeded",
	"budget_exceeded",
	"cancelled",
	"expired",
	"object_missing",
]);
const REVERT_SAFE = [
	"planned",
	"prepared",
	"committed",
	"partial",
	"failed",
	"compensated",
	"cancelled",
	"expired",
];
const REVERT_FILE_SAFE = [
	"prepared",
	"applied",
	"verified",
	"unchanged",
	"conflict",
	"failed",
	"not_attempted",
	"compensated",
	"unknown",
];
interface StateRoot {
	json: string;
	digest: string;
	nullable?: boolean;
	allowUnpinned?: boolean;
}
const STATE_ROOTS: Readonly<Record<string, readonly StateRoot[]>> = {
	file_change_effects: [
		{ json: "before_state_json", digest: "before_blob_digest" },
		{ json: "intended_after_state_json", digest: "intended_after_blob_digest" },
		{ json: "observed_after_state_json", digest: "observed_after_blob_digest" },
	],
	revert_operation_files: [
		{ json: "expected_state_json", digest: "before_blob_digest", allowUnpinned: true },
		{ json: "desired_state_json", digest: "desired_blob_digest", allowUnpinned: true },
		{
			json: "observed_after_state_json",
			digest: "observed_after_blob_digest",
			nullable: true,
			allowUnpinned: true,
		},
		{
			json: "compensation_after_state_json",
			digest: "compensation_after_blob_digest",
			nullable: true,
			allowUnpinned: true,
		},
	],
};
const SCAN_COLUMNS: Readonly<Record<string, string[]>> = {
	file_change_operations: [
		"id",
		"source_kind",
		"evidence_version",
		"execution_outcome",
		"effect_outcome",
		"settlement",
		"attribution_grade",
		"coverage",
		"unresolved_effect_count",
		"prepared_effect_count",
		"settled_effect_count",
		"expected_effect_count",
		"lease_until",
	],
	file_change_effects: [
		"id",
		"phase",
		"outcome",
		"settlement",
		"attribution_grade",
		"attribution_ceiling",
		"disk_outcome",
		"execution_confirmed",
	],
	revert_operation_files: ["id", "status"],
	snapshot_captures: ["id", "coverage", "temporal_consistency", "manifest_blob_digest", "reason"],
	revert_operations: [
		"id",
		"protocol_version",
		"kind",
		"scope",
		"selector_kind",
		"status",
		"selector_blob_digest",
		"plan_blob_digest",
		"history_manifest_blob_digest",
		"lease_until",
	],
	file_change_blob_reservations: [
		"id",
		"budget_id",
		"status",
		"generation",
		"expected_size",
		"blob_digest",
		"published",
		"settled_at",
	],
	file_change_blobs: ["id", "digest", "size_bytes", "status", "gc_generation"],
	file_change_scopes: [
		"id",
		"status",
		"path_flavor",
		"active_lease_id",
		"active_lease_epoch",
		"active_lease_started_at",
		"active_mutation_count",
	],
	workspace_write_leases: ["lease_id", "status", "execution_class", "path_flavor"],
	file_history_clock: ["id", "last_seq"],
};

type Row = Record<string, SQLQueryBindings> & { __rowid: number; __foreign_invalid: number };

/** Caller supplies an existing controlled connection. No database or filesystem is opened here. */
export function preflightFileHistoryRepair(
	db: Database,
	identity: RepairIdentity,
	options: RepairDataOptions = {},
): RepairPreflight {
	return readonlyOperation(db, identity, options, false);
}

export function verifyFileHistoryRepair(
	db: Database,
	identity: RepairIdentity,
	options: RepairDataOptions = {},
): RepairVerification {
	return { ...readonlyOperation(db, identity, options, true), verified: true };
}

function readonlyOperation(
	db: Database,
	identity: RepairIdentity,
	options: RepairDataOptions,
	verify: boolean,
): RepairPreflight {
	try {
		const meter = new RepairMeter(db, identity, options);
		meter.check(verify ? "verify_start" : "preflight_start");
		checkConnection(meter);
		const schema = inspectHistorySchema(db, meter);
		const result = inspectData(meter, schema, verify);
		meter.check(verify ? "verify_complete" : "preflight_complete");
		return result;
	} catch (error) {
		throw repairError(error, "not_committed");
	}
}

/**
 * Sole transaction owner. The CLI must establish offline exclusivity first; guard callbacks
 * revalidate that proof. A synchronous worker is required for hard statement cancellation.
 * Batches bound JS memory and each write; the entire change still commits atomically once.
 */
export function applyFileHistoryRepair(
	db: Database,
	identity: RepairIdentity,
	options: RepairDataOptions = {},
): RepairResult {
	let transactionStarted = false;
	let commitAttempted = false;
	let committed = false;
	try {
		const meter = new RepairMeter(db, identity, options);
		checkConnection(meter);
		meter.check("before_transaction");
		db.exec("BEGIN IMMEDIATE");
		transactionStarted = true;
		meter.check("after_transaction");
		const schema = inspectHistorySchema(db, meter);
		const before = inspectData(meter, schema, false);
		const now = timestamp(options.now?.() ?? Date.now());
		invalidateStateTable(meter, "file_change_effects");
		invalidateStateTable(meter, "revert_operation_files");
		mutateBatches(meter, "snapshot_captures", (first, last) => {
			meter.write(
				`UPDATE snapshot_captures SET manifest_blob_digest = NULL, coverage = 'unavailable', reason = 'expired'
				WHERE rowid >= ? AND rowid <= ?`,
				[first, last],
			);
		});
		mutateBatches(meter, "revert_operations", (first, last) => {
			meter.write(
				`UPDATE revert_operations SET selector_blob_digest = NULL, plan_blob_digest = NULL,
				history_manifest_blob_digest = NULL,
				reason = CASE WHEN status IN ('planned','prepared') THEN 'expired' ELSE reason END,
				updated_at = CASE WHEN status IN ('planned','prepared') THEN ? ELSE updated_at END,
				expires_at = CASE WHEN status IN ('planned','prepared') THEN ? ELSE expires_at END,
				status = CASE WHEN status IN ('planned','prepared') THEN 'expired' ELSE status END
				WHERE rowid >= ? AND rowid <= ?`,
				[now, now, first, last],
			);
		});
		// Certify every state and manifest root before allowing any catalog deletion.
		for (const table of [
			"file_change_effects",
			"revert_operation_files",
			"snapshot_captures",
			"revert_operations",
		])
			inspectTable(meter, schema, table, true);
		for (const table of ["file_change_blob_reservations", "file_change_blobs"])
			mutateBatches(meter, table, (first, last) => {
				meter.write(`DELETE FROM ${quote(table)} WHERE rowid >= ? AND rowid <= ?`, [first, last]);
			});
		meter.write(
			`UPDATE file_change_storage_budgets SET namespace_key = ?, status = 'ready',
			used_bytes = 0, reserved_bytes = 0, generation = ?, reconciled_at = ?, updated_at = ?
			WHERE id = ? AND generation = ? AND quota_bytes = ?`,
			[
				identity.namespaceKey,
				before.budget.generation + 1,
				now,
				now,
				BUDGET_ID,
				before.budget.generation,
				before.budget.quotaBytes,
			],
		);
		const prepared = inspectData(meter, schema, true);
		assertExpectedBudget(prepared.budget, before.budget, now);
		meter.check("before_commit");
		options.beforeCommit?.();
		assertSchemaVersion(meter, schema.version);
		commitAttempted = true;
		db.exec("COMMIT");
		committed = true;
		transactionStarted = false;
		meter.check("after_commit");
		options.afterCommit?.();
		// A post-commit error is never represented as a successful rollback.
		const after = inspectData(meter, schema, true);
		assertExpectedBudget(after.budget, before.budget, now);
		meter.check("apply_complete");
		return {
			committed: true,
			verified: true,
			schemaVersion: schema.version,
			blobReferenceRoots: schema.blobReferenceRoots,
			beforeBudget: before.budget,
			afterBudget: after.budget,
			counts: before.counts,
			processedRows: meter.processedRows,
		};
	} catch (error) {
		if (committed) throw repairError(error, "committed");
		if (transactionStarted && db.inTransaction) {
			try {
				db.exec("ROLLBACK");
			} catch {
				throw new FileHistoryRepairDataError(
					"rollback_failed",
					"Rollback could not be confirmed",
					"unknown",
				);
			}
			if (db.inTransaction)
				throw new FileHistoryRepairDataError(
					"rollback_failed",
					"Transaction is still open",
					"unknown",
				);
			throw repairError(error, "not_committed");
		}
		throw repairError(error, commitAttempted ? "unknown" : "not_committed");
	}
}

class RepairMeter implements SchemaAccess {
	readonly batchSize: number;
	readonly maxRows: number;
	readonly maxJsonBytes: number;
	processedRows = 0;
	private queries = 0;
	constructor(
		readonly db: Database,
		readonly identity: RepairIdentity,
		readonly options: RepairDataOptions,
	) {
		if (!identity || !DIGEST.test(identity.namespaceKey))
			this.fail("invalid_identity", "Invalid namespace key");
		this.batchSize = options.batchSize ?? LIMITS.batchSize;
		this.maxRows = options.maxRows ?? LIMITS.maxRows;
		this.maxJsonBytes = options.maxJsonBytes ?? LIMITS.maxJsonBytes;
		boundedInteger(this.batchSize, 1, LIMITS.maximumBatchSize);
		boundedInteger(this.maxRows, 1, LIMITS.maximumRows);
		boundedInteger(this.maxJsonBytes, 64, LIMITS.maximumJsonBytes);
	}
	fail(code: string, message: string): never {
		throw new FileHistoryRepairDataError(code, message);
	}
	check(phase: string): void {
		this.options.guard?.(phase);
	}
	read<T>(sql: string, bindings: SQLQueryBindings[] = []): T[] {
		this.queryBudget();
		return this.db.query<T, SQLQueryBindings[]>(sql).all(...bindings);
	}
	write(sql: string, bindings: SQLQueryBindings[] = []): void {
		const table = /^(?:UPDATE\s+|DELETE\s+FROM\s+)["`]?([a-z_]+)/i.exec(sql)?.[1];
		if (!table || !HISTORY_WRITABLE_TABLES.some((name) => name === table))
			this.fail("write_scope", "Write outside the history maintenance whitelist");
		this.queryBudget();
		this.db.query(sql).run(...bindings);
	}
	rows(count: number, table: string, phase: string): void {
		this.processedRows += count;
		if (this.processedRows > this.maxRows)
			this.fail("row_budget_exceeded", "History row budget exceeded");
		this.options.onProgress?.({ phase, table, processedRows: this.processedRows });
	}
	private queryBudget(): void {
		this.check("sql");
		if (++this.queries > LIMITS.maximumQueries)
			this.fail("query_budget_exceeded", "History query budget exceeded");
	}
}

function checkConnection(meter: RepairMeter): void {
	if (meter.db.inTransaction)
		meter.fail("transaction_owned", "A root connection without a transaction is required");
	const fk = meter.read<{ foreign_keys: number }>("PRAGMA foreign_keys")[0]?.foreign_keys;
	const timeout = meter.read<{ timeout: number }>("PRAGMA busy_timeout")[0]?.timeout;
	const sync = meter.read<{ synchronous: number }>("PRAGMA synchronous")[0]?.synchronous;
	const journal = meter.read<{ journal_mode: string }>("PRAGMA journal_mode")[0]?.journal_mode;
	const writableSchema = meter.read<{ writable_schema: number }>("PRAGMA writable_schema")[0]
		?.writable_schema;
	if (
		fk !== 1 ||
		timeout === undefined ||
		timeout < 0 ||
		timeout > 250 ||
		sync === undefined ||
		sync < 1 ||
		sync > 3 ||
		!journal ||
		!["wal", "delete", "truncate", "persist"].includes(journal) ||
		writableSchema !== 0
	)
		meter.fail("unsafe_connection", "Foreign keys and normal transaction durability are required");
}

function inspectData(meter: RepairMeter, schema: HistorySchema, verify: boolean): RepairPreflight {
	assertSchemaVersion(meter, schema.version);
	const budget = readBudget(meter, !verify);
	if (verify) {
		if (
			budget.namespaceKey !== meter.identity.namespaceKey ||
			budget.status !== "ready" ||
			budget.usedBytes !== 0 ||
			budget.reservedBytes !== 0 ||
			budget.generation < 1 ||
			!budget.reconciledAt ||
			budget.reconciledAt !== budget.updatedAt
		)
			meter.fail("verification_failed", "Namespace budget is not in the repaired state");
	}
	const counts: RepairCounts = {};
	for (const table of Object.keys(SCAN_COLUMNS)) {
		counts[table] = inspectTable(meter, schema, table, verify);
		if (
			verify &&
			["file_change_blobs", "file_change_blob_reservations"].includes(table) &&
			counts[table] !== 0
		)
			meter.fail("verification_failed", "Old catalog metadata remains");
	}
	assertSchemaVersion(meter, schema.version);
	return {
		schemaVersion: schema.version,
		blobReferenceRoots: schema.blobReferenceRoots,
		namespaceMatches: budget.namespaceKey === meter.identity.namespaceKey,
		budget,
		counts,
		processedRows: meter.processedRows,
	};
}

function readBudget(meter: RepairMeter, requireIncrement: boolean): RepairBudget {
	const textField = (column: string, alias: string) =>
		`CASE WHEN typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) <= 256 THEN ${column} ELSE NULL END AS ${alias}`;
	const numberField = (column: string, alias: string) =>
		`CASE WHEN typeof(${column}) = 'integer' THEN ${column} ELSE NULL END AS ${alias}`;
	const rows = meter.read<RepairBudget & { __metadata_invalid: number }>(
		`SELECT ${textField("id", "id")}, ${textField("namespace_key", "namespaceKey")},
		${textField("status", "status")}, ${numberField("used_bytes", "usedBytes")},
		${numberField("reserved_bytes", "reservedBytes")}, ${numberField("quota_bytes", "quotaBytes")},
		${numberField("generation", "generation")},
		${textField("reconciled_at", "reconciledAt")}, ${textField("updated_at", "updatedAt")},
		CASE WHEN typeof(reconciled_at) NOT IN ('null','text') OR length(CAST(reconciled_at AS BLOB)) > 256
		THEN 1 ELSE 0 END AS __metadata_invalid
		FROM file_change_storage_budgets LIMIT 2`,
	);
	if (rows.length !== 1 || rows[0]?.id !== BUDGET_ID)
		meter.fail("budget_cardinality", "Exactly one supported namespace budget is required");
	const result = rows[0];
	if (!result) meter.fail("budget_cardinality", "Missing namespace budget");
	const { __metadata_invalid, ...row } = result;
	if (__metadata_invalid !== 0) meter.fail("invalid_budget", "Unsupported budget scalar metadata");
	if (typeof row.namespaceKey !== "string" || !DIGEST.test(row.namespaceKey))
		meter.fail("invalid_budget", "Unknown budget namespace identity");
	oneOf(row.status, ["unverified", "reconciling", "ready"]);
	for (const value of [row.usedBytes, row.reservedBytes, row.quotaBytes, row.generation])
		boundedInteger(value, 0, Number.MAX_SAFE_INTEGER);
	if (requireIncrement && row.generation === Number.MAX_SAFE_INTEGER)
		meter.fail("generation_overflow", "Budget generation cannot be incremented safely");
	if (
		typeof row.updatedAt !== "string" ||
		row.updatedAt.length > 64 ||
		(row.reconciledAt !== null &&
			(typeof row.reconciledAt !== "string" || row.reconciledAt.length > 64))
	)
		meter.fail("invalid_budget", "Unknown budget time representation");
	return row;
}

function inspectTable(
	meter: RepairMeter,
	schema: HistorySchema,
	table: string,
	verify: boolean,
): number {
	const roots = STATE_ROOTS[table] ?? [];
	const fields = [...(SCAN_COLUMNS[table] ?? [])];
	for (const root of roots) fields.push(root.digest);
	const select = fields.map(
		(column) =>
			`CASE WHEN typeof(${quote(column)}) IN ('integer','real','null') OR (typeof(${quote(column)}) = 'text' AND length(CAST(${quote(column)} AS BLOB)) <= 256)
		THEN ${quote(column)} ELSE NULL END AS ${quote(column)}`,
	);
	select.push(
		`CASE WHEN ${fields
			.map(
				(column) =>
					`(typeof(${quote(column)}) NOT IN ('integer','real','text','null') OR (typeof(${quote(column)}) = 'text' AND length(CAST(${quote(column)} AS BLOB)) > 256))`,
			)
			.join(" OR ")} THEN 1 ELSE 0 END AS __scalar_invalid`,
	);
	for (const root of roots) {
		select.push(`length(CAST(${quote(root.json)} AS BLOB)) AS ${quote(`${root.json}_bytes`)}`);
		select.push(`CASE WHEN length(CAST(${quote(root.json)} AS BLOB)) <= ${meter.maxJsonBytes}
		THEN ${quote(root.json)} ELSE NULL END AS ${quote(root.json)}`);
	}
	const foreignInvalid = (schema.foreignKeys[table] ?? []).map(
		(fk) =>
			`(${quote(table)}.${quote(fk.from)} IS NOT NULL AND NOT EXISTS
		(SELECT 1 FROM ${quote(fk.table)} AS parent WHERE parent.${quote(fk.to)} = ${quote(table)}.${quote(fk.from)}))`,
	);
	select.push(
		`CASE WHEN ${foreignInvalid.join(" OR ") || "0"} THEN 1 ELSE 0 END AS __foreign_invalid`,
	);
	let count = 0;
	let cursor: number | null = null;
	while (true) {
		meter.check("read_batch");
		const rows: Row[] = meter.read<Row>(
			`SELECT rowid AS __rowid, ${select.join(",")} FROM ${quote(table)}
			${cursor === null ? "" : "WHERE rowid > ?"} ORDER BY rowid LIMIT ?`,
			cursor === null ? [meter.batchSize] : [cursor, meter.batchSize],
		);
		if (rows.length === 0) break;
		meter.rows(rows.length, table, verify ? "verify" : "preflight");
		for (const row of rows) {
			if (!Number.isSafeInteger(row.__rowid))
				meter.fail("unsupported_rowid", "History rowid exceeds safe bounds");
			if (row.__foreign_invalid !== 0)
				meter.fail("foreign_key_violation", "History foreign-key target is missing");
			if (row.__scalar_invalid !== 0)
				meter.fail("invalid_history", "History scalar exceeds supported metadata bounds");
			validateRow(table, row, verify);
			for (const root of roots) validateState(meter, row, root, verify);
		}
		count += rows.length;
		cursor = rows[rows.length - 1]?.__rowid ?? null;
		if (rows.length < meter.batchSize) break;
	}
	return count;
}

function validateRow(table: string, row: Row, verify: boolean): void {
	if (table !== "file_history_clock") {
		const id = table === "workspace_write_leases" ? row.lease_id : row.id;
		if (typeof id !== "string" || id.length === 0 || id.length > 256)
			throw new FileHistoryRepairDataError("invalid_history", "Invalid history identity");
	}
	switch (table) {
		case "file_change_operations":
			oneOf(row.source_kind, [
				"tool",
				"editor",
				"background_task",
				"external",
				"git",
				"revert",
				"import",
			]);
			oneOf(row.evidence_version, [2, 3]);
			oneOf(row.execution_outcome, ["succeeded", "failed", "interrupted"]);
			oneOf(row.effect_outcome, ["no_change", "changed", "unknown"]);
			oneOf(row.settlement, ["settled"]);
			oneOf(row.attribution_grade, ATTRIBUTION);
			oneOf(row.coverage, COVERAGE);
			if (row.unresolved_effect_count !== 0 || row.lease_until !== null)
				throw new FileHistoryRepairDataError("unsettled_history", "Unsettled file operation");
			for (const value of [row.prepared_effect_count, row.settled_effect_count])
				boundedInteger(value, 0, Number.MAX_SAFE_INTEGER);
			if (row.expected_effect_count !== null)
				boundedInteger(row.expected_effect_count, 0, Number.MAX_SAFE_INTEGER);
			break;
		case "file_change_effects":
			oneOf(row.phase, ["apply", "compensate"]);
			oneOf(row.outcome, ["no_change", "changed", "unknown"]);
			oneOf(row.settlement, ["settled"]);
			oneOf(row.attribution_grade, ATTRIBUTION);
			oneOf(row.attribution_ceiling, [...ATTRIBUTION, null]);
			oneOf(row.disk_outcome, ["applied", "not_applied", "unknown", null]);
			oneOf(row.execution_confirmed, [0, 1]);
			break;
		case "revert_operations":
			oneOf(row.protocol_version, [2, 3]);
			oneOf(row.kind, [
				"revert",
				"unrevert",
				"history_delete",
				"rollback_to_block",
				"edit_regenerate",
			]);
			oneOf(row.scope, ["narrator", "workspace"]);
			oneOf(row.selector_kind, ["all", "from_seq", "messages", "tool_calls", "after_block"]);
			oneOf(
				row.status,
				verify
					? REVERT_SAFE.filter((status) => status !== "planned" && status !== "prepared")
					: REVERT_SAFE,
			);
			if (row.lease_until !== null)
				throw new FileHistoryRepairDataError(
					"unsettled_history",
					"Revert retains an execution lease",
				);
			for (const column of [
				"selector_blob_digest",
				"plan_blob_digest",
				"history_manifest_blob_digest",
			])
				validateDigest(row[column], verify);
			break;
		case "revert_operation_files":
			oneOf(row.status, REVERT_FILE_SAFE);
			break;
		case "snapshot_captures":
			oneOf(row.coverage, verify ? ["unavailable"] : COVERAGE);
			oneOf(row.temporal_consistency, ["platform_quiescent", "concurrent_observation", "unknown"]);
			if (row.reason !== null && (typeof row.reason !== "string" || !REASONS.has(row.reason)))
				throw new FileHistoryRepairDataError("unknown_business_state", "Unknown capture reason");
			if (verify && row.reason !== "expired")
				throw new FileHistoryRepairDataError(
					"verification_failed",
					"Capture maintenance reason is missing",
				);
			validateDigest(row.manifest_blob_digest, verify);
			break;
		case "file_change_blob_reservations":
			oneOf(row.status, ["settled"]);
			if (row.budget_id !== BUDGET_ID || typeof row.settled_at !== "string")
				throw new FileHistoryRepairDataError("unsettled_history", "Reservation is not settled");
			oneOf(row.published, [null, 0, 1]);
			boundedInteger(row.generation, 0, Number.MAX_SAFE_INTEGER);
			boundedInteger(row.expected_size, 0, Number.MAX_SAFE_INTEGER);
			validateDigest(row.blob_digest, false);
			break;
		case "file_change_blobs":
			oneOf(row.status, ["ready", "expired", "missing"]);
			if (typeof row.digest !== "string" || !DIGEST.test(row.digest))
				throw new FileHistoryRepairDataError("invalid_history", "Invalid catalog digest");
			boundedInteger(row.size_bytes, 0, Number.MAX_SAFE_INTEGER);
			boundedInteger(row.gc_generation, 0, Number.MAX_SAFE_INTEGER);
			break;
		case "file_change_scopes":
			oneOf(row.status, ["active", "retired", "needs_verification"]);
			oneOf(row.path_flavor, ["posix", "windows"]);
			if (
				row.active_mutation_count !== 0 ||
				row.active_lease_id !== null ||
				row.active_lease_epoch !== null ||
				row.active_lease_started_at !== null
			)
				throw new FileHistoryRepairDataError(
					"unsettled_history",
					"Scope has an active execution barrier",
				);
			break;
		case "workspace_write_leases":
			oneOf(row.status, ["settled", "recovered"]);
			oneOf(row.execution_class, ["local_file_io", "unknown"]);
			oneOf(row.path_flavor, ["posix", "windows"]);
			break;
		case "file_history_clock":
			boundedInteger(row.id, 1, 1);
			boundedInteger(row.last_seq, 0, Number.MAX_SAFE_INTEGER);
			break;
	}
}

function validateState(meter: RepairMeter, row: Row, root: StateRoot, verify: boolean): void {
	const json = row[root.json];
	const bytes = row[`${root.json}_bytes`];
	const digest = row[root.digest];
	if (json === null && bytes === null && root.nullable && digest === null) return;
	if (typeof bytes !== "number" || bytes > meter.maxJsonBytes || typeof json !== "string")
		meter.fail("invalid_state", "State JSON is missing or exceeds the metadata budget");
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		meter.fail("invalid_state", "Malformed file history state JSON");
	}
	if (!plainObject(value)) meter.fail("invalid_state", "Unknown file state representation");
	const state = value;
	validateDigest(digest, verify);
	if (verify) {
		if (
			state.kind !== "unknown" ||
			state.reason !== "expired" ||
			!keysExactly(state, ["kind", "reason"])
		)
			meter.fail("verification_failed", "A retained history state is not expired");
		return;
	}
	switch (state.kind) {
		case "absent":
			if (!keysExactly(state, ["kind"]) || digest !== null)
				meter.fail("invalid_state", "Absent state has a blob reference");
			return;
		case "unknown":
			if (
				!keysExactly(state, ["kind", "reason"]) ||
				typeof state.reason !== "string" ||
				!REASONS.has(state.reason) ||
				digest !== null
			)
				meter.fail("invalid_state", "Unknown state has unsupported metadata");
			return;
		case "regular":
		case "symlink": {
			const field = state.kind === "regular" ? "blob" : "target";
			const ref = state[field];
			if (
				!keysExactly(state, ["kind", field, "mode"]) ||
				!plainObject(ref) ||
				!keysExactly(ref, ["algorithm", "digest", "sizeBytes"]) ||
				ref.algorithm !== "sha256" ||
				typeof ref.digest !== "string" ||
				!DIGEST.test(ref.digest) ||
				(ref.digest !== digest && !(root.allowUnpinned && digest === null))
			)
				meter.fail("invalid_state", "Typed state and reverse digest disagree");
			boundedInteger(ref.sizeBytes, 0, Number.MAX_SAFE_INTEGER);
			if (state.mode !== null) boundedInteger(state.mode, 0, 0o177777);
			return;
		}
		default:
			meter.fail("invalid_state", "Unknown file state kind");
	}
}

function invalidateStateTable(meter: RepairMeter, table: string): void {
	const roots = STATE_ROOTS[table] ?? [];
	const sets: string[] = [];
	const bindings: SQLQueryBindings[] = [];
	for (const root of roots) {
		sets.push(
			`${quote(root.json)} = ${root.nullable ? `CASE WHEN ${quote(root.json)} IS NULL THEN NULL ELSE ? END` : "?"}`,
		);
		bindings.push(EXPIRED_JSON);
		sets.push(`${quote(root.digest)} = NULL`);
	}
	mutateBatches(meter, table, (first, last) => {
		meter.write(`UPDATE ${quote(table)} SET ${sets.join(",")} WHERE rowid >= ? AND rowid <= ?`, [
			...bindings,
			first,
			last,
		]);
	});
}

function mutateBatches(
	meter: RepairMeter,
	table: string,
	write: (first: number, last: number) => void,
): void {
	let cursor: number | null = null;
	while (true) {
		meter.check("write_batch");
		const rows: { __rowid: number }[] = meter.read<{ __rowid: number }>(
			`SELECT rowid AS __rowid FROM ${quote(table)} ${cursor === null ? "" : "WHERE rowid > ?"} ORDER BY rowid LIMIT ?`,
			cursor === null ? [meter.batchSize] : [cursor, meter.batchSize],
		);
		if (rows.length === 0) return;
		meter.rows(rows.length, table, "apply");
		const first = rows[0]?.__rowid;
		const last = rows[rows.length - 1]?.__rowid;
		if (
			first === undefined ||
			last === undefined ||
			!Number.isSafeInteger(first) ||
			!Number.isSafeInteger(last)
		)
			meter.fail("unsupported_rowid", "History rowid exceeds safe bounds");
		write(first, last);
		cursor = last;
		if (rows.length < meter.batchSize) return;
	}
}

function validateDigest(value: SQLQueryBindings | undefined, empty: boolean): void {
	if (value === null) return;
	if (empty || typeof value !== "string" || !DIGEST.test(value))
		throw new FileHistoryRepairDataError(
			empty ? "verification_failed" : "invalid_history",
			"Unsupported history digest reference",
		);
}
function oneOf(value: unknown, allowed: readonly unknown[]): void {
	if (!allowed.includes(value))
		throw new FileHistoryRepairDataError(
			"unknown_business_state",
			"Unknown or unsettled history state",
		);
}
function boundedInteger(value: unknown, minimum: number, maximum: number): asserts value is number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	)
		throw new FileHistoryRepairDataError(
			"invalid_number",
			"Metadata number is outside supported bounds",
		);
}
function plainObject(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}
function keysExactly(value: Record<string, unknown>, keys: string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function assertSchemaVersion(meter: RepairMeter, version: number): void {
	const current = meter.read<{ schema_version: number }>("PRAGMA schema_version")[0]
		?.schema_version;
	if (current !== version)
		meter.fail("schema_changed", "Schema changed during history maintenance");
}
function assertExpectedBudget(after: RepairBudget, before: RepairBudget, now: string): void {
	if (
		after.generation !== before.generation + 1 ||
		after.quotaBytes !== before.quotaBytes ||
		after.reconciledAt !== now
	)
		throw new FileHistoryRepairDataError(
			"verification_failed",
			"Budget generation, quota or reconciliation changed unexpectedly",
		);
}
function timestamp(value: number): string {
	boundedInteger(value, 0, 8_640_000_000_000_000);
	return new Date(value).toISOString();
}
function repairError(error: unknown, commitState: RepairCommitState): FileHistoryRepairDataError {
	if (error instanceof FileHistoryRepairDataError)
		return new FileHistoryRepairDataError(error.code, error.message, commitState);
	return new FileHistoryRepairDataError(
		"maintenance_interrupted",
		"Maintenance failed; retain the report and verify before starting",
		commitState,
	);
}
