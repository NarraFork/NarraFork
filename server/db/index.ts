import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	checkIntegrity,
	recoverWithCli,
	startWalCheckpointInterval,
	tryWalRecovery,
} from "../lib/db-resilience";
import { hotOnce, hotTimer } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { getDbPath, openDatabase } from "./connection";
import { ensureColumns } from "./ensure-columns";
import { ensureFts } from "./fts";
import * as relations from "./relations";
import { runMigrations } from "./run-migrations";
import * as schema from "./schema";

const dbPath = getDbPath();

let sqlite = openDatabase();

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

// FTS5 virtual tables and triggers — managed outside Drizzle (which doesn't support FTS5)
ensureFts(sqlite);

// Periodic WAL checkpoint to prevent WAL file bloat and reduce corruption risk.
// hotTimer clears the previous interval on Bun --hot reloads before creating a new one.
const walCheckpointTimer = hotTimer("narrafork.walCheckpointTimer", () =>
	startWalCheckpointInterval(sqlite),
);

// Clean up on process exit — hotOnce prevents duplicate handler accumulation on hot reloads.
if (hotOnce("narrafork.walExitHandler")) {
	process.on("exit", () => {
		clearInterval(walCheckpointTimer);
		try {
			sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)");
			// Mark clean shutdown so next startup can skip FTS rebuild
			sqlite.run("PRAGMA application_id = 0x4E465243"); // "NFRC" = NarraFork Clean
		} catch {
			// best-effort on exit
		}
	});
}

export const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
export { sqlite };
