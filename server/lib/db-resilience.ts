import { Database } from "bun:sqlite";
import { execSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { logger } from "./logger";

/**
 * Retry a database operation with exponential backoff.
 * Retries on transient SQLite errors (busy, locked).
 */
export async function withDbRetry<T>(
	fn: () => Promise<T>,
	opts: { label?: string; maxRetries?: number } = {},
): Promise<T> {
	const { label = "db_operation", maxRetries = 3 } = opts;
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			const msg = err instanceof Error ? err.message : String(err);
			const isRetryable = msg.includes("database is locked") || msg.includes("SQLITE_BUSY");

			if (!isRetryable || attempt === maxRetries) {
				logger.error(`${label} failed after ${attempt} attempt(s)`, {
					error: msg,
					attempt,
				});
				throw err;
			}

			logger.warn(`${label} failed (attempt ${attempt}/${maxRetries}), retrying...`, {
				error: msg,
			});

			// Exponential backoff: 200ms, 400ms, 800ms
			await sleep(200 * 2 ** (attempt - 1));
		}
	}

	throw lastError;
}

/**
 * Run PRAGMA integrity_check and return whether the database is healthy.
 */
export function checkIntegrity(sqlite: Database): { ok: boolean; details: string } {
	try {
		const result = sqlite.prepare("PRAGMA integrity_check").get() as
			| { integrity_check: string }
			| undefined;
		const status = result?.integrity_check ?? "unknown";
		const ok = status === "ok";
		if (!ok) {
			logger.error("Database integrity check failed", { status });
		}
		return { ok, details: status };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("Database integrity check threw", { error: msg });
		return { ok: false, details: msg };
	}
}

/**
 * Attempt WAL checkpoint to flush pending writes.
 */
export function tryWalRecovery(sqlite: Database): boolean {
	try {
		logger.info("Attempting WAL checkpoint recovery");
		sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)");
		logger.info("WAL checkpoint completed");
		return true;
	} catch (err) {
		logger.error("WAL checkpoint failed", { error: String(err) });
		return false;
	}
}

/**
 * Recover a malformed database using sqlite3 CLI.
 * Dumps the DB to SQL, filters out FTS5 artifacts and triggers (both are
 * recreated by the app on startup), then imports into a fresh DB.
 *
 * Returns true if recovery succeeded, false otherwise.
 */
export function recoverWithCli(dbPath: string): boolean {
	const timestamp = Date.now();
	const backupPath = `${dbPath}.corrupt.${timestamp}`;
	const walPath = `${dbPath}-wal`;
	const shmPath = `${dbPath}-shm`;
	const recoveredPath = `${dbPath}.recovered.${timestamp}`;
	const sqlDumpPath = `${dbPath}.dump.${timestamp}.sql`;

	try {
		logger.warn("Starting CLI-based database recovery", { dbPath });

		// Back up corrupt files
		if (existsSync(dbPath)) copyFileSync(dbPath, backupPath);
		if (existsSync(walPath)) copyFileSync(walPath, `${backupPath}-wal`);
		if (existsSync(shmPath)) copyFileSync(shmPath, `${backupPath}-shm`);

		// Step 1: Try .recover first (handles corruption), fall back to .dump
		try {
			execSync(`sqlite3 "${dbPath}" ".recover" > "${sqlDumpPath}"`, {
				timeout: 60_000,
				stdio: "pipe",
			});
		} catch {
			logger.warn("sqlite3 .recover failed, trying .dump");
			execSync(`sqlite3 "${dbPath}" ".dump" > "${sqlDumpPath}"`, {
				timeout: 60_000,
				stdio: "pipe",
			});
		}

		// Step 2: Filter out FTS artifacts, ALL triggers, and virtual tables.
		// All of these are recreated by db/index.ts on startup.
		//
		// Known limitations of this line-based filter:
		// - Multi-line INSERT values (e.g. strings with embedded newlines) may be
		//   partially filtered if only the first line matches a skip pattern.
		// - The END; detection for trigger blocks assumes it appears on its own line;
		//   non-standard formatting from .recover may cause over/under-skipping.
		// - Indented SQL heuristic (line 150) may false-positive on legitimate
		//   indented statements, though .dump/.recover output is typically unindented.
		// These edge cases are acceptable because all filtered objects (FTS tables,
		// triggers) are recreated by db/index.ts on startup anyway.
		const rawSql = readFileSync(sqlDumpPath, "utf-8");
		const lines = rawSql.split("\n");
		const filtered: string[] = [];
		let inSkipBlock = false;

		for (const line of lines) {
			// Start skipping multi-line blocks: triggers, virtual tables, sqlite_schema
			if (
				/^CREATE TRIGGER\b/i.test(line) ||
				/^CREATE VIRTUAL TABLE\b/i.test(line) ||
				/^INSERT INTO sqlite_schema\b/i.test(line) ||
				/^INSERT INTO sqlite_master\b/i.test(line)
			) {
				inSkipBlock = true;
			}

			if (inSkipBlock) {
				// Triggers end with END; (possibly indented)
				if (/^\s*END;\s*$/i.test(line) || /'\);\s*$/.test(line)) {
					inSkipBlock = false;
				}
				continue;
			}

			// Skip FTS backing table statements (CREATE TABLE / INSERT)
			if (/^CREATE TABLE\s.*_fts_/i.test(line)) continue;
			if (/^INSERT\s.*INTO\s.*_fts/i.test(line)) continue;
			// Skip orphaned trigger body fragments (indented SQL between triggers)
			if (/^\s+(INSERT\s|DELETE\s|VALUES\s|SELECT\s|WHEN\s|BEGIN\s|END)/i.test(line)) continue;

			filtered.push(line);
		}

		writeFileSync(sqlDumpPath, filtered.join("\n"));

		// Step 3: Import cleaned SQL into new DB
		execSync(`sqlite3 "${recoveredPath}" < "${sqlDumpPath}"`, { timeout: 60_000, stdio: "pipe" });

		// Clean up dump file
		if (existsSync(sqlDumpPath)) unlinkSync(sqlDumpPath);

		if (!existsSync(recoveredPath)) {
			logger.error("Recovery produced no output file");
			return false;
		}

		// Verify the recovered DB
		const testDb = new Database(recoveredPath, { readonly: true });
		try {
			const result = testDb.prepare("PRAGMA integrity_check").get() as
				| { integrity_check: string }
				| undefined;
			if (result?.integrity_check !== "ok") {
				logger.error("Recovered DB failed integrity check", {
					details: result?.integrity_check,
				});
				testDb.close();
				unlinkSync(recoveredPath);
				return false;
			}
		} finally {
			testDb.close();
		}

		// Swap: remove old WAL/SHM, replace main DB
		if (existsSync(walPath)) unlinkSync(walPath);
		if (existsSync(shmPath)) unlinkSync(shmPath);
		renameSync(recoveredPath, dbPath);

		logger.info("Database recovery successful", { backupPath });
		return true;
	} catch (err) {
		logger.error("CLI-based database recovery failed", {
			error: String(err),
			backupPath,
			hint: `Manual recovery: sqlite3 "${dbPath}" ".recover" | sqlite3 "${dbPath}.manual"`,
		});
		for (const f of [recoveredPath, sqlDumpPath]) {
			if (existsSync(f)) {
				try {
					unlinkSync(f);
				} catch {}
			}
		}
		return false;
	}
}

/**
 * Periodic WAL checkpoint to prevent WAL file from growing unbounded.
 */
export function startWalCheckpointInterval(
	sqlite: Database,
	intervalMs = 5 * 60 * 1000,
): ReturnType<typeof setInterval> {
	return setInterval(() => {
		try {
			sqlite.run("PRAGMA wal_checkpoint(PASSIVE)");
		} catch (err) {
			logger.warn("Periodic WAL checkpoint failed", { error: String(err) });
		}
	}, intervalMs);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
