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
import {
	FONT_SIZE,
	FONT_WEIGHT,
	LINE_HEIGHT,
	lineBoxHeight,
	SANS_FAMILY,
	typographyMetrics,
} from "../pretext-fonts";
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
	/**
	 * A task DIGEST: the periodic `living_work_spec` reminder lists every open task.
	 * When present it wins over the flat single-task fields above, and each entry is
	 * drawn as its own row through the same glyph/lock/wrapping geometry.
	 */
	tasks?: SpecTaskRow[];
	/**
	 * Single dimmed line for a digest with nothing to list ("no tasks yet", "42 tasks,
	 * over the threshold"). Localized by the adapter; drawn instead of the rows.
	 */
	emptyLabel?: string | null;
}

/**
 * Vertical gap between consecutive task rows in a multi-task digest.
 *
 * Matches the tool card's `SPEC_TASK_GAP` so a periodic digest and the tool-call task
 * list read as the same object at a glance.
 */
export const SPEC_TASK_ROW_GAP = 4;

/**
 * One row of a task digest.
 *
 * `role` is the Dynamic Spec status (doing/next/todo/blocked) that drives the glyph;
 * the continuation's single row has no role and reads as `doing`, which is what it is.
 */
export interface SpecTaskRow {
	text: string;
	protected?: boolean;
	role?: string;
	blocked?: boolean;
}

/**
 * Normalize either payload shape into rows.
 *
 * The continuation delivers ONE task via the flat fields; the periodic digest delivers
 * a list. Both render through the same row renderer, which is the whole point — the two
 * used to look like different species of object (task row vs markdown bullets) even
 * though the data is the same shape.
 */
export function specTaskRows(data: SpecTaskData): SpecTaskRow[] {
	if (Array.isArray(data.tasks) && data.tasks.length > 0) return data.tasks;
	return [{ text: data.text ?? "", protected: data.protected, blocked: data.blocked }];
}

/** Total width the glyph + lock lanes consume, leaving the rest for the text. */
export function specTaskChromeWidth(data: SpecTaskRow): number {
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
	// An empty digest is one dimmed line, measured at the FULL inner width (it carries
	// no glyph, so it reserves no chrome lane).
	const emptyLabel = data.emptyLabel?.trim();
	if (emptyLabel) {
		const block = inlineBlock(emptyLabel);
		const frame = accumulateFrame([block], Math.max(1, innerWidth), pretextLineMetrics);
		return {
			height: Math.max(typographyMetrics().line.xs, frame.contentHeight),
			blocks: [block],
			frame,
			contentWidth: Math.max(1, innerWidth),
			usedWidth: frame.usedWidth,
		};
	}

	const rows = specTaskRows(data);
	// Each row wraps in ITS OWN text column: a protected row's lock lane makes that
	// column narrower, so measuring them all at one width would under-report the
	// locked rows' height.
	const blocks: PreparedInlineBlock[] = [];
	let height = 0;
	let usedWidth = 0;
	// The narrowest column across rows is what the render copy can safely paint every
	// row at… but rows differ, so the render copy re-derives per row with the same
	// helper. `contentWidth` reports the FIRST row's column for the single-task case
	// (the continuation), which is what the existing geometry test pins.
	let firstColumn = Math.max(1, innerWidth - specTaskChromeWidth(rows[0] ?? { text: "" }));
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (!row) continue;
		const textWidth = Math.max(1, innerWidth - specTaskChromeWidth(row));
		if (i === 0) firstColumn = textWidth;
		const block = inlineBlock(row.text ?? "");
		const frame = accumulateFrame([block], textWidth, pretextLineMetrics);
		blocks.push(block);
		// A row is at least one glyph tall even when its text is empty.
		height += Math.max(SPEC_TASK_GLYPH, frame.contentHeight, typographyMetrics().line.xs);
		if (i < rows.length - 1) height += SPEC_TASK_ROW_GAP;
		usedWidth = Math.max(usedWidth, frame.usedWidth + specTaskChromeWidth(row));
	}

	return {
		height: Math.max(typographyMetrics().line.xs, height),
		blocks,
		// The frame is synthesized: the render copy lays rows out with flex (each row's
		// own wrap already decided its height), so per-block `top` values are unused.
		frame: { blocks: [], contentHeight: height, usedWidth },
		contentWidth: firstColumn,
		usedWidth,
	};
}

/** One row's prepared inline flow, at the shared task font. */
function inlineBlock(text: string): PreparedInlineBlock {
	const items: RichInlineItem[] = [
		{ text, font: typographyMetrics().font.xs, break: "normal", extraWidth: 0 },
	];
	return {
		...baseBlockFields(),
		kind: "inline",
		flow: prepareRichInline(items),
		lineHeight: typographyMetrics().line.xs,
		classNames: ["vlist-spec-task"],
		hrefs: [null],
		fonts: [typographyMetrics().font.xs],
	};
}

/** True when a framed payload kind is a spec task row. */
export function isSpecTaskPayload(kind: string): boolean {
	return kind === "spec-task";
}
