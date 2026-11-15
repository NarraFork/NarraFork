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
 * Around that: the root's ancestors (one primary-key read per level of depth), and for a
 * current read the space's open changes and locks' names.
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
import { readOutlineAttention } from "./subtree-marks";
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Levels as read, before content
// ─────────────────────────────────────────────────────────────────────────────

/** One parent's children as the store returned them. */
interface LevelDraft {
	parentId: string | null;
	/** The rows the view shows, in sibling order. */
	rows: OutlineLevelRow[];
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
		last: read.at(-1) ?? null,
		more,
		startCursor,
		processHidden: read.length - rows.length,
	};
}

/**
 * The children of several parents from their beginnings, at most `limit` rows in all: one
 * store read (`listLevels`), split by parent. Parents the limit did not reach come back as
 * unread drafts (`more`, no rows).
 */
async function readLevelsFromStart(
	ctx: ReadContext,
	parentIds: readonly (string | null)[],
	limit: number,
	view: OutlineViewMode,
): Promise<{ drafts: LevelDraft[]; read: number }> {
	const { rows, truncated } = await ctx.store.listLevels(ctx.space.id, parentIds, {
		asOf: ctx.asOf,
		limit,
	});
	const byParent = new Map<string | null, OutlineLevelRow[]>();
	for (const row of rows) {
		const list = byParent.get(row.parentId);
		if (list) list.push(row);
		else byParent.set(row.parentId, [row]);
	}
	const cutAt = truncated ? (rows.at(-1)?.parentId ?? null) : undefined;
	const drafts: LevelDraft[] = [];
	// Parents come back in the order given; past the one the limit cut, nothing was read.
	let reached = true;
	for (const parentId of new Set(parentIds)) {
		const own = byParent.get(parentId) ?? [];
		if (!truncated) drafts.push(draftOf(parentId, own, false, view, null));
		else if (rows.length === 0) drafts.push(draftOf(parentId, [], true, view, null));
		else if (parentId === cutAt) {
			drafts.push(draftOf(parentId, own, true, view, null));
			reached = false;
		} else drafts.push(draftOf(parentId, own, !reached, view, null));
	}
	return { drafts, read: rows.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Content, marks and the wire shape
// ─────────────────────────────────────────────────────────────────────────────

interface Finished {
	blocks: OutlineTreeBlock[];
	levels: OutlineTreeLevel[];
	/** Rows left out because the byte budget ran out. */
	cut: boolean;
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
	pendingOf: ReadonlyMap<string, string[]> | null,
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
			pending: pendingOf?.get(node.id) ?? [],
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
			// Cut by bytes: the rows after the cut are read again, and counted then.
			processHidden: whole ? draft.processHidden : 0,
		});
	}
	return { blocks, levels, cut: shown.length < order.length };
}

async function pendingMarks(ctx: ReadContext): Promise<Map<string, string[]> | null> {
	if (ctx.asOf !== null) return null;
	const rows = await ctx.store.listOpenPendingBySpace(
		ctx.space.id,
		OUTLINE_SUBTREE_LIMITS.markCandidates,
	);
	const out = new Map<string, string[]>();
	const mark = (id: string, rowId: string) => {
		const list = out.get(id);
		if (!list) out.set(id, [rowId]);
		else if (!list.includes(rowId)) list.push(rowId);
	};
	for (const row of rows) {
		for (const id of row.blockIdsJson) mark(id, row.id);
		for (const add of row.addsJson) if (add.parentId) mark(add.parentId, row.id);
	}
	return out;
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
 * The children of the given parents, in the order given, until the budget is spent (see the
 * header). A parent that is not a live block of the space (then) has no children here.
 */
export async function readOutlineLevels(
	request: OutlineLevelsRequest,
): Promise<OutlineLevelsResult> {
	const store = request.store ?? outlineStore;
	const { space } = request;
	const ctx: ReadContext = {
		store,
		space,
		asOf: readSeq(space, request.asOf),
		narratorVisible: request.narratorVisible,
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
				if (room <= 0) {
					drafts.push(draftOf(parent.parentId, [], true, view, startCursor));
					continue;
				}
				const { rows, next } = await store.listLevel(space.id, parent.parentId, {
					asOf: ctx.asOf,
					after: startCursor ? decodeOutlineLevelCursor(startCursor) : null,
					limit: Math.min(room, perParent ?? room),
				});
				room -= rows.length;
				drafts.push(draftOf(parent.parentId, rows, next !== null, view, startCursor));
			}
		}
		const order = drafts.flatMap((draft) => draft.rows);
		const done = await finish(ctx, order, drafts, maxBytes, await pendingMarks(ctx));
		return {
			spaceId: space.id,
			seq: ctx.asOf ?? space.nextSeq - 1,
			current: ctx.asOf === null,
			view,
			blocks: done.blocks,
			levels: done.levels,
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
}

/** What is under such a block is a detail (`shared/outline-fold.ts`). */
function makesDetail(block: { id: string; taskJson: unknown; askJson?: unknown }): boolean {
	return block.taskJson !== null || !!block.askJson || isOutlineReportBlockId(block.id);
}

/** A block of the space as it is now, with its ancestors; null when it is not live. */
async function locateNow(ctx: ReadContext, blockId: string): Promise<Located | null> {
	const { store, space } = ctx;
	const first = (await store.getBlockMetasByIds([blockId]))[0];
	if (!first || first.spaceId !== space.id || first.deleted) return null;
	const chain = [first];
	// One primary-key read per level of depth; the tree is at most `maxDepth` deep.
	for (let at = first; at.parentId !== null; ) {
		if (chain.length > OUTLINE_LIMITS.maxDepth) return null;
		const parent = (await store.getBlockMetasByIds([at.parentId]))[0];
		if (!parent || parent.spaceId !== space.id || parent.deleted) return null;
		chain.push(parent);
		at = parent;
	}
	const above = chain.slice(1);
	const named = above.slice(0, OUTLINE_SUBTREE_LIMITS.maxPath);
	const heads = new Map(
		(await store.getBlockHeads(named.map((meta) => meta.id))).map((row) => [
			row.id,
			row.contentHead,
		]),
	);
	return {
		row: {
			id: first.id,
			sid: first.sid,
			parentId: first.parentId,
			orderKey: first.orderKey,
			alias: first.alias,
			taskJson: first.taskJson,
			askJson: first.askJson,
			versionSeq: first.versionSeq,
			// Set from the root's level once it is read.
			hasChildren: false,
		},
		path: named
			.map((meta) => ({ id: meta.id, sid: meta.sid, title: shortTitle(heads.get(meta.id) ?? "") }))
			.reverse(),
		pathTruncated: above.length > named.length,
		inTask: above.some(makesDetail),
		process: chain.some((meta) => meta.taskJson !== null || !!meta.askJson),
	};
}

/**
 * A block of the space as of a seq, with its ancestors then: its placements walked up to the
 * space (one backward seek per level), which is what says it was in the tree. Null when it was
 * not.
 */
async function locateAsOf(ctx: ReadContext, blockId: string, seq: number): Promise<Located | null> {
	const { store, space } = ctx;
	const ids: string[] = [];
	for (let at = blockId; ; ) {
		if (ids.length > OUTLINE_LIMITS.maxDepth) return null;
		const placement = (await store.getPlacementsAt(space.id, [at], seq))[0];
		if (!placement) return null;
		ids.push(at);
		if (placement.parentKey === space.id) break;
		at = placement.parentKey;
	}
	const named = ids.slice(0, OUTLINE_SUBTREE_LIMITS.maxPath + 1);
	const versions = new Map(
		(await store.listVersionsAt(named, seq)).map((version) => [version.blockId, version]),
	);
	const sids = new Map(
		(await store.getBlockMetasByIds(named)).map((meta) => [meta.id, meta.sid] as const),
	);
	const own = versions.get(blockId);
	if (!own || own.deleted) return null;
	const above = named.slice(1);
	const isProcessAt = (id: string) => {
		const version = versions.get(id);
		return !!version && (version.taskJson !== null || !!version.askJson);
	};
	return {
		row: {
			id: blockId,
			sid: sids.get(blockId) ?? "",
			parentId: own.parentId,
			orderKey: own.orderKey,
			alias: own.alias,
			taskJson: own.taskJson,
			askJson: own.askJson,
			versionSeq: own.fromSeq,
			hasChildren: false,
		},
		path: above
			.map((id) => ({
				id,
				sid: sids.get(id) ?? "",
				title: shortTitle(versions.get(id)?.content ?? ""),
			}))
			.reverse(),
		pathTruncated: ids.length > named.length,
		inTask: above.some((id) => isProcessAt(id) || isOutlineReportBlockId(id)),
		process: named.some(isProcessAt),
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
	const store = request.store ?? outlineStore;
	const { space, rootId } = request;
	const ctx: ReadContext = {
		store,
		space,
		asOf: readSeq(space, request.asOf),
		narratorVisible: request.narratorVisible,
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
		};
		if (rootId !== null) {
			const found =
				ctx.asOf === null ? await locateNow(ctx, rootId) : await locateAsOf(ctx, rootId, ctx.asOf);
			if (!found) return null;
			located = found;
		}
		const view: OutlineViewMode =
			(request.view ?? "facts") === "facts" && located.process ? "all" : (request.view ?? "facts");

		// Current reads: what open changes touch, and (folded) what must stay open.
		let pendingOf: Map<string, string[]> | null = null;
		let over: ReadonlySet<string> | null = null;
		if (ctx.asOf === null) {
			if (request.fold) {
				const attention = await readOutlineAttention(space, { store });
				pendingOf = attention.pendingOf;
				over = attention.over;
			} else pendingOf = await pendingMarks(ctx);
		}

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
				if (room <= 0) break;
				const { rows, next } = await store.listLevel(space.id, id, {
					asOf: ctx.asOf,
					limit: 1,
				});
				room -= rows.length;
				const draft = draftOf(id, rows, next !== null, view, null);
				drafts.push(draft);
				for (const row of draft.rows) order.push(row);
			}
		}

		const done = await finish(ctx, order, drafts, maxBytes, pendingOf);
		const shownIds = new Set(done.blocks.map((block) => block.id));
		return {
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
			...(fold ? { closed: closed.filter((id) => shownIds.has(id)) } : {}),
		};
	});
}
