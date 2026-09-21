/**
 * Measures how many narrator-header tool entries fit, so the icon row collapses
 * into the overflow menu instead of squeezing the title to nothing.
 *
 * The measurement discipline mirrors `NarratorStatusToolbar`:
 *  - Observe only elements this hook does not add or remove (the header row and
 *    its leading group). Watching the entry wrappers would feed the result back
 *    in as an input.
 *  - Coalesce every trigger into one animation frame: ResizeObserver fires while
 *    the DOM is still settling, and measuring per notification resolves against
 *    half-applied layouts.
 *  - Resolve in a layout effect so a wide first pass is corrected before paint.
 */

import {
	HEADER_TITLE_MIN_WIDTH_PX,
	resolveHeaderToolbarBudget,
	resolveHeaderToolbarCapacity,
} from "@frontend/components/narrator/header/narrator-header-toolbar-capacity";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface UseNarratorHeaderToolbarCapacityOptions {
	/** Header row: the budget source, since its width is independent of the result. */
	rowRef: RefObject<HTMLDivElement | null>;
	/** Container holding the collapsible entries and the fixed trailing controls. */
	toolbarRef: RefObject<HTMLDivElement | null>;
	/** Leading group (navigation, title slot, connection badge). */
	leadingRef: RefObject<HTMLDivElement | null>;
	/** Width reserved for the title; 0 when the host draws the title itself. */
	titleSlotMinWidth?: number;
	/** Optional hard share for the toolbar; null = title floor first, then remaining width. */
	maxWidthFraction?: number | null;
	/** Number of candidate entries. */
	itemCount: number;
	/**
	 * Upper bound applied on top of the measurement. Mobile keeps its fixed cap so
	 * a phone never trades a readable title for a wide row; `null` = no bound.
	 */
	maxCapacity?: number | null;
	/** Set false while the header is not rendered (skeleton, workspace preview). */
	enabled?: boolean;
}

/**
 * @returns the number of entries that fit, or `null` while no successful
 * measurement exists (no ResizeObserver, zero-width first frame, SSR). Callers
 * must treat `null` as "no cap" so the row degrades to its previous behaviour
 * rather than rendering an empty toolbar.
 */
export function useNarratorHeaderToolbarCapacity({
	rowRef,
	toolbarRef,
	leadingRef,
	titleSlotMinWidth = HEADER_TITLE_MIN_WIDTH_PX,
	maxWidthFraction = null,
	itemCount,
	maxCapacity = null,
	enabled = true,
}: UseNarratorHeaderToolbarCapacityOptions): number | null {
	const [capacity, setCapacity] = useState<number | null>(null);
	const capacityRef = useRef<number | null>(null);
	/**
	 * The entry count the current capacity was resolved for.
	 *
	 * Hysteresis exists to absorb width jitter, so its baseline is only meaningful
	 * while the candidate set is unchanged. Carrying it across a change in
	 * `itemCount` — a narrator gaining `git` when a chapter appears, say — would let
	 * the old, smaller answer hold the row below what actually fits, and nothing
	 * would ever trigger a correction because no width changed.
	 */
	const baselineItemCountRef = useRef<number | null>(null);
	const frameRef = useRef<number | null>(null);
	/**
	 * Whether the measured DOM anchors have been observed at least once.
	 *
	 * The panel-level controller runs above the skeleton early-return, so the first
	 * effect pass sees `rowRef.current === null`. If the candidate set does not
	 * change when the real header mounts, no effect dependency changes and the
	 * observer would never register — capacity stays null forever. Tracking the
	 * null→non-null transition gives the effect a reason to re-run.
	 */
	const [refsReady, setRefsReady] = useState(false);

	const measure = useCallback(() => {
		if (!enabled) return;
		const row = rowRef.current;
		const toolbar = toolbarRef.current;
		const leading = leadingRef.current;
		if (!row || !toolbar || !leading) return;

		const budgetWidth = resolveHeaderToolbarBudget({
			row,
			toolbar,
			leading,
			titleSlotMinWidth,
			maxWidthFraction,
		});
		// Only an unmeasured row should retain the previous answer. A measured row
		// can legitimately have zero budget: all entries must then collapse.
		if (row.getBoundingClientRect().width <= 0) return;

		const next = resolveHeaderToolbarCapacity({
			budgetWidth,
			itemCount,
			previousCapacity: baselineItemCountRef.current === itemCount ? capacityRef.current : null,
		});
		baselineItemCountRef.current = itemCount;
		if (capacityRef.current !== next) {
			capacityRef.current = next;
			setCapacity(next);
		}
	}, [enabled, rowRef, toolbarRef, leadingRef, titleSlotMinWidth, maxWidthFraction, itemCount]);

	const scheduleMeasure = useCallback(() => {
		if (frameRef.current != null) return;
		if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
			measure();
			return;
		}
		frameRef.current = window.requestAnimationFrame(() => {
			frameRef.current = null;
			measure();
		});
	}, [measure]);

	useEffect(
		() => () => {
			if (frameRef.current != null && typeof window !== "undefined") {
				window.cancelAnimationFrame(frameRef.current);
				frameRef.current = null;
			}
		},
		[],
	);

	// Detect the skeleton→header transition: the controller runs above the early
	// return, so refs start null and only become valid after the real DOM mounts.
	// Without this gate the effects below would run once with null refs, see no
	// dependency change when the header appears, and never measure or observe.
	useLayoutEffect(() => {
		if (!enabled) return;
		if (rowRef.current && !refsReady) setRefsReady(true);
	}, [enabled, rowRef, refsReady]);

	// Re-measure on every committed layout, before paint — but only once the DOM
	// anchors actually exist.
	useLayoutEffect(() => {
		if (!refsReady) return;
		measure();
	}, [refsReady, measure]);

	useLayoutEffect(() => {
		if (!enabled || !refsReady) return;
		const row = rowRef.current;
		const leading = leadingRef.current;
		if (!row) return;
		const observer =
			typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
		observer?.observe(row);
		if (leading) observer?.observe(leading);
		if (typeof window !== "undefined") window.addEventListener("resize", scheduleMeasure);
		return () => {
			observer?.disconnect();
			if (typeof window !== "undefined") window.removeEventListener("resize", scheduleMeasure);
		};
	}, [enabled, refsReady, rowRef, leadingRef, scheduleMeasure]);

	if (capacity == null) return null;
	return maxCapacity == null ? capacity : Math.min(maxCapacity, capacity);
}
