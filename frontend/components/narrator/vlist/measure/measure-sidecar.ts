/**
 * measure-sidecar.ts — Height model for ONE system injection, drawn as a FOOTNOTE.
 *
 * ## The shape
 *
 * No card: no Paper, no border, no background, no accent rail. A footnote is a header
 * row at exactly the bare-row height (`@shared/pretext-layout/row-metrics` — the same
 * 18.8px a folded trace row uses) plus, when it shows a body, a run of indented lines
 * beneath it. The previous form was a coloured Paper with a 2px accent rail, i.e. the
 * heaviest skin in the whole list wrapped around its least important content.
 *
 * ## Four geometries, from `form` × `expanded`
 *
 *   folded / collapsed : header row only. CONSTANT height — the headline is a single
 *                        clamped line, so its length never enters the model.
 *   folded / expanded  : header row + every body line.
 *   open   / collapsed : header row + body lines CAPPED at SIDECAR_INLINE_MAX_LINES,
 *                        plus a "show all" row when the cap bit.
 *   open   / expanded   : header row + every body line.
 *
 * `form` comes from the injection's tone (`@shared/sidecar-body`): a message someone
 * sent you or a finished task's result opens on its own, a routine reminder folds.
 * It is a SHAPE, not a fold default — `expanded` still starts false in every case.
 *
 * ## Why every line is its own prepared block
 *
 * A `bullet` line reserves `SIDECAR_BULLET_LANE` for its marker and therefore wraps
 * at a NARROWER width than a `text` line beside it. One block for the whole body
 * could only be measured at a single width, so it would mispredict every mixed body.
 * Each line is prepared separately and carries its own `contentLeft`, and the render
 * layer re-materializes those exact blocks — zero drift, zero DOM.
 *
 * Height does not depend on `lod`: a side-car is the evidence of what the model was
 * shown, and hiding it at a low level would let the reader believe it never happened.
 */

import { measureLineStats, prepareWithSegments } from "@chenglou/pretext";
import { BARE_ROW_HEIGHT } from "@shared/pretext-layout/row-metrics";
import type { SidecarSpecData } from "@shared/pretext-layout/segment-adapter";
import {
	SIDECAR_BODY_INDENT,
	SIDECAR_BULLET_LANE,
	SIDECAR_INLINE_MAX_LINES,
} from "@shared/pretext-layout/sidecar";
import type { SideCarLine } from "@shared/sidecar-body";
import {
	accumulateFrame,
	DEFAULT_RENDER_LOD,
	type MeasuredElement,
	type PreparedBlock,
	type PreparedCodeBlock,
	type PreparedFixedBlock,
	type RenderLod,
} from "../prepared-block";
import { FONT_SIZE, FONT_XS, LINE_HEIGHT, lineBoxHeight } from "../pretext-fonts";
import { pretextLineMetrics } from "./pretext-metrics";

// ── Chrome constants (px) — CONTRACT.md §3/§4 + pretext-fonts.ts ──────────────

/** Header row height — the SAME bare row a folded trace uses (18.8px). */
export const SIDECAR_HEADER_ROW = BARE_ROW_HEIGHT;
/** xs line box: round(12 × 1.4) = 17. Used by the body lines. */
export const SIDECAR_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // 17
/** Gap between the header row and the first body line. */
export const SIDECAR_HEADER_BODY_GAP = 4;
/** Left inset of the body lines (no rail — see the module header). */
export const SIDECAR_BODY_LEFT = SIDECAR_BODY_INDENT;
/** Extra inset a `bullet` line's text takes for its marker. */
export const SIDECAR_BULLET_INSET = SIDECAR_BULLET_LANE;

/**
 * Hard ceiling on the measured body, whatever `expanded` says.
 *
 * Distinct in KIND from `SIDECAR_INLINE_MAX_LINES` (the `open` default the reader can
 * pass): this one bounds MEASUREMENT COST for a pathological record and cannot be
 * passed at all — the complete text stays one copy-click away.
 */
export const SIDECAR_DETAIL_MAX_LINES = 40;

/**
 * Height of the row appended when a cap clipped the body — either the "show all"
 * affordance (`open` hit the inline cap) or the truncation notice (the hard ceiling
 * bit).
 *
 * Reserved HERE rather than decided by the renderer: the body lane is a fixed-height
 * `overflow:hidden` box, so a row the render layer drew on its own would either be
 * clipped away or push a body line out of the box (CONTRACT §0 rule 2 — height is
 * pure arithmetic and the painted shape must be the measured shape).
 */
export const SIDECAR_EXTRA_ROW_HEIGHT = SIDECAR_LINE_HEIGHT; // 17
/** Gap between the last body line and that extra row. */
export const SIDECAR_EXTRA_ROW_GAP = 4;

/** Collapsed `folded` footnote height (constant). */
export const SIDECAR_COLLAPSED_HEIGHT = SIDECAR_HEADER_ROW;

// ── Measure ──────────────────────────────────────────────────────────────────

/** Which trailing row (if any) the measure pass reserved below the body. */
export type SidecarExtraRow = "none" | "showAll" | "truncated";

export interface MeasuredSidecar extends MeasuredElement {
	/** Whether the reader has opened this footnote past its default. */
	expanded: boolean;
	/** Header row height (px) — constant. */
	headerRow: number;
	/** Total measured body height (0 when no body is drawn). */
	bodyHeight: number;
	/** Top offset of the first body line within the footnote. */
	bodyTop: number;
	/** Width a plain `text` body line wrapped at. */
	bodyWidth: number;
	/**
	 * Per-line geometry, index-aligned with the drawn subset of `payload.lines`.
	 * The renderer paints `blocks[1 + i]` at `lines[i]`.
	 */
	lines: MeasuredSidecarLine[];
	/**
	 * Which trailing row was reserved:
	 *   `showAll`     — an `open` footnote hit the inline cap; the row is the toggle.
	 *   `truncated`   — the hard ceiling bit; the row says so (copy holds the rest).
	 *   `none`        — the whole body is drawn.
	 */
	extraRow: SidecarExtraRow;
	/** Reserved extra-row height (0 when `extraRow === "none"`). */
	extraRowHeight: number;
	/** Top offset of the extra row within the footnote (-1 when absent). */
	extraRowTop: number;
	/** Localized text for the extra row (adapter-composed; empty when absent). */
	extraRowText: string;
	/** How many body lines exist in total (for the "show all" wording). */
	totalLineCount: number;
	/** Render payload (source label / tone / headline / lines / full text). */
	payload: SidecarSpecData;
}

/** One drawn body line's resolved geometry. */
export interface MeasuredSidecarLine {
	kind: SideCarLine["kind"];
	/** Dim this line (a secondary/not-yet-started entry). */
	dimmed: boolean;
	/** Top offset within the footnote. */
	top: number;
	height: number;
	/** Left inset of the TEXT (past the bullet lane, when this is a bullet). */
	left: number;
	/** Width this line wrapped at. */
	width: number;
	/** Wrapped line count (height === lineCount × SIDECAR_LINE_HEIGHT). */
	lineCount: number;
}

/**
 * Measure one side-car footnote. `data` is the adapter's `SidecarSpecData`;
 * `opts.expanded` means "show past the default", not "open at all". Zero DOM.
 */
export function measureSidecar(
	data: SidecarSpecData,
	contentWidth: number,
	_lod: RenderLod = DEFAULT_RENDER_LOD,
	opts?: { expanded?: boolean },
): MeasuredSidecar {
	const expanded = opts?.expanded === true;
	const isOpen = data.form === "open";
	const allLines = data.lines ?? [];
	// `folded` shows nothing until asked; `open` always shows something.
	const drawsBody = allLines.length > 0 && (expanded || isOpen);

	// Body lane: the footnote's width minus the indent. A bullet's TEXT is inset
	// further still (its marker lane), which is why lines are measured one by one.
	const bodyWidth = Math.max(1, contentWidth - SIDECAR_BODY_LEFT);

	const headerBlock: PreparedFixedBlock = {
		kind: "fixed",
		height: SIDECAR_HEADER_ROW,
		tag: "sidecar-header",
		data: { headline: data.headline } as Record<string, unknown>,
		marginTop: 0,
		contentLeft: 0,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};

	const blocks: PreparedBlock[] = [headerBlock];
	const lines: MeasuredSidecarLine[] = [];
	let bodyHeight = 0;
	const bodyTop = SIDECAR_HEADER_ROW + (drawsBody ? SIDECAR_HEADER_BODY_GAP : 0);

	// Line budget for THIS geometry. The inline cap applies only to an `open`
	// footnote the reader has not opened; the hard ceiling always applies.
	const budget = Math.min(
		SIDECAR_DETAIL_MAX_LINES,
		expanded
			? SIDECAR_DETAIL_MAX_LINES
			: isOpen
				? SIDECAR_INLINE_MAX_LINES
				: Number.MAX_SAFE_INTEGER,
	);

	let cursor = bodyTop;
	let usedLines = 0;
	let clipped = false;
	if (drawsBody) {
		for (const line of allLines) {
			if (usedLines >= budget) {
				clipped = true;
				break;
			}
			const isBullet = line.kind === "bullet";
			const left = SIDECAR_BODY_LEFT + (isBullet ? SIDECAR_BULLET_INSET : 0);
			const width = Math.max(1, contentWidth - left);
			const block: PreparedCodeBlock = {
				kind: "code",
				prepared: prepareWithSegments(line.text || " ", FONT_XS, { whiteSpace: "pre-wrap" }),
				lineHeight: SIDECAR_LINE_HEIGHT,
				lang: null,
				// The first body block carries the header→body gap so the frame's block
				// tops match the painted offsets exactly.
				marginTop: usedLines === 0 ? SIDECAR_HEADER_BODY_GAP : 0,
				contentLeft: left,
				quoteRailLefts: [],
				markerText: null,
				markerLeft: null,
				markerClassName: null,
			};
			const stats = measureLineStats(block.prepared, width);
			// A single logical line can wrap into several; clamp it to what is left of
			// the budget so one very long bullet cannot blow past the ceiling.
			const remaining = budget - usedLines;
			const lineCount = Math.max(1, Math.min(stats.lineCount, remaining));
			if (stats.lineCount > lineCount) clipped = true;
			const height = lineCount * SIDECAR_LINE_HEIGHT;
			blocks.push(block);
			lines.push({
				kind: line.kind,
				dimmed: line.dimmed === true,
				top: cursor,
				height,
				left,
				width,
				lineCount,
			});
			cursor += height;
			bodyHeight += height;
			usedLines += lineCount;
		}
	}

	// A clipped body gets a reserved trailing row, and WHICH row depends on why it
	// was clipped: an `open` footnote that merely hit its inline default offers to
	// show the rest, while a body that hit the hard ceiling can only point at copy.
	// Reserved only when there IS text to paint, so the measured height and the
	// painted rows always agree (a fixture without labels reserves nothing).
	const hitCeiling = usedLines >= SIDECAR_DETAIL_MAX_LINES;
	let extraRow: SidecarExtraRow = "none";
	let extraRowText = "";
	if (clipped) {
		if (!expanded && isOpen && !hitCeiling) {
			extraRowText = data.showAllLabel ?? "";
			if (extraRowText) extraRow = "showAll";
		} else {
			extraRowText = data.truncatedLabel ?? "";
			if (extraRowText) extraRow = "truncated";
		}
	}
	const hasExtra = extraRow !== "none";
	const extraRowHeight = hasExtra ? SIDECAR_EXTRA_ROW_HEIGHT : 0;
	const extraRowTop = hasExtra ? cursor + SIDECAR_EXTRA_ROW_GAP : -1;

	const frame = accumulateFrame(blocks, bodyWidth, pretextLineMetrics, {
		codePaddingX: 0,
		codePaddingY: 0,
		codeLangExtraTop: 0,
	});

	const height =
		SIDECAR_HEADER_ROW +
		(drawsBody && bodyHeight > 0 ? SIDECAR_HEADER_BODY_GAP + bodyHeight : 0) +
		(hasExtra ? SIDECAR_EXTRA_ROW_GAP + extraRowHeight : 0);

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
		lines,
		extraRow,
		extraRowHeight,
		extraRowTop,
		extraRowText,
		totalLineCount: allLines.length,
		payload: data,
	};
}

export const MEASURE_SIDECAR_CONSTANTS = {
	SIDECAR_HEADER_ROW,
	SIDECAR_LINE_HEIGHT,
	SIDECAR_HEADER_BODY_GAP,
	SIDECAR_BODY_LEFT,
	SIDECAR_BULLET_INSET,
	SIDECAR_DETAIL_MAX_LINES,
	SIDECAR_EXTRA_ROW_HEIGHT,
	SIDECAR_EXTRA_ROW_GAP,
	SIDECAR_COLLAPSED_HEIGHT,
} as const;
