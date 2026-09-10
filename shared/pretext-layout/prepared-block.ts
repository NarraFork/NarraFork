/**
 * prepared-block.ts — The core PreparedBlock model for the pretext-based
 * zero-DOM-measure narrator list (vlist).
 *
 * Design mirrors the pretext markdown-chat demo's three-layer separation:
 *
 *   1. Prepared layer  (once, width-independent): parse data + pretext
 *      prepareRichInline()/prepareWithSegments() precompute. Produces
 *      PreparedBlock[] — no final coordinates yet.
 *   2. Frame layer      (recomputed on width/LOD change): pure arithmetic via
 *      measureRichInlineStats()/measureLineStats() → line counts → per-block
 *      height/top → element total height.
 *   3. Layout/render    (only when on-screen): walkRichInlineLineRanges()/
 *      layoutWithLines() to materialize fragments; absolute-position render.
 *
 * The universal height formula:
 *   height = fixed_chrome(padding/margin/icon/gap/border)
 *          + Σ(block text line count × line box height)
 * where "line count" is produced by pretext pure arithmetic (zero DOM).
 *
 * ZERO DOM MEASUREMENT: no getBoundingClientRect / offsetHeight / ResizeObserver
 * anywhere in the prepared→frame pipeline. The only controlled exception is a
 * small set of intrinsically-unpredictable blocks (mermaid / katex / images of
 * unknown intrinsic size) — see UnknownBlock below.
 */

import type { PreparedTextWithSegments } from "@chenglou/pretext";
import type { PreparedRichInline } from "@chenglou/pretext/rich-inline";

// ─────────────────────────────────────────────────────────────────────────────
// Render LOD (mirrors RenderLodCtx). Height models MUST take LOD as input.
// L1 (most folded) .. L5 (most detailed). Default L4.
// ─────────────────────────────────────────────────────────────────────────────
export type RenderLod = 1 | 2 | 3 | 4 | 5;
export const DEFAULT_RENDER_LOD: RenderLod = 4;

// ─────────────────────────────────────────────────────────────────────────────
// PreparedBlock — width-independent, produced once per data item.
// A message/tool/system element is modeled as an ordered list of PreparedBlocks.
// Each concrete block carries whatever pretext prepared handle it needs plus the
// fixed-chrome metadata required to place it.
// ─────────────────────────────────────────────────────────────────────────────

/** Common fields shared by every prepared block. */
export interface PreparedBlockBase {
	/** Top margin (px) applied before this block within its element. First
	 * block in an element typically uses 0. */
	marginTop: number;
	/** Horizontal content offset (px) for list/blockquote nesting. */
	contentLeft: number;
	/** Left offsets (px) of blockquote rails to draw, one per nesting depth. */
	quoteRailLefts: number[];
	/** Optional list/task marker text (bullet, "1.", checkbox) or null. */
	markerText: string | null;
	/** Structured task state; render a control, never a font-dependent glyph. */
	taskMarker?: { checked: boolean; label: string };
	/** Left offset (px) of the marker relative to the element, or null. */
	markerLeft: number | null;
	/** CSS class for the marker, or null. */
	markerClassName: string | null;
}

/** Inline rich-text block (paragraph, heading, list item text, quote text). */
export interface PreparedInlineBlock extends PreparedBlockBase {
	kind: "inline";
	/** pretext prepared rich-inline flow (already measured segment widths). */
	flow: PreparedRichInline;
	/** Line box height (px) for this block's text role. */
	lineHeight: number;
	/** Per-fragment CSS class names, indexed by rich-inline itemIndex. */
	classNames: string[];
	/** Per-fragment hrefs (null when not a link), indexed by itemIndex. */
	hrefs: Array<string | null>;
	/**
	 * Per-fragment CSS `font` shorthand, indexed by rich-inline itemIndex. The
	 * render layer MUST apply the exact same font string pretext measured with,
	 * otherwise rendered wrapping drifts from the predicted height.
	 */
	fonts: string[];
	/**
	 * Per-fragment inline math payload, indexed by rich-inline itemIndex; null for
	 * ordinary text fragments. A math fragment is a FIXED-WIDTH ATOM: its pretext
	 * item is an unbreakable placeholder whose `extraWidth` was set so the item
	 * occupies exactly the formula's measured width. The render layer replaces the
	 * placeholder glyph with this KaTeX markup at that same width, so wrapping and
	 * geometry stay identical to what was measured.
	 */
	mathHtmls?: Array<InlineMathFragment | null>;
	/**
	 * Anchor slug when this block is a markdown HEADING; absent otherwise.
	 *
	 * Height-neutral but PAINTED (as `data-md-heading`), so it is what lets a
	 * `[x](#…)` link elsewhere in the same body find this heading. Lives on the
	 * prepared block because that is where the heading's inline tokens are still
	 * available — the render layer only ever sees materialized line fragments, by
	 * which point the heading text has been split across visual lines and the
	 * block no longer knows it was a heading at all.
	 *
	 * Only the FIRST block of a multi-line heading carries it: that is the block a
	 * jump should land on, and duplicating it would give one anchor several targets.
	 */
	headingSlug?: string;
	/**
	 * Optional render-only payload (kept small; no heavy data). Height-neutral —
	 * geometry never consults it. Used e.g. to carry a spec-task's status/lock
	 * glyph so the render layer can draw it in the reserved indent lane.
	 */
	data?: Record<string, unknown>;
}

/** A measured inline formula carried on an inline block's math fragment slot. */
export interface InlineMathFragment {
	/** KaTeX HTML markup to paint. */
	html: string;
	/** Measured width (px) the placeholder item reserves. */
	width: number;
	/** Measured height (px) — folded into the block's lineHeight by the parser. */
	height: number;
	/** LaTeX source, kept for copy/selection and error reporting. */
	latex: string;
}

/** Fenced code block (pre-wrap monospace). */
export interface PreparedCodeBlock extends PreparedBlockBase {
	kind: "code";
	/** pretext prepared pre-wrap text with segments. */
	prepared: PreparedTextWithSegments;
	/** Code line box height (px). */
	lineHeight: number;
	/** Optional language label (adds top padding when present). */
	lang: string | null;
}

/** Horizontal rule / divider. */
export interface PreparedRuleBlock extends PreparedBlockBase {
	kind: "rule";
	/** Fixed rule row height (px). */
	height: number;
}

/**
 * A block with fixed height that never depends on text flow (icons rows, single
 * dimmed lines, badges, image placeholders with known aspect ratio, tool detail
 * regions capped by maxHeight, etc.). Height is provided directly.
 */
export interface PreparedFixedBlock extends PreparedBlockBase {
	kind: "fixed";
	/** Exact height (px), fully determined without text measurement. */
	height: number;
	/** Opaque tag for the renderer to know what to draw. */
	tag: string;
	/** Optional payload the renderer needs (kept small; no heavy data). */
	data?: Record<string, unknown>;
	/**
	 * Known painted width (px), when the block's display size is a pure function
	 * of data (e.g. an image with persisted intrinsic dimensions, fitted by
	 * `fitImageBox`). Reported into the frame's `usedWidth` so a shrink-wrap
	 * container (user bubble) grows around the image instead of clipping it.
	 * Absent → the block contributes nothing to `usedWidth` (legacy behaviour).
	 */
	displayWidth?: number;
}

/**
 * One table cell: an inline flow plus the two intrinsic widths the column solver
 * needs. Both are produced by pretext at prepare time (width-independent), so
 * solving columns later is pure arithmetic.
 */
export interface PreparedTableCell {
	/** pretext prepared rich-inline flow for the cell's content. */
	flow: PreparedRichInline;
	/** Per-fragment CSS class names, indexed by rich-inline itemIndex. */
	classNames: string[];
	/** Per-fragment hrefs (null when not a link), indexed by itemIndex. */
	hrefs: Array<string | null>;
	/** Per-fragment CSS `font` shorthand — the render layer MUST reuse these. */
	fonts: string[];
	/**
	 * Per-fragment inline math payload, indexed by rich-inline itemIndex; null for
	 * ordinary text fragments. Same contract as `PreparedInlineBlock.mathHtmls`: the
	 * flow item is an unbreakable placeholder sized to the formula's measured width,
	 * and the render layer swaps the placeholder glyph for this KaTeX markup. Without
	 * it a cell formula paints as the bare placeholder (a non-breaking space), i.e.
	 * correctly-sized blank space.
	 */
	mathHtmls?: Array<InlineMathFragment | null>;
	/** Width (px) the content occupies when never wrapped (max-content). */
	naturalWidth: number;
	/** Width (px) of the widest unbreakable piece (min-content). */
	minWidth: number;
	/**
	 * Tallest formula in this cell (px), or 0 when it has none. The table's row
	 * height must grow for a stacked formula (a fraction is taller than the text
	 * line box) or the cell clips it.
	 */
	mathHeight?: number;
}

/**
 * GFM table. Rendered WITHOUT a real `<table>`: the browser's `table-layout:auto`
 * algorithm is not reproducible in a pure height model, so the column widths are
 * solved here (see `solveTableColumns`) and the render layer absolutely positions
 * every cell at that geometry. Prediction and paint therefore share one source of
 * truth and cannot drift.
 */
export interface PreparedTableBlock extends PreparedBlockBase {
	kind: "table";
	/** Header cells (one per column); empty when the table has no header row. */
	header: PreparedTableCell[];
	/** Body rows, each a full row of cells (may be shorter than `columns`). */
	rows: PreparedTableCell[][];
	/** Per-column horizontal alignment from the delimiter row. */
	align: Array<"left" | "center" | "right" | null>;
	/** Column count (max of header/row lengths). */
	columns: number;
	/** Line box height (px) for cell text. */
	lineHeight: number;
}

/**
 * A block whose height cannot be predicted purely (mermaid / katex / image of
 * unknown intrinsic size). Uses a conservative placeholder height; the renderer
 * may perform a ONE-TIME local measurement to refine it (the single controlled
 * exception to the zero-DOM-measure rule). Never use for ordinary text/markdown.
 */
export interface PreparedUnknownBlock extends PreparedBlockBase {
	kind: "unknown";
	/** Conservative placeholder height (px) used until refined. */
	placeholderHeight: number;
	/** What kind of unpredictable content this is. */
	tag: "mermaid" | "katex" | "image-unknown";
	/**
	 * Known rendered width (px), when the content's geometry IS predictable.
	 * Display formulas measured via katex-geometry set this; mermaid and
	 * unknown-size images leave it undefined.
	 */
	intrinsicWidth?: number;
	/** Opaque payload for the renderer + local-measure refinement. */
	data?: Record<string, unknown>;
}

export type PreparedBlock =
	| PreparedInlineBlock
	| PreparedCodeBlock
	| PreparedRuleBlock
	| PreparedFixedBlock
	| PreparedTableBlock
	| PreparedUnknownBlock;

// ─────────────────────────────────────────────────────────────────────────────
// Frame layer — per-block resolved geometry at a concrete content width.
// ─────────────────────────────────────────────────────────────────────────────

export interface BlockFrame {
	/** Index into the source PreparedBlock[]. */
	index: number;
	/** Resolved top offset (px) within the element content box. */
	top: number;
	/** Resolved height (px). */
	height: number;
	/** Widest rendered line (px) — used for user-bubble shrink-wrap. */
	usedWidth: number;
}

export interface ElementFrame {
	/** Per-block resolved geometry, parallel to the PreparedBlock[]. */
	blocks: BlockFrame[];
	/** Total element content height (sum of blocks + inter-block margins). */
	contentHeight: number;
	/** Widest used content width across blocks (px). */
	usedWidth: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Measure result — what every measureXxx() function returns.
// ─────────────────────────────────────────────────────────────────────────────

export interface MeasuredElement {
	/** Total element height (px), including the element's own outer chrome. */
	height: number;
	/** The prepared blocks (for later render materialization). */
	blocks: PreparedBlock[];
	/** Resolved frame at the width the measure was run for. */
	frame: ElementFrame;
	/** Content width (px) the frame was computed at (render layer re-materializes
	 * line ranges at this same width). */
	contentWidth: number;
	/** Widest content width used (px) — for shrink-wrap containers. */
	usedWidth: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Height accumulator — the universal Frame-layer routine. Given prepared blocks
// and a per-block line-count resolver, produces the ElementFrame. The resolver
// isolates the pretext calls so this stays trivially unit-testable with a stub.
// ─────────────────────────────────────────────────────────────────────────────

export interface BlockLineMetrics {
	/** Number of text lines this block wraps to at the given width. */
	lineCount: number;
	/** Widest rendered line (px). */
	maxLineWidth: number;
}

/**
 * Resolve line metrics for one prepared block at a content width. For inline/code
 * blocks this calls pretext (measureRichInlineStats / measureLineStats). For
 * fixed/rule/unknown blocks it is ignored (their height is intrinsic).
 *
 * Table cells reuse the same resolver: a cell is measured exactly like an inline
 * block, so the caller supplies one pretext bridge and every text shape flows
 * through it.
 */
export type LineMetricsResolver = (
	block: PreparedInlineBlock | PreparedCodeBlock,
	contentWidth: number,
) => BlockLineMetrics;

// ─────────────────────────────────────────────────────────────────────────────
// Table column solving + geometry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Table chrome, mirroring the chunked path's `<Table fz="sm">`:
 *   - `--table-horizontal-spacing` defaults to Mantine spacing xs = 10px
 *   - `verticalSpacing` is Table's own default prop = 7px
 *   - `withRowBorders` defaults true → a 1px `border-bottom` per row
 *
 * `scrollbarHeight` is OUR constant, not Mantine's: an overflowing table scrolls
 * horizontally and the bar's real thickness is an OS/theme value the pure height
 * model must never read. A fixed reservation (paired with `scrollbar-width: thin`
 * in the render layer) keeps the height deterministic and identical on every
 * platform. Platforms with overlay scrollbars simply gain this much empty space.
 */
export const DEFAULT_TABLE_METRICS: TableMetrics = {
	paddingX: 10,
	paddingY: 7,
	rowBorder: 1,
	scrollbarHeight: 12,
};

/** Chrome constants for table geometry (mirrors Mantine Table CSS). */
export interface TableMetrics {
	/** Cell padding, inline direction (px, per side). */
	paddingX: number;
	/** Cell padding, block direction (px, per side). */
	paddingY: number;
	/** Row separator thickness (px). */
	rowBorder: number;
	/** Reserved height (px) for the horizontal scrollbar when the table overflows. */
	scrollbarHeight: number;
}

/** Resolved table geometry at a concrete available width. */
export interface TableLayout {
	/** Per-column content widths (px), excluding cell padding. */
	columnWidths: number[];
	/** Per-row heights (px), header first when present. */
	rowHeights: number[];
	/** Total table height (px), including the scrollbar reservation when overflowing. */
	height: number;
	/** Total table width (px) including padding and borders. */
	tableWidth: number;
	/** True when `tableWidth` exceeds the available width and must scroll. */
	overflowing: boolean;
}

/**
 * Solve column widths for a prepared table at an available width.
 *
 * A deterministic stand-in for CSS `table-layout: auto`, chosen because the real
 * algorithm is under-specified and varies between engines — impossible to predict
 * arithmetically, which the zero-DOM height model requires. Three regimes:
 *
 *   1. Natural widths fit          → use them (no wrapping at all).
 *   2. Natural too wide, min fits  → shrink each column from natural toward min,
 *      distributed in proportion to its own slack (natural - min), so a column
 *      with little slack is squeezed little. Matches the intuition behind the CSS
 *      algorithm without inheriting its ambiguity.
 *   3. Even min widths overflow    → keep min widths and let the table scroll
 *      horizontally (parity with the chunked path's `overflowX: auto` wrapper).
 *
 * Pure arithmetic given the prepared cells' intrinsic widths.
 */
export function solveTableColumns(
	block: PreparedTableBlock,
	availableWidth: number,
	metrics: TableMetrics,
): number[] {
	const { columns } = block;
	if (columns === 0) return [];

	const natural = new Array<number>(columns).fill(0);
	const min = new Array<number>(columns).fill(0);
	const visit = (cells: readonly PreparedTableCell[]) => {
		for (let c = 0; c < cells.length && c < columns; c++) {
			const cell = cells[c];
			if (!cell) continue;
			if (cell.naturalWidth > (natural[c] ?? 0)) natural[c] = cell.naturalWidth;
			if (cell.minWidth > (min[c] ?? 0)) min[c] = cell.minWidth;
		}
	};
	visit(block.header);
	for (const row of block.rows) visit(row);

	// Chrome consumed by padding/borders is unavailable to text, so the budget the
	// columns compete for is the available width minus it.
	const chrome = columns * metrics.paddingX * 2;
	const budget = availableWidth - chrome;

	let naturalTotal = 0;
	let minTotal = 0;
	for (let c = 0; c < columns; c++) {
		naturalTotal += natural[c] ?? 0;
		minTotal += min[c] ?? 0;
	}

	// Regime 3: not even min widths fit — scroll horizontally at min width.
	// Checked FIRST so the two fitting regimes below can both end with the same
	// budget reconciliation (a table that genuinely overflows must not have width
	// reclaimed from its columns).
	if (minTotal >= budget) return min.map((w) => Math.max(1, Math.ceil(w)));

	// Column floors, shared by both fitting regimes. The min floor is ceil-ed: it
	// is the widest unbreakable unit, so shaving a fraction off it WOULD clip a
	// glyph.
	const floors = new Array<number>(columns);
	for (let c = 0; c < columns; c++) floors[c] = Math.max(1, Math.ceil(min[c] ?? 0));

	// Regime 1: everything fits at its natural width.
	if (naturalTotal <= budget) {
		const out = natural.map((w, c) => Math.max(floors[c] ?? 1, Math.ceil(w)));
		return fitToBudget(out, floors, budget);
	}

	// Regime 2: distribute the required shrink across each column's own slack.
	//
	// Rounding goes DOWN here, unlike regimes 1 and 3. The shrunk widths sum to
	// exactly the budget before rounding, so rounding up would push the total past
	// it and trip the overflow flag — reserving a scrollbar for a sub-pixel
	// overshoot. Rounding down cannot clip anything: a slightly narrower column
	// just wraps one more time, and the height model measures that wrap.
	const excess = naturalTotal - budget;
	const totalSlack = naturalTotal - minTotal;
	const out = new Array<number>(columns);
	for (let c = 0; c < columns; c++) {
		const nat = natural[c] ?? 0;
		const slack = nat - (min[c] ?? 0);
		const shrink = totalSlack > 0 ? (excess * slack) / totalSlack : 0;
		out[c] = Math.max(floors[c] ?? 1, Math.floor(nat - shrink));
	}
	return fitToBudget(out, floors, budget);
}

/**
 * Reclaim per-column rounding overshoot so a table that FITS never reports itself
 * as overflowing.
 *
 * Both fitting regimes round individual columns UP in at least one branch —
 * regime 1 ceils every natural width, regime 2 ceils the min floor — and each
 * ceil can add just under 1px. Across N columns that accumulates to as much as
 * N px, well past `layoutTable`'s 0.5px tolerance, so a table whose true widths
 * fit its box was flagged as overflowing: it got a horizontal scroll container it
 * never needed plus a 12px scrollbar reservation of blank space beneath it.
 * Reproduced at 10 columns of natural width 50.4 in an 820px box (826px solved).
 *
 * Measurement and paint could not DRIFT from this (both call the same solver), so
 * it was cosmetic — but it is cosmetic damage on every table with fractional
 * intrinsic widths, which is all of them under a real font.
 *
 * Recovery takes 1px at a time from the column with the most headroom above its
 * floor, which keeps the columns as even as the proportional solve left them. It
 * stops when the budget is met or no column can give — the latter only at the
 * regime-2/3 boundary, where `Σceil(min)` genuinely exceeds the budget even though
 * `Σmin` did not, and reporting overflow there is correct.
 *
 * Mutates and returns `widths` (a fresh array owned by the caller).
 */
function fitToBudget(widths: number[], floors: readonly number[], budget: number): number[] {
	let total = 0;
	for (const width of widths) total += width;
	// Overshoot is bounded by the column count (one sub-pixel ceil each), so this
	// terminates quickly; the guard is against a pathological input, not the norm.
	while (total > budget) {
		let best = -1;
		let bestHeadroom = 0;
		for (let c = 0; c < widths.length; c++) {
			const headroom = (widths[c] ?? 0) - (floors[c] ?? 1);
			if (headroom > bestHeadroom) {
				bestHeadroom = headroom;
				best = c;
			}
		}
		// Every column sits on its floor: the table cannot be made to fit.
		if (best < 0) break;
		widths[best] = (widths[best] ?? 0) - 1;
		total -= 1;
	}
	return widths;
}

/**
 * Lay out a prepared table at an available width: solve columns, then derive each
 * row's height from the tallest cell in it. Zero DOM — every line count comes
 * from the injected resolver.
 */
export function layoutTable(
	block: PreparedTableBlock,
	availableWidth: number,
	resolveMetrics: LineMetricsResolver,
	metrics: TableMetrics,
): TableLayout {
	const columnWidths = solveTableColumns(block, availableWidth, metrics);
	const rowHeights: number[] = [];

	const measureRow = (cells: readonly PreparedTableCell[]): number => {
		let lines = 1;
		// A stacked formula (fraction, sum with limits) is taller than the text line
		// box, so the row's line height rises to the tallest formula in it — the same
		// adjustment `buildInlineBlock` makes for a paragraph. Shared with the render
		// layer via `tableRowLineHeight` so the two cannot diverge.
		const lineHeight = tableRowLineHeight(cells, block.lineHeight);
		for (let c = 0; c < cells.length && c < columnWidths.length; c++) {
			const cell = cells[c];
			const width = columnWidths[c];
			if (!cell || width === undefined) continue;
			// A cell measures exactly like an inline block, so it is adapted to the
			// shared resolver rather than calling pretext a second, divergent way.
			const { lineCount } = resolveMetrics(cellAsInlineBlock(cell, block.lineHeight), width);
			if (lineCount > lines) lines = lineCount;
		}
		return lines * lineHeight + metrics.paddingY * 2 + metrics.rowBorder;
	};

	if (block.header.length > 0) rowHeights.push(measureRow(block.header));
	for (const row of block.rows) rowHeights.push(measureRow(row));

	let tableWidth = 0;
	for (const width of columnWidths) tableWidth += width + metrics.paddingX * 2;

	const overflowing = tableWidth > availableWidth + 0.5;
	let height = overflowing ? metrics.scrollbarHeight : 0;
	for (const rowHeight of rowHeights) height += rowHeight;

	return { columnWidths, rowHeights, height, tableWidth, overflowing };
}

/**
 * Line box height (px) for one table row: the table's text line height, raised to
 * the tallest formula in the row.
 *
 * Exported because BOTH sides must agree — `layoutTable` reserves the row height
 * with it, and the render layer positions each cell's lines with it. If the render
 * layer used the plain `block.lineHeight` instead, a row containing a fraction
 * would reserve the taller box but paint its lines at the shorter pitch.
 */
export function tableRowLineHeight(
	cells: readonly PreparedTableCell[],
	baseLineHeight: number,
): number {
	let lineHeight = baseLineHeight;
	for (const cell of cells) {
		const mathHeight = cell?.mathHeight ?? 0;
		if (mathHeight > lineHeight) lineHeight = Math.ceil(mathHeight);
	}
	return lineHeight;
}

/**
 * Adapt a table cell to the `PreparedInlineBlock` shape the shared resolver
 * accepts. Only `flow` and `lineHeight` are read for metrics; the rest are inert
 * defaults, so this allocation stays a thin view rather than a second model.
 */
function cellAsInlineBlock(cell: PreparedTableCell, lineHeight: number): PreparedInlineBlock {
	return {
		kind: "inline",
		flow: cell.flow,
		lineHeight,
		classNames: cell.classNames,
		hrefs: cell.hrefs,
		fonts: cell.fonts,
		marginTop: 0,
		contentLeft: 0,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
}

/**
 * Accumulate an ElementFrame from prepared blocks at a concrete content width.
 * Pure arithmetic given the resolver — zero DOM.
 */
export function accumulateFrame(
	blocks: readonly PreparedBlock[],
	contentWidth: number,
	resolveMetrics: LineMetricsResolver,
	opts: {
		codePaddingY?: number;
		codePaddingX?: number;
		codeLangExtraTop?: number;
		quotePaddingY?: number;
		quoteMarginTop?: number;
		/** Table chrome; required for elements that can contain a table block. */
		table?: TableMetrics;
	} = {},
): ElementFrame {
	const codePaddingY = opts.codePaddingY ?? 0;
	const codePaddingX = opts.codePaddingX ?? 0;
	const codeLangExtraTop = opts.codeLangExtraTop ?? 0;
	const quotePaddingY = opts.quotePaddingY ?? 0;
	const quoteMarginTop = opts.quoteMarginTop ?? 0;
	const tableMetrics = opts.table ?? DEFAULT_TABLE_METRICS;

	const frames: BlockFrame[] = new Array(blocks.length);
	let y = 0;
	let usedWidth = 0;

	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		if (!block) continue;
		y += block.marginTop;

		let height: number;
		let blockUsedWidth: number;

		switch (block.kind) {
			case "inline": {
				const lineWidth = Math.max(1, contentWidth - block.contentLeft);
				const { lineCount, maxLineWidth } = resolveMetrics(block, lineWidth);
				height = lineCount * block.lineHeight;
				if (block.quoteRailLefts.length > 0) {
					height += quotePaddingY * 2 + quoteMarginTop;
				}
				blockUsedWidth = block.contentLeft + maxLineWidth;
				break;
			}
			case "code": {
				const boxWidth = Math.max(1, contentWidth - block.contentLeft);
				const innerWidth = Math.max(1, boxWidth - codePaddingX * 2);
				const { lineCount, maxLineWidth } = resolveMetrics(block, innerWidth);
				const langTop = block.lang != null ? codeLangExtraTop : 0;
				height = lineCount * block.lineHeight + codePaddingY * 2 + langTop;
				blockUsedWidth = block.contentLeft + maxLineWidth + codePaddingX * 2;
				break;
			}
			case "table": {
				const boxWidth = Math.max(1, contentWidth - block.contentLeft);
				const layout = layoutTable(block, boxWidth, resolveMetrics, tableMetrics);
				height = layout.height;
				// An overflowing table scrolls inside its own box, so it never reports
				// more than the space it was given — otherwise a shrink-wrap container
				// would grow to the full un-scrolled table width.
				blockUsedWidth = block.contentLeft + Math.min(layout.tableWidth, boxWidth);
				break;
			}
			case "rule":
				height = block.height;
				blockUsedWidth = block.contentLeft;
				break;
			case "fixed":
				height = block.height;
				// Same rationale as the unknown branch below: a block whose painted
				// width is known from data (aspect-fitted image) must report it, or a
				// shrink-wrap container clips it.
				blockUsedWidth = block.contentLeft + (block.displayWidth ?? 0);
				break;
			case "unknown":
				height = block.placeholderHeight;
				// A measured display formula knows its own width; reporting only
				// `contentLeft` would make a shrink-wrap container clip it.
				blockUsedWidth = block.contentLeft + (block.intrinsicWidth ?? 0);
				break;
		}

		frames[index] = { index, top: y, height, usedWidth: blockUsedWidth };
		y += height;
		if (blockUsedWidth > usedWidth) usedWidth = blockUsedWidth;
	}

	return { blocks: frames, contentHeight: y, usedWidth };
}
