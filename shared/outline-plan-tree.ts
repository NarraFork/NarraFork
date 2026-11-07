/**
 * An outline plan as a person reads it (plan readability, after outline P2 PR 8): the tree its
 * markdown rendering is (ExitPlanMode's `input.plan`, the plan's `OutlineRead` snapshot), shown
 * as an overview — the root and the TWO levels under it (phases and their tasks, say), deeper
 * levels folded with their child count — that the reader opens node by node, or all at once.
 * Long block text is clamped to {@link PLAN_TREE_CLAMP_LINES} lines in the overview and opens on
 * a click, so a plan written before its layout was enforced (the goal and the acceptance in one
 * root paragraph) reads too.
 *
 * WHAT IS OPEN
 * ------------
 * A node is open (its children shown) when its depth is below {@link PLAN_TREE_OPEN_DEPTH} (the
 * root is depth 0), so depths 0, 1 and 2 show by default. The reader's view
 * ({@link PlanTreeView}) flips single nodes and texts away from that default, or turns
 * everything open and whole (`all`, 「全部展开」); 「全部收起」 returns to the overview. Nodes are
 * named by their index path (`r`, `r.0`, `r.0.2`): a card's plan is a snapshot that never
 * changes, so the path is a stable identity for it.
 *
 * Pure: no DOM. The tool card (vlist, measured arithmetically) and the DOM views (the inbox)
 * both draw from it.
 */
import { parseBlock } from "./outline/dialect";
import type { Inline, Mark, TaskStatus } from "./outline/dialect/types";
import { type OutlineItem, parseMarkdownOutline } from "./outline/md-outline";

/** Nodes shallower than this are open by default: the root and two levels under it show. */
export const PLAN_TREE_OPEN_DEPTH = 2;
/** Lines a block's text shows in the overview before it is clamped (a click shows it whole). */
export const PLAN_TREE_CLAMP_LINES = 2;
/** Rows one view draws at most (a plan has at most 2000 blocks; the rest are counted). */
export const PLAN_TREE_MAX_ROWS = 600;
/** Code lines one block shows at most. */
const CODE_LINES_MAX = 40;
/** Plans parsed and kept (by their text): one per visible ExitPlanMode card, a few cards. */
const CACHE_MAX = 24;

/** A run of a block's text and how it is marked. */
export interface PlanTreeRun {
	text: string;
	strong?: boolean;
	em?: boolean;
	code?: boolean;
	strike?: boolean;
	/** A link or a reference to another block: drawn as one, not followed. */
	link?: boolean;
}

/** One hard line of a block's text. `dim`: a property (`depends::`, `due::`), not its words. */
export interface PlanTreeLine {
	runs: PlanTreeRun[];
	tone?: "dim" | "code";
}

export interface PlanTreeNode {
	/** Index path: `r` for the root, `r.0` for its first child. */
	key: string;
	depth: number;
	task: TaskStatus | null;
	/** A heading block (drawn strong). */
	heading?: boolean;
	/** The block's text by hard line, then its properties; never empty (one empty line at least). */
	lines: PlanTreeLine[];
	/** The text as plain characters, lines joined with newlines (a tooltip, a copy). */
	plain: string;
	children: PlanTreeNode[];
}

export interface PlanTree {
	root: PlanTreeNode;
	/** Nodes, the root included. */
	size: number;
	/** Some node is folded in the overview (it sits at the open depth and has children). */
	folds: boolean;
}

/** Which nodes and texts the reader flipped away from the overview. */
export interface PlanTreeView {
	/** 「全部展开」: every node open and every text whole (flips then count from that). */
	all: boolean;
	/** Nodes whose fold the reader flipped. */
	nodes: ReadonlySet<string>;
	/** Texts the reader flipped (clamped ↔ whole). */
	texts: ReadonlySet<string>;
}

export const DEFAULT_PLAN_TREE_VIEW: PlanTreeView = Object.freeze({
	all: false,
	nodes: new Set<string>(),
	texts: new Set<string>(),
});

export type PlanTreeAction =
	| { kind: "node"; key: string }
	| { kind: "text"; key: string }
	/** 「全部展开」 from any view; 「全部收起」 (back to the overview) from `all`. */
	| { kind: "all" };

/** The reader's view after `action`. */
export function applyPlanTreeAction(view: PlanTreeView, action: PlanTreeAction): PlanTreeView {
	if (action.kind === "all")
		return view.all ? DEFAULT_PLAN_TREE_VIEW : { all: true, nodes: new Set(), texts: new Set() };
	const field = action.kind === "node" ? "nodes" : "texts";
	const next = new Set(view[field]);
	if (next.has(action.key)) next.delete(action.key);
	else next.add(action.key);
	return { ...view, [field]: next };
}

/** Whether the view is the overview (nothing flipped). */
export function isDefaultPlanTreeView(view: PlanTreeView): boolean {
	return !view.all && view.nodes.size === 0 && view.texts.size === 0;
}

/** A short identity of the view (a cache key's part; empty for the overview). */
export function planTreeViewSignature(view: PlanTreeView): string {
	if (isDefaultPlanTreeView(view)) return "";
	return `${view.all ? "a" : "d"}|${[...view.nodes].sort().join(",")}|${[...view.texts].sort().join(",")}`;
}

/** Whether `node` shows its children in `view`. */
export function isPlanNodeOpen(node: PlanTreeNode, view: PlanTreeView): boolean {
	if (node.children.length === 0) return false;
	const base = view.all || node.depth < PLAN_TREE_OPEN_DEPTH;
	return view.nodes.has(node.key) ? !base : base;
}

/** Whether `node`'s text shows whole (not clamped) in `view`. */
export function isPlanTextWhole(node: PlanTreeNode, view: PlanTreeView): boolean {
	return view.texts.has(node.key) ? !view.all : view.all;
}

/** A row the view draws: a node, whether it is open, whether its text shows whole. */
export interface PlanTreeRow {
	node: PlanTreeNode;
	open: boolean;
	whole: boolean;
}

/**
 * The rows `view` draws, in document order: every node whose ancestors are all open, at most
 * `max`. `cut` counts the rows past it.
 */
export function visiblePlanRows(
	tree: PlanTree,
	view: PlanTreeView,
	max: number = PLAN_TREE_MAX_ROWS,
): { rows: PlanTreeRow[]; cut: number } {
	const rows: PlanTreeRow[] = [];
	let cut = 0;
	const stack: PlanTreeNode[] = [tree.root];
	while (stack.length > 0) {
		const node = stack.pop() as PlanTreeNode;
		const open = isPlanNodeOpen(node, view);
		if (rows.length < max) rows.push({ node, open, whole: isPlanTextWhole(node, view) });
		else cut++;
		if (!open) continue;
		for (let i = node.children.length - 1; i >= 0; i--)
			stack.push(node.children[i] as PlanTreeNode);
	}
	return { rows, cut };
}

/** Nodes under `node` (not counting it). */
export function planDescendants(node: PlanTreeNode): number {
	let count = 0;
	const stack = [...node.children];
	while (stack.length > 0) {
		const next = stack.pop() as PlanTreeNode;
		count++;
		for (const child of next.children) stack.push(child);
	}
	return count;
}

// ─── Parsing ───

const ANNOTATION_LINE = /^[ \t]*‹[^›\n]*›[ \t]*$/;

const cache = new Map<string, PlanTree | null>();

/**
 * The plan tree of an outline plan's markdown rendering, or null when it is not one tree (a
 * plan file's prose, an empty text): the caller then shows the markdown as before. Kept by text,
 * so a card's rebuilds reuse one tree (and what is measured against its nodes).
 */
export function parsePlanTree(markdown: string): PlanTree | null {
	const hit = cache.get(markdown);
	if (hit !== undefined) {
		// Most recently used last.
		cache.delete(markdown);
		cache.set(markdown, hit);
		return hit;
	}
	const tree = buildPlanTree(markdown);
	cache.set(markdown, tree);
	if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
	return tree;
}

function buildPlanTree(markdown: string): PlanTree | null {
	const text = markdown
		.split("\n")
		.filter((line) => !ANNOTATION_LINE.test(line))
		.join("\n");
	if (!/^\s*[-*+]\s/.test(text)) return null;
	const { items } = parseMarkdownOutline(text);
	if (items.length !== 1) return null;
	let size = 0;
	let folds = false;
	const build = (item: OutlineItem, key: string, depth: number): PlanTreeNode => {
		size++;
		if (depth === PLAN_TREE_OPEN_DEPTH && item.children.length > 0) folds = true;
		const { lines, heading } = itemLines(item);
		return {
			key,
			depth,
			task: item.task?.status ?? null,
			...(heading ? { heading: true } : {}),
			lines,
			plain: lines.map((line) => line.runs.map((run) => run.text).join("")).join("\n"),
			children: item.children.map((child, i) => build(child, `${key}.${i}`, depth + 1)),
		};
	};
	const root = build(items[0] as OutlineItem, "r", 0);
	return { root, size, folds };
}

function marked(text: string, marks: readonly Mark[]): PlanTreeRun {
	const run: PlanTreeRun = { text };
	for (const mark of marks) {
		if (mark.type === "strong") run.strong = true;
		else if (mark.type === "em") run.em = true;
		else if (mark.type === "code") run.code = true;
		else if (mark.type === "strike") run.strike = true;
		else if (mark.type === "link") run.link = true;
	}
	return run;
}

/** Inline content split at its hard breaks, adjacent runs of the same marks merged. */
function inlineLines(content: readonly Inline[]): PlanTreeLine[] {
	const lines: PlanTreeLine[] = [{ runs: [] }];
	for (const node of content) {
		const line = lines[lines.length - 1] as PlanTreeLine;
		if (node.type === "br") {
			lines.push({ runs: [] });
			continue;
		}
		const run =
			node.type === "mention"
				? { ...marked(node.label ?? node.ref, node.marks), link: true }
				: marked(node.text, node.marks);
		const last = line.runs[line.runs.length - 1];
		if (last && sameMarks(last, run)) last.text += run.text;
		else if (run.text) line.runs.push(run);
	}
	return lines;
}

function sameMarks(a: PlanTreeRun, b: PlanTreeRun): boolean {
	return (
		!!a.strong === !!b.strong &&
		!!a.em === !!b.em &&
		!!a.code === !!b.code &&
		!!a.strike === !!b.strike &&
		!!a.link === !!b.link
	);
}

function itemLines(item: OutlineItem): { lines: PlanTreeLine[]; heading: boolean } {
	const { body } = parseBlock(item.content);
	let lines: PlanTreeLine[];
	let heading = false;
	switch (body.type) {
		case "paragraph":
		case "quote":
			lines = inlineLines(body.content);
			break;
		case "heading":
			heading = true;
			lines = inlineLines(body.content);
			break;
		case "code": {
			const code = body.text.split("\n");
			lines = code.slice(0, CODE_LINES_MAX).map((text) => ({
				runs: text ? [{ text, code: true }] : [],
				tone: "code" as const,
			}));
			if (code.length > CODE_LINES_MAX) lines.push({ runs: [{ text: "…" }], tone: "dim" });
			break;
		}
		case "table":
			lines = body.rows.map((row) => ({
				runs: [
					{
						text: row
							.map((cell) =>
								inlineLines(cell)
									.flatMap((line) => line.runs.map((r) => r.text))
									.join(""),
							)
							.join(" │ "),
					},
				],
			}));
			break;
		case "embed":
			lines = [{ runs: [{ text: body.label ?? body.ref, link: true }] }];
			break;
	}
	if (lines.length === 0) lines = [{ runs: [] }];
	// The assignee and the properties, as the outline writes them: what the step depends on, when.
	const first = lines[0] as PlanTreeLine;
	if (item.task?.assignee) first.runs.push({ text: ` @${item.task.assignee}`, link: true });
	const props = item.props;
	const targets = (list: typeof props.depends) =>
		(list ?? []).map((link) => link.label ?? link.target).join(", ");
	if (props.depends?.length)
		lines.push({ runs: [{ text: `depends:: ${targets(props.depends)}` }], tone: "dim" });
	if (props.due) lines.push({ runs: [{ text: `due:: ${props.due}` }], tone: "dim" });
	if (props.tags?.length)
		lines.push({ runs: [{ text: `tags:: ${targets(props.tags)}` }], tone: "dim" });
	return { lines, heading };
}

/** Drop the parsed plans (tests). */
export function resetPlanTreeCacheForTest(): void {
	cache.clear();
}
