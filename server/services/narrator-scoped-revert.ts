/**
 * Narrator-scoped rollback: undo one narrator's file changes and leave everyone
 * else's in place.
 *
 * A worktree is shared — several narrators, their subagents, the user's terminal
 * and editor all write to the same directory. The workspace-wide rollback in
 * `snapshot-revert.ts` restores every file to a recorded boundary, so in a shared
 * worktree it discards work that was never in scope.
 *
 * The precision needed for a narrower rollback is already recorded: every
 * `narrator_tool_calls` row carries `treeHashBefore` / `treeHashAfter`, and the
 * diff between that pair is exactly what the call changed. Reversing one call is
 * then a three-way tree merge:
 *
 *   base   = the call's end state   (`treeHashAfter`)
 *   ours   = the current workspace
 *   theirs = the call's start state (`treeHashBefore`)
 *
 * git keeps `ours` wherever `base` and `theirs` agree, which means every change
 * this narrator did not make survives — down to individual hunks inside a file
 * both actors edited. It also covers changes no tool input describes (Bash, build
 * scripts, external editors), because the boundaries are hashes of real bytes.
 *
 * ## Why the window is reversed segment by segment
 *
 * Collapsing a whole window to (first before, last after) would be wrong. That
 * span covers wall-clock time, not just this narrator's writes, so anything another
 * actor wrote *between* two of its tool calls falls inside the span and gets
 * reversed along with it:
 *
 *   v0 --(call 1)--> v1 --(other actor)--> v1+THEIRS --(call 2)--> v2+THEIRS
 *
 * Reversing (v0 … v2+THEIRS) as one span yields `v0`, silently destroying THEIRS.
 *
 * Tree hashes make the gap detectable exactly: consecutive calls with nothing in
 * between satisfy `previous.after === next.before`, because the hash covers every
 * byte in the worktree. A mismatch proves a foreign write landed there. So pairs
 * are collapsed only while they chain, and each resulting segment is reversed
 * separately against the accumulated result (see `planTreeRevertSegments`). Segment
 * reversal is also what makes a non-tail window safe: reversing an earlier segment
 * merges against later state, so later changes survive, and a genuine overlap
 * surfaces as a conflict instead of silent data loss.
 *
 * ## Subagents
 *
 * Subagent tool calls record no tree boundaries (the subagent executor does not
 * install the snapshot hooks), so a subagent's writes are foreign writes as far as
 * this module is concerned. That has two consequences, both handled rather than
 * assumed: they split segments like any other foreign write, and whether they
 * survive is decided by the merge, not by policy. The reported verdict therefore
 * comes from comparing the merge's own change set against the recorded subagent
 * paths — never from a fixed claim that they were left alone.
 */
import { and, asc, eq, gte, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { fileAttributions, narratorMessageRefs, narrators, narratorToolCalls } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { logger } from "../lib/logger";
import { normalizeWorkspacePath } from "./git-workspace";
import { invalidateWorkspaceTreeCache, isWorkspaceBeingWritten } from "./narrator-session-state";
import {
	EMPTY_RESULT,
	type RevertResult,
	type RevertWarning,
	registerTreeCompensation,
	resolveNarratorCwd,
	treeFailure,
} from "./snapshot-revert";
import {
	planTreeRevertSegments,
	type SegmentReversalPlan,
	supportsMergeTree,
	worktreeTreeSnapshot,
} from "./worktree-tree-snapshot";

/** One recorded pre/post workspace boundary for a single tool call. */
export interface BoundaryPair {
	toolUseId: string;
	messageId: string;
	seq: number;
	before: string;
	after: string;
}

/**
 * Which of a narrator's recorded writes a rollback should reverse.
 *
 * `toolUses` is the real unit of work: a boundary pair is recorded per tool call,
 * so a single call is the finest window that can be reversed, and one assistant
 * message can contain several. The message- and seq-shaped variants are
 * conveniences that expand to a set of tool calls.
 *
 * A tool use is addressed by `(messageId, toolUseId)` rather than the bare id.
 * The pair is what is actually unique: a message that gets cloned (a shared
 * message being edited, a rewritten history segment) leaves the same `toolUseId`
 * on rows under different `messageId`s, and selecting by id alone would return the
 * same boundary twice and reverse that one change twice.
 */
export type ScopedRevertSelector =
	| { minSeq: number }
	| { messageIds: string[] }
	| { toolUses: Array<{ messageId: string; toolUseId: string }> };

/**
 * Why a narrator-scoped rollback is not available for a given window.
 *
 * Surfaced to the UI so the confirmation dialog can explain the fallback instead
 * of silently offering a different behaviour than the one the user picked.
 */
export type ScopedRevertUnavailableReason =
	| "no_boundaries"
	| "snapshot_missing"
	| "no_workspace"
	| "git_unsupported";

export interface ScopedRevertPlan {
	worktreePath: string;
	/** Boundary pairs to reverse, oldest first. */
	pairs: BoundaryPair[];
}

/**
 * Select the narrator's boundary pairs, newest last.
 *
 * Pairs where `before === after` are dropped: the call completed without changing
 * the workspace, so it contributes nothing to reverse. This is what keeps
 * `spec://` writes (virtual files, never on disk) and read-only Bash from acting
 * as rollback anchors — no path-prefix special-casing required.
 */
async function selectPairs(
	narratorId: string,
	scope: ScopedRevertSelector,
): Promise<BoundaryPair[]> {
	if ("messageIds" in scope && scope.messageIds.length === 0) return [];
	if ("toolUses" in scope && scope.toolUses.length === 0) return [];
	const rows = await db
		.select({
			toolUseId: narratorToolCalls.toolUseId,
			messageId: narratorToolCalls.messageId,
			seq: narratorMessageRefs.seq,
			before: narratorToolCalls.treeHashBefore,
			after: narratorToolCalls.treeHashAfter,
			createdAt: narratorToolCalls.createdAt,
		})
		.from(narratorToolCalls)
		.innerJoin(
			narratorMessageRefs,
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
			),
		)
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.status, "success"),
				isNotNull(narratorToolCalls.treeHashBefore),
				isNotNull(narratorToolCalls.treeHashAfter),
				// Only calls that actually moved the workspace can be reversed.
				ne(narratorToolCalls.treeHashBefore, narratorToolCalls.treeHashAfter),
				selectorCondition(scope),
			),
		)
		.orderBy(asc(narratorMessageRefs.seq), asc(narratorToolCalls.createdAt));

	return dedupeBoundaryRows(rows);
}

/**
 * Drop boundary rows that describe the same recorded change twice.
 *
 * Real data contains the same `toolUseId` under more than one `messageId` (a message
 * cloned when shared history is edited), so a select can return one boundary twice.
 *
 * This is not a data-loss guard: reversing the same boundary again is
 * `merge(base=after, ours=before, theirs=before)`, which yields `before` unchanged.
 * It removes redundant work — a duplicate cannot chain with its own copy (chaining
 * needs `after === before`), so it would become an extra segment and cost one more
 * `merge-tree` per rollback.
 *
 * Exported for tests: the effect is invisible on disk precisely because reversal is
 * idempotent, so the only honest way to test it is on the selected pairs.
 */
export function dedupeBoundaryRows(
	rows: Array<{
		toolUseId: string;
		messageId: string;
		seq: number;
		before: string | null;
		after: string | null;
	}>,
): BoundaryPair[] {
	const seen = new Set<string>();
	const pairs: BoundaryPair[] = [];
	for (const row of rows) {
		// Keyed without `messageId`: the clone this exists for lives under a *different*
		// message, so including it would defeat the dedupe entirely. Identical
		// `before`/`after` hashes mean a byte-identical workspace transition, so the
		// rows describe one change no matter which message they hang off.
		const key = `${row.toolUseId}\u0000${row.before}\u0000${row.after}`;
		if (seen.has(key)) continue;
		seen.add(key);
		pairs.push({
			toolUseId: row.toolUseId,
			messageId: row.messageId,
			seq: row.seq,
			before: row.before as string,
			after: row.after as string,
		});
	}
	return pairs;
}

/** Translate a selector into the SQL predicate that narrows the boundary rows. */
function selectorCondition(scope: ScopedRevertSelector) {
	if ("messageIds" in scope) {
		return inArray(narratorToolCalls.messageId, scope.messageIds);
	}
	if ("toolUses" in scope) {
		// An empty list must never reach `or()`: drizzle returns undefined for zero
		// arguments, `and()` drops undefined members, and the predicate would vanish —
		// selecting every boundary this narrator ever recorded and rolling back all of
		// it. Callers guard against this, but the failure is too destructive to leave
		// resting on a caller's check.
		if (scope.toolUses.length === 0) return sql`1 = 0`;
		// Matched as pairs: a bare `toolUseId IN (...)` would also pick up a clone of
		// the same call living under a different message.
		return or(
			...scope.toolUses.map((target) =>
				and(
					eq(narratorToolCalls.messageId, target.messageId),
					eq(narratorToolCalls.toolUseId, target.toolUseId),
				),
			),
		);
	}
	return gte(narratorMessageRefs.seq, scope.minSeq);
}

/**
 * Build the reversal plan for a window, or explain why there is none.
 *
 * Never mutates the workspace — both the preview and the rollback derive from this
 * so they can never disagree about scope.
 */
export async function planNarratorScopedRevert(
	narratorId: string,
	scope: ScopedRevertSelector,
): Promise<{ plan: ScopedRevertPlan } | { unavailable: ScopedRevertUnavailableReason }> {
	if (!(await supportsMergeTree())) return { unavailable: "git_unsupported" };

	const worktreePath = await resolveNarratorCwd(narratorId);
	if (!worktreePath) return { unavailable: "no_workspace" };

	const pairs = await selectPairs(narratorId, scope);
	if (pairs.length === 0) return { unavailable: "no_boundaries" };

	// Every segment endpoint has to exist in the shadow repo, otherwise the merge
	// that needs it would fail mid-chain, after earlier segments were computed.
	try {
		const endpoints = new Set<string>();
		for (const segment of planTreeRevertSegments(pairs)) {
			endpoints.add(segment.before);
			endpoints.add(segment.after);
		}
		const present = await Promise.all(
			[...endpoints].map((treeHash) =>
				worktreeTreeSnapshot.hasTree(worktreePath, treeHash, LOCAL_DEVICE_ID),
			),
		);
		if (present.some((exists) => !exists)) return { unavailable: "snapshot_missing" };
	} catch (error) {
		logger.debug("Scoped revert boundary lookup failed", { narratorId, error: String(error) });
		return { unavailable: "snapshot_missing" };
	}

	return { plan: { worktreePath, pairs } };
}

export interface ScopedRevertPreviewFile {
	deviceId: string;
	filePath: string;
	relPath: string;
	willBeDeleted: boolean;
	/** Present only when contents were requested, for the diff view. */
	currentContent?: string | null;
	revertedContent?: string | null;
}

export interface ScopedRevertPreview {
	available: boolean;
	reason?: ScopedRevertUnavailableReason;
	/** Paths the rollback would change, from the same merge the rollback performs. */
	files: ScopedRevertPreviewFile[];
	/** Paths another actor changed in the same regions; a rollback would be refused. */
	conflicts: string[];
	/**
	 * Subagent changes inside the window that this rollback would also revert.
	 *
	 * Derived from the merge's own change set, so it reports what will actually
	 * happen rather than what the scope intends.
	 */
	subagentWarning?: { changeCount: number; sampleFiles: string[] };
}

/**
 * Describe what a narrator-scoped rollback would change.
 *
 * The file list comes from the same three-way merge the rollback runs, so the
 * dialog cannot promise a different scope than the one that gets applied.
 */
export async function previewNarratorScopedRevert(
	narratorId: string,
	scope: ScopedRevertSelector,
	opts?: { withContents?: boolean },
): Promise<ScopedRevertPreview> {
	const planned = await planNarratorScopedRevert(narratorId, scope);
	if ("unavailable" in planned) {
		return { available: false, reason: planned.unavailable, files: [], conflicts: [] };
	}
	const { plan } = planned;

	try {
		// One atomic capture+merge: the preview must describe a state that existed,
		// not a merge of one snapshot against a capture taken at another moment.
		const reversal = await worktreeTreeSnapshot.planReversal(
			plan.worktreePath,
			plan.pairs,
			LOCAL_DEVICE_ID,
		);
		const subagentWarning = await findSubagentOverlap(narratorId, plan, reversal.changedPaths);
		if (reversal.conflicts.length > 0) {
			return {
				available: true,
				files: [],
				conflicts: reversal.conflicts,
				...(subagentWarning && { subagentWarning }),
			};
		}

		const inMerged = new Set(
			await worktreeTreeSnapshot.listPaths(plan.worktreePath, reversal.mergedTree, LOCAL_DEVICE_ID),
		);
		const files: ScopedRevertPreviewFile[] = [];
		for (const relPath of reversal.changedPaths) {
			const file: ScopedRevertPreviewFile = {
				deviceId: LOCAL_DEVICE_ID,
				filePath: joinWorktreePath(plan.worktreePath, relPath),
				relPath,
				// Absent from the merged tree means the rollback removes it.
				willBeDeleted: !inMerged.has(relPath),
			};
			if (opts?.withContents) {
				// The diff view compares what is on disk now against what the rollback
				// would leave, so both sides come from this same merge.
				const [currentContent, revertedContent] = await Promise.all([
					worktreeTreeSnapshot.readFileAtTree(
						plan.worktreePath,
						reversal.currentTree,
						relPath,
						LOCAL_DEVICE_ID,
					),
					worktreeTreeSnapshot.readFileAtTree(
						plan.worktreePath,
						reversal.mergedTree,
						relPath,
						LOCAL_DEVICE_ID,
					),
				]);
				file.currentContent = currentContent;
				file.revertedContent = revertedContent;
			}
			files.push(file);
		}
		return {
			available: true,
			files,
			conflicts: [],
			...(subagentWarning && { subagentWarning }),
		};
	} catch (error) {
		logger.debug("Scoped revert preview unavailable", { narratorId, error: String(error) });
		return { available: false, reason: "snapshot_missing", files: [], conflicts: [] };
	}
}

/** Cap on subagent attribution rows inspected; the count is reported as a lower bound. */
const SUBAGENT_SCAN_LIMIT = 500;

/**
 * Subagent-written paths inside the window that this rollback actually reverts.
 *
 * Subagent work records no tree boundary, so it cannot be targeted or excluded
 * deliberately: the merge decides. Intersecting the recorded subagent paths with
 * the merge's own change set therefore reports the real outcome. Returning null
 * means the merge leaves every subagent change alone, so there is nothing to warn
 * about.
 *
 * Never throws: advice must not break a rollback that is otherwise sound.
 */
async function findSubagentOverlap(
	narratorId: string,
	plan: ScopedRevertPlan,
	changedPaths: string[],
): Promise<{ changeCount: number; sampleFiles: string[] } | null> {
	if (changedPaths.length === 0) return null;
	try {
		// `parentNarratorId` also records fork provenance, so the type filter is what
		// restricts this to real subagents; a fork sharing the worktree is a separate
		// actor whose changes the merge already protects.
		const children = await db
			.select({ id: narrators.id })
			.from(narrators)
			.where(and(eq(narrators.parentNarratorId, narratorId), eq(narrators.type, "subagent")));
		if (children.length === 0) return null;

		const earliest = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, plan.pairs[0].toolUseId),
			),
			columns: { createdAt: true },
		});
		if (!earliest) return null;

		const rows = await db
			.select({ filePath: fileAttributions.filePath })
			.from(fileAttributions)
			.where(
				and(
					eq(fileAttributions.deviceId, LOCAL_DEVICE_ID),
					eq(fileAttributions.workspacePath, normalizeWorkspacePath(plan.worktreePath)),
					gte(fileAttributions.changedAt, earliest.createdAt),
					inArray(
						fileAttributions.narratorId,
						children.map((child) => child.id),
					),
				),
			)
			.limit(SUBAGENT_SCAN_LIMIT);
		if (rows.length === 0) return null;

		// Attribution paths are worktree-relative, the same shape the merge reports.
		const reverted = new Set(changedPaths);
		const affected = [...new Set(rows.map((row) => row.filePath))].filter((filePath) =>
			reverted.has(filePath),
		);
		if (affected.length === 0) return null;
		return { changeCount: affected.length, sampleFiles: affected.slice(0, 10) };
	} catch (error) {
		logger.debug("Subagent overlap detection failed", { narratorId, error: String(error) });
		return null;
	}
}

function joinWorktreePath(worktreePath: string, relPath: string): string {
	return `${worktreePath.replace(/[/\\]+$/, "")}/${relPath}`;
}

/**
 * Reverse this narrator's changes in the window and write the result to disk.
 *
 * Returns `null` when a scoped rollback does not apply, so the caller can fall
 * back to the existing workspace-tree or per-file paths. A conflict is a populated
 * `failures` list rather than a fallback: quietly widening the scope after the user
 * asked for the narrow one would discard another actor's work.
 */
async function revertNarratorScoped(
	narratorId: string,
	scope: ScopedRevertSelector,
): Promise<RevertResult | null> {
	const planned = await planNarratorScopedRevert(narratorId, scope);
	if ("unavailable" in planned) {
		logger.debug("Narrator-scoped revert not applicable", {
			narratorId,
			reason: planned.unavailable,
		});
		return null;
	}
	const { plan } = planned;

	// Planning did several awaited DB and git reads, so a loop could have started in
	// the meantime even though the route admitted this request. Re-checked here, the
	// last point before files are written, mirroring what the revert/unrevert
	// endpoints do around their own DB work. Without it the rollback races the
	// narrator's own tools and fails on the state-drift guard instead.
	if (isWorkspaceBeingWritten(plan.worktreePath)) {
		return {
			...EMPTY_RESULT,
			failures: [
				treeFailure(
					plan.worktreePath,
					"PREPARE_FAILED",
					new Error(
						"Something is writing to this workspace (the narrator or one of its subagents); " +
							"stop it before rolling back.",
					),
				),
			],
		};
	}

	let outcome: Awaited<ReturnType<typeof worktreeTreeSnapshot.reverseAndRestore>>;
	try {
		outcome = await worktreeTreeSnapshot.reverseAndRestore(
			plan.worktreePath,
			plan.pairs,
			LOCAL_DEVICE_ID,
		);
	} catch (error) {
		// The reversal writes the worktree without going through a tool, so any live
		// session's cached tree hash must not survive it — including on failure, which
		// can land after some files were already written.
		invalidateWorkspaceTreeCache(plan.worktreePath);
		return {
			...EMPTY_RESULT,
			failures: [treeFailure(plan.worktreePath, "TREE_RESTORE_FAILED", error)],
		};
	}
	invalidateWorkspaceTreeCache(plan.worktreePath);

	if (outcome.conflicts.length > 0) {
		return {
			...EMPTY_RESULT,
			failures: [
				treeFailure(
					plan.worktreePath,
					"REVERT_CONFLICT",
					new Error(
						`Another actor changed the same regions: ${outcome.conflicts.slice(0, 10).join(", ")}. ` +
							"Undo the whole workspace instead, or delete the messages without reverting files.",
					),
				),
			],
		};
	}

	const warnings: RevertWarning[] = [];
	const subagentOverlap = await findSubagentOverlap(narratorId, plan, outcome.changedFiles);
	if (subagentOverlap) {
		warnings.push({
			code: "SUBAGENT_CHANGES_REVERTED",
			changeCount: subagentOverlap.changeCount,
			sampleFilePaths: subagentOverlap.sampleFiles,
		});
	}

	const result: RevertResult = {
		reverted: outcome.changedFiles.length > 0,
		fileCount: outcome.changedFiles.length,
		files: outcome.changedFiles.map((relPath) => joinWorktreePath(plan.worktreePath, relPath)),
		failures: [],
		...(warnings.length > 0 && { warnings }),
	};
	if (outcome.previousTreeHash !== outcome.mergedTree) {
		registerTreeCompensation(result, plan.worktreePath, outcome.previousTreeHash);
	}
	logger.info("Reverted narrator-scoped changes", {
		narratorId,
		worktreePath: plan.worktreePath,
		fileCount: result.fileCount,
		segmentCount: planTreeRevertSegments(plan.pairs).length,
	});
	return result;
}

/** Reversal plan shape re-exported for callers that render a preview. */
export type { SegmentReversalPlan };

/** Scoped rollback for "undo everything from this message onwards". */
export function revertNarratorScopedFromSeq(
	narratorId: string,
	minSeq: number,
): Promise<RevertResult | null> {
	return revertNarratorScoped(narratorId, { minSeq });
}

/** Scoped rollback for a set of messages about to be deleted. */
export function revertNarratorScopedForMessages(
	narratorId: string,
	messageIds: string[],
): Promise<RevertResult | null> {
	return revertNarratorScoped(narratorId, { messageIds });
}

/**
 * Scoped rollback for individual tool calls — the finest window there is.
 *
 * This is what makes "undo just this one operation" work on the unit the user
 * actually sees. Because each segment is merged against the accumulated result,
 * work that came after the targeted call survives; a genuine overlap surfaces as a
 * conflict rather than silently discarding it.
 */
export function revertNarratorScopedForToolUses(
	narratorId: string,
	toolUses: Array<{ messageId: string; toolUseId: string }>,
): Promise<RevertResult | null> {
	return revertNarratorScoped(narratorId, { toolUses });
}

/** Preview for rolling back individual tool calls. */
export function previewNarratorScopedForToolUses(
	narratorId: string,
	toolUses: Array<{ messageId: string; toolUseId: string }>,
	opts?: { withContents?: boolean },
): Promise<ScopedRevertPreview> {
	return previewNarratorScopedRevert(narratorId, { toolUses }, opts);
}

/** Preview for "undo everything from this message onwards". */
export function previewNarratorScopedFromSeq(
	narratorId: string,
	minSeq: number,
	opts?: { withContents?: boolean },
): Promise<ScopedRevertPreview> {
	return previewNarratorScopedRevert(narratorId, { minSeq }, opts);
}

/** Preview for deleting a set of messages. */
export function previewNarratorScopedForMessages(
	narratorId: string,
	messageIds: string[],
	opts?: { withContents?: boolean },
): Promise<ScopedRevertPreview> {
	return previewNarratorScopedRevert(narratorId, { messageIds }, opts);
}
