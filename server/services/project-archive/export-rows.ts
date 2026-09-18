/**
 * Moving rows from the main database into a portable archive file.
 *
 * This is the export's half of the seam. The main-database reads go through
 * `ProjectArchiveMainStore` (so they survive a dialect change) and the writes go through
 * `ArchiveTableWriter` (so they stay SQLite, which is what the portable file is). Nothing here
 * knows what the main database's tables or TypeScript field names are.
 *
 * WHY THE READS ARE PAGED
 * -----------------------
 * A page is read, handled, and only then is the next one read. Peak memory is one page rather
 * than the whole table, which matters because `narrator_messages.content_json` holds full
 * conversation content — the predecessor of this code loaded every matching row of every table
 * into arrays first.
 *
 * APPEND vs REPLACE, AND WHY ONLY ONE OF THEM NEEDS STAGING
 * --------------------------------------------------------
 * Two shapes of write exist here, and they are not variations of one thing:
 *
 *   - {@link copyTable} APPENDS. Rows go straight through `INSERT OR REPLACE`, one transaction
 *     per page. A reader between pages sees fewer rows than the export will eventually have
 *     written, never fewer than it started with, and every row it does see is complete. No
 *     staging is needed to make that true.
 *   - {@link replaceTables} REPLACES a scope: "these rows, and no others, are what the archive
 *     should hold". That is a DELETE plus the INSERTs that refill it, and the two MUST commit
 *     together — a commit in between is the window where a reader (a user's other machine
 *     opening the file they copied) finds the table emptied or half-refilled.
 *
 * The difficulty is that a replacement's rows arrive across pages, and a `bun:sqlite`
 * transaction cannot span the `await` between two of them: the driver commits when the callback
 * RETURNS, so an `async` callback commits at its first `await` and everything after it runs
 * unprotected (`server/db/transaction-atomicity-contract.test.ts` demonstrates it). Buffering
 * the rows in JS would restore atomicity by giving up the memory bound — for
 * `narrator_messages` that is the whole conversation history in the heap.
 *
 * So {@link replaceTables} stages each page into a TEMP table as it arrives (see
 * `ArchiveStagingTable`), and once EVERY page of EVERY table in the scope has been read, one
 * strictly synchronous transaction runs the DELETEs and loads the staged rows in. Reads stay
 * paged, the atomic section stays synchronous, and the rows never sit in the JS heap.
 *
 * WHAT A FAILED EXPORT LEAVES BEHIND
 * ----------------------------------
 * A replacement that fails at any point — a page that cannot be read, a row the archive rejects,
 * a cancellation, a timeout, a staging ceiling — leaves the archive EXACTLY as it was: the
 * DELETEs never ran, and the staged rows are dropped. Readers see the old complete contents
 * before the commit and the new complete contents after it, with no third state.
 *
 * What is NOT claimed is atomicity ACROSS replacements. `fullSync` performs several (chapters,
 * edges, each narrator's conversation, …), so an export interrupted between them leaves earlier
 * scopes replaced and later ones stale — each internally whole. Two databases cannot be one
 * transaction, the archive is a backup the next export replaces wholesale, and the main database
 * is only ever read.
 */
import type { Database } from "bun:sqlite";
import {
	type ArchiveStagingTable,
	type ArchiveTableWriter,
	stagingTable,
	tableWriter,
} from "./archive-writer";
import type { ArchiveRow, ArchiveValue, ProjectArchiveMainStore } from "./main-store";
import type { ArchiveTable } from "./manifest";

/** Rows per main-database page. The store clamps this to its own ceiling. */
const PAGE_SIZE = 500;

/**
 * Filter values per query.
 *
 * Smaller than `PAGE_SIZE` on purpose: these become an `IN (…)` list, so the number bounds the
 * statement's size rather than the result's. 200 keeps a generated statement well clear of any
 * practical limit while still amortizing the round trip.
 */
const FILTER_CHUNK = 200;

/**
 * Adjustments applied to a row after it leaves the main store, per archive table.
 *
 * The archive is not always a verbatim copy, and each divergence needs to be visible rather
 * than buried in a binding list.
 */
const PROJECTIONS: Partial<Record<ArchiveTable, (row: Record<string, ArchiveValue>) => void>> = {
	narrators(row) {
		// `plan_mode` in the archive is derived from `traits`, not copied from the main column.
		//
		// This preserves the pre-existing export exactly. The two agree in the main database —
		// every writer sets the column and the trait together — but `traits` is what the product
		// reads at runtime (`isPlanModeTrait`), so deriving from it means an archive can never
		// describe a narrator as in plan mode when the trait that actually governs it says
		// otherwise.
		if (!("plan_mode" in row)) return;
		const traits = row.traits;
		let inPlanMode = false;
		if (typeof traits === "string") {
			try {
				const parsed: unknown = JSON.parse(traits);
				inPlanMode = Array.isArray(parsed) && parsed.includes("plan");
			} catch {
				// A traits value that is not valid JSON cannot claim plan mode. The main database
				// normalizes these at startup, so this is a floor rather than an expected case.
				inPlanMode = false;
			}
		}
		row.plan_mode = inPlanMode ? 1 : 0;
	},
};

/**
 * Pages per filter chunk before the export gives up.
 *
 * Bounded rather than `while (true)`: a store whose cursor stops advancing must fail instead of
 * exporting forever. 500 rows over 20 000 pages is 10 million rows per filter chunk, so the
 * bound is unreachable by real data.
 */
const MAX_PAGES = 20_000;

/** A `DELETE` (or any statement) that defines what a replacement scope removes. */
export interface ClearStatement {
	readonly sql: string;
	readonly params?: readonly ArchiveValue[];
}

/**
 * Cancellation and time budget for one export.
 *
 * Checked between pages — never inside the archive transaction, which is synchronous and short.
 * An export that stops early has written nothing a reader can tell apart from "not started":
 * appends are whole pages, and a replacement's staged rows are discarded.
 */
export interface ExportControl {
	readonly signal?: AbortSignal;
	/** Absolute epoch-ms deadline. Use {@link exportDeadline} to derive one from a duration. */
	readonly deadline?: number;
}

/** Thrown when an export is aborted or runs past its deadline. */
export class ArchiveExportCancelledError extends Error {
	constructor(
		readonly reason: "aborted" | "timeout",
		readonly at: string,
	) {
		super(
			reason === "timeout"
				? `Archive export exceeded its time budget at "${at}"`
				: `Archive export was cancelled at "${at}"`,
		);
		this.name = "ArchiveExportCancelledError";
	}
}

/** An absolute deadline `timeoutMs` from now, or undefined for "no time limit". */
export function exportDeadline(timeoutMs: number | undefined): number | undefined {
	if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
	return Date.now() + timeoutMs;
}

/** Throw if the export should stop. `at` names the point, so a failure says where it stopped. */
function checkControl(control: ExportControl, at: string): void {
	if (control.signal?.aborted) throw new ArchiveExportCancelledError("aborted", at);
	if (control.deadline !== undefined && Date.now() > control.deadline) {
		throw new ArchiveExportCancelledError("timeout", at);
	}
}

export interface CopyOptions extends ExportControl {
	/** Restrict to rows whose `column` is one of `values`. Absent reads the whole table. */
	readonly filter?: { readonly column: string; readonly values: readonly string[] };
}

export interface CopyResult {
	readonly rows: number;
}

/**
 * APPEND rows of one archive table from the main database into `conn`.
 *
 * One transaction per page, so a reader between pages sees a prefix of the new rows on top of
 * everything that was already there — never a gap. Use {@link replaceTables} when rows must
 * REPLACE what the archive holds; a delete belongs in the same commit as its refill, which is
 * impossible to express here and is why this function has no `clear` parameter.
 *
 * Returns 0 rows without touching the archive when the table is absent from the file.
 */
export async function copyTable(
	store: ProjectArchiveMainStore,
	conn: Database,
	table: ArchiveTable,
	options: CopyOptions = {},
): Promise<CopyResult> {
	const writer = tableWriter(conn, table);
	if (!writer) return { rows: 0 };
	const rows = await eachPage(store, table, options.filter, options, (page) => {
		writeRows(conn, writer, table, page);
	});
	return { rows };
}

/** One scope of a replacement: what to delete, and which rows refill it. */
export interface ReplaceScope {
	readonly table: ArchiveTable;
	/** Restrict the refill to rows whose `column` is one of `values`. Absent reads the table. */
	readonly filter?: CopyOptions["filter"];
	/**
	 * Statements that remove what this scope replaces, run inside the single commit.
	 *
	 * Absent means "add these rows without removing anything" — which `narrator_messages` needs,
	 * because a message can be shared with another narrator and deleting by narrator would drop
	 * rows another one still references.
	 */
	readonly clear?: readonly ClearStatement[];
}

export interface ReplaceResult {
	/** Rows copied per scope, in `scopes` order. */
	readonly rows: readonly number[];
}

/**
 * REPLACE one or more scopes of the archive as a single atomic change.
 *
 * Every page of every scope is staged into a TEMP table first (see `ArchiveStagingTable`), and
 * only when all of them have been read does one strictly synchronous transaction run the clears
 * and load the staged rows. So a reader of the file sees either the complete previous contents or
 * the complete new ones:
 *
 *   - a page that fails to read, a row the archive rejects, a cancellation, a timeout or a
 *     staging ceiling all abort before the transaction opens, leaving the archive untouched;
 *   - a failure INSIDE the transaction rolls back the clears with it.
 *
 * All clears run before any load, which is what makes a scope's own delete-then-insert correct
 * and lets one scope's clear precede another's refill (`narrator_message_refs` is cleared by
 * narrator while `narrator_messages` is only added to).
 *
 * Staging tables are dropped on every path, so nothing survives in the connection's temp
 * database — and nothing is ever created in the portable file itself.
 */
export async function replaceTables(
	store: ProjectArchiveMainStore,
	conn: Database,
	scopes: readonly ReplaceScope[],
	control: ExportControl = {},
): Promise<ReplaceResult> {
	const staged: (ArchiveStagingTable | null)[] = [];
	const rows: number[] = [];
	try {
		for (const scope of scopes) {
			checkControl(control, scope.table);
			const stage = stagingTable(conn, scope.table);
			staged.push(stage);
			if (!stage) {
				// The file does not carry this table at all (an archive predating it). There is
				// nothing to delete and nothing to write back, so the scope is a no-op rather
				// than a `DELETE FROM <missing table>` that would fail the whole replacement.
				rows.push(0);
				continue;
			}
			rows.push(
				await eachPage(store, scope.table, scope.filter, control, (page) => {
					stage.stage(page, PROJECTIONS[scope.table]);
				}),
			);
		}

		// Last chance to stop: after this point the change is committed or rolled back, and no
		// `await` may appear inside the transaction — `bun:sqlite` commits when the callback
		// RETURNS, so an awaiting callback would commit the clears on their own.
		checkControl(control, "commit");
		const tx = conn.transaction(() => {
			for (const [index, scope] of scopes.entries()) {
				if (!scope.clear || staged[index] === null) continue;
				for (const statement of scope.clear) {
					conn.run(statement.sql, [...(statement.params ?? [])] as (string | number | null)[]);
				}
			}
			for (const stage of staged) stage?.loadInto();
		});
		tx();
	} finally {
		for (const stage of staged) stage?.drop();
	}
	return { rows };
}

/**
 * Read every matching page of one table, handing each to `onPage`.
 *
 * `onPage` is synchronous by signature, which is the enforcement that matters: the paged read is
 * the only `await` in the loop, so no caller can accidentally hold an archive transaction open
 * across one.
 */
async function eachPage(
	store: ProjectArchiveMainStore,
	table: ArchiveTable,
	filter: CopyOptions["filter"],
	control: ExportControl,
	onPage: (rows: readonly ArchiveRow[]) => void,
): Promise<number> {
	// An empty value list means "no rows match", never "no filter" — a scoped read that widened
	// to a full-table one here would dump the whole main database into one project's archive.
	if (filter && filter.values.length === 0) return 0;
	const filters = filter
		? chunk(filter.values, FILTER_CHUNK).map((values) => ({ column: filter.column, values }))
		: [undefined];

	let total = 0;
	for (const chunked of filters) {
		let after: string | null = null;
		for (let page = 0; page < MAX_PAGES; page += 1) {
			checkControl(control, table);
			const result = await store.readRows({ table, filter: chunked, limit: PAGE_SIZE, after });
			if (result.rows.length > 0) {
				onPage(result.rows);
				total += result.rows.length;
			}
			if (result.nextCursor === null) break;
			if (result.nextCursor === after) {
				throw new Error(`Archive export of "${table}" stalled at cursor ${after}`);
			}
			after = result.nextCursor;
			if (page === MAX_PAGES - 1) {
				throw new Error(`Archive export of "${table}" exceeded its page bound`);
			}
		}
	}
	return total;
}

/** Write one page inside an archive-side transaction. Strictly synchronous. */
function writeRows(
	conn: Database,
	writer: ArchiveTableWriter,
	table: ArchiveTable,
	rows: readonly ArchiveRow[],
): void {
	const projection = PROJECTIONS[table];
	const tx = conn.transaction(() => {
		for (const row of rows) {
			if (!projection) {
				writer.write(row);
				continue;
			}
			const projected: Record<string, ArchiveValue> = { ...row };
			projection(projected);
			writer.write(projected);
		}
	});
	tx();
}

function chunk<T>(values: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
	return out;
}

/**
 * Read every matching row of one table through the store, paging to the end.
 *
 * For the cases that need the rows themselves rather than a copy — the message-ref diff that
 * makes the incremental export incremental, and the id lists that scope it. Bounded by the same
 * page-count ceiling as `copyTable`, so a non-advancing cursor fails instead of looping. There
 * is no row limit, matching what these call sites did before (an unpaged `db.select()`); the
 * gain is that the reads are now paged and cannot spin.
 *
 * These lists are narrow by construction — ids and `narrator_message_refs`, never a table with a
 * large column — which is why holding them is acceptable where holding `narrator_messages`
 * would not be.
 */
export async function readAllRows(
	store: ProjectArchiveMainStore,
	table: ArchiveTable,
	options: { filter?: CopyOptions["filter"] } & ExportControl = {},
): Promise<ArchiveRow[]> {
	const all: ArchiveRow[] = [];
	await eachPage(store, table, options.filter, options, (page) => {
		all.push(...page);
	});
	return all;
}

/** Distinct non-null string values of `column` across `rows`, preserving first-seen order. */
export function distinctIds(rows: readonly ArchiveRow[], column: string): string[] {
	const seen = new Set<string>();
	for (const row of rows) {
		const value = row[column];
		if (typeof value === "string" && value.length > 0) seen.add(value);
	}
	return [...seen];
}

export { FILTER_CHUNK as ARCHIVE_EXPORT_FILTER_CHUNK, PAGE_SIZE as ARCHIVE_EXPORT_PAGE_SIZE };
