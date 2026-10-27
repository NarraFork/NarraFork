/**
 * What the outline pages of the web app show, in the shapes of `shared/outline-api.ts`: spaces
 * with display names, a block and its subtree as a tree within a budget, the pages of a space,
 * a page's timeline, a block's history.
 *
 * Nothing here decides access: callers check `access.ts` first and pass only what the person
 * may read. Every read is bounded (the read limits of `read.ts` and `render.ts`), and a page
 * too large to read on the main thread is read on the read workers by the store.
 *
 * BUDGETED EXPANSION
 * ------------------
 * The same rule as the agent's read (`render.ts`): the root, then whole levels breadth first,
 * while blocks fit the block and byte budgets; the first block that does not fit ends the
 * expansion, so what is shown is a prefix of the breadth-first order and every shown block's
 * parent is shown. Under each shown block, `hidden` counts the blocks of the view below it that
 * were left out; the client offers to focus that block, which reads its subtree with a fresh
 * budget.
 */
import { ValidationError } from "@server/lib/errors";
import { titleOf } from "@shared/outline";
import type {
	OutlineBlockHistoryResponse,
	OutlineBlockViewResponse,
	OutlineChange,
	OutlineCommitSummary,
	OutlinePageListResponse,
	OutlineSpaceSummary,
	OutlineTimelineResponse,
	OutlineViewBlock,
	OutlineViewMode,
} from "@shared/outline-api";
import type { OutlinePrincipal } from "./access";
import { readDisplayNames } from "./access-reads";
import { OUTLINE_CHANGE } from "./model";
import { loadBodies, loadBodiesWithin, readPageTimeline, readSubtree } from "./read";
import { clampBudget, type OutlineBudget } from "./render";
import { isOrphanedSpace } from "./spaces";
import { outlineStore } from "./store";
import type { OutlineCommitRow, OutlineSpaceRow, OutlineStore } from "./store/port";
import { effectiveView, type OutlineNode, viewChildren } from "./tree";

/** Characters of a title in a page list. */
const TITLE_CHARS = 200;

function utf8(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function shortTitle(content: string): string {
	const title = titleOf(content);
	const chars = Array.from(title);
	return chars.length <= TITLE_CHARS ? title : `${chars.slice(0, TITLE_CHARS - 1).join("")}…`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spaces
// ─────────────────────────────────────────────────────────────────────────────

/** Spaces as the client lists them, with the names of what they belong to. */
export async function describeSpaces(
	principal: OutlinePrincipal,
	spaces: readonly OutlineSpaceRow[],
): Promise<OutlineSpaceSummary[]> {
	const names = await readDisplayNames({
		projectIds: spaces.flatMap((s) => (s.kind === "project" && s.projectId ? [s.projectId] : [])),
		narratorIds: spaces.flatMap((s) =>
			s.kind === "session" && s.narratorId ? [s.narratorId] : [],
		),
	});
	return spaces.map((space) => {
		const label =
			space.kind === "project" && space.projectId
				? (names.projects.get(space.projectId) ?? null)
				: space.kind === "session" && space.narratorId
					? (names.narrators.get(space.narratorId) ?? null)
					: null;
		return {
			id: space.id,
			key: space.key,
			kind: space.kind,
			projectId: space.projectId,
			narratorId: space.narratorId,
			label,
			mine: space.kind === "personal" && space.ownerUserId === principal.userId,
			orphaned: isOrphanedSpace(space),
			lastSeq: space.nextSeq - 1,
		};
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Pages of a space
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_CURSOR = /^[\x21-\x7e]{1,512}$/;

function encodePageCursor(orderKey: string, id: string): string {
	return Buffer.from(JSON.stringify([orderKey, id]), "utf8").toString("base64url");
}

function decodePageCursor(cursor: string): { orderKey: string; id: string } {
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (
			Array.isArray(value) &&
			value.length === 2 &&
			typeof value[0] === "string" &&
			typeof value[1] === "string" &&
			PAGE_CURSOR.test(value[0]) &&
			PAGE_CURSOR.test(value[1])
		) {
			return { orderKey: value[0], id: value[1] };
		}
	} catch {
		// Fall through to the validation error.
	}
	throw new ValidationError("Invalid cursor");
}

/** The live pages of a space in sibling order, `limit` at a time. */
export async function listSpacePages(
	spaceId: string,
	options: { cursor?: string | null; limit: number; store?: OutlineStore },
): Promise<OutlinePageListResponse> {
	const store = options.store ?? outlineStore;
	const after = options.cursor ? decodePageCursor(options.cursor) : null;
	const rows = await store.listSpacePages(spaceId, { after, limit: options.limit + 1 });
	const page = rows.slice(0, options.limit);
	const last = page.at(-1);
	return {
		pages: page.map((row) => ({
			id: row.id,
			sid: row.sid,
			title: shortTitle(row.contentHead),
			alias: row.alias,
			isTask: row.isTask,
		})),
		nextCursor:
			rows.length > options.limit && last ? encodePageCursor(last.orderKey, last.id) : null,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// A block and its subtree
// ─────────────────────────────────────────────────────────────────────────────

const OPEN_TASK = new Set(["todo", "doing"]);

function countSubtree(root: OutlineNode): number {
	let count = 0;
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.pop() as OutlineNode;
		count++;
		for (const child of node.children) stack.push(child);
	}
	return count;
}

export interface OutlineBlockViewRequest {
	blockId: string;
	/** Commit seq of the block's space; the current state when omitted. */
	asOf?: number;
	view?: OutlineViewMode;
	budget?: Partial<OutlineBudget>;
	store?: OutlineStore;
}

export type OutlineBlockView = Omit<OutlineBlockViewResponse, "space">;

/**
 * A block and its subtree as a tree of blocks: the facts view by default, expanded breadth
 * first within the budget (see the module header). Null when the block is not live (at
 * `asOf`).
 */
export async function readBlockView(
	request: OutlineBlockViewRequest,
): Promise<OutlineBlockView | null> {
	const store = request.store ?? outlineStore;
	const subtree = await readSubtree(request.blockId, { asOf: request.asOf, store });
	if (!subtree) return null;
	const { state, root, path } = subtree;
	const view = effectiveView(root, request.view ?? "facts");
	const budget = clampBudget(request.budget);

	// The whole subtree in the view, breadth first, with each block's view-subtree size.
	const kids = new Map<OutlineNode, OutlineNode[]>();
	const order: OutlineNode[] = [root];
	for (let i = 0; i < order.length; i++) {
		const node = order[i] as OutlineNode;
		const list = viewChildren(node, view);
		kids.set(node, list);
		order.push(...list);
	}
	const size = new Map<OutlineNode, number>();
	for (let i = order.length - 1; i >= 0; i--) {
		const node = order[i] as OutlineNode;
		let total = 1;
		for (const child of kids.get(node) ?? []) total += size.get(child) ?? 0;
		size.set(node, total);
	}

	const candidates = order.slice(0, budget.blocks);
	await loadBodiesWithin(state, candidates, budget.bytes, { store });
	await loadBodies(state, path, { store });
	const shown: OutlineNode[] = [];
	let bytes = 0;
	for (const node of candidates) {
		if (node.content === null) break;
		const cost = utf8(node.content);
		if (shown.length > 0 && bytes + cost > budget.bytes) break;
		bytes += cost;
		shown.push(node);
	}
	const shownSet = new Set(shown);

	let hiddenByView = 0;
	const blocks: OutlineViewBlock[] = shown.map((node) => {
		const children = kids.get(node) ?? [];
		let hidden = 0;
		const childIds: string[] = [];
		for (const child of children) {
			if (shownSet.has(child)) childIds.push(child.id);
			else hidden += size.get(child) ?? 0;
		}
		let processHidden = 0;
		let openTasks = 0;
		for (const child of node.children) {
			if (child.task && OPEN_TASK.has(child.task.status)) openTasks++;
			if (view === "facts" && child.task) processHidden += countSubtree(child);
		}
		return {
			id: node.id,
			sid: node.sid,
			parentId: node.parentId,
			content: node.content ?? "",
			task: node.task
				? {
						status: node.task.status,
						assignee: node.task.assignee,
						due: node.task.due ?? null,
						depends: (node.task.depends ?? []).map((d) => d.target),
					}
				: null,
			alias: node.alias,
			tags: node.tags ?? [],
			childIds,
			hidden,
			processHidden,
			openTasks,
		};
	});
	if (view === "facts") {
		for (const node of order) {
			for (const child of node.children) if (child.task) hiddenByView += countSubtree(child);
		}
	}
	return {
		pageId: state.pageId,
		rootId: root.id,
		seq: state.seq,
		current: state.current,
		view,
		path: path.map((node) => ({
			id: node.id,
			sid: node.sid,
			title: shortTitle(node.content ?? ""),
		})),
		blocks,
		hiddenByBudget: (size.get(root) ?? 1) - shown.length,
		hiddenByView,
		pageTruncated: state.truncated,
		pageBlocks: state.nodes.size,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────────────────────

const CHANGE_NAMES: ReadonlyArray<[number, OutlineChange]> = [
	[OUTLINE_CHANGE.CREATE, "create"],
	[OUTLINE_CHANGE.CONTENT, "content"],
	[OUTLINE_CHANGE.MOVE, "move"],
	[OUTLINE_CHANGE.DELETE, "delete"],
	[OUTLINE_CHANGE.RESTORE, "restore"],
	[OUTLINE_CHANGE.TASK, "task"],
	[OUTLINE_CHANGE.PAGE, "page"],
	[OUTLINE_CHANGE.PROPS, "props"],
];

/** The change flags of a version, by name. */
export function decodeChanges(flags: number): OutlineChange[] {
	return CHANGE_NAMES.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => name);
}

/** Commits as the client shows them, with the usernames of the people behind them. */
export async function summarizeCommits(
	commits: readonly OutlineCommitRow[],
): Promise<OutlineCommitSummary[]> {
	const names = await readDisplayNames({
		userIds: commits.flatMap((c) => [
			...(c.actorKind === "human" ? [c.actorId] : []),
			...(c.responsibleUserId ? [c.responsibleUserId] : []),
		]),
	});
	return commits.map((commit) => ({
		id: commit.id,
		seq: commit.seq,
		kind: commit.kind,
		actorKind: commit.actorKind,
		actorName: commit.actorKind === "human" ? (names.users.get(commit.actorId) ?? null) : null,
		responsibleName: commit.responsibleUserId
			? (names.users.get(commit.responsibleUserId) ?? null)
			: null,
		narratorId: commit.narratorId,
		createdAt: commit.createdAt,
		summary: commit.summary,
	}));
}

/** Commits that touched a page, newest first, a page at a time. Null for an unknown block. */
export async function readTimelineView(
	pageId: string,
	options: { before?: number; limit: number; store?: OutlineStore },
): Promise<OutlineTimelineResponse | null> {
	const timeline = await readPageTimeline(pageId, options);
	if (!timeline) return null;
	return {
		commits: await summarizeCommits(timeline.commits),
		nextBefore: timeline.nextBefore,
	};
}

/** Versions of one block, newest first, each with the commit that wrote it. */
export async function readBlockHistory(
	block: { id: string; spaceId: string },
	options: { before?: number; limit: number; store?: OutlineStore },
): Promise<OutlineBlockHistoryResponse> {
	const store = options.store ?? outlineStore;
	const rows = await store.listBlockHistory(block.id, {
		before: options.before ?? null,
		limit: options.limit + 1,
	});
	const page = rows.slice(0, options.limit);
	const commits = await store.getCommitsBySeqs(
		block.spaceId,
		page.map((row) => row.fromSeq),
	);
	const bySeq = new Map((await summarizeCommits(commits)).map((c) => [c.seq, c]));
	return {
		entries: page.map((row) => ({
			seq: row.fromSeq,
			changes: decodeChanges(row.changeFlags),
			deleted: row.deleted,
			pageId: row.pageId,
			commit: bySeq.get(row.fromSeq) ?? null,
		})),
		nextBefore: rows.length > options.limit ? (page.at(-1)?.fromSeq ?? null) : null,
	};
}
