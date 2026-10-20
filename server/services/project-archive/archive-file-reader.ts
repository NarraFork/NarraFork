import type { Database } from "bun:sqlite";
import { ValidationError } from "@server/lib/errors";
import type { ArchiveRow, ArchiveValue } from "./main-store";
import { ARCHIVE_COLUMNS, type ArchiveTable, isArchiveTable } from "./manifest";

export const ARCHIVE_FILE_MAX_PAGE_SIZE = 500;

export interface ArchiveTablePage {
	readonly rows: readonly ArchiveRow[];
	readonly serializedBytes: number;
	readonly nextCursor: string | null;
}

export interface ArchiveTableReadOptions {
	readonly limit: number;
	readonly after?: string | null;
	readonly maxRowSerializedBytes?: number;
	readonly maxBatchSerializedBytes?: number;
}

export type ProjectArchiveReadParams = {
	kind: "projectArchiveReadV1";
	table: ArchiveTable;
} & (
	| { operation: "columns" }
	| { operation: "page"; columns: readonly string[]; options: ArchiveTableReadOptions }
);

/** Worker-only reader: the pool injects the specific read-only archive connection. */
export function readProjectArchive(
	conn: Database,
	params: ProjectArchiveReadParams,
): readonly string[] | ArchiveTablePage {
	if (!isArchiveTable(params.table)) throw new ValidationError("Unknown archive table");
	const table = params.table;
	const present = new Set(
		(conn.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as { name: string }[]).map(
			(column) => column.name,
		),
	);
	const available = ARCHIVE_COLUMNS[table].filter((column) => present.has(column));
	if (params.operation === "columns") return available;
	const selected = params.columns.filter((column) => available.includes(column));
	if (selected.length === 0) return { rows: [], serializedBytes: 0, nextCursor: null };
	const { options } = params;
	const limit = Math.max(1, Math.min(options.limit, ARCHIVE_FILE_MAX_PAGE_SIZE));
	const maxRowBytes = options.maxRowSerializedBytes ?? Number.MAX_SAFE_INTEGER;
	const maxBatchBytes = options.maxBatchSerializedBytes ?? Number.MAX_SAFE_INTEGER;
	const queried = selected.includes("id") ? selected : ["id", ...selected];
	const selection = queried.map(quoteIdentifier).join(", ");
	const serializedKeyBytes = selected.map((column) =>
		Buffer.byteLength(JSON.stringify(column), "utf8"),
	);
	const where = options.after != null ? ' WHERE "id" > ?' : "";
	const statement = `SELECT ${selection} FROM ${quoteIdentifier(table)}${where} ORDER BY "id" ASC LIMIT ${limit}`;
	const bindings = options.after != null ? [options.after] : [];
	const rows: ArchiveRow[] = [];
	let serializedBytes = 0;
	let lastId: string | null = null;

	// Enforce the original byte ceilings before collecting the page or sending it over IPC.
	for (const source of conn.prepare(statement).iterate(...bindings) as Iterable<
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
		const more = conn
			.prepare(`SELECT 1 FROM ${quoteIdentifier(table)} WHERE "id" > ? ORDER BY "id" ASC LIMIT 1`)
			.get(lastId);
		if (more) nextCursor = lastId;
	}
	return { rows, serializedBytes, nextCursor };
}

function quoteIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function serializedRowBytes(
	row: ArchiveRow,
	columns: readonly string[],
	serializedKeyBytes: readonly number[],
): number {
	let bytes = 2;
	for (const [index, column] of columns.entries()) {
		bytes +=
			(index === 0 ? 0 : 1) +
			(serializedKeyBytes[index] ?? 0) +
			1 +
			Buffer.byteLength(JSON.stringify(row[column] ?? null));
	}
	return bytes;
}

function normalize(value: unknown): ArchiveValue {
	if (value === undefined || value === null) return null;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
		return value;
	if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
	return String(value);
}
