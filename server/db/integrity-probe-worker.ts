/**
 * Out-of-process database integrity probe.
 *
 * Runs `PRAGMA quick_check` / `integrity_check` on a READ-ONLY connection in its own process, so
 * the multi-minute full-database scan never blocks the server's single JS thread (bun:sqlite is
 * synchronous). The parent spawns this with {@link DB_INTEGRITY_WORKER_FLAG} and reads the report
 * from stdout.
 *
 * Deliberately imports nothing from the app: no logger, no settings, no DB layer. Any of those
 * would open the database read-write, defeating the point of an isolated probe.
 */

import { Database } from "bun:sqlite";
import {
	DB_INTEGRITY_MODE_ENV,
	DB_INTEGRITY_PATH_ENV,
	encodeIntegrityReport,
	type IntegrityProbeMode,
	type IntegrityProbeReport,
} from "./integrity-protocol";

function runProbe(): IntegrityProbeReport {
	const startedAt = Date.now();
	const mode: IntegrityProbeMode = process.env[DB_INTEGRITY_MODE_ENV] === "full" ? "full" : "quick";
	const dbPath = process.env[DB_INTEGRITY_PATH_ENV]?.trim();

	if (!dbPath) {
		return {
			status: "unavailable",
			mode,
			details: `${DB_INTEGRITY_PATH_ENV} is not set`,
			durationMs: Date.now() - startedAt,
		};
	}

	let db: Database | undefined;
	try {
		// Read-only: the probe must never write, checkpoint, or take the write lock. The server
		// process keeps running with its own read-write connection while this scans.
		db = new Database(dbPath, { readonly: true });
	} catch (err) {
		return {
			status: "unavailable",
			mode,
			details: `failed to open database read-only: ${err instanceof Error ? err.message : String(err)}`,
			durationMs: Date.now() - startedAt,
		};
	}

	try {
		const pragma = mode === "full" ? "integrity_check" : "quick_check";
		const rows = db.prepare(`PRAGMA ${pragma}`).all() as Record<string, unknown>[];
		const messages = rows
			.map((row) => String(row[pragma] ?? Object.values(row)[0] ?? ""))
			.filter((value) => value.length > 0);
		const ok = messages.length === 1 && messages[0] === "ok";
		return {
			status: ok ? "ok" : "corrupt",
			mode,
			// Bound the payload: integrity_check can emit thousands of lines on a wrecked DB.
			details: ok ? "ok" : messages.slice(0, 20).join("; ").slice(0, 2000),
			durationMs: Date.now() - startedAt,
		};
	} catch (err) {
		// A throw here means SQLite itself refused to read the file (malformed image, I/O error).
		return {
			status: "corrupt",
			mode,
			details: err instanceof Error ? err.message : String(err),
			durationMs: Date.now() - startedAt,
		};
	} finally {
		try {
			db?.close();
		} catch {
			// best effort
		}
	}
}

console.log(encodeIntegrityReport(runProbe()));
process.exit(0);
