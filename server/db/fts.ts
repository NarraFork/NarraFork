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
	// Step 1 (fast, correctness-critical): stamp the clean marker. Writing `application_id`
	// lands the marker in the WAL, which is sufficient — the next startup opens the DB and
	// replays the WAL, so the marker is read back even without a checkpoint into the main
	// file. This single PRAGMA is near-instant.
	sqlite.run(`PRAGMA application_id = ${CLEAN_SHUTDOWN_MARKER}`);
	// Step 2 (best-effort optimization only): truncate the WAL to bound its size. This is
	// NOT required for clean-shutdown detection. A large WAL can make TRUNCATE slow, and on
	// Windows the ~5s console-close (CTRL_CLOSE_EVENT) timeout can force-kill the process
	// mid-checkpoint; guarding it here ensures a stalled/failed checkpoint never invalidates
	// the marker written in step 1.
	try {
		sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)");
	} catch (err) {
		logger.warn("Clean-shutdown WAL checkpoint failed (marker already persisted)", {
			error: String(err),
		});
	}
}

/**
 * Read the clean-shutdown marker WITHOUT resetting it.
 *
 * Must be called before {@link ensureFts}, which resets `application_id` to 0
 * after deciding whether to rebuild the FTS indexes. The value read here reflects
 * how the *previous* process exited: `wasClean === true` means the last run wrote
 * the clean marker on graceful shutdown (so the DB and FTS indexes are trustworthy
 * and the expensive startup integrity check can be skipped).
 */
export function readCleanShutdownState(sqlite: Database): { wasClean: boolean } {
	const appId =
		(sqlite.prepare("PRAGMA application_id").get() as { application_id: number } | undefined)
			?.application_id ?? 0;
	return { wasClean: appId === CLEAN_SHUTDOWN_MARKER };
}

/**
 * Read the clean-shutdown marker AND reset it atomically.
 *
 * This ensures that if the process crashes after this point, the next startup
 * will see `wasClean: false` (the marker is consumed). Call this once at startup
 * before any mutations.
 */
export function consumeCleanShutdownState(sqlite: Database): { wasClean: boolean } {
	const result = readCleanShutdownState(sqlite);
	// Reset immediately so a crash after this point leaves the DB in "unclean" state.
	sqlite.run("PRAGMA application_id = 0");
	return result;
}

/** Env flag: force the old behavior of unconditionally rebuilding every FTS index after an
 * unclean shutdown (bypasses the cheaper 'integrity-check' probe). Escape hatch for the rare
 * case where the probe misses a corruption that the full rebuild would have fixed. */
const FORCE_FULL_FTS_REBUILD =
	process.env.NARRAFORK_DB_FULL_INTEGRITY_CHECK === "1" ||
	process.env.NARRAFORK_FTS_FULL_REBUILD === "1";

/**
 * Probe an external-content FTS5 table for corruption without rebuilding it.
 *
 * `INSERT INTO <t>(<t>) VALUES('integrity-check')` verifies that the FTS index is internally
 * consistent with its content table and that its b-tree structure is well-formed. It is far
 * cheaper than a full 'rebuild' (no re-tokenization of the whole corpus), so on the common case
 * — an unclean shutdown that did NOT actually corrupt the index — we skip the expensive rebuild.
 *
 * Returns `"ok"` when the probe passes, `"corrupt"` when it throws (SQLITE_CORRUPT_VTAB or a
 * "database disk image is malformed" style error), signalling the caller to rebuild that table.
 *
 * NOTE (safety trade-off): 'integrity-check' catches the vast majority of index/content
 * inconsistencies but is not a 100% guarantee against every edge-case corruption that could
 * later surface as a "malformed" error on UPDATE. The runtime safety net (recoverWithCli in
 * db-resilience.ts) still recovers such cases if they slip through, and its recovery path
 * recreates the FTS tables. Worst case is a delayed fix, not permanent data loss.
 */
function probeFtsIntegrity(sqlite: Database, table: string): "ok" | "corrupt" {
	try {
		sqlite.run(`INSERT INTO ${table}(${table}) VALUES ('integrity-check')`);
		return "ok";
	} catch (err) {
		logger.warn("FTS integrity probe failed — table will be rebuilt", {
			table,
			error: String(err),
		});
		return "corrupt";
	}
}

export function ensureFts(
	sqlite: Database,
	options: {
		skipUncleanShutdownRebuild?: boolean;
		/**
		 * How the previous process exited, as read by {@link consumeCleanShutdownState}.
		 *
		 * MUST be passed by the startup path. `consumeCleanShutdownState` resets `application_id`
		 * to 0 before this function runs, so re-reading the pragma here would report EVERY startup
		 * as unclean and pay the probe cost (seconds of blocked main thread) even after a clean
		 * shutdown. Omitted only by callers with no marker to consult (tests, tooling).
		 */
		wasClean?: boolean;
	} = {},
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
		// Column-set migration: an older DB has knowledge_entries_fts with only
		// (title, current_content). The `current_keywords` column was added for passive
		// auto-injection — detect the stale shape and drop it so it is recreated with the
		// new column (and rebuilt below via needsRebuild). The FTS column name must match
		// the base-table column name (external-content tables resolve columns by name on
		// 'rebuild'), hence `current_keywords` rather than `keywords`.
		const keInfo = sqlite
			.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_entries_fts'")
			.get() as { sql: string } | undefined;
		if (keInfo && !keInfo.sql.includes("current_keywords")) {
			sqlite.run("DROP TABLE IF EXISTS knowledge_entries_fts");
			// The sync triggers reference the FTS column list, so drop them too — they are
			// recreated (with the keywords column) by the CREATE TRIGGER calls below.
			sqlite.run("DROP TRIGGER IF EXISTS knowledge_entries_fts_insert");
			sqlite.run("DROP TRIGGER IF EXISTS knowledge_entries_fts_update");
			sqlite.run("DROP TRIGGER IF EXISTS knowledge_entries_fts_delete");
			ftsTablesRecreated.push("knowledge_entries_fts");
		}
		sqlite.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_entries_fts USING fts5(
				title, current_content, current_keywords, content='knowledge_entries', content_rowid=rowid, tokenize='trigram'
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

	// --- Sync triggers: knowledge_entries (title + current_content + current_keywords) ---
	if (hasKnowledgeEntries) {
		sqlite.run(`
			CREATE TRIGGER IF NOT EXISTS knowledge_entries_fts_insert AFTER INSERT ON knowledge_entries BEGIN
				INSERT INTO knowledge_entries_fts(rowid, title, current_content, current_keywords)
				VALUES (NEW.rowid, NEW.title, NEW.current_content, NEW.current_keywords);
			END
		`);
		sqlite.run(`
			CREATE TRIGGER IF NOT EXISTS knowledge_entries_fts_update AFTER UPDATE ON knowledge_entries BEGIN
				INSERT INTO knowledge_entries_fts(knowledge_entries_fts, rowid, title, current_content, current_keywords)
				VALUES ('delete', OLD.rowid, OLD.title, OLD.current_content, OLD.current_keywords);
				INSERT INTO knowledge_entries_fts(rowid, title, current_content, current_keywords)
				VALUES (NEW.rowid, NEW.title, NEW.current_content, NEW.current_keywords);
			END
		`);
		sqlite.run(`
			CREATE TRIGGER IF NOT EXISTS knowledge_entries_fts_delete AFTER DELETE ON knowledge_entries BEGIN
				INSERT INTO knowledge_entries_fts(knowledge_entries_fts, rowid, title, current_content, current_keywords)
				VALUES ('delete', OLD.rowid, OLD.title, OLD.current_content, OLD.current_keywords);
			END
		`);
	}

	// --- Sync triggers: knowledge_drafts (rowid-bound; title de-normalized from entry) ---
	if (hasKnowledgeDrafts) {
		// INSERT: index the new personal entry. Title comes from its own `title` (standalone
		// entry) or, when linked (entry_id set), the parent global entry's title.
		sqlite.run(`
			CREATE TRIGGER IF NOT EXISTS knowledge_drafts_fts_insert AFTER INSERT ON knowledge_drafts BEGIN
				INSERT INTO knowledge_drafts_fts(rowid, title, content)
				VALUES (
					NEW.rowid,
					COALESCE((SELECT title FROM knowledge_entries WHERE id = NEW.entry_id), NEW.title, ''),
					NEW.content
				);
			END
		`);
		// UPDATE: delete+reinsert by rowid (content may change; title re-resolved).
		sqlite.run(`
			CREATE TRIGGER IF NOT EXISTS knowledge_drafts_fts_update AFTER UPDATE ON knowledge_drafts BEGIN
				DELETE FROM knowledge_drafts_fts WHERE rowid = OLD.rowid;
				INSERT INTO knowledge_drafts_fts(rowid, title, content)
				VALUES (
					NEW.rowid,
					COALESCE((SELECT title FROM knowledge_entries WHERE id = NEW.entry_id), NEW.title, ''),
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
	// Two independent triggers, handled differently:
	//   1) Migration (tokenizer change / dropped-and-recreated table): the index is empty or
	//      built with the wrong tokenizer, so an UNCONDITIONAL full 'rebuild' is mandatory.
	//   2) Unclean shutdown: trigram indexes *can* silently corrupt on crash and later throw
	//      "malformed" on UPDATE, but usually they are fine. Instead of unconditionally
	//      rebuilding every table (the previous behavior — slow: full re-tokenization of the
	//      whole corpus, ~1 min on large narrator_messages), probe each table cheaply with
	//      'integrity-check' and rebuild ONLY the tables that actually fail. Set
	//      NARRAFORK_FTS_FULL_REBUILD=1 (or NARRAFORK_DB_FULL_INTEGRITY_CHECK=1) to force the
	//      old unconditional-rebuild behavior.
	// Prefer the caller-supplied marker state. Falling back to the live pragma is only correct for
	// callers that never consumed the marker; the startup path always passes `wasClean` because it
	// already reset `application_id` to 0 (see the option docs above).
	const wasClean =
		options.wasClean ??
		((sqlite.prepare("PRAGMA application_id").get() as { application_id: number } | undefined)
			?.application_id ?? 0) === CLEAN_SHUTDOWN_MARKER;
	const migrationForcedRebuild = ftsTablesRecreated.length > 0;
	const uncleanShutdown = !options.skipUncleanShutdownRebuild && !wasClean;
	const needsRebuild = migrationForcedRebuild || uncleanShutdown;

	if (needsRebuild) {
		const startedAt = Date.now();
		// Migration always rebuilds unconditionally. Unclean shutdown only rebuilds tables that
		// fail the cheap integrity probe (unless the force flag is set).
		const probeThenRebuild = uncleanShutdown && !migrationForcedRebuild && !FORCE_FULL_FTS_REBUILD;
		const ftsTables = [
			"narrators_fts",
			"chapters_fts",
			"narrator_messages_fts",
			...(hasKnowledgeEntries ? ["knowledge_entries_fts"] : []),
		];
		const rebuilt: string[] = [];
		const healthy: string[] = [];
		try {
			for (const table of ftsTables) {
				if (probeThenRebuild && probeFtsIntegrity(sqlite, table) === "ok") {
					healthy.push(table);
					continue;
				}
				sqlite.run(`INSERT INTO ${table}(${table}) VALUES ('rebuild')`);
				rebuilt.push(table);
			}
			logger.info("FTS indexes checked on startup", {
				reason: migrationForcedRebuild ? "migration" : "unclean_shutdown",
				mode: probeThenRebuild ? "probe_then_rebuild" : "full_rebuild",
				rebuilt,
				healthy,
				durationMs: Date.now() - startedAt,
			});
		} catch (err) {
			logger.warn("FTS rebuild failed on startup", {
				error: String(err),
				durationMs: Date.now() - startedAt,
			});
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
				SELECT d.rowid, COALESCE(e.title, d.title, ''), d.content
				FROM knowledge_drafts d
				LEFT JOIN knowledge_entries e ON e.id = d.entry_id
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
