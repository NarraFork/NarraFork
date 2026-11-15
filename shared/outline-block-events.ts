/**
 * What a commit changed, said by block and not by page, and the read-only subscriptions built
 * on it (`/ws/narrator`): a client watches the levels it has open and the subtrees it shows
 * something about, in one space, and is told which of them a commit touched. Ids and seqs only,
 * never content: the client re-reads over HTTP, which checks access again.
 *
 * PARENT KEYS
 * -----------
 * A level is named by its parent: a block's id, or the SPACE's id for the top level (the same
 * key the placements use, `outline_block_edges.parent_key`). A subtree is named by its root the
 * same way, so the space's id stands for "anything in this space".
 *
 * TWO KINDS OF WATCH
 * ------------------
 *   - a LEVEL (an open parent): told when a read of that level would differ: the list of its
 *     children changed (one created, moved in or out, reordered, deleted, restored), one of its
 *     direct children changed itself, or the list of children of one of its children changed
 *     (a row says whether it has children, so a child gaining its first child or losing its
 *     last shows in the level; it is told whenever a child's list changes, not only then).
 *     Not told about anything deeper.
 *   - a SUBTREE (a timeline, a board, a plan card, a closed row's marks): told when the block
 *     itself or anything that was under it changed, before or after the commit (a block moved
 *     out of it counts).
 *
 * Pure: no server or DOM imports.
 */

/** Ids each list of {@link OutlineCommitChanges} carries at most. */
export const OUTLINE_COMMIT_CHANGE_LIMITS = { ids: 512 } as const;

/**
 * What one commit changed (`outline:committed`'s `changes`). Each list holds an id once, in no
 * order, and at most {@link OUTLINE_COMMIT_CHANGE_LIMITS} ids; when one would hold more,
 * `truncated` is set and a listener must treat the whole space as changed.
 */
export interface OutlineCommitChanges {
	/**
	 * Parent keys of the levels that read differently after the commit: the parent before the
	 * commit and the parent after it of every changed block, and, for a block that was
	 * created, moved, deleted or restored, the parent of each of those parents too (their row
	 * there says whether they have children).
	 */
	parentKeys: string[];
	/** The blocks the commit gave a version. */
	blockIds: string[];
	/**
	 * Every ancestor, before and after, of every changed block (the commit's change marks,
	 * `outline_subtree_changes`). The space itself is not listed: it always changed.
	 */
	ancestorIds: string[];
	truncated: boolean;
}

/** {@link OutlineCommitChanges} from whole sets, cut to the limits. */
export function buildOutlineCommitChanges(input: {
	parentKeys: Iterable<string>;
	blockIds: Iterable<string>;
	ancestorIds: Iterable<string>;
}): OutlineCommitChanges {
	let truncated = false;
	const cut = (ids: Iterable<string>): string[] => {
		const out: string[] = [];
		for (const id of new Set(ids)) {
			if (out.length >= OUTLINE_COMMIT_CHANGE_LIMITS.ids) {
				truncated = true;
				break;
			}
			out.push(id);
		}
		return out;
	};
	const changes = {
		parentKeys: cut(input.parentKeys),
		blockIds: cut(input.blockIds),
		ancestorIds: cut(input.ancestorIds),
	};
	return { ...changes, truncated };
}

/** A commit's changes as sets, for matching many watches against one commit. */
export interface OutlineCommitChangeIndex {
	spaceId: string;
	all: boolean;
	parents: ReadonlySet<string>;
	/** Changed blocks and marked ancestors together. */
	touched: ReadonlySet<string>;
}

/** `changes` absent (a commit event built without them): everything in the space changed. */
export function indexOutlineCommitChanges(
	spaceId: string,
	changes: OutlineCommitChanges | undefined,
): OutlineCommitChangeIndex {
	if (!changes || changes.truncated)
		return { spaceId, all: true, parents: new Set(), touched: new Set() };
	return {
		spaceId,
		all: false,
		parents: new Set(changes.parentKeys),
		touched: new Set([...changes.blockIds, ...changes.ancestorIds]),
	};
}

/** Whether a commit concerns a watched level (see the header). */
export function outlineLevelChanged(index: OutlineCommitChangeIndex, parentKey: string): boolean {
	return index.all || index.parents.has(parentKey);
}

/** Whether a commit concerns a watched subtree (see the header). */
export function outlineSubtreeChanged(index: OutlineCommitChangeIndex, rootKey: string): boolean {
	return index.all || rootKey === index.spaceId || index.touched.has(rootKey);
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscriptions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One subscription watches one space. Sending `outline_watch` again with the same
 * `subscriptionId` REPLACES what it watches (a client sends its whole set when a row opens or
 * closes); the answer is a new `outline_watching`.
 *
 * REPLACING LOSES NOTHING. A change the old set was already told of but whose frame had not
 * gone out yet (frames are coalesced) is carried over: for the keys the new set still
 * watches, it arrives in an `outline_watch_changed` after the new `outline_watching`. Keys
 * the new set dropped are forgotten, and so is everything when the space changes. A key that
 * is new in the set has no past: the client reads it when it starts watching it. While the
 * replacement is being checked, the old set keeps listening and its frames keep coming.
 *
 * THE BACKSTOP. Every `outline_watching` carries the space's last commit seq. A client that
 * gets one whose seq is past what it last read (after a reconnect, a replacement, anything)
 * re-reads everything it watches: that never depends on which frames reached it.
 */
export type OutlineWatchClientMessage =
	| {
			type: "outline_watch";
			subscriptionId: string;
			spaceId: string;
			/** Parent keys of the open levels. */
			levels?: string[];
			/** Root keys of the watched subtrees. */
			subtrees?: string[];
	  }
	| { type: "outline_unwatch"; subscriptionId: string };

export type OutlineWatchErrorCode =
	/** The space does not exist, or the person may not (or may no longer) read it. */
	| "access_denied"
	/** Too many subscriptions or keys, a malformed request, or the outline is switched off. */
	| "unavailable";

export type OutlineWatchServerMessage =
	| {
			type: "outline_watching";
			subscriptionId: string;
			spaceId: string;
			/** The space's last commit seq when the subscription started. */
			seq: number;
	  }
	| {
			type: "outline_watch_changed";
			subscriptionId: string;
			spaceId: string;
			/** The newest commit seq among the changes this frame stands for. */
			seq: number;
			/** Ids of the commits, oldest first; at most the last few when many landed at once. */
			commitIds: string[];
			/** The watched levels the commits concern. */
			levels: string[];
			/** The watched subtrees the commits concern. */
			subtrees: string[];
			/**
			 * A commit changed more than its event names (or the frame would name too many keys):
			 * everything watched may have changed, and `levels` and `subtrees` are empty.
			 */
			all: boolean;
	  }
	| {
			/** Changes waiting for confirmation in the space changed: re-read what shows them. */
			type: "outline_watch_pending";
			subscriptionId: string;
			spaceId: string;
	  }
	| { type: "outline_watch_error"; subscriptionId: string; code: OutlineWatchErrorCode };

/** Limits of block subscriptions. */
export const OUTLINE_WATCH_LIMITS = {
	/** Subscriptions (spaces) of one socket. */
	perSocket: 16,
	/** Subscriptions of one space across sockets. */
	perSpace: 200,
	/** Subscriptions of one space one person holds, across their sockets and tabs. */
	perUserPerSpace: 24,
	/** Levels and subtrees one subscription watches, together. */
	keysPerSubscription: 2000,
	/** Keys one change frame names at most; past it the frame says `all`. */
	keysPerFrame: 256,
	/** Commit ids one change frame carries at most. */
	commitIdsPerFrame: 16,
} as const;
