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
import { isAbsolute, relative, resolve, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { narratorMessages, narratorToolCalls } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { advanceChapterSnapshot } from "./chapter-snapshot-ref";
import { specVfsService } from "./spec-vfs-service";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";
import { worktreeWatcher } from "./worktree-watcher";
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
	/** Last observation, for compatibility only; never reused as a tool boundary. */
	_lastTreeHash?: string;
	/** When the last observation completed (epoch ms), not a future tool's start. */
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
		const rel = relative(cwd, resolve(cwd, filePath));
		// Empty means the root itself; a parent component or a different Windows
		// drive escapes the scope. A filename beginning with '..' does not.
		if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return [];
		// Only the local platform's separator is a separator. A backslash is a real
		// filename byte on POSIX, not a Windows path to reinterpret.
		return [rel.split(sep).join("/")];
	} catch {
		return [];
	}
}

/**
 * Capture a fresh session-workspace observation. A previous session hash cannot
 * describe the next boundary: human and other narrator writes bypass that cache.
 *
 * Never throws. Returns null for a remote target, a non-git cwd, or a git error.
 *
 * Two deliberate degradation valves live here. The `chapters.treeSnapshotsEnabled`
 * setting is the manual escape hatch for worktrees where the whole-tree scan is
 * not viable at all; and the capture itself goes through `tryCaptureHot`, which
 * bounds how long the narrator's event consumer may stall on it and lets an
 * over-budget scan finish in the background instead of blocking the session
 * (the cold-index cycle that froze huge Windows worktrees).
 */
export async function captureSessionTree(
	session: TreeSnapshotSession,
	narratorId: string,
	opts?: { minCaptureStartedAt?: number },
): Promise<string | null> {
	// Even a failed/disabled capture must not leave a stale observation looking fresh.
	session._lastTreeHash = undefined;
	session._lastTreeHashAt = undefined;
	if (!settings.chapters.treeSnapshotsEnabled) return null;
	if ((session._defaultDeviceId ?? LOCAL_DEVICE_ID) !== LOCAL_DEVICE_ID) return null;
	const treeHash = await worktreeTreeSnapshot.tryCaptureHot(session.cwd, LOCAL_DEVICE_ID, {
		// Before boundaries also reject an older in-flight warm scan. It may have
		// read this file before a human saved it between the two tool calls.
		minStartedAt: opts?.minCaptureStartedAt ?? Date.now(),
		requireFresh: true,
	});
	if (!treeHash) {
		logger.warn("Workspace tree snapshot unavailable; boundary protection degraded", {
			narratorId,
			cwd: session.cwd,
		});
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
	// A repeated attempt cannot inherit an earlier attempt's staged boundary.
	session._treeHashBefore?.delete(toolUseId);
	const startedAt = Date.now();
	const treeHash = await captureSessionTree(session, narratorId, {
		minCaptureStartedAt: startedAt,
	});
	// The scan is an observation window, not an atomic timestamp. Include writes
	// that overlap the scan, but never extend it back to a previous tool's cache.
	if ((session._defaultDeviceId ?? LOCAL_DEVICE_ID) !== LOCAL_DEVICE_ID) return;
	openClaim(session.cwd, narratorId, toolUseId, declared, startedAt);
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
	opts?: { unavailable: true },
): Promise<TreeSnapshotAfterResult> {
	const before = opts?.unavailable ? null : (session._treeHashBefore?.get(toolUseId) ?? null);
	session._treeHashBefore?.delete(toolUseId);
	// The tool just wrote, so any cached hash describes a stale state.
	session._lastTreeHash = undefined;
	// A shared in-flight capture is only usable as the *after* boundary when its
	// scan started no earlier than the tool's completion: one started earlier
	// (typically the pre-execution hook's own over-budget capture, promoted to a
	// background warm-up) may have read some files before the tool wrote them,
	// producing a tree that never existed on disk. Rolling back "to after this
	// message" would then silently drop this call's own edits. The cutoff tells
	// tryCaptureHot to wait out such a scan and re-capture instead of sharing it.
	const after = opts?.unavailable
		? null
		: await captureSessionTree(session, narratorId, {
				minCaptureStartedAt: Date.now(),
			});
	// A missing boundary or failed diff is unknown, never an ownedPaths=[] no-op.
	let deltaMeasured = before !== null && after !== null;
	let workspaceDelta: string[] = [];
	let deltaStatuses: { path: string; kind: "added" | "updated" | "deleted" }[] = [];
	if (before && after && before !== after) {
		try {
			// Statuses rather than bare paths: the same diff answers both questions, and
			// the file tree cannot patch itself from paths alone (a path that changed does
			// not say whether a row should appear, refresh, or be removed).
			deltaStatuses = await worktreeTreeSnapshot.diffPathStatuses(
				session.cwd,
				before,
				after,
				LOCAL_DEVICE_ID,
			);
			workspaceDelta = deltaStatuses.map((entry) => entry.path);
		} catch (err) {
			deltaMeasured = false;
			logger.warn("Tree snapshot diff failed; path coverage is unknown", {
				narratorId,
				toolUseId,
				error: String(err),
			});
		}
	}

	// Announce the delta to anything rendering this workspace.
	//
	// The WHOLE delta, not the narrower `owned` set computed below: `owned` answers
	// "who is accountable for this write" (for attribution and rollback), while a file
	// tree only asks "what does the directory look like now". A neighbour's concurrent
	// write is not this call's responsibility but it IS on disk, so filtering it out
	// would leave the tree showing a state that no longer exists.
	if (deltaStatuses.length > 0) {
		emitWorkspacePathChanges(session.cwd, narratorId, deltaStatuses);
	}

	const owned = resolveOwnedPaths(session.cwd, narratorId, toolUseId, workspaceDelta);
	if (deltaMeasured) {
		// Only a measured empty delta can clear a tool's declared paths.
		closeClaim(session.cwd, toolUseId, owned);
	} else {
		sealClaim(session.cwd, toolUseId);
	}

	try {
		const [updated] = await db
			.update(narratorToolCalls)
			.set({
				treeHashBefore: before,
				treeHashAfter: after,
				// Explicit null also invalidates evidence from a previous attempt.
				ownedPathsJson: deltaMeasured ? owned : null,
			})
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			)
			.returning({ messageId: narratorToolCalls.messageId });
		// Link this state into the workspace's snapshot DAG. Done with the tree that
		// was just captured rather than by re-capturing: `add -A` is the one cost here
		// that scales with repository size, and it has already been paid.
		//
		// The lineage is what makes this boundary usable as a *fork or merge* endpoint,
		// not just a rollback target: a bare tree has no ancestry, so two diverging
		// workspaces have no computable merge base. Failure is tolerated — the boundary
		// hashes above are already durable, so the worst case is that forking from this
		// point falls back to the older commit-plus-replay path.
		const linked = after
			? await advanceChapterSnapshot(session.cwd, after, "narrator tool boundary")
			: null;

		// Mirror the resulting state onto the owning message so rolling back "to just
		// after this message" has a boundary to restore. A later tool in the same
		// message overwrites it, which is correct: the boundary is the state after the
		// message's final tool.
		if (updated?.messageId) {
			await db
				.update(narratorMessages)
				.set({
					treeHashAfter: after,
					snapshotCommitSha: linked?.commitSha ?? null,
				})
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
 * Publish a tool call's workspace delta to everyone viewing that workspace.
 *
 * ## Why this is the good event source
 *
 * Unlike the filesystem watcher, this fires from the code that just performed the
 * write, so it needs no native watcher (which is opt-in — the default deployment
 * polls git status and observes no paths at all), it has no ignore list to disagree
 * with, and its paths come from a real `diff-tree` between two boundaries rather
 * than from OS notifications. It is also inherently deduplicated and coalesced: one
 * event per tool call, describing the net effect of that call.
 *
 * What it does NOT cover, and why the watcher path stays: writes from the user's own
 * editor, an external build, or a terminal command that ran outside the tool path.
 * Those have no tool boundary, so only a watcher can see them. The two sources are
 * complementary and the tree treats both as the same kind of hint.
 *
 * ## Fan-out
 *
 * Delivered to every narrator attached to the worktree, not just the one that wrote:
 * a shared worktree can have several sessions open beside each other, and a tree in
 * any of them is showing the same directory. The attached set is read from the
 * watcher's registry, which already maintains exactly this mapping — querying the
 * database for it would put a lookup on the tool-execution hot path.
 *
 * Never throws: a failed broadcast must not fail the tool call that succeeded.
 */
function emitWorkspacePathChanges(
	worktreePath: string,
	actingNarratorId: string,
	changes: readonly { path: string; kind: "added" | "updated" | "deleted" }[],
): void {
	try {
		// Paths from `diff-tree` are already worktree-relative and `/`-separated, which
		// is exactly the shape the client keys its cache by — no conversion, and
		// deliberately no absolute form (that would disclose the host's directory layout
		// to every subscriber).
		const bounded = changes.slice(0, MAX_BROADCAST_PATHS);
		const truncated = bounded.length < changes.length;
		const attached = worktreeWatcher.getAttachedNarratorIds(worktreePath);
		// The acting narrator is always a recipient, even when no watcher is registered
		// for its worktree (a chapterless session, or one whose watcher was torn down):
		// it is the surface most likely to be showing this tree right now.
		const recipients = new Set<string>(attached);
		recipients.add(actingNarratorId);

		for (const narratorId of recipients) {
			eventBus.emit({
				type: "narrator:ws_broadcast",
				narratorId,
				message: {
					type: "workspace_paths_changed",
					narratorId,
					chapterId: "",
					toolUseId: "",
					changes: bounded,
					truncated,
				},
			});
		}
	} catch (err) {
		logger.debug("Failed to broadcast workspace path changes", {
			worktreePath,
			error: String(err),
		});
	}
}

/**
 * Upper bound on paths carried by one broadcast.
 *
 * A single tool call can legitimately touch a great many files (a formatter over a
 * repository, a dependency install). Past this the client is told `truncated` and
 * revalidates what it has loaded, which is both smaller and more correct than a
 * enormous path list — see the same trade in the watcher's `MAX_PENDING_PATHS`.
 */
const MAX_BROADCAST_PATHS = 500;

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
