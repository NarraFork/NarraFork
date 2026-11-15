/**
 * Reading the outline without pages (pageless outline, H2): any block's subtree, or a whole
 * space, loaded lazily one level per parent, now or as of a seq. Built on the placement reads of
 * `store/history-port.ts`; the page-keyed reads of `read.ts` and `views.ts` stay beside it until
 * their callers have moved.
 *
 * TWO READS
 * ---------
 *   - {@link readOutlineSubtree}: a root (a block, or the space) and what is under it, breadth
 *     first until the budget is spent. A level is whole before the next one starts; where the
 *     budget ends, the result says which levels are incomplete and where each continues.
 *   - {@link readOutlineLevels}: the children of the parents named, each from its own cursor:
 *     what opening rows of a loaded tree, or scrolling a long level, asks for.
 * Both return the same thing: blocks, and one {@link OutlineTreeLevel} per parent looked at.
 * Assembling every level of a root gives exactly the tree a whole read would give.
 *
 * WHAT A READ COSTS
 * -----------------
 * Rows returned, never the size of what is under the root. Every read takes at most
 * {@link OUTLINE_SUBTREE_LIMITS.maxBlocks} (800) level rows from the store, now or as of a seq
 * (H1 measured 800 rows as of a seq at 8 to 14 ms on the main thread, 2,000 at 27 to 53 ms),
 * then loads content only for the rows it returns, in chunks that stop at the byte budget.
 * Around that: the root's ancestors (one recursive statement by primary key whatever the
 * depth), and for a current read the open changes of the locked tasks among the blocks read
 * and above them, and the locks' names.
 *
 * AS OF A SEQ
 * -----------
 * The same reads with a seq: the placements valid then, each block's version valid then. A
 * block read as of a seq is located by walking its placements up to the space as of that seq,
 * which is also what says it was in the tree then. A space whose placements are not built yet,
 * or a seq below its history floor, is refused with `OutlineHistoryNotAvailableError`
 * (`subtree-errors.ts`); a current read is never refused.
 *
 * THE FACTS VIEW leaves tasks and questions out, and with them what is under them
 * (`tree.ts`); each level says how many it left out. A root that is process, or under it, is
 * read whole whatever was asked.
 *
 * FOLDED READS (`fold`)
 * ---------------------
 * The budget is not spent behind closed rows: the default folding (`shared/outline-fold.ts`)
 * with the reader's own over it says which rows are closed, decided row by row on the way down
 * (a row's default needs only itself and whether it is under a task or a report). A closed row
 * is not gone below; up to {@link OUTLINE_SUBTREE_LIMITS.maxPreviews} of them get the one child
 * their preview line is read from. In a current read, a row with something nobody must miss
 * under it (an unanswered question, a lock, a change waiting for confirmation) stays open
 * (`readOutlineAttention`, candidates first). What a closed row hides is counted by
 * `readOutlineMarks`, not here.
 *
 * Nothing here decides access: callers check `access.ts` first, and every store read names the
 * space, so a block of another space is never returned.
 */
import { ValidationError } from "@server/lib/errors";
import { titleOf } from "@shared/outline";
import type { OutlineQuestionMark, OutlineViewMode } from "@shared/outline-api";
import { FOLD_MAX_OPEN_DEPTH, foldDefaultOpen } from "@shared/outline-fold";
import { isOutlineReportBlockId } from "@shared/outline-report-line";
import {
	OUTLINE_SUBTREE_LIMITS,
	type OutlineLevelsResponse,
	type OutlineSubtreeResponse,
	type OutlineTreeBlock,
	type OutlineTreeLevel,
} from "@shared/outline-subtree-api";
import { OUTLINE_TEXT } from "./messages";
import { OUTLINE_LIMITS, type OutlineAskJson } from "./model";
import { loadBodiesWithin } from "./read";
import { readReportAuthors } from "./report-authors";
import { outlineStore } from "./store";
import type { OutlineLevelCursor, OutlineLevelRow } from "./store/history-port";
import type { OutlineSpaceRow, OutlineStore } from "./store/port";
import { withOutlineHistory } from "./subtree-errors";
import { pendingTouched, readOutlineAttention } from "./subtree-marks";
import { buildTree, type OutlineNode } from "./tree";
import { describeLocks } from "./views";

/** Characters of a title in `path`. */
const TITLE_CHARS = 200;

function utf8(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function shortTitle(content: string): string {
	const title = titleOf(content);
	const chars = Array.from(title);
	return chars.length <= TITLE_CHARS ? title : `${chars.slice(0, TITLE_CHARS - 1).join("")}…`;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
	return value === undefined || !Number.isFinite(value)
		? fallback
		: Math.max(1, Math.min(max, Math.floor(value)));
}

function isProcess(row: OutlineLevelRow): boolean {
	return row.taskJson !== null || !!row.askJson;
}

function questionMark(ask: OutlineAskJson): OutlineQuestionMark {
	return {
		state: ask.withdrawn ? "withdrawn" : ask.answer ? "answered" : "open",
		proceed: ask.proceed === true,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursors
// ─────────────────────────────────────────────────────────────────────────────

const CURSOR_PART = /^[\x21-\x7e]{1,512}$/;

export function encodeOutlineLevelCursor(cursor: OutlineLevelCursor): string {
	return Buffer.from(JSON.stringify([cursor.orderKey, cursor.id]), "utf8").toString("base64url");
}

export function decodeOutlineLevelCursor(cursor: string): OutlineLevelCursor {
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (
			Array.isArray(value) &&
			value.length === 2 &&
			typeof value[0] === "string" &&
			typeof value[1] === "string" &&
			CURSOR_PART.test(value[0]) &&
			CURSOR_PART.test(value[1])
		) {
			return { orderKey: value[0], id: value[1] };
		}
	} catch {
		// Fall through to the validation error.
	}
	throw new ValidationError("Invalid cursor");
}

// ─────────────────────────────────────────────────────────────────────────────
// The seq of a read
// ─────────────────────────────────────────────────────────────────────────────

/** The seq to read a space at: null for now; `asOf` checked and capped at the last commit. */
function readSeq(space: OutlineSpaceRow, asOf: number | undefined): number | null {
	if (asOf === undefined) return null;
	if (!Number.isSafeInteger(asOf) || asOf < 0)
		throw new ValidationError(OUTLINE_TEXT.errors.badSeq("asOf"));
	return Math.min(asOf, space.nextSeq - 1);
}

interface ReadContext {
	store: OutlineStore;
	space: OutlineSpaceRow;
	/** Null: the current state. */
	asOf: number | null;
	narratorVisible?: (narratorId: string) => Promise<boolean>;
	/**
	 * Level rows this call may still take from the store: every read of a level is charged
	 * here, the row it only peeks at included, so one call never takes more than
	 * {@link OUTLINE_SUBTREE_LIMITS.maxBlocks}.
	 */
	rowsLeft: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Levels as read, before content
// ─────────────────────────────────────────────────────────────────────────────

/** One parent's children as the store returned them. */
interface LevelDraft {
	parentId: string | null;
	/** The rows the view shows, in sibling order. */
	rows: OutlineLevelRow[];
	/** Every row read, shown or left out by the view. */
	read: readonly OutlineLevelRow[];
	/** The last row read, shown or not: where the level continues. */
	last: OutlineLevelRow | null;
	/** The store has more children after `last`. */
	more: boolean;
	/** Where this read of the level started; null: its beginning. */
	startCursor: string | null;
	processHidden: number;
}

function draftOf(
	parentId: string | null,
	read: readonly OutlineLevelRow[],
	more: boolean,
	view: OutlineViewMode,
	startCursor: string | null,
): LevelDraft {
	const rows = view === "all" ? [...read] : read.filter((row) => !isProcess(row));
	return {
		parentId,
		rows,
		read,
		last: read.at(-1) ?? null,
		more,
		startCursor,
		processHidden: read.length - rows.length,
	};
}

/**
 * The children of several parents from their beginnings, at most `limit` rows in all: one
 * store read (`listLevels`), split by parent. The read asks for one row more than it returns
 * (within what the call may still take, `rowsLeft`), so it knows whether the parent the limit ended in has
 * more children or the limit fell exactly between two parents. Parents the limit did not
 * reach come back as unread drafts (`more`, no rows).
 */
async function readLevelsFromStart(
	ctx: ReadContext,
	parentIds: readonly (string | null)[],
	limit: number,
	view: OutlineViewMode,
): Promise<{ drafts: LevelDraft[]; read: number }> {
	const asked = Math.min(limit + 1, ctx.rowsLeft);
	if (asked <= 0) {
		return {
			drafts: [...new Set(parentIds)].map((parentId) => draftOf(parentId, [], true, view, null)),
			read: 0,
		};
	}
	const usable = Math.min(limit, asked - 1);
	const found = await ctx.store.listLevels(ctx.space.id, parentIds, {
		asOf: ctx.asOf,
		limit: asked,
	});
	ctx.rowsLeft -= found.rows.length;
	const rows = found.rows.slice(0, usable);
	/** The first row past what is returned: its parent is where the limit ended. */
	const peek = found.rows[usable];
	const byParent = new Map<string | null, OutlineLevelRow[]>();
	for (const row of rows) {
		const list = byParent.get(row.parentId);
		if (list) list.push(row);
		else byParent.set(row.parentId, [row]);
	}
	const drafts: LevelDraft[] = [];
	// Parents come back in the order given. Before the peeked row's parent every level is
	// whole; that parent has more; after it nothing was read, unless the store had nothing
	// more at all (then those parents have no children).
	let state: "whole" | "after" = "whole";
	for (const parentId of new Set(parentIds)) {
		const own = byParent.get(parentId) ?? [];
		if (!peek) drafts.push(draftOf(parentId, own, false, view, null));
		else if (state === "after") drafts.push(draftOf(parentId, [], found.truncated, view, null));
		else if (parentId === peek.parentId) {
			drafts.push(draftOf(parentId, own, true, view, null));
			state = "after";
		} else drafts.push(draftOf(parentId, own, false, view, null));
	}
	return { drafts, read: rows.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Content, marks and the wire shape
// ─────────────────────────────────────────────────────────────────────────────

interface Finished {
	blocks: OutlineTreeBlock[];
	/** The same blocks as tree nodes, in the same order (see {@link OutlineReadNodes}). */
	shown: OutlineNode[];
	levels: OutlineTreeLevel[];
	/** Rows left out because the byte budget ran out. */
	cut: boolean;
	/** More open changes touch these blocks than one read looks at. */
	pendingTruncated: boolean;
}

/**
 * Load the content of the rows in `order` (the read's order: a prefix of it is returned) within
 * the byte budget, mark them, and say what was loaded of each level.
 */
async function finish(
	ctx: ReadContext,
	order: readonly OutlineLevelRow[],
	drafts: readonly LevelDraft[],
	maxBytes: number,
	/** Locked tasks above the rows read (ancestors of the root, or of the parents asked for). */
	lockedAbove: readonly string[],
): Promise<Finished> {
	const { store } = ctx;
	const nodes = buildTree(order);
	const list = order.map((row) => nodes.get(row.id) as OutlineNode);
	const state = { current: ctx.asOf === null, seq: ctx.asOf ?? ctx.space.nextSeq - 1 };
	await loadBodiesWithin(state, list, maxBytes, { store });
	const shown: OutlineNode[] = [];
	let bytes = 0;
	for (const node of list) {
		if (node.content === null) break;
		const cost = utf8(node.content);
		if (shown.length > 0 && bytes + cost > maxBytes) break;
		bytes += cost;
		shown.push(node);
	}
	const shownIds = new Set(shown.map((node) => node.id));
	const locks = await describeLocks(
		shown.flatMap((node) => (node.task?.lock ? [{ blockId: node.id, lock: node.task.lock }] : [])),
		{ narratorVisible: ctx.narratorVisible },
	);
	const reportFrom = await readReportAuthors(
		ctx.space.id,
		shown.filter((node) => isOutlineReportBlockId(node.id)),
		{ narratorVisible: ctx.narratorVisible, store },
	);
	const pending = await pendingOfBlocks(ctx, [
		...lockedAbove,
		...shown.flatMap((node) => (node.task?.lock ? [node.id] : [])),
	]);
	const pendingOf = pending.of;
	const hasChildren = new Map(order.map((row) => [row.id, row.hasChildren]));
	const blocks = shown.map(
		(node): OutlineTreeBlock => ({
			id: node.id,
			sid: node.sid,
			parentId: node.parentId,
			orderKey: node.orderKey,
			content: node.content ?? "",
			task: node.task
				? {
						status: node.task.status,
						assignee: node.task.assignee,
						due: node.task.due ?? null,
						depends: (node.task.depends ?? []).map((d) => d.target),
					}
				: null,
			question: node.ask ? questionMark(node.ask) : null,
			alias: node.alias,
			tags: node.tags ?? [],
			versionSeq: node.versionSeq,
			hasChildren: hasChildren.get(node.id) === true,
			lock: locks.get(node.id) ?? null,
			pending: pendingOf.get(node.id) ?? [],
			...(reportFrom.has(node.id) ? { reportFrom: reportFrom.get(node.id) } : {}),
		}),
	);
	const levels: OutlineTreeLevel[] = [];
	for (const draft of drafts) {
		// A level whose own parent did not fit is not part of the answer.
		if (draft.parentId !== null && hasChildren.has(draft.parentId) && !shownIds.has(draft.parentId))
			continue;
		const kept = draft.rows.filter((row) => shownIds.has(row.id));
		const whole = kept.length === draft.rows.length;
		const lastKept = kept.at(-1);
		// All shown: the level continues after the last row READ (shown or left out by the view).
		// Cut by bytes: after the last row shown, or where this read started.
		const cursor = whole ? draft.last : (lastKept ?? null);
		const more = draft.more || !whole;
		levels.push({
			parentId: draft.parentId,
			childIds: kept.map((row) => row.id),
			more,
			nextCursor: !more
				? null
				: cursor
					? encodeOutlineLevelCursor({ orderKey: cursor.orderKey, id: cursor.id })
					: draft.startCursor,
			// Cut by bytes: only what was left out before the cut; the rest is read again.
			processHidden: whole ? draft.processHidden : processBefore(draft, lastKept),
		});
	}
	return {
		blocks,
		shown,
		levels,
		cut: shown.length < order.length,
		pendingTruncated: pending.truncated,
	};
}

/** Tasks and questions the view left out of a level before the row `last` (none: 0). */
function processBefore(draft: LevelDraft, last: OutlineLevelRow | undefined): number {
	if (!last) return 0;
	let count = 0;
	for (const row of draft.read) {
		if (row.id === last.id) break;
		if (isProcess(row)) count++;
	}
	return count;
}

/**
 * The open changes that touch the blocks of a read, by block. A change hangs on the locked
 * task its tree is rooted at, and touches only blocks of that tree: so the changes that can
 * touch a read's blocks are those of the locked tasks among the blocks themselves and above
 * them (`roots`), read by the open-root index. Bounded by what the page shows, not by how
 * many changes the space has; at most {@link OUTLINE_SUBTREE_LIMITS.pendingRows} changes, and
 * `truncated` says when there were more. A read as of a seq shows none.
 */
async function pendingOfBlocks(
	ctx: ReadContext,
	roots: readonly string[],
): Promise<{ of: Map<string, string[]>; truncated: boolean }> {
	const of = new Map<string, string[]>();
	const unique = [...new Set(roots)];
	if (ctx.asOf !== null || unique.length === 0) return { of, truncated: false };
	const limit = OUTLINE_SUBTREE_LIMITS.pendingRows;
	const rows = await ctx.store.listOpenPendingByRoots(unique, limit + 1);
	for (const row of rows.slice(0, limit)) {
		if (row.spaceId !== ctx.space.id) continue;
		for (const id of pendingTouched(row)) {
			const list = of.get(id);
			if (list) list.push(row.id);
			else of.set(id, [row.id]);
		}
	}
	return { of, truncated: rows.length > limit };
}

// ─────────────────────────────────────────────────────────────────────────────
// Levels
// ─────────────────────────────────────────────────────────────────────────────

export interface OutlineLevelsRequest {
	space: OutlineSpaceRow;
	/** The parents whose children to read (`null`: the top level), each from its cursor. */
	parents: ReadonlyArray<{ parentId: string | null; cursor?: string | null }>;
	/** Commit seq of the space to read as of; the current state when omitted. */
	asOf?: number;
	/** Blocks in all (default 200, at most 800). */
	limit?: number;
	/** Children of one parent at most; unlimited (within `limit`) when omitted. */
	perParent?: number;
	/** UTF-8 bytes of content in all. */
	bytes?: number;
	/** Default `all`: the caller knows whether the rows it opens are process. */
	view?: OutlineViewMode;
	narratorVisible?: (narratorId: string) => Promise<boolean>;
	store?: OutlineStore;
}

export type OutlineLevelsResult = OutlineLevelsResponse;

/**
 * What a read returned, once more as tree nodes: for readers that render text and need what
 * the wire shape leaves out (the whole task with its plan and prerequisites as written, the
 * whole question). One node per block of `read.blocks`, in the same order, content and tags
 * loaded; nodes are linked among themselves, but a caller that combines several reads links
 * them itself from `read.levels`.
 */
export interface OutlineReadNodes<Read> {
	read: Read;
	nodes: OutlineNode[];
	/** Locked tasks above what was read (ancestors of the root, or of the parents asked for). */
	lockedAbove: string[];
}

/**
 * The children of the given parents, in the order given, until the budget is spent (see the
 * header). A parent that is not a live block of the space (then) has no children here.
 */
export async function readOutlineLevels(
	request: OutlineLevelsRequest,
): Promise<OutlineLevelsResult> {
	return (await readOutlineLevelsNodes(request)).read;
}

/** {@link readOutlineLevels} with the blocks as tree nodes too. */
export async function readOutlineLevelsNodes(
	request: OutlineLevelsRequest,
): Promise<OutlineReadNodes<OutlineLevelsResult>> {
	const store = request.store ?? outlineStore;
	const { space } = request;
	const ctx: ReadContext = {
		store,
		space,
		asOf: readSeq(space, request.asOf),
		narratorVisible: request.narratorVisible,
		rowsLeft: OUTLINE_SUBTREE_LIMITS.maxBlocks,
	};
	const view = request.view ?? "all";
	const limit = clamp(
		request.limit,
		OUTLINE_SUBTREE_LIMITS.defaultLevelBlocks,
		OUTLINE_SUBTREE_LIMITS.maxLevelBlocks,
	);
	const maxBytes = clamp(
		request.bytes,
		OUTLINE_SUBTREE_LIMITS.maxBytes,
		OUTLINE_SUBTREE_LIMITS.maxBytes,
	);
	const parents = request.parents.slice(0, OUTLINE_SUBTREE_LIMITS.maxParents);
	const seen = new Set<string | null>();
	for (const parent of parents) {
		if (seen.has(parent.parentId)) throw new ValidationError("A parent is named twice");
		seen.add(parent.parentId);
	}
	const perParent =
		request.perParent === undefined ? undefined : clamp(request.perParent, limit, limit);
	return withOutlineHistory(async () => {
		let drafts: LevelDraft[];
		if (perParent === undefined && parents.every((parent) => !parent.cursor)) {
			drafts = (
				await readLevelsFromStart(
					ctx,
					parents.map((parent) => parent.parentId),
					limit,
					view,
				)
			).drafts;
		} else {
			drafts = [];
			let room = limit;
			for (const parent of parents) {
				const startCursor = parent.cursor ?? null;
				const take = Math.min(room, perParent ?? room, ctx.rowsLeft);
				if (take <= 0) {
					drafts.push(draftOf(parent.parentId, [], true, view, startCursor));
					continue;
				}
				const { rows, next } = await store.listLevel(space.id, parent.parentId, {
					asOf: ctx.asOf,
					after: startCursor ? decodeOutlineLevelCursor(startCursor) : null,
					limit: take,
				});
				room -= rows.length;
				ctx.rowsLeft -= rows.length;
				drafts.push(draftOf(parent.parentId, rows, next !== null, view, startCursor));
			}
		}
		const order = drafts.flatMap((draft) => draft.rows);
		// Locked tasks among the parents and above them: one walk for all of them.
		const above = parents.flatMap((parent) => (parent.parentId ? [parent.parentId] : []));
		const lockedAbove =
			ctx.asOf === null && above.length > 0 && order.length > 0
				? (
						await store.listAncestryOf(space.id, above, OUTLINE_SUBTREE_LIMITS.markWalkRows)
					).rows.flatMap((row) => (row.locked ? [row.id] : []))
				: [];
		const done = await finish(ctx, order, drafts, maxBytes, lockedAbove);
		return {
			read: {
				spaceId: space.id,
				seq: ctx.asOf ?? space.nextSeq - 1,
				current: ctx.asOf === null,
				view,
				blocks: done.blocks,
				levels: done.levels,
				...(done.pendingTruncated ? { pendingTruncated: true } : {}),
			},
			nodes: done.shown,
			lockedAbove,
		};
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// A root and its ancestors
// ─────────────────────────────────────────────────────────────────────────────

interface Located {
	/** The root as a level row; null for the space. */
	row: OutlineLevelRow | null;
	path: Array<{ id: string; sid: string; title: string }>;
	pathTruncated: boolean;
	/** An ancestor of the root is a task or a question, or a subagent report's container. */
	inTask: boolean;
	/** The root is a task or a question, or under one: the facts view of it would be empty. */
	process: boolean;
	/** Locked tasks among the root's ancestors. */
	lockedAbove: string[];
}

/** What is under such a block is a detail (`shared/outline-fold.ts`). */
function makesDetail(block: { id: string; taskJson: unknown; askJson?: unknown }): boolean {
	return block.taskJson !== null || !!block.askJson || isOutlineReportBlockId(block.id);
}

/**
 * A block of the space with its ancestors, now or as of a seq; null when it was not in the
 * tree then. The walk up is ONE statement whatever the depth (`getAncestry`), and what it
 * says of every ancestor (task, question, lock) is the same now and as of a seq; only the
 * titles of `path` are read for the nearest ancestors alone.
 */
async function locate(ctx: ReadContext, blockId: string): Promise<Located | null> {
	const { store, space } = ctx;
	const chain = await store.getAncestry(space.id, blockId, {
		asOf: ctx.asOf,
		maxDepth: OUTLINE_LIMITS.maxDepth,
	});
	if (!chain) return null;
	const above = chain.slice(1);
	const named = above.slice(0, OUTLINE_SUBTREE_LIMITS.maxPath);
	let row: OutlineLevelRow;
	const titles = new Map<string, string>();
	if (ctx.asOf === null) {
		const meta = (await store.getBlockMetasByIds([blockId]))[0];
		if (!meta || meta.spaceId !== space.id || meta.deleted) return null;
		row = {
			id: meta.id,
			sid: meta.sid,
			parentId: meta.parentId,
			orderKey: meta.orderKey,
			alias: meta.alias,
			taskJson: meta.taskJson,
			askJson: meta.askJson,
			versionSeq: meta.versionSeq,
			// Set from the root's level once it is read.
			hasChildren: false,
		};
		if (named.length > 0) {
			for (const head of await store.getBlockHeads(named.map((entry) => entry.id)))
				titles.set(head.id, shortTitle(head.contentHead));
		}
	} else {
		const versions = await store.listVersionsAt(
			[blockId, ...named.map((entry) => entry.id)],
			ctx.asOf,
		);
		const own = versions.find((version) => version.blockId === blockId);
		if (!own || own.deleted) return null;
		row = {
			id: blockId,
			sid: chain[0]?.sid ?? "",
			parentId: own.parentId,
			orderKey: own.orderKey,
			alias: own.alias,
			taskJson: own.taskJson,
			askJson: own.askJson,
			versionSeq: own.fromSeq,
			hasChildren: false,
		};
		for (const version of versions) titles.set(version.blockId, shortTitle(version.content ?? ""));
	}
	const isProcessAt = (entry: { isTask: boolean; isAsk: boolean }) => entry.isTask || entry.isAsk;
	return {
		row,
		path: named
			.map((entry) => ({ id: entry.id, sid: entry.sid, title: titles.get(entry.id) ?? "" }))
			.reverse(),
		pathTruncated: above.length > named.length,
		inTask: above.some((entry) => isProcessAt(entry) || isOutlineReportBlockId(entry.id)),
		process: chain.some(isProcessAt),
		lockedAbove: above.flatMap((entry) => (entry.locked ? [entry.id] : [])),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// A subtree
// ─────────────────────────────────────────────────────────────────────────────

export interface OutlineSubtreeRequest {
	space: OutlineSpaceRow;
	/** The block whose subtree to read; null: the whole space. */
	rootId: string | null;
	/** Commit seq of the space to read as of; the current state when omitted. */
	asOf?: number;
	/** Blocks (default 400, at most 800, the root included) and bytes of content. */
	budget?: { blocks?: number; bytes?: number };
	/** Default `facts`. */
	view?: OutlineViewMode;
	/**
	 * Leave out what is behind closed rows (see the header): the reader's own folding (both
	 * sets empty for a reader who never folded anything here).
	 */
	fold?: { expanded: ReadonlySet<string>; collapsed: ReadonlySet<string> };
	narratorVisible?: (narratorId: string) => Promise<boolean>;
	store?: OutlineStore;
}

export type OutlineSubtreeResult = OutlineSubtreeResponse;

/** What a folded read knows of a row on the way down. */
interface FoldAt {
	depth: number;
	/** Under a task or inside a report. */
	detail: boolean;
	/** Its children are details. */
	over: boolean;
}

/**
 * A root and what is under it, breadth first within the budget (see the header). Null when
 * the root is not a live block of the space (at `asOf`).
 */
export async function readOutlineSubtree(
	request: OutlineSubtreeRequest,
): Promise<OutlineSubtreeResult | null> {
	return (await readOutlineSubtreeNodes(request))?.read ?? null;
}

/** {@link readOutlineSubtree} with the blocks as tree nodes too. */
export async function readOutlineSubtreeNodes(
	request: OutlineSubtreeRequest,
): Promise<OutlineReadNodes<OutlineSubtreeResult> | null> {
	const store = request.store ?? outlineStore;
	const { space, rootId } = request;
	const ctx: ReadContext = {
		store,
		space,
		asOf: readSeq(space, request.asOf),
		narratorVisible: request.narratorVisible,
		rowsLeft: OUTLINE_SUBTREE_LIMITS.maxBlocks,
	};
	// A block root takes one of the budget, and its own level is always looked at.
	const maxBlocks = Math.max(
		rootId === null ? 1 : 2,
		clamp(
			request.budget?.blocks,
			OUTLINE_SUBTREE_LIMITS.defaultBlocks,
			OUTLINE_SUBTREE_LIMITS.maxBlocks,
		),
	);
	const maxBytes = clamp(
		request.budget?.bytes,
		OUTLINE_SUBTREE_LIMITS.maxBytes,
		OUTLINE_SUBTREE_LIMITS.maxBytes,
	);
	return withOutlineHistory(async () => {
		let located: Located = {
			row: null,
			path: [],
			pathTruncated: false,
			inTask: false,
			process: false,
			lockedAbove: [],
		};
		if (rootId !== null) {
			const found = await locate(ctx, rootId);
			if (!found) return null;
			located = found;
		}
		const view: OutlineViewMode =
			(request.view ?? "facts") === "facts" && located.process ? "all" : (request.view ?? "facts");

		// Folded current reads: what must stay open.
		const attention =
			ctx.asOf === null && request.fold ? await readOutlineAttention(space, { store }) : null;
		const over: ReadonlySet<string> | null = attention?.over ?? null;

		const fold = request.fold;
		const foldAt = new Map<string, FoldAt>();
		const isOpen = (row: OutlineLevelRow, at: FoldAt): boolean => {
			if (!fold) return true;
			if (at.depth >= FOLD_MAX_OPEN_DEPTH) return false;
			if (fold.expanded.has(row.id)) return true;
			if (fold.collapsed.has(row.id)) return false;
			if (over?.has(row.id)) return true;
			const status = row.taskJson?.status ?? null;
			return foldDefaultOpen({
				root: false,
				task: status,
				report: isOutlineReportBlockId(row.id),
				detail: at.detail,
			});
		};

		const order: OutlineLevelRow[] = [];
		const drafts: LevelDraft[] = [];
		const closed: string[] = [];
		let room = maxBlocks;
		if (located.row) {
			order.push(located.row);
			room--;
		}
		const rootAt: FoldAt = {
			depth: 0,
			detail: located.inTask,
			over: located.inTask || (located.row !== null && makesDetail(located.row)),
		};
		let frontier: Array<string | null> = [rootId];
		let truncated = false;
		while (frontier.length > 0) {
			if (room <= 0) {
				for (const parentId of frontier) drafts.push(draftOf(parentId, [], true, view, null));
				truncated = true;
				break;
			}
			const level = await readLevelsFromStart(ctx, frontier, room, view);
			room -= level.read;
			const next: string[] = [];
			for (const draft of level.drafts) {
				drafts.push(draft);
				if (draft.more) truncated = true;
				const parentAt =
					draft.parentId === rootId ? rootAt : (foldAt.get(draft.parentId as string) ?? rootAt);
				for (const row of draft.rows) {
					order.push(row);
					const at: FoldAt = {
						depth: parentAt.depth + 1,
						detail: parentAt.over,
						over: parentAt.over || makesDetail(row),
					};
					if (!row.hasChildren) continue;
					if (fold) foldAt.set(row.id, at);
					if (isOpen(row, at)) next.push(row.id);
					else closed.push(row.id);
				}
			}
			if (located.row && frontier.length === 1 && frontier[0] === rootId) {
				const own = level.drafts[0];
				located.row.hasChildren = !!own && (own.last !== null || own.more);
			}
			frontier = next;
		}

		// The one child a closed row's preview line is read from, while the budget lasts.
		if (fold) {
			for (const id of closed.slice(0, OUTLINE_SUBTREE_LIMITS.maxPreviews)) {
				if (room <= 0 || ctx.rowsLeft <= 0) break;
				const { rows, next } = await store.listLevel(space.id, id, {
					asOf: ctx.asOf,
					limit: 1,
				});
				room -= rows.length;
				ctx.rowsLeft -= rows.length;
				const draft = draftOf(id, rows, next !== null, view, null);
				drafts.push(draft);
				for (const row of draft.rows) order.push(row);
			}
		}

		const done = await finish(ctx, order, drafts, maxBytes, located.lockedAbove);
		const shownIds = new Set(done.blocks.map((block) => block.id));
		return {
			read: {
				spaceId: space.id,
				rootId,
				seq: ctx.asOf ?? space.nextSeq - 1,
				current: ctx.asOf === null,
				view,
				path: located.path,
				pathTruncated: located.pathTruncated,
				rootInTask: located.inTask,
				blocks: done.blocks,
				levels: done.levels,
				truncated: truncated || done.cut,
				...(done.pendingTruncated ? { pendingTruncated: true } : {}),
				...(fold ? { closed: closed.filter((id) => shownIds.has(id)) } : {}),
				...(attention?.atLeast ? { attentionAtLeast: true } : {}),
			},
			nodes: done.shown,
			lockedAbove: located.lockedAbove,
		};
	});
}
