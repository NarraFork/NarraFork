/**
 * measure-system-simple.ts — Fixed-height system cards (single-line / clamped).
 *
 * Covers the batch-2 P4 family: every card here renders a SINGLE line whose text
 * is force-clamped (truncate / lineClamp={1}), so the height NEVER depends on the
 * text content. Each kind therefore has one constant height — zero pretext, zero
 * DOM measurement. All blocks are `PreparedFixedBlock`.
 *
 * Two height shapes (see CONTRACT.md §4 and MessageBubble.tsx):
 *
 *   ┌ center-row (compact / segment_compact) ────────────────────────────────┐
 *   │  <Group justify="center" py={4}> icon(14) + <Text size="xs">           │
 *   │  height = 4×2 + max(icon 14, xs line 17) = 25px                         │
 *   └────────────────────────────────────────────────────────────────────────┘
 *   ┌ paper-row (merge_summary) ─────────────────────────────────────────────┐
 *   │  <Paper p="xs"> <Group> icon(16)|Badge(16) + <Text size="xs" clamp>     │
 *   │  height = 10×2 + max(icon/badge 16, xs line 17) = 37px                  │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 * Chrome constants come from CONTRACT.md §3/§4 and pretext-fonts.ts.
 */

import {
	accumulateFrame,
	DEFAULT_RENDER_LOD,
	type LineMetricsResolver,
	type MeasuredElement,
	type PreparedFixedBlock,
	type RenderLod,
} from "../prepared-block";
import {
	FONT_SIZE,
	LINE_HEIGHT,
	lineBoxHeight,
	SPACING,
	typographyMetrics,
} from "../pretext-fonts";

// ── Discriminant + payload ───────────────────────────────────────────────────

/**
 * The single-line / clamped system-card kinds covered by this module.
 *
 * `review_feedback` used to be here and is now a `system-text` card: its body is a
 * verdict plus a findings list, and one clamped line could show neither those findings
 * nor the action button the card needs.
 */
export type SystemSimpleKind =
	| "compact"
	| "segment_compact"
	| "merge_summary"
	| "publication_result";

/**
 * Render payload carried on the prepared block. Height is fully determined by
 * `kind` — NONE of these fields affect it (the single line is always clamped).
 * The renderer reads them to paint the correct icon / colour / text.
 */
export interface SystemSimpleData {
	/** The single line of display text (pre-composed by the caller). */
	text: string;
	snapshotText?: string;
	messageId?: string;
	publicationResult?: { truncated: boolean };
	/** Live compact labels used to repaint the fixed-height marker without relayout. */
	compactLabels?: {
		compacting: string;
		segmentCompacting: string;
		outputChars: string;
		thinking: string;
		thinkingChars: string;
		retrying: string;
	};
	/** Mantine colour name for icon/text/background (e.g. orange/teal/indigo). */
	color?: string;
	/** compact / segment_compact status → chooses loader vs minimize vs alert. */
	status?: "compacting" | "compacted" | "failed";
	/** Whether the text is clickable (adds an underline). Height-neutral. */
	interactive?: boolean;
	/** merge_summary: reserve a leading creator-avatar slot. Height-neutral. */
	hasAvatar?: boolean;
}

// ── Chrome constants (px) — CONTRACT.md §3/§4 + pretext-fonts.ts ──────────────

/** Center-row cards (compact / segment_compact) use py={4}. */
export const CENTER_ROW_PADDING_Y = 4;
/** Paper p="xs" inner padding (merge_summary / review_feedback / spec_*). */
export const CARD_PADDING = SPACING.xs; // 10

/** xs single-line box height: round(12 × 1.4) = 17. */
export const XS_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs);

/** Center-row icon is 14; the xs line (17) is taller → the row is 17px tall. */
const CENTER_ROW_CONTENT = Math.max(14, XS_LINE_HEIGHT); // 17 (neutral baseline)
/** Centre-row lane at the reader's typography: the 14px glyph floors it. */
function centerRowContent(): number {
	return Math.max(14, typographyMetrics().line.xs);
}
/** Paper-row icon/Badge is 16; the xs line (17) is taller → 17px tall. */
const CARD_ROW_CONTENT = Math.max(16, XS_LINE_HEIGHT); // 17 (neutral baseline)
/** Card-row lane at the reader's typography: the 16px glyph floors it. */
function cardRowContent(): number {
	return Math.max(16, typographyMetrics().line.xs);
}

// ── Per-kind fixed heights (px) ──────────────────────────────────────────────

/** compact indicator: centered single line, py={4}. ≈25px. */
export const COMPACT_CARD_HEIGHT = CENTER_ROW_PADDING_Y * 2 + CENTER_ROW_CONTENT; // 25
/** Live counterparts of the three card heights above. */
export function compactCardHeight(): number {
	return CENTER_ROW_PADDING_Y * 2 + centerRowContent();
}
export function segmentCompactCardHeight(): number {
	return CENTER_ROW_PADDING_Y * 2 + centerRowContent();
}
export function mergeSummaryCardHeight(): number {
	return CARD_PADDING * 2 + cardRowContent();
}
/** segment_compact (compacting/compacted): centered single line, py={4}. ≈25px. */
export const SEGMENT_COMPACT_CARD_HEIGHT = CENTER_ROW_PADDING_Y * 2 + CENTER_ROW_CONTENT; // 25
/** merge_summary: Paper p="xs" + single lineClamp={1} row. ≈37px. */
export const MERGE_SUMMARY_CARD_HEIGHT = CARD_PADDING * 2 + CARD_ROW_CONTENT; // 37

/**
 * Central lookup: kind → fixed height (px) at NEUTRAL typography. Used by tests.
 *
 * A frozen record, so measurement must NOT read it — see {@link systemSimpleCardHeight}.
 */
export const SYSTEM_SIMPLE_CARD_HEIGHTS: Record<SystemSimpleKind, number> = {
	publication_result: COMPACT_CARD_HEIGHT,
	compact: COMPACT_CARD_HEIGHT,
	segment_compact: SEGMENT_COMPACT_CARD_HEIGHT,
	merge_summary: MERGE_SUMMARY_CARD_HEIGHT,
};

/**
 * A card's height at the reader's current typography.
 *
 * Resolved per call rather than through a record built at import time: these cards
 * are single-line, so their whole height IS a text line plus fixed padding, and a
 * frozen value would leave them the only cards in the transcript that ignore the
 * font-size setting.
 */
export function systemSimpleCardHeight(kind: SystemSimpleKind): number {
	switch (kind) {
		case "compact":
		case "publication_result":
			return compactCardHeight();
		case "segment_compact":
			return segmentCompactCardHeight();
		default:
			return mergeSummaryCardHeight();
	}
}

/**
 * A no-op line resolver. These cards contain only `PreparedFixedBlock`s, whose
 * height is intrinsic (`accumulateFrame` never calls the resolver for them), so
 * this module stays fully decoupled from pretext/canvas — tests need no stub.
 */
const NO_TEXT_MEASURE: LineMetricsResolver = () => ({ lineCount: 1, maxLineWidth: 0 });

/**
 * Measure a single-line / clamped system card. The height is a per-kind constant
 * and does not depend on `data`, `contentWidth`, or `lod`. The full-width card
 * uses `contentWidth` as its used width.
 */
export function measureSystemSimpleCard(
	kind: SystemSimpleKind,
	data: SystemSimpleData,
	contentWidth: number,
	_lod: RenderLod = DEFAULT_RENDER_LOD,
): MeasuredElement {
	const block: PreparedFixedBlock = {
		kind: "fixed",
		height: systemSimpleCardHeight(kind),
		tag: kind,
		data: { ...data } as Record<string, unknown>,
		marginTop: 0,
		contentLeft: 0,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
	const blocks: PreparedFixedBlock[] = [block];
	const frame = accumulateFrame(blocks, contentWidth, NO_TEXT_MEASURE);
	return {
		height: frame.contentHeight,
		blocks,
		frame,
		contentWidth,
		usedWidth: contentWidth,
	};
}

export const MEASURE_SYSTEM_SIMPLE_CONSTANTS = {
	CENTER_ROW_PADDING_Y,
	CARD_PADDING,
	XS_LINE_HEIGHT,
	CENTER_ROW_CONTENT,
	CARD_ROW_CONTENT,
} as const;
