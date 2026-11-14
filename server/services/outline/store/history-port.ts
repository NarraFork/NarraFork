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
 * A READ THAT CANNOT BE RIGHT IS REFUSED, NOT ANSWERED
 * ---------------------------------------------------
 * The placements of a space written before the tables existed are built by a one-time
 * conversion (`services/outline/history-convert.ts`), and nothing is known of a space before
 * its history floor. A read that would need either rejects with
 * {@link OutlineHistoryUnavailableError} instead of returning a tree that looks plausible:
 *
 *   - `not-ready`: the space's placements are not built yet
 *     ({@link OutlineHistoryState.edgesReady} false). Every read of placements or marks.
 *   - `before-floor`: the seq asked for (`asOf`, or the `after` end of a range) is below
 *     {@link OutlineHistoryState.floorSeq}. The floor itself is readable: it is the tree as the
 *     conversion found it.
 * Reads of the current tree (`asOf` null on a level or a subtree) come from the blocks' own
 * index and are never refused. Every read names its space, and sees only that space's blocks.
 *
 * WHAT IT COSTS
 * -------------
 * Every method is bounded: a hard row limit, a cursor where a level can be long, one statement
 * per chunk of ids. A level as of a seq reads the parent's children that are still there a page
 * at a time, in sibling order (`idx_outline_edges_open`), and those that left AFTER that seq
 * (`idx_outline_edges_closed`); children that came and went before it are never looked at, nor
 * are the text versions under the parent. What remains: a read as of a seq long ago looks at
 * every child that left since. The statements that join placements to versions pin their join
 * order and their indexes (SQLite: `CROSS JOIN`, `INDEXED BY`; PostgreSQL: `LATERAL`), and
 * each backend's tests read the plans.
 *
 * WRITERS (H3): one commit marks at most `OUTLINE_HISTORY_LIMITS.maxChangeMarks` ancestors
 * (`port.ts`). A compensating commit that restores many blocks spread over separate deep
 * chains must be split by the ancestors it marks as well as by the rows it writes.
 *
 * NO RECURSIVE READ. A subtree is read level by level, not by one recursive statement over the
 * placements: measured on 100,000 blocks, PostgreSQL computes a whole level before the limit
 * applies (260 to 370 ms for 800 rows of a space whose 200 top-level blocks have 500 children
 * each), and SQLite lists every child of every row it returns. One bounded read per level
 * costs what it returns on both.
 *
 * FOR THE CALLER OF A SUBTREE AS OF A SEQ (H2): keep such a read on the main thread at 800
 * rows or fewer. Measured on SQLite, 100,000 blocks: 800 rows 8 to 14 ms; 2,000 rows 27 to 39 ms
 * at p50 and 40 to 53 ms at p95 (each row costs its block, its version and two child probes).
 * A larger one belongs on the read workers.
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

/**
 * Where a changed-children read continues. A read is of the space as it stood when its first
 * page was read (`pin`, the space's latest seq then), so commits that land between pages
 * neither repeat a child nor drop one. It goes through the children that were there at `pin`
 * (`open`, in sibling order), then through those that had left by then (by when they left),
 * each in the order of its index, so a page costs what it looks at and not the whole level.
 * The other values are the last row's; the order within a part is the backend's own, so a
 * cursor goes back only to the backend that made it.
 */
export interface OutlineChangedChildCursor {
	/** The space's latest seq when the first page was read. */
	pin: number;
	open: boolean;
	/** Of the last row of the second part; otherwise where that part starts. */
	toSeq: number;
	fromSeq: number;
	orderKey: string;
	blockId: string;
}

/** Why a read by placement or by change mark cannot be answered; see the header. */
export class OutlineHistoryUnavailableError extends Error {
	constructor(
		readonly spaceId: string,
		readonly reason: "not-ready" | "before-floor",
		/** The space's history floor. */
		readonly floorSeq: number,
		/** The seq the read asked for; null when it asked for none. */
		readonly seq: number | null,
	) {
		super(
			reason === "not-ready"
				? `the placements of outline space ${spaceId} are not built yet`
				: `outline space ${spaceId} keeps no history before seq ${floorSeq} (asked for ${seq})`,
		);
		this.name = "OutlineHistoryUnavailableError";
	}
}

/**
 * Refuse a read the space's state cannot answer: `seq` is the oldest seq the read looks at
 * (null: it only needs the placements to be there). Shared by both backends.
 */
export function assertHistoryReadable(
	spaceId: string,
	state: OutlineHistoryState,
	seq: number | null,
): void {
	if (!state.edgesReady)
		throw new OutlineHistoryUnavailableError(spaceId, "not-ready", state.floorSeq, seq);
	if (seq !== null && seq < state.floorSeq)
		throw new OutlineHistoryUnavailableError(spaceId, "before-floor", state.floorSeq, seq);
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
	 * As of a seq: refused when the space is not ready or the seq is below its floor.
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
	 * more, and then only the parent of the last row may be cut short. Parents come in the
	 * order given (each once), `null` where it stands. One statement per 500 parents. Refused
	 * like {@link listLevel}.
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
	 * Refused like {@link listLevel}.
	 */
	listSubtreeAt(
		spaceId: string,
		rootId: string | null,
		options: { asOf: number | null; limit: number },
	): Promise<{ rows: OutlineLevelRow[]; truncated: boolean }>;
	/**
	 * Where each of a space's blocks sat as of a seq (`null`: now): its parent key (the space
	 * id for a top-level block) and order key. Blocks that were not in the tree then (not
	 * created yet, deleted) and blocks of other spaces are left out. One backward seek on the
	 * block's placements each: walking up from a block to the space as of a seq is one call per
	 * level. Refused when the space is not ready, or `asOf` is below its floor.
	 */
	getPlacementsAt(
		spaceId: string,
		blockIds: readonly string[],
		asOf: number | null,
	): Promise<OutlineEdgeRow[]>;
	/**
	 * Which of a space's blocks changed, themselves or anywhere below, in `(after, upTo]`.
	 * Blocks with neither (and blocks of other spaces) are left out: their subtrees are the same
	 * at both seqs. Two index probes per block. Refused when the space is not ready, or `after`
	 * is below its floor.
	 */
	findSubtreeChanges(
		spaceId: string,
		blockIds: readonly string[],
		range: { after: number; upTo: number },
	): Promise<OutlineSubtreeChange[]>;
	/**
	 * The children one parent (`null`: the space's top level) had during `(after, upTo]` that
	 * differ between its two ends, after `cursor`, at most `limit` (at least 1), in no order a
	 * caller should rely on; `next` is where the following read continues. Comparing two seqs
	 * walks down with it: only a child with `below` set needs its own level read. All pages of
	 * one read see the space as it stood at the first (the cursor carries that seq): a commit
	 * landing between pages neither repeats a placement nor drops one, and what it adds is not
	 * part of the read (`upTo` beyond that seq counts as that seq). Looks at the parent's
	 * children that were there then and at those that left after `after`, with two index probes
	 * each. Refused like {@link findSubtreeChanges}.
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
	 * Seqs of the commits that changed anything that was under a block of the space, newest
	 * first, in `after < seq < before`, at most `limit`: the block's timeline, together with its
	 * own versions (`listBlockHistory`). One range read on the marks' primary key. Only seqs
	 * above the space's floor are returned (commits that landed while the space was being
	 * converted left marks at or below it, and nothing below the floor is history): the list
	 * ends there. Refused when the space is not ready; a block of another space has none.
	 */
	listSubtreeChangeSeqs(
		spaceId: string,
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

/** Before every child that left after `after`: where the second part of a read starts. */
function closedStart(pin: number, after: number): OutlineChangedChildCursor {
	return {
		pin,
		open: false,
		toSeq: after,
		fromSeq: Number.MAX_SAFE_INTEGER,
		orderKey: "",
		blockId: "",
	};
}

/**
 * One page of changed children, for both backends. `readOpen` returns the differing children
 * that were under the parent at `pin` (whether or not they have left since), `readClosed` those
 * that left in `(after, pin]`; each after a cursor, in an order of its own, at most `limit`.
 * `latestSeq` is the space's latest seq now: a first page pins the read to it.
 */
export async function pageChangedChildren(
	readOpen: (
		pin: number,
		after: OutlineChangedChildCursor | null,
		limit: number,
	) => Promise<OutlineChangedChildRow[]>,
	readClosed: (
		pin: number,
		after: OutlineChangedChildCursor,
		limit: number,
	) => Promise<OutlineChangedChildRow[]>,
	options: {
		after: number;
		latestSeq: number;
		cursor?: OutlineChangedChildCursor | null;
		limit: number;
	},
): Promise<{ rows: OutlineChangedChildRow[]; next: OutlineChangedChildCursor | null }> {
	const max = Math.floor(options.limit);
	if (!(max >= 1)) throw new RangeError("listChangedChildren needs a limit of at least 1");
	const cursor = options.cursor ?? null;
	const pin = cursor?.pin ?? options.latestSeq;
	const rows: OutlineChangedChildRow[] = [];
	let fromOpen = 0;
	let openDone = cursor !== null && !cursor.open;
	if (!openDone) {
		const found = await readOpen(pin, cursor, max + 1);
		if (found.length > max) {
			const kept = found.slice(0, max);
			const last = kept[max - 1] as OutlineChangedChildRow;
			return {
				rows: kept,
				next: {
					pin,
					open: true,
					toSeq: 0,
					fromSeq: last.fromSeq,
					orderKey: last.orderKey,
					blockId: last.blockId,
				},
			};
		}
		for (const row of found) rows.push(row);
		fromOpen = found.length;
		openDone = true;
	}
	const from = cursor !== null && !cursor.open ? cursor : closedStart(pin, options.after);
	for (const row of await readClosed(pin, from, max - rows.length + 1)) rows.push(row);
	if (rows.length <= max) return { rows, next: null };
	const kept = rows.slice(0, max);
	const last = kept[max - 1] as OutlineChangedChildRow;
	// The page ends with the first part's last row: the second part starts at its beginning.
	if (max <= fromOpen) return { rows: kept, next: closedStart(pin, options.after) };
	return {
		rows: kept,
		next: {
			pin,
			open: false,
			toSeq: last.toSeq as number,
			fromSeq: last.fromSeq,
			orderKey: last.orderKey,
			blockId: last.blockId,
		},
	};
}
