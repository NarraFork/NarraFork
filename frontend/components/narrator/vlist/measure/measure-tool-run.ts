/**
 * measure-tool-run.ts — Height model for the tool-run "trace" family, all built
 * on the shared CollapsibleTrace structure (batch-2 P9).
 *
 * Visual parity targets (do NOT import them — this is a zero-DOM measure copy):
 *   - CollapsibleTrace.tsx      — the content-agnostic header + row list + fold.
 *   - ToolRunSummary.tsx        — ToolRunCountLine (L1/L2).
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
 *       <Group py={1}>chevron|dot 12 + <ThemeIcon 14>? + <Text xs truncate>title
 *                     + status glyph 12? + timing?</Group>
 *       {expanded && <Box pl="lg" py={2} borderLeft:2px><MarkdownContent/></Box>}
 *     </Box>
 *
 * The trailing status glyph (12px fixed slot) and timing text (one nowrap xs span,
 * 16.8px line) both fit INSIDE the row's existing 16.8px content lane, so a row
 * carrying them measures exactly the same 18.8px as one that does not — see
 * `TRACE_ROW_CONTENT`. Only reasoning rows omit them, and they are unaffected.
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
 * ── Expandable body (reasoning-step rows: standalone trace + activity fold) ──
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
	BARE_ROW_CHEVRON,
	BARE_ROW_CONTENT,
	BARE_ROW_GAP,
	BARE_ROW_HEIGHT,
	BARE_ROW_ICON,
	BARE_ROW_PADDING_Y,
	BARE_ROW_STATUS,
	BARE_XS_LINE,
} from "@shared/pretext-layout/row-metrics";
// Type-only: the row identity the adapter attaches and the renderer consumes.
// A type import adds no runtime dependency and stays clear of the measure math.
import type { AdapterTraceRowIdentity } from "@shared/pretext-layout/segment-adapter";
import {
	accumulateFrame,
	DEFAULT_RENDER_LOD,
	type LineMetricsResolver,
	type MeasuredElement,
	type PreparedBlock,
	type PreparedFixedBlock,
	type RenderLod,
} from "../prepared-block";
import { SPACING } from "../pretext-fonts";
import { measureMarkdown } from "./measure-markdown";
// The drilled-in SUBAGENT card (an Agent/Task/Send row reveals the same card it
// gets at L3+). Not a cycle: measure-subagent sources its row height from
// `@shared/pretext-layout/row-metrics` directly, so this edge is the only one
// between the two modules.
import {
	BADGE_ROW_HEIGHT,
	DESC_LEFT,
	DESC_MARGIN_TOP,
	type MeasuredSubagent,
	measureSubagentCard,
	CARD_BORDER as SUBAGENT_CARD_BORDER,
	CARD_PADDING as SUBAGENT_CARD_PADDING,
	type SubagentCardData,
	XS_LINE_HEIGHT,
} from "./measure-subagent";
// The drill-down card. NOT a cycle: measure-tool-call depends on markdown /
// media / permission / reflection / pretext-metrics and never on this module.
import {
	CARD_BORDER,
	CARD_PADDING,
	HEADER_ROW_HEIGHT,
	type MeasuredToolCall,
	measureToolCall,
	resolveToolTimingStamps,
	type ToolCallData,
	type ToolTimingStamps,
} from "./measure-tool-call";

// ── Chrome constants (px) — CONTRACT §3/§4 + CollapsibleTrace.tsx ─────────────
//
// The per-ROW numbers live in `@shared/pretext-layout/row-metrics` so other measure
// modules can share them without importing this one (which would close a cycle).
// They keep their original names below so every caller and test here is unaffected.

/** Outer `<Box py={2}>` around the whole trace. */
export const TRACE_OUTER_PADDING_Y = 2;
/** Header `<Group py={2}>`. */
export const TRACE_HEADER_PADDING_Y = 2;
/** TraceRow / "show earlier" `<Group py={1}>`. */
export const TRACE_ROW_PADDING_Y = BARE_ROW_PADDING_Y;
/** Header ThemeIcon size={16}. */
export const TRACE_HEADER_ICON = 16;
/** Per-row ThemeIcon size={14}. */
export const TRACE_ROW_ICON = BARE_ROW_ICON;
/** Chevron / dot slot icon size (12). */
export const TRACE_CHEVRON = BARE_ROW_CHEVRON;

/**
 * xs single-line box = 12 × 1.4 = 16.8px, kept UNROUNDED (see file header). JS
 * float gives 16.799999…; tests assert with toBeCloseTo. Browsers lay out this
 * fractional line box, so the raw value is the most faithful prediction.
 */
export const TRACE_XS_LINE = BARE_XS_LINE;

/** Header row content lane: max(icon 16, xs line 16.8) = 16.8. */
export const TRACE_HEADER_CONTENT = Math.max(TRACE_HEADER_ICON, TRACE_XS_LINE);
/** Header `<Group>` height: py*2 + content = 4 + 16.8 = 20.8. */
export const TRACE_HEADER_GROUP_HEIGHT = TRACE_HEADER_PADDING_Y * 2 + TRACE_HEADER_CONTENT;
/** Collapsed (header-only) band height: outer py*2 + header group = 4 + 20.8 = 24.8. */
export const TRACE_HEADER_BAND_HEIGHT = TRACE_OUTER_PADDING_Y * 2 + TRACE_HEADER_GROUP_HEIGHT;

/** Trailing status glyph size (12) — same slot the chunk path reserves. */
export const TRACE_ROW_STATUS = BARE_ROW_STATUS;
/**
 * Gap between a trace row's cells (`<Group gap={6}>`).
 *
 * Horizontal only, so it never enters a height computation; it lives here so the
 * trace rows and the subagent card's recent-call rows — which are the same row —
 * read it from one place instead of both hard-coding `6`.
 */
export const TRACE_ROW_GAP = BARE_ROW_GAP;
/**
 * Row content lane: max(row icon 14, chevron 12, status 12, xs line 16.8) = 16.8.
 *
 * The xs text line dominates every glyph in the row, which is precisely why the
 * trailing status + timing slots are height-neutral: adding them cannot raise this
 * max, so `TRACE_ROW_HEIGHT` is unchanged.
 */
export const TRACE_ROW_CONTENT = BARE_ROW_CONTENT;
/** Trace row height: py*2 + content = 2 + 16.8 = 18.8. Shared by rows + toggle. */
export const TRACE_ROW_HEIGHT = BARE_ROW_HEIGHT;

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
export type TraceVariant = "collapsible" | "activity" | "reasoning-steps";

/** One trace row. Title is single-line/truncated → height-neutral. */
export interface TraceItemData {
	/** Single-line truncated row title (never wraps → height-neutral). */
	title: string;
	/** Whether the row shows a leading 14px ThemeIcon. Height-neutral. */
	hasIcon?: boolean;
	/** Mantine colour for the row icon (renderer only). */
	iconColor?: string;
	/** Tool name for picking the real category glyph (renderer only). */
	toolName?: string;
	/** Resolved tool category for the glyph (renderer only). */
	category?: string;
	/** Markdown body for an expandable row; null/empty → non-expandable dot row. */
	bodyText?: string | null;
	/** Streaming shimmer on this row (renderer only). */
	shimmer?: boolean;
	/**
	 * A live reflection gate's status (renderer only; height-neutral).
	 *
	 * Selects the row's shimmer colour — purple while a gate deliberates — and nothing
	 * else. See `@shared/tool-shimmer` for why the tool's own `pending` status cannot
	 * express this on its own.
	 */
	reflectionStatus?: string;
	/** Stable row key (renderer only); falls back to the row index. */
	key?: string;
	/**
	 * Raw tool status for the row's trailing glyph (renderer only).
	 *
	 * HEIGHT-NEUTRAL: the glyph is a fixed 12px flex slot, well inside the row's
	 * 16.8px content lane (`TRACE_ROW_CONTENT`), so a row with a status is exactly
	 * as tall as one without. A row that carries none draws no slot at all, which is
	 * what keeps reasoning rows byte-identical.
	 */
	status?: string | null;
	/**
	 * Lifecycle stamps for the row's trailing timing text (renderer only).
	 *
	 * HEIGHT-NEUTRAL for the same reason the tool card's header timing is: an
	 * elapsed counter / final duration is one nowrap span sharing the row's fixed
	 * line, and the breakdown popover is portaled.
	 */
	timing?: Partial<ToolTimingStamps> | null;
	/**
	 * Selection / context-menu coordinates for this row (renderer only).
	 *
	 * Pure passthrough, exactly like `toolName` / `category` / `iconColor`: the
	 * measure layer NEVER reads it. The renderer turns it into a row interaction
	 * surface whose selection outline uses `outline` and whose menus/modals are
	 * portaled, so an interactive row occupies precisely the predicted height.
	 * (`measure-tool-run.test.ts` asserts heights are identical with and without it.)
	 */
	identity?: AdapterTraceRowIdentity;
	/**
	 * LOD-independent identity of this row's content. Pure passthrough like
	 * `identity` — the measure layer never reads it. It exists so a folded row and
	 * the full card the same content becomes at L3+ can be paired across a level
	 * change (both carry `tool-<toolUseId>`); the renderer emits it as
	 * `data-nf-unit`.
	 */
	unitId?: string;
	/**
	 * This row can be drilled into: a real tool call whose card can be nested under
	 * the title line.
	 *
	 * Makes the row `expandable` (chevron instead of the "•" dot) WITHOUT changing
	 * its collapsed height — the chevron and the dot share the same fixed 12px slot.
	 */
	canDrillDown?: boolean;
	/**
	 * The nested card payload, present only on a row the reader actually drilled
	 * into.
	 *
	 * Height-bearing when expanded: the row grows by the measured card plus the body
	 * box padding. Absent on collapsed rows by design — the adapter does not
	 * classify a payload until its row is opened, so a several-hundred-row fold
	 * stays as cheap as it was before drill-down existed.
	 *
	 * `ToolCallData` for an ordinary tool, `SubagentCardData` when `cardKind` is
	 * "subagent-card": a subagent row must reveal the SAME card it gets at L3+.
	 */
	card?: ToolCallData | SubagentCardData;
	/**
	 * Which card `card` holds. Absent means "tool-call", the overwhelmingly common
	 * case — every pre-existing producer (and drill-down test) leaves it unset.
	 */
	cardKind?: "tool-call" | "subagent-card";
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
	/**
	 * Viewport height, forwarded to a drilled-in card's own measure.
	 *
	 * Only ExitPlanMode plans read it (their detail caps at 0.85 × viewport instead
	 * of a fixed 400px), so an absent value simply leaves that one cap on its
	 * fallback — the same contract `measureToolCall` already has.
	 */
	viewportHeight?: number;
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
	/** Raw tool status for the trailing glyph (renderer only; height-neutral). */
	status: string | null;
	/**
	 * Lifecycle stamps for the trailing timing text (renderer only; height-neutral).
	 * Null when the row carried none, so the slot is skipped entirely.
	 */
	timing: ToolTimingStamps | null;
	/** Tool name for picking the real category glyph (renderer only). */
	toolName?: string;
	/** Resolved tool category for the glyph (renderer only). */
	category?: string;
	/** Streaming shimmer flag (renderer). */
	shimmer: boolean;
	/** Live reflection-gate status for the shimmer colour (renderer; height-neutral). */
	reflectionStatus?: string;
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
	/**
	 * The nested card when this row is drilled into, else null.
	 *
	 * Mutually exclusive with `body`: a row either drills into a card (tool rows) or
	 * expands a markdown body (reasoning steps), never both.
	 *
	 * A `MeasuredSubagent` when `cardKind` is "subagent-card" — the measure layer
	 * dispatches on the row's `cardKind` so a folded Agent call reveals its
	 * subagent card, not the generic tool card.
	 */
	cardMeasured: MeasuredToolCall | MeasuredSubagent | null;
	/** Which card `cardMeasured` holds (meaningful only when it is non-null). */
	cardKind: "tool-call" | "subagent-card";
	/** Whether this row offers a drill-down (chevron present, card available). */
	canDrillDown: boolean;
	/** Top offset (px) where the body content begins (expanded only). */
	bodyTop: number;
	/** Left offset (px) of the body content (pl + border). */
	bodyLeft: number;
	/**
	 * Drill-down header morph target: the nested card's HEADER row rect in the
	 * row-block coordinate system (drilled-in rows only, else null).
	 *
	 * The drilled-in card fills the row block from its top (the summary row is not
	 * rendered — the card's header visually takes its place). This is the pure
	 * arithmetic the header-morph controller needs to place the outgoing summary
	 * row over the incoming card header, so neither the render nor the motion
	 * layer re-derives it (and no DOM is ever read). Height-neutral: it only
	 * restates geometry `cardMeasured` + the chrome constants already decided.
	 */
	drillHeader: {
		/** Header row-box top within the row block (border + card padding). */
		top: number;
		/** Header row-box left within the row block (border + card padding). */
		left: number;
		/** Header row-box width (card inner width). */
		width: number;
		/** Header row-box height (`HEADER_ROW_HEIGHT`). */
		height: number;
	} | null;
	/** Selection / context-menu coordinates (renderer only; height-neutral). */
	identity?: AdapterTraceRowIdentity;
	/**
	 * LOD-independent identity of this row's content (renderer only; height-neutral).
	 * Matches the `unitId` of the full card the same content renders as at L3+, so
	 * the two can be paired across a level change. See `TraceItemData.unitId`.
	 */
	unitId?: string;
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

/**
 * A row is expandable when it has SOMETHING to reveal: a markdown body
 * (reasoning steps) or a drill-down card (tool rows).
 *
 * `canDrillDown` is deliberately independent of `card`: the flag decides whether
 * the chevron is drawn, while the card only arrives once the row is expanded. If
 * the two were conflated a collapsed tool row would show a "•" and be unclickable
 * — i.e. there would be no way to ever ask for the card.
 */
function isExpandable(item: TraceItemData): boolean {
	if (item.canDrillDown === true) return true;
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
 * is prop-driven via expandState. Only expanded rows do real work: a markdown
 * body invokes pretext (via measureMarkdown), a drill-down row nests a real
 * `measureToolCall`. Every other row is fixed-height.
 *
 * `lod` is forwarded to a nested card ONLY for its detail measurement; the card's
 * expand decision is overridden (`lodUserOverride`) because a drilled-in row is by
 * definition an explicit user request, and `resolveToolCallOpened` returns false
 * for every level a fold exists at (L1-L4).
 */
export function measureCollapsibleTrace(
	data: CollapsibleTraceData,
	contentWidth: number,
	expandState: TraceExpandState = {},
	lod: RenderLod = DEFAULT_RENDER_LOD,
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

	// Rows (with folded-in expanded bodies / drilled-in cards).
	const rowBlockIndices: number[] = [];
	const rowBodies: (MeasuredElement | null)[] = [];
	const rowCards: (MeasuredToolCall | MeasuredSubagent | null)[] = [];
	for (let vi = 0; vi < visibleItems.length; vi++) {
		const item = visibleItems[vi]!;
		const itemIndex = startIndex + vi;
		const expandable = isExpandable(item);
		const expanded = expandable && expandedSet.has(itemIndex);

		let blockHeight = TRACE_ROW_HEIGHT;
		let body: MeasuredElement | null = null;
		let card: MeasuredToolCall | MeasuredSubagent | null = null;
		if (expanded) {
			if (item.card) {
				// Drill-down: a standalone (bordered) card, exactly like a grouped card's
				// child. `lodUserOverride` is what opens it — see the fn doc.
				//
				// The card fills the WHOLE row block (full row width, from the block's
				// top): the summary title row is NOT painted for a drilled-in row — the
				// card's own header morphs into its place, so the row block IS the card
				// (`blockHeight === card.height`). No `traceBodyInnerWidth`, no indent.
				//
				// Dispatched by KIND: a subagent row measures its SubagentCard, so the
				// drilled-in geometry is the same one the standalone L3+ card reports.
				card =
					item.cardKind === "subagent-card"
						? measureSubagentCard(item.card as SubagentCardData, contentWidth, lod, {
								lodUserOverride: true,
								isRecent: true,
								inRun: false,
								isLast: true,
							})
						: measureToolCall({ ...(item.card as ToolCallData), inRun: false }, contentWidth, lod, {
								lodUserOverride: true,
								isRecent: true,
								viewportHeight: expandState.viewportHeight,
							});
				blockHeight = card.height;
			} else if (typeof item.bodyText === "string" && item.bodyText.trim().length > 0) {
				const inner = traceBodyInnerWidth(contentWidth);
				body = measureMarkdown(item.bodyText, inner);
				blockHeight += TRACE_BODY_PADDING_Y * 2 + body.frame.contentHeight;
			}
		}

		rowBlockIndices.push(blocks.length);
		rowBodies.push(body);
		rowCards.push(card);
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
		const cardMeasured = rowCards[vi] ?? null;
		const cardKind: "tool-call" | "subagent-card" =
			item.cardKind === "subagent-card" ? "subagent-card" : "tool-call";
		const expandable = isExpandable(item);
		// A drilled-in row reports `expanded` too, so the renderer draws the open
		// chevron and paints the body box for either kind of revealed content.
		const expanded = body != null || cardMeasured != null;
		// Header morph target (drilled-in rows only). The card is drawn at the row
		// block's origin across the FULL row width, so its header row sits at
		// `border + padding` inside the block. Pure restatement of the card chrome —
		// the morph controller animates the outgoing summary row toward this rect.
		//
		// Per KIND: a tool card's successor of the folded summary row is its header
		// line (`Read · file.ts`); a subagent card's is its DESCRIPTION line — the
		// badge row above it carries chips, not the title text the row showed.
		let drillHeader: MeasuredTraceRow["drillHeader"] = null;
		if (cardMeasured != null) {
			if (cardKind === "subagent-card") {
				const border =
					(cardMeasured as MeasuredSubagent).borderHeight > 0 ? SUBAGENT_CARD_BORDER : 0;
				drillHeader = {
					top: border + SUBAGENT_CARD_PADDING + BADGE_ROW_HEIGHT + DESC_MARGIN_TOP,
					left: border + SUBAGENT_CARD_PADDING + DESC_LEFT,
					width: Math.max(1, contentWidth - 2 * (border + SUBAGENT_CARD_PADDING) - DESC_LEFT),
					height: XS_LINE_HEIGHT,
				};
			} else {
				const drillBorder = (cardMeasured as MeasuredToolCall).hasBorder ? CARD_BORDER : 0;
				drillHeader = {
					top: drillBorder + CARD_PADDING,
					left: drillBorder + CARD_PADDING,
					width: Math.max(1, contentWidth - 2 * (drillBorder + CARD_PADDING)),
					height: HEADER_ROW_HEIGHT,
				};
			}
		}
		return {
			itemIndex,
			key: item.key ?? `row-${itemIndex}`,
			title: item.title,
			hasIcon: !!item.hasIcon,
			iconColor: item.iconColor,
			toolName: item.toolName,
			category: item.category,
			// Status / timing are pure PASSTHROUGH: neither appears in any height
			// computation above. `timing` is normalized here (not in the renderer) so
			// the render layer never re-parses wire shapes, mirroring measure-subagent's
			// `recentCallTimings`.
			status: item.status ?? null,
			timing: item.timing ? resolveToolTimingStamps(item.timing) : null,
			shimmer: !!item.shimmer,
			reflectionStatus: item.reflectionStatus,
			expandable,
			expanded,
			top: bf.top,
			rowHeight: TRACE_ROW_HEIGHT,
			blockHeight: bf.height,
			body,
			cardMeasured,
			cardKind,
			canDrillDown: item.canDrillDown === true,
			// A drilled-in card starts at the row block's top (no summary row above
			// it); a markdown body still sits below the 18.8px row it belongs to.
			bodyTop:
				cardMeasured != null
					? bf.top
					: expanded
						? bf.top + TRACE_ROW_HEIGHT + TRACE_BODY_PADDING_Y
						: bf.top + TRACE_ROW_HEIGHT,
			bodyLeft: cardMeasured != null ? 0 : TRACE_BODY_PADDING_LEFT + TRACE_BODY_BORDER_LEFT,
			drillHeader,
			// Passthrough only — never used above in any height computation.
			identity: item.identity,
			unitId: item.unitId,
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

/** Optional header labels for a trace (height-neutral). */
export interface TraceHeaderLabels {
	label?: string;
	count?: string;
}

/**
 * ActivityTrace row input.
 *
 * Two independent reveal channels, mutually exclusive per row: a tool row DRILLS
 * DOWN into its card (`card`), a reasoning-step row EXPANDS its markdown
 * (`bodyText`). Both make the row `expandable`, i.e. give it a chevron instead of
 * the "•" dot, at the same collapsed height.
 */
export interface ActivityTraceItem {
	title: string;
	hasIcon?: boolean;
	iconColor?: string;
	shimmer?: boolean;
	/** Live reflection-gate status for the shimmer colour (renderer; height-neutral). */
	reflectionStatus?: string;
	key?: string;
	/** Trailing status glyph (renderer only; height-neutral). */
	status?: string | null;
	/** Trailing timing text (renderer only; height-neutral). */
	timing?: Partial<ToolTimingStamps> | null;
	/** Row offers a drill-down chevron (height-neutral while collapsed). */
	canDrillDown?: boolean;
	/**
	 * Nested card payload, present only on a drilled-in row. A `SubagentCardData`
	 * when `cardKind` is "subagent-card" (an Agent/Task/Send row reveals the same
	 * card it renders as at L3+), otherwise a `ToolCallData`.
	 */
	card?: ToolCallData | SubagentCardData;
	/** Which card `card` holds; absent means "tool-call". */
	cardKind?: "tool-call" | "subagent-card";
	/**
	 * Markdown body for a REASONING-STEP row; null/absent → no body to reveal.
	 *
	 * Height-bearing when its row is expanded, exactly like the step rows of a
	 * standalone reasoning trace: the row grows by `2*bodyPadY + markdownHeight`.
	 * The adapter supplies it only for a settled step with real content — a live
	 * step's body is truncated to one line for cost reasons, so a live row carries
	 * none and stays non-expandable.
	 */
	bodyText?: string | null;
}

/**
 * L1/L2 — ActivityTrace: maxVisible=10. `collapsed` (L1) folds the whole list
 * behind the header (→ header only, 24.8px); L2 shows its rows.
 *
 * Row bodies are passed THROUGH (not nulled): a reasoning-step row carries the
 * step's markdown so the reader can open one step of a folded run. Tool rows carry
 * no `bodyText` and reveal their card via `card` instead.
 */
export function measureActivityTrace(
	items: ActivityTraceItem[],
	contentWidth: number,
	expandState: TraceExpandState & { collapsed?: boolean } = {},
	labels: TraceHeaderLabels = {},
	lod: RenderLod = DEFAULT_RENDER_LOD,
): MeasuredCollapsibleTrace {
	// `collapsed` is the ActivityTrace prop name for CollapsibleTrace.collapseItems.
	const collapseItems = expandState.collapseItems ?? expandState.collapsed;
	return measureCollapsibleTrace(
		{
			items: items.map((it) => ({ ...it, bodyText: it.bodyText ?? null })),
			maxVisible: ACTIVITY_MAX_VISIBLE,
			variant: "activity",
			headerLabel: labels.label,
			headerCount: labels.count,
		},
		contentWidth,
		{ ...expandState, collapseItems },
		lod,
	);
}

/** ReasoningStepsTrace step input — body is the step's markdown. */
export interface ReasoningStepItem {
	title: string;
	/** Step markdown body; null/empty → a non-expandable title row. */
	body?: string | null;
	shimmer?: boolean;
	key?: string;
	/**
	 * LOD-independent identity of this step, matching the `unitId` of the folded
	 * `activity-trace` row the same step becomes at L1/L2 (see `TraceItemData.unitId`).
	 * Render-only passthrough; never read for layout.
	 */
	unitId?: string;
}

/**
 * ReasoningStepsTrace: maxVisible=5, each step's body is markdown. Expanded steps
 * add `2*bodyPadY + markdownHeight` under their 18.8px row.
 *
 * LOD-independent by design: there is no level at which a visible step title has
 * an unopenable body (the former `titlesOnly` mode). The trace looks the same at
 * every level; only which steps the reader opened varies.
 */
export function measureReasoningStepsTrace(
	steps: ReasoningStepItem[],
	contentWidth: number,
	expandState: TraceExpandState = {},
	labels: TraceHeaderLabels = {},
): MeasuredCollapsibleTrace {
	return measureCollapsibleTrace(
		{
			items: steps.map((s) => ({
				title: s.title,
				hasIcon: false,
				bodyText: s.body ?? null,
				shimmer: s.shimmer,
				key: s.key,
				// Passthrough so the step row paints `data-nf-unit` and can be paired with
				// its folded counterpart across an LOD switch. Height-neutral.
				unitId: s.unitId,
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
	TRACE_ROW_STATUS,
	TRACE_ROW_GAP,
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
	ACTIVITY_MAX_VISIBLE,
	REASONING_STEPS_MAX_VISIBLE,
} as const;
