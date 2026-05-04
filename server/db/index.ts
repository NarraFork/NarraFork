import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	checkIntegrity,
	recoverWithCli,
	startWalCheckpointInterval,
	tryWalRecovery,
} from "../lib/db-resilience";
import { hotOnce, hotSafe, hotTimer } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { getDbPath, openDatabase } from "./connection";
import { ensureColumns } from "./ensure-columns";
import { ensureFts, markCleanShutdown } from "./fts";
import * as relations from "./relations";
import { runMigrations } from "./run-migrations";
import * as schema from "./schema";

const dbPath = getDbPath();

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

// Startup integrity check — detect corruption early
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

// FTS5 virtual tables and triggers — managed outside Drizzle (which doesn't support FTS5)
ensureFts(sqlite, { skipUncleanShutdownRebuild: isHotReload });
dbLifecycle.initialized = true;

// Periodic WAL checkpoint to prevent WAL file bloat and reduce corruption risk.
// hotTimer clears the previous interval on Bun --hot reloads before creating a new one.
const walCheckpointTimer = hotTimer("narrafork.walCheckpointTimer", () =>
	startWalCheckpointInterval(sqlite),
);
dbLifecycle.walCheckpointTimer = walCheckpointTimer;

export function markDatabaseCleanShutdown(): void {
	if (dbLifecycle.cleanMarked) return;
	if (dbLifecycle.walCheckpointTimer) clearInterval(dbLifecycle.walCheckpointTimer);
	const currentSqlite = dbLifecycle.sqlite;
	if (!currentSqlite) return;
	try {
		markCleanShutdown(currentSqlite);
		dbLifecycle.cleanMarked = true;
	} catch (err) {
		logger.warn("Failed to mark database clean shutdown", { error: String(err) });
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
