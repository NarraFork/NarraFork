/**
 * Reading a portable `project.db` archive file. Permanently SQLite, by design.
 *
 * The archive is a plain SQLite file at `<gitPath>/.narrafork/project.db` that users copy
 * between machines. That portability IS the feature, so this side is not migrating anywhere
 * regardless of what the main database does — which is why `bun:sqlite` appears here and not
 * behind the `ProjectArchiveMainStore` port.
 *
 * READ-ONLY, AND THAT IS LOAD-BEARING
 * -----------------------------------
 * The handle is opened `{ readonly: true }`. An import must never modify the file it is reading:
 * the user's copy is often their only backup, and a failed import that also mutated the source
 * would destroy the thing they would retry from. `readonly` makes that a property of the handle
 * rather than a discipline — SQLite refuses the write, so no code path can accidentally acquire
 * one. `__tests__/import-roundtrip.test.ts` verifies the file's bytes are unchanged after both a
 * successful and a failed import.
 *
 * Read-only also means this never creates the file and never runs the schema patches in
 * `server/lib/project-db.ts`. An OLD archive is read exactly as it is, with whatever columns it
 * has; adapting to it is `columnsFor`'s job.
 *
 * BOUNDS
 * ------
 * `readTable` pages by primary key with a caller-supplied limit, so no table is ever loaded
 * whole. That matters most for `narrator_messages`, whose `content_json` holds full conversation
 * content — the previous importer did `SELECT * FROM <table>` and materialized every row of
 * every table in the heap at once before writing any of them.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { NotFoundError, ValidationError } from "@server/lib/errors";
import { getProjectDbPath } from "@server/lib/project-db";
import type { ArchiveRow, ArchiveValue } from "./main-store";
import { ARCHIVE_COLUMNS, type ArchiveTable, isArchiveTable } from "./manifest";

/** Upper bound on rows read per page, mirroring the main store's ceiling. */
const MAX_PAGE_SIZE = 500;

export interface ArchiveTablePage {
	readonly rows: readonly ArchiveRow[];
	/** UTF-8 bytes for serializing `rows` as a JSON array; zero when the page is empty. */
	readonly serializedBytes: number;
	/** Pass back as `after` to continue; `null` on the last page. */
	readonly nextCursor: string | null;
}

export interface ArchiveTableReadOptions {
	readonly limit: number;
	readonly after?: string | null;
	/** Reject while reading if one normalized row exceeds this serialized size. */
	readonly maxRowSerializedBytes?: number;
	/** Reject while reading before one returned page grows beyond this serialized size. */
	readonly maxBatchSerializedBytes?: number;
}

/**
 * A read-only view of one archive file.
 *
 * Callers must `close()` it. The handle is a file descriptor on a user-visible file, and on
 * Windows an unclosed one blocks the directory from being moved or deleted.
 */
export class ProjectArchiveFile {
	private readonly conn: Database;
	private readonly columnCache = new Map<string, readonly string[]>();

	private constructor(
		conn: Database,
		readonly path: string,
	) {
		this.conn = conn;
	}

	/**
	 * Open the archive under `gitPath`.
	 *
	 * Throws `NotFoundError` when absent, which is what the import route turns into a 404 —
	 * preserved from the previous implementation.
	 */
	static open(gitPath: string): ProjectArchiveFile {
		const path = getProjectDbPath(gitPath);
		if (!existsSync(path)) throw new NotFoundError("Project database", path);
		return new ProjectArchiveFile(new Database(path, { readonly: true }), path);
	}

	close(): void {
		try {
			this.conn.close();
		} catch {
			// Closing twice, or closing a handle whose file vanished, is not worth failing an
			// import that already succeeded.
		}
	}

	/**
	 * Which archive columns this FILE actually has for `table`, intersected with the manifest.
	 *
	 * Three-way narrowing, and each side has a reason:
	 *
	 *   - the file's own `PRAGMA table_info` — an archive written by an older version lacks
	 *     columns the current format defines (`execution_path_flavor` and its three siblings
	 *     were added by a later patch, so any archive predating it has none of them).
	 *   - the manifest — a RETIRED column may still sit in an old file. `prune_enabled` and
	 *     friends are the precedent: they existed, were removed from the product, and must not
	 *     be resurrected into the main database by an import.
	 *   - and the caller intersects again with what the main database can accept.
	 *
	 * A table absent from the file yields an empty list rather than throwing: a missing table is
	 * an ordinary shape for an old archive.
	 */
	columnsFor(table: ArchiveTable): readonly string[] {
		const cached = this.columnCache.get(table);
		if (cached) return cached;
		let present: Set<string>;
		try {
			present = new Set(
				(
					this.conn.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
						name: string;
					}>
				).map((column) => column.name),
			);
		} catch {
			present = new Set();
		}
		const columns = ARCHIVE_COLUMNS[table].filter((column) => present.has(column));
		this.columnCache.set(table, columns);
		return columns;
	}

	/** Whether the file has this table at all. */
	hasTable(table: ArchiveTable): boolean {
		return this.columnsFor(table).length > 0;
	}

	/**
	 * One page of rows from `table`, ordered by `id`, restricted to `columns`.
	 *
	 * `columns` is passed in rather than derived here so the caller can hand over the already
	 * three-way-narrowed list, and so this method never reads a large column the caller has no
	 * use for.
	 */
	readTable(
		table: ArchiveTable,
		columns: readonly string[],
		options: ArchiveTableReadOptions = { limit: MAX_PAGE_SIZE },
	): ArchiveTablePage {
		if (columns.length === 0) return { rows: [], serializedBytes: 0, nextCursor: null };
		const available = new Set(this.columnsFor(table));
		const selected = columns.filter((column) => available.has(column));
		if (selected.length === 0) return { rows: [], serializedBytes: 0, nextCursor: null };

		const limit = Math.max(1, Math.min(options.limit, MAX_PAGE_SIZE));
		const maxRowBytes = options.maxRowSerializedBytes ?? Number.MAX_SAFE_INTEGER;
		const maxBatchBytes = options.maxBatchSerializedBytes ?? Number.MAX_SAFE_INTEGER;
		const queried = selected.includes("id") ? selected : ["id", ...selected];
		const selection = queried.map(quoteIdentifier).join(", ");
		const serializedKeyBytes = selected.map((column) =>
			Buffer.byteLength(JSON.stringify(column), "utf8"),
		);
		// Every table in the archive is keyed by `id`, so it is both the primary key and a
		// stable paging order. `iterate()` prevents the driver from first materializing the whole
		// page in a second array before the importer can enforce its byte budget.
		const where = options.after != null ? ' WHERE "id" > ?' : "";
		const statement = `SELECT ${selection} FROM ${quoteIdentifier(table)}${where} ORDER BY "id" ASC LIMIT ${limit}`;
		const params = options.after != null ? [options.after] : [];
		const rows: ArchiveRow[] = [];
		let serializedBytes = 0;
		let lastId: string | null = null;

		for (const source of this.conn.prepare(statement).iterate(...params) as Iterable<
			Record<string, unknown>
		>) {
			const row: Record<string, ArchiveValue> = {};
			for (const column of selected) row[column] = normalize(source[column]);
			const rowBytes = serializedRowBytes(row, selected, serializedKeyBytes);
			if (rowBytes > maxRowBytes) {
				throw new ValidationError(
					`Archive row "${table}.${String(source.id)}" exceeds the ${maxRowBytes}-byte serialized row limit`,
					"PROJECT_ARCHIVE_LIMIT_EXCEEDED",
				);
			}
			const nextBatchBytes = rows.length === 0 ? rowBytes + 2 : serializedBytes + rowBytes + 1;
			if (nextBatchBytes > maxBatchBytes) {
				throw new ValidationError(
					`Archive batch for "${table}" exceeds the ${maxBatchBytes}-byte serialized batch limit`,
					"PROJECT_ARCHIVE_LIMIT_EXCEEDED",
				);
			}
			rows.push(row);
			serializedBytes = nextBatchBytes;
			lastId = String(source.id);
		}

		let nextCursor: string | null = null;
		if (rows.length === limit && lastId !== null) {
			const more = this.conn
				.prepare(`SELECT 1 FROM ${quoteIdentifier(table)} WHERE "id" > ? ORDER BY "id" ASC LIMIT 1`)
				.get(lastId);
			if (more) nextCursor = lastId;
		}
		return { rows, serializedBytes, nextCursor };
	}

	/**
	 * The single project row, or null when the archive has none.
	 *
	 * An archive with no project record is unusable — there is nothing to import — and the
	 * caller turns that into a `ValidationError`, unchanged from before.
	 */
	readProjectRow(): ArchiveRow | null {
		const columns = this.columnsFor("projects");
		if (columns.length === 0) return null;
		const { rows } = this.readTable("projects", columns, { limit: 1 });
		return rows[0] ?? null;
	}
}

/**
 * Quote an identifier for the archive's SQL.
 *
 * Only ever called with manifest-derived names, so the doubling is belt-and-braces rather than
 * the actual defense — the actual defense is that nothing else reaches these statements.
 */
function quoteIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Exact UTF-8 bytes for one normalized row's JSON object representation.
 *
 * Values are serialized independently so budget accounting never creates a second full-row JSON
 * string alongside the retained row object. Summing these pieces is byte-identical to serializing
 * the complete object because the separators are fixed ASCII bytes.
 */
function serializedRowBytes(
	row: ArchiveRow,
	columns: readonly string[],
	serializedKeyBytes: readonly number[],
): number {
	let bytes = 2; // `{}`
	for (const [index, column] of columns.entries()) {
		const valueJson = JSON.stringify(row[column] ?? null);
		bytes +=
			(index === 0 ? 0 : 1) + (serializedKeyBytes[index] ?? 0) + 1 + Buffer.byteLength(valueJson);
	}
	return bytes;
}

/** Coerce a value out of the file to the archive's four types. */
function normalize(value: unknown): ArchiveValue {
	if (value === undefined || value === null) return null;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	// A BLOB (Uint8Array) has no place in this format; the archive's binary payloads are all
	// base64 inside JSON text. Anything else is stringified rather than silently dropped.
	if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
	return String(value);
}

export { isArchiveTable, MAX_PAGE_SIZE as ARCHIVE_FILE_MAX_PAGE_SIZE };
