import type { Database } from "bun:sqlite";
import type { ArchiveRow, ArchiveValue } from "./main-store";
import { type ArchiveSqlConnection, quoteArchiveIdentifier } from "./worker-store";

/** Isolated-worker connection, NEVER the shared HTTP main db handle. */
export function sqliteArchiveConnection(db: Database): ArchiveSqlConnection {
	const cache = new Map<string, string[]>();
	const connection: ArchiveSqlConnection = {
		byteLength(column) {
			return `coalesce(length(CAST(${quoteArchiveIdentifier(column)} AS BLOB)),0)`;
		},
		async query(text: string, values: ArchiveValue[] = []) {
			return db
				.prepare(text)
				.all(...values.map((x) => (typeof x === "boolean" ? Number(x) : x))) as ArchiveRow[];
		},
		async columns(table) {
			const cached = cache.get(table);
			if (cached) return cached;
			const rows = db.prepare(`PRAGMA table_info(${quoteArchiveIdentifier(table)})`).all() as {
				name: string;
			}[];
			const columns = rows.map((r) => r.name);
			cache.set(table, columns);
			return columns;
		},
		async transaction(write, action) {
			// ONE dedicated worker owns this connection across awaits; no shared requests
			// and no async native db.transaction callback that commits prematurely.
			db.run(write ? "BEGIN IMMEDIATE" : "BEGIN");
			try {
				const result = await action(connection);
				db.run("COMMIT");
				return result;
			} catch (error) {
				db.run("ROLLBACK");
				throw error;
			}
		},
	};
	return connection;
}
