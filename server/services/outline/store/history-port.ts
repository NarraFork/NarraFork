/**
 * Reads by placement and by change mark: the tree of a space read one level at a time, now or
 * as of a seq, and "what changed under this block" answered without reading the subtree. Part of
 * `OutlineStore`; each backend implements them in its own module (`sqlite-history.ts`,
 * `postgres-history.ts`) and spreads them into its store.
 *
 * TWO DERIVED TABLES (`schema.ts`), written by `applyCommit` in the commit's atomic section:
 *
 *   - `outline_block_edges`: where a block sat (parent, order key) for a range of seqs. The
 *     parent key of a top-level block is the SPACE id, so every read here takes
 *     `parentId: string | null` and treats null as "the space itself".
 *   - `outline_subtree_changes`: `(ancestor, seq)` for every ancestor, before and after, of
 *     every block a commit gave a version. A block with no version of its own and no mark in
 *     `(after, upTo]` has the same subtree at both seqs.
 *
 * WHAT A CALLER MUST CHECK FIRST
 * ------------------------------
 * The edges of a space written before the tables existed are built by a one-time conversion
 * (`services/outline/history-convert.ts`). Until it has finished a space
 * ({@link OutlineHistoryState.edgesReady}), reads by placement of that space are incomplete and
 * must not be used. And no read here knows the space's history floor: a read as of a seq below
 * {@link OutlineHistoryState.floorSeq} is the caller's to refuse ("history starts later").
 *
 * Every method is bounded: a hard row limit, a cursor where a level can be long, one statement
 * per chunk of ids. A read as of a seq looks at every placement the parent ever had (at most
 * `OUTLINE_LIMITS.maxSiblings` live at a time, plus those that left), not at the text versions
 * under it. The statements that join placements to versions pin their join order (SQLite:
 * `CROSS JOIN`; PostgreSQL: `LATERAL`), and each backend's tests read the plans.
 *
 * NO RECURSIVE READ. A subtree is read level by level, not by one recursive statement over the
 * placements: measured on 100,000 blocks, PostgreSQL computes a whole level before the limit
 * applies (260 to 370 ms for 800 rows of a space whose 200 top-level blocks have 500 children
 * each), and SQLite lists every child of every row it returns. One bounded read per level
 * costs what it returns on both.
 *
 * This file imports nothing dialect-specific.
 */
import type { OutlineSpaceRow } from "./port";
import type { OutlineStructureRow } from "./read-port";

/** One row of `outline_block_edges`. */
export interface OutlineEdgeRow {
	/** The parent block's id, or the space's id for a top-level block. */
	parentKey: string;
	blockId: string;
	fromSeq: number;
	/** Null: the block's placement now. */
	toSeq: number | null;
	orderKey: string;
}

/** Where a level read continues: after this sibling, in sibling order (order key, then id). */
export interface OutlineLevelCursor {
	orderKey: string;
	id: string;
}

/**
 * A block as one level of the tree shows it, without content: its structure row (as of the seq
 * read: `versionSeq` is the `from_seq` of the version valid then) and whether it had live
 * children then, so a collapsed row can offer to open without its level being read.
 */
export interface OutlineLevelRow extends OutlineStructureRow {
	hasChildren: boolean;
}

/** What the placement conversion and the readers need to know of a space. */
export interface OutlineHistoryState {
	/** History at or below this seq is not kept (`outline_spaces.history_floor_seq`). */
	floorSeq: number;
	/** Every live block of the space has its open placement (`outline_spaces.edges_ready`). */
	edgesReady: boolean;
}

/** Whether a block, or anything that was under it, changed in a seq range. */
export interface OutlineSubtreeChange {
	blockId: string;
	/** The block has a version of its own in the range. */
	self: boolean;
	/** A commit in the range changed a block that was under it then (a change mark). */
	below: boolean;
}

/**
 * A child a parent had at some point of `(after, upTo]` that differs between the two ends: it
 * arrived or left (its placement does not cover the whole range), changed itself, or something
 * under it changed. One row per placement, so a child that left and came back is two rows.
 */
export interface OutlineChangedChildRow extends OutlineSubtreeChange {
	/** `from_seq` of the placement under this parent. */
	fromSeq: number;
	/** `to_seq` of the placement; null while it holds. */
	toSeq: number | null;
	orderKey: string;
}

/** Where a changed-children read continues: after this placement, by (block id, from seq). */
export interface OutlineChangedChildCursor {
	blockId: string;
	fromSeq: number;
}

/** Rows one placement backfill transaction scans at most. */
export const OUTLINE_EDGE_BACKFILL_ROWS = 2000;

export interface OutlineHistoryPort {
	/**
	 * The live children of one parent (`null`: the space's top level) in sibling order, now
	 * (`asOf` null, read from the blocks' children index) or as of a seq (read from the
	 * placements of that parent, each joined to the block's version valid then). After `after`
	 * when given, at most `limit` rows; `next` is where the following read continues, null when
	 * the level ended. A parent of another space, deleted, or unknown has no children here.
	 */
	listLevel(
		spaceId: string,
		parentId: string | null,
		options: { asOf: number | null; after?: OutlineLevelCursor | null; limit: number },
	): Promise<{ rows: OutlineLevelRow[]; next: OutlineLevelCursor | null }>;
	/**
	 * The live children of several parents at once (`null` among them: the top level), now or as
	 * of a seq: what opening several rows of a lazily loaded tree reads. Rows come grouped by
	 * parent, each parent's in sibling order, at most `limit` in all; `truncated` when there are
	 * more, and then only the parent of the last row may be cut short. One statement per 500
	 * parents.
	 */
	listLevels(
		spaceId: string,
		parentIds: readonly (string | null)[],
		options: { asOf: number | null; limit: number },
	): Promise<{ rows: OutlineLevelRow[]; truncated: boolean }>;
	/**
	 * The live blocks under a root (`null`: the whole space), breadth first, now or as of a seq,
	 * the root itself left out: at most `limit` rows, `truncated` when the subtree holds more.
	 * Breadth first means a level is whole before the next one starts, each parent's children
	 * together and in sibling order; with `truncated`, only the parent of the last row may be
	 * cut short. Read one level at a time ({@link readSubtreeByLevels}), every read stopping at
	 * what is left of the limit and skipping the blocks known to have no children: its cost
	 * follows the rows returned, not the size of the subtree or of the levels it starts.
	 */
	/**
	 * Where each block sat as of a seq (`null`: now): its parent key (the space id for a
	 * top-level block) and order key. Blocks that were not in the tree then (not created yet,
	 * deleted) are left out. One backward seek on the block's placements each: walking up from a
	 * block to the space as of a seq is one call per level.
	 */
	getPlacementsAt(blockIds: readonly string[], asOf: number | null): Promise<OutlineEdgeRow[]>;
	/**
	 * Which of the blocks changed, themselves or anywhere below, in `(after, upTo]`. Blocks with
	 * neither are left out: their subtrees are the same at both seqs. Two index probes per block.
	 */
	findSubtreeChanges(
		blockIds: readonly string[],
		range: { after: number; upTo: number },
	): Promise<OutlineSubtreeChange[]>;
	/**
	 * The children one parent (`null`: the space's top level) had during `(after, upTo]` that
	 * differ between its two ends, by (block id, from seq) after `cursor`, at most `limit`; `next`
	 * is where the following read continues. Comparing two seqs walks down with it: only a child
	 * with `below` set needs its own level read. Looks at every placement the parent had in the
	 * range, with two index probes each.
	 */
	listChangedChildren(
		spaceId: string,
		parentId: string | null,
		options: {
			after: number;
			upTo: number;
			cursor?: OutlineChangedChildCursor | null;
			limit: number;
		},
	): Promise<{ rows: OutlineChangedChildRow[]; next: OutlineChangedChildCursor | null }>;
	/**
	 * Seqs of the commits that changed anything that was under a block, newest first, in
	 * `after < seq < before`, at most `limit`: the block's timeline, together with its own
	 * versions (`listBlockHistory`). One range read on the marks' primary key.
	 */
	listSubtreeChangeSeqs(
		blockId: string,
		options: { before?: number | null; after?: number; limit: number },
	): Promise<number[]>;
	/** The history floor and placement readiness of the given spaces (primary key, chunked). */
	getHistoryStates(spaceIds: readonly string[]): Promise<Map<string, OutlineHistoryState>>;

	// ── the placement conversion (`services/outline/history-convert.ts`) ───────────────

	/** Spaces whose placements are not built yet, by id (bytewise) after `after`, at most `limit`. */
	listSpacesPendingEdges(options: {
		after?: string | null;
		limit: number;
	}): Promise<OutlineSpaceRow[]>;
	/**
	 * Give every live block among the next `limit` blocks of a space (by sid, after `afterSid`)
	 * that has no open placement one, from its current row, holding since before the space's
	 * history (`from_seq` 0). One short transaction that excludes a commit of the space while it
	 * runs; a block a commit placed meanwhile is left as the commit wrote it, so running it
	 * again writes nothing. `nextSid` is where the following batch starts, null once the space's
	 * blocks are all visited.
	 */
	backfillEdges(
		spaceId: string,
		options: { afterSid: string | null; limit: number },
	): Promise<{ scanned: number; inserted: number; nextSid: string | null }>;
	/**
	 * Mark a space's placements built and set its history floor to its latest commit, in one
	 * statement, only if it was not marked yet. Returns the floor, or null when the space was
	 * marked already (or is gone).
	 */
	finishEdgeBackfill(spaceId: string): Promise<number | null>;
}

/**
 * A subtree read one level at a time, for both backends: `readLevels` returns the children of
 * the given parents (each parent's together, in sibling order), at most `limit` rows in all.
 * Parents whose row says they have no children are not asked. At most one read per level of
 * the tree (and per chunk of parents).
 */
export async function readSubtreeByLevels(
	readLevels: (parentIds: readonly (string | null)[], limit: number) => Promise<OutlineLevelRow[]>,
	rootId: string | null,
	limit: number,
): Promise<{ rows: OutlineLevelRow[]; truncated: boolean }> {
	const max = Math.max(0, Math.floor(limit));
	const rows: OutlineLevelRow[] = [];
	let frontier: Array<string | null> = [rootId];
	while (frontier.length > 0) {
		const found = await readLevels(frontier, max - rows.length + 1);
		for (const row of found) rows.push(row);
		if (rows.length > max) return { rows: rows.slice(0, max), truncated: true };
		frontier = found.filter((row) => row.hasChildren).map((row) => row.id);
	}
	return { rows, truncated: false };
}
