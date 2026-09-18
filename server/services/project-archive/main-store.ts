/**
 * The main-database capability the portable project archive needs, stated without a dialect.
 *
 * WHY THIS EXISTS
 * ---------------
 * `<gitPath>/.narrafork/project.db` is a portable SQLite FILE users copy between machines. It
 * is not migrating anywhere: its whole value is that a plain file, readable by any SQLite, can
 * be handed to another install. The MAIN database is the part that may one day be something
 * else. Export and import sit exactly on that seam, and before this port they straddled it:
 * `project-import.ts` ran `sqlite.run("BEGIN TRANSACTION")` on the shared main-database handle
 * and `PRAGMA table_info` against it, while `project-db-sync.ts` passed Drizzle rows straight
 * into positional SQLite bindings. A second main-database backend would have had to reproduce
 * that shape rather than the requirement.
 *
 * So the requirement is written here in domain terms: which rows the archive needs out of the
 * main database, and what "import this archive" means as one indivisible fact. This file must
 * import nothing dialect-specific — no driver, no Drizzle, no `server/db`, no schema — and
 * `__tests__/main-store-contract.test.ts` asserts exactly that, because an accidental import
 * here is how a portable contract silently becomes a SQLite one.
 *
 * WHAT CROSSES THE BOUNDARY
 * -------------------------
 * Plain domain rows: `Record<string, ArchiveValue>` keyed by the archive's own snake_case
 * column names, with values already flattened to what a SQLite file can hold. The archive
 * format is the fixed point of this design (an existing file on a user's disk cannot be
 * renegotiated), so it is the archive's spelling that both sides agree on — not the main
 * database's, which is free to change.
 *
 * `ArchiveValue` excludes `undefined` deliberately. A missing key and a key holding
 * `undefined` are the same thing to a caller but different to a binding array, and that
 * difference is what silently shifts positional parameters. Absent means absent.
 *
 * ATOMICITY IS PART OF THE CONTRACT, NOT OF THE IMPLEMENTATION
 * ------------------------------------------------------------
 * `importRows` either applies every batch it is given or leaves the main database exactly as
 * it was found. How is the implementation's business: the SQLite adapter uses one strictly
 * synchronous native transaction, because `bun:sqlite` commits when the transaction callback
 * RETURNS — an `async` callback commits at its first `await` and everything after it runs
 * unprotected (see `server/db/transaction-atomicity-contract.test.ts`). A future networked
 * adapter would use a genuinely async transaction. Both satisfy the Promise-returning
 * signatures below, which are Promise-returning precisely so the caller never depends on
 * which one it holds.
 *
 * THE LIMIT OF THAT GUARANTEE, STATED PLAINLY
 * -------------------------------------------
 * Two databases cannot be one transaction. An import writes the main database; the archive
 * file it reads is untouched (opened read-only — `readsSourceFile` below). An export writes
 * the archive file; a failure mid-export leaves the archive partially written while the main
 * database is unharmed. Neither operation claims otherwise, and no amount of wrapping would
 * make it true. What IS guaranteed is the asymmetry that matters: a failure never leaves the
 * MAIN database partially changed, and never damages the source archive.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a repository layer. Only the reads the export performs and the single write the import
 * performs are here. Everything else in the product still speaks to the database directly,
 * and widening this port beyond the sliced capability would be inventing an abstraction
 * nobody asked for.
 */

/**
 * A value the portable archive can hold.
 *
 * SQLite stores five types; the archive uses four of them (no BLOB — every binary payload in
 * this product is already base64 inside JSON text). `undefined` is excluded on purpose: see
 * the header.
 */
export type ArchiveValue = string | number | boolean | null;

/** One archive row, keyed by the archive's own column names. */
export type ArchiveRow = Readonly<Record<string, ArchiveValue>>;

/**
 * Rows destined for one archive table, as a bounded batch.
 *
 * `columns` is explicit rather than derived from the rows: a row that happens to omit a
 * nullable key must not shorten the column list for that batch, and two rows disagreeing
 * about which keys they carry must not produce two different statements. The implementation
 * fills a column absent from a row with `null`.
 */
export interface ArchiveBatch {
	readonly table: string;
	readonly columns: readonly string[];
	readonly rows: readonly ArchiveRow[];
}

/** How an import treats a row whose primary key already exists in the main database. */
export type ArchiveConflictPolicy =
	/**
	 * Keep what is already there.
	 *
	 * This is the import's rule and it is not new: the pre-existing importer used
	 * `INSERT OR IGNORE` throughout, and an import of a project that already exists is
	 * refused before any row is written. Changing the merge rule is out of scope here.
	 */
	"skip";

export interface ImportRowsRequest {
	/** Applied in order. The caller sequences them to respect foreign keys. */
	readonly batches: readonly ArchiveBatch[];
	readonly conflictPolicy: ArchiveConflictPolicy;
}

export interface ImportRowsResult {
	/** Rows OFFERED per table, in `batches` order — not rows actually inserted. */
	readonly applied: Readonly<Record<string, number>>;
}

/** A cursor-paged read of one main-database table, so no read is unbounded. */
export interface ReadRowsPage {
	readonly rows: readonly ArchiveRow[];
	/**
	 * Pass back as `after` to continue. `null` means the last page.
	 *
	 * Opaque by contract: it is the last row's primary key today, and callers must not
	 * interpret it.
	 */
	readonly nextCursor: string | null;
}

export interface ReadRowsQuery {
	/** Archive table name. The implementation maps it to whatever it stores. */
	readonly table: string;
	/**
	 * Restrict to rows whose `column` is one of `values`, or, when absent, read the whole
	 * table. `values` is expected to be small — the caller chunks it.
	 *
	 * An EMPTY `values` array means "no rows match", never "no filter": a filter that
	 * silently widens to a full-table read when its key list happens to be empty is how a
	 * scoped export turns into a whole-database dump.
	 */
	readonly filter?: { readonly column: string; readonly values: readonly string[] };
	/** Max rows per page. The implementation clamps it to its own ceiling. */
	readonly limit: number;
	/** Exclusive lower bound on the ordering key, from a previous page's `nextCursor`. */
	readonly after?: string | null;
}

export interface ProjectArchiveMainStore {
	/**
	 * Which archive columns this main database can actually supply for `table`.
	 *
	 * The archive format is frozen per file, but the main schema moves. This is how a caller
	 * learns which columns to ask for without asking the main database's shape directly —
	 * the question `PRAGMA table_info` used to answer at the import call site.
	 *
	 * Unknown table → empty array. A caller must treat that as "skip this table", the same
	 * as it treats a table missing from an old archive file.
	 */
	supportedColumns(table: string): Promise<readonly string[]>;

	/** One page of archive-shaped rows. Ordered by primary key so paging is stable. */
	readRows(query: ReadRowsQuery): Promise<ReadRowsPage>;

	/**
	 * Apply every batch as one indivisible change, or leave the database untouched.
	 *
	 * Rejects with the underlying storage failure. On rejection nothing from any batch is
	 * visible — including batches that had already been applied when a later one failed.
	 */
	importRows(request: ImportRowsRequest): Promise<ImportRowsResult>;
}
