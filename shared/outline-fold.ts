/**
 * What an outline page shows open and what it folds, before the reader touches anything (task
 * tree readability, PR C), and how the reader's own folding changes that. One model for the three
 * views of a page: the read-only tree, the live editor and the mind map.
 *
 *   The page title                                   the root: always open
 *     ▾ ◐ A task in progress                         an open task shows its direct children
 *         ▸ • A note                                 … each closed behind ONE preview line
 *               The first line of what is under it…  2 more ▸
 *         ▸ • Subagent report · 17:38 · from scout   a report: one line of its first paragraph
 *               What the report concluded…           Show all (27 blocks) ▸
 *     ▸ ✓ A finished task                            done or cancelled: its title and one line
 *           The result, as its first note says it…   3 more ▸
 *     ▾ • A fact                                     facts (nothing under a task) stay open
 *
 * THE DEFAULT ({@link foldDefaultOpen})
 * -----------------------------------
 *   - the root (the page, or the block focused as one) is open;
 *   - a task to do or in progress is open: its direct children show;
 *   - a task done or cancelled is closed: its title, and one line of its result;
 *   - a subagent report's container is closed: one line of its summary;
 *   - any other block under a task or inside a report (a DETAIL) is closed: one preview line;
 *   - any other block (a fact) is open, as before;
 *   - whatever it is, a block with a question waiting for an answer somewhere under it is open:
 *     an unanswered question is never folded away by default.
 *
 * THE READER'S VIEW ({@link FoldView})
 * -----------------------------------
 * Two sets of block ids, personal and stored per page (`outline_view_state`): what the reader
 * opened that is closed by default (`expanded`), and what they closed that is open by default
 * (`collapsed`). A block in neither follows the default, so a task that gets done later closes by
 * itself, and one the reader opened stays open. {@link applyFoldAction} keeps the sets minimal: a
 * block put back to its default leaves both.
 *
 * The same controls as an outline plan's card (`outline-plan-tree.ts`): the arrow flips one node;
 * a preview line, the row's quick control and Alt on the arrow open everything inside a node, or
 * return it to the default view; the page's own control does that for the whole page.
 *
 * WHAT A CLOSED ROW STILL SAYS
 * ----------------------------
 * A closed row counts what it hides that someone must not miss ({@link FoldMarks}): questions
 * waiting for an answer, changes waiting for confirmation, locks, tasks finished since the reader
 * last looked. Each hidden mark is counted on exactly one row: its nearest visible ancestor.
 *
 * Pure: no DOM, no server imports. Every pass is one walk of the tree (a page read holds at most
 * 2000 blocks), on an explicit stack.
 */

export type FoldTask = "todo" | "doing" | "done" | "cancelled";

/** What a closed row counts of what it hides. */
export interface FoldMarks {
	/** Questions put to a person, not answered yet. */
	question: number;
	/** Blocks a change waiting for confirmation touches. */
	pending: number;
	/** Locked tasks. */
	locked: number;
	/** Tasks finished since the reader last looked. */
	fresh: number;
}

export const FOLD_MARK_KEYS = ["question", "pending", "locked", "fresh"] as const;
export type FoldMarkKey = (typeof FOLD_MARK_KEYS)[number];

/** The tree a view folds: what it shows, by id. */
export interface FoldSource {
	/** The block's children in this view, in sibling order (none for an unknown id). */
	children(id: string): readonly string[];
	task(id: string): FoldTask | null;
	/** A subagent report's container. */
	report(id: string): boolean;
	/** A heading: a report's summary is what stands under its first heading. */
	heading?(id: string): boolean;
	/** The block's own marks (see {@link FoldMarks}); null or absent: none. */
	marks?(id: string): Partial<FoldMarks> | null | undefined;
}

/** The reader's own folding of a page. */
export interface FoldView {
	/** Opened by the reader: closed by default. */
	expanded: ReadonlySet<string>;
	/** Closed by the reader: open by default. */
	collapsed: ReadonlySet<string>;
}

/** {@link FoldView} as its owner changes it. */
export interface MutableFoldView {
	expanded: Set<string>;
	collapsed: Set<string>;
}

export const DEFAULT_FOLD_VIEW: FoldView = Object.freeze({
	expanded: new Set<string>(),
	collapsed: new Set<string>(),
});

/** Ids both sets hold together at most (`OUTLINE_VIEW_STATE_LIMITS.maxCollapsed`). */
export const FOLD_VIEW_MAX_IDS = 2000;
/** Depth past which a tree is not walked (a cycle in bad data; the editor's own guard is 100). */
const MAX_DEPTH = 200;
/** Characters of a preview line (one visual line shows far fewer). */
export const FOLD_PREVIEW_CHARS = 240;

/**
 * Whether a block shows its children before the reader changed anything.
 * `detail`: an ancestor is a task or a report container.
 */
export function foldDefaultOpen(block: {
	root: boolean;
	task: FoldTask | null;
	report: boolean;
	detail: boolean;
}): boolean {
	if (block.root) return true;
	if (block.report) return false;
	if (block.task) return block.task === "todo" || block.task === "doing";
	return !block.detail;
}

export interface FoldNode {
	id: string;
	/** Null for the root. */
	parent: string | null;
	/** 0 for the root. */
	depth: number;
	kids: readonly string[];
	task: FoldTask | null;
	report: boolean;
	/** Under a task or inside a report. */
	detail: boolean;
	defaultOpen: boolean;
	/** Shows its children now (false for a block without any). */
	open: boolean;
	/** Every ancestor is open: the block is on screen. */
	visible: boolean;
	/** Blocks under it, all levels. */
	size: number;
	/** Every block with children in its subtree (itself included) is open now. */
	allOpen: boolean;
	/** … and by default. */
	defaultAllOpen: boolean;
	/** The marks of the blocks under it (not its own); null: none. */
	under: FoldMarks | null;
}

/** A page's tree with its folding worked out. */
export interface FoldTree {
	rootId: string;
	nodes: ReadonlyMap<string, FoldNode>;
	/** Every block from the root, in document order. */
	order: readonly string[];
}

export interface FoldTreeOptions {
	rootId: string;
	/** The root itself is under a task or inside a report (its ancestors are not in the view). */
	rootDetail?: boolean;
	/**
	 * Blocks that must stay on screen whatever the folding says (the block an input method is
	 * composing in): their ancestors are open in this tree, and nothing is stored for it.
	 */
	pinned?: Iterable<string>;
}

function addMarks(into: FoldMarks | null, from: Partial<FoldMarks> | null | undefined) {
	if (!from) return into;
	let out = into;
	for (const key of FOLD_MARK_KEYS) {
		const n = from[key];
		if (!n || n <= 0) continue;
		out ??= { question: 0, pending: 0, locked: 0, fresh: 0 };
		out[key] += n;
	}
	return out;
}

/** The tree under `rootId` with what is open in `view`: two walks down and two back up. */
export function buildFoldTree(
	source: FoldSource,
	options: FoldTreeOptions,
	view: FoldView = DEFAULT_FOLD_VIEW,
): FoldTree {
	const nodes = new Map<string, FoldNode>();
	const order: string[] = [];
	const stack: Array<{ id: string; parent: FoldNode | null }> = [
		{ id: options.rootId, parent: null },
	];
	// Down: the structure, and what each block is.
	while (stack.length > 0) {
		const { id, parent } = stack.pop() as { id: string; parent: FoldNode | null };
		// A block reached twice (bad data) is shown once.
		if (nodes.has(id)) continue;
		const depth = parent ? parent.depth + 1 : 0;
		const kids = depth >= MAX_DEPTH ? [] : source.children(id);
		const task = source.task(id);
		const report = source.report(id);
		const detail = parent
			? parent.detail || parent.task !== null || parent.report
			: options.rootDetail === true;
		const node: FoldNode = {
			id,
			parent: parent?.id ?? null,
			depth,
			kids,
			task,
			report,
			detail,
			defaultOpen: foldDefaultOpen({ root: parent === null, task, report, detail }),
			open: false,
			visible: true,
			size: 0,
			allOpen: true,
			defaultAllOpen: true,
			under: null,
		};
		nodes.set(id, node);
		order.push(id);
		for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: kids[i] as string, parent: node });
	}
	// Up: how much is under each block, and the marks of it.
	for (let i = order.length - 1; i >= 0; i--) {
		const node = nodes.get(order[i] as string) as FoldNode;
		if (node.parent === null) continue;
		const parent = nodes.get(node.parent) as FoldNode;
		parent.size += node.size + 1;
		parent.under = addMarks(addMarks(parent.under, node.under), source.marks?.(node.id));
	}
	const forced = new Set<string>();
	for (const id of options.pinned ?? []) {
		for (let at = nodes.get(id)?.parent ?? null; at !== null; at = nodes.get(at)?.parent ?? null)
			forced.add(at);
	}
	// Down again (parents come before their children in `order`): what is open and on screen.
	for (const id of order) {
		const node = nodes.get(id) as FoldNode;
		const parent = node.parent === null ? null : (nodes.get(node.parent) as FoldNode);
		// A question waiting for an answer is never folded away by default: the blocks above it
		// are open until the reader closes them (then the closed row counts it).
		if ((node.under?.question ?? 0) > 0) node.defaultOpen = true;
		node.open =
			node.kids.length > 0 &&
			(parent === null ||
				forced.has(id) ||
				(view.expanded.has(id) ? true : view.collapsed.has(id) ? false : node.defaultOpen));
		node.visible = parent ? parent.visible && parent.open : true;
	}
	// Up again: whether everything inside each block is open, now and by default.
	for (let i = order.length - 1; i >= 0; i--) {
		const node = nodes.get(order[i] as string) as FoldNode;
		if (node.kids.length > 0) {
			if (!node.open) node.allOpen = false;
			if (!node.defaultOpen) node.defaultAllOpen = false;
		}
		if (node.parent === null) continue;
		const parent = nodes.get(node.parent) as FoldNode;
		if (!node.allOpen) parent.allOpen = false;
		if (!node.defaultAllOpen) parent.defaultAllOpen = false;
	}
	return { rootId: options.rootId, nodes, order };
}

/** What a closed node with children shows in their place: one line. */
export interface FoldPreview {
	/**
	 * `result`: a finished task's first note. `report`: a report's first paragraph. `details`:
	 * the first block under any other closed node.
	 */
	kind: "result" | "report" | "details";
	/** The block whose first line is the preview. */
	textId: string;
	/** Direct children besides the one the line shows (「还有 N 条」). */
	rest: number;
	/** Blocks under the node, all levels (a report's 「展开全文（N 块）」). */
	total: number;
	/**
	 * There is more than the line's block itself (other children, what is under it): the line
	 * always carries its label. Without it, whether the one line fits is the renderer's to say.
	 */
	more: boolean;
}

/**
 * The preview of a closed node, or null: it is open, has no children, or (a finished task) has
 * no note to show — then its title is all there is, and the arrow opens it.
 */
export function foldPreview(tree: FoldTree, source: FoldSource, id: string): FoldPreview | null {
	const node = tree.nodes.get(id);
	if (!node || node.open || node.kids.length === 0) return null;
	const first = node.kids[0] as string;
	if (node.report) {
		// The first paragraph: under the first block when that is a heading with something under it.
		const under = source.heading?.(first) ? tree.nodes.get(first)?.kids[0] : undefined;
		return {
			kind: "report",
			textId: under ?? first,
			rest: node.kids.length - 1,
			total: node.size,
			more: true,
		};
	}
	if (node.task === "done" || node.task === "cancelled") {
		const note = node.kids.find((kid) => !source.task(kid) && !source.report(kid));
		if (note === undefined) return null;
		return {
			kind: "result",
			textId: note,
			rest: node.kids.length - 1,
			total: node.size,
			more: node.size > 1,
		};
	}
	return {
		kind: "details",
		textId: first,
		rest: node.kids.length - 1,
		total: node.size,
		more: node.size > 1,
	};
}

/**
 * The row's quick control for everything inside it: `expand` while something inside is closed,
 * `collapse` (back to the default view inside it) when all of it is open and the default would
 * close some; null when there is nothing to fold inside, and for the root (the page's control).
 */
export function foldSubtreeControl(node: FoldNode): "expand" | "collapse" | null {
	if (node.parent === null || node.kids.length === 0) return null;
	if (!node.allOpen) return "expand";
	return node.defaultAllOpen ? null : "collapse";
}

/** The page's control: 「全部展开」 while something is closed, else 「全部收起」; null: neither. */
export function foldPageControl(tree: FoldTree, view: FoldView): "expand" | "collapse" | null {
	const root = tree.nodes.get(tree.rootId);
	if (!root) return null;
	if (!root.allOpen) return "expand";
	if (!root.defaultAllOpen) return "collapse";
	// Everything is open, as by default; only something stored for these blocks is left to drop.
	return hasOverride(tree, view) ? "collapse" : null;
}

function hasOverride(tree: FoldTree, view: FoldView): boolean {
	if (view.expanded.size === 0 && view.collapsed.size === 0) return false;
	for (const id of tree.order) if (view.expanded.has(id) || view.collapsed.has(id)) return true;
	return false;
}

/**
 * The blocks under `id` that are questions waiting for an answer (what a closed row's question
 * count stands for), in document order: the count opens them.
 */
export function foldQuestionsUnder(tree: FoldTree, source: FoldSource, id: string): string[] {
	const out: string[] = [];
	for (const node of subtreeOf(tree, id)) {
		if (node.id !== id && (source.marks?.(node.id)?.question ?? 0) > 0) out.push(node.id);
	}
	return out;
}

/** What a closed row counts of what it hides, or null. */
export function foldHiddenMarks(node: FoldNode): FoldMarks | null {
	return node.kids.length > 0 && !node.open ? node.under : null;
}

/** A row a view draws. */
export interface FoldRow {
	node: FoldNode;
	/** Depth under the root (the root's children are 0). */
	depth: number;
	preview: FoldPreview | null;
	subtree: "expand" | "collapse" | null;
	/** Marks of what the closed row hides. */
	hidden: FoldMarks | null;
}

/**
 * The rows under the root, in document order: every block whose ancestors are all open, at most
 * `max`. The root is the page's heading, not a row.
 */
export function visibleFoldRows(
	tree: FoldTree,
	source: FoldSource,
	max: number = Number.POSITIVE_INFINITY,
): { rows: FoldRow[]; cut: number } {
	const rows: FoldRow[] = [];
	let cut = 0;
	for (const id of tree.order) {
		const node = tree.nodes.get(id) as FoldNode;
		if (node.parent === null || !node.visible) continue;
		if (rows.length >= max) {
			cut++;
			continue;
		}
		rows.push({
			node,
			depth: node.depth - 1,
			preview: foldPreview(tree, source, id),
			subtree: foldSubtreeControl(node),
			hidden: foldHiddenMarks(node),
		});
	}
	return { rows, cut };
}

export type FoldAction =
	/** Open or close one node (its arrow); without `open`, the one it is not now. */
	| { kind: "node"; id: string; open?: boolean }
	/**
	 * Everything inside one node: all of it open, or back to the default view inside it (the
	 * node included).
	 */
	| { kind: "subtree"; id: string; open: boolean }
	/** The whole page: everything open, or the default view. */
	| { kind: "all"; open: boolean }
	/** Bring a block on screen: open its ancestors. */
	| { kind: "reveal"; id: string }
	/** Close every block with children (the keyboard's "collapse all"). */
	| { kind: "closeAll" }
	/** Open down to a level: blocks at `level` and deeper are closed (the root's children are 1). */
	| { kind: "level"; level: number };

function setOpen(view: MutableFoldView, node: FoldNode, open: boolean): boolean {
	const { expanded, collapsed } = view;
	const before = expanded.has(node.id) ? 1 : collapsed.has(node.id) ? 2 : 0;
	const after = open === node.defaultOpen ? 0 : open ? 1 : 2;
	if (before === after) return false;
	expanded.delete(node.id);
	collapsed.delete(node.id);
	if (after === 1) expanded.add(node.id);
	else if (after === 2) collapsed.add(node.id);
	return true;
}

/** The nodes of `id`'s subtree, itself first. */
function* subtreeOf(tree: FoldTree, id: string): Generator<FoldNode> {
	const top = tree.nodes.get(id);
	if (!top) return;
	const stack = [top];
	while (stack.length > 0) {
		const node = stack.pop() as FoldNode;
		yield node;
		for (let i = node.kids.length - 1; i >= 0; i--) {
			const kid = tree.nodes.get(node.kids[i] as string);
			// A block reached twice hangs under its first parent only.
			if (kid && kid.parent === node.id) stack.push(kid);
		}
	}
}

/**
 * Change the reader's view (`view` itself) by `action`; true when it changed. `tree` is the tree
 * as `view` showed it: the next tree is built from the changed view.
 */
export function applyFoldAction(
	tree: FoldTree,
	view: MutableFoldView,
	action: FoldAction,
): boolean {
	let changed = false;
	switch (action.kind) {
		case "node": {
			const node = tree.nodes.get(action.id);
			if (!node || node.parent === null || node.kids.length === 0) return false;
			return setOpen(view, node, action.open ?? !node.open);
		}
		case "all":
			return applyFoldAction(tree, view, { kind: "subtree", id: tree.rootId, open: action.open });
		case "subtree":
			for (const node of subtreeOf(tree, action.id)) {
				if (node.parent === null) continue;
				if (action.open) {
					if (node.kids.length > 0 && setOpen(view, node, true)) changed = true;
				} else if (view.expanded.delete(node.id) || view.collapsed.delete(node.id)) {
					// (`||`: a block is never in both.)
					changed = true;
				}
			}
			return changed;
		case "reveal":
			for (let at = tree.nodes.get(action.id)?.parent ?? null; at !== null; ) {
				const node = tree.nodes.get(at) as FoldNode;
				if (node.parent !== null && setOpen(view, node, true)) changed = true;
				at = node.parent;
			}
			return changed;
		case "closeAll":
		case "level": {
			const level = action.kind === "level" ? action.level : 1;
			for (const node of subtreeOf(tree, tree.rootId)) {
				if (node.parent === null) continue;
				// A block without children keeps nothing stored.
				const open = node.kids.length > 0 ? node.depth < level : node.defaultOpen;
				if (setOpen(view, node, open)) changed = true;
			}
			return changed;
		}
	}
}

/** A block's first line as a preview shows it: plain text, bounded. */
export function foldPreviewLine(firstLine: string): string {
	const flat = firstLine.replace(/\s+/g, " ").trim();
	if (flat.length <= FOLD_PREVIEW_CHARS) return flat;
	return `${Array.from(flat.slice(0, FOLD_PREVIEW_CHARS)).slice(0, -1).join("")}…`;
}

/** The ids a view stores, within the limit both sets share: what the reader opened first. */
export function boundedFoldView(
	view: FoldView,
	max: number = FOLD_VIEW_MAX_IDS,
): {
	expanded: string[];
	collapsed: string[];
} {
	const expanded = [...view.expanded].slice(0, max);
	const taken = new Set(expanded);
	const collapsed: string[] = [];
	for (const id of view.collapsed) {
		if (expanded.length + collapsed.length >= max) break;
		if (!taken.has(id)) collapsed.push(id);
	}
	return { expanded, collapsed };
}
