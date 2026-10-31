/**
 * Reading outlines: a page or a subtree as of any seq, rendered within a budget; a page's
 * timeline; the seq a space was at at some time.
 *
 * HOW A READ WORKS
 * ----------------
 *   1. Locate the block: its current row, or (with `asOf`) its version valid at that seq, which
 *      names the page it was on then.
 *   2. Read the page's STRUCTURE (ids, parents, order keys, tasks, aliases; no content) in one
 *      indexed statement: from the current rows, or from the version rows valid at the seq
 *      (`page_id = ? AND from_seq <= s AND (to_seq IS NULL OR to_seq > s)`), and build the tree in
 *      memory. No recursion in SQL: every block of a page carries its `page_id`. The store reads
 *      a page of up to 2000 blocks on the main thread and a larger one on the read workers; a
 *      page with more blocks than one read loads comes back truncated.
 *   3. Take the subtree of the block, list what the view and budget can show (breadth first),
 *      and load CONTENT and tags only for those blocks, by the exact version the structure named,
 *      in chunks that stop once the byte budget is spent.
 *   4. Render (`render.ts`).
 *
 * A read without `asOf` uses the current rows, which is cheaper than the version range scan; it
 * reports the space's last seq at the time of the read as its seq.
 */
import { AppError, NotFoundError, ValidationError } from "@server/lib/errors";
import { blockTitle } from "@shared/outline";
import { OUTLINE_TEXT } from "./messages";
import { OUTLINE_LIMITS } from "./model";
import {
	clampBudget,
	type OutlineBudget,
	type OutlineDisplay,
	type OutlineLabel,
	type OutlineRenderResult,
	renderOutline,
} from "./render";
import { outlineStore } from "./store";
import type { OutlineCommitRow, OutlineSpaceRow, OutlineStore } from "./store/port";
import {
	ancestorsOf,
	breadthFirst,
	buildTree,
	effectiveView,
	type OutlineNode,
	type OutlineView,
} from "./tree";

/** Limits of reads that are not about rendering. */
export const OUTLINE_READ_PAGE_LIMITS = {
	/** Blocks of one page a read loads; a larger page is read truncated. */
	maxPageBlocks: OUTLINE_LIMITS.maxPageBlocks,
	/** Blocks whose content one statement loads. */
	bodyChunk: 100,
	/** Commits one timeline page returns at most. */
	maxTimelineCommits: 200,
	defaultTimelineCommits: 50,
} as const;

/** The block's page holds more blocks than one read loads and the block was not among them. */
export class OutlinePageTooLargeError extends AppError {
	constructor(pageId: string) {
		super(
			OUTLINE_TEXT.errors.pageTooLarge(pageId, OUTLINE_READ_PAGE_LIMITS.maxPageBlocks),
			413,
			"OUTLINE_PAGE_TOO_LARGE",
		);
		this.name = "OutlinePageTooLargeError";
	}
}

export interface OutlineReadOptions {
	/** Commit seq of the block's space to read as of; the current state when omitted. */
	asOf?: number;
	store?: OutlineStore;
}

/** A page's tree at one seq, content not loaded yet. */
export interface OutlinePageState {
	space: OutlineSpaceRow;
	pageId: string;
	/**
	 * The seq the state is as of. For a current read, the space's last commit when the read
	 * started (a commit landing during the read may show in it).
	 */
	seq: number;
	/** Read from the current rows rather than from history. */
	current: boolean;
	/** Every block read, by id. */
	nodes: Map<string, OutlineNode>;
	/** The page block, null when the page was not live (or not a page) at the seq. */
	page: OutlineNode | null;
	/** The page has more blocks than one read loads; some were left out. */
	truncated: boolean;
}

/** The seq to read a space at: `asOf` checked and capped at the space's last commit. */
function readSeq(space: OutlineSpaceRow, asOf: number | undefined): number | null {
	if (asOf === undefined) return null;
	if (!Number.isSafeInteger(asOf) || asOf < 0) {
		throw new ValidationError(OUTLINE_TEXT.errors.badSeq("asOf"));
	}
	return Math.min(asOf, space.nextSeq - 1);
}

async function spaceOf(store: OutlineStore, spaceId: string): Promise<OutlineSpaceRow> {
	const space = await store.getSpace(spaceId);
	if (!space) throw new NotFoundError("Outline space", spaceId);
	return space;
}

async function pageState(
	store: OutlineStore,
	space: OutlineSpaceRow,
	pageId: string,
	seq: number | null,
): Promise<OutlinePageState> {
	const { rows, truncated } = await store.listPageStructure(pageId, {
		asOf: seq,
		limit: OUTLINE_READ_PAGE_LIMITS.maxPageBlocks,
	});
	const nodes = buildTree(rows);
	const page = nodes.get(pageId);
	return {
		space,
		pageId,
		seq: seq ?? space.nextSeq - 1,
		current: seq === null,
		nodes,
		page: page && page.parentId === null ? page : null,
		truncated,
	};
}

/** A page's tree, current or as of a seq. Null when the page does not exist (then). */
export async function readPageState(
	pageId: string,
	options: OutlineReadOptions = {},
): Promise<OutlinePageState | null> {
	const store = options.store ?? outlineStore;
	const block = await store.getBlock(pageId);
	if (!block) return null;
	const space = await spaceOf(store, block.spaceId);
	const state = await pageState(store, space, pageId, readSeq(space, options.asOf));
	return state.page ? state : null;
}

export interface OutlineSubtree {
	state: OutlinePageState;
	root: OutlineNode;
	/** The root's ancestors, the page first. */
	path: OutlineNode[];
}

/** A block and its subtree, current or as of a seq. Null when the block is not live (then). */
export async function readSubtree(
	blockId: string,
	options: OutlineReadOptions = {},
): Promise<OutlineSubtree | null> {
	const store = options.store ?? outlineStore;
	// A current read retries once: the block may move to another page between its two reads.
	for (let attempt = 0; attempt < 2; attempt++) {
		const block = await store.getBlock(blockId);
		if (!block) return null;
		const space = await spaceOf(store, block.spaceId);
		const seq = readSeq(space, options.asOf);
		let pageId: string;
		if (seq === null) {
			if (block.deleted) return null;
			pageId = block.pageId;
		} else {
			const version = (await store.listVersionsAt([blockId], seq))[0];
			if (!version || version.deleted) return null;
			pageId = version.pageId;
		}
		const state = await pageState(store, space, pageId, seq);
		const root = state.nodes.get(blockId);
		if (root) return { state, root, path: ancestorsOf(root) };
		if (state.truncated) throw new OutlinePageTooLargeError(pageId);
		if (seq !== null) break;
	}
	return null;
}

/**
 * Load content and tags of the given nodes (those not loaded yet): the content of exactly the
 * version the structure named (versions never change, so even a current read gets the content
 * that goes with its structure), and the tags valid at the state's seq (open ones for a current
 * read).
 */
export async function loadBodies(
	state: Pick<OutlinePageState, "current" | "seq">,
	nodes: readonly OutlineNode[],
	options: { store?: OutlineStore } = {},
): Promise<void> {
	const store = options.store ?? outlineStore;
	const pending = nodes.filter((n) => n.content === null);
	if (pending.length === 0) return;
	const ids = pending.map((n) => n.id);
	const seq = state.current ? null : state.seq;
	const byId = new Map(pending.map((n) => [n.id, n]));
	const versions = await store.listVersionContents(
		pending.map((n) => ({ blockId: n.id, fromSeq: n.versionSeq })),
	);
	for (const version of versions) {
		const node = byId.get(version.blockId);
		if (node) node.content = version.content ?? "";
	}
	const tags = new Map<string, string[]>();
	const links = await store.listLinksAt(
		ids,
		seq,
		["tag"],
		ids.length * OUTLINE_LIMITS.maxTagsPerBlock,
	);
	for (const link of links) {
		const list = tags.get(link.fromBlockId);
		if (list) list.push(link.targetRef);
		else tags.set(link.fromBlockId, [link.targetRef]);
	}
	for (const node of pending) {
		node.content ??= "";
		node.tags = (tags.get(node.id) ?? []).sort();
	}
}

function utf8(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * Load bodies of `order` front to back, a chunk at a time, until their content alone exceeds
 * `maxBytes`: the rendered text of a block is never shorter than its content, so a budget of
 * `maxBytes` can never show a block past that point.
 */
export async function loadBodiesWithin(
	state: Pick<OutlinePageState, "current" | "seq">,
	order: readonly OutlineNode[],
	maxBytes: number,
	options: { store?: OutlineStore } = {},
): Promise<void> {
	let bytes = 0;
	for (let i = 0; i < order.length && bytes <= maxBytes; ) {
		const chunk = order.slice(i, i + OUTLINE_READ_PAGE_LIMITS.bodyChunk);
		await loadBodies(state, chunk, options);
		for (const node of chunk) {
			bytes += utf8(node.content ?? "");
			i++;
			if (bytes > maxBytes) break;
		}
	}
}

export interface OutlineReadRequest extends OutlineReadOptions {
	/** The block to read: a page, or any block of one (its subtree is read). */
	blockId: string;
	/** Default `facts`. */
	view?: OutlineView;
	budget?: Partial<OutlineBudget>;
	label?: OutlineLabel;
	/**
	 * Prepares what each block renders as (see `OutlineRenderOptions.display`), once the
	 * content of the blocks the read may show (`nodes`, the root first) is loaded.
	 */
	display?: (
		state: OutlinePageState,
		nodes: readonly OutlineNode[],
	) => Promise<OutlineDisplay | undefined>;
}

export interface OutlineReadResult extends OutlineRenderResult {
	space: Pick<OutlineSpaceRow, "id" | "key" | "kind">;
	pageId: string;
	rootId: string;
	/** The seq the read is as of (see {@link OutlinePageState.seq}). */
	seq: number;
	current: boolean;
	/** Some of the subtree is not in `markdown`: the budget ran out or the page was too large. */
	truncated: boolean;
	/** The root's ancestors, the page first. */
	path: Array<{ id: string; sid: string; title: string }>;
}

/**
 * A block and its subtree as a markdown outline: the facts view by default, expanded breadth
 * first within the budget. Null when the block is not live (at `asOf`).
 */
export async function readOutline(request: OutlineReadRequest): Promise<OutlineReadResult | null> {
	const store = request.store ?? outlineStore;
	const subtree = await readSubtree(request.blockId, { asOf: request.asOf, store });
	if (!subtree) return null;
	const { state, root, path } = subtree;
	const view = effectiveView(root, request.view ?? "facts");
	const budget = clampBudget(request.budget);
	const order = breadthFirst(root, view, budget.blocks);
	await loadBodiesWithin(state, order, budget.bytes, { store });
	await loadBodies(state, path, { store });
	const display = request.display
		? await request.display(
				state,
				order.filter((node) => node.content !== null),
			)
		: undefined;
	const rendered = renderOutline(root, {
		view,
		budget,
		label: request.label,
		display,
		truncatedRead: state.truncated ? { blocksRead: state.nodes.size } : undefined,
	});
	return {
		...rendered,
		space: { id: state.space.id, key: state.space.key, kind: state.space.kind },
		pageId: state.pageId,
		rootId: root.id,
		seq: state.seq,
		current: state.current,
		truncated: rendered.hiddenByBudget > 0 || state.truncated,
		path: path.map((node) => ({
			id: node.id,
			sid: node.sid,
			title: blockTitle(node.content ?? ""),
		})),
	};
}

export interface OutlineTimelinePage {
	/** Commits that touched the page, newest first. */
	commits: OutlineCommitRow[];
	/** Pass as `before` for the next (older) page; null when there is none. */
	nextBefore: number | null;
}

/**
 * Commits that touched a page, newest first, `limit` (at most 200) per page: commits that wrote a
 * version under it, and commits that moved blocks off it. Pages are cut by seq (`before` is
 * exclusive). Null when the block does not exist.
 */
export async function readPageTimeline(
	pageId: string,
	options: { before?: number; limit?: number; store?: OutlineStore } = {},
): Promise<OutlineTimelinePage | null> {
	const store = options.store ?? outlineStore;
	const block = await store.getBlock(pageId);
	if (!block) return null;
	const space = await spaceOf(store, block.spaceId);
	const limit = Math.max(
		1,
		Math.min(
			OUTLINE_READ_PAGE_LIMITS.maxTimelineCommits,
			Math.floor(options.limit ?? OUTLINE_READ_PAGE_LIMITS.defaultTimelineCommits),
		),
	);
	const before = Math.min(options.before ?? space.nextSeq, space.nextSeq);
	if (!Number.isSafeInteger(before))
		throw new ValidationError(OUTLINE_TEXT.errors.badSeq("before"));
	// Versions that opened under the page: the newest `limit + 1` seqs say how far back this
	// page of the timeline reaches.
	const opened = await store.listPageSeqs(pageId, {
		edge: "from",
		before,
		after: 0,
		limit: limit + 1,
	});
	const floor = opened.length > limit ? (opened[limit] as number) : 0;
	// Versions under the page that closed in that window without a successor under it: blocks
	// that moved off the page.
	const closed = await store.listPageSeqs(pageId, {
		edge: "to",
		before,
		after: floor,
		limit: limit + 1,
	});
	const seqs = [...new Set([...opened.filter((s) => s > floor), ...closed])].sort((a, b) => b - a);
	let nextBefore: number | null = null;
	let page = seqs;
	if (seqs.length > limit) {
		page = seqs.slice(0, limit);
		nextBefore = page[page.length - 1] as number;
	} else if (opened.length > limit) {
		nextBefore = floor + 1;
	}
	const commits = await store.getCommitsBySeqs(space.id, page);
	commits.sort((a, b) => b.seq - a.seq);
	return { commits, nextBefore };
}

/**
 * The seq of the last commit of a space made at or before `at` (0 when there is none): what a
 * read "as of a time" reads at. Commits take their time when they are planned, in seq order, so
 * this is a binary search over seqs.
 */
export async function commitSeqAt(
	spaceId: string,
	at: Date | string,
	options: { store?: OutlineStore } = {},
): Promise<number> {
	const store = options.store ?? outlineStore;
	const space = await spaceOf(store, spaceId);
	const when = new Date(at);
	if (Number.isNaN(when.getTime())) throw new ValidationError(OUTLINE_TEXT.errors.badTime);
	const target = when.toISOString();
	let lo = 0;
	let hi = space.nextSeq - 1;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		const commit = (await store.getCommitsBySeqs(spaceId, [mid]))[0];
		if (commit && commit.createdAt <= target) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}
