/**
 * measure-tool-run.ts — Height model for the tool-run "trace" family, all built
 * on the shared CollapsibleTrace structure (batch-2 P9).
 *
 * Visual parity targets (do NOT import them — this is a zero-DOM measure copy):
 *   - CollapsibleTrace.tsx      — the content-agnostic header + row list + fold.
 *   - ToolRunSummary.tsx        — ToolRunSummary (L3) + ToolRunCountLine (L2).
 *   - ActivityTrace.tsx         — the unified L1/L2 activity fold.
 *   - ReasoningCountLine.tsx    — the L1/L2 single "reasoning ×N" line.
 *   - ReasoningStepsTrace.tsx   — reasoning trace whose steps expand to markdown.
 *
 * ── The CollapsibleTrace DOM (CONTRACT §4) ───────────────────────────────────
 *
 *   <Box py={2}>                              ← outer padding (2 top, 2 bottom)
 *     <Group py={2}>                          ← header row
 *       {collapseItems && chevron 12}
 *       <ThemeIcon 16> + <Text xs>label + <Text xs>count
 *     </Group>
 *     <LazyCollapse in={rowsOpened}>          ← 0-height when collapsed
 *       {hiddenCount>0 && <Group py={1}>dots + "show earlier"</Group>}
 *       {rows.map(<TraceRow/>)}
 *     </LazyCollapse>
 *   </Box>
 *
 *   TraceRow:
 *     <Box>
 *       <Group py={1}>chevron|dot 12 + <ThemeIcon 14>? + <Text xs truncate>title</Group>
 *       {expanded && <Box pl="lg" py={2} borderLeft:2px><MarkdownContent/></Box>}
 *     </Box>
 *
 * ── Line box convention ──────────────────────────────────────────────────────
 * The header / rows / count line are all `<Text size="xs">`, whose line box is
 * `12 × 1.4 = 16.8px` (Mantine line-height xs, laid out fractional by browsers).
 * CONTRACT §4 states these heights with the UNROUNDED 16.8 line (24.8 / 18.8 /
 * 20.8), so this module keeps it unrounded — deliberately different from
 * measure-reasoning.ts, which rounds the xs line to 17 (→ 21 count line). We use
 * package-local constant names so the two never collide.
 *
 * ── Derived fixed heights (px) ───────────────────────────────────────────────
 *   header band (collapsed, header only) = 2 + (4 + 16.8) + 2      ≈ 24.8
 *   trace row                            = 2 + max(14,12,16.8)     ≈ 18.8
 *   count line (Group py=2, no outer box)= 4 + max(16,16.8)        ≈ 20.8
 *
 * ── Expandable body (ReasoningStepsTrace only) ───────────────────────────────
 * A row's body is `Box pl="lg"(20) py={2} borderLeft:2px` wrapping MarkdownContent.
 * Like reasoning, the body renders at markdown `sm` (MarkdownContent.module.css
 * hard-codes p/li/… to sm), so we reuse measureMarkdown as-is (no xs variant).
 *   expanded row height = 18.8 + (2*2 + markdownHeight)
 *
 * Zero DOM. Fold is PROP-driven (collapseItems / itemsOpened / showEarlier /
 * per-row expanded) — this family does NOT read LOD (the caller picks the variant
 * + expand state from LOD upstream). Follows the measure-markdown / measure-
 * reasoning / measure-system-simple templates.
 */

import {
	accumulateFrame,
	type LineMetricsResolver,
	type MeasuredElement,
	type PreparedBlock,
	type PreparedFixedBlock,
} from "../prepared-block";
import { FONT_SIZE, LINE_HEIGHT, SPACING } from "../pretext-fonts";
import { measureMarkdown } from "./measure-markdown";

// ── Chrome constants (px) — CONTRACT §3/§4 + CollapsibleTrace.tsx ─────────────

/** Outer `<Box py={2}>` around the whole trace. */
export const TRACE_OUTER_PADDING_Y = 2;
/** Header `<Group py={2}>`. */
export const TRACE_HEADER_PADDING_Y = 2;
/** TraceRow / "show earlier" `<Group py={1}>`. */
export const TRACE_ROW_PADDING_Y = 1;
/** Header ThemeIcon size={16}. */
export const TRACE_HEADER_ICON = 16;
/** Per-row ThemeIcon size={14}. */
export const TRACE_ROW_ICON = 14;
/** Chevron / dot slot icon size (12). */
export const TRACE_CHEVRON = 12;

/**
 * xs single-line box = 12 × 1.4 = 16.8px, kept UNROUNDED (see file header). JS
 * float gives 16.799999…; tests assert with toBeCloseTo. Browsers lay out this
 * fractional line box, so the raw value is the most faithful prediction.
 */
export const TRACE_XS_LINE = FONT_SIZE.xs * LINE_HEIGHT.xs;

/** Header row content lane: max(icon 16, xs line 16.8) = 16.8. */
export const TRACE_HEADER_CONTENT = Math.max(TRACE_HEADER_ICON, TRACE_XS_LINE);
/** Header `<Group>` height: py*2 + content = 4 + 16.8 = 20.8. */
export const TRACE_HEADER_GROUP_HEIGHT = TRACE_HEADER_PADDING_Y * 2 + TRACE_HEADER_CONTENT;
/** Collapsed (header-only) band height: outer py*2 + header group = 4 + 20.8 = 24.8. */
export const TRACE_HEADER_BAND_HEIGHT = TRACE_OUTER_PADDING_Y * 2 + TRACE_HEADER_GROUP_HEIGHT;

/** Row content lane: max(row icon 14, chevron 12, xs line 16.8) = 16.8. */
export const TRACE_ROW_CONTENT = Math.max(TRACE_ROW_ICON, TRACE_CHEVRON, TRACE_XS_LINE);
/** Trace row height: py*2 + content = 2 + 16.8 = 18.8. Shared by rows + toggle. */
export const TRACE_ROW_HEIGHT = TRACE_ROW_PADDING_Y * 2 + TRACE_ROW_CONTENT;

/**
 * Standalone count line (ToolRunCountLine / ReasoningCountLine): a single
 * `<Group py={2}>` with NO outer Box wrapper → 4 + 16.8 = 20.8.
 */
export const TRACE_COUNT_LINE_HEIGHT = TRACE_HEADER_PADDING_Y * 2 + TRACE_HEADER_CONTENT;

// ── Expandable body chrome (ReasoningStepsTrace) ─────────────────────────────
/** Body `<Box py={2}>`. */
export const TRACE_BODY_PADDING_Y = 2;
/** Body `pl="lg"` = 20px. */
export const TRACE_BODY_PADDING_LEFT = SPACING.lg;
/** Body `borderLeft: 2px`. */
export const TRACE_BODY_BORDER_LEFT = 2;

// ── Default maxVisible per variant ───────────────────────────────────────────
/** Generic default (reasoning-style). */
export const TRACE_DEFAULT_MAX_VISIBLE = 5;
/** ToolRunSummary rows visible before the fold. */
export const TOOL_RUN_MAX_VISIBLE = 10;
/** ActivityTrace rows visible before the fold. */
export const ACTIVITY_MAX_VISIBLE = 10;
/** ReasoningStepsTrace step titles visible before the fold. */
export const REASONING_STEPS_MAX_VISIBLE = 5;

/** Inner content width of an expanded body (inside pl + borderLeft). */
export function traceBodyInnerWidth(contentWidth: number): number {
	return Math.max(1, contentWidth - TRACE_BODY_PADDING_LEFT - TRACE_BODY_BORDER_LEFT);
}

// ── Data types ───────────────────────────────────────────────────────────────

/** Which concrete trace this is (renderer picks header icon / colour / label). */
export type TraceVariant = "collapsible" | "tool-run-summary" | "activity" | "reasoning-steps";

/** One trace row. Title is single-line/truncated → height-neutral. */
export interface TraceItemData {
	/** Single-line truncated row title (never wraps → height-neutral). */
	title: string;
	/** Whether the row shows a leading 14px ThemeIcon. Height-neutral. */
	hasIcon?: boolean;
	/** Mantine colour for the row icon (renderer only). */
	iconColor?: string;
	/** Markdown body for an expandable row; null/empty → non-expandable dot row. */
	bodyText?: string | null;
	/** Streaming shimmer on this row (renderer only). */
	shimmer?: boolean;
	/** Stable row key (renderer only); falls back to the row index. */
	key?: string;
}

/** Trace payload. maxVisible + header labels default per variant. */
export interface CollapsibleTraceData {
	items: TraceItemData[];
	/** Rows visible before the "show earlier" fold. */
	maxVisible?: number;
	/** Which concrete trace (renderer visual). */
	variant?: TraceVariant;
	/** Header label text (height-neutral; renderer only). */
	headerLabel?: string;
	/** Header count text (height-neutral; renderer only). */
	headerCount?: string;
}

/** Prop-driven fold / expand state (upstream resolves this from LOD). */
export interface TraceExpandState {
	/** ActivityTrace L1: fold the whole row list behind the clickable header. */
	collapseItems?: boolean;
	/** When collapseItems, whether the user opened the folded list. */
	itemsOpened?: boolean;
	/** Whether "show earlier" is expanded (reveal all rows, not just the last N). */
	showEarlier?: boolean;
	/** Item indices whose expandable body is currently expanded. */
	expandedIndices?: readonly number[];
}

// ── Measured-row / header / toggle descriptors ───────────────────────────────

export interface MeasuredTraceHeader {
	/** Top offset (px) of the header Group (== outer top padding). */
	top: number;
	/** Header Group height (px) ≈ 20.8. */
	height: number;
	/** Whether a leading chevron is drawn (collapseItems). */
	hasChevron: boolean;
	/** Whether the folded list is currently open (itemsOpened). */
	opened: boolean;
	/** Header label / count (renderer). */
	label: string;
	count: string;
	variant: TraceVariant;
}

export interface MeasuredTraceToggle {
	/** Top offset (px) of the "show earlier" row. */
	top: number;
	/** Row height (px) ≈ 18.8. */
	height: number;
	/** How many rows are hidden behind the fold. */
	hiddenCount: number;
	/** Whether the fold is currently expanded. */
	showEarlier: boolean;
}

export interface MeasuredTraceRow {
	/** Index into the original items[]. */
	itemIndex: number;
	/** Stable render key. */
	key: string;
	/** Row title (single line, truncated by the renderer). */
	title: string;
	/** Whether a leading 14px icon is drawn. */
	hasIcon: boolean;
	/** Row icon colour (renderer). */
	iconColor?: string;
	/** Streaming shimmer flag (renderer). */
	shimmer: boolean;
	/** Whether this row has an expandable body. */
	expandable: boolean;
	/** Whether the body is currently expanded (height-affecting). */
	expanded: boolean;
	/** Top offset (px) of the row Group within the element. */
	top: number;
	/** The 18.8px row Group height (excludes any expanded body). */
	rowHeight: number;
	/** Row Group + expanded body total height (px). */
	blockHeight: number;
	/** Markdown body MeasuredElement when expanded, else null. */
	body: MeasuredElement | null;
	/** Top offset (px) where the body content begins (expanded only). */
	bodyTop: number;
	/** Left offset (px) of the body content (pl + border). */
	bodyLeft: number;
}

/**
 * A measured CollapsibleTrace — a MeasuredElement (blocks/frame carry the fixed
 * rows + expanded body placeholders) plus the structured geometry the renderer
 * needs to redraw the exact shape.
 */
export interface MeasuredCollapsibleTrace extends MeasuredElement {
	variant: TraceVariant;
	/** Collapsed (header-only) band height (px) ≈ 24.8. */
	headerBandHeight: number;
	/** True when the whole row list is folded → header only. */
	collapsedToHeader: boolean;
	header: MeasuredTraceHeader;
	toggle: MeasuredTraceToggle | null;
	/** Visible rows in order (the last maxVisible, or all when showEarlier). */
	rows: MeasuredTraceRow[];
	/** Total number of items (visible + hidden). */
	itemCount: number;
	/** Rows visible before the fold. */
	maxVisible: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Fixed blocks only → the resolver is never consulted (no pretext/canvas). */
const NO_TEXT_MEASURE: LineMetricsResolver = () => ({ lineCount: 1, maxLineWidth: 0 });

function fixedBlock(
	tag: string,
	height: number,
	marginTop: number,
	contentLeft: number,
	data?: Record<string, unknown>,
): PreparedFixedBlock {
	return {
		kind: "fixed",
		height,
		tag,
		data,
		marginTop,
		contentLeft,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
}

function isExpandable(item: TraceItemData): boolean {
	return typeof item.bodyText === "string" && item.bodyText.trim().length > 0;
}

function emptyTrace(
	contentWidth: number,
	variant: TraceVariant,
	maxVisible: number,
): MeasuredCollapsibleTrace {
	return {
		height: 0,
		blocks: [],
		frame: { blocks: [], contentHeight: 0, usedWidth: 0 },
		contentWidth,
		usedWidth: 0,
		variant,
		headerBandHeight: TRACE_HEADER_BAND_HEIGHT,
		collapsedToHeader: false,
		header: {
			top: 0,
			height: 0,
			hasChevron: false,
			opened: false,
			label: "",
			count: "",
			variant,
		},
		toggle: null,
		rows: [],
		itemCount: 0,
		maxVisible,
	};
}

// ── Core engine ──────────────────────────────────────────────────────────────

/**
 * Measure a CollapsibleTrace at a content width. Deterministic, zero DOM. Fold
 * is prop-driven via expandState. Only expanded rows with a markdown body invoke
 * pretext (via measureMarkdown); all other rows are fixed-height.
 */
export function measureCollapsibleTrace(
	data: CollapsibleTraceData,
	contentWidth: number,
	expandState: TraceExpandState = {},
): MeasuredCollapsibleTrace {
	const variant = data.variant ?? "collapsible";
	const maxVisible = data.maxVisible ?? TRACE_DEFAULT_MAX_VISIBLE;
	const items = data.items;

	// Original renders null for an empty trace.
	if (items.length === 0) return emptyTrace(contentWidth, variant, maxVisible);

	const collapseItems = !!expandState.collapseItems;
	const itemsOpened = !!expandState.itemsOpened;
	const rowsOpened = !collapseItems || itemsOpened;
	const showEarlier = !!expandState.showEarlier;
	const expandedSet = new Set(expandState.expandedIndices ?? []);

	const hiddenCount = Math.max(0, items.length - maxVisible);
	const hasToggleRow = rowsOpened && hiddenCount > 0;
	const startIndex = showEarlier ? 0 : hiddenCount;
	const visibleItems = rowsOpened ? items.slice(startIndex) : [];

	// ── Build the vertical block stack: header, [toggle], rows(+body), pad ──
	const blocks: PreparedBlock[] = [];

	// Header carries the outer TOP padding as its marginTop.
	blocks.push(
		fixedBlock("trace-header", TRACE_HEADER_GROUP_HEIGHT, TRACE_OUTER_PADDING_Y, 0, {
			variant,
			hasChevron: collapseItems,
			opened: itemsOpened,
			label: data.headerLabel ?? "",
			count: data.headerCount ?? "",
		}),
	);
	const toggleBlockIndex = hasToggleRow ? blocks.length : -1;
	if (hasToggleRow) {
		blocks.push(fixedBlock("trace-toggle", TRACE_ROW_HEIGHT, 0, 0, { hiddenCount, showEarlier }));
	}

	// Rows (with folded-in expanded bodies).
	const rowBlockIndices: number[] = [];
	const rowBodies: (MeasuredElement | null)[] = [];
	for (let vi = 0; vi < visibleItems.length; vi++) {
		const item = visibleItems[vi]!;
		const itemIndex = startIndex + vi;
		const expandable = isExpandable(item);
		const expanded = expandable && expandedSet.has(itemIndex);

		let blockHeight = TRACE_ROW_HEIGHT;
		let body: MeasuredElement | null = null;
		if (expanded) {
			const inner = traceBodyInnerWidth(contentWidth);
			body = measureMarkdown(item.bodyText ?? "", inner);
			blockHeight += TRACE_BODY_PADDING_Y * 2 + body.frame.contentHeight;
		}

		rowBlockIndices.push(blocks.length);
		rowBodies.push(body);
		blocks.push(
			fixedBlock("trace-row", blockHeight, 0, 0, {
				itemIndex,
				expandable,
				expanded,
				hasIcon: !!item.hasIcon,
			}),
		);
	}

	// Trailing outer BOTTOM padding.
	blocks.push(fixedBlock("trace-pad", TRACE_OUTER_PADDING_Y, 0, 0));

	// ── Resolve geometry (pure arithmetic; fixed blocks stack by marginTop) ──
	const frame = accumulateFrame(blocks, contentWidth, NO_TEXT_MEASURE);

	// ── Structured descriptors, tops read straight from the frame ──
	const headerFrame = frame.blocks[0]!;
	const header: MeasuredTraceHeader = {
		top: headerFrame.top,
		height: headerFrame.height,
		hasChevron: collapseItems,
		opened: itemsOpened,
		label: data.headerLabel ?? "",
		count: data.headerCount ?? "",
		variant,
	};

	let toggle: MeasuredTraceToggle | null = null;
	if (hasToggleRow && toggleBlockIndex >= 0) {
		const tf = frame.blocks[toggleBlockIndex]!;
		toggle = { top: tf.top, height: tf.height, hiddenCount, showEarlier };
	}

	const rows: MeasuredTraceRow[] = visibleItems.map((item, vi) => {
		const itemIndex = startIndex + vi;
		const blockIndex = rowBlockIndices[vi]!;
		const bf = frame.blocks[blockIndex]!;
		const body = rowBodies[vi] ?? null;
		const expandable = isExpandable(item);
		const expanded = body != null;
		return {
			itemIndex,
			key: item.key ?? `row-${itemIndex}`,
			title: item.title,
			hasIcon: !!item.hasIcon,
			iconColor: item.iconColor,
			shimmer: !!item.shimmer,
			expandable,
			expanded,
			top: bf.top,
			rowHeight: TRACE_ROW_HEIGHT,
			blockHeight: bf.height,
			body,
			bodyTop: expanded
				? bf.top + TRACE_ROW_HEIGHT + TRACE_BODY_PADDING_Y
				: bf.top + TRACE_ROW_HEIGHT,
			bodyLeft: TRACE_BODY_PADDING_LEFT + TRACE_BODY_BORDER_LEFT,
		};
	});

	return {
		height: frame.contentHeight,
		blocks,
		frame,
		contentWidth,
		usedWidth: contentWidth,
		variant,
		headerBandHeight: TRACE_HEADER_BAND_HEIGHT,
		collapsedToHeader: !rowsOpened,
		header,
		toggle,
		rows,
		itemCount: items.length,
		maxVisible,
	};
}

// ── Variant wrappers ─────────────────────────────────────────────────────────

/** ToolRunSummary row input (no bodies — L3 is titles-only). */
export interface ToolRunSummaryItem {
	title: string;
	hasIcon?: boolean;
	iconColor?: string;
	shimmer?: boolean;
	key?: string;
}

/** Optional header labels for a trace (height-neutral). */
export interface TraceHeaderLabels {
	label?: string;
	count?: string;
}

/**
 * L3 — ToolRunSummary: a frameless CollapsibleTrace, maxVisible=10, every body
 * null (titles only) → header + min(N,10) rows (+ toggle when N>10).
 */
export function measureToolRunSummary(
	items: ToolRunSummaryItem[],
	contentWidth: number,
	expandState: TraceExpandState = {},
	labels: TraceHeaderLabels = {},
): MeasuredCollapsibleTrace {
	return measureCollapsibleTrace(
		{
			items: items.map((it) => ({ ...it, bodyText: null })),
			maxVisible: TOOL_RUN_MAX_VISIBLE,
			variant: "tool-run-summary",
			headerLabel: labels.label,
			headerCount: labels.count,
		},
		contentWidth,
		expandState,
	);
}

/** ActivityTrace row input (no bodies — L1/L2 is titles-only). */
export interface ActivityTraceItem {
	title: string;
	hasIcon?: boolean;
	iconColor?: string;
	shimmer?: boolean;
	key?: string;
}

/**
 * L1/L2 — ActivityTrace: maxVisible=10, bodies null. `collapsed` (L1) folds the
 * whole list behind the header (→ header only, 24.8px); L2 shows its rows.
 */
export function measureActivityTrace(
	items: ActivityTraceItem[],
	contentWidth: number,
	expandState: TraceExpandState & { collapsed?: boolean } = {},
	labels: TraceHeaderLabels = {},
): MeasuredCollapsibleTrace {
	// `collapsed` is the ActivityTrace prop name for CollapsibleTrace.collapseItems.
	const collapseItems = expandState.collapseItems ?? expandState.collapsed;
	return measureCollapsibleTrace(
		{
			items: items.map((it) => ({ ...it, bodyText: null })),
			maxVisible: ACTIVITY_MAX_VISIBLE,
			variant: "activity",
			headerLabel: labels.label,
			headerCount: labels.count,
		},
		contentWidth,
		{ ...expandState, collapseItems },
	);
}

/** ReasoningStepsTrace step input — body is the step's markdown. */
export interface ReasoningStepItem {
	title: string;
	/** Step markdown body; null/empty → a non-expandable title row. */
	body?: string | null;
	shimmer?: boolean;
	key?: string;
}

/**
 * ReasoningStepsTrace: maxVisible=5, each step's body is markdown. `titlesOnly`
 * drops all bodies (→ pure title rows). Expanded steps add
 * `2*bodyPadY + markdownHeight` under their 18.8px row.
 */
export function measureReasoningStepsTrace(
	steps: ReasoningStepItem[],
	contentWidth: number,
	expandState: TraceExpandState & { titlesOnly?: boolean } = {},
	labels: TraceHeaderLabels = {},
): MeasuredCollapsibleTrace {
	const titlesOnly = !!expandState.titlesOnly;
	return measureCollapsibleTrace(
		{
			items: steps.map((s) => ({
				title: s.title,
				hasIcon: false,
				bodyText: titlesOnly ? null : (s.body ?? null),
				shimmer: s.shimmer,
				key: s.key,
			})),
			maxVisible: REASONING_STEPS_MAX_VISIBLE,
			variant: "reasoning-steps",
			headerLabel: labels.label,
			headerCount: labels.count,
		},
		contentWidth,
		expandState,
	);
}

// ── Count lines (standalone single row, no CollapsibleTrace wrapper) ─────────

/** Which count line this is (renderer icon / colour / label). */
export type TraceCountLineKind = "tool" | "reasoning";

/** A measured single-row count line. `blocks[0]` is a PreparedFixedBlock. */
export interface MeasuredTraceCountLine extends MeasuredElement {
	kind: TraceCountLineKind;
	count: number;
}

function measureTraceCountLine(
	kind: TraceCountLineKind,
	count: number,
	contentWidth: number,
	labels: TraceHeaderLabels = {},
): MeasuredTraceCountLine {
	const block = fixedBlock("trace-count-line", TRACE_COUNT_LINE_HEIGHT, 0, 0, {
		kind,
		count,
		label: labels.label ?? "",
		count_label: labels.count ?? "",
	});
	const frame = accumulateFrame([block], contentWidth, NO_TEXT_MEASURE);
	return {
		height: frame.contentHeight,
		blocks: [block],
		frame,
		contentWidth,
		usedWidth: contentWidth,
		kind,
		count,
	};
}

/** L2 — ToolRunCountLine: single "🔧 Tool calls · N" row ≈ 20.8px. */
export function measureToolRunCountLine(
	count: number,
	contentWidth: number,
	labels: TraceHeaderLabels = {},
): MeasuredTraceCountLine {
	return measureTraceCountLine("tool", count, contentWidth, labels);
}

/**
 * L1/L2 — ReasoningCountLine: single "🧠 reasoning · N" row ≈ 20.8px. Provided
 * here (package-local) so P1/measure-reasoning need not re-derive it; note it is
 * 20.8 (unrounded xs), distinct from measure-reasoning's rounded 21.
 */
export function measureReasoningCountLine(
	count: number,
	contentWidth: number,
	labels: TraceHeaderLabels = {},
): MeasuredTraceCountLine {
	return measureTraceCountLine("reasoning", count, contentWidth, labels);
}

export const MEASURE_TOOL_RUN_CONSTANTS = {
	TRACE_OUTER_PADDING_Y,
	TRACE_HEADER_PADDING_Y,
	TRACE_ROW_PADDING_Y,
	TRACE_HEADER_ICON,
	TRACE_ROW_ICON,
	TRACE_CHEVRON,
	TRACE_XS_LINE,
	TRACE_HEADER_CONTENT,
	TRACE_HEADER_GROUP_HEIGHT,
	TRACE_HEADER_BAND_HEIGHT,
	TRACE_ROW_CONTENT,
	TRACE_ROW_HEIGHT,
	TRACE_COUNT_LINE_HEIGHT,
	TRACE_BODY_PADDING_Y,
	TRACE_BODY_PADDING_LEFT,
	TRACE_BODY_BORDER_LEFT,
	TOOL_RUN_MAX_VISIBLE,
	ACTIVITY_MAX_VISIBLE,
	REASONING_STEPS_MAX_VISIBLE,
} as const;
