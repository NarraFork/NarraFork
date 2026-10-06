import { useCallback, useEffect, useRef } from "react";

/**
 * useLodAnchor — keep the content under the gesture/mouse visually stable
 * across a render-LOD switch.
 *
 * A LOD switch changes the height of many blocks, which would otherwise make
 * the viewport content jump. This hook captures an "anchor" (the block element
 * under the gesture point + that point's offset from the block's top) right
 * BEFORE the level changes, then — after React commits and ResizeObservers
 * settle — shifts the scroll container so the anchor returns to its previous
 * viewport position.
 *
 * Usage:
 *   const { captureAnchor, scheduleRestore } = useLodAnchor(scrollerRef, contentRef, lod);
 *   // in the gesture handler, BEFORE setLod:
 *   captureAnchor(clientX, clientY);
 *   setLod(next);            // triggers the restore effect via the `lod` dep
 */

interface AnchorSnapshot {
	/** The anchored block element, or null when no block was found under the point. */
	el: HTMLElement | null;
	/** Viewport Y of the gesture point at capture time. */
	pointClientY: number;
	/** The anchor element's top at capture time. */
	elTop: number;
	/** scrollTop / scrollHeight ratio at capture time (fallback). */
	ratio: number;
	scrollTop: number;
	scrollHeight: number;
}

/** Find the nearest block-level anchor element at/above the given point. */
function findAnchorElement(x: number, y: number, within: HTMLElement | null): HTMLElement | null {
	let node = document.elementFromPoint(x, y) as HTMLElement | null;
	// elementFromPoint may return a node outside our content (e.g. overlay); walk
	// up until inside `within`.
	while (node && within && !within.contains(node)) {
		node = node.parentElement;
	}
	while (node && node !== within) {
		if (
			node.hasAttribute("data-message-id") ||
			node.hasAttribute("data-tool-run") ||
			node.id.startsWith("msg-") ||
			node.id.startsWith("tool-use-")
		) {
			return node;
		}
		node = node.parentElement;
	}
	return null;
}

export function useLodAnchor(
	scrollerRef: React.RefObject<HTMLDivElement | null>,
	lod: number,
): {
	captureAnchor: (clientX: number, clientY: number) => void;
} {
	const snapshotRef = useRef<AnchorSnapshot | null>(null);
	// Track the previous lod so the restore effect only runs on an actual change
	// (not on mount or unrelated renders).
	const prevLodRef = useRef(lod);

	const captureAnchor = useCallback(
		(clientX: number, clientY: number) => {
			const scroller = scrollerRef.current;
			if (!scroller) return;
			const el = findAnchorElement(clientX, clientY, scroller);
			const scrollHeight = scroller.scrollHeight;
			const scrollTop = scroller.scrollTop;
			snapshotRef.current = {
				el,
				pointClientY: clientY,
				elTop: el ? el.getBoundingClientRect().top : 0,
				ratio: scrollHeight > 0 ? scrollTop / scrollHeight : 0,
				scrollTop,
				scrollHeight,
			};
		},
		[scrollerRef],
	);

	useEffect(() => {
		if (prevLodRef.current === lod) return;
		prevLodRef.current = lod;
		const snapshot = snapshotRef.current;
		snapshotRef.current = null;
		const scroller = scrollerRef.current;
		if (!snapshot || !scroller) return;

		// Restore after React commits + ResizeObservers report. rAF lands us after
		// layout; the anchor element may have been unmounted (folded into a count
		// line) — fall back to the scroll ratio in that case.
		const raf = requestAnimationFrame(() => {
			const el = scrollerRef.current;
			if (!el) return;
			if (snapshot.el?.isConnected) {
				// Precise path: the same block element still exists — shift it back to
				// its captured viewport position.
				const newTop = snapshot.el.getBoundingClientRect().top;
				const delta = newTop - snapshot.elTop;
				if (delta !== 0) el.scrollTop += delta;
			} else {
				// No anchor block found, or it was unmounted by the LOD switch (folded
				// into a count line) — approximate by preserving the scroll ratio
				// through the (now different) total height.
				const newHeight = el.scrollHeight;
				if (newHeight > 0) el.scrollTop = snapshot.ratio * newHeight;
			}
		});
		return () => cancelAnimationFrame(raf);
	}, [lod, scrollerRef]);

	return { captureAnchor };
}
