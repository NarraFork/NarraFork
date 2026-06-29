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
export function markCleanShutdown(sqlite: Database): void {
	// Set the marker before checkpointing so the marker itself is flushed out of WAL.
	sqlite.run(`PRAGMA application_id = ${CLEAN_SHUTDOWN_MARKER}`);
	sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)");
}

export function ensureFts(
	sqlite: Database,
	options: { skipUncleanShutdownRebuild?: boolean } = {},
): { rebuilt: boolean } {
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
	for (const table of [
		"chapters_fts",
		"narrator_messages_fts",
		"narrators_fts",
		"knowledge_drafts_fts",
	]) {
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

	// knowledge_entries_fts is created conditionally — the table may not exist yet on
	// older databases that haven't run the knowledge-base migration. Guarded below.
	const hasKnowledgeEntries =
		(
			sqlite
				.prepare(
					"SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='knowledge_entries'",
				)
				.get() as { c: number }
		).c === 1;
	if (hasKnowledgeEntries) {
		sqlite.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_entries_fts USING fts5(
				title, current_content, content='knowledge_entries', content_rowid=rowid, tokenize='trigram'
			)
		`);
	}

	// knowledge_drafts_fts indexes each author's personal draft (title + content) so the
	// agent's KnowledgeSearch can surface a user's own uncommitted edits ("working copy").
	// NOT an external-content table: the FTS rowid is bound to knowledge_drafts.rowid so all
	// trigger maintenance is by rowid (O(log n)), never a scan over UNINDEXED columns.
	// `title` is de-normalized from the parent entry (drafts only edit content, not title)
	// and kept in sync by an entries-title trigger below.
	const hasKnowledgeDrafts =
		(
			sqlite
				.prepare(
					"SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='knowledge_drafts'",
				)
				.get() as { c: number }
		).c === 1;
	// Track whether the drafts FTS table is being created for the first time so it gets
	// populated even on a clean startup (a brand-new empty FTS table won't otherwise be
	// caught by the unclean-shutdown rebuild path).
	let draftsFtsFreshlyCreated = false;
	if (hasKnowledgeDrafts) {
		const draftsFtsExists =
			(
				sqlite
					.prepare(
						"SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='knowledge_drafts_fts'",
					)
					.get() as { c: number }
			).c === 1;
		draftsFtsFreshlyCreated = !draftsFtsExists;
		sqlite.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_drafts_fts USING fts5(
				title, content, tokenize='trigram'
			)
		`);
	}

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

	// --- Sync triggers: knowledge_entries (title + current_content) ---
	if (hasKnowledgeEntries) {
		sqlite.run(`
			CREATE TRIGGER IF NOT EXISTS knowledge_entries_fts_insert AFTER INSERT ON knowledge_entries BEGIN
				INSERT INTO knowledge_entries_fts(rowid, title, current_content)
				VALUES (NEW.rowid, NEW.title, NEW.current_content);
			END
		`);
		sqlite.run(`
			CREATE TRIGGER IF NOT EXISTS knowledge_entries_fts_update AFTER UPDATE ON knowledge_entries BEGIN
				INSERT INTO knowledge_entries_fts(knowledge_entries_fts, rowid, title, current_content)
				VALUES ('delete', OLD.rowid, OLD.title, OLD.current_content);
				INSERT INTO knowledge_entries_fts(rowid, title, current_content)
				VALUES (NEW.rowid, NEW.title, NEW.current_content);
			END
		`);
		sqlite.run(`
			CREATE TRIGGER IF NOT EXISTS knowledge_entries_fts_delete AFTER DELETE ON knowledge_entries BEGIN
				INSERT INTO knowledge_entries_fts(knowledge_entries_fts, rowid, title, current_content)
				VALUES ('delete', OLD.rowid, OLD.title, OLD.current_content);
			END
		`);
	}

	// --- Sync triggers: knowledge_drafts (rowid-bound; title de-normalized from entry) ---
	if (hasKnowledgeDrafts) {
		// INSERT: index the new draft, pulling title from its parent entry.
		sqlite.run(`
			CREATE TRIGGER IF NOT EXISTS knowledge_drafts_fts_insert AFTER INSERT ON knowledge_drafts BEGIN
				INSERT INTO knowledge_drafts_fts(rowid, title, content)
				VALUES (
					NEW.rowid,
					(SELECT title FROM knowledge_entries WHERE id = NEW.entry_id),
					NEW.content
				);
			END
		`);
		// UPDATE: delete+reinsert by rowid (content may change; title re-pulled in case
		// the draft was somehow re-pointed — cheap and keeps it correct).
		sqlite.run(`
			CREATE TRIGGER IF NOT EXISTS knowledge_drafts_fts_update AFTER UPDATE ON knowledge_drafts BEGIN
				DELETE FROM knowledge_drafts_fts WHERE rowid = OLD.rowid;
				INSERT INTO knowledge_drafts_fts(rowid, title, content)
				VALUES (
					NEW.rowid,
					(SELECT title FROM knowledge_entries WHERE id = NEW.entry_id),
					NEW.content
				);
			END
		`);
		// DELETE: drop the indexed row by rowid.
		sqlite.run(`
			CREATE TRIGGER IF NOT EXISTS knowledge_drafts_fts_delete AFTER DELETE ON knowledge_drafts BEGIN
				DELETE FROM knowledge_drafts_fts WHERE rowid = OLD.rowid;
			END
		`);
		// entry title change → refresh de-normalized title on all its drafts. The subquery
		// resolves rowids via idx_kd_entry (entry_id B-tree), then updates by rowid.
		if (hasKnowledgeEntries) {
			sqlite.run(`
				CREATE TRIGGER IF NOT EXISTS knowledge_drafts_fts_entry_title AFTER UPDATE OF title ON knowledge_entries BEGIN
					UPDATE knowledge_drafts_fts
					SET title = NEW.title
					WHERE rowid IN (SELECT rowid FROM knowledge_drafts WHERE entry_id = NEW.id);
				END
			`);
		}
	}

	// --- Rebuild FTS indexes if needed ---
	// Rebuild after migration (tokenizer change) or unclean shutdown (trigram indexes
	// can silently corrupt on crash, causing "malformed" errors on UPDATE).
	const appId =
		(sqlite.prepare("PRAGMA application_id").get() as { application_id: number } | undefined)
			?.application_id ?? 0;
	const needsRebuild =
		ftsTablesRecreated.length > 0 ||
		(!options.skipUncleanShutdownRebuild && appId !== CLEAN_SHUTDOWN_MARKER);

	if (needsRebuild) {
		try {
			sqlite.run("INSERT INTO narrators_fts(narrators_fts) VALUES ('rebuild')");
			sqlite.run("INSERT INTO chapters_fts(chapters_fts) VALUES ('rebuild')");
			sqlite.run("INSERT INTO narrator_messages_fts(narrator_messages_fts) VALUES ('rebuild')");
			if (hasKnowledgeEntries) {
				sqlite.run("INSERT INTO knowledge_entries_fts(knowledge_entries_fts) VALUES ('rebuild')");
			}
			logger.info("FTS indexes rebuilt on startup", {
				reason: ftsTablesRecreated.length > 0 ? "migration" : "unclean_shutdown",
			});
		} catch (err) {
			logger.warn("FTS rebuild failed on startup", { error: String(err) });
		}
	}

	// Populate knowledge_drafts_fts when rebuilding OR when the table was just created
	// (a brand-new empty table on a clean startup isn't covered by needsRebuild). It is a
	// plain (non external-content) FTS table, so 'rebuild' is unavailable — refill manually
	// with rowid bound to knowledge_drafts.rowid and title de-normalized from the entry.
	if (hasKnowledgeDrafts && (needsRebuild || draftsFtsFreshlyCreated)) {
		try {
			sqlite.run("DELETE FROM knowledge_drafts_fts");
			sqlite.run(`
				INSERT INTO knowledge_drafts_fts(rowid, title, content)
				SELECT d.rowid, e.title, d.content
				FROM knowledge_drafts d
				JOIN knowledge_entries e ON e.id = d.entry_id
			`);
		} catch (err) {
			logger.warn("knowledge_drafts_fts populate failed on startup", { error: String(err) });
		}
	}

	// Clear the clean shutdown marker — it will be set again on clean exit.
	// During Bun --hot reloads, skipUncleanShutdownRebuild prevents this running
	// process from being misclassified as a crashed previous process.
	sqlite.run("PRAGMA application_id = 0");

	return { rebuilt: needsRebuild };
}
