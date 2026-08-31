/**
 * measure-misc.ts — Misc list-level decorative elements (batch-2 P12).
 *
 * Currently: the prune-divider — a Mantine <Divider my="xs" label=… /> with a
 * centered label, inserted by segmentMessages() at the pruned-context boundary
 * (see MessageRenderer.tsx:645). It is a FIXED single-row element: a horizontal
 * rule with a centered label whose font-size is 11px, wrapped in a vertical
 * margin of `my="xs"` (10px top + 10px bottom).
 *
 *   ┌ Divider my="xs" labelPosition="center" ──────────────────────────────────┐
 *   │  marginTop 10                                                             │
 *   │  ── label (fontSize 11, single line) ──                                   │
 *   │  marginBottom 10                                                          │
 *   └───────────────────────────────────────────────────────────────────────────┘
 *
 * The label never wraps (Mantine draws it on the divider line), so the height is
 * a per-element CONSTANT — zero pretext, zero DOM. Modeled as a PreparedRuleBlock
 * whose height already includes the label row, with the my="xs" margins folded
 * into the block (marginTop) + returned total.
 *
 * Follows the measure-system-simple.ts template. Zero DOM.
 */

import {
	accumulateFrame,
	DEFAULT_RENDER_LOD,
	type LineMetricsResolver,
	type MeasuredElement,
	type PreparedRuleBlock,
	type RenderLod,
} from "../prepared-block";
import { lineBoxHeight, SPACING, scaledLineBoxHeight } from "../pretext-fonts";

// ── Chrome constants (px) — MessageRenderer.tsx prune-divider + Mantine ──────

/** Divider my="xs" (10px) vertical margin, top + bottom. */
export const PRUNE_DIVIDER_MARGIN_Y = SPACING.xs; // 10
/** Label font-size (hard-coded 11 in MessageRenderer styles). */
export const PRUNE_DIVIDER_LABEL_FONT_SIZE = 11;
/**
 * Label row height: the divider's centered label sets the row height. Mantine's
 * `--divider-fz` uses the label font-size at line-height ~1.55 → round(11×1.55)
 * = 17. When no label is present the rule is a hairline (~1px), but the pruned
 * boundary always carries a label, so the label row is authoritative.
 */
export const PRUNE_DIVIDER_LABEL_ROW = lineBoxHeight(PRUNE_DIVIDER_LABEL_FONT_SIZE, 1.55); // 17

/** Total fixed height: label row + top & bottom margins. */
export const PRUNE_DIVIDER_HEIGHT = PRUNE_DIVIDER_LABEL_ROW + PRUNE_DIVIDER_MARGIN_Y * 2; // 37

/** Optional payload for the renderer (the label text). Height-neutral. */
export interface PruneDividerData {
	/** Centered label text (e.g. the pruned-boundary hint). */
	label?: string;
}

/** A no-op resolver — the single rule block's height is intrinsic. */
const NO_TEXT_MEASURE: LineMetricsResolver = () => ({ lineCount: 1, maxLineWidth: 0 });

/**
 * Measure the prune-divider. Height is a constant (label row + my="xs" margins)
 * and does not depend on `contentWidth`, `lod`, or the label text (single line).
 *
 * @param contentWidth available OUTER width in px (full-width block)
 * @param _data        optional label payload (height-neutral)
 * @param _lod         render LOD — ignored (fixed decorative row)
 */
export function measurePruneDivider(
	contentWidth: number,
	_data: PruneDividerData = {},
	_lod: RenderLod = DEFAULT_RENDER_LOD,
): MeasuredElement {
	const block: PreparedRuleBlock = {
		kind: "rule",
		// Scaled at measure time; the constant above is the neutral baseline.
		height: scaledLineBoxHeight(PRUNE_DIVIDER_LABEL_FONT_SIZE, 1.55),
		marginTop: PRUNE_DIVIDER_MARGIN_Y,
		contentLeft: 0,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
	const frame = accumulateFrame([block], contentWidth, NO_TEXT_MEASURE);
	// accumulateFrame folds marginTop into contentHeight; add the bottom margin.
	const height = frame.contentHeight + PRUNE_DIVIDER_MARGIN_Y;
	return {
		height,
		blocks: [block],
		frame,
		contentWidth,
		usedWidth: contentWidth,
	};
}

export const MEASURE_MISC_CONSTANTS = {
	PRUNE_DIVIDER_MARGIN_Y,
	PRUNE_DIVIDER_LABEL_FONT_SIZE,
	PRUNE_DIVIDER_LABEL_ROW,
	PRUNE_DIVIDER_HEIGHT,
} as const;
