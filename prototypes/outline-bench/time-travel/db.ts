/** Thin dialect wrappers so the same benchmark code drives bun:sqlite and PostgreSQL (Bun.SQL). */
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { PG_SOCKET } from "./lib";

export type Dialect = "sqlite" | "pg";
// biome-ignore lint/suspicious/noExplicitAny: benchmark rows are untyped
export type Row = Record<string, any>;

export interface Db {
	dialect: Dialect;
	all(sql: string, params?: unknown[]): Promise<Row[]>;
	/** Run a statement that must not stay in any statement cache (EXPLAIN). */
	once(sql: string, params?: unknown[]): Promise<Row[]>;
	exec(sql: string): Promise<void>;
	close(): Promise<void>;
	/** Run fn inside one transaction (used by the write benchmark). */
	tx<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<Row[]>) => Promise<T>): Promise<T>;
}

export interface SqliteTuning {
	cacheKiB: number;
	mmapBytes: number;
}

/** Same PRAGMAs as server/db/connection.ts (cache_size -16000, mmap 256 MiB). */
export const SQLITE_PROD: SqliteTuning = { cacheKiB: 16_000, mmapBytes: 268_435_456 };
export const SQLITE_BIG: SqliteTuning = { cacheKiB: 2_000_000, mmapBytes: 4 * 1024 ** 3 };

export function openSqlite(path: string, tuning: SqliteTuning = SQLITE_PROD): Db {
	const db = new Database(path);
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA synchronous = NORMAL");
	db.run("PRAGMA busy_timeout = 250");
	db.run(`PRAGMA cache_size = -${tuning.cacheKiB}`);
	db.run("PRAGMA temp_store = MEMORY");
	db.run(`PRAGMA mmap_size = ${tuning.mmapBytes}`);
	db.run("PRAGMA wal_autocheckpoint = 1000");
	return {
		dialect: "sqlite",
		async all(sql, params = []) {
			return db.query(sql).all(...(params as never[])) as Row[];
		},
		async once(sql, params = []) {
			const st = db.prepare(sql);
			try {
				return st.all(...(params as never[])) as Row[];
			} finally {
				st.finalize();
			}
		},
		async exec(sql) {
			db.run(sql);
		},
		async close() {
			db.close();
		},
		async tx(fn) {
			db.run("BEGIN IMMEDIATE");
			try {
				const out = await fn(
					async (sql, params = []) => db.query(sql).all(...(params as never[])) as Row[],
				);
				db.run("COMMIT");
				return out;
			} catch (e) {
				db.run("ROLLBACK");
				throw e;
			}
		},
	};
}

export function openPg(database: string): Db {
	const sql = new SQL({ path: PG_SOCKET, user: "postgres", database, max: 1 });
	return {
		dialect: "pg",
		async all(text, params = []) {
			return (await sql.unsafe(text, params as never[])) as unknown as Row[];
		},
		async once(text, params = []) {
			return (await sql.unsafe(text, params as never[])) as unknown as Row[];
		},
		async exec(text) {
			await sql.unsafe(text);
		},
		async close() {
			await sql.close();
		},
		async tx(fn) {
			return (await sql.begin(async (t) => {
				return fn(
					async (text, params = []) =>
						(await t.unsafe(text, params as never[])) as unknown as Row[],
				);
			})) as never;
		},
	};
}
