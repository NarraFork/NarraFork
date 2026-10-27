/**
 * The outline store, stated without a dialect.
 *
 * Two kinds of operation live here:
 *
 *   - READS of current state, small and indexed, each with a hard row limit. The write path
 *     uses them to plan a transaction; tests use them to check what was written. Reads of
 *     history, links and the full-text index (a page as of a seq, timelines, search, backlinks)
 *     are stated in `read-port.ts` and are part of this port too; budgeted rendering and the
 *     rest of the reading logic live in their own modules above it.
 *   - `applyCommit`, the one write: it takes a fully computed {@link OutlineCommitPlan} and
 *     writes it atomically. All deciding (validation, normalization, order keys, link
 *     extraction, invariants) happens before, in `server/services/outline/write.ts`, so the
 *     SQLite implementation's synchronous section only writes rows.
 *
 * THE CONTRACT (inherited from `server/db/backend/write-port.ts`)
 * --------------------------------------------------------------
 * 1. Methods return Promises. The SQLite implementation runs its atomic section strictly
 *    synchronously; the PostgreSQL one runs an async section wrapped in `withPgRetry`.
 * 2. `applyCommit` is all-or-nothing.
 * 3. The plan names the seq it was computed for. The implementation claims it from the space's
 *    `next_seq` counter (`next_seq = seq` → `seq + 1`) as the first statement of the section;
 *    if the counter moved, another commit landed after the plan's reads, and the section
 *    rejects with {@link OutlineStaleWriteError} having written nothing. The caller re-plans.
 * 4. A uniqueness conflict crosses the boundary as `WriteConflictError`, never a driver error.
 * 5. Post-commit side effects (event-bus emission) belong to the caller, after the Promise
 *    resolves: the PostgreSQL implementation may replay its section before resolving once.
 *
 * This file imports nothing dialect-specific.
 */
import type { WritePortIdentity } from "@server/db/backend/write-port";
import type {
	OutlineActorKind,
	OutlineCommitKind,
	OutlineLinkKind,
	OutlineLinkTargetKind,
	OutlineSpaceKind,
	OutlineTaskJson,
} from "../model";
import type { OutlineReadPort } from "./read-port";

export { WriteConflictError } from "@server/db/backend/write-port";

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes (plain data, field-identical across backends)
// ─────────────────────────────────────────────────────────────────────────────

export interface OutlineSpaceRow {
	id: string;
	key: string;
	kind: OutlineSpaceKind;
	projectId: string | null;
	narratorId: string | null;
	ownerUserId: string | null;
	nextSeq: number;
	createdAt: string;
}

export interface OutlineBlockRow {
	id: string;
	spaceId: string;
	sid: string;
	parentId: string | null;
	pageId: string;
	orderKey: string;
	content: string;
	contentHash: string;
	alias: string | null;
	taskJson: OutlineTaskJson | null;
	authorKind: OutlineActorKind;
	authorId: string;
	versionSeq: number;
	deleted: boolean;
}

/** A block without its content and author: what planning a write needs. */
export type OutlineBlockMeta = Omit<OutlineBlockRow, "content" | "authorKind" | "authorId">;

export interface OutlineVersionRow {
	blockId: string;
	fromSeq: number;
	toSeq: number | null;
	commitId: string;
	pageId: string;
	parentId: string | null;
	orderKey: string;
	/** Null for a tombstone. */
	content: string | null;
	taskJson: OutlineTaskJson | null;
	alias: string | null;
	contentHash: string;
	changeFlags: number;
	deleted: boolean;
}

export interface OutlineLinkRow {
	id: string;
	spaceId: string;
	fromBlockId: string;
	kind: OutlineLinkKind;
	targetKind: OutlineLinkTargetKind;
	targetRef: string;
	fromSeq: number;
	toSeq: number | null;
}

export interface OutlineCommitRow {
	id: string;
	spaceId: string;
	seq: number;
	kind: OutlineCommitKind;
	actorKind: OutlineActorKind;
	actorId: string;
	responsibleUserId: string | null;
	narratorId: string | null;
	messageId: string | null;
	toolCallId: string | null;
	createdAt: string;
	summary: string;
}

/**
 * One row of a page's live session log (`outline_live_updates`): a Yjs update as base64. Seq 0 of
 * an epoch, or the first row after a compaction, is a full snapshot of the session's document;
 * the rows after it are increments. Replaying an epoch's rows in seq order rebuilds the document.
 */
export interface OutlineLiveUpdateRow {
	pageBlockId: string;
	epoch: number;
	seq: number;
	updateB64: string;
	actorKind: OutlineActorKind;
	actorId: string;
	createdAt: string;
}

/**
 * One person's view state of one page (`outline_view_state`, design §7.1): folded blocks and the
 * mind map's direction. Personal and outside history: never versioned, never part of a commit.
 */
export interface OutlineViewStateRow {
	userId: string;
	pageBlockId: string;
	collapsed: string[];
	layout: "right" | "down";
	updatedAt: string;
}

/** The space a project, a user or a narrator owns. */
export type OutlineSpaceScope =
	| { kind: "project"; projectId: string }
	| { kind: "personal"; ownerUserId: string }
	| { kind: "session"; narratorId: string };

// ─────────────────────────────────────────────────────────────────────────────
// The write plan
// ─────────────────────────────────────────────────────────────────────────────

/** Columns a commit may change on an existing block. `versionSeq` is set by the store. */
export type OutlineBlockPatch = Partial<
	Pick<
		OutlineBlockRow,
		| "parentId"
		| "pageId"
		| "orderKey"
		| "content"
		| "contentHash"
		| "alias"
		| "taskJson"
		| "authorKind"
		| "authorId"
		| "deleted"
	>
>;

/**
 * Everything one commit writes, already decided. Applied in this order inside one atomic
 * section:
 *
 *   1. claim `seq` from the space counter (or reject as stale), insert `commit`;
 *   2. close the open version of every block in `closeVersionIds` (`to_seq = seq`);
 *   3. clear the alias of every patched block whose alias changes, then apply `patchBlocks`
 *      (deletions first), so an alias can move between blocks within one commit;
 *   4. insert `insertBlocks`;
 *   5. open one version per block in `versions`, copied from the block's new row;
 *   6. close `closeLinkIds`, insert `insertLinks`.
 */
export interface OutlineCommitPlan {
	spaceId: string;
	/** The space's `next_seq` the plan was computed against; becomes the commit's seq. */
	seq: number;
	commit: OutlineCommitRow;
	/** Existing blocks that get a new version: exactly the non-inserted blocks in `versions`. */
	closeVersionIds: string[];
	/** Changes to existing blocks, grouped by identical patch. */
	patchBlocks: Array<{ ids: string[]; patch: OutlineBlockPatch }>;
	/** New blocks, `versionSeq` = `seq`. */
	insertBlocks: OutlineBlockRow[];
	/** Every touched block once, grouped by the version's change flags. */
	versions: Array<{ ids: string[]; flags: number }>;
	closeLinkIds: string[];
	/** New link rows, `fromSeq` = `seq`, `toSeq` null. */
	insertLinks: OutlineLinkRow[];
}

/**
 * The space counter moved between planning and writing: another commit landed. Nothing was
 * written; plan again from fresh reads.
 */
export class OutlineStaleWriteError extends Error {
	constructor(
		readonly spaceId: string,
		readonly expectedSeq: number,
	) {
		super(`outline space ${spaceId} moved past seq ${expectedSeq} while the write was planned`);
		this.name = "OutlineStaleWriteError";
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The port
// ─────────────────────────────────────────────────────────────────────────────

export interface OutlineStore extends WritePortIdentity, OutlineReadPort {
	/**
	 * The space of a project, user or narrator, created on first use. Concurrent callers get
	 * the same row (one per scope, enforced by a unique index). New spaces start at seq 1.
	 */
	ensureSpace(scope: OutlineSpaceScope, now: string): Promise<OutlineSpaceRow>;
	getSpace(id: string): Promise<OutlineSpaceRow | null>;
	getSpaceByKey(key: string): Promise<OutlineSpaceRow | null>;
	findSpace(scope: OutlineSpaceScope): Promise<OutlineSpaceRow | null>;

	/** Blocks of `spaceId` by id or sid, live or deleted. Ids of other spaces are not found. */
	getBlockMetas(
		spaceId: string,
		by: { ids?: readonly string[]; sids?: readonly string[] },
	): Promise<OutlineBlockMeta[]>;
	/** Which of `ids` exist as block ids in any space. */
	findExistingBlockIds(ids: readonly string[]): Promise<string[]>;
	/** Live children of the given parents (`null`: the space's pages), at most `limit` rows. */
	listChildMetas(
		spaceId: string,
		parentIds: readonly (string | null)[],
		limit: number,
	): Promise<OutlineBlockMeta[]>;
	/** Live blocks of `spaceId` holding any of `aliases`. */
	findAliasOwners(
		spaceId: string,
		aliases: readonly string[],
	): Promise<Array<{ alias: string; id: string }>>;
	/** Open links (`to_seq` NULL) of the given blocks, at most `limit` rows. */
	listOpenLinks(blockIds: readonly string[], limit: number): Promise<OutlineLinkRow[]>;

	getBlock(id: string): Promise<OutlineBlockRow | null>;
	getBlockBySid(spaceId: string, sid: string): Promise<OutlineBlockRow | null>;
	/** Live children of a parent (`null`: the space's pages) in sibling order. */
	listChildren(spaceId: string, parentId: string | null, limit: number): Promise<OutlineBlockRow[]>;
	/** Live blocks of a page, unordered; `truncated` when the page holds more than `limit`. */
	listPageBlocks(
		pageId: string,
		limit: number,
	): Promise<{ blocks: OutlineBlockRow[]; truncated: boolean }>;
	/** A block's versions, oldest first. */
	listBlockVersions(blockId: string, limit: number): Promise<OutlineVersionRow[]>;
	/** Versions recorded under a page, by `from_seq` then block id, after `afterSeq`. */
	listPageVersions(
		pageId: string,
		options: { limit: number; afterSeq?: number },
	): Promise<OutlineVersionRow[]>;
	/** Commits of a space by seq, after `afterSeq`. */
	listCommits(
		spaceId: string,
		options: { limit: number; afterSeq?: number },
	): Promise<OutlineCommitRow[]>;

	/** Write one commit atomically; see {@link OutlineCommitPlan} and the header contract. */
	applyCommit(plan: OutlineCommitPlan): Promise<void>;

	// ── live session log (`services/outline/live/`) ─────────────────────────────────────
	// Not part of a page's history: rows are written while a page is edited live and deleted
	// once the session's text is committed. Each call is one small indexed statement or one
	// short transaction; callers bound the row counts.

	/** Append rows (at most a handful per call). */
	appendLiveUpdates(rows: readonly OutlineLiveUpdateRow[]): Promise<void>;
	/** Replace every row of an epoch with `rows`, atomically (a compaction). */
	replaceLiveUpdates(
		pageBlockId: string,
		epoch: number,
		rows: readonly OutlineLiveUpdateRow[],
	): Promise<void>;
	/** Rows of an epoch by seq, after `afterSeq`, at most `limit`. */
	listLiveUpdates(
		pageBlockId: string,
		epoch: number,
		options: { afterSeq?: number; limit: number },
	): Promise<OutlineLiveUpdateRow[]>;
	/** Delete every row of an epoch; returns how many went. */
	deleteLiveUpdates(pageBlockId: string, epoch: number): Promise<number>;
	/** Epochs that have rows, ordered by page then epoch, after `after`, at most `limit`. */
	listLiveEpochs(options: {
		after?: { pageBlockId: string; epoch: number };
		limit: number;
	}): Promise<Array<{ pageBlockId: string; epoch: number }>>;

	// ── view state (`services/outline/view-state.ts`) ───────────────────────────────────
	// One row per person and page, read and written by primary key: one small statement each.

	/** A person's view state of a page, or null when they never wrote one. */
	getViewState(userId: string, pageBlockId: string): Promise<OutlineViewStateRow | null>;
	/**
	 * Insert or replace a person's view state of a page, then keep only that page and their
	 * `keepPerUser` most recently written others (the rest are deleted in one statement bounded
	 * by that number: the person never has more than `keepPerUser + 2` rows). The page just
	 * written is never dropped, even when a clock stepped back makes it the oldest.
	 */
	putViewState(row: OutlineViewStateRow, keepPerUser: number): Promise<void>;
}

/** Ids per `IN (…)` list, well under every engine's bound-parameter limit. */
export const OUTLINE_SQL_CHUNK = 500;

export function chunked<T>(items: readonly T[], size = OUTLINE_SQL_CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}
