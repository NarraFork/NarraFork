/**
 * Pure SQLite storage-scan queries.
 *
 * ## Why this module exists separately
 *
 * The storage settings page scan is a whole-database read that takes seconds (measured: ~4.9s over
 * 116 tables on a 5.3 GB database). `bun:sqlite` is synchronous, so running it on the main thread
 * freezes HTTP, WebSocket, and every agent session for that entire duration. The fix is to run it
 * in a Worker — but a Worker may only import code that does NOT touch `server/db/index.ts`.
 *
 * Importing `server/db/index.ts` from a Worker re-evaluates the whole DB bootstrap inside the same
 * process (verified experimentally): it opens a second READ-WRITE connection, re-runs
 * migrations/backfills/`ensureFts`, registers a second WAL-checkpoint timer and exit handler, and —
 * worst of all — calls `consumeCleanShutdownState`, which CLEARS the clean-shutdown marker. That
 * silently makes the next startup believe it crashed. `acquireInstanceLock` does not catch this
 * because the pid matches, so it "reuses" the lock without complaining.
 *
 * Therefore every function here takes an explicit `Database` handle and this module imports nothing
 * but types. The same code then runs unchanged on the main thread (with the shared read-write
 * connection) and inside a Worker (with its own read-only connection).
 *
 * A test asserts the Worker's bundled module graph never reaches `server/db/index.ts`; do not add
 * imports here that would break that.
 */

import type { Database } from "bun:sqlite";

// ── Category taxonomy ──────────────────────────────────────────────────────

export const DATABASE_STORAGE_CATEGORY_KEYS = [
	"sessions",
	"apiRequests",
	"projects",
	"runtime",
	"users",
	"search",
	"gateway",
	"benchmarks",
	"internal",
	"free",
	"other",
] as const;

export type DatabaseStorageCategoryKey = (typeof DATABASE_STORAGE_CATEGORY_KEYS)[number];

export type DatabaseTableKind = "table" | "virtual" | "shadow" | "internal";

const SEARCH_TABLE_PREFIXES = ["chapters_fts", "narrator_messages_fts", "narrators_fts"];

export interface DatabaseStorageCategorySummary {
	key: DatabaseStorageCategoryKey;
	tableCount: number;
	rowCount: number;
	approxContentBytes: number;
	diskBytes: number;
	indexBytes: number;
	totalBytes: number;
}

export interface DatabaseStorageTableSummary {
	name: string;
	category: DatabaseStorageCategoryKey;
	kind: DatabaseTableKind;
	rowCount: number | null;
	approxContentBytes: number;
	diskBytes: number;
	indexBytes: number;
	totalBytes: number;
	/**
	 * True when a measurement query failed (typically SQLITE_BUSY against a writer holding an
	 * exclusive lock, e.g. VACUUM). Zeroes on such a row mean "unknown", NOT "empty" — see
	 * {@link measureTable}.
	 */
	readFailed?: boolean;
}

/** Tables whose measurement failed, so the report can be flagged as incomplete. */
export interface DatabaseStorageReadFailures {
	tableCount: number;
	/** Bounded sample of failing table names; `tableCount` is the true total. */
	tableNames: string[];
}

export interface DatabaseObjectStorageResult {
	pageSize: number;
	pageCount: number;
	freelistBytes: number;
	objectBytes: number;
	scanMode: "dbstat" | "approximate";
	categories: DatabaseStorageCategorySummary[];
	topTables: DatabaseStorageTableSummary[];
	readFailures: DatabaseStorageReadFailures;
}

/** How many tables appear in `topTables`. */
const TOP_TABLE_LIMIT = 12;
/** How many failing table names are reported; the count is always exact. */
const READ_FAILURE_NAME_LIMIT = 20;

interface SqliteTableListRow {
	schema?: string;
	name: string;
	type: string;
}

interface SqliteIndexRow {
	name: string;
	tableName: string;
}

interface SqliteTableColumnRow {
	name: string;
	hidden?: number | string | bigint;
}

// ── Primitives ─────────────────────────────────────────────────────────────

export function numberFromRow(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "string") return Number(value) || 0;
	return 0;
}

export function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

export function readPragmaNumber(sqlite: Database, name: string): number {
	try {
		const row = sqlite.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
		return numberFromRow(row?.[name]);
	} catch {
		return 0;
	}
}

export function sumBytesQuery(sqlite: Database, expression: string, fromClause: string): number {
	const row = sqlite
		.prepare(`SELECT COALESCE(SUM(${expression}), 0) AS bytes ${fromClause}`)
		.get() as { bytes: number | string | bigint };
	return numberFromRow(row?.bytes);
}

export function countQuery(sqlite: Database, fromClause: string): number {
	const row = sqlite.prepare(`SELECT COUNT(*) AS count ${fromClause}`).get() as {
		count: number | string | bigint;
	};
	return numberFromRow(row?.count);
}

export function tableExists(sqlite: Database, tableName: string): boolean {
	const row = sqlite
		.prepare("SELECT 1 FROM sqlite_schema WHERE name = ? AND type IN ('table', 'view') LIMIT 1")
		.get(tableName);
	return Boolean(row);
}

function isSearchTableName(tableName: string): boolean {
	return SEARCH_TABLE_PREFIXES.some(
		(prefix) => tableName === prefix || tableName.startsWith(`${prefix}_`),
	);
}

export function getDatabaseStorageCategory(tableName: string): DatabaseStorageCategoryKey {
	if (tableName.startsWith("sqlite_")) return "internal";
	if (isSearchTableName(tableName)) return "search";
	if (
		[
			"narrators",
			"narrator_messages",
			"narrator_message_refs",
			"narrator_tool_calls",
			"narrator_buffered_messages",
			"narrator_file_snapshots",
			"narrator_patches",
			"narrator_whitelist_dirs",
			"narrator_blacklist_dirs",
			"narrator_whitelist_cmds",
			"narrator_blacklist_cmds",
			"background_tasks",
		].includes(tableName)
	) {
		return "sessions";
	}
	if (tableName === "api_requests") return "apiRequests";
	if (
		[
			"projects",
			"exploration_groups",
			"chapters",
			"chapter_edges",
			"chapter_commits",
			"merge_sessions",
			"review_conclusions",
		].includes(tableName)
	) {
		return "projects";
	}
	if (
		[
			"terminals",
			"terminal_view_state",
			"container_instances",
			"port_allocations",
			"volume_snapshots",
			"volume_snapshot_applications",
		].includes(tableName)
	) {
		return "runtime";
	}
	if (
		["users", "user_preferences", "user_favorite_directories", "workspaces", "hooks"].includes(
			tableName,
		)
	) {
		return "users";
	}
	if (tableName === "gateway_session_mappings") return "gateway";
	if (["benchmark_suites", "benchmark_runs", "benchmark_task_results"].includes(tableName)) {
		return "benchmarks";
	}
	return "other";
}

function normalizeTableKind(type: string): DatabaseTableKind {
	if (type === "virtual" || type === "shadow") return type;
	return type === "internal" ? "internal" : "table";
}

// ── Schema introspection ───────────────────────────────────────────────────

export interface ScanTableRef {
	name: string;
	kind: DatabaseTableKind;
}

/**
 * List user tables in deterministic (`localeCompare`) order.
 *
 * The stable order matters: table statistics are sharded across workers, and the merge step
 * re-sorts by this same order so category totals and `topTables` never depend on which shard
 * finished first.
 */
export function loadSqliteTables(sqlite: Database): ScanTableRef[] {
	try {
		const rows = sqlite.prepare("PRAGMA table_list").all() as SqliteTableListRow[];
		return rows
			.filter((row) => (row.schema ?? "main") === "main")
			.filter((row) => ["table", "virtual", "shadow"].includes(row.type))
			.filter((row) => !row.name.startsWith("sqlite_"))
			.map((row) => ({ name: row.name, kind: normalizeTableKind(row.type) }))
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		const rows = sqlite
			.prepare(
				"SELECT name, type FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
			)
			.all() as SqliteTableListRow[];
		return rows
			.map((row) => ({ name: row.name, kind: normalizeTableKind(row.type) }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}
}

export function loadSqliteIndexes(sqlite: Database): SqliteIndexRow[] {
	return sqlite
		.prepare("SELECT name, tbl_name AS tableName FROM sqlite_schema WHERE type = 'index'")
		.all() as SqliteIndexRow[];
}

export function buildIndexesByTable(indexes: SqliteIndexRow[]): Map<string, string[]> {
	const indexesByTable = new Map<string, string[]>();
	for (const index of indexes) {
		const names = indexesByTable.get(index.tableName) ?? [];
		names.push(index.name);
		indexesByTable.set(index.tableName, names);
	}
	return indexesByTable;
}

export interface DbstatObjectBytes {
	supported: boolean;
	bytesByName: Map<string, number>;
}

/**
 * Per-object byte sizes from the `dbstat` virtual table.
 *
 * NOTE: dbstat is a COMPILE-TIME option, so availability is a property of the SQLite build and must
 * be probed, never assumed. It is compiled into Bun 1.4.2's bundled SQLite (verified by querying
 * it), and was absent from earlier builds — which is why both branches below are live: `supported:
 * false` sends the scan down the `approximate` mode (a `SUM(length(...))` scan per table) for older
 * runtimes and custom builds. The approximate path is strictly a fallback, not an equivalent, and
 * `scanMode` in the report is what tells a reader which one produced the numbers.
 */
export function loadDbstatObjectBytes(sqlite: Database): DbstatObjectBytes {
	const readRows = (sql: string): Map<string, number> => {
		const rows = sqlite.prepare(sql).all() as Array<{
			name: string;
			bytes: number | string | bigint;
		}>;
		return new Map(rows.map((row) => [row.name, numberFromRow(row.bytes)]));
	};
	try {
		return {
			supported: true,
			bytesByName: readRows(
				"SELECT name, COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE schema = 'main' GROUP BY name",
			),
		};
	} catch {
		try {
			return {
				supported: true,
				bytesByName: readRows(
					"SELECT name, COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat GROUP BY name",
				),
			};
		} catch {
			return { supported: false, bytesByName: new Map() };
		}
	}
}

// ── Per-table measurement ──────────────────────────────────────────────────

/**
 * Column names cache, keyed by `Database` handle so a Worker's connection never reads sizes
 * cached from a different connection (schemas can differ across processes/runs).
 */
const tableColumnCache = new WeakMap<Database, Map<string, string[]>>();

export function getTableValueColumnNames(sqlite: Database, tableName: string): string[] {
	let perDb = tableColumnCache.get(sqlite);
	if (!perDb) {
		perDb = new Map();
		tableColumnCache.set(sqlite, perDb);
	}
	const cached = perDb.get(tableName);
	if (cached) return cached;
	try {
		const rows = sqlite
			.prepare(`PRAGMA table_xinfo(${quoteIdentifier(tableName)})`)
			.all() as SqliteTableColumnRow[];
		const columns = rows
			.filter((row) => numberFromRow(row.hidden) === 0)
			.map((row) => row.name)
			.filter(Boolean);
		perDb.set(tableName, columns);
		return columns;
	} catch {
		perDb.set(tableName, []);
		return [];
	}
}

/**
 * Page/freelist facts only: three pragmas, no table data.
 *
 * Callers that just need `freelistBytes` must use this instead of a full object scan — reading every
 * table only to keep one number is both slow and, during maintenance, an extra source of lock
 * contention with the writer.
 */
export function readFreelistSummary(
	sqlite: Database,
	mainBytes: number,
): { pageSize: number; pageCount: number; freelistBytes: number } {
	const pageSize = readPragmaNumber(sqlite, "page_size");
	const pageCount = readPragmaNumber(sqlite, "page_count");
	const rawFreelistBytes = pageSize * readPragmaNumber(sqlite, "freelist_count");
	return {
		pageSize,
		pageCount,
		// Same clamping as aggregateObjectStorage, so both paths report the same freelist size.
		freelistBytes: Math.min(rawFreelistBytes, Math.max(mainBytes, pageSize * pageCount)),
	};
}

export function buildApproxBytesExpression(
	sqlite: Database,
	tableName: string,
	alias: string,
): string {
	const columns = getTableValueColumnNames(sqlite, tableName);
	if (columns.length === 0) return "0";
	return columns
		.map((column) => `length(CAST(coalesce(${alias}.${quoteIdentifier(column)}, '') AS BLOB))`)
		.join(" + ");
}

export function sumTableApproxBytes(
	sqlite: Database,
	tableName: string,
	alias: string,
	fromClause: string,
): number {
	return sumBytesQuery(sqlite, buildApproxBytesExpression(sqlite, tableName, alias), fromClause);
}

// ── BUSY handling ──────────────────────────────────────────────────────────

/**
 * Retry schedule for lock contention, in milliseconds between attempts.
 *
 * Why this exists: read workers open their connection with `PRAGMA busy_timeout = 250` so they never
 * park a thread inside SQLite's busy handler. That makes a concurrent exclusive writer (VACUUM takes
 * the write lock for its whole duration) surface as SQLITE_BUSY after 250ms. Swallowing that error
 * used to produce a report where every table looked empty.
 *
 * Two retries with a short backoff cover the common case (a checkpoint or a brief write burst) while
 * keeping the worst case bounded: 3 attempts x 250ms busy_timeout + 160ms of sleeping < 1s per
 * failed query, and a genuinely long VACUUM still ends as an honest "could not read" instead of a
 * fabricated zero.
 */
const BUSY_RETRY_DELAYS_MS = [40, 120];
/** Total sleep budget shared by all retries inside one `measureTable` call. */
const BUSY_RETRY_SLEEP_BUDGET_MS = 200;

/** Sleep synchronously. These queries are synchronous, so there is nothing to await. */
function sleepSyncMs(ms: number): void {
	if (ms <= 0) return;
	const bun = (globalThis as { Bun?: { sleepSync?: (ms: number) => void } }).Bun;
	if (typeof bun?.sleepSync === "function") {
		bun.sleepSync(ms);
		return;
	}
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		// No blocking primitive available; skip the backoff rather than spin.
	}
}

/** Lock contention, as opposed to a schema/permission problem that retrying cannot fix. */
export function isSqliteBusyError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const code = (error as { code?: unknown } | null)?.code;
	const codeText = typeof code === "string" ? code : "";
	return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(
		`${codeText} ${message}`,
	);
}

/** Sleep budget tracker, so one table cannot spend the whole scan retrying. */
interface BusyRetryBudget {
	remainingMs: number;
}

function createBusyRetryBudget(): BusyRetryBudget {
	return { remainingMs: BUSY_RETRY_SLEEP_BUDGET_MS };
}

/**
 * Run a read, retrying only on lock contention. Returns `{ ok: false }` instead of throwing so
 * callers can record "unknown" rather than inventing a zero.
 */
function readWithBusyRetry<T>(
	read: () => T,
	budget: BusyRetryBudget,
): { ok: true; value: T } | { ok: false; error: unknown } {
	let lastError: unknown;
	for (let attempt = 0; ; attempt += 1) {
		try {
			return { ok: true, value: read() };
		} catch (err) {
			lastError = err;
			const delay = BUSY_RETRY_DELAYS_MS[attempt];
			if (delay === undefined || !isSqliteBusyError(err) || budget.remainingMs <= 0) {
				return { ok: false, error: lastError };
			}
			const slept = Math.min(delay, budget.remainingMs);
			budget.remainingMs -= slept;
			sleepSyncMs(slept);
		}
	}
}

/**
 * Measure ONE table. This is the shard unit for parallel scanning: a single table's row count and
 * byte total are never split across workers, so no partial aggregate ever has to be merged.
 *
 * A failed read is reported as `readFailed: true` with zeroed numbers. Callers MUST treat that as
 * "unknown", never as "empty": collapsing a BUSY error into zero used to render a syntactically
 * perfect storage report in which the whole database appeared to weigh nothing.
 */
export function measureTable(
	sqlite: Database,
	table: ScanTableRef,
	context: { dbstat: DbstatObjectBytes; indexesByTable: Map<string, string[]> },
): DatabaseStorageTableSummary {
	const { dbstat, indexesByTable } = context;
	const budget = createBusyRetryBudget();
	const counted = readWithBusyRetry(
		() => countQuery(sqlite, `FROM ${quoteIdentifier(table.name)}`),
		budget,
	);
	// dbstat already gives exact page-level object sizes, so skip the extra SUM(length(...))
	// full-table scan in that mode. Virtual tables are measured through their shadow tables.
	const skipContentScan = dbstat.supported || table.kind === "virtual";
	const measured = skipContentScan
		? ({ ok: true, value: 0 } as const)
		: readWithBusyRetry(
				() => sumTableApproxBytes(sqlite, table.name, "t", `FROM ${quoteIdentifier(table.name)} t`),
				budget,
			);

	const readFailed = !counted.ok || !measured.ok;
	const rowCount = counted.ok ? counted.value : null;
	const approxContentBytes = measured.ok ? measured.value : 0;
	const indexNames = indexesByTable.get(table.name) ?? [];
	const diskBytes = dbstat.supported
		? (dbstat.bytesByName.get(table.name) ?? 0)
		: approxContentBytes;
	const indexBytes = dbstat.supported
		? indexNames.reduce((sum, indexName) => sum + (dbstat.bytesByName.get(indexName) ?? 0), 0)
		: 0;
	return {
		name: table.name,
		category: getDatabaseStorageCategory(table.name),
		kind: table.kind,
		rowCount,
		approxContentBytes,
		diskBytes,
		indexBytes,
		totalBytes: diskBytes + indexBytes,
		...(readFailed ? { readFailed: true } : {}),
	};
}

// ── Aggregation ────────────────────────────────────────────────────────────

export interface AggregateObjectStorageInput {
	mainBytes: number;
	pageSize: number;
	pageCount: number;
	rawFreelistBytes: number;
	dbstatSupported: boolean;
	/** Object name → bytes, from dbstat. Empty in approximate mode. */
	dbstatBytesByName: Map<string, number>;
	indexesByTable: Map<string, string[]>;
	/** Per-table results. Re-sorted by name here, so shard completion order cannot leak in. */
	tableSummaries: DatabaseStorageTableSummary[];
}

/**
 * Combine per-table measurements into the category/topTables shape the settings page renders.
 *
 * Determinism: `tableSummaries` is re-sorted by table name before any accumulation, so the result
 * is byte-for-byte identical whether the tables were measured serially on the main thread or
 * sharded across workers that finished out of order. All sums are integers, so no float drift.
 */
export function aggregateObjectStorage(
	input: AggregateObjectStorageInput,
): DatabaseObjectStorageResult {
	const {
		mainBytes,
		pageSize,
		pageCount,
		rawFreelistBytes,
		dbstatSupported,
		dbstatBytesByName,
		indexesByTable,
	} = input;
	const freelistBytes = Math.min(rawFreelistBytes, Math.max(mainBytes, pageSize * pageCount));

	const tableSummaries = [...input.tableSummaries].sort((a, b) => a.name.localeCompare(b.name));

	const usedObjectNames = new Set<string>();
	for (const table of tableSummaries) {
		usedObjectNames.add(table.name);
		for (const indexName of indexesByTable.get(table.name) ?? []) {
			usedObjectNames.add(indexName);
		}
	}

	const categoryMap = new Map<DatabaseStorageCategoryKey, DatabaseStorageCategorySummary>();
	const ensureCategory = (key: DatabaseStorageCategoryKey): DatabaseStorageCategorySummary => {
		const existing = categoryMap.get(key);
		if (existing) return existing;
		const created: DatabaseStorageCategorySummary = {
			key,
			tableCount: 0,
			rowCount: 0,
			approxContentBytes: 0,
			diskBytes: 0,
			indexBytes: 0,
			totalBytes: 0,
		};
		categoryMap.set(key, created);
		return created;
	};
	for (const table of tableSummaries) {
		const category = ensureCategory(table.category);
		category.tableCount += 1;
		category.rowCount += table.rowCount ?? 0;
		category.approxContentBytes += table.approxContentBytes;
		category.diskBytes += table.diskBytes;
		category.indexBytes += table.indexBytes;
		category.totalBytes += table.totalBytes;
	}

	let objectBytes = tableSummaries.reduce((sum, table) => sum + table.totalBytes, 0);
	if (dbstatSupported) {
		let internalBytes = 0;
		for (const [objectName, bytes] of dbstatBytesByName) {
			if (usedObjectNames.has(objectName)) continue;
			internalBytes += bytes;
		}
		if (internalBytes > 0) {
			const internal = ensureCategory("internal");
			internal.diskBytes += internalBytes;
			internal.totalBytes += internalBytes;
			objectBytes += internalBytes;
		}
	}

	if (freelistBytes > 0) {
		const free = ensureCategory("free");
		free.diskBytes += freelistBytes;
		free.totalBytes += freelistBytes;
	}

	const categories = DATABASE_STORAGE_CATEGORY_KEYS.map((key) => categoryMap.get(key))
		.filter((category): category is DatabaseStorageCategorySummary => Boolean(category))
		.filter((category) => category.totalBytes > 0 || category.tableCount > 0);
	// Total ordering (bytes desc, then name) keeps the slice stable when sizes tie.
	const topTables = tableSummaries
		.filter((table) => table.totalBytes > 0 || table.approxContentBytes > 0 || table.readFailed)
		.sort((a, b) => b.totalBytes - a.totalBytes || a.name.localeCompare(b.name))
		.slice(0, TOP_TABLE_LIMIT);

	// Tables whose measurement failed are reported explicitly: their zeroes are unknowns, so the UI
	// must be able to say "this report is incomplete" instead of presenting it as a clean result.
	const failedTables = tableSummaries
		.filter((table) => table.readFailed)
		.map((table) => table.name);

	return {
		pageSize,
		pageCount,
		freelistBytes,
		objectBytes,
		scanMode: dbstatSupported ? "dbstat" : "approximate",
		categories,
		topTables,
		readFailures: {
			tableCount: failedTables.length,
			tableNames: failedTables.slice(0, READ_FAILURE_NAME_LIMIT),
		},
	};
}

// ── Session cleanup byte estimation ────────────────────────────────────────

/** One table owned by a narrator, used to size what a session cleanup would delete. */
export interface SessionOwnedTableRelation {
	tableName: string;
	alias: string;
	narratorColumn: string;
	countAs?: "toolCalls" | "apiRequests";
}

export interface SessionAggregateStats {
	narrators: number;
	messages: number;
	toolCalls: number;
	apiRequests: number;
	dumpsCleared: number;
	approxBytes: number;
}

const EMPTY_SESSION_AGGREGATE_STATS: SessionAggregateStats = {
	narrators: 0,
	messages: 0,
	toolCalls: 0,
	apiRequests: 0,
	dumpsCleared: 0,
	approxBytes: 0,
};

/** Bind the target narrator ids as a JSON array so `json_each` can expand them inside SQL. */
function targetIdsParam(narratorIds: string[]): string {
	// Deduplicate to match the old TEMP table, whose `id TEXT PRIMARY KEY` collapsed repeats.
	return JSON.stringify([...new Set(narratorIds)]);
}

/** COUNT and SUM(length(...)) in ONE pass, instead of scanning the same rows twice. */
function countAndSumTableBytes(
	sqlite: Database,
	tableName: string,
	alias: string,
	fromClause: string,
	params: string[],
): { count: number; bytes: number } {
	const expression = buildApproxBytesExpression(sqlite, tableName, alias);
	const row = sqlite
		.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(${expression}), 0) AS bytes ${fromClause}`)
		.get(...params) as { count: unknown; bytes: unknown } | undefined;
	return { count: numberFromRow(row?.count), bytes: numberFromRow(row?.bytes) };
}

/**
 * Size what deleting the given narrators would free.
 *
 * Pure SQL by design. The previous implementation materialised EVERY candidate `narrator_messages`
 * id into a JS array with an unbounded `.all()` and then re-inserted them into a TEMP table row by
 * row — forbidden on the main thread, and unbounded in the number of sessions being cleaned. The
 * message count and byte total are now a single aggregate with a correlated `NOT EXISTS`, which
 * returns exactly the same numbers: `narrator_messages.id` is a primary key, so the old
 * id-list join contributed each message exactly once.
 *
 * The narrator id list itself is bounded by the caller's cleanup plan, which is already in memory.
 */
export function collectSessionAggregateStats(
	sqlite: Database,
	narratorIds: string[],
	relations: SessionOwnedTableRelation[],
): SessionAggregateStats {
	if (narratorIds.length === 0) return { ...EMPTY_SESSION_AGGREGATE_STATS };
	const targetIds = targetIdsParam(narratorIds);
	const targetSelect = "SELECT value FROM json_each(?)";

	const narratorRows = countAndSumTableBytes(
		sqlite,
		"narrators",
		"n",
		`FROM narrators n WHERE n.id IN (${targetSelect})`,
		[targetIds],
	);
	let approxBytes = narratorRows.bytes;
	let toolCalls = 0;
	let apiRequests = 0;

	for (const relation of relations) {
		if (!tableExists(sqlite, relation.tableName)) continue;
		const column = quoteIdentifier(relation.narratorColumn);
		const { count, bytes } = countAndSumTableBytes(
			sqlite,
			relation.tableName,
			relation.alias,
			`FROM ${quoteIdentifier(relation.tableName)} ${relation.alias}
			 WHERE ${relation.alias}.${column} IN (${targetSelect})`,
			[targetIds],
		);
		approxBytes += bytes;
		if (relation.countAs === "toolCalls") toolCalls += count;
		else if (relation.countAs === "apiRequests") apiRequests += count;
	}

	let dumpsCleared = 0;
	if (tableExists(sqlite, "api_requests")) {
		dumpsCleared = numberFromRow(
			(
				sqlite
					.prepare(
						`SELECT COUNT(*) AS count
						 FROM api_requests ar
						 WHERE ar.narrator_id IN (${targetSelect}) AND ar.raw_dump_json IS NOT NULL`,
					)
					.get(targetIds) as { count: unknown } | undefined
			)?.count,
		);
	}

	if (tableExists(sqlite, "background_tasks")) {
		approxBytes += countAndSumTableBytes(
			sqlite,
			"background_tasks",
			"bt",
			`FROM background_tasks bt
			 WHERE bt.parent_narrator_id IN (${targetSelect})
				OR bt.subagent_narrator_id IN (${targetSelect})`,
			[targetIds, targetIds],
		).bytes;
	}

	let messages = 0;
	if (tableExists(sqlite, "narrator_messages")) {
		// A message survives if any narrator OUTSIDE the target set still references it, so only
		// exclusively-owned messages are counted — same predicate as before, evaluated in SQL.
		const refsExist = tableExists(sqlite, "narrator_message_refs");
		const survivorClause = refsExist
			? `AND NOT EXISTS (
					SELECT 1 FROM narrator_message_refs r
					WHERE r.message_id = m.id AND r.narrator_id NOT IN (${targetSelect})
				 )`
			: "";
		const params = refsExist ? [targetIds, targetIds] : [targetIds];
		const result = countAndSumTableBytes(
			sqlite,
			"narrator_messages",
			"m",
			`FROM narrator_messages m
			 WHERE m.narrator_id IN (${targetSelect}) ${survivorClause}`,
			params,
		);
		messages = result.count;
		approxBytes += result.bytes;
	}

	return {
		narrators: narratorRows.count,
		messages,
		toolCalls,
		apiRequests,
		dumpsCleared,
		approxBytes,
	};
}

// ── Whole-database object scan ─────────────────────────────────────────────

export interface ScanObjectStorageOptions {
	/** Restrict measurement to these tables (a worker shard). Omit to measure all of them. */
	tableNames?: string[];
	/** Called after each table is measured, for scan progress reporting. */
	onTableMeasured?: (tableName: string, index: number, total: number) => void;
}

/**
 * Collect the schema-level facts a scan needs. Cheap: pragmas plus two schema queries, no
 * table data is read.
 */
export function loadScanContext(sqlite: Database): {
	pageSize: number;
	pageCount: number;
	rawFreelistBytes: number;
	tables: ScanTableRef[];
	indexesByTable: Map<string, string[]>;
	dbstat: DbstatObjectBytes;
} {
	const pageSize = readPragmaNumber(sqlite, "page_size");
	const pageCount = readPragmaNumber(sqlite, "page_count");
	const rawFreelistBytes = pageSize * readPragmaNumber(sqlite, "freelist_count");
	return {
		pageSize,
		pageCount,
		rawFreelistBytes,
		tables: loadSqliteTables(sqlite),
		indexesByTable: buildIndexesByTable(loadSqliteIndexes(sqlite)),
		dbstat: loadDbstatObjectBytes(sqlite),
	};
}

/** Measure the requested tables (default: all) without aggregating. */
export function measureTables(
	sqlite: Database,
	options: ScanObjectStorageOptions = {},
): DatabaseStorageTableSummary[] {
	const context = loadScanContext(sqlite);
	const wanted = options.tableNames ? new Set(options.tableNames) : null;
	const tables = wanted ? context.tables.filter((table) => wanted.has(table.name)) : context.tables;
	return tables.map((table, index) => {
		const summary = measureTable(sqlite, table, context);
		options.onTableMeasured?.(table.name, index + 1, tables.length);
		return summary;
	});
}

/**
 * Full single-connection object-storage scan.
 *
 * This is the serial reference implementation: it is what the main-thread fallback runs, and what
 * the parallel worker path must match field-for-field.
 */
export function scanDatabaseObjectStorage(
	sqlite: Database,
	mainBytes: number,
	options: ScanObjectStorageOptions = {},
): DatabaseObjectStorageResult {
	const context = loadScanContext(sqlite);
	const wanted = options.tableNames ? new Set(options.tableNames) : null;
	const tables = wanted ? context.tables.filter((table) => wanted.has(table.name)) : context.tables;
	const tableSummaries = tables.map((table, index) => {
		const summary = measureTable(sqlite, table, context);
		options.onTableMeasured?.(table.name, index + 1, tables.length);
		return summary;
	});
	return aggregateObjectStorage({
		mainBytes,
		pageSize: context.pageSize,
		pageCount: context.pageCount,
		rawFreelistBytes: context.rawFreelistBytes,
		dbstatSupported: context.dbstat.supported,
		dbstatBytesByName: context.dbstat.bytesByName,
		indexesByTable: context.indexesByTable,
		tableSummaries,
	});
}
