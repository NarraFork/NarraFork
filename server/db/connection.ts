/**
 * The single chokepoint for WRITABLE connections to the main `narrafork.db`.
 *
 * ⚠️ CONVENTION: every read-write handle on the main database must come from
 * `openDatabase()`. A bare `new Database(mainDbPath)` elsewhere is not just a missing
 * PRAGMA set — it silently bypasses `assertNotRealDatabaseInTests`, and the whole point
 * of that guard is that a stale checkout or a custom bunfig cannot route around it. One
 * such connection is enough for a test run to write fixtures into real user data.
 *
 * Direct `new Database(...)` calls outside this file are therefore allowed only when
 * they are provably NOT a writable main-DB handle. As of this writing the non-test
 * cases are:
 *
 *   - `lib/db-worker/worker-entry.ts`, `db/integrity-probe-worker.ts`,
 *     `lib/db-resilience.ts` (recovered-copy verification) — main DB or a copy of it,
 *     but opened `{ readonly: true }`, so they cannot mutate anything.
 *   - `lib/project-db.ts`, `services/project-import.ts` — per-project
 *     `<gitPath>/.narrafork/project.db`, a different file from the main database.
 *   - `scripts/approve-all.ts`, `scripts/benchmark-narrator-history.ts` — operator CLI
 *     tools, read-only.
 *
 * Adding a writable main-DB connection anywhere else needs this guard applied too, not
 * a copy of the PRAGMA block.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getNarraforkHome } from "../lib/narrafork-home";

export function getDbDir(): string {
	return getNarraforkHome();
}

export function getDbPath(): string {
	return resolve(getNarraforkHome(), "narrafork.db");
}

function normalizedPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalPath(path: string): string {
	try {
		return normalizedPath(realpathSync(path));
	} catch {
		return normalizedPath(path);
	}
}

/**
 * Resolve the developer's REAL data directory, ignoring NARRAFORK_HOME.
 *
 * `os.homedir()` reads the host account rather than `process.env.HOME`, so this stays
 * correct even after a test preload repoints HOME at a temp directory.
 */
function realNarraforkHome(): string {
	// tests/preload.ts repoints HOME/USERPROFILE (which os.homedir() follows) at a
	// temp dir, so the original home is preserved in NARRAFORK_ORIGINAL_HOME and
	// used here — otherwise the real-database guard would treat the isolated test
	// path as the production data dir and refuse every writable connection.
	const originalHome = process.env.NARRAFORK_ORIGINAL_HOME?.trim();
	return canonicalPath(resolve(originalHome ?? homedir(), ".narrafork"));
}

/**
 * Refuse to open the real ~/.narrafork database from a test process.
 *
 * `tests/preload.ts` already redirects NARRAFORK_HOME to a temp directory, but that
 * guard lives in the repo: any checkout or worktree predating it (or run with a custom
 * bunfig) writes fixtures straight into production data. This check sits at the single
 * chokepoint every writable connection goes through, so it holds regardless of preload.
 *
 * `NODE_ENV=test` is set by `bun test` itself and is absent under `bun run`/compiled
 * binaries, which makes it the one signal a stale checkout cannot drop.
 */
function assertNotRealDatabaseInTests(dbPath: string): void {
	if (process.env.NODE_ENV !== "test") return;
	const realDbPath = resolve(realNarraforkHome(), "narrafork.db");
	if (canonicalPath(dbPath) !== normalizedPath(realDbPath)) return;
	throw new Error(
		`Refusing to open the real NarraFork database from a test process: ${realDbPath}. ` +
			"Tests must run against an isolated NARRAFORK_HOME (see tests/preload.ts).",
	);
}

/** Open a SQLite connection with standard NarraFork PRAGMA settings. */
export function openDatabase(dbPath?: string): Database {
	const target = dbPath ?? getDbPath();
	assertNotRealDatabaseInTests(target);
	mkdirSync(getNarraforkHome(), { recursive: true, mode: 0o700 });
	const conn = new Database(target);
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
