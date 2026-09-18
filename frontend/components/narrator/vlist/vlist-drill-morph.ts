/**
 * vlist-drill-morph.ts — The PURE arithmetic behind drill-down header morphs,
 * driven by a DECLARATIVE row-level diff rather than a click capture.
 *
 * ## Why a diff, not a capture
 *
 * A folded trace's drill-down state (`expandedTraceRows`) is a Set of row keys —
 * any number of rows can be drilled in at once, and a live stream can flip them in
 * any combination. The earlier capture-based design stored ONE pending morph in a
 * single-slot ref at click time; a second toggle overwrote the first, so stacked
 * activity silently dropped morphs, and the geometry was derived in scattered
 * places (committed state for expand, captured state for collapse), which is where
 * the "wrong position" bugs came from.
 *
 * This module takes the fold animation's own paradigm — compare a before/after
 * geometry pair — and sinks it to the trace's ROW level. After every committed
 * rebuild the shell snapshots every visible trace row's drill state and header-line
 * viewport position, then diffs the new snapshot against the previous frame's. Any
 * row whose `drilled` flag flipped between the two frames gets a morph; N flips in
 * one frame produce N plans, so stacked activity is handled natively.
 *
 * Everything here is computed from the layout's own numbers (`exactLayout` trace
 * tops, the measured `rows[]` of each trace, `scrollTop`) — NO DOM measurement, and
 * no React state. The committed DOM is the truth; the snapshot is pure data.
 */

import { BARE_ROW_CHEVRON, BARE_ROW_GAP } from "@shared/pretext-layout/row-metrics";
import { CARD_BORDER, CARD_PADDING } from "./measure/measure-tool-call";
import { FOLD_DURATION_MS } from "./vlist-fold-animation";

/** How long a header morph lasts. Matches the fold transition (Mantine Collapse). */
export const HEADER_MORPH_DURATION_MS = FOLD_DURATION_MS;

/**
 * Horizontal offset between where the two forms start their content, in px.
 *
 * Both ends have to be counted, and an earlier version counted only one — which put the
 * morph's target 11px too far right:
 *
 *  - a folded trace row leads with a chevron slot (`BARE_ROW_CHEVRON` 12) plus the row's
 *    cell gap (`BARE_ROW_GAP` 6), so its icon lane starts at **18** from the block edge;
 *  - a card header does NOT start at 0: the card is a bordered, padded `Paper`, so its
 *    header begins at `CARD_BORDER + CARD_PADDING` = **11**. (Its own chevron is at the
 *    END of the line, which is why nothing precedes the icon.)
 *
 * The visible jump is therefore the DIFFERENCE, `18 − 11 = 7`, not the row's lane alone.
 * This is the same pair of numbers `measure-tool-run` uses for `drillHeader.left`, so the
 * compensation and the measured geometry cannot disagree.
 *
 * Derived from the shared constants rather than written as a literal, so a change to the
 * chevron slot, the row gap, or the card's padding cannot silently leave it stale.
 */
export const DRILL_MORPH_X_OFFSET = BARE_ROW_CHEVRON + BARE_ROW_GAP - (CARD_BORDER + CARD_PADDING);

/** The folded summary row's height (the morph's collapsed-state line). */
export const DRILL_ROW_HEIGHT = 18.8;

/** Which way one row's morph runs. */
export type DrillMorphKind = "expand" | "collapse";

/**
 * One trace row's drill state at a committed frame.
 *
 * `rowUid` is globally unique across the document: `${traceKey}::${rowKey}`. The
 * trace key alone cannot address a row (a trace has many), and the row key alone is
 * only unique within its trace.
 *
 * `headerViewportTop` is the vertical CENTRE of the line the reader perceives as
 * this row's "title", in viewport px:
 *   - drilled (card shown)  → the card's own header centre;
 *   - folded (summary row)  → the summary line centre.
 * Storing the CENTRE lets one pair of snapshots yield both morph directions with
 * pixel symmetry (see `diffDrillSnapshots`).
 */
export interface DrillRowSnapshot {
	readonly rowUid: string;
	readonly drilled: boolean;
	readonly headerViewportTop: number;
	/** Header centre relative to its own row block, independent of scroll correction. */
	readonly headerLocalTop: number;
	/** Height of the incoming header line, used to test its start box against the after clip. */
	readonly headerHeight: number;
	/** The row block's viewport clip, when the measured block height is available. */
	readonly clip: { readonly top: number; readonly bottom: number } | null;
}

/** The minimal shape the snapshot builder needs from a measured trace row. */
export interface DrillMeasuredRow {
	readonly key: string;
	readonly top: number;
	readonly drilled: boolean;
	/** Measured height of the row's whole painted block. */
	readonly blockHeight?: number;
	/** Card header rect within the row block (drilled rows only), else null. */
	readonly drillHeader: { readonly top: number; readonly height: number } | null;
}

/** The minimal shape the snapshot builder needs from one visible trace element. */
export interface DrillTraceSource {
	readonly traceKey: string;
	/** Trace element's top in DOCUMENT px (from the exact layout). */
	readonly top: number;
	readonly rows: readonly DrillMeasuredRow[];
}

/** What `diffDrillSnapshots` produces for one flipped row. */
export interface DrillMorphPlan {
	readonly rowUid: string;
	readonly kind: DrillMorphKind;
	/**
	 * Vertical distance the line travels, in px. Expand uses viewport travel from summary to
	 * card header; collapse uses the local card-header → summary delta. The DOM edge applies
	 * the direction appropriate to the morph kind.
	 */
	readonly driftY: number;
	readonly durationMs: number;
}

/**
 * Snapshot every visible trace's rows.
 *
 * `scrollTop` converts the document-space layout offsets into the viewport space the
 * reader actually sees, so a morph anchored to a row tracks it even when the
 * anchored rebuild rewrote scrollTop.
 */
export function buildDrillSnapshots(
	traces: readonly DrillTraceSource[],
	scrollTop: number,
): Map<string, DrillRowSnapshot> {
	const out = new Map<string, DrillRowSnapshot>();
	for (const trace of traces) {
		for (const row of trace.rows) {
			const rowBlockTop = trace.top + row.top;
			const headerHeight = row.drilled
				? (row.drillHeader?.height ?? DRILL_ROW_HEIGHT)
				: DRILL_ROW_HEIGHT;
			const headerLocalTop = row.drilled
				? // Drilled: the card header's centre is the perceived title line. The card
					// fills the row block from its top, so the header sits at drillHeader.top.
					(row.drillHeader?.top ?? 0) + headerHeight / 2
				: // Folded: the summary line's own centre.
					DRILL_ROW_HEIGHT / 2;
			const headerViewportTop = rowBlockTop + headerLocalTop - scrollTop;
			const blockHeight =
				typeof row.blockHeight === "number" && Number.isFinite(row.blockHeight)
					? row.blockHeight
					: null;
			out.set(`${trace.traceKey}::${row.key}`, {
				rowUid: `${trace.traceKey}::${row.key}`,
				drilled: row.drilled,
				headerViewportTop,
				headerLocalTop,
				headerHeight,
				clip:
					blockHeight === null
						? null
						: {
								top: rowBlockTop - scrollTop,
								bottom: rowBlockTop + blockHeight - scrollTop,
							},
			});
		}
	}
	return out;
}

/**
 * Diff two committed snapshots into per-row morph plans.
 *
 * A row morphs only when its `drilled` flag FLIPPED between the two frames AND it
 * exists in both. A row present in only one frame (freshly mounted, or unmounted by
 * the rebuild) has no counterpart to morph from/to — the same rule the fold applies
 * ("only rows present in BOTH maps are animated").
 *
 * Expand and collapse read the SAME two endpoints in opposite directions:
 *   - folded-centre  = the row's own summary line;
 *   - drilled-centre = the card header.
 * Expand's incoming line (the card header) starts at the folded centre and travels
 * DOWN to its committed spot. Collapse keeps the retained card header as the animated
 * node and uses the LOCAL card-header → summary delta, so pinned-bottom scroll correction
 * cannot become part of the header morph.
 */
function overlapsClip(clip: DrillRowSnapshot["clip"], top: number, height: number): boolean {
	if (!clip) return true;
	return top < clip.bottom && top + height > clip.top;
}

export function diffDrillSnapshots(
	prev: ReadonlyMap<string, DrillRowSnapshot>,
	next: ReadonlyMap<string, DrillRowSnapshot>,
): DrillMorphPlan[] {
	const out: DrillMorphPlan[] = [];
	for (const [rowUid, after] of next) {
		const before = prev.get(rowUid);
		if (!before) continue;
		if (before.drilled === after.drilled) continue;
		const kind: DrillMorphKind = after.drilled ? "expand" : "collapse";
		// The incoming line travels from where the OUTGOING line was to where it now
		// is. Expand: incoming = card header (after), outgoing = summary (before).
		// Collapse: incoming = summary (after), outgoing = card header (before).
		const driftY = after.headerViewportTop - before.headerViewportTop;
		/**
		 * Collapse stays a real morph, but its vertical delta must be LOCAL to the row block.
		 * The viewport delta includes the pinned-bottom scroll correction, which can be hundreds
		 * of pixels and would send the retained header through the shrinking clip into the next
		 * block. The local header centres preserve the intended card-header → summary movement.
		 *
		 * On expand the NEW card header is clipped by the after row block. A pinned-bottom
		 * rebuild can move that block upward by the newly revealed card height, leaving the
		 * old summary position wholly below the block. Translating the header from there
		 * would make it invisible for the whole morph, so keep the committed header in place
		 * and let the fold/scroll correction carry the structural movement.
		 */
		const collapseDriftY = after.headerLocalTop - before.headerLocalTop;
		const startTop = before.headerViewportTop - after.headerHeight / 2;
		const visibleStart =
			kind !== "expand" || overlapsClip(after.clip, startTop, after.headerHeight);
		out.push({
			rowUid,
			kind,
			driftY: !visibleStart ? 0 : kind === "collapse" ? collapseDriftY : driftY,
			durationMs: HEADER_MORPH_DURATION_MS,
		});
	}
	return out;
}
