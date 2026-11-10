/**
 * An outline plan as a person reads it (plan readability, after outline P2 PR 8): the tree its
 * markdown rendering is (ExitPlanMode's `input.plan`, the plan's `OutlineRead` snapshot), in the
 * plan format (`outline-plan-structure.ts`):
 *
 *   ☐ The title                                   the root, always shown
 *       The background paragraph, whole           the root's first block, never folded
 *     ▾ ☐ A big point                             depth 1: open
 *         ▸ ☐ A small point                       depth 2: shown, its details folded …
 *               The first line of its first de…  3 more ▸   … behind ONE preview line
 *     ▾ • Notable points                          its items shown whole
 *           • A risk
 *
 * WHAT IS OPEN
 * ------------
 * By default a node is open (its children shown) when its depth is below
 * {@link PLAN_TREE_OPEN_DEPTH}: the root and the big points. A closed node with children shows
 * one PREVIEW line instead of them — its first child's first line and how many more there are —
 * so a small point's implementation details read as one line until opened. The texts of the
 * title and the points are clamped to {@link PLAN_TREE_CLAMP_LINES} lines (a legacy plan's long
 * root or point); the background, the notable points' items and the details show whole.
 *
 * The reader's view ({@link PlanTreeView}) changes that: a node or a text flipped on its own, or a
 * whole SUBTREE expanded (every node in it open, every text whole: a preview line's click, the
 * row's quick control, Alt+click on the arrow, 「全部展开」 for the root) or returned to the
 * default view inside an expanded one. Nodes are named by their index path (`r`, `r.0`,
 * `r.0.2`): a card's plan is a snapshot that never changes, so the path is a stable identity.
 *
 * Pure: no DOM. The tool card (vlist, measured arithmetically) and the DOM views (the inbox)
 * both draw from it.
 */
import { parseBlock } from "./outline/dialect";
import type { Inline, Mark, TaskStatus } from "./outline/dialect/types";
import { type OutlineItem, parseMarkdownOutline } from "./outline/md-outline";
import {
	isNotablePointsHeading,
	isPlanNoteContent,
	OUTLINE_PLAN_STRUCTURE,
	planBackgroundProblem,
	planBlockText,
	planTextChars,
} from "./outline-plan-structure";

/** Nodes shallower than this are open by default: the root and the big points. */
export const PLAN_TREE_OPEN_DEPTH = 2;
/** Lines the title's and a point's text show before it is clamped (a click shows it whole). */
export const PLAN_TREE_CLAMP_LINES = 3;
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

/**
 * What a node is in the plan format: the root's `title`; the root's first block when it is a
 * paragraph with nothing under it, its `background`; a big or small `point` (depths 1 and 2);
 * the `notable` points section (a big point titled so) and its `notableItem`s; a `detail`
 * (depth 3 and deeper). A plan written before the format gets the same roles by depth.
 */
export type PlanTreeRole = "title" | "background" | "point" | "notable" | "notableItem" | "detail";

export interface PlanTreeNode {
	/** Index path: `r` for the root, `r.0` for its first child. */
	key: string;
	depth: number;
	role: PlanTreeRole;
	task: TaskStatus | null;
	/** A heading block (drawn strong). */
	heading?: boolean;
	/** A question put to a person (`Ask`): never the background. */
	question?: boolean;
	/** The block's text by hard line, then its properties; never empty (one empty line at least). */
	lines: PlanTreeLine[];
	/** The text as plain characters, lines joined with newlines (a tooltip, a copy). */
	plain: string;
	children: PlanTreeNode[];
	/** Something under it is folded by default (a node at or below the open depth has children). */
	folds: boolean;
}

export interface PlanTree {
	root: PlanTreeNode;
	/** Nodes, the root included. */
	size: number;
	/** Something is folded behind a preview line in the default view. */
	folds: boolean;
}

/** How the reader changed the default view. */
export interface PlanTreeView {
	/**
	 * Subtrees the reader expanded (`x`: every node in it open, every text whole) or returned to
	 * the default view inside an expanded one (`d`). The nearest one at or above a node rules it.
	 */
	scopes: ReadonlyMap<string, "x" | "d">;
	/** Nodes whose fold the reader flipped (from what their scope makes it). */
	nodes: ReadonlySet<string>;
	/** Texts the reader flipped, clamped ↔ whole (from what their scope makes it). */
	texts: ReadonlySet<string>;
}

export const DEFAULT_PLAN_TREE_VIEW: PlanTreeView = Object.freeze({
	scopes: new Map<string, "x" | "d">(),
	nodes: new Set<string>(),
	texts: new Set<string>(),
});

/** The root's key: its subtree is the whole plan (「全部展开 / 全部收起」). */
export const PLAN_TREE_ROOT_KEY = "r";

export type PlanTreeAction =
	/** Open or close one node (its arrow). */
	| { kind: "node"; key: string }
	/** Show one text whole or clamped. */
	| { kind: "text"; key: string }
	/**
	 * Everything inside one node: expanded (every node in it open, every text whole), or back to
	 * the default view inside it. `open` says which (what the control showed); without it, the
	 * one it is not now.
	 */
	| { kind: "subtree"; key: string; open?: boolean }
	/** 「全部展开 / 全部收起」: the root's subtree. */
	| { kind: "all"; open?: boolean };

/** Whether `key` is `under` or a node below it. */
function within(key: string, under: string): boolean {
	return key === under || (key.startsWith(under) && key.charCodeAt(under.length) === 46);
}

/** The scope ruling `key`: the nearest one at or above it (`d`, the default view, if none). */
function scopeAt(view: PlanTreeView, key: string, self = true): "x" | "d" {
	if (view.scopes.size === 0) return "d";
	let at = self ? key : parentKey(key);
	while (at !== null) {
		const scope = view.scopes.get(at);
		if (scope) return scope;
		at = parentKey(at);
	}
	return "d";
}

function parentKey(key: string): string | null {
	const dot = key.lastIndexOf(".");
	return dot < 0 ? null : key.slice(0, dot);
}

/**
 * Whether everything inside `key` is expanded: its scope is `x`, no part of it returned to the
 * default view, nothing in it flipped back.
 */
export function isPlanSubtreeExpanded(view: PlanTreeView, key: string): boolean {
	if (scopeAt(view, key) !== "x") return false;
	for (const [at, scope] of view.scopes) if (scope === "d" && within(at, key)) return false;
	for (const flipped of view.nodes) if (within(flipped, key)) return false;
	for (const flipped of view.texts) if (within(flipped, key)) return false;
	return true;
}

/** Whether the whole plan is expanded (「全部收起」 is what its toolbar offers then). */
export function isPlanTreeAllExpanded(view: PlanTreeView): boolean {
	return isPlanSubtreeExpanded(view, PLAN_TREE_ROOT_KEY);
}

/** The reader's view after `action`. */
export function applyPlanTreeAction(view: PlanTreeView, action: PlanTreeAction): PlanTreeView {
	if (action.kind === "all")
		return applyPlanTreeAction(view, {
			kind: "subtree",
			key: PLAN_TREE_ROOT_KEY,
			...(action.open !== undefined ? { open: action.open } : {}),
		});
	if (action.kind === "subtree") {
		const key = action.key;
		const expanded = action.open === undefined ? isPlanSubtreeExpanded(view, key) : !action.open;
		const keep = (k: string) => !within(k, key);
		const scopes = new Map([...view.scopes].filter(([k]) => keep(k)));
		const next: PlanTreeView = {
			scopes,
			nodes: new Set([...view.nodes].filter(keep)),
			texts: new Set([...view.texts].filter(keep)),
		};
		// Nothing in it is flipped now: it follows the nearest scope above it unless that is not
		// what the reader asked for.
		const above = scopeAt(next, key, false);
		if (!expanded && above !== "x") scopes.set(key, "x");
		if (expanded && above === "x") scopes.set(key, "d");
		return next;
	}
	const field = action.kind === "node" ? "nodes" : "texts";
	const flipped = new Set(view[field]);
	if (flipped.has(action.key)) flipped.delete(action.key);
	else flipped.add(action.key);
	return { ...view, [field]: flipped };
}

/** Whether the view is the default one (nothing changed). */
export function isDefaultPlanTreeView(view: PlanTreeView): boolean {
	return view.scopes.size === 0 && view.nodes.size === 0 && view.texts.size === 0;
}

/** A short identity of the view (a cache key's part; empty for the default view). */
export function planTreeViewSignature(view: PlanTreeView): string {
	if (isDefaultPlanTreeView(view)) return "";
	const scopes = [...view.scopes]
		.map(([key, scope]) => `${scope}${key}`)
		.sort()
		.join(",");
	return `${scopes}|${[...view.nodes].sort().join(",")}|${[...view.texts].sort().join(",")}`;
}

/** Whether `node` shows its children in `view` (a closed node with children shows a preview). */
export function isPlanNodeOpen(node: PlanTreeNode, view: PlanTreeView): boolean {
	if (node.children.length === 0) return false;
	const base = scopeAt(view, node.key) === "x" || node.depth < PLAN_TREE_OPEN_DEPTH;
	return view.nodes.has(node.key) ? !base : base;
}

/**
 * Whether `node`'s text is clamped by default (the title, a point, the notable section's title):
 * the background, the notable items and the details always show whole.
 */
export function planTextClamps(node: PlanTreeNode): boolean {
	return node.role === "title" || node.role === "point" || node.role === "notable";
}

/** Whether `node`'s text shows whole (not clamped) in `view`. The background always does. */
export function isPlanTextWhole(node: PlanTreeNode, view: PlanTreeView): boolean {
	if (!planTextClamps(node)) return true;
	const base = scopeAt(view, node.key) === "x";
	return view.texts.has(node.key) ? !base : base;
}

/** What a closed node with children shows in their place: one line of its first child. */
export interface PlanTreePreview {
	first: PlanTreeNode;
	/** Children after the first. */
	rest: number;
	/**
	 * There is more than the first child's first line (other children, its other lines, what is
	 * under it): the preview ends in an ellipsis and its control. Whether the first line itself
	 * fits is the renderer's to say.
	 */
	more: boolean;
}

/** A row the view draws. */
export interface PlanTreeRow {
	node: PlanTreeNode;
	open: boolean;
	whole: boolean;
	/** The node is closed and has children: the line shown in their place. */
	preview: PlanTreePreview | null;
	/**
	 * The row's quick control for everything inside it: `expand`, or `collapse` when it is all
	 * expanded; null for the root (the toolbar's 「全部展开」), the background, and a node with
	 * nothing folded inside.
	 */
	subtree: "expand" | "collapse" | null;
}

/** The quick control `node` shows in `view` (see {@link PlanTreeRow.subtree}). */
export function planSubtreeControl(node: PlanTreeNode, view: PlanTreeView): PlanTreeRow["subtree"] {
	if (node.depth === 0 || !node.folds) return null;
	return isPlanSubtreeExpanded(view, node.key) ? "collapse" : "expand";
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
		const first = node.children[0];
		if (rows.length < max)
			rows.push({
				node,
				open,
				whole: isPlanTextWhole(node, view),
				preview:
					!open && first
						? {
								first,
								rest: node.children.length - 1,
								more:
									node.children.length > 1 || first.children.length > 0 || first.lines.length > 1,
							}
						: null,
				subtree: planSubtreeControl(node, view),
			});
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

/**
 * The notes a read adds on lines of their own, as the server's `isReadAnnotation` knows them
 * (`render.ts`): not blocks. A note's words may hold a `›` themselves (a question's option
 * "Settings › Privacy"), so each is matched by its opening word, up to the line's last `›`.
 */
const NOTE_LINES: readonly RegExp[] = [
	/^‹[^\n]*›[ \t]*$/,
	/^ *‹… \d+ more›[ \t]*$/,
	/^ *‹pending [^\n]*›[ \t]*$/,
	/^ *‹question [^\n]*›[ \t]*$/,
	/^ *‹plan [^\n]*›[ \t]*$/,
];
/** The note under a question put to a person (`Ask`), indented like the block's children. */
const QUESTION_LINE = /^( *)‹question [^\n]*›[ \t]*$/;
/** A block's line: its bullet, indented by its depth. */
const ITEM_LINE = /^( *)(?:[-*+]|\d{1,9}[.)]) /;
/**
 * A code fence opening a line, or right after an item's bullet, its label and its checkbox (as
 * the server's read writes them, `stripReadAnnotations`).
 */
const FENCE = /^ *(?:(?:[-*+]|\d{1,9}[.)]) +(?:\[[^\]\n]*\] +)?(?:\[[ xX/-]\] +)?)?(`{3,}|~{3,})/;
/** Indentation per level of the rendered outline. */
const INDENT = 2;

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

/**
 * The rendering without the read's notes (lines inside code fences left alone), and which blocks
 * are questions put to a person (by their place in document order: the read writes a
 * `‹question …›` note under each).
 */
function readNotes(markdown: string): { text: string; questions: Set<number> } {
	const out: string[] = [];
	const questions = new Set<number>();
	const lastAt = new Map<number, number>();
	let items = -1;
	let fence: { char: string; length: number } | null = null;
	for (const line of markdown.split("\n")) {
		if (fence) {
			const closing = line.trim();
			if (closing[0] === fence.char && closing.length >= fence.length && /^(`+|~+)$/.test(closing))
				fence = null;
			out.push(line);
			continue;
		}
		const item = ITEM_LINE.exec(line);
		if (item) {
			items++;
			lastAt.set((item[1] as string).length, items);
		}
		const run = FENCE.exec(line)?.[1];
		if (run) {
			fence = { char: run[0] as string, length: run.length };
			out.push(line);
			continue;
		}
		if (!NOTE_LINES.some((note) => note.test(line))) {
			out.push(line);
			continue;
		}
		const question = QUESTION_LINE.exec(line);
		if (question) {
			const owner = lastAt.get((question[1] as string).length - INDENT);
			if (owner !== undefined) questions.add(owner);
		}
	}
	return { text: out.join("\n"), questions };
}

/** A legacy plan's first paragraph past this many characters is a point, not the background. */
const BACKGROUND_MAX_CHARS = 2 * OUTLINE_PLAN_STRUCTURE.backgroundChars;

/**
 * The background: the root's first block that is the plan's own (not a question put to a person,
 * not a note for the agent), when it has a background's shape (`planBackgroundProblem`: what
 * is under it but questions does not count) — the submission check's rule. A legacy plan's
 * first paragraph far longer than a background reads as a point (clamped).
 */
function backgroundOf(
	root: OutlineItem,
	isQuestion: (item: OutlineItem) => boolean,
): OutlineItem | null {
	const first = root.children.find(
		(child) => !isQuestion(child) && !isPlanNoteContent(child.content),
	);
	if (!first) return null;
	const problem = planBackgroundProblem({
		content: first.content,
		task: first.task !== null,
		children: first.children.filter((child) => !isQuestion(child)).length,
	});
	if (problem !== null) return null;
	return planTextChars(planBlockText(first.content).text) <= BACKGROUND_MAX_CHARS ? first : null;
}

function buildPlanTree(markdown: string): PlanTree | null {
	const { text, questions } = readNotes(markdown);
	if (!/^\s*[-*+]\s/.test(text)) return null;
	const { items } = parseMarkdownOutline(text);
	if (items.length !== 1) return null;
	const top = items[0] as OutlineItem;
	// Each item's place in document order (what the question notes name).
	const order = new Map<OutlineItem, number>();
	const number = (item: OutlineItem) => {
		order.set(item, order.size);
		for (const child of item.children) number(child);
	};
	number(top);
	const isQuestion = (item: OutlineItem) => questions.has(order.get(item) ?? -1);
	const background = backgroundOf(top, isQuestion);
	let size = 0;
	const build = (
		item: OutlineItem,
		key: string,
		depth: number,
		parent: PlanTreeRole | null,
	): PlanTreeNode => {
		size++;
		const question = isQuestion(item);
		const role: PlanTreeRole =
			depth === 0
				? "title"
				: depth === 1
					? item === background
						? "background"
						: item.task === null && !question && isNotablePointsHeading(item.content)
							? "notable"
							: "point"
					: depth === 2
						? parent === "notable"
							? "notableItem"
							: "point"
						: "detail";
		const { lines, heading } = itemLines(item);
		const children = item.children.map((child, i) => build(child, `${key}.${i}`, depth + 1, role));
		return {
			key,
			depth,
			role,
			task: item.task?.status ?? null,
			...(heading ? { heading: true } : {}),
			...(question ? { question: true } : {}),
			lines,
			plain: lines.map((line) => line.runs.map((run) => run.text).join("")).join("\n"),
			children,
			folds:
				(depth >= PLAN_TREE_OPEN_DEPTH && children.length > 0) ||
				children.some((child) => child.folds),
		};
	};
	const root = build(top, PLAN_TREE_ROOT_KEY, 0, null);
	return { root, size, folds: root.folds };
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
