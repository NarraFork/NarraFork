import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { getNarraforkHome } from "../lib/narrafork-home";

export function getDbDir(): string {
	return getNarraforkHome();
}

export function getDbPath(): string {
	return resolve(getNarraforkHome(), "narrafork.db");
}

/** Open a SQLite connection with standard NarraFork PRAGMA settings. */
export function openDatabase(dbPath?: string): Database {
	mkdirSync(getNarraforkHome(), { recursive: true });
	const conn = new Database(dbPath ?? getDbPath());
	// WAL: concurrent readers + single writer; readers don't block the writer.
	conn.run("PRAGMA journal_mode = WAL");
	// NORMAL is crash-safe under WAL (only fsyncs at checkpoint, not every commit).
	// Committed transactions can only be lost on power loss, never on app crash —
	// a worthwhile trade for avoiding an fsync on every write.
	conn.run("PRAGMA synchronous = NORMAL");
	conn.run("PRAGMA foreign_keys = ON");
	// Keep SQLite lock waits short: bun:sqlite executes synchronously on the JS thread,
	// so multi-second busy waits make the whole HTTP/WS server appear frozen.
	// SQLITE_BUSY is handled at the application layer via withDbRetry (async backoff).
	conn.run("PRAGMA busy_timeout = 250");
	// 16 MB page cache (negative value = KiB) to reduce disk reads on hot pages.
	conn.run("PRAGMA cache_size = -16000");
	// Keep temp tables / indexes in memory instead of spilling to disk.
	conn.run("PRAGMA temp_store = MEMORY");
	// Memory-map up to 256 MB of the database to cut read() syscalls.
	conn.run("PRAGMA mmap_size = 268435456");
	// Auto-checkpoint when the WAL reaches ~1000 pages (~4 MB) to bound its growth.
	conn.run("PRAGMA wal_autocheckpoint = 1000");
	return conn;
}
