import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	checkIntegrity,
	recoverWithCli,
	startWalCheckpointInterval,
	tryWalRecovery,
} from "../lib/db-resilience";
import { hotOnce, hotSafe, hotTimer } from "../lib/hot-safe";
import { acquireInstanceLock, releaseInstanceLock } from "../lib/instance-lock";
import { logger } from "../lib/logger";
import { getDbPath, openDatabase } from "./connection";
import { ensureColumns } from "./ensure-columns";
import { ensureFts, markCleanShutdown, readCleanShutdownState } from "./fts";
import * as relations from "./relations";
import { runMigrations } from "./run-migrations";
import * as schema from "./schema";

const dbPath = getDbPath();

acquireInstanceLock(dbPath);

let sqlite = openDatabase();

const dbLifecycle = hotSafe("narrafork.dbLifecycle", () => ({
	initialized: false,
	cleanMarked: false,
	sqlite: undefined as typeof sqlite | undefined,
	walCheckpointTimer: undefined as ReturnType<typeof setInterval> | undefined,
}));
const isHotReload = dbLifecycle.initialized;
dbLifecycle.sqlite = sqlite;
dbLifecycle.cleanMarked = false;

// Read the clean-shutdown marker BEFORE ensureFts resets it. This reflects how the
// previous process exited and gates the expensive startup integrity check below.
// ensureFts reads the same marker again to decide FTS rebuild — same value, consistent.
const { wasClean } = readCleanShutdownState(sqlite);

// Startup integrity check — detect corruption early.
// A full `PRAGMA integrity_check` scans the entire database and can take ~15s on a
// multi-GB DB, blocking the main thread (bun:sqlite is synchronous). Skip it when the
// previous shutdown was clean: WAL + synchronous=NORMAL guarantees committed data
// survives an app crash, and a clean marker means we wrote it on graceful exit. Only
// run the full check after an unclean shutdown (crash/SIGKILL) or when forced via env.
// The runtime malformed-error recovery path (recoverWithCli, below) remains as the
// safety net for the rare case of external/on-disk corruption.
const forceFullIntegrityCheck = process.env.NARRAFORK_DB_FULL_INTEGRITY_CHECK === "1";
if (wasClean && !forceFullIntegrityCheck) {
	logger.info("Startup integrity check skipped (clean shutdown marker present)");
} else {
	const integrity = checkIntegrity(sqlite);
	if (!integrity.ok) {
		logger.error("Database integrity check failed on startup — attempting recovery", {
			details: integrity.details,
		});
		const walOk = tryWalRecovery(sqlite);
		if (walOk && checkIntegrity(sqlite).ok) {
			logger.info("Database recovered after WAL checkpoint");
		} else {
			logger.warn("WAL recovery insufficient, attempting CLI .recover");
			sqlite.close();
			const recovered = recoverWithCli(dbPath);
			sqlite = openDatabase();
			dbLifecycle.sqlite = sqlite;
			if (recovered && checkIntegrity(sqlite).ok) {
				logger.info("Database recovered via sqlite3 CLI .recover");
			} else {
				logger.error("Automatic recovery failed — manual repair needed", {
					hint: `sqlite3 "${dbPath}" ".recover" | sqlite3 "${dbPath}.manual"`,
				});
			}
		}
	}
}

try {
	const migrationResult = await runMigrations(sqlite);
	if (migrationResult.source === "embedded") {
		logger.info("Database migrated from embedded migration data", {
			migrationsFolder: migrationResult.folder,
		});
	}
} catch (err) {
	logger.error("Database migration failed on startup", {
		error: String(err),
		stack: (err as Error)?.stack,
	});
	throw err;
}

// Patch missing columns for databases created by older versions
ensureColumns(sqlite);

// Migrate old narrator status values to new status + substatus model
{
	const migrations: [string, string, string][] = [
		// [oldStatus, newStatus, substatusJson]
		["thinking", "working", "[]"],
		["done", "idle", '["unread"]'],
		["error", "idle", '["error"]'],
		["interrupted", "idle", '["interrupted"]'],
		["suspended", "idle", '["suspended"]'],
	];
	for (const [oldStatus, newStatus, substatusJson] of migrations) {
		const result = sqlite
			.prepare("UPDATE narrators SET status = ?, substatus = ? WHERE status = ?")
			.run(newStatus, substatusJson, oldStatus);
		if (result.changes > 0) {
			logger.info(
				`Migrated ${result.changes} narrators from status "${oldStatus}" to "${newStatus}" + substatus ${substatusJson}`,
			);
		}
	}
}

// Idempotent backfill: ensure variant/traits are consistent with legacy fields.
// Handles databases where ensureColumns added the columns with defaults but
// the 0025 migration's data backfill never ran.
{
	// Normalize invalid traits values to valid JSON arrays.
	// ensureColumns may have added the column with DEFAULT '' instead of '[]'.
	const fixTraitsJson = sqlite
		.prepare(
			`UPDATE narrators SET traits = '[]'
			 WHERE traits IS NULL OR traits = '' OR json_valid(traits) = 0`,
		)
		.run();
	if (fixTraitsJson.changes > 0) {
		logger.info("Normalized invalid traits JSON to empty array", {
			count: fixTraitsJson.changes,
		});
	}

	const fixSubstatusJson = sqlite
		.prepare(
			`UPDATE narrators SET substatus = '[]'
			 WHERE substatus IS NULL OR substatus = '' OR json_valid(substatus) = 0`,
		)
		.run();
	if (fixSubstatusJson.changes > 0) {
		logger.info("Normalized invalid substatus JSON to empty array", {
			count: fixSubstatusJson.changes,
		});
	}

	// 1. Fix subagent variant: type='subagent' but variant still 'primary'
	const fixVariant = sqlite
		.prepare(
			`UPDATE narrators SET variant = 'subagent:' || COALESCE(subagent_type, 'general')
			 WHERE type = 'subagent' AND (variant = 'primary' OR variant = '' OR variant IS NULL)`,
		)
		.run();
	if (fixVariant.changes > 0) {
		logger.info("Backfilled subagent variant from legacy type+subagent_type", {
			count: fixVariant.changes,
		});
	}

	// 2. Ensure standalone trait for narrators without a chapter
	const fixStandalone = sqlite
		.prepare(
			`UPDATE narrators SET traits = CASE
				WHEN traits = '[]' THEN '["standalone"]'
				WHEN traits LIKE '%]' THEN SUBSTR(traits, 1, LENGTH(traits) - 1) || ',"standalone"]'
				ELSE '["standalone"]'
			 END
			 WHERE chapter_id IS NULL
			   AND traits NOT LIKE '%"standalone"%'`,
		)
		.run();
	if (fixStandalone.changes > 0) {
		logger.info("Backfilled standalone trait for chapter-less narrators", {
			count: fixStandalone.changes,
		});
	}

	// 3. Ensure background trait for narrators with is_background=1
	const fixBg = sqlite
		.prepare(
			`UPDATE narrators SET traits = CASE
				WHEN traits = '[]' THEN '["background"]'
				WHEN traits LIKE '%]' THEN SUBSTR(traits, 1, LENGTH(traits) - 1) || ',"background"]'
				ELSE '["background"]'
			 END
			 WHERE is_background = 1 AND traits NOT LIKE '%"background"%'`,
		)
		.run();
	if (fixBg.changes > 0) {
		logger.info("Backfilled background trait from is_background flag", {
			count: fixBg.changes,
		});
	}

	// 4. Ensure ask-in-passing trait for narrators with is_ask_in_passing=1
	const fixAip = sqlite
		.prepare(
			`UPDATE narrators SET traits = CASE
				WHEN traits = '[]' THEN '["ask-in-passing"]'
				WHEN traits LIKE '%]' THEN SUBSTR(traits, 1, LENGTH(traits) - 1) || ',"ask-in-passing"]'
				ELSE '["ask-in-passing"]'
			 END
			 WHERE is_ask_in_passing = 1 AND traits NOT LIKE '%"ask-in-passing"%'`,
		)
		.run();
	if (fixAip.changes > 0) {
		logger.info("Backfilled ask-in-passing trait from is_ask_in_passing flag", {
			count: fixAip.changes,
		});
	}
}

// Knowledge base seed: default classification levels + builtin tag types.
// Idempotent — only inserts when the respective table is empty, so user edits are never overwritten.
try {
	const hasKTables = (
		sqlite
			.prepare(
				"SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name IN ('knowledge_levels','knowledge_tag_types')",
			)
			.get() as { c: number }
	).c;
	if (hasKTables === 2) {
		const nowIso = new Date().toISOString();
		const levelCount = (
			sqlite.prepare("SELECT COUNT(*) AS c FROM knowledge_levels").get() as { c: number }
		).c;
		if (levelCount === 0) {
			const insLevel = sqlite.prepare(
				"INSERT INTO knowledge_levels (id, name, rank, label, created_at) VALUES (?, ?, ?, ?, ?)",
			);
			const seedLevels: [string, string, number, string][] = [
				["klvl_public", "public", 0, "Public"],
				["klvl_internal", "internal", 10, "Internal"],
				["klvl_confidential", "confidential", 20, "Confidential"],
				["klvl_secret", "secret", 30, "Secret"],
			];
			for (const [id, name, rank, label] of seedLevels) insLevel.run(id, name, rank, label, nowIso);
			logger.info("Seeded default knowledge classification levels", { count: seedLevels.length });
		}
		const typeCount = (
			sqlite.prepare("SELECT COUNT(*) AS c FROM knowledge_tag_types").get() as { c: number }
		).c;
		if (typeCount === 0) {
			const insType = sqlite.prepare(
				"INSERT INTO knowledge_tag_types (id, name, builtin, sort_order, created_at) VALUES (?, ?, 1, ?, ?)",
			);
			const seedTypes: [string, string, number][] = [
				["ktt_org", "组织", 0],
				["ktt_position", "岗位", 1],
				["ktt_permission", "权限", 2],
				["ktt_other", "其他", 3],
			];
			for (const [id, name, sort] of seedTypes) insType.run(id, name, sort, nowIso);
			logger.info("Seeded builtin knowledge tag types", { count: seedTypes.length });
		}
	}
} catch (err) {
	logger.warn("Knowledge base seed failed (non-fatal)", { error: String(err) });
}

// FTS5 virtual tables and triggers — managed outside Drizzle (which doesn't support FTS5)
ensureFts(sqlite, { skipUncleanShutdownRebuild: isHotReload });
dbLifecycle.initialized = true;

// Periodic WAL checkpoint to prevent WAL file bloat and reduce corruption risk.
// hotTimer clears the previous interval on Bun --hot reloads before creating a new one.
const walCheckpointTimer = hotTimer("narrafork.walCheckpointTimer", () =>
	startWalCheckpointInterval(sqlite),
);
dbLifecycle.walCheckpointTimer = walCheckpointTimer;

/**
 * Write the clean-shutdown marker (application_id + WAL checkpoint) WITHOUT
 * releasing the instance lock. Idempotent via dbLifecycle.cleanMarked.
 *
 * Call this EARLY in the graceful-shutdown sequence — before the terminal/MCP/
 * browser teardown awaits that can hang — so the marker is persisted even if a
 * later step stalls and the process is force-killed. The instance lock stays held
 * (the DB may still be written by teardown, and an update-handoff replacement is
 * waiting on the lock), and is released later by markDatabaseCleanShutdown().
 */
export function markDatabaseCleanShutdownEarly(): void {
	if (dbLifecycle.walCheckpointTimer) {
		clearInterval(dbLifecycle.walCheckpointTimer);
		dbLifecycle.walCheckpointTimer = undefined;
	}
	const currentSqlite = dbLifecycle.sqlite;
	try {
		if (!dbLifecycle.cleanMarked && currentSqlite) {
			markCleanShutdown(currentSqlite);
			dbLifecycle.cleanMarked = true;
		}
	} catch (err) {
		logger.warn("Failed to mark database clean shutdown (early)", { error: String(err) });
	}
}

export function markDatabaseCleanShutdown(): void {
	try {
		markDatabaseCleanShutdownEarly();
	} finally {
		releaseInstanceLock();
	}
}

// Clean up on process exit — hotOnce prevents duplicate handler accumulation on hot reloads.
if (hotOnce("narrafork.walExitHandler")) {
	process.on("exit", () => {
		markDatabaseCleanShutdown();
	});
}

export const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
export { sqlite };
