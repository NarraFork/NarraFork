/**
 * SQLite implementation of `ProjectArchiveMainStore`, delegating to the current main `db`.
 *
 * This is the ONLY file in the archive port that knows the main database is SQLite, that it is
 * reached through Drizzle, or what its tables are called. Everything above it speaks the domain
 * contract in `main-store.ts`.
 *
 * THE ATOMIC SECTION IS STRICTLY SYNCHRONOUS, AND THAT IS NOT A STYLE CHOICE
 * -------------------------------------------------------------------------
 * `bun:sqlite` commits when the transaction callback RETURNS. An `async` callback returns at its
 * first `await`, so the COMMIT fires there and every statement after it runs in autocommit: not
 * rolled back on failure, and interleavable with another request's transaction on the shared
 * connection. `server/db/transaction-atomicity-contract.test.ts` demonstrates both failures and
 * gates the shape at authoring time.
 *
 * `importRows` is therefore `async` on the OUTSIDE — the caller only ever sees a Promise — while
 * the section between BEGIN and COMMIT contains no `await` at all. That is what replaced the
 * previous `sqlite.run("BEGIN TRANSACTION")` / `"COMMIT"` / `"ROLLBACK"` trio in
 * `project-import.ts`: raw statements on the shared handle, with no nesting protection and no
 * relationship to any other transaction that might already be open on it.
 *
 * WHY THE ROWS ARE READ THROUGH `sql` TEMPLATES RATHER THAN THE QUERY BUILDER
 * --------------------------------------------------------------------------
 * The archive addresses columns by NAME (`snapshot_shadow_key`), because that is what the
 * portable file stores. Drizzle's builder addresses them by TypeScript field
 * (`snapshotShadowKey`). Translating between the two is this file's job, and doing it through a
 * name→column map means one lookup table instead of a hand-maintained positional binding list
 * per table — the shape where "a future column reshuffle misaligns the bindings" was a real
 * hazard the old snapshot test had to pin.
 *
 * Every identifier that reaches SQL goes through `sql.identifier()` after being checked against
 * the manifest, so no caller-supplied string is ever concatenated into a statement.
 *
 * BOUNDS
 * ------
 * Reads are cursor-paged with a hard `MAX_PAGE_SIZE`, ordered by primary key. Writes are
 * per-row statements inside one transaction: measured at ~29µs/row, which is ample for a
 * user-triggered one-shot import, and it avoids multi-row `VALUES` entirely. Multi-row inserts
 * would have to chunk against `bun:sqlite`'s bind-parameter ceiling as a function of column
 * count, and overshooting it fails with a misleading "expected 3392 values, received 200000"
 * rather than a clean limit error.
 *
 * THE IMPORT IS TWO-PHASE, IN ONE TRANSACTION
 * -------------------------------------------
 * Phase 1 inserts every row with its forward-reference columns bound to NULL; phase 2
 * restores them after all batches have landed. `deferred-references.ts` states the
 * reference graph that requires it (self-references within a PK-ordered batch, and
 * references to tables that arrive LATER in the parent-first order) — a latent hazard
 * the pre-two-phase code answered with a foreign-key abort on real imports that had
 * forked chapters or narrators. The PostgreSQL main store uses the same two phases,
 * which is what makes the conflict policy's semantics identical across backends.
 */
import { db } from "@server/db";
import {
	chapterCommits,
	chapterEdges,
	chapters,
	explorationGroups,
	mergeSessions,
	narratorMessageRefs,
	narratorMessages,
	narratorPatches,
	narrators,
	narratorToolCalls,
	projects,
} from "@server/db/schema";
import { type Column, getTableColumns, getTableName, type SQL, sql, type Table } from "drizzle-orm";
/**
 * Flatten one main-database value to something the portable file can hold, and the
 * inverse. Both live in `value-mapping.ts` — dialect-free by construction, and
 * shared with the PostgreSQL main store, which must never load this module's SQLite
 * handle. The re-export below keeps the mapping's contract-test surface stable.
 */
import { forwardReferencesOf } from "./deferred-references";
import type {
	ArchiveBatch,
	ArchiveRow,
	ArchiveValue,
	ImportRowsRequest,
	ImportRowsResult,
	ProjectArchiveMainStore,
	ReadRowsPage,
	ReadRowsQuery,
} from "./main-store";
import { ARCHIVE_COLUMNS, type ArchiveTable, isArchiveTable } from "./manifest";
import { toArchiveValue, toMainValue } from "./value-mapping";

/** Transaction handle as produced by `db.transaction((tx) => …)`. SQLite-side only. */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Upper bound on rows per page, regardless of what a caller asks for.
 *
 * The point is that no single read can load an unbounded slice of `narrator_messages` (whose
 * `content_json` is one of the large columns the performance rules single out) into the heap.
 * A caller wanting more pages asks for more pages.
 */
const MAX_PAGE_SIZE = 500;

/** Archive table name → the Drizzle table backing it in the main database. */
const MAIN_TABLES: Readonly<Record<ArchiveTable, Table>> = {
	projects,
	exploration_groups: explorationGroups,
	chapters,
	chapter_edges: chapterEdges,
	narrators,
	narrator_messages: narratorMessages,
	narrator_message_refs: narratorMessageRefs,
	narrator_tool_calls: narratorToolCalls,
	narrator_patches: narratorPatches,
	chapter_commits: chapterCommits,
	merge_sessions: mergeSessions,
};

/**
 * Archive column name → main-database column, per table.
 *
 * Built from the live Drizzle metadata, so a renamed or dropped main column shows up as a
 * MISSING entry (the column is then simply not exported/imported) rather than as a statement
 * referencing a column that no longer exists.
 *
 * Restricted to the manifest: a main column the archive format does not define must not leak
 * into an archive just because both databases happen to have it. That is how `credential_id`
 * and the ACL columns stay out.
 */
const columnMapCache = new Map<ArchiveTable, ReadonlyMap<string, Column>>();

function columnMap(table: ArchiveTable): ReadonlyMap<string, Column> {
	const cached = columnMapCache.get(table);
	if (cached) return cached;
	const byName = new Map<string, Column>();
	for (const column of Object.values(getTableColumns(MAIN_TABLES[table]))) {
		byName.set(column.name, column as Column);
	}
	const mapped = new Map<string, Column>();
	for (const archiveColumn of ARCHIVE_COLUMNS[table]) {
		const column = byName.get(archiveColumn);
		if (column) mapped.set(archiveColumn, column);
	}
	columnMapCache.set(table, mapped);
	return mapped;
}

/** The primary-key column, used as the stable paging order. */
function primaryKeyColumn(table: ArchiveTable): Column {
	for (const column of Object.values(getTableColumns(MAIN_TABLES[table]))) {
		if ((column as Column).primary) return column as Column;
	}
	// Every archived table is keyed by a nanoid `id`; a table without one would make paging
	// unstable, which is worse than failing here.
	throw new Error(`Archive table "${table}" has no single-column primary key to page by`);
}

function requireArchiveTable(table: string): ArchiveTable {
	if (!isArchiveTable(table)) {
		throw new Error(`"${table}" is not a table of the portable project archive`);
	}
	return table;
}

/** `INSERT OR IGNORE INTO <table> (<cols>) VALUES (<binds>) RETURNING id` for one row. */
function insertStatement(
	table: ArchiveTable,
	columns: readonly Column[],
	values: readonly ArchiveValue[],
): SQL {
	const target = sql.identifier(getTableName(MAIN_TABLES[table]));
	const names = sql.join(
		columns.map((column) => sql.identifier(column.name)),
		sql`, `,
	);
	const binds = sql.join(
		values.map((value) => sql`${value}`),
		sql`, `,
	);
	// `INSERT OR IGNORE` is the pre-existing conflict policy, preserved exactly. Worth being
	// precise about what it does and does not swallow: it skips a row whose PRIMARY KEY or
	// UNIQUE constraint already matches, and it skips a NOT NULL violation — but it does NOT
	// skip a FOREIGN KEY failure, which throws and aborts the transaction. That is why the
	// caller applies tables parent-first, why a bad order surfaces as a failed import rather
	// than as quietly missing rows — and why the RETURNING clause matters: only a row that
	// was actually inserted may have its forward references restored in phase 2 (see
	// `deferred-references.ts`); a conflict-skipped row keeps the existing row's references.
	return sql`INSERT OR IGNORE INTO ${target} (${names}) VALUES (${binds}) RETURNING ${sql.identifier(
		primaryKeyColumn(table).name,
	)}`;
}

/** A reference restore deferred to phase 2 (see `deferred-references.ts`). */
interface PendingReferenceRestore {
	table: ArchiveTable;
	pkValue: unknown;
	columns: readonly Column[];
	values: readonly ArchiveValue[];
}

/**
 * Apply every batch. Strictly synchronous: no `await` may ever appear in here.
 *
 * Kept a named function rather than an inline closure precisely because that property has to be
 * checkable by reading one short function.
 *
 * Two phases, one transaction (see `deferred-references.ts` for the graph that
 * requires them): every row is inserted with its forward-reference columns bound to
 * NULL, then — after ALL batches have landed — the recorded references are restored
 * with one UPDATE per inserted row. A genuinely dangling reference still aborts the
 * whole import, from the restoring UPDATE rather than from the row's own INSERT.
 */
function importRowsAtomically(tx: DbTransaction, request: ImportRowsRequest): ImportRowsResult {
	const applied: Record<string, number> = {};
	const pending: PendingReferenceRestore[] = [];
	for (const batch of request.batches) {
		const table = requireArchiveTable(batch.table);
		const available = columnMap(table);
		const columns = batch.columns
			.map((name) => available.get(name))
			.filter((column): column is Column => column !== undefined);
		if (columns.length === 0 || batch.rows.length === 0) {
			applied[batch.table] = batch.rows.length;
			continue;
		}
		const forward = new Set(forwardReferencesOf(table, batch.columns));
		for (const row of batch.rows) {
			// Phase 1: forward references go in as NULL; the row's own values are
			// recorded for phase 2 only when the insert actually landed.
			const values = columns.map((column) =>
				forward.has(column.name) ? null : toMainValue(column, row[column.name] ?? null),
			);
			// Bun's Drizzle raw get() returns a POSITIONAL row (["id"]), not an object
			// keyed by column name — the RETURNING clause has exactly one column.
			const inserted = tx.get(insertStatement(table, columns, values)) as unknown[] | undefined;
			if (!inserted) continue;
			const deferredColumns = columns.filter((column) => forward.has(column.name));
			if (deferredColumns.length === 0) continue;
			pending.push({
				table,
				pkValue: inserted[0],
				columns: deferredColumns,
				values: deferredColumns.map((column) => toMainValue(column, row[column.name] ?? null)),
			});
		}
		applied[batch.table] = batch.rows.length;
	}
	for (const restore of pending) {
		// Phase 2: the target rows all exist now (every batch has landed), so the
		// immediate FK check on this UPDATE is the honest dangling-reference verdict.
		const assignments = sql.join(
			restore.columns.map((column, index) => {
				const value = restore.values[index] ?? null;
				return sql`${sql.identifier(column.name)} = ${value}`;
			}),
			sql`, `,
		);
		try {
			tx.run(
				sql`UPDATE ${sql.identifier(getTableName(MAIN_TABLES[restore.table]))} SET ${assignments} WHERE ${sql.identifier(
					primaryKeyColumn(restore.table).name,
				)} = ${restore.pkValue}`,
			);
		} catch (error) {
			// A foreign-key failure here means the archive references a row that is in
			// NO batch and not in the main database. Name the reference: "FK failed" alone
			// sends the user hunting through every table of their backup.
			throw new Error(
				`Archive row "${restore.table}.${String(restore.pkValue)}" references a missing row ` +
					`(${restore.columns.map((column) => column.name).join(", ")}); the archive is incomplete`,
				{ cause: error },
			);
		}
	}
	return { applied };
}

export const sqliteProjectArchiveMainStore: ProjectArchiveMainStore = {
	async supportedColumns(table: string): Promise<readonly string[]> {
		if (!isArchiveTable(table)) return [];
		return [...columnMap(table).keys()];
	},

	async readRows(query: ReadRowsQuery): Promise<ReadRowsPage> {
		const table = requireArchiveTable(query.table);
		const available = columnMap(table);
		const columns = [...available.values()];
		const key = primaryKeyColumn(table);
		const limit = Math.max(1, Math.min(query.limit, MAX_PAGE_SIZE));

		const conditions: SQL[] = [];
		if (query.filter) {
			const filterColumn = available.get(query.filter.column);
			if (!filterColumn) {
				throw new Error(
					`Cannot filter archive table "${table}" by "${query.filter.column}": ` +
						"the main database has no such archive column",
				);
			}
			// An empty value list means "nothing matches". Omitting the clause instead would
			// silently widen a scoped read into a full-table one.
			if (query.filter.values.length === 0) return { rows: [], nextCursor: null };
			conditions.push(
				sql`${sql.identifier(filterColumn.name)} IN (${sql.join(
					query.filter.values.map((value) => sql`${value}`),
					sql`, `,
				)})`,
			);
		}
		if (query.after != null) {
			conditions.push(sql`${sql.identifier(key.name)} > ${query.after}`);
		}

		const target = sql.identifier(getTableName(MAIN_TABLES[table]));
		const selection = sql.join(
			columns.map((column) => sql.identifier(column.name)),
			sql`, `,
		);
		const where =
			conditions.length > 0 ? sql` WHERE ${sql.join(conditions, sql` AND `)}` : sql.empty();
		// `limit + 1` rather than a preceding COUNT(*): one extra row answers "is there more?"
		// without a second scan.
		const statement = sql`SELECT ${selection} FROM ${target}${where} ORDER BY ${sql.identifier(
			key.name,
		)} ASC LIMIT ${limit + 1}`;

		const raw = db.all(statement) as Record<string, unknown>[];
		const hasMore = raw.length > limit;
		const page = hasMore ? raw.slice(0, limit) : raw;
		const rows: ArchiveRow[] = page.map((source) => {
			const row: Record<string, ArchiveValue> = {};
			for (const column of columns) row[column.name] = toArchiveValue(source[column.name]);
			return row;
		});
		const last = page.at(-1);
		const cursor = hasMore && last ? String(last[key.name]) : null;
		return { rows, nextCursor: cursor };
	},

	async importRows(request: ImportRowsRequest): Promise<ImportRowsResult> {
		// Validate before opening the transaction: a bad table name is a programming error, and
		// discovering it mid-transaction would mean rolling back work that was fine.
		for (const batch of request.batches) requireArchiveTable(batch.table);
		if (request.conflictPolicy !== "skip") {
			throw new Error(`Unsupported archive conflict policy: ${String(request.conflictPolicy)}`);
		}
		// No `await` inside — see the header. The `async` keyword here only shapes the return
		// value for the caller; the transaction has already committed (or rolled back) by the
		// time this Promise resolves.
		return db.transaction((tx) => importRowsAtomically(tx, request));
	},
};

/** Exported for the contract tests, which must exercise the batching without a main database. */
export const ARCHIVE_MAX_PAGE_SIZE = MAX_PAGE_SIZE;

/** Exported for tests: the value mapping is the part most likely to break silently. */
export const archiveValueMapping = { toArchiveValue, toMainValue } as const;

/** Batch shape helper for callers assembling an import from an archive file. */
export function archiveBatch(
	table: string,
	columns: readonly string[],
	rows: readonly ArchiveRow[],
): ArchiveBatch {
	return { table, columns, rows };
}
