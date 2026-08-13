/**
 * measure-spec-task.ts — a single Dynamic Spec task row inside an injection bubble.
 *
 * ## Why this is not the system-simple card
 *
 * The framed `spec_continuation` used to nest the standalone `system-simple` card
 * inside the bubble: a full-width tinted band that clamps the task to ONE clamped
 * line and paints the protected lock twice (a Badge whose leftSection is a lock AND
 * whose child is the 🔒 emoji). That is the card-in-a-card this element replaces.
 *
 * Here the bubble draws the row itself — a status glyph, an optional lock, and the
 * task text WRAPPED to as many lines as it needs. No band, no clamp, no nested card.
 *
 * ## Geometry
 *
 * One row: `[glyph 16] [gap 8] [lock 11 + gap 4]? [text …]`. The text column is
 * what's left after the glyph and lock lanes, and it wraps at that width — so the
 * row height is `max(glyphLane, wrappedTextHeight)`. Zero DOM: the wrap comes from
 * pretext line metrics exactly like every other measure.
 */

import { prepareRichInline, type RichInlineItem } from "@chenglou/pretext/rich-inline";
import { accumulateFrame, type MeasuredElement, type PreparedInlineBlock } from "../prepared-block";
import { FONT_SIZE, FONT_WEIGHT, LINE_HEIGHT, lineBoxHeight, SANS_FAMILY } from "../pretext-fonts";
import { pretextLineMetrics } from "./pretext-metrics";

/** Status glyph box (matches the tool card's SPEC_TASK_ICON). */
export const SPEC_TASK_GLYPH = 16;
/** Gap between the glyph and the text (matches SPEC_TASK_INDENT - SPEC_TASK_ICON). */
export const SPEC_TASK_GLYPH_GAP = 8;
/** Protected lock glyph size (matches SPEC_TASK_LOCK). */
export const SPEC_TASK_LOCK = 11;
/** Gap after the lock (matches SPEC_TASK_LOCK_GAP). */
export const SPEC_TASK_LOCK_GAP = 4;

/** xs single-line box: round(12 × 1.4) = 17 (CONTRACT §3 ground truth). */
export const SPEC_TASK_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // 17
/** Task text font (Text size="xs"). */
export const SPEC_TASK_FONT = `${FONT_WEIGHT.regular} ${FONT_SIZE.xs}px ${SANS_FAMILY}`;

/** The data the adapter projects for a framed spec task. */
export interface SpecTaskData {
	/** The task text (chunk reads `block.task`, falling back to the row text). */
	text: string;
	/** True when the task carries Dynamic Spec's protected marker. */
	protected?: boolean;
	/** True for `spec_blocked_continuation` — the glyph turns to a warning tone. */
	blocked?: boolean;
}

/** Total width the glyph + lock lanes consume, leaving the rest for the text. */
export function specTaskChromeWidth(data: SpecTaskData): number {
	const lock = data.protected === true ? SPEC_TASK_LOCK + SPEC_TASK_LOCK_GAP : 0;
	return SPEC_TASK_GLYPH + SPEC_TASK_GLYPH_GAP + lock;
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

/**
 * Measure a framed spec task row at the bubble's inner width.
 *
 * The row never wraps below a single glyph line even for an empty task: an empty text
 * still occupies one line box, keeping a degenerate payload visible instead of a
 * zero-height hole.
 */
export function measureSpecTask(data: SpecTaskData, innerWidth: number): MeasuredElement {
	const textWidth = Math.max(1, innerWidth - specTaskChromeWidth(data));
	const items: RichInlineItem[] = [
		{ text: data.text ?? "", font: SPEC_TASK_FONT, break: "normal", extraWidth: 0 },
	];
	const block: PreparedInlineBlock = {
		...baseBlockFields(),
		kind: "inline",
		flow: prepareRichInline(items),
		lineHeight: SPEC_TASK_LINE_HEIGHT,
		classNames: ["vlist-spec-task"],
		hrefs: [null],
		fonts: [SPEC_TASK_FONT],
	};
	// Measure the TEXT column on its own; the glyph/lock lanes are fixed chrome the
	// render copy places beside it. `usedWidth` is the text's widest line, to which the
	// bubble adds the chrome back when it shrink-wraps the frame.
	const frame = accumulateFrame([block], textWidth, pretextLineMetrics);
	const height = Math.max(SPEC_TASK_GLYPH, frame.contentHeight, SPEC_TASK_LINE_HEIGHT);
	return {
		height,
		blocks: [block],
		frame,
		contentWidth: textWidth,
		usedWidth: frame.usedWidth,
	};
}

/** True when a framed payload kind is a spec task row. */
export function isSpecTaskPayload(kind: string): boolean {
	return kind === "spec-task";
}
