/**
 * measure-ask-in-passing.ts — "Ask in passing" cards (batch-2 P8).
 *
 * Two sub-cards, both authored by AskInPassingCard.tsx:
 *
 *   ┌ pending (AskInPassingPendingCard) — FIXED 77px ────────────────────────────┐
 *   │  <Box px="md" py="xs" radius=md dashed-border>                             │
 *   │    row1: <Group gap=6 mb=4> icon(14) + <Text xs dimmed hint>  → 17 + mb 4  │
 *   │    row2: <Group> TextInput sm(36) flex=1 + Button sm(36) + Button sm(36)   │
 *   │  height = py(10)×2 + (17 + 4) + 36 = 77                                    │
 *   └────────────────────────────────────────────────────────────────────────────┘
 *   ┌ resolved (AskInPassingResolvedCard) — 57~77px (lineClamp=2 caps it) ────────┐
 *   │  <Paper px="sm" py="xs" borderLeft:3px>                                    │
 *   │    <Group gap=6> icon(14) + <Stack gap=0>[Text xs label + Text sm          │
 *   │      lineClamp=2 question] + icon(14)                                      │
 *   │  height = py(10)×2 + label(xs 17) + question(clamp[1,2] × sm 20)           │
 *   │         = 57 (1 line) .. 77 (2 lines)                                      │
 *   └────────────────────────────────────────────────────────────────────────────┘
 *
 * The question text is measured with pretext (rich-inline) so short questions
 * render at 57px while long/wrapping ones cap at 77px — the row count is clamped
 * to [1, 2] to mirror the DOM `lineClamp={2}`. The renderer materializes the same
 * line ranges (zero drift). Chrome constants come from CONTRACT.md §3/§4 +
 * pretext-fonts.ts. Zero DOM measurement.
 */

import { prepareRichInline } from "@chenglou/pretext/rich-inline";
import {
	accumulateFrame,
	DEFAULT_RENDER_LOD,
	type LineMetricsResolver,
	type MeasuredElement,
	type PreparedFixedBlock,
	type PreparedInlineBlock,
	type RenderLod,
} from "../prepared-block";
import {
	FONT_SIZE,
	FONT_WEIGHT,
	LINE_HEIGHT,
	lineBoxHeight,
	SANS_FAMILY,
	SPACING,
	typographyMetrics,
} from "../pretext-fonts";
import { pretextLineMetrics } from "./pretext-metrics";

// ── Discriminant + payloads ──────────────────────────────────────────────────

export type AskInPassingKind = "pending" | "resolved";

/** Pending card payload. Height is fully fixed — these fields are render-only. */
export interface AskInPassingPendingData {
	messageId?: string;
	narratorId?: string;
}

/** Resolved card payload. `question` drives the (clamped) line count. */
export interface AskInPassingResolvedData {
	/** The full question text (pre-truncation). */
	question: string;
	/** Narrator the resolved card navigates to on click. Render-only. */
	targetNarratorId?: string;
}

export type AskInPassingData = AskInPassingPendingData | AskInPassingResolvedData;

// ── Shared chrome constants (px) — CONTRACT.md §3/§4 + pretext-fonts.ts ───────

/** xs single-line box height: round(12 × 1.4) = 17. */
export const XS_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // 17
/** sm body line box height: round(14 × 1.45) = 20. */
export const SM_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.sm, LINE_HEIGHT.sm); // 20

// ── pending: fixed 77px ──────────────────────────────────────────────────────

/** Box py="xs" inner padding (top & bottom). */
export const PENDING_PADDING_Y = SPACING.xs; // 10
/** Box px="md" inner padding (left & right). Render-only (no height impact). */
export const PENDING_PADDING_X = SPACING.md; // 16
/** Hint row: max(icon 14, xs line 17) = 17. */
export const PENDING_HINT_ROW = Math.max(14, XS_LINE_HEIGHT); // 17
/** Hint row bottom margin (Group mb={4}). */
export const PENDING_HINT_MARGIN = 4;
/** Input row: TextInput size="sm" + Button size="sm" are all 36px tall. */
export const PENDING_INPUT_ROW = 36;
/** Full pending card height. ≈77px. */
export const PENDING_CARD_HEIGHT =
	PENDING_PADDING_Y * 2 + (PENDING_HINT_ROW + PENDING_HINT_MARGIN) + PENDING_INPUT_ROW; // 77

// ── resolved: 57~77px (question line count clamped to [1, 2]) ─────────────────

/** Paper py="xs" inner padding (top & bottom). */
export const RESOLVED_PADDING_Y = SPACING.xs; // 10
/** Paper px="sm" inner padding (left & right). */
export const RESOLVED_PADDING_X = SPACING.sm; // 12
/** borderLeft: 3px solid. */
export const RESOLVED_BORDER_LEFT = 3;
/** Leading / trailing icon size (IconMessageQuestion / IconArrowRight). */
export const RESOLVED_ICON = 14;
/** Group gap={6} appears twice (icon↔stack, stack↔icon). */
export const RESOLVED_GROUP_GAP = 6;
/** Fixed label row (Text size="xs" dimmed, single line). */
export const RESOLVED_LABEL_HEIGHT = XS_LINE_HEIGHT; // 17
/** Max rendered question lines (DOM lineClamp={2}). */
export const QUESTION_MAX_LINES = 2;
/** JS-layer truncation length applied by the card before display. */
export const QUESTION_SLICE_LEN = 60;

/**
 * Horizontal chrome subtracted from the outer width to get the question's
 * available layout width (the flex Stack region):
 *   px×2 + borderLeft + icon×2 + gap×2 = 24 + 3 + 28 + 12 = 67.
 */
export const RESOLVED_CHROME_X =
	RESOLVED_PADDING_X * 2 + RESOLVED_BORDER_LEFT + RESOLVED_ICON * 2 + RESOLVED_GROUP_GAP * 2; // 67

/** Resolved minimum height (question fits on one line). ≈57px. */
export const RESOLVED_MIN_HEIGHT = RESOLVED_PADDING_Y * 2 + RESOLVED_LABEL_HEIGHT + SM_LINE_HEIGHT; // 57
/** Resolved maximum height (question wraps to two lines). ≈77px. */
export const RESOLVED_MAX_HEIGHT =
	RESOLVED_PADDING_Y * 2 +
	RESOLVED_LABEL_HEIGHT +
	QUESTION_MAX_LINES * typographyMetrics().line.body; // 77

/** Question text font (Text size="sm" fw={500}). Renderer MUST use this string. */
export const QUESTION_FONT = `500 ${FONT_SIZE.sm}px ${SANS_FAMILY}`;

/**
 * Apply the card's JS-layer truncation exactly (AskInPassingResolvedCard):
 * `question.length > 60 ? question.slice(0, 60) + "..." : question`.
 */
export function truncateQuestion(question: string): string {
	return question.length > QUESTION_SLICE_LEN
		? `${question.slice(0, QUESTION_SLICE_LEN)}...`
		: question;
}

/** A no-op resolver for the pending card (its only block is intrinsic-height). */
const NO_TEXT_MEASURE: LineMetricsResolver = () => ({ lineCount: 1, maxLineWidth: 0 });

/** Wrap pretext line metrics but clamp the reported line count to [1, maxLines]. */
function clampedInlineResolver(maxLines: number): LineMetricsResolver {
	return (block, contentWidth) => {
		const m = pretextLineMetrics(block, contentWidth);
		return {
			lineCount: Math.min(maxLines, Math.max(1, m.lineCount)),
			maxLineWidth: m.maxLineWidth,
		};
	};
}

function baseBlockFields() {
	return {
		marginTop: 0,
		contentLeft: 0,
		quoteRailLefts: [] as number[],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
}

// ── Measure ──────────────────────────────────────────────────────────────────

export function measureAskInPassing(
	kind: "pending",
	data: AskInPassingPendingData,
	contentWidth: number,
	lod?: RenderLod,
): MeasuredElement;
export function measureAskInPassing(
	kind: "resolved",
	data: AskInPassingResolvedData,
	contentWidth: number,
	lod?: RenderLod,
): MeasuredElement;
/**
 * Measure an ask-in-passing card. The pending card is a per-kind constant
 * (independent of data / width / LOD). The resolved card's height depends only
 * on how many lines (1 or 2) the truncated question wraps to at `contentWidth`.
 */
export function measureAskInPassing(
	kind: AskInPassingKind,
	data: AskInPassingData,
	contentWidth: number,
	_lod: RenderLod = DEFAULT_RENDER_LOD,
): MeasuredElement {
	return kind === "pending"
		? measurePending(data as AskInPassingPendingData, contentWidth)
		: measureResolved(data as AskInPassingResolvedData, contentWidth);
}

// ── pending: single fixed block, 77px ────────────────────────────────────────
function measurePending(data: AskInPassingPendingData, contentWidth: number): MeasuredElement {
	const block: PreparedFixedBlock = {
		...baseBlockFields(),
		kind: "fixed",
		height: PENDING_CARD_HEIGHT,
		tag: "ask_in_passing_pending",
		data: { ...data },
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

// ── resolved: fixed chrome + question inline (clamped to 2 lines) ─────────────
function measureResolved(data: AskInPassingResolvedData, contentWidth: number): MeasuredElement {
	const questionText = truncateQuestion(data.question ?? "");
	const questionWidth = Math.max(1, contentWidth - RESOLVED_CHROME_X);

	const questionBlock: PreparedInlineBlock = {
		...baseBlockFields(),
		kind: "inline",
		flow: prepareRichInline([
			{
				text: questionText,
				font: typographyMetrics().font.bodyMedium,
				break: "normal",
				extraWidth: 0,
			},
		]),
		lineHeight: typographyMetrics().line.body,
		classNames: ["vlist-frag vlist-frag--body"],
		hrefs: [null],
		fonts: [typographyMetrics().font.bodyMedium],
	};
	const blocks: PreparedInlineBlock[] = [questionBlock];

	// Frame is computed at the question's available width; the label + padding are
	// fixed chrome the renderer draws around it (mirrors measure-message-bubble).
	const frame = accumulateFrame(blocks, questionWidth, clampedInlineResolver(QUESTION_MAX_LINES));
	const height = RESOLVED_PADDING_Y * 2 + RESOLVED_LABEL_HEIGHT + frame.contentHeight;

	return {
		height,
		blocks,
		frame,
		// Render layer re-materializes the question line ranges at this width.
		contentWidth: questionWidth,
		// Full-width card (Paper is block-level).
		usedWidth: contentWidth,
	};
}

export const MEASURE_ASK_IN_PASSING_CONSTANTS = {
	XS_LINE_HEIGHT,
	SM_LINE_HEIGHT,
	PENDING_CARD_HEIGHT,
	RESOLVED_MIN_HEIGHT,
	RESOLVED_MAX_HEIGHT,
	RESOLVED_CHROME_X,
	QUESTION_MAX_LINES,
	QUESTION_SLICE_LEN,
	// echo the pending sub-parts for the harness / tests.
	PENDING_PADDING_Y,
	PENDING_HINT_ROW,
	PENDING_HINT_MARGIN,
	PENDING_INPUT_ROW,
	FONT_WEIGHT_MEDIUM: FONT_WEIGHT.medium,
} as const;
