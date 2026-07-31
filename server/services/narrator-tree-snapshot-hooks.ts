/**
 * Workspace tree snapshot recording for the narrator's tool lifecycle.
 *
 * These are the bodies behind the agent loop's `onSnapshotBefore` /
 * `onSnapshotAfter` hooks. They live apart from `narrator-session.ts` so the
 * recording contract can be tested against real git worktrees without standing
 * up a whole session.
 *
 * Contract: capture the worktree before a file-mutating tool runs and again once
 * it completes, then persist both hashes on the tool call and mirror the result
 * onto the owning message. Every failure degrades to "no snapshot for this
 * boundary" — snapshotting must never break a narrator's turn.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { narratorMessages, narratorToolCalls } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { logger } from "../lib/logger";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";

/** The session state this module reads and updates. */
export interface TreeSnapshotSession {
	cwd: string;
	/** Execution device for the session; only local workspaces can be snapshotted. */
	_defaultDeviceId?: string | null;
	/** Staged pre-execution hashes, keyed by toolUseId. */
	_treeHashBefore?: Map<string, string>;
	/** Cache of the most recent capture; cleared whenever a tool writes. */
	_lastTreeHash?: string;
}

/**
 * Capture the session workspace, reusing the cached hash when nothing has run
 * since the last capture.
 *
 * Never throws. Returns null for a remote target, a non-git cwd, or a git error.
 */
export async function captureSessionTree(
	session: TreeSnapshotSession,
	narratorId: string,
): Promise<string | null> {
	if (session._lastTreeHash) return session._lastTreeHash;
	// Remote workspaces have no shadow repository yet; the per-file snapshot path
	// still covers them.
	if ((session._defaultDeviceId ?? LOCAL_DEVICE_ID) !== LOCAL_DEVICE_ID) return null;
	const treeHash = await worktreeTreeSnapshot.tryCapture(session.cwd, LOCAL_DEVICE_ID);
	if (!treeHash) {
		logger.debug("Workspace tree snapshot unavailable", { narratorId, cwd: session.cwd });
		return null;
	}
	session._lastTreeHash = treeHash;
	return treeHash;
}

/** Stage the pre-execution hash for one tool call. */
export async function recordTreeSnapshotBefore(
	session: TreeSnapshotSession,
	narratorId: string,
	toolUseId: string,
): Promise<void> {
	const treeHash = await captureSessionTree(session, narratorId);
	if (!treeHash) return;
	if (!session._treeHashBefore) session._treeHashBefore = new Map();
	session._treeHashBefore.set(toolUseId, treeHash);
}

export interface TreeSnapshotAfterResult {
	before: string | null;
	after: string | null;
	/** Paths that changed between the two snapshots, when both exist. */
	changedFiles: string[];
}

/**
 * Capture the post-execution hash, persist both boundaries, and report the paths
 * the tool actually changed.
 *
 * The returned path list comes from diffing the two trees, which is why it is
 * more reliable than the `git status` set difference this replaced: it also sees
 * files that were already modified before the tool ran.
 */
export async function recordTreeSnapshotAfter(
	session: TreeSnapshotSession,
	narratorId: string,
	toolUseId: string,
): Promise<TreeSnapshotAfterResult> {
	const before = session._treeHashBefore?.get(toolUseId) ?? null;
	session._treeHashBefore?.delete(toolUseId);
	// The tool just wrote, so any cached hash describes a stale state.
	session._lastTreeHash = undefined;
	const after = await captureSessionTree(session, narratorId);
	if (!before && !after) return { before, after, changedFiles: [] };

	try {
		const [updated] = await db
			.update(narratorToolCalls)
			.set({
				...(before && { treeHashBefore: before }),
				...(after && { treeHashAfter: after }),
			})
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			)
			.returning({ messageId: narratorToolCalls.messageId });
		// Mirror the resulting state onto the owning message so rolling back "to just
		// after this message" has a boundary to restore. A later tool in the same
		// message overwrites it, which is correct: the boundary is the state after the
		// message's final tool.
		if (after && updated?.messageId) {
			await db
				.update(narratorMessages)
				.set({ treeHashAfter: after })
				.where(eq(narratorMessages.id, updated.messageId));
		}
	} catch (err) {
		logger.debug("Failed to persist tool call tree hashes", {
			narratorId,
			toolUseId,
			error: String(err),
		});
	}

	let changedFiles: string[] = [];
	if (before && after && before !== after) {
		try {
			changedFiles = await worktreeTreeSnapshot.diffPaths(
				session.cwd,
				before,
				after,
				LOCAL_DEVICE_ID,
			);
		} catch (err) {
			logger.debug("Tree snapshot diff failed", { narratorId, toolUseId, error: String(err) });
		}
	}
	return { before, after, changedFiles };
}
