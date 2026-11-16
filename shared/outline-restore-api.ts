/**
 * Wire types of comparing two moments of any block's subtree and of restoring a subtree to an
 * earlier moment (pageless outline, H3). Routes are under `/api/outline/spaces/:spaceId/…`
 * (`server/routes/outline-restore.ts`).
 *
 * WHAT IS COMPARED. A subtree is named by its root: a block, or `null` for the whole space.
 * `then` is the older seq, `now` the newer one (the space's last commit unless a `to` is
 * given). With S-then the blocks under the root at `then` and S-now those under it at `now`:
 *
 *   - `added`: under the root now, not in the tree at `then` (created since, or deleted then),
 *     and reached from the root through blocks of S-then and other added blocks only;
 *   - `removed`: under the root then, deleted now, and deleted while still under the root;
 *   - `moved-in`: under the root now, in the tree at `then` but elsewhere, and reached from the
 *     root through blocks of S-then and added blocks only (what sits under a moved-in block came
 *     with it and is not listed);
 *   - `moved-away`: under the root then, not under it now, and under another parent than then
 *     (what merely followed a block that moved away is not listed). It may be deleted since:
 *     a block that left the subtree and was deleted afterwards (`deletedSince`, `after` null)
 *     is not `removed` (owner rule D58: what moved away is not pulled back by a restore);
 *   - `changed`: under the root at both, with another parent, order key, text, task, question,
 *     alias or tags (`fields`). The root itself is listed when its own fields differ; where the
 *     root sits is not part of its subtree.
 *
 * A comparison is walked depth first, only into blocks under which something changed, and
 * PAGED: a response holds what one bounded read found and a cursor for the rest. Entries
 * carry excerpts, never whole bodies; read a block as of a seq for its full text
 * (`GET …/blocks/:blockId/subtree?asOf=`).
 */

export const OUTLINE_DIFF_LIMITS = {
	/** Entries one page returns unless asked otherwise, and at most. */
	defaultEntries: 100,
	maxEntries: 200,
	/** Rows one page reads from the store at most (the main-thread budget of a read of history). */
	maxStoreRows: 800,
	/** Changed children one store read returns. */
	levelRows: 40,
	/** Characters of a block's text an entry carries for each side. */
	excerptChars: 200,
	/** Characters of a cursor or a token. */
	maxCursorChars: 128 * 1024,
	/** Blocks under a moved-in block a preview counts (`carries`) before it says "more". */
	carryCount: 50,
} as const;

export const OUTLINE_RESTORE_LIMITS = {
	/** Blocks one compensating commit of a restore changes at most. */
	maxBlocksPerCommit: 400,
	/** Commits one call writes before it answers with a cursor to continue from. */
	maxCommitsPerCall: 8,
	/** Milliseconds one call works before it answers with a cursor to continue from. */
	maxCallMs: 1000,
	/** Passes over the subtree: a later pass places what an earlier one could not yet. */
	maxPasses: 4,
	/** Blocks left alone that one response names; `skippedTruncated` past it. */
	maxSkipped: 200,
	/** Store rows one call reads at most (with the commits and the clock). */
	maxRowsPerCall: 40_000,
	/**
	 * Minutes a preview's token can be confirmed (and paged) in. A restore confirmed in time
	 * finishes however long it takes: a call with its cursor, or after one of its commits, is
	 * not refused.
	 */
	tokenMinutes: 30,
} as const;

export type OutlineDiffKind = "added" | "removed" | "moved-in" | "moved-away" | "changed";

/** `parent`: another parent; `order`: the same parent, another order key. */
export type OutlineDiffField = "parent" | "order" | "text" | "task" | "question" | "alias" | "tags";

/** A block as one side of a comparison shows it. */
export interface OutlineDiffSide {
	/** Null: a top-level block of the space. */
	parentId: string | null;
	orderKey: string;
	/** The first {@link OUTLINE_DIFF_LIMITS.excerptChars} characters of its text. */
	excerpt: string;
	/** The text is longer than the excerpt. */
	truncated: boolean;
	isTask: boolean;
	alias: string | null;
}

export interface OutlineDiffEntry {
	blockId: string;
	sid: string;
	kind: OutlineDiffKind;
	/** For `changed`: what differs. Empty otherwise. */
	fields: OutlineDiffField[];
	/** The block at `then`; null when it was not in the tree. */
	before: OutlineDiffSide | null;
	/** The block at `now`; null when it is deleted. */
	after: OutlineDiffSide | null;
	/** For `moved-away`: it left the subtree and has been deleted since (`after` is null). */
	deletedSince?: true;
}

/** `POST /spaces/:spaceId/diff` (a read; its cursor can be too long for a query string). */
export interface OutlineSubtreeDiffResponse {
	spaceId: string;
	/** Null: the whole space. */
	rootId: string | null;
	/** The older seq. */
	thenSeq: number;
	/** The newer seq actually compared: the one asked for, capped at the space's last commit. */
	nowSeq: number;
	entries: OutlineDiffEntry[];
	/** Pass as `cursor` for the next page; null when the comparison is complete. */
	nextCursor: string | null;
}

/** Why a restore leaves a block as it is. */
export type OutlineRestoreSkipReason =
	/** The block it belonged under has moved away from the subtree (or is deleted with it). */
	| "parent-moved-away"
	/** A block that moved in cannot go back: the block it came from under is deleted. */
	| "parent-gone"
	/** A block added since holds a block that stays, so it is not deleted. */
	| "holds-kept"
	/** The write path refused the change (it would end up under itself, a limit, a claim). */
	| "refused"
	/** It depends on a block whose change was refused (it was to go back under that one). */
	| "parent-refused"
	/** Someone else's lock would be taken away, changed or put back. */
	| "lock-kept"
	/** Its old place among its siblings, or its alias, is still taken after every pass. */
	| "place-taken";

/** What a restore does with a block of the change list. */
export type OutlineRestoreAction =
	/** Deleted: it was added since, and nothing under it has to leave it first. */
	| "delete"
	/**
	 * Deleted unless, when the restore gets to it, it still holds a block that cannot leave it
	 * (a block of the subtree or one that moved in, whose way back the write path may refuse):
	 * then it is kept, and the restore says so with `holds-kept`.
	 */
	| "delete-unless-holds"
	/** Brought back: it was removed since. */
	| "restore"
	/** Moved back to where it was at `then`: it moved in since. */
	| "move-out"
	/** Put back to its parent, order, text and fields of `then`. */
	| "put-back"
	/** Listed only: it moved away, and is not pulled back (see `move-back`). */
	| "none";

export interface OutlineRestoreEntry extends OutlineDiffEntry {
	action: OutlineRestoreAction;
	/** The restore leaves it alone, or (for `put-back`) leaves it where it is: why. */
	skip?: OutlineRestoreSkipReason;
	/**
	 * For `moved-away`: whether moving it back can work now (the block it was under at `then`
	 * is live, or it was a top-level block). A block deleted since is brought back by it.
	 */
	canMoveBack?: boolean;
	/**
	 * For `moved-in`: blocks under it now, which leave with it (counted up to
	 * {@link OUTLINE_DIFF_LIMITS.carryCount}; `carriesMore` past it). Blocks added since among them
	 * are not deleted; blocks of the subtree among them are put back where they were.
	 */
	carries?: number;
	carriesMore?: boolean;
}

/** A block a restore leaves alone, found after its entry was returned. */
export interface OutlineRestoreSkip {
	blockId: string;
	sid: string;
	reason: OutlineRestoreSkipReason;
}

/** `POST /spaces/:spaceId/restore/preview` */
export interface OutlineRestorePreviewResponse {
	spaceId: string;
	rootId: string | null;
	/** The seq the subtree is restored to. */
	thenSeq: number;
	/** The seq the preview is of: the space's last commit when its first page was read. */
	nowSeq: number;
	/**
	 * Names this restore: pass it to every further page of the preview and to the restore.
	 * The restore applies what this preview lists, or answers 409 `OUTLINE_RESTORE_CONFLICT`
	 * when anything under the subtree changed after `now`. It is good for
	 * {@link OUTLINE_RESTORE_LIMITS.tokenMinutes} minutes and only for the person who previewed:
	 * anyone else makes a preview of their own.
	 */
	token: string;
	/** The id of the restore the token names. */
	restoreId: string;
	/**
	 * The change list, depth first; `moved-away` blocks are among it with action `none`. An
	 * added block that has something under it is listed when its subtree has been walked (after
	 * what is under it), with what will happen to it.
	 */
	entries: OutlineRestoreEntry[];
	/**
	 * Added blocks found to hold something that stays (also on their entries, `skip:
	 * "holds-kept"`), so they are not deleted.
	 */
	skipped: OutlineRestoreSkip[];
	nextCursor: string | null;
}

/** `POST /spaces/:spaceId/restore` */
export interface OutlineRestoreResponse {
	spaceId: string;
	restoreId: string;
	/**
	 * The subtree is restored (as far as it can be). False: this call did a bounded part; call
	 * again with the same token (and `cursor`, which only saves work) to continue.
	 */
	done: boolean;
	/** Where the next call continues. Without it the next call starts over, skipping what is done. */
	cursor: string | null;
	/** The compensating commits this call wrote, in order. */
	commits: Array<{ id: string; seq: number }>;
	/** Blocks those commits changed. */
	changed: number;
	/** Blocks this call left alone. */
	skipped: OutlineRestoreSkip[];
	skippedTruncated: boolean;
	/** Blocks under the root at `then` that have moved away, seen by this call. */
	movedAway: number;
	/** Operations held for confirmation instead of written (an agent's restore of a locked plan). */
	pending?: { id: string; label: string };
}

/** `POST /spaces/:spaceId/blocks/:blockId/move-back` */
export interface OutlineMoveBackResponse {
	spaceId: string;
	blockId: string;
	/** Null when the block already is where it was. */
	commit: { id: string; seq: number } | null;
	/** It was deleted and has been brought back. */
	restored: boolean;
	/** Its old order key was taken: it was placed right after the block holding it. */
	orderKeyMoved: boolean;
}

export const OUTLINE_RESTORE_ERROR_CODES = {
	/** Something under the subtree changed after the preview. */
	conflict: "OUTLINE_RESTORE_CONFLICT",
	/** The root was not in the tree at `then`, or is not now. */
	root: "OUTLINE_RESTORE_ROOT_NOT_THERE",
	/** The block a move-back would put the block under is deleted. */
	parentGone: "OUTLINE_RESTORE_PARENT_GONE",
	/** A cursor or token is malformed, forged, of another restore, of another person, or expired. */
	token: "OUTLINE_RESTORE_TOKEN_INVALID",
} as const;

/** `details` of a 409 `OUTLINE_RESTORE_CONFLICT`. */
export interface OutlineRestoreConflictDetails {
	restoreId: string;
	/** The seq the preview was of. */
	previewSeq: number;
	/** A commit after it that changed something under the subtree and is not this restore's. */
	conflictSeq: number;
}

/** `details` of a 409 `OUTLINE_RESTORE_ROOT_NOT_THERE`. */
export interface OutlineRestoreRootDetails {
	blockId: string;
	seq: number;
}
