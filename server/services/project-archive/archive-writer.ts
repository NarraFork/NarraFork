/**
 * Writing rows into a portable `project.db` archive. Permanently SQLite, by design.
 *
 * WHY THIS REPLACED TEN HAND-WRITTEN INSERT STATEMENTS
 * ---------------------------------------------------
 * The export used to spell out, per table, a positional `INSERT OR REPLACE INTO … VALUES (?, ?,
 * …)` with a matching array of Drizzle row fields — 36 placeholders for `narrator_messages`, 38
 * for `narrators`. Nothing checked that the two lists lined up. A column inserted in the middle
 * of one list and appended to the other type-checks, formats, and runs; it just stores every
 * subsequent value in the wrong column. `project-db-snapshot-columns.test.ts` had to assert an
 * unrelated `merge_commit_sha` was still null purely to catch that class of misalignment.
 *
 * Here the column list and the value list are derived from the same source — an `ArchiveRow`
 * keyed by column name — so they cannot disagree.
 *
 * WHY IT INTERSECTS WITH THE FILE'S ACTUAL COLUMNS
 * ------------------------------------------------
 * `initProjectDb` patches an existing archive up to the current schema on open, so in practice
 * the file has every column the manifest names. The intersection is what makes that a
 * non-assumption: an archive opened by a path that skipped patching, or one a future version
 * chooses not to patch, degrades to writing the columns it has instead of failing every INSERT.
 *
 * CONFLICT POLICY: `INSERT OR REPLACE`, WHICH IS THE EXPORT'S DIRECTION
 * --------------------------------------------------------------------
 * The main database is the source of truth for an export, so a row already in the archive is
 * overwritten. That is the pre-existing behavior and the opposite of the IMPORT's
 * `INSERT OR IGNORE` — deliberately, because there the archive is the source and the main
 * database's existing rows win. Two directions, two policies, neither one a default.
 *
 * STAGING, AND WHY A DELETE-THEN-INSERT NEEDS IT
 * ---------------------------------------------
 * A replacement scope ("these rows, and no others, are what the archive should hold") is a
 * DELETE plus every INSERT that refills it. Those have to commit together or a reader can catch
 * the table emptied — and a reader here is a user's other machine opening the file they copied.
 *
 * The main-database reads are PAGED, so the rows do not all exist at once, and a `bun:sqlite`
 * transaction cannot span the `await` between two pages: the driver commits when the callback
 * RETURNS, so an `async` callback commits at its first `await` (see
 * `server/db/transaction-atomicity-contract.test.ts`). That is the whole difficulty, and
 * {@link ArchiveStagingTable} is the way out: each page is appended to a TEMP table as it
 * arrives, and only once every page has been read successfully does one strictly synchronous
 * transaction run the DELETEs and load the staged rows into the real tables.
 *
 * Three properties make the temp table the right holding area rather than a JS array:
 *
 *   - it lives in the CONNECTION's temp database, never in `project.db`. It is absent from the
 *     file's `sqlite_master`, invisible to any other handle, and gone when the connection
 *     closes — so a crashed export cannot leave a stray table in a user's archive.
 *   - SQLite spills it to its own (anonymous, auto-deleted) temp file, so staging a large
 *     `narrator_messages` does not grow the JS heap. The predecessor of this code held every
 *     row of every table in `Array`s before writing any of them.
 *   - the load is `INSERT … SELECT`, one statement executed inside SQLite, so the rows never
 *     re-enter JS to be written a second time.
 *
 * The staged volume is still bounded on purpose ({@link ARCHIVE_STAGING_LIMITS}): the temp file
 * is real disk, and the honest failure for an archive too large to replace atomically is to
 * refuse and leave the previous contents intact.
 */
import type { Database } from "bun:sqlite";
import { logger } from "@server/lib/logger";
import type { ArchiveRow, ArchiveValue } from "./main-store";
import { ARCHIVE_COLUMNS, type ArchiveTable } from "./manifest";

/**
 * A prepared writer for one archive table.
 *
 * Holds a prepared statement, so writing N rows prepares once rather than N times. Bound to the
 * connection it was created from.
 */
export class ArchiveTableWriter {
	private readonly statement: ReturnType<Database["prepare"]>;

	constructor(
		conn: Database,
		readonly table: ArchiveTable,
		readonly columns: readonly string[],
	) {
		const names = columns.map(quoteIdentifier).join(", ");
		const binds = columns.map(() => "?").join(", ");
		this.statement = conn.prepare(
			`INSERT OR REPLACE INTO ${quoteIdentifier(table)} (${names}) VALUES (${binds})`,
		);
	}

	/**
	 * Write one row.
	 *
	 * A column absent from `row` is written as NULL rather than skipped: a positional statement
	 * has no way to omit a parameter, and `undefined` in a binding array is what silently shifts
	 * every value after it.
	 */
	write(row: ArchiveRow): void {
		const values = this.columns.map((column) => bindable(row[column]));
		this.statement.run(...values);
	}
}

/**
 * Prepare a writer for `table` against `conn`, narrowed to columns the file actually has.
 *
 * Returns null when the file has none of them — a table this archive does not carry, which the
 * caller skips rather than treating as an error.
 */
export function tableWriter(conn: Database, table: ArchiveTable): ArchiveTableWriter | null {
	const present = presentColumns(conn, table);
	const columns = ARCHIVE_COLUMNS[table].filter((column) => present.has(column));
	if (columns.length === 0) return null;
	return new ArchiveTableWriter(conn, table, columns);
}

/** Columns `table` has in this file, per its own `PRAGMA table_info`. */
export function presentColumns(conn: Database, table: string): ReadonlySet<string> {
	try {
		return new Set(
			(
				conn.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
					name: string;
				}>
			).map((column) => column.name),
		);
	} catch {
		// No such table. An archive predating a table is an ordinary shape, not a failure.
		return new Set();
	}
}

/**
 * Ceilings on what one replacement may stage before it gives up.
 *
 * Not a guess at what is "enough": the point is that staging writes to a real temp file and
 * `loadInto` runs one statement over everything staged, so an unbounded scope would trade an
 * unbounded temp file and an unbounded synchronous load for the atomicity it buys. Exceeding a
 * limit ABORTS the replacement, which leaves the archive's previous contents whole — the honest
 * outcome, and the reason these are limits rather than warnings.
 *
 * The row ceiling is the export's own page bound (500 × 20 000) expressed per replacement, so it
 * is unreachable by real data for the same reason. The byte ceiling exists because
 * `narrator_messages.content_json` has no natural size: 4 GiB of staged text is a project whose
 * archive cannot be replaced atomically on this machine, and saying so beats silently filling a
 * disk.
 */
export const ARCHIVE_STAGING_LIMITS = {
	maxRows: 10_000_000,
	maxBytes: 4 * 1024 * 1024 * 1024,
} as const;

/** Thrown when a replacement's staged volume exceeds {@link ARCHIVE_STAGING_LIMITS}. */
export class ArchiveStagingLimitError extends Error {
	constructor(
		readonly table: ArchiveTable,
		readonly limit: "rows" | "bytes",
		readonly staged: number,
		readonly ceiling: number,
	) {
		super(
			`Archive replacement of "${table}" exceeded its staging ${limit} limit ` +
				`(${staged} > ${ceiling})`,
		);
		this.name = "ArchiveStagingLimitError";
	}
}

/** Monotonic suffix so two staging tables on one connection cannot collide. */
let stagingSequence = 0;

/**
 * The staging table's own ordering column, declared `INTEGER PRIMARY KEY` so SQLite fills it in
 * insertion order.
 *
 * An explicit column rather than the implicit `rowid`: the load has to replay staging order (see
 * {@link ArchiveStagingTable.loadInto}), and naming the column keeps that ordering visible in the
 * statement instead of resting on a hidden one. The prefix cannot collide with an archive column —
 * every name in `ARCHIVE_COLUMNS` is a plain domain column, and a collision would fail loudly at
 * `CREATE TABLE` with a duplicate-column error rather than silently reorder anything.
 */
const STAGE_ORDER_COLUMN = "nf_stage_seq";

/**
 * A TEMP table holding the rows of one archive table until they can be loaded in one commit.
 *
 * Created in the connection's temp database (`temp.<name>`), so it is not part of the portable
 * file: absent from its `sqlite_master`, invisible to every other handle, and destroyed when the
 * connection closes. {@link drop} is still called on every path — success, failure and
 * cancellation — because a connection is pooled and long-lived, so leaving staged rows behind
 * would hold the temp file's disk for as long as the process runs.
 *
 * The columns are declared WITHOUT types on purpose. A staged value must reach the real table
 * exactly as the main database produced it; a declared affinity would convert it on the way in
 * (a TEXT `"42"` stored into an INTEGER column becomes the number 42), so the staging table
 * stores what it is given and the real table's own affinity applies once, during the load.
 */
export class ArchiveStagingTable {
	/**
	 * The temp table's own name, always addressed as `temp.<name>` in statements so it can never
	 * resolve to a main-database table of the same name.
	 */
	readonly name: string;

	private readonly insert: ReturnType<Database["prepare"]>;
	private dropped = false;
	private rows = 0;
	private bytes = 0;

	/**
	 * `limits` is a parameter only so a test can exercise the ceiling without staging gigabytes.
	 * Production never passes it — {@link stagingTable} is the only constructor call site there,
	 * and it takes the default.
	 */
	constructor(
		private readonly conn: Database,
		readonly table: ArchiveTable,
		readonly columns: readonly string[],
		private readonly limits: {
			readonly maxRows: number;
			readonly maxBytes: number;
		} = ARCHIVE_STAGING_LIMITS,
	) {
		stagingSequence += 1;
		this.name = `nf_archive_stage_${table}_${process.pid}_${stagingSequence}`;
		const names = columns.map(quoteIdentifier).join(", ");
		const binds = columns.map(() => "?").join(", ");
		// `IF NOT EXISTS` is not used: a name collision would silently append to someone else's
		// staged rows, and the sequence above is what makes the name unique.
		conn.run(
			`CREATE TEMP TABLE ${quoteIdentifier(this.name)} ` +
				`(${quoteIdentifier(STAGE_ORDER_COLUMN)} INTEGER PRIMARY KEY, ${names})`,
		);
		this.insert = conn.prepare(
			`INSERT INTO temp.${quoteIdentifier(this.name)} (${names}) VALUES (${binds})`,
		);
	}

	get stagedRows(): number {
		return this.rows;
	}

	get stagedBytes(): number {
		return this.bytes;
	}

	/**
	 * Stage one page. Strictly synchronous, and one transaction per page so the temp file's
	 * write-ahead work is batched rather than committed per row.
	 *
	 * Throws {@link ArchiveStagingLimitError} once the accumulated volume crosses a ceiling. The
	 * page that crossed it is not staged in full; the caller aborts the whole replacement, so
	 * partial staging is discarded rather than becoming visible.
	 */
	stage(rows: readonly ArchiveRow[], project?: (row: Record<string, ArchiveValue>) => void): void {
		if (rows.length === 0) return;
		this.assertUsable();
		const tx = this.conn.transaction(() => {
			for (const row of rows) {
				let source: ArchiveRow = row;
				if (project) {
					const projected: Record<string, ArchiveValue> = { ...row };
					project(projected);
					source = projected;
				}
				const values = this.columns.map((column) => bindable(source[column]));
				this.rows += 1;
				this.bytes += approximateBytes(values);
				if (this.rows > this.limits.maxRows) {
					throw new ArchiveStagingLimitError(this.table, "rows", this.rows, this.limits.maxRows);
				}
				if (this.bytes > this.limits.maxBytes) {
					throw new ArchiveStagingLimitError(this.table, "bytes", this.bytes, this.limits.maxBytes);
				}
				this.insert.run(...values);
			}
		});
		tx();
	}

	/**
	 * Load every staged row into the real table. Strictly synchronous, and the CALLER supplies
	 * the transaction — that is the whole point: the DELETEs of a replacement scope and this
	 * load have to be in one commit, and only the caller knows the full set.
	 *
	 * Ordering by {@link STAGE_ORDER_COLUMN} makes the load replay the staging order, so when two
	 * staged rows share a primary key the last one written wins — the same outcome as writing them
	 * straight through `INSERT OR REPLACE`. Without it, SQLite's chosen scan order would decide
	 * which duplicate survives.
	 */
	loadInto(): void {
		this.assertUsable();
		if (this.rows === 0) return;
		const names = this.columns.map(quoteIdentifier).join(", ");
		this.conn.run(
			`INSERT OR REPLACE INTO ${quoteIdentifier(this.table)} (${names}) ` +
				`SELECT ${names} FROM temp.${quoteIdentifier(this.name)} ` +
				`ORDER BY ${quoteIdentifier(STAGE_ORDER_COLUMN)}`,
		);
	}

	/**
	 * Discard the staging table. Idempotent, and safe to call from a `finally`.
	 *
	 * Never throws: it runs on the failure path of an export whose own error is the one worth
	 * reporting, and a temp table that outlives its connection is dropped by SQLite anyway.
	 */
	drop(): void {
		if (this.dropped) return;
		this.dropped = true;
		try {
			// Finalized first: an open statement against the table keeps SQLite from dropping it.
			this.insert.finalize();
		} catch {
			// Already finalized, or the connection is gone. Either way the DROP below is what
			// matters.
		}
		try {
			this.conn.run(`DROP TABLE IF EXISTS temp.${quoteIdentifier(this.name)}`);
		} catch (error) {
			logger.warn("Failed to drop archive staging table", {
				table: this.table,
				staging: this.name,
				error: String(error),
			});
		}
	}

	private assertUsable(): void {
		if (this.dropped) {
			throw new Error(`Archive staging table "${this.name}" was already dropped`);
		}
	}
}

/**
 * Open a staging table for `table`, narrowed to the columns the archive file actually has.
 *
 * Null means the file does not carry this table at all — the same answer {@link tableWriter}
 * gives, and the caller skips it the same way.
 */
export function stagingTable(conn: Database, table: ArchiveTable): ArchiveStagingTable | null {
	const present = presentColumns(conn, table);
	const columns = ARCHIVE_COLUMNS[table].filter((column) => present.has(column));
	if (columns.length === 0) return null;
	return new ArchiveStagingTable(conn, table, columns);
}

/**
 * Bytes one staged row costs, near enough to bound a temp file by.
 *
 * `Buffer.byteLength` on the strings (the only values whose size is unbounded — `content_json`
 * holds whole conversations) plus a flat 8 for each number/null. It is an estimate of SQLite's
 * on-disk record, not a measurement of it: exact accounting would mean asking SQLite after every
 * page, which is what the limit exists to avoid paying for.
 */
function approximateBytes(values: readonly (string | number | null)[]): number {
	let total = 0;
	for (const value of values) {
		total += typeof value === "string" ? Buffer.byteLength(value, "utf8") : 8;
	}
	return total;
}

/**
 * Coerce an archive value to something `bun:sqlite` will bind.
 *
 * `undefined` → null is the important case; the driver rejects `undefined` outright, and a
 * mapping that let it through would turn a missing optional field into a runtime error at
 * export time. Booleans are normalized to 0/1 so the archive's on-disk type is a property of the
 * format rather than of the driver's coercion.
 */
function bindable(value: ArchiveValue | undefined): string | number | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	return value;
}

function quoteIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}
