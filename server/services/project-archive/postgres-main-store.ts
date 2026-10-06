/**
 * PostgreSQL implementation of `ProjectArchiveMainStore`.
 *
 * Same capability as `sqlite-main-store.ts`, different engine — and deliberately not
 * the same code: what the two implementations share is the port (`main-store.ts`),
 * the manifest, the forward-reference graph (`deferred-references.ts`), the value
 * mapping (`value-mapping.ts`) and the SECTION CONTENT. Everything dialect-shaped
 * lives here: the PG schema, genuinely async transactions and whole-section retry.
 *
 * HOW THE PORT'S REQUIREMENTS ARE MET
 * -----------------------------------
 * - PROMISE boundary: every method is honestly async against a networked driver.
 * - ATOMICITY: `importRows` runs its whole two-phase section in one
 *   `db.transaction`; any rejection — including a dangling forward reference at
 *   phase 2 — rolls all of it back, so a failed import never leaves the MAIN
 *   database partially changed. The archive file is untouched either way (the
 *   caller opens it read-only).
 * - RETRY: `withPgRetry` wraps the WHOLE section (BEGIN through COMMIT). The section
 *   is idempotent under replay: the conflict policy is "keep what is already
 *   there", so a replay after a commit whose acknowledgement was lost simply
 *   conflict-skips every row it already wrote.
 *
 * THE CONFLICT POLICY, IN POSTGRESQL SPELLING
 * -------------------------------------------
 * `INSERT OR IGNORE` becomes `INSERT … ON CONFLICT DO NOTHING` — the portable
 * spelling for the same policy ("keep what is already there"), and the spelling the
 * knowledge write store already standardized on. Two honest differences, stated
 * rather than hidden:
 *
 *   - A NOT NULL violation aborts the import here; SQLite's OR IGNORE skipped the
 *     row. The archive's own writer only ever produces complete rows, so the
 *     skipped-row shape only ever arose from a hand-corrupted file — where failing
 *     loudly is the better answer, and where the pre-existing tests pin "a failed
 *     import leaves nothing behind" as the required behavior either way.
 *   - `ON CONFLICT DO NOTHING` without a target skips ANY unique-violating row
 *     (e.g. a chapter colliding on the `(project_id, branch)` unique index), which
 *     is exactly what OR IGNORE did with unique constraints.
 *
 * THE IMPORT IS TWO-PHASE, IN ONE TRANSACTION
 * -------------------------------------------
 * `deferred-references.ts` states why: self-references within a PK-ordered batch
 * and references to tables that arrive LATER cannot satisfy an immediately enforced
 * FK at row-insert time, on EITHER backend. Phase 1 inserts every row with those
 * columns bound to NULL, recording (via `RETURNING`) only the rows that were
 * actually inserted; phase 2 restores the references with one UPDATE per inserted
 * row. A genuinely dangling reference aborts the whole import at phase 2 — the same
 * verdict SQLite's immediate FK gave, from a statement that names the broken
 * reference instead of the unlucky row order. No schema change is needed: the FKs
 * stay IMMEDIATE for every other write path (see the batch report for the optional
 * DEFERRABLE alternative, which would trade this mechanism for a schema migration).
 *
 * BOUNDS
 * ------
 * Reads are cursor-paged with the same hard `MAX_PAGE_SIZE` as the SQLite store,
 * ordered by primary key, `limit + 1` rather than a preceding COUNT(*). Writes are
 * per-row statements inside one transaction; multi-row VALUES would have to chunk
 * against the driver's bind-parameter ceiling as a function of column count.
 */
import { withPgRetry } from "@server/db/pg-retry";
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
} from "@server/db/postgres-schema";
import { type Column, getTableColumns, getTableName, type SQL, sql, type Table } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { forwardReferencesOf } from "./deferred-references";
import type {
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

/** Transaction handle as produced by `db.transaction(async (tx) => …)`. PG-side only. */
type PgTransaction = Parameters<Parameters<BunSQLDatabase["transaction"]>[0]>[0];

/**
 * Upper bound on rows per page, regardless of what a caller asks for — identical to
 * the SQLite store, for the same reason: no single read may load an unbounded slice
 * of `narrator_messages` (whose `content_json` is one of the large columns the
 * performance rules single out) into the heap.
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
 * Archive column name → main-database column, per table — built from the live
 * Drizzle metadata exactly as the SQLite store builds its own, so a renamed or
 * dropped main column shows up as a MISSING entry rather than as a statement
 * referencing a column that no longer exists. Restricted to the manifest for the
 * same reason: a main column the archive format does not define (credentials, ACL)
 * must not leak into an archive.
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
	throw new Error(`Archive table "${table}" has no single-column primary key to page by`);
}

function requireArchiveTable(table: string): ArchiveTable {
	if (!isArchiveTable(table)) {
		throw new Error(`"${table}" is not a table of the portable project archive`);
	}
	return table;
}

/**
 * `INSERT INTO <table> (<cols>) VALUES (<binds>) ON CONFLICT DO NOTHING RETURNING id`.
 *
 * The RETURNING clause is the inserted/skipped verdict the two-phase import keys on:
 * only a row that was actually inserted may have its forward references restored in
 * phase 2 — a conflict-skipped row keeps the existing row's references, which is
 * the "keep what is already there" policy applied to the references themselves.
 */
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
	return sql`INSERT INTO ${target} (${names}) VALUES (${binds}) ON CONFLICT DO NOTHING RETURNING ${sql.identifier(
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
 * The whole import as one async section: phase 1 inserts (forward references NULL),
 * phase 2 restores them. A rejection anywhere rolls everything back.
 *
 * A named function rather than an inline closure so the transaction-atomicity gate
 * sees the required shape: a named section invoked through a non-async arrow.
 */
async function importRowsSection(
	tx: PgTransaction,
	request: ImportRowsRequest,
): Promise<ImportRowsResult> {
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
			const values = columns.map((column) =>
				forward.has(column.name) ? null : toMainValue(column, row[column.name] ?? null),
			);
			const inserted = (await tx.execute(insertStatement(table, columns, values))) as unknown as
				| Record<string, unknown>[]
				| undefined;
			const insertedRow = inserted?.[0];
			if (!insertedRow) continue;
			const deferredColumns = columns.filter((column) => forward.has(column.name));
			if (deferredColumns.length === 0) continue;
			pending.push({
				table,
				pkValue: insertedRow[primaryKeyColumn(table).name],
				columns: deferredColumns,
				values: deferredColumns.map((column) => toMainValue(column, row[column.name] ?? null)),
			});
		}
		applied[batch.table] = batch.rows.length;
	}
	for (const restore of pending) {
		const assignments = sql.join(
			restore.columns.map((column, index) => {
				const value = restore.values[index] ?? null;
				return sql`${sql.identifier(column.name)} = ${value}`;
			}),
			sql`, `,
		);
		await tx.execute(
			sql`UPDATE ${sql.identifier(getTableName(MAIN_TABLES[restore.table]))} SET ${assignments} WHERE ${sql.identifier(
				primaryKeyColumn(restore.table).name,
			)} = ${restore.pkValue}`,
		);
	}
	return { applied };
}

/**
 * Compose the PostgreSQL archive main store over a caller-supplied handle. Nothing
 * here opens a connection — tests and the future composition root build their own.
 */
export function createPostgresProjectArchiveMainStore(db: BunSQLDatabase): ProjectArchiveMainStore {
	return {
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
			// `limit + 1` rather than a preceding COUNT(*): one extra row answers "is there
			// more?" without a second scan.
			const statement = sql`SELECT ${selection} FROM ${target}${where} ORDER BY ${sql.identifier(
				key.name,
			)} ASC LIMIT ${limit + 1}`;

			const raw = (await db.execute(statement)) as unknown as Record<string, unknown>[];
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
			// Validate before opening the transaction: a bad table name is a programming
			// error, and discovering it mid-transaction would mean rolling back work that
			// was fine.
			for (const batch of request.batches) requireArchiveTable(batch.table);
			if (request.conflictPolicy !== "skip") {
				throw new Error(`Unsupported archive conflict policy: ${String(request.conflictPolicy)}`);
			}
			return withPgRetry(() => db.transaction((tx) => importRowsSection(tx, request)), {
				label: "projectArchive.importRows",
			});
		},
	};
}
