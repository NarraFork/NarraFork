/**
 * Maintains each chapter's position in the snapshot DAG.
 *
 * A chapter's state used to be expressible only as a commit, which is why forking
 * and merging demanded one: there was no other name for "the state this chapter is
 * in". `chapters.snapshotCommitSha` is that name, and this module is its single
 * writer — deliberately, because a pointer maintained from several places drifts,
 * and a stale pointer means forking from the wrong state.
 *
 * Callers hand over a workspace path and (optionally) a tree they already captured.
 * Nothing here throws: the DAG is layered on top of boundary hashes that are
 * recorded independently, so failing to extend it degrades fork precision but must
 * never break a tool call, a watcher tick, or a merge.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { chapters } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { logger } from "../lib/logger";
import { normalizePathForComparison } from "../lib/platform-path";
import { SNAPSHOT_HEAD_REF, treeSnapshotKey, worktreeTreeSnapshot } from "./worktree-tree-snapshot";

/** Outcome of extending a lineage: the recorded tree and its snapshot commit. */
export interface SnapshotAdvance {
	treeHash: string;
	commitSha: string;
}

/**
 * Record a workspace state in the DAG and point every owning chapter at it.
 *
 * `treeHash` is the tree the caller already captured. Passing it matters on the
 * tool-execution path: capturing is the one step whose cost scales with repository
 * size, and the hooks have already paid it. Omit it only when no capture happened
 * yet.
 *
 * Returns null when no lineage could be extended — a remote workspace, a
 * non-git directory, or a git failure. The caller should treat that as "no DAG
 * position for this boundary" rather than an error.
 */
export async function advanceChapterSnapshot(
	worktreePath: string,
	treeHash?: string | null,
	message = "workspace snapshot",
): Promise<SnapshotAdvance | null> {
	const advanced = treeHash
		? await worktreeTreeSnapshot.linkSnapshot(worktreePath, treeHash, message)
		: await worktreeTreeSnapshot.advanceSnapshotRef(worktreePath, message);
	if (!advanced) return null;

	await pointChaptersAt(worktreePath, advanced.commitSha);
	return advanced;
}

/**
 * Update the chapter rows that own this workspace.
 *
 * Matched on `worktreePath` rather than on a chapter id the caller supplies,
 * because a workspace can back more than one narrator (subagents, the root
 * chapter) and the position belongs to the workspace, not to whoever wrote last.
 *
 * `snapshotShadowKey` is written alongside, and is the reason a dormant chapter's
 * lineage survives: it outlives `worktreePath` being nulled, which is what lets the
 * orphan sweep tell a dormant chapter's shadow repository from an abandoned one.
 */
async function pointChaptersAt(worktreePath: string, commitSha: string): Promise<void> {
	try {
		// Matched against both the raw and the normalized spelling. `chapters.worktreePath`
		// is stored as whoever created the chapter supplied it (the project's `gitPath` for
		// a root chapter, a constructed `.worktrees/<name>` for a fork) and is never
		// normalized on write, while `snapshotShadowKey` in the same `set` *is* normalized.
		// Comparing on the raw value alone therefore matched zero rows whenever the caller's
		// path differed only in case or a trailing separator — and the update then silently
		// did nothing, leaving the chapter pointing at an older snapshot while the DAG had
		// already moved on. A fork from that chapter starts from the stale state.
		const normalized = snapshotWorkspaceKey(worktreePath);
		const candidates = normalized === worktreePath ? [worktreePath] : [worktreePath, normalized];
		const updated = await db
			.update(chapters)
			.set({
				snapshotCommitSha: commitSha,
				snapshotShadowKey: treeSnapshotKey(LOCAL_DEVICE_ID, worktreePath),
			})
			.where(inArray(chapters.worktreePath, candidates))
			.returning({ id: chapters.id });
		// Zero rows is legitimate for a standalone narrator with no chapter, but it is also
		// exactly what the silent-mismatch bug above looked like. Logged so the two are
		// distinguishable from the outside instead of both being invisible.
		if (updated.length === 0) {
			logger.debug("No chapter row owns this workspace; snapshot pointer not stored", {
				worktreePath,
				commitSha,
			});
		}
	} catch (error) {
		// The DAG itself is already advanced and durable; only the denormalized
		// pointer is behind. Fork falls back to walking the narrator timeline, so this
		// costs precision rather than correctness.
		logger.debug("Failed to update a chapter's snapshot pointer", {
			worktreePath,
			error: String(error),
		});
	}
}

/**
 * The snapshot commit a chapter is currently at, or null when it has none.
 *
 * Prefers the stored pointer and falls back to reading the workspace's head ref,
 * so a chapter whose pointer was never written (a row predating the DAG, or an
 * update that failed) still resolves as long as its shadow repository has a
 * lineage. Verified against the shadow repository before being returned: a pointer
 * to a commit that no longer exists is worse than no pointer, because the caller
 * would fork from it and fail late.
 */
export async function resolveChapterSnapshot(
	chapterId: string,
): Promise<{ commitSha: string; worktreePath: string } | null> {
	const chapter = await db.query.chapters.findFirst({
		where: eq(chapters.id, chapterId),
		columns: { worktreePath: true, snapshotCommitSha: true },
	});
	if (!chapter?.worktreePath) return null;
	const worktreePath = chapter.worktreePath;

	if (chapter.snapshotCommitSha) {
		const tree = await worktreeTreeSnapshot
			.treeOfSnapshot(worktreePath, chapter.snapshotCommitSha)
			.catch(() => null);
		if (tree) return { commitSha: chapter.snapshotCommitSha, worktreePath };
		logger.debug("Chapter snapshot pointer no longer resolves; falling back to the head ref", {
			chapterId,
			snapshotCommitSha: chapter.snapshotCommitSha,
		});
	}

	const head = await worktreeTreeSnapshot.getRef(worktreePath, SNAPSHOT_HEAD_REF).catch(() => null);
	return head ? { commitSha: head, worktreePath } : null;
}

/**
 * Ensure a workspace has a DAG position, capturing one if it has none.
 *
 * For entry points that need a lineage to exist before they can proceed (forking
 * from a chapter that has not run a file-mutating tool yet, so no hook has fired).
 * Idempotent: an existing head is returned untouched.
 */
export async function ensureChapterSnapshot(
	worktreePath: string,
	message = "workspace snapshot",
): Promise<SnapshotAdvance | null> {
	const existing = await worktreeTreeSnapshot
		.getRef(worktreePath, SNAPSHOT_HEAD_REF)
		.catch(() => null);
	if (existing) {
		const tree = await worktreeTreeSnapshot
			.treeOfSnapshot(worktreePath, existing)
			.catch(() => null);
		// A capture still has to run when the head exists but the workspace moved since
		// — otherwise a fork would start from a state the user has already edited past.
		const current = await worktreeTreeSnapshot.tryCapture(worktreePath);
		if (tree && current && tree === current) {
			await pointChaptersAt(worktreePath, existing);
			return { treeHash: tree, commitSha: existing };
		}
		if (current) return advanceChapterSnapshot(worktreePath, current, message);
	}
	return advanceChapterSnapshot(worktreePath, null, message);
}

/**
 * Normalized form of a workspace path, for comparing against DB rows.
 *
 * Kept exported despite having had no callers: it is now what {@link pointChaptersAt}
 * uses, so the normalization rule this module applies to `chapters.worktreePath` has
 * exactly one definition. A caller that needs to find the same rows — and there is no
 * index on that column yet, so such a query should be rare — must use this rather than
 * a second `normalizePathForComparison` call that could drift from it.
 */
export function snapshotWorkspaceKey(worktreePath: string): string {
	return normalizePathForComparison(worktreePath);
}
