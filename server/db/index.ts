import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	checkIntegrity,
	optimizeDatabase,
	quickCheck,
	recoverWithCli,
	startWalCheckpointInterval,
	tryWalRecovery,
} from "../lib/db-resilience";
import { hotOnce, hotSafe, hotTimer } from "../lib/hot-safe";
import { acquireInstanceLock, releaseInstanceLock } from "../lib/instance-lock";
import { logger } from "../lib/logger";
import { getDbPath, openDatabase } from "./connection";
import { ensureColumns } from "./ensure-columns";
import { consumeCleanShutdownState, ensureFts, markCleanShutdown } from "./fts";
import { migrateLegacyNarratorDraftTraits } from "./migrate-narrator-drafts";
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

// Consume the previous process' marker before any startup mutation. If this process crashes
// during migrations/backfills/FTS setup, the next startup must not reuse a stale clean marker.
const { wasClean } = consumeCleanShutdownState(sqlite);

// Startup integrity check — detect corruption early.
// Both `PRAGMA quick_check` and `integrity_check` scan the whole DB and block the main thread
// (bun:sqlite is synchronous). We minimize that cost on two axes:
//   1) Skip entirely when the previous shutdown was clean: WAL + synchronous=NORMAL guarantees
//      committed data survives an app crash, and a clean marker means we wrote it on graceful
//      exit — so the on-disk state is trustworthy.
//   2) After an unclean shutdown (crash / SIGKILL / taskkill / power loss), run the CHEAPER
//      `quick_check` first. It performs the same page/structure checks as `integrity_check` but
//      skips the most expensive step (verifying index content matches table content), so it is
//      typically several times faster on a large DB. Only escalate to the full `integrity_check`
//      + recovery flow when quick_check fails, or when explicitly forced via env.
// The runtime malformed-error recovery path (recoverWithCli, below) remains as the safety net
// for the rare corruption that quick_check does not catch.
const forceFullIntegrityCheck = process.env.NARRAFORK_DB_FULL_INTEGRITY_CHECK === "1";
if ((wasClean || isHotReload) && !forceFullIntegrityCheck) {
	logger.info("Startup integrity check skipped", {
		reason: isHotReload ? "hot_reload" : "clean_shutdown",
	});
} else {
	const checkStartedAt = Date.now();
	const checkKind = forceFullIntegrityCheck ? "integrity_check" : "quick_check";
	logger.info("Startup database integrity check running (unclean shutdown)", {
		check: checkKind,
		reason: forceFullIntegrityCheck ? "forced" : "unclean_shutdown",
	});
	// quick_check on the unclean path; full integrity_check only when forced.
	const initial = forceFullIntegrityCheck ? checkIntegrity(sqlite) : quickCheck(sqlite);
	logger.info("Startup database integrity check completed", {
		check: checkKind,
		ok: initial.ok,
		durationMs: Date.now() - checkStartedAt,
	});
	if (!initial.ok) {
		logger.error("Database integrity check failed on startup — attempting recovery", {
			details: initial.details,
		});
		const walOk = tryWalRecovery(sqlite);
		// After a failed quick_check + WAL recovery, confirm with the authoritative full
		// integrity_check before deciding the DB is healthy (quick_check alone may under-report).
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

// Idempotent backfill: populate handle_fold for named narrators that predate the
// case-insensitive handle model. Legacy handles were already stored lowercase, so
// lower(handle) is a safe, non-conflicting fold. NFC differences don't apply to
// the ASCII-only legacy handles. Only touches rows where the fold is still unset.
try {
	const fixHandleFold = sqlite
		.prepare(
			`UPDATE narrators SET handle_fold = lower(handle)
			 WHERE handle IS NOT NULL AND handle_fold IS NULL`,
		)
		.run();
	if (fixHandleFold.changes > 0) {
		logger.info("Backfilled handle_fold for named narrators", {
			count: fixHandleFold.changes,
		});
	}
} catch (err) {
	// Non-fatal: never block startup on an optional backfill.
	logger.warn("handle_fold backfill failed (non-fatal)", { error: String(err) });
}

// One-time privacy migration: move narrator-wide composer drafts into per-user rows and
// remove every legacy encoded draft trait so it can no longer leak through shared state.
// The migration is atomic (single transaction) and idempotent, so a transient failure is
// safe to retry on the next boot. Never block startup on it — but log loudly (error, not
// warn) because a persistent failure means the legacy cross-account draft leak survives.
try {
	const result = migrateLegacyNarratorDraftTraits(sqlite);
	if (result.migrated > 0 || result.discarded > 0) {
		logger.info("Migrated legacy narrator draft traits", { ...result });
	}
} catch (err) {
	logger.error("Legacy narrator draft migration failed (privacy leak may persist)", {
		error: String(err),
	});
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
ensureFts(sqlite, {
	skipUncleanShutdownRebuild: isHotReload,
});
dbLifecycle.initialized = true;

// Refresh query-planner statistics once on a real startup (skip hot reloads — the stats
// are process-independent and this avoids redundant work on every --hot cycle). Bounded
// by analysis_limit so it stays fast even on large tables.
if (!isHotReload) {
	optimizeDatabase(sqlite);
}

// Periodic WAL checkpoint to prevent WAL file bloat and reduce corruption risk.
// hotTimer clears the previous interval on Bun --hot reloads before creating a new one.
const walCheckpointTimer = hotTimer("narrafork.walCheckpointTimer", () =>
	startWalCheckpointInterval(sqlite),
);
dbLifecycle.walCheckpointTimer = walCheckpointTimer;

/**
 * Persist the clean-shutdown marker (application_id + WAL checkpoint) and release the instance
 * lock. This is intentionally the only marker-writing path: callers must invoke it only after
 * request drain and every teardown step have succeeded. Returns whether the marker was durable.
 */
export function markDatabaseCleanShutdown(): boolean {
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
		return dbLifecycle.cleanMarked;
	} catch (err) {
		logger.warn("Failed to mark database clean shutdown", { error: String(err) });
		return false;
	} finally {
		releaseInstanceLock();
	}
}

/**
 * Release the instance lock WITHOUT writing the clean-shutdown marker.
 *
 * Used on the degraded graceful-shutdown path (a teardown step timed out or failed, or requests
 * never drained). We still stop the WAL checkpoint timer and release the lock so an update-handoff
 * replacement can start, but we deliberately leave the clean marker unset so the next startup runs
 * its integrity check rather than trusting a shutdown we could not prove was consistent.
 */
export function releaseDatabaseInstanceLockOnly(): void {
	if (dbLifecycle.walCheckpointTimer) {
		clearInterval(dbLifecycle.walCheckpointTimer);
		dbLifecycle.walCheckpointTimer = undefined;
	}
	releaseInstanceLock();
}

// Clean up on process exit — hotOnce prevents duplicate handler accumulation on hot reloads.
if (hotOnce("narrafork.walExitHandler")) {
	process.on("exit", () => {
		// Do NOT write the clean-shutdown marker here. The marker asserts "teardown fully
		// completed", which a bare process exit cannot guarantee: this handler also fires after a
		// crash, a forced process.exit(), or a degraded graceful shutdown. Writing it
		// unconditionally would let the next startup skip its integrity check even when the DB was
		// left in an unknown state. Only the graceful-shutdown path decides — after requests drain
		// and every teardown step succeeds — to persist the marker. Here we merely guarantee the
		// instance lock is released so a replacement can start.
		releaseDatabaseInstanceLockOnly();
	});
}

export const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
export { sqlite };
