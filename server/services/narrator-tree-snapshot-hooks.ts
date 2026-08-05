/**
 * Workspace tree snapshot recording for the narrator's tool lifecycle.
 *
 * These are the bodies behind the agent loop's `onSnapshotBefore` /
 * `onSnapshotAfter` hooks. They live apart from `narrator-session.ts` so the
 * recording contract can be tested against real git worktrees without standing
 * up a whole session.
 *
 * Contract: capture the worktree before a file-mutating tool runs and again once
 * it completes, persist both hashes on the tool call, mirror the result onto the
 * owning message, and resolve which of the changed paths this call actually owns.
 * Every failure degrades to "no snapshot for this boundary" — snapshotting must
 * never break a narrator's turn.
 *
 * ## Why a boundary pair is not enough
 *
 * A tree hash covers every byte in the worktree, which is what lets it see writes
 * no tool input describes (Bash, build scripts, external editors). But a worktree
 * is shared: several narrators, their subagents, the user's terminal and editor
 * write to the same directory. So the delta between `before` and `after` contains
 * whatever landed there during the window, not just this tool's work — a read-only
 * `git log` can come out looking like it changed files.
 *
 * The owned set closes that gap. Write/Edit declare their target path before they
 * execute, and the shell path subtracts whatever a neighbour declared in an
 * overlapping window. The result is persisted so a rollback can act on this call's
 * own changes instead of the whole workspace delta.
 */
import { relative } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { narratorMessages, narratorToolCalls } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { logger } from "../lib/logger";
import { specVfsService } from "./spec-vfs-service";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";
import {
	closeClaim,
	foreignDeclaredPaths,
	openClaim,
	peekClaim,
	sealClaim,
	sealNarratorClaims,
} from "./worktree-write-claims";

/** The session state this module reads and updates. */
export interface TreeSnapshotSession {
	cwd: string;
	/** Execution device for the session; only local workspaces can be snapshotted. */
	_defaultDeviceId?: string | null;
	/** Staged pre-execution hashes, keyed by toolUseId. */
	_treeHashBefore?: Map<string, string>;
	/** Cache of the most recent capture; cleared whenever a tool writes. */
	_lastTreeHash?: string;
	/**
	 * When `_lastTreeHash` was captured (epoch ms).
	 *
	 * The cached hash is reused as the next tool's `before`, so the span the two
	 * boundaries describe can start well before that tool did — in real sessions by
	 * many seconds. Attribution has to be asked about *that* span, not about the
	 * tool's own runtime, otherwise a neighbour's write landing in the gap is
	 * invisible to the query and gets credited to the tool.
	 */
	_lastTreeHashAt?: number;
}

/**
 * Resolve the worktree-relative paths a tool declared it will write.
 *
 * Runs *before* execution, so `narrator_tool_calls.resolvedFilePath` (written
 * afterwards) is not available — the declaration can only come from the tool
 * input.
 *
 * Returns `[]` rather than null for anything that provably writes nothing inside
 * this worktree. The distinction matters downstream: `[]` means "declared, owns
 * nothing", while null means "cannot declare, derive from the tree delta".
 *
 * Never throws: a malformed input must not break the tool's turn.
 */
export function declaredWorktreePaths(cwd: string, input: unknown): string[] {
	const filePath = (input as Record<string, unknown> | null)?.file_path;
	if (typeof filePath !== "string" || filePath.length === 0) return [];
	// Dynamic Spec URIs are virtual: nothing reaches the worktree, so there is
	// nothing a rollback could restore. This is what previously showed up as
	// `before === after` and is now stated directly.
	if (specVfsService.isSpecUri(filePath)) return [];
	try {
		const rel = relative(cwd, filePath);
		// Empty means the path *is* the worktree root; ".." means it escapes the tree.
		// Neither is a file this call can own.
		if (!rel || rel === "." || rel.startsWith("..")) return [];
		// git reports paths with forward slashes even on Windows, and the owned set is
		// compared against `diff-tree` output.
		return [rel.split(/[\\/]/).join("/")];
	} catch {
		return [];
	}
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
	session._lastTreeHashAt = Date.now();
	return treeHash;
}

/**
 * Stage the pre-execution hash for one tool call and register its write window.
 *
 * `declared` is the tool's own statement of what it will write: the paths from
 * {@link declaredWorktreePaths} for Write/Edit, or `null` for a shell command,
 * which cannot know. The claim is registered even when the snapshot itself fails,
 * so a neighbouring shell command can still subtract this call's declaration.
 */
export async function recordTreeSnapshotBefore(
	session: TreeSnapshotSession,
	narratorId: string,
	toolUseId: string,
	declared: string[] | null = null,
): Promise<void> {
	const treeHash = await captureSessionTree(session, narratorId);
	// The claim window has to start when the `before` state was actually captured,
	// which may be earlier than now: a cached hash from a previous tool is reused,
	// and everything written since then is inside the span the two boundaries
	// describe. Registered after the capture so that timestamp is available.
	openClaim(session.cwd, narratorId, toolUseId, declared, session._lastTreeHashAt);
	if (!treeHash) return;
	if (!session._treeHashBefore) session._treeHashBefore = new Map();
	session._treeHashBefore.set(toolUseId, treeHash);
}

/**
 * End one tool call's write window without measuring what it wrote.
 *
 * For the paths where {@link recordTreeSnapshotAfter} never runs: the tool threw,
 * the turn was aborted between `tool_call` and `tool_result`, or a re-run's
 * execution metadata did not name a local device. The claim opened by the
 * pre-execution hook would otherwise stay in flight, and an in-flight claim is read
 * as extending to now — so a single leak makes its declared paths overlap *every*
 * later window and get subtracted from every other narrator's shell call in this
 * worktree, silently turning their real writes into unrevertable ones.
 *
 * The declaration is kept rather than cleared: the tool may well have written its
 * target before failing, and a neighbour inside the span it really occupied must
 * still see it. Only the window's end is pinned.
 *
 * Never throws — this runs on cleanup paths that must not fail.
 */
export function abandonTreeSnapshot(
	session: TreeSnapshotSession,
	narratorId: string,
	toolUseId: string,
): void {
	try {
		session._treeHashBefore?.delete(toolUseId);
		// Whatever the tool managed to write before failing is on disk now, so a
		// cached hash from before it ran no longer describes the workspace.
		session._lastTreeHash = undefined;
		if (sealClaim(session.cwd, toolUseId)) {
			logger.debug("Sealed an unfinished tool write claim", { narratorId, toolUseId });
		}
	} catch (err) {
		logger.debug("Failed to seal an unfinished tool write claim", {
			narratorId,
			toolUseId,
			error: String(err),
		});
	}
}

/**
 * End every write window this narrator still holds on its workspace.
 *
 * The turn-level counterpart of {@link abandonTreeSnapshot}, for an abort or loop
 * error: the loop stops emitting `tool_result`, so the per-call hook never runs for
 * the tools that had already been announced. Write/Edit/Bash are all excluded from
 * eager execution, which is exactly the set whose pre-execution hook has run by
 * then — so without this every interrupted turn leaks its declarations.
 *
 * Never throws.
 */
export function abandonSessionTreeSnapshots(
	session: TreeSnapshotSession,
	narratorId: string,
): void {
	try {
		session._treeHashBefore?.clear();
		session._lastTreeHash = undefined;
		const sealed = sealNarratorClaims(session.cwd, narratorId);
		if (sealed > 0) {
			logger.debug("Sealed unfinished tool write claims after a turn ended", {
				narratorId,
				sealed,
			});
		}
	} catch (err) {
		logger.debug("Failed to seal unfinished tool write claims", {
			narratorId,
			error: String(err),
		});
	}
}

export interface TreeSnapshotAfterResult {
	before: string | null;
	after: string | null;
	/**
	 * Paths this call is attributable for.
	 *
	 * Not the raw tree delta: in a shared worktree that would include a
	 * neighbour's concurrent writes. This is the delta narrowed to what the call
	 * declared, or (for a shell command) the delta minus what neighbours declared.
	 */
	changedFiles: string[];
	/**
	 * The raw workspace delta between the two boundaries, for callers that need the
	 * unattributed set. Empty when either boundary is missing.
	 */
	workspaceDelta: string[];
}

/**
 * Capture the post-execution hash, persist both boundaries plus the owned path
 * set, and report the paths this call is attributable for.
 *
 * The owned set is what makes a rollback in a shared worktree honest, and it is
 * also what gets attributed in `file_attributions`: reporting the raw delta there
 * credited one narrator with another's edits.
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
	if (!before && !after) {
		// Nothing was measured, so there is no resolved set to close the claim with.
		closeClaim(session.cwd, toolUseId, []);
		return { before, after, changedFiles: [], workspaceDelta: [] };
	}

	let workspaceDelta: string[] = [];
	if (before && after && before !== after) {
		try {
			workspaceDelta = await worktreeTreeSnapshot.diffPaths(
				session.cwd,
				before,
				after,
				LOCAL_DEVICE_ID,
			);
		} catch (err) {
			logger.debug("Tree snapshot diff failed", { narratorId, toolUseId, error: String(err) });
		}
	}

	const owned = resolveOwnedPaths(session.cwd, narratorId, toolUseId, workspaceDelta);
	// Closing with the resolved set (not the declaration) keeps the registry honest:
	// a declared path the tool never touched must stop shadowing neighbours.
	closeClaim(session.cwd, toolUseId, owned);

	try {
		const [updated] = await db
			.update(narratorToolCalls)
			.set({
				...(before && { treeHashBefore: before }),
				...(after && { treeHashAfter: after }),
				// Written whenever a boundary exists, including as an empty array: that
				// is a positive result ("this call changed nothing"), which is exactly
				// what a rollback needs to know to skip it.
				...(before && after && { ownedPathsJson: owned }),
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

	return { before, after, changedFiles: owned, workspaceDelta };
}

/**
 * Narrow a workspace delta to the paths one tool call is attributable for.
 *
 * Two cases, both resting on what the call could state up front:
 *
 *   - It declared paths → intersect. A declared path missing from the delta was
 *     not actually written (an Edit that produced identical bytes), and a delta
 *     path it never declared belongs to someone else.
 *   - It declared nothing (shell) → subtract every path a neighbour declared in an
 *     overlapping window. What remains is either this command's work or an
 *     undeclared actor's, and the shell is the only actor that can produce it
 *     without declaring.
 *
 * The declaration is read back from the claim registry rather than passed between
 * the two hooks, so the "before" and "after" halves cannot disagree about what was
 * declared. The claim's own `from` bounds the overlap query, so a neighbour that
 * finished before this call started is not counted.
 */
function resolveOwnedPaths(
	worktreePath: string,
	narratorId: string,
	toolUseId: string,
	workspaceDelta: string[],
): string[] {
	if (workspaceDelta.length === 0) return [];
	const claim = peekClaim(worktreePath, toolUseId);
	const declared = claim?.declared ?? null;
	if (declared !== null) {
		if (declared.length === 0) return [];
		const inDelta = new Set(workspaceDelta);
		return declared.filter((path) => inDelta.has(path));
	}
	const foreign = foreignDeclaredPaths(
		worktreePath,
		narratorId,
		toolUseId,
		claim?.from ?? Date.now(),
		Date.now(),
	);
	return foreign.size === 0 ? workspaceDelta : workspaceDelta.filter((path) => !foreign.has(path));
}
