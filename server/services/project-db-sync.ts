/**
 * Exporting the main database into each project's portable `project.db` archive.
 *
 * WHAT CHANGED IN PHASE 2
 * -----------------------
 * The main-database reads now go through `ProjectArchiveMainStore` (`project-archive/`), and the
 * archive writes through `ArchiveTableWriter`. What that replaced was ten hand-maintained
 * positional `INSERT` statements — 38 placeholders for `narrators`, 36 for `narrator_messages` —
 * each paired with a hand-ordered array of Drizzle row fields. Nothing checked that the two
 * lists lined up, so inserting a column in the middle of one and appending it to the other
 * type-checks, formats, runs, and silently stores every subsequent value in the wrong column.
 * The old snapshot test had to assert an unrelated `merge_commit_sha` was still null purely to
 * catch that class of drift.
 *
 * Column list and value list are now derived from the same column-keyed row, so they cannot
 * disagree. The archive FORMAT is unchanged: same tables, same columns, same
 * `INSERT OR REPLACE`, same delete-then-insert scopes, same debounce.
 *
 * READS ARE PAGED
 * ---------------
 * Rows are read one page at a time, so peak memory is one page rather than a whole table. That
 * matters for `narrator_messages`, whose `content_json` holds full conversation content; the
 * predecessor of this code built arrays of every matching row of every table first.
 *
 * A REPLACEMENT IS ATOMIC ON THE ARCHIVE SIDE — VIA STAGING, NOT VIA A HELD TRANSACTION
 * ------------------------------------------------------------------------------------
 * Every delete-then-insert here goes through `replaceTables`, which stages the paged rows in a
 * TEMP table and then runs the DELETEs and the load in ONE synchronous archive transaction. A
 * reader of the portable file therefore sees the complete previous contents or the complete new
 * ones, and a failure at any point (an unreadable page, a rejected row, cancellation, timeout)
 * leaves the archive exactly as it was.
 *
 * That mechanism is what the paging forced. A `bun:sqlite` transaction commits when its callback
 * RETURNS, so it cannot be held across the `await` between two pages — writing page-by-page
 * inside "one transaction" would in fact commit the DELETE by itself and leave the refill
 * unprotected.
 *
 * WHAT IS STILL NOT ATOMIC, STATED PLAINLY
 * ----------------------------------------
 * Two databases cannot be one transaction, and `fullSync` performs SEVERAL replacements
 * (chapters, edges, each narrator's conversation, …). An export interrupted between them leaves
 * earlier scopes replaced and later ones stale — each internally whole, never half-replaced. The
 * main database is only ever read. That residue is acceptable for the reason it always was: the
 * archive is a backup the next `fullSync` replaces wholesale, and every sync path here is
 * best-effort by design (a failed archive write must never fail the user operation that
 * triggered it).
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NARRATOR_BACKUP_LIMITS } from "@shared/narrator-backup";
import { and, eq, gt } from "drizzle-orm";
import { activeDatabaseBackend, db } from "../db";
import { getDbPath } from "../db/connection";
import {
	chapters,
	explorationGroups,
	mergeSessions,
	narratorMessageRefs,
	narrators,
} from "../db/schema";
import type { NarraForkEvent } from "../lib/event-bus";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { projectDbManager } from "../lib/project-db";
import type { BackupActor } from "./narrator-backup/contract";
import {
	copyTable,
	distinctIds,
	type ExportControl,
	exportDeadline,
	type ReplaceScope,
	readAllRows,
	replaceTables,
} from "./project-archive/export-rows";
import { exportLegacyProjectOnWorker } from "./project-archive/legacy-sync-job";
import type { ArchiveTable } from "./project-archive/manifest";
import { projectArchiveMainStore as mainStore } from "./project-archive/store";
import { createNarratorSyncScheduler } from "./project-db-sync-scheduler";

// === Helpers ===

/** Get the projectId for a chapter. */
async function projectIdForChapter(chapterId: string): Promise<string | null> {
	const row = await db.query.chapters.findFirst({
		where: eq(chapters.id, chapterId),
		columns: { projectId: true },
	});
	return row?.projectId ?? null;
}

/** Context affiliation is explicit; cwd is never an ownership heuristic. */
async function projectIdsForNarrator(narratorId: string): Promise<string[]> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { chapterId: true, contextProjectId: true },
	});
	if (!narrator) return [];
	const chapterProject = narrator.chapterId ? await projectIdForChapter(narrator.chapterId) : null;
	return [
		...new Set([chapterProject, narrator.contextProjectId].filter((id): id is string => !!id)),
	];
}

const PROJECT_TOOL_CALL_TARGET_COLUMNS = [
	["execution_path_flavor", "TEXT"],
	["canonical_file_path", "TEXT"],
	["runtime_generation", "INTEGER"],
	["execution_targets_json", "TEXT"],
] as const;

function ensureProjectToolCallTargetColumns(pdb: Database): void {
	const columns = pdb.prepare("PRAGMA table_info(narrator_tool_calls)").all() as Array<{
		name: string;
	}>;
	const existing = new Set(columns.map((column) => column.name));
	for (const [name, type] of PROJECT_TOOL_CALL_TARGET_COLUMNS) {
		if (!existing.has(name)) pdb.run(`ALTER TABLE narrator_tool_calls ADD COLUMN ${name} ${type}`);
	}
}

/** Get project DB connection, returns null if unavailable. */
async function getProjectDb(projectId: string): Promise<Database | null> {
	try {
		const pdb = await projectDbManager.getDb(projectId);
		if (!pdb) return null;
		ensureProjectToolCallTargetColumns(pdb);
		return pdb;
	} catch (err) {
		logger.warn("Failed to get project DB", { projectId, error: String(err) });
		return null;
	}
}

/**
 * APPEND the rows of one archive table matching `column IN values`.
 *
 * For scopes that only add or overwrite by primary key. Anything that must also REMOVE what the
 * archive holds goes through {@link replaceById} instead, so the delete and the refill land in
 * one commit.
 */
async function copyById(
	pdb: Database,
	table: ArchiveTable,
	column: string,
	values: readonly string[],
	control: ExportControl = {},
): Promise<number> {
	const { rows } = await copyTable(mainStore, pdb, table, {
		filter: { column, values },
		...control,
	});
	return rows;
}

/** REPLACE one scope atomically: `clear` and the refilled rows share a single commit. */
async function replaceById(
	pdb: Database,
	table: ArchiveTable,
	column: string,
	values: readonly string[],
	clear: readonly { sql: string; params?: (string | number | null)[] }[],
	control: ExportControl = {},
): Promise<number> {
	const { rows } = await replaceTables(
		mainStore,
		pdb,
		[{ table, filter: { column, values }, clear }],
		control,
	);
	return rows[0] ?? 0;
}

// === Sync functions ===

/** Sync a single project record. */
export async function syncProject(projectId: string): Promise<void> {
	const pdb = await getProjectDb(projectId);
	if (!pdb) return;
	await copyById(pdb, "projects", "id", [projectId]);
}

/** Sync a single chapter record. */
async function syncChapter(chapterId: string): Promise<void> {
	const projectId = await projectIdForChapter(chapterId);
	if (!projectId) return;
	const pdb = await getProjectDb(projectId);
	if (!pdb) return;
	await copyById(pdb, "chapters", "id", [chapterId]);
}

/** Sync chapter edges for a project (delete-then-insert to handle removals). */
async function syncChapterEdgesForProject(projectId: string): Promise<void> {
	const pdb = await getProjectDb(projectId);
	if (!pdb) return;
	await replaceById(
		pdb,
		"chapter_edges",
		"project_id",
		[projectId],
		[{ sql: "DELETE FROM chapter_edges WHERE project_id = ?", params: [projectId] }],
	);
}

/** Sync chapter commits for a single chapter (delete-then-insert). */
async function syncChapterCommits(chapterId: string, control: ExportControl = {}): Promise<void> {
	const projectId = await projectIdForChapter(chapterId);
	if (!projectId) return;
	const pdb = await getProjectDb(projectId);
	if (!pdb) return;
	await replaceById(
		pdb,
		"chapter_commits",
		"chapter_id",
		[chapterId],
		[{ sql: "DELETE FROM chapter_commits WHERE chapter_id = ?", params: [chapterId] }],
		control,
	);
}

/** Sync a single narrator record. */
async function syncNarrator(narratorId: string): Promise<void> {
	for (const projectId of await projectIdsForNarrator(narratorId)) {
		const pdb = await getProjectDb(projectId);
		if (pdb) await copyById(pdb, "narrators", "id", [narratorId]);
	}
}

/** What one incremental message sync looked at and copied — used for slow-sync diagnostics. */
interface NarratorMessageSyncStats {
	readonly mainRefs: number;
	readonly archivedMessages: number;
	readonly newRefs: number;
}

/**
 * Sync messages for a narrator (incremental: only refs the archive does not have yet).
 *
 * Note: shared messages (from fork) may have narrator_id pointing to a narrator not in this
 * project DB (e.g. a standalone narrator). That is acceptable since the archive has no foreign
 * key constraints, and the message content is still correctly preserved. Full data integrity is
 * restored on import.
 */
async function syncNarratorMessages(narratorId: string): Promise<NarratorMessageSyncStats | null> {
	let stats: NarratorMessageSyncStats | null = null;
	for (const projectId of await projectIdsForNarrator(narratorId)) {
		stats = await syncNarratorMessagesIntoProject(narratorId, projectId);
	}
	return stats;
}

async function syncNarratorMessagesIntoProject(
	narratorId: string,
	projectId: string,
): Promise<NarratorMessageSyncStats | null> {
	const pdb = await getProjectDb(projectId);
	if (!pdb) return null;

	// Which refs does the archive already have?
	//
	// A MAX(seq) high-water mark is not usable here: a lazily-forked narrator gains *older* refs
	// over time (see narrator-refs-backfill), so backfilled rows sit below the mark and would be
	// skipped forever. Compare by message id instead — the ids are narrow, indexed, and bounded
	// by the narrator's own ref count.
	//
	// Nor is "ref counts are equal, nothing to do" usable: this path only appends, so refs the
	// main database has since deleted stay in the archive until the next full sync, and an equal
	// count can hide exactly as many new refs as there are stale ones.
	const syncedIds = new Set<string>();
	let archivedAfter = "";
	for (;;) {
		const page = pdb
			.prepare(
				"SELECT id,message_id FROM narrator_message_refs WHERE narrator_id=? AND id>? ORDER BY id LIMIT 500",
			)
			.all(narratorId, archivedAfter) as { id: string; message_id: string }[];
		if (!page.length) break;
		for (const ref of page) syncedIds.add(ref.message_id);
		archivedAfter = page.at(-1)?.id ?? archivedAfter;
		if (syncedIds.size > 100_000)
			throw new Error("Project incremental backup reference budget exceeded");
	}

	// ONE narrow read of (id, message_id), NOT the paged full-row `readAllRows`. A paged read
	// filtered by narrator and ordered by primary key re-sorts the narrator's whole ref set for
	// every page — O(N²/page) — which on a working narrator with ~90k refs held the event loop
	// for ~10s on every debounced sync. The two ids per ref are all the diff needs; the full rows
	// of only the NEW refs are fetched below, by primary key.
	const mainRefs: { id: string; messageId: string }[] = [];
	let mainAfter = "";
	for (;;) {
		const page = await db
			.select({ id: narratorMessageRefs.id, messageId: narratorMessageRefs.messageId })
			.from(narratorMessageRefs)
			.where(
				and(eq(narratorMessageRefs.narratorId, narratorId), gt(narratorMessageRefs.id, mainAfter)),
			)
			.orderBy(narratorMessageRefs.id)
			.limit(500);
		if (!page.length) break;
		mainRefs.push(...page);
		mainAfter = page.at(-1)?.id ?? mainAfter;
		if (mainRefs.length > 100_000)
			throw new Error("Project incremental backup reference budget exceeded");
	}
	const newRefs = mainRefs.filter((ref) => !syncedIds.has(ref.messageId));
	const stats: NarratorMessageSyncStats = {
		mainRefs: mainRefs.length,
		archivedMessages: syncedIds.size,
		newRefs: newRefs.length,
	};
	if (newRefs.length === 0) return stats;

	const messageIds = [...new Set(newRefs.map((ref) => ref.messageId))];

	await copyTable(mainStore, pdb, "narrator_messages", {
		filter: { column: "id", values: messageIds },
	});
	await copyTable(mainStore, pdb, "narrator_message_refs", {
		filter: { column: "id", values: newRefs.map((ref) => ref.id) },
	});
	await copyTable(mainStore, pdb, "narrator_tool_calls", {
		filter: { column: "message_id", values: messageIds },
	});
	return stats;
}

/** Sync exploration groups for a project (delete-then-insert). */
async function syncExplorationGroups(
	projectId: string,
	control: ExportControl = {},
): Promise<number> {
	const pdb = await getProjectDb(projectId);
	if (!pdb) return 0;
	return replaceById(
		pdb,
		"exploration_groups",
		"project_id",
		[projectId],
		[{ sql: "DELETE FROM exploration_groups WHERE project_id = ?", params: [projectId] }],
		control,
	);
}

/** Sync merge sessions for a project (delete-then-insert via target chapter). */
async function syncMergeSessions(projectId: string, control: ExportControl = {}): Promise<void> {
	const pdb = await getProjectDb(projectId);
	if (!pdb) return;
	const chapterRows = await db
		.select({ id: chapters.id })
		.from(chapters)
		.where(eq(chapters.projectId, projectId));
	if (chapterRows.length === 0) return;
	const chapterIds = chapterRows.map((c) => c.id);
	// Placeholders for the DELETE IN clause. chapterIds are nanoid strings from a DB query.
	const ph = chapterIds.map(() => "?").join(",");
	await replaceById(
		pdb,
		"merge_sessions",
		"target_chapter_id",
		chapterIds,
		[
			{
				sql: `DELETE FROM merge_sessions WHERE target_chapter_id IN (${ph})`,
				params: chapterIds,
			},
		],
		control,
	);
}

/**
 * Full sync of one narrator's conversation (delete-then-insert), as ONE atomic replacement.
 *
 * Used by `fullSync` so refs and tool calls deleted in the main database are cleaned up here too.
 * The three tables go into a single `replaceTables` call rather than three, because they describe
 * one thing: a reader that caught the refs deleted but not yet reloaded would see a conversation
 * with no messages, and one that caught refs reloaded without their tool calls would see calls
 * that vanished. Staging all three and committing once removes both windows.
 *
 * `narrator_messages` is deliberately NOT cleared: a message can be shared with another narrator
 * (fork copies the shared prefix), so deleting by narrator would remove rows another narrator
 * still references. Orphans are swept at the end of `fullSync` instead.
 */
async function fullSyncNarratorMessages(
	narratorId: string,
	pdb: Database,
	control: ExportControl = {},
): Promise<void> {
	const refs = await readAllRows(mainStore, "narrator_message_refs", {
		filter: { column: "narrator_id", values: [narratorId] },
		...control,
	});
	const messageIds = distinctIds(refs, "message_id");

	const scopes: ReplaceScope[] = [
		{
			table: "narrator_messages",
			filter: { column: "id", values: messageIds },
		},
		{
			table: "narrator_message_refs",
			filter: { column: "id", values: distinctIds(refs, "id") },
			clear: [
				{ sql: "DELETE FROM narrator_message_refs WHERE narrator_id = ?", params: [narratorId] },
			],
		},
		{
			table: "narrator_tool_calls",
			filter: { column: "message_id", values: messageIds },
			clear: [
				{ sql: "DELETE FROM narrator_tool_calls WHERE narrator_id = ?", params: [narratorId] },
			],
		},
	];
	await replaceTables(mainStore, pdb, scopes, control);
}

/** Clean up orphan messages in the archive (not referenced by any narrator_message_refs). */
function cleanupOrphanMessages(pdb: Database): void {
	pdb.run(`
		DELETE FROM narrator_messages WHERE id NOT IN (
			SELECT DISTINCT message_id FROM narrator_message_refs
		)
	`);
}

/**
 * Delete a chapter and all its associated data from the archive.
 * Handles two scenarios:
 * - cleanup: chapter still exists in main DB (status → abandoned), just sync it
 * - remove: chapter already deleted from main DB, purge from the archive
 */
async function deleteChapterFromProjectDb(chapterId: string, projectId: string): Promise<void> {
	// If the chapter still exists in the main DB (cleanup scenario), just sync the updated status.
	const row = await db.query.chapters.findFirst({
		where: eq(chapters.id, chapterId),
		columns: { id: true },
	});
	if (row) {
		await syncChapter(chapterId);
		return;
	}

	// Chapter already deleted from the main DB — purge from the archive.
	const pdb = await getProjectDb(projectId);
	if (!pdb) return;

	const narratorIds: string[] = [];
	let after = "";
	for (;;) {
		const page = pdb
			.prepare("SELECT id FROM narrators WHERE chapter_id = ? AND id > ? ORDER BY id LIMIT 500")
			.all(chapterId, after) as { id: string }[];
		if (!page.length) break;
		for (const candidate of page) {
			const live = await mainStore.readRows({
				table: "narrators",
				filter: { column: "id", values: [candidate.id] },
				limit: 1,
			});
			if (live.rows.length) {
				// The narrator survived detachment: keep its refs/messages and copy the new affiliation.
				await copyById(pdb, "narrators", "id", [candidate.id]);
			} else {
				const shared = pdb
					.prepare(
						"SELECT 1 FROM narrator_messages m JOIN narrator_message_refs r ON r.message_id=m.id WHERE m.narrator_id=? AND r.narrator_id<>? LIMIT 1",
					)
					.get(candidate.id, candidate.id);
				if (shared) {
					pdb.run("UPDATE narrators SET chapter_id=NULL,status='archived' WHERE id=?", [
						candidate.id,
					]);
					logger.warn("Retaining shared history author after chapter deletion", {
						projectId,
						narratorId: candidate.id,
					});
				} else narratorIds.push(candidate.id);
			}
		}
		after = page.at(-1)?.id ?? after;
	}

	const tx = pdb.transaction(() => {
		if (narratorIds.length > 0) {
			// narratorIds are nanoid strings from a DB query — safe for IN-clause interpolation
			const ph = narratorIds.map(() => "?").join(",");
			pdb.run(`DELETE FROM narrator_tool_calls WHERE narrator_id IN (${ph})`, narratorIds);
			pdb.run(`DELETE FROM narrator_message_refs WHERE narrator_id IN (${ph})`, narratorIds);
			pdb.run(`DELETE FROM narrators WHERE id IN (${ph})`, narratorIds);
		}

		pdb.run("DELETE FROM chapter_commits WHERE chapter_id = ?", [chapterId]);
		pdb.run("DELETE FROM chapter_edges WHERE source_id = ? OR target_id = ?", [
			chapterId,
			chapterId,
		]);
		// Delete sessions where this chapter is the target, or appears in the
		// source_chapter_ids JSON array (those sessions are now invalid).
		pdb.run("DELETE FROM merge_sessions WHERE target_chapter_id = ?", [chapterId]);
		pdb.run(
			`DELETE FROM merge_sessions WHERE EXISTS (
				SELECT 1 FROM json_each(source_chapter_ids) WHERE value = ?
			)`,
			[chapterId],
		);
		pdb.run("DELETE FROM chapters WHERE id = ?", [chapterId]);
	});
	tx();

	// Clean up orphan messages no longer referenced by any narrator
	cleanupOrphanMessages(pdb);

	logger.info("Deleted chapter from project DB", { chapterId, projectId });
}

// === Full sync ===

/**
 * How a caller may stop a full sync.
 *
 * There is deliberately NO default deadline. A legitimately large project takes as long as it
 * takes, and inventing a clock here would turn "your backup is big" into "your backup fails",
 * which is worse than slow — the bounds that protect the process are the page size, the staging
 * ceilings and the fact that nothing is held across an `await`. A caller that DOES have a budget
 * (a request that can be abandoned, a shutdown in progress) passes it and every page boundary
 * honors it.
 */
export interface FullSyncOptions {
	readonly signal?: AbortSignal;
	/** Public/full exports revalidate the authenticated closure in the worker snapshot. */
	readonly actor?: BackupActor;
	/** Isolated contract tests may use the injected inline main-store port. */
	readonly worker?: boolean;
	/** Relative budget in ms, converted to an absolute deadline once, at entry. */
	readonly timeoutMs?: number;
}

/** Full sync: export all project data from the main DB to the archive. */
export async function fullSync(
	projectId: string,
	options: FullSyncOptions = {},
): Promise<{ tables: Record<string, number> }> {
	const pdb = await getProjectDb(projectId);
	if (!pdb) throw new Error(`Cannot open project DB for project ${projectId}`);
	if (options.worker ?? process.env.NODE_ENV !== "test") {
		return exportLegacyProjectOnWorker(
			{
				databasePath: getDbPath(),
				archivePath: pdb.filename,
				projectId,
				backend: activeDatabaseBackend === "postgres" ? "postgres" : "sqlite",
				postgresUrl:
					activeDatabaseBackend === "postgres"
						? (process.env.NF_DATABASE_URL ?? process.env.DATABASE_URL)
						: undefined,
				actor: options.actor,
				deadline:
					Date.now() +
					Math.min(options.timeoutMs ?? NARRATOR_BACKUP_LIMITS.jobMs, NARRATOR_BACKUP_LIMITS.jobMs),
			},
			options.signal,
		);
	}

	// One deadline for the whole export rather than one per table: a per-table budget would let a
	// project with many tables run for an unbounded total.
	const control: ExportControl = {
		signal: options.signal,
		deadline: exportDeadline(options.timeoutMs),
	};
	const counts: Record<string, number> = {};

	// 1. Project
	await syncProject(projectId);
	counts.projects = 1;

	// 2. Chapters — replaced, so chapters removed from the main DB disappear here too.
	const chapterRows = await db
		.select({ id: chapters.id })
		.from(chapters)
		.where(eq(chapters.projectId, projectId));
	const chapterIds = chapterRows.map((c) => c.id);
	counts.chapters = await replaceById(
		pdb,
		"chapters",
		"project_id",
		[projectId],
		[{ sql: "DELETE FROM chapters WHERE project_id = ?", params: [projectId] }],
		control,
	);

	// 3. Chapter edges — replaced. The count is what was COPIED, i.e. the main database's row
	// count, which is what this field always reported (it used to come from a second `SELECT id`
	// against the main DB; the copy already knows the answer).
	counts.chapter_edges = await replaceById(
		pdb,
		"chapter_edges",
		"project_id",
		[projectId],
		[{ sql: "DELETE FROM chapter_edges WHERE project_id = ?", params: [projectId] }],
		control,
	);

	// 4. Exploration groups — replaced
	counts.exploration_groups = await syncExplorationGroups(projectId, control);

	// 5. Narrators + messages (via chapters).
	//
	// The narrators scope is ONE replacement: its clear removes archive narrators that no longer
	// belong to a live chapter, and the refill rewrites the ones that do. Running that DELETE on
	// its own — as this did before — is exactly the window the replacement exists to close: a
	// reader between the delete and the refill finds the project's narrators missing, and a
	// failure while reading them leaves the archive permanently short of narrators the main
	// database still has.
	// Only explicitly attributed scopes may be replaced. NULL chapter is NOT proof that
	// a narrator was deleted: ordinary/context-only sessions deliberately have no chapter.
	const narratorClear: { sql: string; params: string[] }[] = [
		{ sql: "DELETE FROM narrators WHERE context_project_id = ?", params: [projectId] },
	];
	if (chapterIds.length)
		narratorClear.push({
			sql: `DELETE FROM narrators WHERE chapter_id IN (${chapterIds.map(() => "?").join(",")})`,
			params: chapterIds,
		});
	const contextNarrators = await readAllRows(mainStore, "narrators", {
		filter: { column: "context_project_id", values: [projectId] },
		...control,
	});
	const chapterNarrators = chapterIds.length
		? await readAllRows(mainStore, "narrators", {
				filter: { column: "chapter_id", values: chapterIds },
				...control,
			})
		: [];
	const narratorIds = [
		...new Set([...contextNarrators, ...chapterNarrators].map((row) => String(row.id))),
	];
	const unknownLegacy = pdb
		.prepare(
			"SELECT id FROM narrators WHERE chapter_id IS NULL AND context_project_id IS NULL LIMIT 1",
		)
		.get();
	if (unknownLegacy)
		logger.warn("Retaining project archive narrators with unknown legacy affiliation", {
			projectId,
		});
	await replaceById(pdb, "narrators", "id", narratorIds, narratorClear, control);
	for (const narratorId of narratorIds) {
		await fullSyncNarratorMessages(narratorId, pdb, control);
	}
	counts.narrators = narratorIds.length;

	// Clean up orphan messages (messages no longer referenced by any narrator)
	cleanupOrphanMessages(pdb);

	// 6. Chapter commits
	for (const ch of chapterRows) {
		await syncChapterCommits(ch.id, control);
	}

	// 7. Merge sessions
	await syncMergeSessions(projectId, control);

	logger.info("Project DB full sync completed", { projectId, counts });
	return { tables: counts };
}

// === Event-driven incremental sync ===

const MESSAGE_DEBOUNCE_MS = 500;
/**
 * Minimum gap between two event-driven syncs of the same narrator. The archive is a best-effort
 * backup, so a working narrator's archive trailing by a few seconds is harmless; re-diffing its
 * whole ref set after every 500ms pause is not.
 */
const MESSAGE_SYNC_MIN_INTERVAL_MS = 10_000;
/** An event-driven narrator sync slower than this is logged with its sizes. */
const SLOW_NARRATOR_SYNC_MS = 500;

async function runNarratorSync(narratorId: string): Promise<void> {
	const startedAt = performance.now();
	try {
		await syncNarrator(narratorId);
	} catch (err) {
		logger.warn("Project DB narrator sync failed", { narratorId, error: String(err) });
	}
	let stats: NarratorMessageSyncStats | null = null;
	try {
		stats = await syncNarratorMessages(narratorId);
	} catch (err) {
		logger.warn("Project DB message sync failed", { narratorId, error: String(err) });
	}
	const elapsedMs = Math.round(performance.now() - startedAt);
	if (elapsedMs >= SLOW_NARRATOR_SYNC_MS) {
		logger.warn("Slow project DB narrator sync", { narratorId, elapsedMs, ...stats });
	}
}

const narratorSyncScheduler = createNarratorSyncScheduler({
	debounceMs: MESSAGE_DEBOUNCE_MS,
	minIntervalMs: MESSAGE_SYNC_MIN_INTERVAL_MS,
	run: runNarratorSync,
	onError: (narratorId, err) => {
		logger.warn("Project DB narrator sync failed", { narratorId, error: String(err) });
	},
});

function debouncedNarratorSync(narratorId: string): void {
	narratorSyncScheduler.schedule(narratorId);
}

/** Internal entry points exposed for tests only. */
export const __testing = { syncNarratorMessages, runNarratorSync };

async function handleEvent(event: NarraForkEvent): Promise<void> {
	switch (event.type) {
		// Chapter lifecycle
		case "chapter:created": {
			await syncProject(event.projectId);
			await syncChapter(event.chapterId);
			break;
		}
		case "chapter:forked": {
			await syncChapter(event.chapterId);
			// Edges are created alongside fork — sync all edges for the project
			const pid = await projectIdForChapter(event.chapterId);
			if (pid) await syncChapterEdgesForProject(pid);
			break;
		}
		case "chapter:merged": {
			await syncChapter(event.sourceId);
			await syncChapter(event.targetId);
			const pid2 = await projectIdForChapter(event.targetId);
			if (pid2) await syncChapterEdgesForProject(pid2);
			break;
		}
		case "chapter:abandoned": {
			await deleteChapterFromProjectDb(event.chapterId, event.projectId);
			break;
		}
		case "chapter:dormant":
		case "chapter:woken":
		case "chapter:role_changed": {
			await syncChapter(event.chapterId);
			break;
		}
		case "chapter:split": {
			await syncChapter(event.prefixChapterId);
			await syncChapter(event.continuationChapterId);
			await syncChapter(event.newForkChapterId);
			const pid3 = await projectIdForChapter(event.prefixChapterId);
			if (pid3) await syncChapterEdgesForProject(pid3);
			break;
		}
		case "chapter:cherry_picked": {
			await syncChapter(event.sourceId);
			await syncChapter(event.targetId);
			break;
		}
		case "chapter:commits_updated": {
			await syncChapterCommits(event.chapterId);
			break;
		}

		// Dependencies: the dependency edge type is gone, so there are no
		// `dependency:created`/`dependency:removed` events left to sync.

		// Exploration groups
		case "exploration:created":
		case "exploration:decided":
		case "exploration:abandoned":
		case "exploration:chapter_added": {
			// We need the projectId — get it from the group itself
			const groupId = event.groupId;
			const group = await db.query.explorationGroups.findFirst({
				where: eq(explorationGroups.id, groupId),
				columns: { projectId: true },
			});
			if (group) await syncExplorationGroups(group.projectId);
			break;
		}

		// Merge sessions
		case "merge:started":
		case "merge:completed": {
			const pid5 = await projectIdForChapter(event.targetChapterId);
			if (pid5) await syncMergeSessions(pid5);
			break;
		}
		case "merge:cancelled": {
			// merge:cancelled has no targetChapterId — look up via mergeSessionId
			const session = await db.query.mergeSessions.findFirst({
				where: eq(mergeSessions.id, event.mergeSessionId),
				columns: { targetChapterId: true },
			});
			if (session) {
				const pid6 = await projectIdForChapter(session.targetChapterId);
				if (pid6) await syncMergeSessions(pid6);
			}
			break;
		}

		// Narrator lifecycle — debounced
		case "narrator:message": {
			debouncedNarratorSync(event.narratorId);
			break;
		}
		case "narrator:status_changed":
		case "narrator:title_updated": {
			debouncedNarratorSync(event.narratorId);
			break;
		}
		case "narrator:forked": {
			await syncNarrator(event.narratorId);
			await syncNarratorMessages(event.narratorId);
			break;
		}

		default:
			// Ignore events we don't care about
			break;
	}
}

/** Ensure .narrafork/ and .worktrees/ are in the project's .gitignore. */
export function ensureGitignoreEntry(gitPath: string): void {
	const entries = [".narrafork/", ".worktrees/"];
	const gitignorePath = resolve(gitPath, ".gitignore");
	if (existsSync(gitignorePath)) {
		const content = readFileSync(gitignorePath, "utf-8");
		const missing = entries.filter((e) => !content.includes(e));
		if (missing.length === 0) return;
		writeFileSync(gitignorePath, `${content.trimEnd()}\n${missing.join("\n")}\n`);
	} else {
		writeFileSync(gitignorePath, `${entries.join("\n")}\n`);
	}
}

/** Register event listeners for incremental sync. */
export function registerProjectDbSync(): void {
	eventBus.onAny((event) => {
		handleEvent(event).catch((err) => {
			logger.warn("Project DB sync event handler failed", {
				eventType: event.type,
				error: String(err),
			});
		});
	});
	logger.info("Project DB sync: event listeners registered");
}
