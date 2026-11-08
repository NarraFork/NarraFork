/**
 * measure-plan-tree.ts — an outline plan's tree in its ExitPlanMode card (plan readability).
 *
 *   ┌ toolbar (one xs line, only when something is folded or clamped, or the reader changed it) ┐
 *   │ 「大纲 · 共 38 块」                                              「全部展开」/「全部收起」 │
 *   ├ box (min(rows + padding, cap), scrolls past the cap) ──────────────────────────────────────┤
 *   │     ☐ Title (bold)                                                                       │
 *   │       The background paragraph, dimmed, whole                                            │
 *   │   ▾ ☐ A big point (medium)                                                       [⇊]    │
 *   │     ▸ ☐ A small point, clamped to three lines when longer…                       [⇊]    │
 *   │           The first line of its first detail, cut to one line…  3 more ▸                │
 *   └────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Which rows show, which texts are whole and which rows end in a preview line is
 * `outline-plan-tree.ts`'s (the reader's view is part of the data, so a fold re-measures). Every
 * row is laid out here, by arithmetic only: its indent (depth × {@link PLAN_TREE_INDENT}, deeper
 * than {@link PLAN_TREE_MAX_INDENT_DEPTH} levels stops growing), the fold arrow's and the
 * checkbox's slots, the quick control's slot on a row with something folded inside, then the
 * block's text: one rich-inline flow per hard line, wrapped at the room left, clamped to
 * {@link PLAN_TREE_CLAMP_LINES} lines unless whole. The background sits under the title's text
 * with no arrow or marker, whole. A closed row with children adds one preview line: its first
 * child's first hard line, cut to one visual line at the room its label (「还有 N 条 ▸」,
 * measured in the body font) and an ellipsis leave. A clamped text and a preview end in an
 * ellipsis drawn in room their last line leaves for it (the render lays that line out narrower),
 * so neither changes a row's height.
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
	isPlanTreeAllExpanded,
	PLAN_TREE_CLAMP_LINES,
	type PlanTree,
	type PlanTreeLine,
	type PlanTreeNode,
	type PlanTreeRole,
	type PlanTreeRun,
	type PlanTreeView,
	planTextClamps,
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
/** Gap between rows, and between a row's text and its preview line (px). */
export const PLAN_TREE_ROW_GAP = 2;
/** Extra room under the background paragraph, before the first point (px). */
export const PLAN_TREE_BACKGROUND_GAP = 4;
/** The box's padding (px). */
export const PLAN_TREE_PAD_X = 6;
export const PLAN_TREE_PAD_Y = 4;
/** Gap between the toolbar line and the box (px). */
export const PLAN_TREE_TOOLBAR_GAP = 4;
/** The quick control (everything inside this node) at the right of a row's first line (px). */
export const PLAN_TREE_SUBTREE_SLOT = 24;
/** The fold arrow's hit area (px): its slot and 3px either side (into the indent and marker). */
export const PLAN_TREE_TOGGLE_HIT = 24;
/** Gap between a row's text and its quick control (px). */
export const PLAN_TREE_SUBTREE_GAP = 4;
/** Gap between a preview's ellipsis and its label (px). */
export const PLAN_TREE_PREVIEW_LABEL_GAP = 8;
/** Inline code runs carry the markdown path's chip padding (`INLINE_CODE_EXTRA_WIDTH`). */
const INLINE_CODE_EXTRA_WIDTH = 10;
/** The ellipsis a clamped text or a preview ends with. */
export const PLAN_TREE_ELLIPSIS = "…";

/**
 * The preview's labels (measured: they share its line). `more` with `{n}` for the children past
 * the first; `one` when there is only the first child, longer than its line.
 */
export interface PlanTreeMeasureLabels {
	more: string;
	one: string;
}

export const DEFAULT_PLAN_TREE_MEASURE_LABELS: PlanTreeMeasureLabels = {
	more: "{n} more ▸",
	one: "Expand ▸",
};

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

/** The line a closed row with children shows in their place (row-local coordinates). */
export interface PlanTreePreviewLayout {
	top: number;
	/** Left of the preview's text (where a child's text would start). */
	left: number;
	/** The room its text is laid out in (before the ellipsis and the label). */
	width: number;
	/** The first child's first hard line. */
	line: PlanTreePreparedLine;
	/** There is more than the line shows: it ends in an ellipsis and the label. */
	ellipsis: boolean;
	label: string | null;
	labelWidth: number;
	/** Children after the first. */
	rest: number;
}

/** One row, laid out (box-local coordinates, inside the padding). */
export interface PlanTreeRowLayout {
	key: string;
	depth: number;
	role: PlanTreeRole;
	top: number;
	height: number;
	/** Left of the fold arrow's slot. */
	left: number;
	/** Left and width of the text's room. */
	textLeft: number;
	textWidth: number;
	/** Height of the text (the preview line, when there is one, sits under it). */
	textHeight: number;
	hasChildren: boolean;
	open: boolean;
	task: PlanTreeNode["task"];
	heading: boolean;
	/** The quick control for everything inside it, at the right of its first line. */
	subtree: "expand" | "collapse" | null;
	/** Each hard line and how many of its visual lines show. */
	lines: Array<{ line: PlanTreePreparedLine; top: number; shown: number }>;
	/** The text is cut: the last shown line ends in an ellipsis. */
	clamped: boolean;
	/** The reader can flip the text between clamped and whole (it is longer than the clamp). */
	textToggles: boolean;
	whole: boolean;
	plain: string;
	preview: PlanTreePreviewLayout | null;
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
	/**
	 * Something is folded behind a preview, a text is longer than its clamp, or the reader opened
	 * or closed nodes: the toolbar shows. (A text flip alone does not keep it: once the card is
	 * wide enough that nothing clamps, there is nothing for it to do.)
	 */
	toolbar: boolean;
	/**
	 * Everything is expanded, or nothing drawn is hidden any more (no preview, no clamp, no closed
	 * node): the toolbar offers 「全部收起」, which returns to the default view.
	 */
	allOpen: boolean;
	/** Nodes in the plan. */
	size: number;
}

// ─── Fonts ───

function baseFont(node: PlanTreeNode): "bold" | "medium" | "regular" {
	if (node.role === "background") return "regular";
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

/** Visual lines of one prepared hard line at `width`. */
function lineCount(line: PlanTreePreparedLine, width: number): number {
	if (!line.flow) return 1;
	return Math.max(1, measureRichInlineStats(line.flow, Math.max(1, width)).lineCount);
}

/** Left of the text of a row at `depth` (after its indent, arrow slot and marker slot). */
function textLeftAt(depth: number, marker: number): number {
	return (
		Math.min(depth, PLAN_TREE_MAX_INDENT_DEPTH) * PLAN_TREE_INDENT + PLAN_TREE_TOGGLE_SLOT + marker
	);
}

/** The preview's label for `rest` more children (`{n}` filled in). */
export function planTreePreviewLabel(labels: PlanTreeMeasureLabels, rest: number): string {
	return rest > 0 ? labels.more.replaceAll("{n}", String(rest)) : labels.one;
}

/** Lay out the rows `view` shows of `tree`, in a box `innerWidth` wide (inside its padding). */
export function layoutPlanTree(
	tree: PlanTree,
	view: PlanTreeView,
	innerWidth: number,
	labels: PlanTreeMeasureLabels = DEFAULT_PLAN_TREE_MEASURE_LABELS,
): PlanTreeLayout {
	const { rows: visible, cut } = visiblePlanRows(tree, view);
	const metrics = typographyMetrics();
	const lineHeight = metrics.line.body;
	const marker = planTreeMarkerSlot();
	const bodyFont = metrics.font.body;
	const ellipsisWidth = Math.ceil(textWidth(PLAN_TREE_ELLIPSIS, bodyFont));
	const rows: PlanTreeRowLayout[] = [];
	let y = 0;
	let anyLonger = false;
	let anyHidden = false;
	for (const { node, open, whole, preview, subtree } of visible) {
		const previous = rows[rows.length - 1];
		if (previous) {
			y += PLAN_TREE_ROW_GAP;
			if (previous.role === "background") y += PLAN_TREE_BACKGROUND_GAP;
		}
		const background = node.role === "background";
		// The background reads as the title's paragraph: under the title's text, no arrow, no marker.
		const left = background
			? 0
			: Math.min(node.depth, PLAN_TREE_MAX_INDENT_DEPTH) * PLAN_TREE_INDENT;
		const textLeft = background ? textLeftAt(0, marker) : textLeftAt(node.depth, marker);
		const room = Math.max(
			24,
			innerWidth - textLeft - (subtree ? PLAN_TREE_SUBTREE_SLOT + PLAN_TREE_SUBTREE_GAP : 0),
		);
		const preparedLines = preparePlanTreeLines(node);
		const counts = preparedLines.map((line) => lineCount(line, room));
		const total = counts.reduce((sum, n) => sum + n, 0);
		const longer = planTextClamps(node) && total > PLAN_TREE_CLAMP_LINES;
		const clamp = !whole && longer;
		if (longer) anyLonger = true;
		if (clamp || preview || (node.children.length > 0 && !open)) anyHidden = true;
		let remaining = clamp ? PLAN_TREE_CLAMP_LINES : total;
		let lineTop = 0;
		const lines: PlanTreeRowLayout["lines"] = [];
		for (let i = 0; i < preparedLines.length && remaining > 0; i++) {
			const shown = Math.min(counts[i] as number, remaining);
			lines.push({ line: preparedLines[i] as PlanTreePreparedLine, top: lineTop, shown });
			lineTop += shown * lineHeight;
			remaining -= shown;
		}
		const textHeight = lineTop;
		let height = textHeight;
		let previewLayout: PlanTreePreviewLayout | null = null;
		if (preview) {
			const previewLeft = textLeftAt(node.depth + 1, marker);
			const previewRoom = Math.max(24, innerWidth - previewLeft);
			const line = preparePlanTreeLines(preview.first)[0] as PlanTreePreparedLine;
			// The label shows when there is more than the line: other children, other lines, or a
			// first line longer than the room.
			const more = preview.more || lineCount(line, previewRoom) > 1;
			const label = more ? planTreePreviewLabel(labels, preview.rest) : null;
			const labelWidth = label ? Math.ceil(textWidth(label, bodyFont)) : 0;
			const top = textHeight + PLAN_TREE_ROW_GAP;
			previewLayout = {
				top,
				left: previewLeft,
				width: label
					? Math.max(0, previewRoom - labelWidth - PLAN_TREE_PREVIEW_LABEL_GAP - ellipsisWidth)
					: previewRoom,
				line,
				ellipsis: more,
				label,
				labelWidth,
				rest: preview.rest,
			};
			height = top + lineHeight;
		}
		rows.push({
			key: node.key,
			depth: node.depth,
			role: node.role,
			top: y,
			height,
			left,
			textLeft,
			textWidth: room,
			textHeight,
			hasChildren: node.children.length > 0,
			open,
			task: node.task,
			heading: node.heading === true,
			subtree,
			lines,
			clamped: clamp,
			textToggles: longer,
			whole,
			plain: node.plain,
			preview: previewLayout,
		});
		y += height;
	}
	if (cut > 0) y += PLAN_TREE_ROW_GAP + metrics.line.xs;
	return {
		rows,
		cut,
		contentHeight: y,
		lineHeight,
		innerWidth,
		ellipsisWidth,
		toolbar: tree.folds || anyLonger || view.scopes.size > 0 || view.nodes.size > 0,
		allOpen: isPlanTreeAllExpanded(view) || (!anyHidden && cut === 0),
		size: tree.size,
	};
}

/** The toolbar line's height (one xs line), when it shows. */
export function planTreeToolbarHeight(): number {
	return typographyMetrics().line.xs;
}
