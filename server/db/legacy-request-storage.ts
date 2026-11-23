import type { Database } from "bun:sqlite";

/**
 * Physical half of migration 0207 (`drop_legacy_request_dumps`), split by cost.
 *
 * The repair tables and partial indexes are cheap to drop: no table rewrite. The three
 * `api_requests` column drops rewrite every row, which copies any retained multi-GB request
 * dump. So those column drops wait until no dump is retained. An admin clears dumps in small
 * batches from the storage settings page; the next startup then finishes the schema.
 */

/** Receipt prefix for an exact 0207 whose column drops were deferred behind retained dumps. */
export const LEGACY_REQUEST_RETIREMENT_RECEIPT_PREFIX = "narrafork:0207-logical-retirement:v1:";

const LEGACY_REQUEST_TABLES = ["usage_token_repair_candidates", "usage_token_repair_jobs"];
const LEGACY_REQUEST_INDEXES = [
	"idx_api_requests_token_repair_pending",
	"idx_api_requests_token_repair_reviewed",
];
const LEGACY_REQUEST_COLUMNS = [
	"token_accounting_version",
	"token_accounting_review_version",
	"raw_dump_json",
];

function objectExists(sqlite: Database, type: "table" | "index", name: string): boolean {
	return (
		sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) !=
		null
	);
}

function apiRequestColumns(sqlite: Database): Set<string> {
	if (!objectExists(sqlite, "table", "api_requests")) return new Set();
	const rows = sqlite.prepare("PRAGMA table_info(api_requests)").all() as Array<{ name: string }>;
	return new Set(rows.map((row) => row.name.toLowerCase()));
}

/**
 * The legacy columns still to drop. A later migration may add a legacy name back for the
 * current schema (0226 re-adds `token_accounting_version` with its own partial index), so a
 * column that a non-legacy index still uses belongs to the current schema and is kept.
 */
function droppableLegacyColumns(sqlite: Database): string[] {
	const columns = apiRequestColumns(sqlite);
	const present = LEGACY_REQUEST_COLUMNS.filter((column) => columns.has(column));
	if (present.length === 0) return present;
	const liveIndexSql = (
		sqlite
			.prepare(
				"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'api_requests' AND sql IS NOT NULL",
			)
			.all() as Array<{ name: string; sql: string }>
	)
		.filter((index) => !LEGACY_REQUEST_INDEXES.includes(index.name))
		.map((index) => index.sql.toLowerCase());
	return present.filter(
		(column) =>
			!liveIndexSql.some((sql) => new RegExp(`(^|[^a-z0-9_])${column}([^a-z0-9_]|$)`).test(sql)),
	);
}

/**
 * Whether any request dump is still stored. Stops at the first non-null row and reads only the
 * record header, never the payload itself.
 */
export function hasRetainedLegacyRequestDump(sqlite: Database): boolean {
	if (!apiRequestColumns(sqlite).has("raw_dump_json")) return false;
	return (
		sqlite.prepare("SELECT 1 FROM api_requests WHERE raw_dump_json IS NOT NULL LIMIT 1").get() !=
		null
	);
}

/** Whether any part of 0207's physical cleanup is still outstanding. Catalog reads only. */
export function hasPendingLegacyRequestRetirement(sqlite: Database): boolean {
	return (
		droppableLegacyColumns(sqlite).length > 0 ||
		LEGACY_REQUEST_TABLES.some((table) => objectExists(sqlite, "table", table)) ||
		LEGACY_REQUEST_INDEXES.some((index) => objectExists(sqlite, "index", index))
	);
}

/**
 * Idempotently apply as much of 0207 as is cheap now. Returns true when its full schema is in
 * effect. The caller owns the transaction and must have foreign keys disabled, as for 0207.
 */
export function retireLegacyRequestStorage(sqlite: Database): boolean {
	for (const table of LEGACY_REQUEST_TABLES) {
		if (objectExists(sqlite, "table", table)) sqlite.run(`DROP TABLE \`${table}\``);
	}
	for (const index of LEGACY_REQUEST_INDEXES) {
		if (objectExists(sqlite, "index", index)) sqlite.run(`DROP INDEX \`${index}\``);
	}
	const columns = droppableLegacyColumns(sqlite);
	if (columns.length === 0) return true;
	if (hasRetainedLegacyRequestDump(sqlite)) return false;
	for (const column of columns) {
		sqlite.run(`ALTER TABLE \`api_requests\` DROP COLUMN \`${column}\``);
	}
	return true;
}

/**
 * Finish a deferred 0207 at startup once the dumps are gone. Without retained dumps the column
 * drops cost the same as 0207 on a database that never stored dumps.
 */
export function completeDeferredLegacyRequestRetirement(sqlite: Database): boolean {
	if (!objectExists(sqlite, "table", "__drizzle_migrations")) return false;
	const deferred = sqlite
		.prepare("SELECT 1 FROM __drizzle_migrations WHERE hash LIKE ? LIMIT 1")
		.get(`${LEGACY_REQUEST_RETIREMENT_RECEIPT_PREFIX}%`);
	if (!deferred || !hasPendingLegacyRequestRetirement(sqlite)) return false;
	const foreignKeys = sqlite.prepare("PRAGMA foreign_keys").get() as {
		foreign_keys: number | bigint;
	} | null;
	const foreignKeysWereEnabled = Number(foreignKeys?.foreign_keys ?? 0) === 1;
	if (foreignKeysWereEnabled) sqlite.run("PRAGMA foreign_keys = OFF");
	try {
		return sqlite.transaction(() => retireLegacyRequestStorage(sqlite))();
	} finally {
		if (foreignKeysWereEnabled) sqlite.run("PRAGMA foreign_keys = ON");
	}
}

/**
 * Clear one batch of retained dumps after `afterRowid`. Returns null when none remain. Batches
 * are rowid-ordered so the whole pass reads each row header once.
 */
export function clearLegacyRequestDumpBatch(
	sqlite: Database,
	afterRowid: number,
	limit: number,
): { lastRowid: number; cleared: number } | null {
	if (!apiRequestColumns(sqlite).has("raw_dump_json")) return null;
	const rows = sqlite
		.prepare(
			`SELECT rowid AS rowid FROM api_requests
			 WHERE rowid > ? AND raw_dump_json IS NOT NULL
			 ORDER BY rowid LIMIT ?`,
		)
		.all(afterRowid, limit) as Array<{ rowid: number }>;
	if (rows.length === 0) return null;
	const lastRowid = Number(rows[rows.length - 1].rowid);
	const result = sqlite
		.prepare(
			`UPDATE api_requests SET raw_dump_json = NULL
			 WHERE rowid > ? AND rowid <= ? AND raw_dump_json IS NOT NULL`,
		)
		.run(afterRowid, lastRowid);
	return { lastRowid, cleared: Number(result.changes) };
}
