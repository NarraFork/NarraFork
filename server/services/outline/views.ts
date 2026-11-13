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
 *
 * FOLDED READS (readability F)
 * ---------------------------
 * With `fold`, the budget is not spent behind closed rows: the page's default folding
 * (`shared/outline-fold.ts`: finished tasks, subagent reports, details under a task) with the
 * reader's stored folding over it says which rows are closed, and under a closed row only what
 * its ONE preview line is read from is taken (a finished task's first note, a report's first
 * paragraph, the first block of anything else). So a big task page shows its open work. A closed
 * row that hides something nobody must miss (a question waiting for an answer, a change waiting
 * for confirmation, a lock) is read whole: its marks are counted from its blocks. A block read
 * this way says so (`fold`: how much is behind it); the reader opening it stores that and reads
 * the page again. The focused page and the editor never ask for it.
 *
 * LOCKS, PENDING CHANGES, IN PROGRESS (P2 PR 6)
 * --------------------------------------------
 * A locked task carries its lock (who, and the session confirming on their behalf); a block an
 * open change touches carries the change's id (it waits for confirmation); every shown block
 * lists the open tasks directly under it (at most {@link OUTLINE_PENDING_API_LIMITS}), the facts
 * view's "in progress" marker. One indexed read of the page's open changes, the names of the
 * people and sessions, and the titles of the listed tasks (their content, by version).
 */
import { ValidationError } from "@server/lib/errors";
import { titleOf } from "@shared/outline";
import {
	OUTLINE_PENDING_API_LIMITS,
	type OutlineBlockHistoryResponse,
	type OutlineBlockViewResponse,
	type OutlineChange,
	type OutlineCommitSummary,
	type OutlineInProgressItem,
	type OutlineLockView,
	type OutlinePageListResponse,
	type OutlineQuestionMark,
	type OutlineSpaceSummary,
	type OutlineTimelineResponse,
	type OutlineViewBlock,
	type OutlineViewMode,
} from "@shared/outline-api";
import { buildFoldTree, type FoldView } from "@shared/outline-fold";
import { isOutlineReportBlockId, isOutlineReportContainer } from "@shared/outline-report-line";
import type { OutlinePrincipal } from "./access";
import { readDisplayNames } from "./access-reads";
import {
	OUTLINE_CHANGE,
	OUTLINE_PENDING_LIMITS,
	type OutlineAskJson,
	type OutlineTaskLockJson,
} from "./model";
import { loadBodies, loadBodiesWithin, readPageTimeline, readSubtree } from "./read";
import { clampBudget, type OutlineBudget } from "./render";
import { readReportAuthors } from "./report-authors";
import { isOrphanedSpace } from "./spaces";
import { outlineStore } from "./store";
import type { OutlineCommitRow, OutlineSpaceRow, OutlineStore } from "./store/port";
import { effectiveView, isProcessNode, type OutlineNode, viewChildren } from "./tree";

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

/** A task not done or cancelled, or a question not answered or withdrawn: "in progress". */
function isOpenWork(node: OutlineNode): boolean {
	if (node.task) return OPEN_TASK.has(node.task.status);
	return !!node.ask && !node.ask.answer && !node.ask.withdrawn;
}

function questionMark(ask: OutlineAskJson): OutlineQuestionMark {
	return {
		state: ask.withdrawn ? "withdrawn" : ask.answer ? "answered" : "open",
		proceed: ask.proceed === true,
	};
}

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
	/** Whether the viewer may read a session (locks name it by title only then, review S-5). */
	narratorVisible?: (narratorId: string) => Promise<boolean>;
	/**
	 * Leave out what is behind closed rows (see the module header): the reader's stored folding
	 * of the page the block is on (both sets empty for a reader who never folded it).
	 */
	fold?: (pageId: string) => Promise<{ expanded: readonly string[]; collapsed: readonly string[] }>;
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

	const pendingRows = state.current
		? await store.listOpenPendingByPage(state.pageId, OUTLINE_PENDING_LIMITS.openPerPage)
		: [];
	// What waits: the blocks a change targets. What is marked: those, and the blocks a change
	// adds blocks under (review N-3; a proposed step's parent does not wait, decision 20).
	const pendingOf = new Map<string, string[]>();
	const markedOf = new Map<string, string[]>();
	const mark = (map: Map<string, string[]>, id: string, rowId: string) => {
		const list = map.get(id) ?? [];
		if (!list.includes(rowId)) map.set(id, [...list, rowId]);
	};
	for (const row of pendingRows) {
		for (const id of row.blockIdsJson) {
			mark(pendingOf, id, row.id);
			mark(markedOf, id, row.id);
		}
		for (const add of row.addsJson) if (add.parentId) mark(markedOf, add.parentId, row.id);
	}

	// What the read may show: the whole view, or (folded) the view without what closed rows hide.
	const folded = new Map<OutlineNode, { kids: number; size: number }>();
	let reach = order;
	if (request.fold) {
		reach = foldedOrder({
			root,
			kids,
			size,
			nodes: state.nodes,
			rootDetail: path.some((node) => node.task !== null || isOutlineReportBlockId(node.id)),
			view: await request.fold(state.pageId),
			marked: markedOf,
			folded,
		});
	}
	const candidates = reach.slice(0, budget.blocks);
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

	// The open tasks under each shown block (the "in progress" marker), with their titles.
	const inProgressOf = new Map<OutlineNode, OutlineNode[]>();
	const listed: OutlineNode[] = [];
	for (const node of shown) {
		const room = IN_PROGRESS_TITLES - listed.length;
		if (room <= 0) break;
		const open = node.children.filter(isOpenWork);
		// Past the titles a view loads, a marker lists what fits (the client says how many more).
		const take = open.slice(0, Math.min(OUTLINE_PENDING_API_LIMITS.inProgressItems, room));
		inProgressOf.set(node, take);
		listed.push(...take);
	}
	await loadBodies(state, listed, { store });
	const locks = await describeLocks(
		shown.flatMap((node) => (node.task?.lock ? [{ blockId: node.id, lock: node.task.lock }] : [])),
		{ narratorVisible: request.narratorVisible },
	);

	// Who wrote each subagent report shown (its container line says it), for a reader who may
	// read that session.
	const reportFrom = await readReportAuthors(
		state.space.id,
		shown.filter((node) => isOutlineReportBlockId(node.id)),
		{ narratorVisible: request.narratorVisible, store },
	);

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
			if (isOpenWork(child)) openTasks++;
			if (view === "facts" && isProcessNode(child)) processHidden += countSubtree(child);
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
			question: node.ask ? questionMark(node.ask) : null,
			alias: node.alias,
			tags: node.tags ?? [],
			childIds,
			hidden,
			processHidden,
			openTasks,
			inProgress: (inProgressOf.get(node) ?? []).map(
				(task): OutlineInProgressItem => ({
					id: task.id,
					sid: task.sid,
					title: shortTitle(task.content ?? ""),
					status: task.task?.status ?? "todo",
					assignee: task.task?.assignee ?? null,
					waiting: pendingOf.has(task.id),
					...(task.ask ? { question: true } : {}),
				}),
			),
			lock: locks.get(node.id) ?? null,
			pending: markedOf.get(node.id) ?? [],
			...(reportFrom.has(node.id) ? { reportFrom: reportFrom.get(node.id) } : {}),
			...(folded.has(node) ? { fold: folded.get(node) } : {}),
		};
	});
	if (view === "facts") {
		for (const node of order) {
			for (const child of node.children)
				if (isProcessNode(child)) hiddenByView += countSubtree(child);
		}
	}
	return {
		pageId: state.pageId,
		rootId: root.id,
		seq: state.seq,
		current: state.current,
		view,
		rootInTask: path.some(
			(node) => node.task !== null || isOutlineReportContainer(node.id, node.content ?? ""),
		),
		path: path.map((node) => ({
			id: node.id,
			sid: node.sid,
			title: shortTitle(node.content ?? ""),
		})),
		blocks,
		hiddenByBudget: reach.length - shown.length,
		hiddenByView,
		...(request.fold ? { hiddenByFold: (size.get(root) ?? 1) - reach.length } : {}),
		pageTruncated: state.truncated,
		pageBlocks: state.nodes.size,
	};
}

/**
 * The view's blocks a folded read may show, the root first, breadth first: every block whose
 * ancestors are open, and under a closed row only what its preview line is read from. `folded`
 * gets every block some of whose children were left out. Pure: one walk of the page's tree.
 */
function foldedOrder(input: {
	root: OutlineNode;
	kids: ReadonlyMap<OutlineNode, OutlineNode[]>;
	size: ReadonlyMap<OutlineNode, number>;
	nodes: ReadonlyMap<string, OutlineNode>;
	rootDetail: boolean;
	view: { expanded: readonly string[]; collapsed: readonly string[] };
	marked: ReadonlyMap<string, unknown>;
	folded: Map<OutlineNode, { kids: number; size: number }>;
}): OutlineNode[] {
	const { root, kids, nodes } = input;
	const node = (id: string) => nodes.get(id);
	const childrenOf = (id: string) => {
		const at = node(id);
		return at ? (kids.get(at) ?? []) : [];
	};
	const foldView: FoldView = {
		expanded: new Set(input.view.expanded),
		collapsed: new Set(input.view.collapsed),
	};
	const tree = buildFoldTree(
		{
			children: (id) => childrenOf(id).map((child) => child.id),
			task: (id) => node(id)?.task?.status ?? null,
			// By id only (content is not read yet): a row the client alone takes for a report is
			// read whole and folded there.
			report: (id) => isOutlineReportBlockId(id),
			marks: (id) => {
				const at = node(id);
				if (!at) return null;
				const question = at.ask && !at.ask.answer && !at.ask.withdrawn ? 1 : 0;
				const pending = input.marked.has(id) ? 1 : 0;
				const locked = at.task?.lock ? 1 : 0;
				return question || pending || locked ? { question, pending, locked } : null;
			},
		},
		{ rootId: root.id, rootDetail: input.rootDetail },
		foldView,
	);
	// What is taken of each block's children: all of them, the first only, or none.
	const take = new Map<OutlineNode, "first" | "none">();
	const out: OutlineNode[] = [root];
	for (let i = 0; i < out.length; i++) {
		const at = out[i] as OutlineNode;
		const all = kids.get(at) ?? [];
		if (all.length === 0) continue;
		const mode = take.get(at);
		const fold = tree.nodes.get(at.id);
		let picked: OutlineNode[];
		if (mode === "none") picked = [];
		else if (mode === "first") {
			picked = all.slice(0, 1);
			for (const child of picked) take.set(child, "none");
		} else if (!fold || fold.open || fold.under !== null) {
			// Open, or closed over something nobody must miss: read whole.
			picked = all;
		} else {
			// Closed: what its one preview line is read from (`foldPreview`).
			const first = all[0] as OutlineNode;
			if (fold.report) {
				// A report's first paragraph: under its first block when that is a heading.
				picked = [first];
				take.set(first, "first");
			} else {
				const done = fold.task === "done" || fold.task === "cancelled";
				const note = done
					? all.find((child) => child.task === null && !isOutlineReportBlockId(child.id))
					: undefined;
				picked = [note ?? first];
				take.set(picked[0] as OutlineNode, "none");
			}
		}
		if (picked.length < all.length) {
			input.folded.set(at, { kids: all.length, size: (input.size.get(at) ?? 1) - 1 });
		}
		out.push(...picked);
	}
	return out;
}

/** Titles of listed tasks one view loads at most (the rest of the markers show counts only). */
const IN_PROGRESS_TITLES = 200;

/**
 * Locks as the client shows them, with the names of the people and sessions they name: a
 * session by title only when `narratorVisible` says the viewer may read it (review S-5; without
 * it, never). `canUnlock` is the caller's to decide (the routes know the person); false here.
 */
export async function describeLocks(
	locks: ReadonlyArray<{ blockId: string; lock: OutlineTaskLockJson }>,
	options: { narratorVisible?: (narratorId: string) => Promise<boolean> } = {},
): Promise<Map<string, OutlineLockView>> {
	const out = new Map<string, OutlineLockView>();
	if (locks.length === 0) return out;
	const found = await readDisplayNames({
		userIds: locks.flatMap((l) => (l.lock.by.kind === "human" ? [l.lock.by.id] : [])),
		narratorIds: locks.flatMap((l) => [
			...(l.lock.by.kind === "agent" ? [l.lock.by.id] : []),
			...(l.lock.delegate ? [l.lock.delegate] : []),
		]),
	});
	const titles = new Map<string, string | null>();
	for (const [id, title] of found.narrators) {
		const visible = title !== null && (await options.narratorVisible?.(id)) === true;
		titles.set(id, visible ? title : null);
	}
	const names = { users: found.users, narrators: titles };
	for (const { blockId, lock } of locks) {
		out.set(blockId, {
			blockId,
			by: {
				kind: lock.by.kind,
				id: lock.by.id,
				name:
					lock.by.kind === "human"
						? (names.users.get(lock.by.id) ?? null)
						: (names.narrators.get(lock.by.id) ?? null),
			},
			delegate: lock.delegate
				? { narratorId: lock.delegate, title: names.narrators.get(lock.delegate) ?? null }
				: null,
			versionSeq: lock.versionSeq,
			canUnlock: false,
		});
	}
	return out;
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
	[OUTLINE_CHANGE.MERGE, "merge"],
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
