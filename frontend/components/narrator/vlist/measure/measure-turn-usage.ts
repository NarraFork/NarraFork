/**
 * measure-turn-usage.ts — Per-turn token/cost lines around an assistant message.
 *
 * The chunked renderer draws these as `<Text size="xs" c="dimmed" ta="right">`
 * siblings of the message bubble (MessageRenderer.tsx). They are REAL text rows,
 * so the exact list has to reserve their height or every assistant message below
 * one would be off by 17-51px.
 *
 *   ┌ leading (above the body) ────────────────────────────────────────────────┐
 *   │  ↑ 12,345                             (xs, right-aligned, mb 2)          │
 *   ├ trailing (below the body) ───────────────────────────────────────────────┤
 *   │  Σ 12,345 ctx · 900 in · 120 out · $0.0421      (xs, right-aligned, mt 2)│
 *   │  8 cache hit · $0.0421          (mobile only — the split second line)     │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * Height model: every line is FORCED SINGLE-LINE. The chunked `<Text>` has no
 * wrapping guard, but these strings are short, bounded compositions of formatted
 * numbers (see shared/pretext-layout/turn-usage.ts) and the render copy clamps
 * them with `nowrap` + `ellipsis`. That makes the height a pure function of HOW
 * MANY lines exist, not of their content — no pretext measurement needed, so a
 * long line can never silently change the layout.
 *
 * Zero DOM.
 */

import {
	accumulateFrame,
	DEFAULT_RENDER_LOD,
	type LineMetricsResolver,
	type MeasuredElement,
	type PreparedFixedBlock,
	type RenderLod,
} from "../prepared-block";
import { FONT_SIZE, LINE_HEIGHT, lineBoxHeight } from "../pretext-fonts";

/** xs single-line box: round(12 × 1.4) = 17. */
export const TURN_USAGE_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs);
/** `mb={2}` on the leading line / `mt={2}` on the trailing one. */
export const TURN_USAGE_LINE_MARGIN = 2;
/** Right inset (`pr="sm"`) the chunked lines use. Height-neutral. */
export const TURN_USAGE_PADDING_RIGHT = 12;

/**
 * Which side of the message body this element sits on. Two separate elements
 * rather than one wrapping both: the assistant body between them is a sequence of
 * independent block elements (text / reasoning / tool blocks), so the usage rows
 * are siblings in the same flat item list, not a container.
 */
export type TurnUsagePlacement = "leading" | "trailing";

export interface MeasureTurnUsageInput {
	placement: TurnUsagePlacement;
	/** Primary line text. */
	text: string;
	/** Second line (mobile trailing split); omitted → one line. */
	secondaryText?: string | null;
}

/** Geometry the render copy needs on top of MeasuredElement. */
export interface MeasuredTurnUsage extends MeasuredElement {
	placement: TurnUsagePlacement;
	/** The lines to paint, top to bottom (1 or 2 entries). */
	lines: readonly string[];
}

/** A no-op resolver — every block here is fixed-height. */
const NO_TEXT_MEASURE: LineMetricsResolver = () => ({ lineCount: 1, maxLineWidth: 0 });

function usageLineBlock(text: string, marginTop: number): PreparedFixedBlock {
	return {
		kind: "fixed",
		marginTop,
		height: TURN_USAGE_LINE_HEIGHT,
		tag: "turn-usage-line",
		data: { text },
		contentLeft: 0,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
}

/**
 * Measure a turn-usage row group.
 *
 * The margin sits on the side FACING the message body (leading → below it,
 * trailing → above it), mirroring the chunked `mb={2}` / `mt={2}`. A mobile
 * trailing group's second line is flush against the first.
 */
export function measureTurnUsage(
	input: MeasureTurnUsageInput,
	contentWidth: number,
	_lod: RenderLod = DEFAULT_RENDER_LOD,
): MeasuredTurnUsage {
	const lines = [input.text, ...(input.secondaryText ? [input.secondaryText] : [])];
	// `leading` carries its gap BELOW the text, which accumulateFrame cannot
	// express (it only folds marginTop), so it is added to the total instead.
	const blocks = lines.map((text, index) =>
		usageLineBlock(
			text,
			index === 0 && input.placement === "trailing" ? TURN_USAGE_LINE_MARGIN : 0,
		),
	);
	const frame = accumulateFrame(blocks, contentWidth, NO_TEXT_MEASURE);
	const height = frame.contentHeight + (input.placement === "leading" ? TURN_USAGE_LINE_MARGIN : 0);
	return {
		height,
		blocks,
		frame,
		contentWidth,
		usedWidth: contentWidth,
		placement: input.placement,
		lines,
	};
}

export const MEASURE_TURN_USAGE_CONSTANTS = {
	TURN_USAGE_LINE_HEIGHT,
	TURN_USAGE_LINE_MARGIN,
	TURN_USAGE_PADDING_RIGHT,
} as const;
