import type { Database } from "bun:sqlite";
import type { ArchiveRow, ArchiveValue } from "../project-archive/main-store";
import type { BackupTable } from "./contract";
import { quoteBackupIdentifier } from "./contract";
import { type BackupSqlConnection, SqlNarratorBackupMainStore } from "./main-store";

/** Isolated-worker connection, NEVER the shared HTTP main db handle. */
export function sqliteBackupConnection(db: Database): BackupSqlConnection {
	const cache = new Map<string, string[]>();
	const connection: BackupSqlConnection = {
		byteLength(column) {
			return `coalesce(length(CAST(${quoteBackupIdentifier(column)} AS BLOB)),0)`;
		},
		async query(text: string, values: ArchiveValue[] = []) {
			return db
				.prepare(text)
				.all(...values.map((x) => (typeof x === "boolean" ? Number(x) : x))) as ArchiveRow[];
		},
		async columns(table: BackupTable) {
			const cached = cache.get(table);
			if (cached) return cached;
			const rows = db.prepare(`PRAGMA table_info(${quoteBackupIdentifier(table)})`).all() as {
				name: string;
			}[];
			const columns = rows.map((r) => r.name);
			cache.set(table, columns);
			return columns;
		},
		async transaction(write, action) {
			// A dedicated connection in ONE worker can safely hold a transaction across these
			// promise-shaped calls: no other request shares it. No async db.transaction callback.
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
export function createSqliteNarratorBackupMainStore(db: Database) {
	return new SqlNarratorBackupMainStore(sqliteBackupConnection(db));
}
