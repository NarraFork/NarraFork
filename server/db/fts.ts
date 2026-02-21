import type { Database } from "bun:sqlite";
import { logger } from "../lib/logger";

const CLEAN_SHUTDOWN_MARKER = 0x4e465243; // "NFRC" = NarraFork Clean

/**
 * Ensure FTS5 virtual tables and sync triggers exist.
 *
 * Drizzle doesn't support FTS5, so these are managed separately.
 * All statements use IF NOT EXISTS / DROP-then-CREATE to be idempotent.
 * Old non-trigram FTS tables are detected and recreated.
 */
export function ensureFts(sqlite: Database): { rebuilt: boolean } {
	// Guard: skip if base tables don't exist yet (fresh DB before first migration)
	const hasBaseTables = sqlite
		.prepare(
			"SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name IN ('chapters','narrators','narrator_messages')",
		)
		.get() as { c: number };

	if (hasBaseTables.c !== 3) {
		return { rebuilt: false };
	}

	// Detect and drop old non-trigram FTS tables so they get recreated correctly
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

	// --- Virtual tables ---
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

	// --- Sync triggers: chapters ---
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

	// --- Sync triggers: narrator_messages ---
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

	// --- Sync triggers: narrators ---
	sqlite.run(`
		CREATE TRIGGER IF NOT EXISTS narrators_fts_insert AFTER INSERT ON narrators
		WHEN NEW.title IS NOT NULL BEGIN
			INSERT INTO narrators_fts(rowid, title) VALUES (NEW.rowid, NEW.title);
		END
	`);
	// narrators_fts_update needs DROP+CREATE to handle the complex WHEN clause update
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

	// --- Rebuild FTS indexes if needed ---
	// Rebuild after migration (tokenizer change) or unclean shutdown (trigram indexes
	// can silently corrupt on crash, causing "malformed" errors on UPDATE).
	const appId =
		(sqlite.prepare("PRAGMA application_id").get() as { application_id: number } | undefined)
			?.application_id ?? 0;
	const needsRebuild = ftsTablesRecreated.length > 0 || appId !== CLEAN_SHUTDOWN_MARKER;

	if (needsRebuild) {
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

	return { rebuilt: needsRebuild };
}
