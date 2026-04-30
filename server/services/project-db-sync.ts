import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "../db";
import {
	chapterCommits,
	chapterEdges,
	chapters,
	explorationGroups,
	mergeSessions,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
} from "../db/schema";
import type { NarraForkEvent } from "../lib/event-bus";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { projectDbManager } from "../lib/project-db";

// === Helpers ===

/** Stringify a value for SQLite TEXT column (JSON fields). */
function jsonCol(val: unknown): string | null {
	if (val == null) return null;
	if (typeof val === "string") return val;
	return JSON.stringify(val);
}

/** Get the projectId for a chapter. */
async function projectIdForChapter(chapterId: string): Promise<string | null> {
	const row = await db.query.chapters.findFirst({
		where: eq(chapters.id, chapterId),
		columns: { projectId: true },
	});
	return row?.projectId ?? null;
}

/** Get project DB connection, returns null if unavailable. */
async function getProjectDb(projectId: string): Promise<Database | null> {
	try {
		return await projectDbManager.getDb(projectId);
	} catch (err) {
		logger.warn("Failed to get project DB", { projectId, error: String(err) });
		return null;
	}
}

// === Sync functions ===

/** Sync a single project record. */
async function syncProject(projectId: string): Promise<void> {
	const pdb = await getProjectDb(projectId);
	if (!pdb) return;
	const row = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
	if (!row) return;
	pdb.run(
		`INSERT OR REPLACE INTO projects
		(id, name, description, status, git_path, remote_url, default_branch,
		 startup_script, copy_files, chapter_settings, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.name,
			row.description,
			row.status,
			row.gitPath,
			row.remoteUrl,
			row.defaultBranch,
			row.startupScript,
			row.copyFiles,
			jsonCol(row.chapterSettings),
			row.createdAt,
			row.updatedAt,
		],
	);
}

/** Sync a single chapter record. */
async function syncChapter(chapterId: string): Promise<void> {
	const row = await db.query.chapters.findFirst({ where: eq(chapters.id, chapterId) });
	if (!row) return;
	const pdb = await getProjectDb(row.projectId);
	if (!pdb) return;
	pdb.run(
		`INSERT OR REPLACE INTO chapters
		(id, project_id, title, description, status, role, branch, worktree_path,
		 base_branch, parent_chapter_id, fork_point, merged_into_chapter_id,
		 merge_commit_sha, merge_strategy, container_config, exploration_group_id,
		 is_root, head_commit_sha, start_commit_sha, commit_count, color, group_label,
		 pinned, anchor_commit_sha, axis_offset, cross_offset, last_accessed_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.projectId,
			row.title,
			row.description,
			row.status,
			row.role,
			row.branch,
			row.worktreePath,
			row.baseBranch,
			row.parentChapterId,
			jsonCol(row.forkPoint),
			row.mergedIntoChapterId,
			row.mergeCommitSha,
			row.mergeStrategy,
			jsonCol(row.containerConfig),
			row.explorationGroupId,
			row.isRoot,
			row.headCommitSha,
			row.startCommitSha,
			row.commitCount,
			row.color,
			row.groupLabel,
			row.pinned,
			row.anchorCommitSha,
			row.axisOffset,
			row.crossOffset,
			row.lastAccessedAt,
			row.createdAt,
			row.updatedAt,
		],
	);
}

/** Sync chapter edges for a project (delete-then-insert to handle removals). */
async function syncChapterEdgesForProject(projectId: string): Promise<void> {
	const pdb = await getProjectDb(projectId);
	if (!pdb) return;
	const rows = await db.select().from(chapterEdges).where(eq(chapterEdges.projectId, projectId));
	const stmt = pdb.prepare(
		`INSERT OR REPLACE INTO chapter_edges
		(id, project_id, source_id, target_id, type, metadata, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	const tx = pdb.transaction(() => {
		pdb.run("DELETE FROM chapter_edges WHERE project_id = ?", [projectId]);
		for (const row of rows) {
			stmt.run(
				row.id,
				row.projectId,
				row.sourceId,
				row.targetId,
				row.type,
				jsonCol(row.metadata),
				row.createdAt,
			);
		}
	});
	tx();
}

/** Sync chapter commits for a single chapter (delete-then-insert). */
async function syncChapterCommits(chapterId: string): Promise<void> {
	const projectId = await projectIdForChapter(chapterId);
	if (!projectId) return;
	const pdb = await getProjectDb(projectId);
	if (!pdb) return;
	const rows = await db
		.select()
		.from(chapterCommits)
		.where(eq(chapterCommits.chapterId, chapterId));
	const stmt = pdb.prepare(
		`INSERT OR REPLACE INTO chapter_commits
		(id, chapter_id, sha, message, full_message, author_name, author_email,
		 authored_at, source, narrator_id, narrator_message_id,
		 files_changed, lines_added, lines_removed, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const tx = pdb.transaction(() => {
		pdb.run("DELETE FROM chapter_commits WHERE chapter_id = ?", [chapterId]);
		for (const row of rows) {
			stmt.run(
				row.id,
				row.chapterId,
				row.sha,
				row.message,
				row.fullMessage,
				row.authorName,
				row.authorEmail,
				row.authoredAt,
				row.source,
				row.narratorId,
				row.narratorMessageId,
				row.filesChanged,
				row.linesAdded,
				row.linesRemoved,
				row.createdAt,
			);
		}
	});
	tx();
}

/** Sync a single narrator and all its messages/refs/tool_calls/patches. */
async function syncNarrator(narratorId: string): Promise<void> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
	});
	if (!narrator?.chapterId) return;
	const projectId = await projectIdForChapter(narrator.chapterId);
	if (!projectId) return;
	const pdb = await getProjectDb(projectId);
	if (!pdb) return;

	// Sync narrator record
	pdb.run(
		`INSERT OR REPLACE INTO narrators
		(id, chapter_id, api_conversation_id, fork_message_id, type, subagent_type,
		 title, inherit_mode, parent_narrator_id, context_summary, model, system_prompt,
		 permission_mode, message_count, total_cost_usd, last_message_at, status,
		 plan_mode, cwd, error_message, todos_json, todos_tool_use_id,
		 prune_boundary_message_id, pruned_percent, created_at, substatus, variant, traits,
		 is_background, background_status, background_result, background_completed_at,
		 is_ask_in_passing, turn_started_at, message_version, prune_enabled, fast_mode,
		 relaxed_plan, reasoning_effort, previous_permission_mode, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			narrator.id,
			narrator.chapterId,
			narrator.apiConversationId,
			narrator.forkMessageId,
			narrator.type,
			narrator.subagentType,
			narrator.title,
			narrator.inheritMode,
			narrator.parentNarratorId,
			narrator.contextSummary,
			narrator.model,
			narrator.systemPrompt,
			narrator.permissionMode,
			narrator.messageCount,
			narrator.totalCostUsd,
			narrator.lastMessageAt,
			narrator.status,
			narrator.permissionMode === "plan" ? 1 : 0,
			narrator.cwd,
			narrator.errorMessage,
			jsonCol(narrator.todosJson),
			narrator.todosToolUseId,
			narrator.pruneBoundaryMessageId,
			narrator.prunedPercent,
			narrator.createdAt,
			narrator.substatus,
			narrator.variant,
			jsonCol(narrator.traits),
			narrator.isBackground ? 1 : 0,
			narrator.backgroundStatus,
			narrator.backgroundResult,
			narrator.backgroundCompletedAt,
			narrator.isAskInPassing ? 1 : 0,
			narrator.turnStartedAt,
			narrator.messageVersion,
			narrator.pruneEnabled ? 1 : 0,
			narrator.fastMode ? 1 : 0,
			narrator.relaxedPlan ? 1 : 0,
			narrator.reasoningEffort,
			narrator.previousPermissionMode,
			narrator.updatedAt,
		],
	);
}

/**
 * Sync messages for a narrator (incremental: only new refs since last sync).
 *
 * Note: shared messages (from fork) may have narrator_id pointing to a narrator
 * not in this project DB (e.g. standalone narrator). This is acceptable since
 * the project DB has no foreign key constraints, and the message content is
 * still correctly preserved. Full data integrity is restored on import.
 */
async function syncNarratorMessages(narratorId: string): Promise<void> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { chapterId: true },
	});
	if (!narrator?.chapterId) return;
	const projectId = await projectIdForChapter(narrator.chapterId);
	if (!projectId) return;
	const pdb = await getProjectDb(projectId);
	if (!pdb) return;

	// Find the max seq already synced in project DB for this narrator
	const maxSeqRow = pdb
		.prepare("SELECT MAX(seq) as max_seq FROM narrator_message_refs WHERE narrator_id = ?")
		.get(narratorId) as { max_seq: number | null } | undefined;
	const lastSyncedSeq = maxSeqRow?.max_seq ?? -1;

	// Get only new refs (seq > lastSyncedSeq)
	const newRefs = await db
		.select()
		.from(narratorMessageRefs)
		.where(
			lastSyncedSeq >= 0
				? and(
						eq(narratorMessageRefs.narratorId, narratorId),
						gt(narratorMessageRefs.seq, lastSyncedSeq),
					)
				: eq(narratorMessageRefs.narratorId, narratorId),
		);
	if (newRefs.length === 0) return;

	const messageIds = [...new Set(newRefs.map((r) => r.messageId))];

	// Load messages in batches
	const BATCH = 500;
	const allMessages: (typeof narratorMessages.$inferSelect)[] = [];
	for (let i = 0; i < messageIds.length; i += BATCH) {
		const batch = messageIds.slice(i, i + BATCH);
		const rows = await db
			.select()
			.from(narratorMessages)
			.where(inArray(narratorMessages.id, batch));
		allMessages.push(...rows);
	}

	// Load tool calls for these messages
	const allToolCalls: (typeof narratorToolCalls.$inferSelect)[] = [];
	for (let i = 0; i < messageIds.length; i += BATCH) {
		const batch = messageIds.slice(i, i + BATCH);
		const rows = await db
			.select()
			.from(narratorToolCalls)
			.where(inArray(narratorToolCalls.messageId, batch));
		allToolCalls.push(...rows);
	}

	// Write all to project DB in a single transaction
	const msgStmt = pdb.prepare(
		`INSERT OR REPLACE INTO narrator_messages
		(id, narrator_id, sdk_message_uuid, parent_tool_use_id, role, content_json,
		 content_text, tokens_in, cost_usd, turn_usage_json, provider, model,
		 output_tokens, cached_input_tokens, cache_creation_input_tokens,
		 cache_creation_5m_tokens, cache_creation_1h_tokens, reasoning_tokens,
		 ttft_ms, duration_ms, context_percent, meter_usage, meter_unit, commit_sha, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const refStmt = pdb.prepare(
		`INSERT OR REPLACE INTO narrator_message_refs
		(id, narrator_id, message_id, seq, is_compact, pruned_percent)
		VALUES (?, ?, ?, ?, ?, ?)`,
	);
	const tcStmt = pdb.prepare(
		`INSERT OR REPLACE INTO narrator_tool_calls
		(id, narrator_id, message_id, tool_use_id, tool_name, input_json, output_json,
		 status, duration_ms, error_message, permission_decided_by, permission_decided_at,
		 permission_deny_message, permission_decision_reason, permission_suggestions, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	const tx = pdb.transaction(() => {
		for (const m of allMessages) {
			msgStmt.run(
				m.id,
				m.narratorId,
				m.messageUuid,
				m.parentToolUseId,
				m.role,
				jsonCol(m.contentJson),
				m.contentText,
				m.tokensIn,
				m.costUsd,
				jsonCol(m.turnUsageJson),
				m.provider,
				m.model,
				m.outputTokens,
				m.cachedInputTokens,
				m.cacheCreationInputTokens,
				m.cacheCreation5mTokens,
				m.cacheCreation1hTokens,
				m.reasoningTokens,
				m.ttftMs,
				m.durationMs,
				m.contextPercent,
				m.meterUsage,
				m.meterUnit,
				m.commitSha,
				m.createdAt,
			);
		}
		for (const r of newRefs) {
			refStmt.run(r.id, r.narratorId, r.messageId, r.seq, r.isCompact, r.prunedPercent);
		}
		for (const tc of allToolCalls) {
			tcStmt.run(
				tc.id,
				tc.narratorId,
				tc.messageId,
				tc.toolUseId,
				tc.toolName,
				jsonCol(tc.inputJson),
				jsonCol(tc.outputJson),
				tc.status,
				tc.durationMs,
				tc.errorMessage,
				tc.permissionDecidedBy,
				tc.permissionDecidedAt,
				tc.permissionDenyMessage,
				tc.permissionDecisionReason,
				jsonCol(tc.permissionSuggestions),
				tc.createdAt,
			);
		}
	});
	tx();
}

/** Sync exploration groups for a project (delete-then-insert). */
async function syncExplorationGroups(projectId: string): Promise<void> {
	const pdb = await getProjectDb(projectId);
	if (!pdb) return;
	const rows = await db
		.select()
		.from(explorationGroups)
		.where(eq(explorationGroups.projectId, projectId));
	const stmt = pdb.prepare(
		`INSERT OR REPLACE INTO exploration_groups
		(id, project_id, title, description, base_chapter_id, status,
		 decided_chapter_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const tx = pdb.transaction(() => {
		pdb.run("DELETE FROM exploration_groups WHERE project_id = ?", [projectId]);
		for (const row of rows) {
			stmt.run(
				row.id,
				row.projectId,
				row.title,
				row.description,
				row.baseChapterId,
				row.status,
				row.decidedChapterId,
				row.createdAt,
				row.updatedAt,
			);
		}
	});
	tx();
}

/** Sync merge sessions for a project (delete-then-insert via target chapter). */
async function syncMergeSessions(projectId: string): Promise<void> {
	const pdb = await getProjectDb(projectId);
	if (!pdb) return;
	const chapterRows = await db
		.select({ id: chapters.id })
		.from(chapters)
		.where(eq(chapters.projectId, projectId));
	if (chapterRows.length === 0) return;
	const chapterIds = chapterRows.map((c) => c.id);
	const rows = await db
		.select()
		.from(mergeSessions)
		.where(inArray(mergeSessions.targetChapterId, chapterIds));
	const stmt = pdb.prepare(
		`INSERT OR REPLACE INTO merge_sessions
		(id, target_chapter_id, source_chapter_ids, strategy, status,
		 current_index, merged_count, current_source_chapter_id,
		 conflict_files, error, locale, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	// Build placeholders for DELETE IN clause
	const ph = chapterIds.map(() => "?").join(",");
	const tx = pdb.transaction(() => {
		pdb.run(`DELETE FROM merge_sessions WHERE target_chapter_id IN (${ph})`, chapterIds);
		for (const row of rows) {
			stmt.run(
				row.id,
				row.targetChapterId,
				jsonCol(row.sourceChapterIds),
				row.strategy,
				row.status,
				row.currentIndex,
				row.mergedCount,
				row.currentSourceChapterId,
				jsonCol(row.conflictFiles),
				row.error,
				row.locale,
				row.createdAt,
				row.updatedAt,
			);
		}
	});
	tx();
}

/**
 * Full sync of narrator messages (delete-then-insert).
 * Used by fullSync to ensure deleted messages are cleaned up.
 */
async function fullSyncNarratorMessages(narratorId: string, pdb: Database): Promise<void> {
	// Get all refs for this narrator from main DB
	const refs = await db
		.select()
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.narratorId, narratorId));

	const messageIds = [...new Set(refs.map((r) => r.messageId))];

	const BATCH = 500;
	const allMessages: (typeof narratorMessages.$inferSelect)[] = [];
	for (let i = 0; i < messageIds.length; i += BATCH) {
		const batch = messageIds.slice(i, i + BATCH);
		const rows = await db
			.select()
			.from(narratorMessages)
			.where(inArray(narratorMessages.id, batch));
		allMessages.push(...rows);
	}

	const allToolCalls: (typeof narratorToolCalls.$inferSelect)[] = [];
	for (let i = 0; i < messageIds.length; i += BATCH) {
		const batch = messageIds.slice(i, i + BATCH);
		const rows = await db
			.select()
			.from(narratorToolCalls)
			.where(inArray(narratorToolCalls.messageId, batch));
		allToolCalls.push(...rows);
	}

	const msgStmt = pdb.prepare(
		`INSERT OR REPLACE INTO narrator_messages
		(id, narrator_id, sdk_message_uuid, parent_tool_use_id, role, content_json,
		 content_text, tokens_in, cost_usd, turn_usage_json, provider, model,
		 output_tokens, cached_input_tokens, cache_creation_input_tokens,
		 cache_creation_5m_tokens, cache_creation_1h_tokens, reasoning_tokens,
		 ttft_ms, duration_ms, context_percent, meter_usage, meter_unit, commit_sha, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const refStmt = pdb.prepare(
		`INSERT OR REPLACE INTO narrator_message_refs
		(id, narrator_id, message_id, seq, is_compact, pruned_percent)
		VALUES (?, ?, ?, ?, ?, ?)`,
	);
	const tcStmt = pdb.prepare(
		`INSERT OR REPLACE INTO narrator_tool_calls
		(id, narrator_id, message_id, tool_use_id, tool_name, input_json, output_json,
		 status, duration_ms, error_message, permission_decided_by, permission_decided_at,
		 permission_deny_message, permission_decision_reason, permission_suggestions, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	const tx = pdb.transaction(() => {
		// Delete existing data for this narrator first
		pdb.run("DELETE FROM narrator_tool_calls WHERE narrator_id = ?", [narratorId]);
		pdb.run("DELETE FROM narrator_message_refs WHERE narrator_id = ?", [narratorId]);
		// Don't delete narrator_messages here — they may be shared with other narrators.
		// Orphan messages will be cleaned up at the end of fullSync.

		for (const m of allMessages) {
			msgStmt.run(
				m.id,
				m.narratorId,
				m.messageUuid,
				m.parentToolUseId,
				m.role,
				jsonCol(m.contentJson),
				m.contentText,
				m.tokensIn,
				m.costUsd,
				jsonCol(m.turnUsageJson),
				m.provider,
				m.model,
				m.outputTokens,
				m.cachedInputTokens,
				m.cacheCreationInputTokens,
				m.cacheCreation5mTokens,
				m.cacheCreation1hTokens,
				m.reasoningTokens,
				m.ttftMs,
				m.durationMs,
				m.contextPercent,
				m.meterUsage,
				m.meterUnit,
				m.commitSha,
				m.createdAt,
			);
		}
		for (const r of refs) {
			refStmt.run(r.id, r.narratorId, r.messageId, r.seq, r.isCompact, r.prunedPercent);
		}
		for (const tc of allToolCalls) {
			tcStmt.run(
				tc.id,
				tc.narratorId,
				tc.messageId,
				tc.toolUseId,
				tc.toolName,
				jsonCol(tc.inputJson),
				jsonCol(tc.outputJson),
				tc.status,
				tc.durationMs,
				tc.errorMessage,
				tc.permissionDecidedBy,
				tc.permissionDecidedAt,
				tc.permissionDenyMessage,
				tc.permissionDecisionReason,
				jsonCol(tc.permissionSuggestions),
				tc.createdAt,
			);
		}
	});
	tx();
}

/** Clean up orphan messages in project DB (messages not referenced by any narrator_message_refs). */
function cleanupOrphanMessages(pdb: Database): void {
	pdb.run(`
		DELETE FROM narrator_messages WHERE id NOT IN (
			SELECT DISTINCT message_id FROM narrator_message_refs
		)
	`);
}

/**
 * Delete a chapter and all its associated data from the project database.
 * Handles two scenarios:
 * - cleanup: chapter still exists in main DB (status → abandoned), just sync it
 * - remove: chapter already deleted from main DB, purge from project DB
 */
async function deleteChapterFromProjectDb(chapterId: string, projectId: string): Promise<void> {
	// If chapter still exists in main DB (cleanup scenario), just sync the updated status
	const row = await db.query.chapters.findFirst({
		where: eq(chapters.id, chapterId),
	});
	if (row) {
		await syncChapter(chapterId);
		return;
	}

	// Chapter already deleted from main DB — purge from project DB
	const pdb = await getProjectDb(projectId);
	if (!pdb) return;

	// Find narrators belonging to this chapter in project DB
	const narratorRows = pdb
		.prepare("SELECT id FROM narrators WHERE chapter_id = ?")
		.all(chapterId) as { id: string }[];
	const narratorIds = narratorRows.map((n) => n.id);

	const tx = pdb.transaction(() => {
		if (narratorIds.length > 0) {
			// narratorIds are nanoid strings from a DB query — safe for IN-clause interpolation
			const ph = narratorIds.map(() => "?").join(",");
			pdb.run(`DELETE FROM narrator_tool_calls WHERE narrator_id IN (${ph})`, narratorIds);
			pdb.run(`DELETE FROM narrator_message_refs WHERE narrator_id IN (${ph})`, narratorIds);
			pdb.run("DELETE FROM narrators WHERE chapter_id = ?", [chapterId]);
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

/** Full sync: export all project data from main DB to project DB. */
export async function fullSync(projectId: string): Promise<{ tables: Record<string, number> }> {
	const pdb = await getProjectDb(projectId);
	if (!pdb) throw new Error(`Cannot open project DB for project ${projectId}`);

	const counts: Record<string, number> = {};

	// 1. Project
	await syncProject(projectId);
	counts.projects = 1;

	// 2. Chapters — delete-then-insert to handle removed chapters
	const chapterRows = await db.select().from(chapters).where(eq(chapters.projectId, projectId));
	const chapterIds = chapterRows.map((c) => c.id);
	// Delete chapters in project DB that no longer exist in main DB
	pdb.run("DELETE FROM chapters WHERE project_id = ?", [projectId]);
	for (const ch of chapterRows) {
		await syncChapter(ch.id);
	}
	counts.chapters = chapterRows.length;

	// 3. Chapter edges (already delete-then-insert)
	await syncChapterEdgesForProject(projectId);
	const edgeRows = await db
		.select({ id: chapterEdges.id })
		.from(chapterEdges)
		.where(eq(chapterEdges.projectId, projectId));
	counts.chapter_edges = edgeRows.length;

	// 4. Exploration groups (already delete-then-insert)
	await syncExplorationGroups(projectId);
	const egRows = await db
		.select({ id: explorationGroups.id })
		.from(explorationGroups)
		.where(eq(explorationGroups.projectId, projectId));
	counts.exploration_groups = egRows.length;

	// 5. Narrators + messages (via chapters) — delete-then-insert for full accuracy
	// First, delete narrators in project DB that no longer exist
	if (chapterIds.length > 0) {
		const ph = chapterIds.map(() => "?").join(",");
		pdb.run(
			`DELETE FROM narrators WHERE chapter_id NOT IN (${ph}) OR chapter_id IS NULL`,
			chapterIds,
		);
	} else {
		pdb.run("DELETE FROM narrators");
	}

	let narratorRows: { id: string }[] = [];
	if (chapterIds.length > 0) {
		narratorRows = await db
			.select({ id: narrators.id })
			.from(narrators)
			.where(inArray(narrators.chapterId, chapterIds));
	}
	for (const n of narratorRows) {
		await syncNarrator(n.id);
		await fullSyncNarratorMessages(n.id, pdb);
	}
	counts.narrators = narratorRows.length;

	// Clean up orphan messages (messages no longer referenced by any narrator)
	cleanupOrphanMessages(pdb);

	// 6. Chapter commits
	for (const ch of chapterRows) {
		await syncChapterCommits(ch.id);
	}

	// 7. Merge sessions (already delete-then-insert)
	await syncMergeSessions(projectId);

	logger.info("Project DB full sync completed", { projectId, counts });
	return { tables: counts };
}

// === Event-driven incremental sync ===

const messageDebounceMap = new Map<string, Timer>();
const MESSAGE_DEBOUNCE_MS = 500;

function debouncedNarratorSync(narratorId: string): void {
	const existing = messageDebounceMap.get(narratorId);
	if (existing) clearTimeout(existing);
	messageDebounceMap.set(
		narratorId,
		setTimeout(() => {
			messageDebounceMap.delete(narratorId);
			syncNarrator(narratorId).catch((err) => {
				logger.warn("Project DB narrator sync failed", { narratorId, error: String(err) });
			});
			syncNarratorMessages(narratorId).catch((err) => {
				logger.warn("Project DB message sync failed", { narratorId, error: String(err) });
			});
		}, MESSAGE_DEBOUNCE_MS),
	);
}

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
		case "chapter:frozen":
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

		// Dependencies
		case "dependency:created":
		case "dependency:removed": {
			const pid4 = await projectIdForChapter(event.sourceId);
			if (pid4) await syncChapterEdgesForProject(pid4);
			break;
		}

		// Exploration groups
		case "exploration:created":
		case "exploration:decided":
		case "exploration:abandoned":
		case "exploration:chapter_added": {
			// We need the projectId — get it from the group's first chapter or the group itself
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
