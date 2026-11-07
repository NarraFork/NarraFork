/**
 * measure-plan-tree.ts — an outline plan's tree in its ExitPlanMode card (plan readability).
 *
 *   ┌ toolbar (one xs line, only when something is folded or the reader opened something) ─┐
 *   │ 「两层大纲 · 共 38 块」                                         「全部展开」/「全部收起」 │
 *   ├ box (min(rows + padding, cap), scrolls past the cap) ─────────────────────────────────┤
 *   │ ▾ ☐ Root title (bold)                                                                │
 *   │   ▾ • Phase (medium)                                                                 │
 *   │       ▸ ☐ Task, its text clamped to two lines when longer…                    [+3]  │
 *   │       • Detail                                                                       │
 *   └──────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Which rows show and which texts are whole is `outline-plan-tree.ts`'s (the reader's view is
 * part of the data, so a fold re-measures). Every row is laid out here, by arithmetic only:
 * its indent (depth × {@link PLAN_TREE_INDENT}, deeper than {@link PLAN_TREE_MAX_INDENT_DEPTH}
 * levels stops growing), the fold arrow's and the checkbox's slots, the child-count badge's
 * width on a folded row (its text measured with the badge font), then the block's text: one
 * rich-inline flow per hard line, wrapped at the room left, clamped to
 * {@link PLAN_TREE_CLAMP_LINES} lines unless whole. A clamped text ends in an ellipsis drawn in
 * room the last line leaves for it (the render lays that line out narrower), so the clamp never
 * changes a row's height.
 *
 * Zero DOM. The prepared flows of a node are kept per node object (the parsed tree is cached by
 * text) and typography generation, so a fold re-measures without re-preparing.
 */
import { measureLineStats, prepareWithSegments } from "@chenglou/pretext";
import {
	measureRichInlineStats,
	type PreparedRichInline,
	prepareRichInline,
	type RichInlineItem,
} from "@chenglou/pretext/rich-inline";
import {
	PLAN_TREE_CLAMP_LINES,
	type PlanTree,
	type PlanTreeLine,
	type PlanTreeNode,
	type PlanTreeRun,
	type PlanTreeView,
	visiblePlanRows,
} from "@shared/outline-plan-tree";
import { letterSpacingForFont } from "@shared/pretext-layout/typography";
import { typographyMetrics } from "../pretext-fonts";

/** Indent per level under the root (px). */
export const PLAN_TREE_INDENT = 16;
/** Levels past which the indent stops growing (a deep plan stays inside a phone's width). */
export const PLAN_TREE_MAX_INDENT_DEPTH = 6;
/** The fold arrow's slot (px), reserved on every row so texts line up. */
export const PLAN_TREE_TOGGLE_SLOT = 18;
/** Gap after the checkbox / bullet (px). */
export const PLAN_TREE_MARKER_GAP = 6;
/** Gap between rows (px). */
export const PLAN_TREE_ROW_GAP = 2;
/** The box's padding (px). */
export const PLAN_TREE_PAD_X = 6;
export const PLAN_TREE_PAD_Y = 4;
/** Gap between the toolbar line and the box (px). */
export const PLAN_TREE_TOOLBAR_GAP = 4;
/** The child-count badge: horizontal padding inside it, and its gap before the text's room. */
export const PLAN_TREE_BADGE_PAD_X = 6;
export const PLAN_TREE_BADGE_GAP = 6;
/** Inline code runs carry the markdown path's chip padding (`INLINE_CODE_EXTRA_WIDTH`). */
const INLINE_CODE_EXTRA_WIDTH = 10;
/** The ellipsis a clamped text ends with. */
export const PLAN_TREE_ELLIPSIS = "…";

/** Class names of a run (the markdown path's fragment classes, plus the line's tone). */
export const PLAN_TREE_FRAG = "vlist-frag vlist-frag--body";

/** The checkbox's size (px): the outline's `--nf-outline-icon`, clamp(12, body + 2, 24). */
export function planTreeIconPx(): number {
	return Math.min(24, Math.max(12, Math.round(typographyMetrics().size.sm + 2)));
}

/** The checkbox / bullet slot (px). */
export function planTreeMarkerSlot(): number {
	return planTreeIconPx() + PLAN_TREE_MARKER_GAP;
}

/** One hard line of a row's text, prepared. `null` flow: an empty line (one line box). */
export interface PlanTreePreparedLine {
	flow: PreparedRichInline | null;
	fonts: string[];
	classNames: string[];
	tone?: "dim" | "code";
}

/** One row, laid out (box-local coordinates, inside the padding). */
export interface PlanTreeRowLayout {
	key: string;
	depth: number;
	top: number;
	height: number;
	/** Left of the fold arrow's slot. */
	left: number;
	/** Left and width of the text's room. */
	textLeft: number;
	textWidth: number;
	hasChildren: boolean;
	open: boolean;
	task: PlanTreeNode["task"];
	heading: boolean;
	/** The badge a folded row with children draws at the right of its first line. */
	badge: { text: string; width: number; count: number } | null;
	/** Each hard line and how many of its visual lines show. */
	lines: Array<{ line: PlanTreePreparedLine; top: number; shown: number }>;
	/** The text is cut: the last shown line ends in an ellipsis. */
	clamped: boolean;
	/** The reader can flip the text between clamped and whole (it is longer than the clamp). */
	textToggles: boolean;
	whole: boolean;
	plain: string;
}

export interface PlanTreeLayout {
	rows: PlanTreeRowLayout[];
	/** Rows past the view's limit (`PLAN_TREE_MAX_ROWS`, counted in a last line). */
	cut: number;
	/** Height of the rows (and the cut line), without the padding. */
	contentHeight: number;
	lineHeight: number;
	/** The width the rows were laid out in (the box's inner width). */
	innerWidth: number;
	/** The ellipsis's width in the body font (the room a clamped last line leaves for it). */
	ellipsisWidth: number;
	/** Something is folded or clamped, or the reader opened something: the toolbar shows. */
	toolbar: boolean;
	/** Nodes in the plan. */
	size: number;
}

// ─── Fonts ───

function baseFont(node: PlanTreeNode): "bold" | "medium" | "regular" {
	if (node.depth === 0 || node.heading) return "bold";
	return node.depth === 1 ? "medium" : "regular";
}

function runFont(run: PlanTreeRun, base: "bold" | "medium" | "regular"): string {
	const { font } = typographyMetrics();
	if (run.code) return font.inlineCode;
	const bold = run.strong || base === "bold";
	if (bold && run.em) return font.bodyBoldItalic;
	if (bold) return font.bodyBold;
	if (run.em) return font.bodyItalic;
	return base === "medium" ? font.bodyMedium : font.body;
}

function runClass(run: PlanTreeRun, tone: PlanTreeLine["tone"]): string {
	let cls = run.code && tone !== "code" ? "vlist-frag vlist-frag--code" : PLAN_TREE_FRAG;
	if (run.link) cls += " is-link";
	if (run.strong) cls += " is-strong";
	if (run.em) cls += " is-em";
	if (run.strike) cls += " is-del";
	if (tone === "dim") cls += " vlist-plan-dim";
	if (tone === "code") cls += " vlist-plan-code";
	return cls;
}

const prepared = new WeakMap<PlanTreeNode, { revision: number; lines: PlanTreePreparedLine[] }>();

/** A node's text, prepared once per typography generation. */
export function preparePlanTreeLines(node: PlanTreeNode): PlanTreePreparedLine[] {
	const revision = typographyMetrics().revision;
	const hit = prepared.get(node);
	if (hit && hit.revision === revision) return hit.lines;
	// The weight of the root and the phases is their title's: the block's first line only (a
	// legacy root's goal and acceptance lines read as body text under it).
	const first = baseFont(node);
	const lines = node.lines.map((line, index): PlanTreePreparedLine => {
		const base = index === 0 ? first : "regular";
		const runs = line.runs.filter((run) => run.text.length > 0);
		if (runs.length === 0) return { flow: null, fonts: [], classNames: [], tone: line.tone };
		const fonts = runs.map((run) =>
			line.tone === "code" ? typographyMetrics().font.inlineCode : runFont(run, base),
		);
		const items: RichInlineItem[] = runs.map((run, i) => {
			const font = fonts[i] as string;
			const spacing = letterSpacingForFont(font);
			return {
				text: run.text,
				font,
				break: "normal",
				extraWidth: run.code && line.tone !== "code" ? INLINE_CODE_EXTRA_WIDTH : 0,
				...(spacing ? { letterSpacing: spacing } : {}),
			};
		});
		return {
			flow: prepareRichInline(items),
			fonts,
			classNames: runs.map((run) => runClass(run, line.tone)),
			tone: line.tone,
		};
	});
	prepared.set(node, { revision, lines });
	return lines;
}

/** Natural width of `text` in `font` (px). */
function textWidth(text: string, font: string): number {
	const spacing = letterSpacingForFont(font);
	const handle = prepareWithSegments(text, font, spacing ? { letterSpacing: spacing } : undefined);
	return measureLineStats(handle, 1e6).maxLineWidth;
}

/** The child-count badge's text: `+N`, N the children a folded row hides. */
export function planTreeBadgeText(count: number): string {
	return `+${count}`;
}

/** Visual lines of one prepared hard line at `width`. */
function lineCount(line: PlanTreePreparedLine, width: number): number {
	if (!line.flow) return 1;
	return Math.max(1, measureRichInlineStats(line.flow, Math.max(1, width)).lineCount);
}

/** Lay out the rows `view` shows of `tree`, in a box `innerWidth` wide (inside its padding). */
export function layoutPlanTree(
	tree: PlanTree,
	view: PlanTreeView,
	innerWidth: number,
): PlanTreeLayout {
	const { rows: visible, cut } = visiblePlanRows(tree, view);
	const lineHeight = typographyMetrics().line.body;
	const marker = planTreeMarkerSlot();
	const badgeFont = typographyMetrics().font.xs;
	const ellipsisWidth = Math.ceil(textWidth(PLAN_TREE_ELLIPSIS, typographyMetrics().font.body));
	const rows: PlanTreeRowLayout[] = [];
	let y = 0;
	let anyClamp = false;
	for (const { node, open, whole } of visible) {
		if (rows.length > 0) y += PLAN_TREE_ROW_GAP;
		const left = Math.min(node.depth, PLAN_TREE_MAX_INDENT_DEPTH) * PLAN_TREE_INDENT;
		const textLeft = left + PLAN_TREE_TOGGLE_SLOT + marker;
		const hasChildren = node.children.length > 0;
		const badge =
			hasChildren && !open
				? (() => {
						const text = planTreeBadgeText(node.children.length);
						return {
							text,
							count: node.children.length,
							width: Math.ceil(textWidth(text, badgeFont)) + PLAN_TREE_BADGE_PAD_X * 2,
						};
					})()
				: null;
		const room = Math.max(
			24,
			innerWidth - textLeft - (badge ? badge.width + PLAN_TREE_BADGE_GAP : 0),
		);
		const preparedLines = preparePlanTreeLines(node);
		const counts = preparedLines.map((line) => lineCount(line, room));
		const total = counts.reduce((sum, n) => sum + n, 0);
		const longer = total > PLAN_TREE_CLAMP_LINES;
		const clamp = !whole && longer;
		if (longer) anyClamp = true;
		let remaining = clamp ? PLAN_TREE_CLAMP_LINES : total;
		let lineTop = 0;
		const lines: PlanTreeRowLayout["lines"] = [];
		for (let i = 0; i < preparedLines.length && remaining > 0; i++) {
			const shown = Math.min(counts[i] as number, remaining);
			lines.push({ line: preparedLines[i] as PlanTreePreparedLine, top: lineTop, shown });
			lineTop += shown * lineHeight;
			remaining -= shown;
		}
		const height = lineTop;
		rows.push({
			key: node.key,
			depth: node.depth,
			top: y,
			height,
			left,
			textLeft,
			textWidth: room,
			hasChildren,
			open,
			task: node.task,
			heading: node.heading === true,
			badge,
			lines,
			clamped: clamp,
			textToggles: longer,
			whole,
			plain: node.plain,
		});
		y += height;
	}
	if (cut > 0) y += PLAN_TREE_ROW_GAP + typographyMetrics().line.xs;
	const flipped = view.all || view.nodes.size > 0 || view.texts.size > 0;
	return {
		rows,
		cut,
		contentHeight: y,
		lineHeight,
		innerWidth,
		ellipsisWidth,
		toolbar: tree.folds || anyClamp || flipped,
		size: tree.size,
	};
}

/** The toolbar line's height (one xs line), when it shows. */
export function planTreeToolbarHeight(): number {
	return typographyMetrics().line.xs;
}
