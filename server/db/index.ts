import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	checkIntegrity,
	recoverWithCli,
	startWalCheckpointInterval,
	tryWalRecovery,
} from "../lib/db-resilience";
import { logger } from "../lib/logger";
import * as relations from "./relations";
import * as schema from "./schema";

const narraforkDir = resolve(homedir(), ".narrafork");
mkdirSync(narraforkDir, { recursive: true });

const dbPath = resolve(narraforkDir, "narrafork.db");

function openDatabase(): Database {
	const conn = new Database(dbPath);
	conn.run("PRAGMA journal_mode = WAL");
	conn.run("PRAGMA foreign_keys = ON");
	conn.run("PRAGMA busy_timeout = 5000");
	return conn;
}

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

// Periodic WAL checkpoint to prevent WAL file bloat and reduce corruption risk
const walCheckpointTimer = startWalCheckpointInterval(sqlite);

// Clean up on process exit
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

// FTS5 virtual tables for full-text search (Phase 5)
// Use trigram tokenizer for CJK (Chinese/Japanese/Korean) support
// Guard: skip FTS setup if base tables don't exist yet (fresh DB before migration)
const hasBaseTables = sqlite
	.prepare(
		"SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name IN ('chapters','narrators','narrator_messages')",
	)
	.get() as { c: number };

if (hasBaseTables.c === 3) {
	// Migrate: drop old default-tokenizer tables and recreate with trigram
	const ftsTablesRecreated: string[] = [];
	for (const table of ["chapters_fts", "narrator_messages_fts", "narrators_fts"]) {
		const info = sqlite
			.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
			.get(table) as { sql: string } | undefined;
		if (info && !info.sql.includes("trigram")) {
			sqlite.run(`DROP TABLE IF EXISTS ${table}`);
			ftsTablesRecreated.push(table);
		}
	}

	sqlite.run(`
	  CREATE VIRTUAL TABLE IF NOT EXISTS chapters_fts USING fts5(
	    title, description, content='chapters', content_rowid=rowid, tokenize='trigram'
	  )
	`);
	sqlite.run(`
	  CREATE VIRTUAL TABLE IF NOT EXISTS narrator_messages_fts USING fts5(
	    content_text, content='narrator_messages', content_rowid=rowid, tokenize='trigram'
	  )
	`);
	sqlite.run(`
	  CREATE VIRTUAL TABLE IF NOT EXISTS narrators_fts USING fts5(
	    title, content='narrators', content_rowid=rowid, tokenize='trigram'
	  )
	`);

	// FTS sync triggers — keep FTS index up to date with source tables
	sqlite.run(`
	  CREATE TRIGGER IF NOT EXISTS chapters_fts_insert AFTER INSERT ON chapters BEGIN
	    INSERT INTO chapters_fts(rowid, title, description)
	    VALUES (NEW.rowid, NEW.title, NEW.description);
	  END
	`);
	sqlite.run(`
	  CREATE TRIGGER IF NOT EXISTS chapters_fts_update AFTER UPDATE ON chapters BEGIN
	    INSERT INTO chapters_fts(chapters_fts, rowid, title, description)
	    VALUES ('delete', OLD.rowid, OLD.title, OLD.description);
	    INSERT INTO chapters_fts(rowid, title, description)
	    VALUES (NEW.rowid, NEW.title, NEW.description);
	  END
	`);
	sqlite.run(`
	  CREATE TRIGGER IF NOT EXISTS chapters_fts_delete AFTER DELETE ON chapters BEGIN
	    INSERT INTO chapters_fts(chapters_fts, rowid, title, description)
	    VALUES ('delete', OLD.rowid, OLD.title, OLD.description);
	  END
	`);
	sqlite.run(`
	  CREATE TRIGGER IF NOT EXISTS narrator_messages_fts_insert AFTER INSERT ON narrator_messages BEGIN
	    INSERT INTO narrator_messages_fts(rowid, content_text)
	    VALUES (NEW.rowid, NEW.content_text);
	  END
	`);
	sqlite.run(`
	  CREATE TRIGGER IF NOT EXISTS narrator_messages_fts_update AFTER UPDATE ON narrator_messages BEGIN
	    INSERT INTO narrator_messages_fts(narrator_messages_fts, rowid, content_text)
	    VALUES ('delete', OLD.rowid, OLD.content_text);
	    INSERT INTO narrator_messages_fts(rowid, content_text)
	    VALUES (NEW.rowid, NEW.content_text);
	  END
	`);
	sqlite.run(`
	  CREATE TRIGGER IF NOT EXISTS narrator_messages_fts_delete AFTER DELETE ON narrator_messages BEGIN
	    INSERT INTO narrator_messages_fts(narrator_messages_fts, rowid, content_text)
	    VALUES ('delete', OLD.rowid, OLD.content_text);
	  END
	`);
	sqlite.run(`
	  CREATE TRIGGER IF NOT EXISTS narrators_fts_insert AFTER INSERT ON narrators
	  WHEN NEW.title IS NOT NULL BEGIN
	    INSERT INTO narrators_fts(rowid, title) VALUES (NEW.rowid, NEW.title);
	  END
	`);
	sqlite.run("DROP TRIGGER IF EXISTS narrators_fts_update");
	sqlite.run(`
	  CREATE TRIGGER narrators_fts_update AFTER UPDATE OF title ON narrators
	  WHEN OLD.title IS NOT NULL OR NEW.title IS NOT NULL BEGIN
	    INSERT INTO narrators_fts(narrators_fts, rowid, title)
	    SELECT 'delete', OLD.rowid, OLD.title WHERE OLD.title IS NOT NULL;
	    INSERT OR IGNORE INTO narrators_fts(rowid, title)
	    SELECT NEW.rowid, NEW.title WHERE NEW.title IS NOT NULL;
	  END
	`);
	sqlite.run(`
	  CREATE TRIGGER IF NOT EXISTS narrators_fts_delete AFTER DELETE ON narrators
	  WHEN OLD.title IS NOT NULL BEGIN
	    INSERT INTO narrators_fts(narrators_fts, rowid, title)
	    VALUES ('delete', OLD.rowid, OLD.title);
	  END
	`);

	// Rebuild FTS indexes only after migration or unclean shutdown
	// (FTS trigram indexes can silently corrupt on crash, causing "malformed" errors on UPDATE)
	const CLEAN_SHUTDOWN_MARKER = 0x4e465243; // "NFRC"
	const appId =
		(sqlite.prepare("PRAGMA application_id").get() as { application_id: number } | undefined)
			?.application_id ?? 0;
	const needsFtsRebuild = ftsTablesRecreated.length > 0 || appId !== CLEAN_SHUTDOWN_MARKER;

	if (needsFtsRebuild) {
		try {
			sqlite.run("INSERT INTO narrators_fts(narrators_fts) VALUES ('rebuild')");
			sqlite.run("INSERT INTO chapters_fts(chapters_fts) VALUES ('rebuild')");
			sqlite.run("INSERT INTO narrator_messages_fts(narrator_messages_fts) VALUES ('rebuild')");
			logger.info("FTS indexes rebuilt on startup", {
				reason: ftsTablesRecreated.length > 0 ? "migration" : "unclean_shutdown",
			});
		} catch (err) {
			logger.warn("FTS rebuild failed on startup", { error: String(err) });
		}
	}

	// Clear the clean shutdown marker — it will be set again on clean exit
	sqlite.run("PRAGMA application_id = 0");

	// Index for efficient subagent child message lookups
	sqlite.run(`
	  CREATE INDEX IF NOT EXISTS idx_messages_parent_tool_use
	  ON narrator_messages(narrator_id, parent_tool_use_id)
	`);
}

export const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
export { sqlite };
