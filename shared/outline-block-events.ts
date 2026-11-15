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
 *   - a LEVEL (an open parent): told when the list of its children changed (one created, moved
 *     in or out, reordered, deleted, restored) or one of its direct children changed itself.
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
	 * Parent keys with a direct child the commit gave a version: the parent before the commit
	 * and the parent after it, of every changed block.
	 */
	parentKeys: string[];
	/**
	 * The parent keys among those whose LIST of children changed: a child was created, moved
	 * (in, out, or among its siblings), deleted or restored.
	 */
	listParentKeys: string[];
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
	listParentKeys: Iterable<string>;
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
		listParentKeys: cut(input.listParentKeys),
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
	/** Levels and subtrees one subscription watches, together. */
	keysPerSubscription: 2000,
	/** Keys one change frame names at most; past it the frame says `all`. */
	keysPerFrame: 256,
	/** Commit ids one change frame carries at most. */
	commitIdsPerFrame: 16,
} as const;
