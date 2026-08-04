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
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { fileAttributions, narratorMessageRefs, narrators, narratorToolCalls } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { logger } from "../lib/logger";
import { normalizeWorkspacePath } from "./git-workspace";
import { invalidateWorkspaceTreeCache, isWorkspaceBeingWritten } from "./narrator-session-state";
import { declaredWorktreePaths } from "./narrator-tree-snapshot-hooks";
import {
	EMPTY_RESULT,
	type RevertResult,
	type RevertWarning,
	registerTreeCompensation,
	resolveNarratorCwd,
	treeFailure,
} from "./snapshot-revert";
import { specVfsService } from "./spec-vfs-service";
import {
	planTreeRevertSegments,
	type SegmentReversalPlan,
	supportsMergeTree,
	TreeRestoreError,
	worktreeTreeSnapshot,
} from "./worktree-tree-snapshot";

/** One recorded pre/post workspace boundary for a single tool call. */
export interface BoundaryPair {
	toolUseId: string;
	messageId: string;
	seq: number;
	before: string;
	after: string;
	/**
	 * Paths this call is attributable for, within the span the hashes describe.
	 *
	 * Required because the hashes cover the whole worktree: in a shared directory
	 * the span also contains other actors' writes, so reversing it wholesale would
	 * discard them. null means the range was never recorded (a pre-feature row) and
	 * could not be derived, in which case the legacy whole-tree behaviour stands.
	 */
	ownedPaths: string[] | null;
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
	| "git_unsupported"
	/**
	 * The window holds more recorded boundaries than one request may process.
	 *
	 * Reported rather than silently truncated: a rollback derived from part of a
	 * window would leave the rest applied while claiming success, and the segment
	 * chain would be cut at an arbitrary row. The user's remedy is a narrower scope.
	 */
	| "window_too_large"
	/**
	 * The window has recorded boundaries, and they prove this narrator changed no
	 * files in it.
	 *
	 * Deliberately distinct from `no_boundaries`, which means "nothing was
	 * recorded, so we do not know". This one is a positive finding, and conflating
	 * them is what made a read-only turn look destructive: with no usable pairs the
	 * caller fell back to a whole-workspace restore, whose boundary hashes still
	 * contained every neighbour's concurrent write. So a rollback that should have
	 * been a no-op offered to revert three files another narrator was editing.
	 */
	| "nothing_owned";

export interface ScopedRevertPlan {
	worktreePath: string;
	/** Boundary pairs to reverse, oldest first. */
	pairs: BoundaryPair[];
}

/** What a window's boundary rows amount to, before any git work. */
interface PairSelection {
	pairs: BoundaryPair[];
	/**
	 * True when boundary rows existed but every one of them resolved to an empty
	 * owned set. Distinguishes "proven to have changed nothing" from "nothing was
	 * ever recorded", which must not share a fallback.
	 */
	allEmpty: boolean;
	/** True when the window has more boundary rows than a single request may process. */
	tooLarge?: boolean;
}

/**
 * Most boundary rows one rollback or preview may consider.
 *
 * Each row costs at least one merge-tree per segment and, for legacy rows, a git
 * child process; the query behind them runs on the thread that also serves every
 * other request. A window past this is refused rather than truncated — a rollback
 * computed from part of a window would leave the rest applied while reporting
 * success.
 */
const MAX_BOUNDARY_ROWS = 1_000;

/**
 * Most files a single preview enumerates.
 *
 * `withContents` reads each file out of two trees, so this also bounds the number of
 * git child processes one request can spawn. The rollback itself is not capped: it
 * has to reverse the whole window or nothing.
 */
const MAX_PREVIEW_FILES = 500;

/**
 * Most files a preview attaches contents for.
 *
 * Each one is two `cat-file` invocations against two different trees, so an
 * uncapped list turned a single GET into hundreds of child processes. The diff view
 * renders a handful at a time; the rest arrive when a narrower scope is requested.
 */
const MAX_PREVIEW_CONTENT_FILES = 50;

/**
 * Select the narrator's boundary pairs, newest last.
 *
 * Pairs whose owned path set is empty are dropped: the call is attributable for no
 * file, so there is nothing to reverse. That covers `spec://` writes (virtual
 * files, never on disk) and read-only Bash — including read-only Bash whose
 * boundary hashes *differ*, because a neighbour wrote to the shared worktree while
 * it ran. Filtering on `before !== after` alone let exactly those through and made
 * them act as rollback anchors for another narrator's edits.
 *
 * Rows where `before === after` are loaded rather than filtered out in SQL, even
 * though they trivially own nothing. Excluding them made a window of only no-op
 * calls look like "no boundaries recorded", which sent the caller to a
 * whole-workspace restore of the earliest recorded boundary — and that discards
 * whatever a neighbour wrote *after* the no-op. Keeping them lets such a window
 * resolve to `nothing_owned` and stop.
 */
async function selectPairs(
	narratorId: string,
	scope: ScopedRevertSelector,
	worktreePath: string,
): Promise<PairSelection> {
	if ("messageIds" in scope && scope.messageIds.length === 0) {
		return { pairs: [], allEmpty: false };
	}
	if ("toolUses" in scope && scope.toolUses.length === 0) {
		return { pairs: [], allEmpty: false };
	}
	// Deliberately no `inputJson` here. A Write's input holds the whole file body, and
	// `minSeq` selects every recorded call from a point onwards, so selecting it would
	// pull an entire session's file contents into memory on a GET request — on the same
	// thread that serves every other request. The path a legacy row needs is extracted
	// in SQL instead (`json_extract`), which returns one short string per row.
	const rows = await db
		.select({
			toolUseId: narratorToolCalls.toolUseId,
			messageId: narratorToolCalls.messageId,
			seq: narratorMessageRefs.seq,
			before: narratorToolCalls.treeHashBefore,
			after: narratorToolCalls.treeHashAfter,
			ownedPaths: narratorToolCalls.ownedPathsJson,
			toolName: narratorToolCalls.toolName,
			resolvedFilePath: narratorToolCalls.resolvedFilePath,
			inputFilePath: sql<
				string | null
			>`json_extract(${narratorToolCalls.inputJson}, '$.file_path')`,
			createdAt: narratorToolCalls.createdAt,
			completedAt: narratorToolCalls.completedAt,
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
				selectorCondition(scope),
			),
		)
		.orderBy(asc(narratorMessageRefs.seq), asc(narratorToolCalls.createdAt))
		// One over the cap, so "there are more" is knowable without a COUNT(*) over the
		// same range. Unbounded, a long session's whole history landed in one request.
		.limit(MAX_BOUNDARY_ROWS + 1);

	if (rows.length === 0) return { pairs: [], allEmpty: false };
	if (rows.length > MAX_BOUNDARY_ROWS) {
		// Refused rather than silently truncated: a rollback computed from a prefix of
		// the window would leave the rest applied while reporting success, and the
		// segment chain would be cut at an arbitrary point.
		return { pairs: [], allEmpty: false, tooLarge: true };
	}

	const usable: BoundaryPair[] = [];
	let considered = 0;
	// Derivation for legacy rows needs one attribution query and possibly one git
	// child process per row. Resolved once for the whole window instead of per row, so
	// a 200-call window is one query rather than 200.
	const attributions = await loadForeignAttributions(narratorId, worktreePath, rows);
	for (const row of rows) {
		// The SQL already rejected null hashes; this narrows the type without a cast.
		if (!row.before || !row.after) continue;
		considered++;
		// A call that left the workspace byte-identical owns nothing by definition,
		// and asking git about it would be wasted work.
		const owned =
			row.before === row.after
				? []
				: await resolveOwnedPathsForRow(
						worktreePath,
						{
							...row,
							before: row.before,
							after: row.after,
						},
						attributions,
					);
		// An empty (not null) set is a positive finding that the call owns nothing.
		if (owned !== null && owned.length === 0) continue;
		usable.push({
			toolUseId: row.toolUseId,
			messageId: row.messageId,
			seq: row.seq,
			before: row.before,
			after: row.after,
			ownedPaths: owned,
		});
	}
	return {
		pairs: dedupeBoundaryRows(usable),
		allEmpty: considered > 0 && usable.length === 0,
	};
}

/** Bound on attribution rows inspected when narrowing shell calls' owned sets. */
const FOREIGN_ATTRIBUTION_SCAN_LIMIT = 2000;

/**
 * Slack added to each side of a recorded call's window when subtracting foreign
 * writes.
 *
 * The window a claim really occupied is wider than `[createdAt, completedAt]` at
 * both ends, and neither end is recorded:
 *
 *   - the `before` boundary is captured by `onSnapshotBefore`, which runs on the
 *     `tool_call` event *before* the tool-call row is inserted, and it may reuse a
 *     tree hash cached seconds earlier (`session._lastTreeHashAt`);
 *   - the `after` boundary is captured by `onSnapshotAfter`, which runs after
 *     `completedAt` was written.
 *
 * A foreign write landing in either gap therefore falls outside the DB window,
 * escapes the subtraction, and gets credited to this call — so a rollback would undo
 * a terminal command or a hand edit that was never in scope. Persisting the real
 * capture timestamps would be exact, but that needs two new columns on
 * `narrator_tool_calls`, so this approximates them with a fixed grace instead. If
 * those columns are ever added (`treeHashBeforeAt` / `treeHashAfterAt`), use them
 * directly and delete this constant.
 */
const ATTRIBUTION_WINDOW_GRACE_MS = 5_000;

function shiftIso(timestamp: string, deltaMs: number): string {
	const parsed = Date.parse(timestamp);
	if (Number.isNaN(parsed)) return timestamp;
	return new Date(parsed + deltaMs).toISOString();
}

/** A boundary row as far as owned-path derivation is concerned. */
interface OwnedPathRow {
	toolUseId: string;
	toolName: string;
	ownedPaths: string[] | null;
	resolvedFilePath: string | null;
	inputFilePath: string | null;
	before: string;
	after: string;
	createdAt: string;
	completedAt: string | null;
}

/** One foreign write, as the attribution timeline recorded it. */
interface ForeignAttribution {
	filePath: string;
	changedAt: string;
}

/**
 * Determine which paths a boundary row is attributable for.
 *
 * Rows recorded since owned sets exist carry the answer. Older rows are derived
 * here rather than backfilled, so existing history benefits immediately without a
 * large write transaction over a multi-gigabyte database:
 *
 *   - Write/Edit → the resolved target path. The tool named it, so it is exact.
 *   - Bash → the whole span minus the paths *other* narrators' Write/Edit calls
 *     were attributed for inside it. Those attributions come from tool inputs, so
 *     they were never polluted by the shared-worktree problem and are safe to
 *     subtract. Deriving the span itself is left to the caller (null = whole tree),
 *     because the subtraction only narrows a set the merge already computes.
 *
 * Never throws: a failed derivation degrades to null, i.e. the pre-existing
 * whole-tree behaviour, rather than losing the row.
 */
async function resolveOwnedPathsForRow(
	worktreePath: string,
	row: OwnedPathRow,
	attributions: ForeignAttribution[],
): Promise<string[] | null> {
	// A declared tool's set is exact — it named its target, and nothing recorded
	// afterwards can make that more precise.
	if (row.toolName === "Write" || row.toolName === "Edit") {
		return row.ownedPaths ?? legacyWriteEditPath(worktreePath, row);
	}

	// A shell command declared nothing, so its set is a subtraction and every
	// authoritative record of a foreign write improves it. The in-memory pass at
	// record time only knew about *declared* neighbours that were still in flight;
	// the attribution timeline also covers writes credited to other narrators and to
	// external actors (terminal, editor) that the worktree watcher observed.
	const attributed = attributionsInWindow(attributions, row);
	if (attributed === null) return row.ownedPaths;
	const base = row.ownedPaths ?? (await spanPaths(worktreePath, row));
	if (base === null) return null;
	return base.filter((path) => !attributed.has(path));
}

/** Paths that differ across a boundary pair, or null when the span cannot be read. */
async function spanPaths(
	worktreePath: string,
	row: { before: string; after: string },
): Promise<string[] | null> {
	try {
		return await worktreeTreeSnapshot.diffPaths(
			worktreePath,
			row.before,
			row.after,
			LOCAL_DEVICE_ID,
		);
	} catch (error) {
		logger.debug("Boundary span could not be read", { worktreePath, error: String(error) });
		return null;
	}
}

/**
 * The worktree-relative target of a legacy Write/Edit row.
 *
 * Returns null (unknown) rather than an empty set when the path cannot be
 * resolved: an empty set would assert the call changed nothing, and for a Write
 * that is the one thing it certainly did not do. Null keeps the caller's replay
 * fallback available, which for a legacy row is the only strategy that can still
 * restore the file — it has the recorded absolute path and does not need the
 * current cwd to agree.
 *
 * The two "cannot own anything here" cases are kept apart from that:
 *   - a `spec://` URI is a virtual file that never reached any worktree, so `[]` is
 *     a real finding no matter which directory this narrator resolves to now;
 *   - a real filesystem path that simply does not sit under *this* cwd is unknown,
 *     not empty. A dormant chapter resolves to the project repo while the row's
 *     path points into `.worktrees/<x>`, so `relative()` yields `..` — reading that
 *     as "owned nothing" made a rollback report success with zero files and
 *     suppressed the replay that would have worked.
 */
function legacyWriteEditPath(
	worktreePath: string,
	row: { resolvedFilePath: string | null; inputFilePath: string | null },
): string[] | null {
	const raw = row.resolvedFilePath ?? row.inputFilePath;
	if (!raw) return null;
	// Virtual files are provably outside every worktree, so this is a finding rather
	// than a failure to resolve.
	if (specVfsService.isSpecUri(raw)) return [];
	const declared = declaredWorktreePaths(worktreePath, { file_path: raw });
	// Empty here means the path did not resolve under this cwd. That is a mismatch
	// between the recorded path and the currently resolved workspace, not proof the
	// call owned nothing, so it is reported as unknown.
	return declared.length > 0 ? declared : null;
}

/**
 * Paths another actor was credited with writing inside a shell call's window.
 *
 * The attribution timeline is the authoritative record of who wrote what, and it is
 * complete in a way the in-memory claim registry cannot be at record time:
 *
 *   - Write/Edit rows come from tool inputs, so they were never affected by the
 *     shared-worktree ambiguity this whole mechanism exists to fix.
 *   - `external` rows are what the worktree watcher observed with no tool claiming
 *     it — a terminal command or an editor. Those declare nothing, so subtracting
 *     them here is the only way a shell call can be told apart from them.
 *
 * Other `bash` rows are deliberately not subtracted: they are themselves derived,
 * so trusting one to narrow another would be circular and could erase a real write.
 *
 * Returns null when nothing can be subtracted, which leaves the caller's set as it
 * stands rather than asserting a precision that was never recorded. Never throws:
 * failing to improve a set must not lose it.
 */
async function loadForeignAttributions(
	narratorId: string,
	worktreePath: string,
	rows: Array<{ createdAt: string; completedAt: string | null }>,
): Promise<ForeignAttribution[]> {
	if (rows.length === 0) return [];
	// One query for the whole window instead of one per row: the per-row version put
	// a DB round trip inside a loop that already spawns git processes, so a 200-call
	// window was 200 queries on the request thread.
	let earliest = rows[0].createdAt;
	let latest = rows[0].completedAt ?? rows[0].createdAt;
	for (const row of rows) {
		if (row.createdAt < earliest) earliest = row.createdAt;
		const end = row.completedAt ?? row.createdAt;
		if (end > latest) latest = end;
	}
	try {
		return await db
			.select({ filePath: fileAttributions.filePath, changedAt: fileAttributions.changedAt })
			.from(fileAttributions)
			.where(
				and(
					eq(fileAttributions.deviceId, LOCAL_DEVICE_ID),
					eq(fileAttributions.workspacePath, normalizeWorkspacePath(worktreePath)),
					gte(fileAttributions.changedAt, shiftIso(earliest, -ATTRIBUTION_WINDOW_GRACE_MS)),
					lte(fileAttributions.changedAt, shiftIso(latest, ATTRIBUTION_WINDOW_GRACE_MS)),
					inArray(fileAttributions.action, ["write", "edit", "external"]),
					// An external row has a null narrator, which `ne` would filter out, so
					// the two cases are spelled out.
					or(isNull(fileAttributions.narratorId), ne(fileAttributions.narratorId, narratorId)),
				),
			)
			.limit(FOREIGN_ATTRIBUTION_SCAN_LIMIT);
	} catch (error) {
		logger.debug("Foreign attribution lookup failed", { narratorId, error: String(error) });
		return [];
	}
}

/**
 * The foreign writes that fall inside one row's window.
 *
 * The window is widened by {@link ATTRIBUTION_WINDOW_GRACE_MS} at both ends because
 * the boundary captures happen outside `[createdAt, completedAt]` — see that
 * constant. Returns null when nothing falls inside, which leaves the caller's set as
 * it stands rather than asserting a precision that was never recorded.
 */
function attributionsInWindow(
	attributions: ForeignAttribution[],
	row: { createdAt: string; completedAt: string | null },
): Set<string> | null {
	if (attributions.length === 0) return null;
	const from = shiftIso(row.createdAt, -ATTRIBUTION_WINDOW_GRACE_MS);
	const to = shiftIso(row.completedAt ?? row.createdAt, ATTRIBUTION_WINDOW_GRACE_MS);
	const inWindow = new Set<string>();
	for (const entry of attributions) {
		if (entry.changedAt < from || entry.changedAt > to) continue;
		inWindow.add(entry.filePath);
	}
	return inWindow.size === 0 ? null : inWindow;
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
		ownedPaths?: string[] | null;
	}>,
): BoundaryPair[] {
	const seen = new Set<string>();
	const pairs: BoundaryPair[] = [];
	for (const row of rows) {
		// Keyed without `messageId`: the clone this exists for lives under a *different*
		// message, so including it would defeat the dedupe entirely. Identical
		// `before`/`after` hashes mean a byte-identical workspace transition, so the
		// rows describe one change no matter which message they hang off.
		//
		// The owned set joins the key because two clones can legitimately resolve to
		// different sets (one recorded, one derived), and collapsing those would
		// silently pick whichever came first.
		const owned = row.ownedPaths === undefined ? null : row.ownedPaths;
		const ownedKey = owned === null ? "*" : [...owned].sort().join("\u0001");
		const key = `${row.toolUseId}\u0000${row.before}\u0000${row.after}\u0000${ownedKey}`;
		if (seen.has(key)) continue;
		seen.add(key);
		pairs.push({
			toolUseId: row.toolUseId,
			messageId: row.messageId,
			seq: row.seq,
			before: row.before as string,
			after: row.after as string,
			ownedPaths: owned,
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

	const { pairs, allEmpty, tooLarge } = await selectPairs(narratorId, scope, worktreePath);
	if (tooLarge) {
		logger.warn("Scoped revert window exceeds the boundary row limit", {
			narratorId,
			limit: MAX_BOUNDARY_ROWS,
		});
		return { unavailable: "window_too_large" };
	}
	if (pairs.length === 0) {
		// Boundaries existed and proved the narrator changed nothing. Reported apart
		// from `no_boundaries` so the caller stays on this scope with an empty result
		// instead of falling back to a whole-workspace restore, whose boundaries still
		// carry every neighbour's concurrent write.
		return { unavailable: allEmpty ? "nothing_owned" : "no_boundaries" };
	}

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
	/**
	 * Total paths the rollback would change, which may exceed `files.length`.
	 *
	 * The list is capped so one request cannot enumerate an unbounded change set; the
	 * count is not, so the dialog can still state the real scope instead of implying
	 * the cap is all there is.
	 */
	totalFileCount?: number;
	/** True when `files` was truncated against `totalFileCount`. */
	hasMore?: boolean;
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
		// `nothing_owned` is an answer, not a gap: the boundaries exist and show this
		// narrator changed no file. Reported as available with an empty file list so
		// the caller keeps this scope and renders its empty state, rather than
		// treating it as "cannot express" and widening to the whole workspace.
		//
		// `window_too_large` is likewise not a gap — the rollback refuses it rather than
		// falling back — so it is surfaced with its reason instead of being reported as
		// simply unavailable, which the dialog would read as "use the workspace scope".
		return {
			available: planned.unavailable === "nothing_owned",
			reason: planned.unavailable,
			files: [],
			conflicts: [],
		};
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

		const totalFileCount = reversal.changedPaths.length;
		// Capped before any per-file git work: a 500-file change set with contents was
		// 2000 child processes for one GET request. The count above still reports the
		// real scope, so the dialog does not understate what a rollback would do.
		const listed = reversal.changedPaths.slice(0, MAX_PREVIEW_FILES);
		const inMerged = await treePathPresence(plan.worktreePath, reversal.mergedTree, listed);
		const files: ScopedRevertPreviewFile[] = [];
		for (const [index, relPath] of listed.entries()) {
			const file: ScopedRevertPreviewFile = {
				deviceId: LOCAL_DEVICE_ID,
				filePath: joinWorktreePath(plan.worktreePath, relPath),
				relPath,
				// Absent from the merged tree means the rollback removes it.
				willBeDeleted: !inMerged.has(relPath),
			};
			// Contents are the expensive half (two `cat-file` runs per file per side), so
			// they stop earlier than the list does. A file past the limit still appears,
			// just without a diff body.
			if (opts?.withContents && index < MAX_PREVIEW_CONTENT_FILES) {
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
			totalFileCount,
			...(totalFileCount > files.length && { hasMore: true }),
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
 * Which of `paths` exist in a tree.
 *
 * Asks about the requested paths rather than listing the whole tree: a preview only
 * needs to know whether each changed path survives the rollback, and a full listing
 * of a large repository is both wasted work and large enough to hit the captured
 * output cap. Falls back to "present" on failure, which renders a file as modified
 * rather than as being deleted — the less alarming of the two wrong answers.
 */
async function treePathPresence(
	worktreePath: string,
	treeHash: string,
	paths: string[],
): Promise<Set<string>> {
	if (paths.length === 0) return new Set();
	try {
		return new Set(
			await worktreeTreeSnapshot.listPathsIn(worktreePath, treeHash, paths, LOCAL_DEVICE_ID),
		);
	} catch (error) {
		logger.debug("Tree path presence lookup failed", { worktreePath, error: String(error) });
		return new Set(paths);
	}
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
		if (planned.unavailable === "window_too_large") {
			// Refused rather than returned as null: null means "this strategy does not
			// apply", and every caller answers that by widening to a whole-workspace
			// restore — which would undo far more than the window the user picked, and do
			// it because the window was *too big* to compute precisely.
			return {
				...EMPTY_RESULT,
				failures: [
					treeFailure(
						(await resolveNarratorCwd(narratorId)) ?? "(unknown)",
						"PREPARE_FAILED",
						new Error(
							`This window contains more than ${MAX_BOUNDARY_ROWS} recorded operations, ` +
								"which is too many to roll back in one step. Undo a smaller range.",
						),
					),
				],
			};
		}
		if (planned.unavailable === "nothing_owned") {
			// A successful no-op, so it must NOT return null: every caller treats null
			// as "this strategy does not apply" and falls through to a whole-workspace
			// restore or a replay — which is exactly how a narrator that changed nothing
			// ended up reverting files another narrator was editing.
			logger.info("Narrator-scoped revert had nothing to undo", { narratorId });
			return EMPTY_RESULT;
		}
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
		const failed: RevertResult = {
			...EMPTY_RESULT,
			failures: [treeFailure(plan.worktreePath, "TREE_RESTORE_FAILED", error)],
		};
		// A failure that already began writing carries the state captured just before
		// it did. Registering it means the caller's `discardSnapshotRevert` /
		// `commitSnapshotRevert` exit can still put the worktree back; without it a
		// half-applied rollback had no recorded pre-state at all, because
		// `reverseAndRestore` only returns one on success.
		if (error instanceof TreeRestoreError) {
			registerTreeCompensation(failed, plan.worktreePath, error.capturedTreeHash);
		}
		return failed;
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
