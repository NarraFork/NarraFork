/**
 * Idempotent PRODUCT data backfills, run by the lifecycle at one specific point in startup.
 *
 * WHY THEY LIVE IN THEIR OWN MODULE
 * --------------------------------
 * These are domain decisions — narrator status/substatus, trait arrays, handle folding, the composer
 * draft privacy migration, the knowledge-base seed — not lifecycle steps. Putting them in the SQLite
 * lifecycle adapter would make the boundary meaningless (the adapter is supposed to hold only
 * engine-shaped work), and leaving them inline in `db/index.ts` made that module both the wiring and
 * a 200-line data migration script.
 *
 * WHY THE POSITION MATTERS
 * -----------------------
 * The lifecycle guarantees exactly one thing about when this runs: AFTER migrations and
 * `ensureColumns`, so every column referenced below exists, and BEFORE FTS5 initialisation, so the
 * search indexes are built from the rows these statements produce. Reordering either way fails
 * silently — the wrong content is simply indexed, and nothing throws.
 *
 * RULES EVERY BLOCK FOLLOWS
 * ------------------------
 *   - awaited before the port is bound; each SQLite transaction stays synchronous.
 *     Required seq-counter repair yields between bounded pages and fails startup on error.
 *   - safe to re-run. It executes on every startup, so a second run must be a no-op.
 *   - non-fatal, except where a failure is itself a correctness problem: the draft migration logs at
 *     ERROR because a persistent failure means a cross-account draft leak survives, while the rest
 *     warn. Startup must never be blocked by an optional backfill.
 *
 * Typed with `bun:sqlite`'s `Database` on purpose. These statements ARE SQLite SQL; a portable
 * signature here would be a fiction, and the backend-independent port surface deliberately does not
 * mention this type.
 */

import type { Database } from "bun:sqlite";
import { logger } from "../lib/logger";
import { migrateLegacyNarratorDraftTraits } from "./migrate-narrator-drafts";

const REF_SEQ_PAGE_SIZE = 64;
const REF_SEQ_TRANSACTION_BUDGET_MS = 8;
const REF_SEQ_BACKFILL_TIMEOUT_MS = 120_000;

export interface SqliteDataBackfillOptions {
	readonly signal?: AbortSignal;
}

/**
 * Required upgrade repair, before any writer can claim from next_seq. Each narrator's
 * top ref is a single reverse seek on idx_narrator_refs_seq, never a global aggregate.
 * Restart from the beginning after interruption: the one-way ratchet neither lowers
 * previously claimed counters nor needs a fragile completion flag beside the data.
 */
async function backfillNarratorNextSeq(
	sqlite: Database,
	options: SqliteDataBackfillOptions,
): Promise<void> {
	const started = performance.now();
	const firstPage = sqlite.prepare<{ id: string }, []>(
		`SELECT id FROM narrators ORDER BY id LIMIT ${REF_SEQ_PAGE_SIZE}`,
	);
	const nextPage = sqlite.prepare<{ id: string }, [string]>(
		`SELECT id FROM narrators WHERE id > ? ORDER BY id LIMIT ${REF_SEQ_PAGE_SIZE}`,
	);
	const repair = sqlite.prepare(`UPDATE narrators SET next_seq = max(next_seq, COALESCE((
		SELECT seq + 1 FROM narrator_message_refs WHERE narrator_id = narrators.id
		ORDER BY seq DESC LIMIT 1
	), 0)) WHERE id = ? AND next_seq < COALESCE((
		SELECT seq + 1 FROM narrator_message_refs WHERE narrator_id = narrators.id
		ORDER BY seq DESC LIMIT 1
	), 0)`);
	let cursor: string | undefined;
	let repaired = 0;
	let scanned = 0;
	const checkBudget = () => {
		options.signal?.throwIfAborted();
		if (performance.now() - started > REF_SEQ_BACKFILL_TIMEOUT_MS) {
			throw new Error("Narrator next_seq startup backfill timed out; retry startup to resume");
		}
	};
	try {
		while (true) {
			checkBudget();
			const rows = cursor === undefined ? firstPage.all() : nextPage.all(cursor);
			if (!rows.length) break;
			const batchStarted = performance.now();
			sqlite.transaction(() => {
				for (const row of rows) {
					checkBudget();
					repaired += repair.run(row.id).changes;
					cursor = row.id;
					scanned++;
					if (performance.now() - batchStarted >= REF_SEQ_TRANSACTION_BUDGET_MS) break;
				}
			})();
			if (performance.now() - batchStarted > 50) {
				logger.warn("Slow narrator next_seq backfill page", {
					durationMs: performance.now() - batchStarted,
				});
			}
			// No transaction survives this await. Timers/I/O can run before the next page.
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	} catch (error) {
		logger.error("Required narrator next_seq backfill failed; startup must stop", {
			scanned,
			repaired,
			error: String(error),
		});
		throw error;
	} finally {
		firstPage.finalize();
		nextPage.finalize();
		repair.finalize();
	}
	if (repaired || performance.now() - started > 50) {
		logger.info("Narrator next_seq startup backfill completed", {
			scanned,
			repaired,
			durationMs: performance.now() - started,
		});
	}
}

export async function applySqliteDataBackfills(
	sqlite: Database,
	options: SqliteDataBackfillOptions = {},
): Promise<void> {
	await backfillNarratorNextSeq(sqlite, options);
	// Migrate old narrator status values to the status + substatus model.
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

	// Ensure variant/traits are consistent with legacy fields. Handles databases where ensureColumns
	// added the columns with defaults but the 0025 migration's data backfill never ran.
	{
		// Normalize invalid traits values to valid JSON arrays. ensureColumns may have added the
		// column with DEFAULT '' instead of '[]'.
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

	// Populate handle_fold for named narrators that predate the case-insensitive handle model.
	// Legacy handles were already stored lowercase, so lower(handle) is a safe, non-conflicting
	// fold. NFC differences don't apply to the ASCII-only legacy handles. Only touches rows where
	// the fold is still unset.
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

	// One-time privacy migration: move narrator-wide composer drafts into per-user rows and remove
	// every legacy encoded draft trait so it can no longer leak through shared state. The migration
	// is atomic (single transaction) and idempotent, so a transient failure is safe to retry on the
	// next boot. Never block startup on it — but log loudly (error, not warn) because a persistent
	// failure means the legacy cross-account draft leak survives.
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

	// Knowledge base seed: default classification levels + builtin tag types. Idempotent — only
	// inserts when the respective table is empty, so user edits are never overwritten.
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
				for (const [id, name, rank, label] of seedLevels) {
					insLevel.run(id, name, rank, label, nowIso);
				}
				logger.info("Seeded default knowledge classification levels", {
					count: seedLevels.length,
				});
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
}
