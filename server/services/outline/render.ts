/**
 * An outline (sub)tree as a markdown outline, within a budget. Pure; no database.
 *
 * BUDGETED BREADTH-FIRST EXPANSION
 * --------------------------------
 * The root is always shown. Then blocks are taken breadth first, a whole level before the next
 * one and each level in document order, while they fit the budget of blocks and UTF-8 bytes. The
 * first block that does not fit ends the expansion, so what is shown is always a prefix of the
 * breadth-first order: the top of the tree is complete before anything deeper appears. Under
 * every shown block whose children are not all shown, one `‹… N more›` line says how many blocks
 * of its subtree are left out (each left-out block is counted once, under its nearest shown
 * ancestor). Those lines are charged to the budget when a block that may need one is shown, so
 * the output stays within the byte budget (only the root may exceed it on its own).
 *
 * FACTS VIEW
 * ----------
 * By default tasks and everything under them are left out (see `tree.ts`), and one line at the end
 * says how many blocks that was. A read whose root is a task, or under one, shows everything.
 *
 * ANNOTATIONS NEVER PARSE BACK AS CONTENT
 * ---------------------------------------
 * The `‹…›` lines are output only. A note about the whole read is written at column 0, where the
 * outline serializer never writes anything but a top-level item; a `‹… N more›` line is indented
 * like the children it stands for. `stripReadAnnotations` removes both (outside code fences), and
 * whoever parses outline text an agent may have copied from a read applies it first.
 *
 * Block labels (an address before each item, say) are a hook: the caller decides their syntax.
 */
import { type OutlineItem, type OutlineProps, serializeMarkdownOutline } from "@shared/outline";
import { OUTLINE_TEXT } from "./messages";
import { effectiveView, type OutlineNode, type OutlineView, viewChildren } from "./tree";

/** Limits of one read. */
export const OUTLINE_READ_LIMITS = {
	/** Blocks one read renders at most. */
	maxBlocks: 2000,
	/** UTF-8 bytes of rendered text one read returns at most. */
	maxBytes: 256 * 1024,
	/** What a read renders unless it asks for more: an agent's default. */
	defaultBudget: { blocks: 80, bytes: 16 * 1024 },
} as const;

export interface OutlineBudget {
	blocks: number;
	bytes: number;
}

/** The budget asked for, defaulted and clamped to the read limits. */
export function clampBudget(budget?: Partial<OutlineBudget>): OutlineBudget {
	const pick = (value: number | undefined, fallback: number, max: number) =>
		value === undefined || !Number.isFinite(value)
			? fallback
			: Math.max(1, Math.min(max, Math.floor(value)));
	return {
		blocks: pick(
			budget?.blocks,
			OUTLINE_READ_LIMITS.defaultBudget.blocks,
			OUTLINE_READ_LIMITS.maxBlocks,
		),
		bytes: pick(
			budget?.bytes,
			OUTLINE_READ_LIMITS.defaultBudget.bytes,
			OUTLINE_READ_LIMITS.maxBytes,
		),
	};
}

/** Text to put before an item (after its bullet); null for none. */
export type OutlineLabel = (node: OutlineNode) => string | null | undefined;

/** The outline item a block renders as, given the one its stored state makes. */
export type OutlineDisplay = (node: OutlineNode, item: OutlineItem) => OutlineItem;

export interface OutlineRenderOptions {
	/** Default `facts`. */
	view?: OutlineView;
	budget?: Partial<OutlineBudget>;
	label?: OutlineLabel;
	/**
	 * What a block renders as, when it differs from its stored state (links shown with their
	 * targets' titles, say). Content must stay canonical dialect markdown.
	 */
	display?: OutlineDisplay;
	/**
	 * The tree was read cut short (a page with more blocks than one read loads): a note says so,
	 * with the number of blocks that were read.
	 */
	truncatedRead?: { blocksRead: number };
}

export interface OutlineRenderResult {
	markdown: string;
	/** The view applied: `all` when the root is a task or under one. */
	view: OutlineView;
	/** Blocks shown, in output order (the root first). */
	blockIds: string[];
	/** Blocks of the view that did not fit the budget. */
	hiddenByBudget: number;
	/** Process blocks the facts view left out. */
	hiddenByView: number;
	/** UTF-8 bytes of `markdown`. */
	bytes: number;
}

const INDENT = "  ";

function utf8(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** The outline item of one block (no children), as the markdown outline format writes it. */
export function outlineItem(node: OutlineNode): OutlineItem {
	const props: OutlineProps = {};
	if (node.task?.depends?.length) props.depends = node.task.depends;
	if (node.task?.due) props.due = node.task.due;
	if (node.alias) props.alias = node.alias;
	if (node.tags?.length) props.tags = node.tags.map((target) => ({ target, label: null }));
	return {
		content: node.content ?? "",
		task: node.task ? { status: node.task.status, assignee: node.task.assignee } : null,
		props,
		children: [],
	};
}

function indented(lines: readonly string[], depth: number): string[] {
	if (depth === 0) return [...lines];
	const pad = INDENT.repeat(depth);
	return lines.map((line) => (line === "" ? "" : pad + line));
}

/** Bytes of lines once joined, counting one newline after each. */
function linesBytes(lines: readonly string[]): number {
	let total = 0;
	for (const line of lines) total += utf8(line) + 1;
	return total;
}

function moreLine(depth: number, hidden: number): string {
	return INDENT.repeat(depth) + OUTLINE_TEXT.more(hidden);
}

/**
 * The subtree of `root` as a markdown outline within the budget. Blocks whose content is not
 * loaded (`content === null`) end the expansion like a block that does not fit.
 */
export function renderOutline(
	root: OutlineNode,
	options: OutlineRenderOptions = {},
): OutlineRenderResult {
	const view = effectiveView(root, options.view ?? "facts");
	const budget = clampBudget(options.budget);
	// Each node's children in the view, computed once (a page may be wide).
	const children = new Map<OutlineNode, OutlineNode[]>();
	const kids = (node: OutlineNode): OutlineNode[] => {
		let list = children.get(node);
		if (!list) {
			list = viewChildren(node, view);
			children.set(node, list);
		}
		return list;
	};

	// Visible subtree sizes (post-order over the breadth-first list) and what the view leaves out.
	const order: OutlineNode[] = [root];
	const depth = new Map<OutlineNode, number>([[root, 0]]);
	for (let i = 0; i < order.length; i++) {
		const node = order[i] as OutlineNode;
		for (const child of kids(node)) {
			depth.set(child, (depth.get(node) ?? 0) + 1);
			order.push(child);
		}
	}
	const size = new Map<OutlineNode, number>();
	let hiddenByView = 0;
	for (let i = order.length - 1; i >= 0; i--) {
		const node = order[i] as OutlineNode;
		let total = 1;
		for (const child of node.children) {
			if (view === "all" || child.task === null) total += size.get(child) ?? 0;
			else hiddenByView += countSubtree(child);
		}
		size.set(node, total);
	}

	const notes: string[] = [];
	if (options.truncatedRead)
		notes.push(OUTLINE_TEXT.pageTruncated(options.truncatedRead.blocksRead));
	if (hiddenByView > 0) notes.push(OUTLINE_TEXT.factsOnly(hiddenByView));

	const lines = new Map<OutlineNode, string[]>();
	const linesOf = (node: OutlineNode): string[] => {
		let cached = lines.get(node);
		if (!cached) {
			const label = options.label?.(node);
			const item = outlineItem(node);
			const text = serializeMarkdownOutline([options.display?.(node, item) ?? item], {
				label: () => label ?? null,
			});
			cached = indented(text.split("\n"), depth.get(node) ?? 0);
			lines.set(node, cached);
		}
		return cached;
	};
	/** What the `… more` line under `node` may cost at most. */
	const reserveFor = (node: OutlineNode): number =>
		kids(node).length > 0
			? utf8(moreLine((depth.get(node) ?? 0) + 1, (size.get(node) ?? 1) - 1)) + 1
			: 0;

	const shown = new Set<OutlineNode>([root]);
	const reserved = new Map<OutlineNode, number>();
	let used = linesBytes(notes) + linesBytes(linesOf(root)) + reserveFor(root);
	reserved.set(root, reserveFor(root));
	for (let i = 1; i < order.length; i++) {
		const node = order[i] as OutlineNode;
		if (node.content === null || shown.size >= budget.blocks) break;
		const parent = node.parent as OutlineNode;
		const siblings = kids(parent);
		const release = siblings[siblings.length - 1] === node ? (reserved.get(parent) ?? 0) : 0;
		const reserve = reserveFor(node);
		const cost = linesBytes(linesOf(node)) + reserve - release;
		if (used + cost > budget.bytes) break;
		used += cost;
		shown.add(node);
		reserved.set(node, reserve);
		if (release > 0) reserved.set(parent, 0);
	}

	const out: string[] = [];
	const blockIds: string[] = [];
	let hiddenByBudget = 0;
	// Depth-first output; a stack keeps deep outlines off the call stack.
	const stack: Array<{ node: OutlineNode } | { more: number; depth: number }> = [{ node: root }];
	while (stack.length > 0) {
		const top = stack.pop() as { node: OutlineNode } | { more: number; depth: number };
		if ("more" in top) {
			out.push(moreLine(top.depth, top.more));
			continue;
		}
		const node = top.node;
		out.push(...linesOf(node));
		blockIds.push(node.id);
		let hidden = 0;
		const next: OutlineNode[] = [];
		for (const child of kids(node)) {
			if (shown.has(child)) next.push(child);
			else hidden += size.get(child) ?? 0;
		}
		hiddenByBudget += hidden;
		if (hidden > 0) stack.push({ more: hidden, depth: (depth.get(node) ?? 0) + 1 });
		for (let k = next.length - 1; k >= 0; k--) stack.push({ node: next[k] as OutlineNode });
	}
	out.push(...notes);
	const markdown = out.join("\n");
	return { markdown, view, blockIds, hiddenByBudget, hiddenByView, bytes: utf8(markdown) };
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

const MORE_LINE = /^ *‹… \d+ more›$/;
const NOTE_LINE = /^‹[^\n]*›$/;
/**
 * A code fence opening a line, or right after an item's bullet, its label (`[Ab3dEf9Q]`, when
 * the read put one there) and its checkbox.
 */
const FENCE = /^ *(?:(?:[-*+]|\d{1,9}[.)]) +(?:\[[^\]\n]*\] +)?(?:\[[ xX/-]\] +)?)?(`{3,}|~{3,})/;

/** Whether a line of a rendered outline is an annotation rather than content. */
export function isReadAnnotation(line: string): boolean {
	return NOTE_LINE.test(line) || MORE_LINE.test(line);
}

/**
 * Outline text without the annotations a read adds (`‹… N more›` lines and the notes at the
 * end), lines inside code fences left alone. Apply before parsing text that may have been
 * copied from a read.
 */
export function stripReadAnnotations(markdown: string): string {
	const out: string[] = [];
	let fence: { char: string; length: number } | null = null;
	for (const line of markdown.split("\n")) {
		const run = FENCE.exec(line)?.[1];
		if (fence) {
			const closing = line.trim();
			if (
				closing[0] === fence.char &&
				closing.length >= fence.length &&
				/^(`+|~+)$/.test(closing)
			) {
				fence = null;
			}
			out.push(line);
			continue;
		}
		if (run) {
			fence = { char: run[0] as string, length: run.length };
			out.push(line);
			continue;
		}
		if (!isReadAnnotation(line)) out.push(line);
	}
	return out.join("\n");
}
