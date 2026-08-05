/**
 * measure-sidecar.ts — One collapsible card per system-injection (sidecar).
 *
 * This is the vlist REDESIGN of the chunked path's aggregate SideCarNotice:
 * instead of one "×N" row that unfolds into a list, every sidecar record is its
 * own small card with its own fold state (per the product decision). The card:
 *
 *   collapsed : a single fixed-height header row — accent rail + info icon +
 *               source badge + target badge + a clamped preview line + chevron +
 *               copy button. The preview is truncated to one line, so the
 *               collapsed height is a CONSTANT regardless of content.
 *   expanded  : the same header row, then the full body measured as pre-wrap
 *               text (prepareWithSegments), capped at SIDECAR_DETAIL_MAX_LINES so
 *               a pathological record costs a bounded measure.
 *
 * Height model (Paper p="xs", radius=sm — same chrome as the system cards):
 *
 *   collapsed = CARD_PADDING×2 + HEADER_ROW
 *   expanded  = CARD_PADDING×2 + HEADER_ROW + HEADER_BODY_GAP + bodyLines×17
 *               [+ NOTICE_GAP + NOTICE_ROW when the line cap clipped the body]
 *
 * The notice row is reserved HERE, not decided by the renderer: the body lane is a
 * fixed-height overflow:hidden box, so a notice drawn outside the measured height
 * would be clipped or would push a body line out of the box.
 *
 * The body is carried as a PreparedCodeBlock (like measure-system-text), so the
 * render layer re-materializes the exact lines the measure pass wrapped — zero
 * drift, zero DOM. Height does not depend on `lod` (a sidecar never folds away).
 */

import { measureLineStats, prepareWithSegments } from "@chenglou/pretext";
import type { SidecarSpecData } from "@shared/pretext-layout/segment-adapter";
import {
	accumulateFrame,
	DEFAULT_RENDER_LOD,
	type MeasuredElement,
	type PreparedBlock,
	type PreparedCodeBlock,
	type PreparedFixedBlock,
	type RenderLod,
} from "../prepared-block";
import { FONT_SIZE, FONT_XS, LINE_HEIGHT, lineBoxHeight, SPACING } from "../pretext-fonts";
import { pretextLineMetrics } from "./pretext-metrics";

// ── Chrome constants (px) — CONTRACT.md §3/§4 + pretext-fonts.ts ──────────────

/** Paper p="xs" inner padding (top + bottom each). */
export const SIDECAR_CARD_PADDING = SPACING.xs; // 10
/** xs line box: round(12 × 1.4) = 17. Shared by header row + body. */
export const SIDECAR_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // 17
/** Header row: max(badge 16 / icon 14 / xs line 17) → 17. */
export const SIDECAR_HEADER_ROW = SIDECAR_LINE_HEIGHT; // 17
/** Gap between the header row and the expanded body (Stack gap={6}). */
export const SIDECAR_HEADER_BODY_GAP = 6;
/** Left accent rail width (borderLeft 2px) — the body wraps clear of it. */
export const SIDECAR_ACCENT_RAIL = 2;
/** Gap between the accent rail and the content lane (its paddingLeft). */
export const SIDECAR_RAIL_GAP = 8;

/**
 * Cap on the measured body: a sidecar is a diagnostic/injection preview, so we
 * never let it grow past this many lines (the full text remains one click away
 * via the copy button; the chunked detail view caps at 120_000 chars). Bounded
 * measure cost + a predictable max card height.
 */
export const SIDECAR_DETAIL_MAX_LINES = 40;

/**
 * Height of the notice row appended when the LINE cap clipped the body.
 *
 * Why it lives HERE rather than in the renderer: the body box is a fixed-height
 * `overflow:hidden` lane, so a notice the render layer decided to draw on its own
 * would either be clipped away or push a line out of the box (CONTRACT §0 — height
 * is pure arithmetic, the painted shape must be the measured shape). Reserving one
 * xs line box plus its gap makes the notice part of the card's arithmetic height.
 *
 * Only the LINE cap needs this. The CHAR cap (`sidecarDetailText`) already appends
 * its label INTO the text, so it is measured as an ordinary body line.
 */
export const SIDECAR_TRUNCATION_NOTICE_HEIGHT = SIDECAR_LINE_HEIGHT; // 17
/** Gap between the clipped body and the truncation notice row. */
export const SIDECAR_TRUNCATION_NOTICE_GAP = 4;

/** Collapsed card height (constant). */
export const SIDECAR_COLLAPSED_HEIGHT = SIDECAR_CARD_PADDING * 2 + SIDECAR_HEADER_ROW; // 37

// ── Measure ──────────────────────────────────────────────────────────────────

export interface MeasuredSidecar extends MeasuredElement {
	/** Whether the card is expanded (drives which geometry the renderer draws). */
	expanded: boolean;
	/** Header row height (px) — constant. */
	headerRow: number;
	/** Measured body height when expanded (0 when collapsed). */
	bodyHeight: number;
	/** Top offset of the body within the card content box (== headerRow + gap). */
	bodyTop: number;
	/** Body width the text wrapped at (card inner width minus rail + gap). */
	bodyWidth: number;
	/**
	 * True when the LINE cap clipped the expanded body, i.e. the reader is NOT
	 * seeing all of it. The renderer paints the notice row reserved below; the
	 * complete text is still what the copy button yields.
	 */
	bodyTruncated: boolean;
	/** Reserved notice row height (0 unless `bodyTruncated`). */
	noticeHeight: number;
	/** Top offset of the notice row within the card content box (-1 when absent). */
	noticeTop: number;
	/** Localized notice text (adapter-composed; empty when absent). */
	noticeText: string;
	/** Render payload (source label / colours / preview / full text). */
	payload: SidecarSpecData;
}

/**
 * Measure one sidecar card. `data` is the adapter's `SidecarSpecData`;
 * `opts.expanded` (boolean) selects collapsed vs expanded geometry. Zero DOM.
 */
export function measureSidecar(
	data: SidecarSpecData,
	contentWidth: number,
	_lod: RenderLod = DEFAULT_RENDER_LOD,
	opts?: { expanded?: boolean },
): MeasuredSidecar {
	const expanded = opts?.expanded === true;
	// Body lane width: card inner width minus the accent rail and its gap.
	const bodyWidth = Math.max(
		1,
		contentWidth - SIDECAR_CARD_PADDING * 2 - SIDECAR_ACCENT_RAIL - SIDECAR_RAIL_GAP,
	);

	// Header row: a fixed block so the renderer positions the header chrome at the
	// reserved row; its content is clamped single-line (height-neutral).
	const headerBlock: PreparedFixedBlock = {
		kind: "fixed",
		height: SIDECAR_HEADER_ROW,
		tag: "sidecar-header",
		data: { previewText: data.previewText } as Record<string, unknown>,
		marginTop: 0,
		contentLeft: 0,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};

	const blocks: PreparedBlock[] = [headerBlock];
	let bodyHeight = 0;
	let bodyTruncated = false;
	const bodyTop = SIDECAR_HEADER_ROW + (expanded ? SIDECAR_HEADER_BODY_GAP : 0);

	if (expanded) {
		const bodyBlock: PreparedCodeBlock = {
			kind: "code",
			prepared: prepareWithSegments(data.fullText, FONT_XS, { whiteSpace: "pre-wrap" }),
			lineHeight: SIDECAR_LINE_HEIGHT,
			lang: null,
			// The body sits below the header: its marginTop carries the header→body gap
			// so the frame's block tops match the painted offsets exactly.
			marginTop: SIDECAR_HEADER_BODY_GAP,
			contentLeft: 0,
			quoteRailLefts: [],
			markerText: null,
			markerLeft: null,
			markerClassName: null,
		};
		blocks.push(bodyBlock);
		// Wrap the body at the body lane width. prepareWithSegments already resolved
		// the width-independent segments; measureLineStats gives the wrapped line
		// count at this width (pure arithmetic). Cap the line count so the measured
		// height never exceeds the detail cap.
		const stats = measureLineStats(bodyBlock.prepared, bodyWidth);
		const lines = Math.min(stats.lineCount, SIDECAR_DETAIL_MAX_LINES);
		bodyTruncated = stats.lineCount > SIDECAR_DETAIL_MAX_LINES;
		bodyHeight = lines * SIDECAR_LINE_HEIGHT;
	}

	// A clipped body gets a reserved notice row. Without it the card simply stops
	// mid-text inside an overflow:hidden lane with no scrollbar and no hint — the
	// reader has no way to learn that the copy button holds more.
	//
	// Reserved only when there IS a label to paint: the height and the painted row
	// must agree, so a payload without one (a hand-written fixture) reserves nothing
	// rather than an empty gap.
	const noticeText = bodyTruncated ? (data.truncatedLabel ?? "") : "";
	const hasNotice = noticeText.length > 0;
	const noticeHeight = hasNotice ? SIDECAR_TRUNCATION_NOTICE_HEIGHT : 0;
	const noticeTop = hasNotice ? bodyTop + bodyHeight + SIDECAR_TRUNCATION_NOTICE_GAP : -1;

	const frame = accumulateFrame(blocks, bodyWidth, pretextLineMetrics, {
		codePaddingX: 0,
		codePaddingY: 0,
		codeLangExtraTop: 0,
	});

	const height = expanded
		? SIDECAR_CARD_PADDING * 2 +
			SIDECAR_HEADER_ROW +
			SIDECAR_HEADER_BODY_GAP +
			bodyHeight +
			(hasNotice ? SIDECAR_TRUNCATION_NOTICE_GAP + noticeHeight : 0)
		: SIDECAR_COLLAPSED_HEIGHT;

	return {
		height,
		blocks,
		frame,
		contentWidth: bodyWidth,
		usedWidth: contentWidth,
		expanded,
		headerRow: SIDECAR_HEADER_ROW,
		bodyHeight,
		bodyTop,
		bodyWidth,
		bodyTruncated,
		noticeHeight,
		noticeTop,
		noticeText,
		payload: data,
	};
}

export const MEASURE_SIDECAR_CONSTANTS = {
	SIDECAR_CARD_PADDING,
	SIDECAR_LINE_HEIGHT,
	SIDECAR_HEADER_ROW,
	SIDECAR_HEADER_BODY_GAP,
	SIDECAR_ACCENT_RAIL,
	SIDECAR_RAIL_GAP,
	SIDECAR_DETAIL_MAX_LINES,
	SIDECAR_TRUNCATION_NOTICE_HEIGHT,
	SIDECAR_TRUNCATION_NOTICE_GAP,
	SIDECAR_COLLAPSED_HEIGHT,
} as const;
