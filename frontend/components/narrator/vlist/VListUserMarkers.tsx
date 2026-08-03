/**
 * VListUserMarkers.tsx — the user-message quick index beside the exact list's
 * scrollbar.
 *
 * The chunked path has `ScrollbarUserMarkers`, which places each mark by the
 * message's SEQUENCE ordinal because it has no pixel geometry for unmounted
 * chunks. The exact list knows every row's real document offset, so this copy
 * places each mark at the turn's true document fraction and jumps by writing that
 * offset directly — no seq resolution, no manifest window expansion, no waiting
 * for the row to mount.
 *
 * Height neutrality (CONTRACT.md §0 iron law 2): a zero-height sticky overlay
 * pinned to the viewport top (the same non-flow trick the older-history spinner
 * uses), with the marks absolutely positioned inside it. It contributes no
 * scrollable height and reads no element size except the viewport's own scrollbar
 * width — the controlled shell exception the guard already allows for the
 * scroll container.
 *
 * Tooltips are native `title` attributes rather than Mantine `Tooltip`s on
 * purpose: a long conversation renders a hundred marks, and a hundred floating
 * instances would be paid for on every scroll frame to show text the browser
 * renders for free.
 */

import { memo, type RefObject, useEffect, useState } from "react";
import {
	resolveVListUserMarkerTop,
	shouldShowVListUserMarkers,
	type VListUserMarker,
} from "./vlist-user-markers";

/** Resting width (px) of one mark; hover widens it without moving the track. */
const MARKER_WIDTH = 10;
const MARKER_HOVER_WIDTH = 16;
const MARKER_HEIGHT = 6;

/**
 * Fallback gutter when the platform reports a zero-width scrollbar (Firefox
 * overlay scrollbars, macOS auto-hide). Matches ScrollbarUserMarkers so both
 * paths sit at the same distance from the right edge.
 */
const OVERLAY_SCROLLBAR_GUTTER = 2;

export interface VListUserMarkersProps {
	markers: readonly VListUserMarker[];
	/** Full scrollable height (canvas + footer) the fractions were derived from. */
	documentHeight: number;
	/** Viewport height — the track length, and the "is scrolling useful" test. */
	trackHeight: number;
	/** Scroll the list to a marker's document offset. */
	onJump: (marker: VListUserMarker) => void;
	/** The scroll viewport, measured for its native scrollbar width. */
	viewportRef: RefObject<HTMLElement | null>;
	/** Localized aria-label builder ("Jump to message #3"). */
	resolveLabel: (ordinal: number) => string;
}

/**
 * Vertical index of user turns, pinned just left of the native scrollbar.
 *
 * Renders nothing when scrolling cannot help (no user turns, or a document that
 * fits the viewport), so a short conversation keeps a clean right edge.
 */
export const VListUserMarkers = memo(function VListUserMarkers({
	markers,
	documentHeight,
	trackHeight,
	onJump,
	viewportRef,
	resolveLabel,
}: VListUserMarkersProps) {
	const [scrollbarWidth, setScrollbarWidth] = useState(0);

	useEffect(() => {
		const node = viewportRef.current;
		if (!node) return;
		const measure = () => {
			const width = node.offsetWidth - node.clientWidth;
			setScrollbarWidth((previous) => (previous !== width ? width : previous));
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [viewportRef]);

	if (!shouldShowVListUserMarkers(markers.length, documentHeight, trackHeight)) return null;

	return (
		<div
			data-vlist-user-markers
			style={{
				position: "sticky",
				top: 0,
				// Zero flow height: the track is drawn by the absolutely positioned marks
				// inside, so this box never grows the document it is indexing.
				height: 0,
				zIndex: 5,
				pointerEvents: "none",
			}}
		>
			<div
				style={{
					position: "absolute",
					top: 0,
					right: scrollbarWidth || OVERLAY_SCROLLBAR_GUTTER,
					height: trackHeight,
					width: MARKER_WIDTH,
				}}
			>
				{markers.map((marker) => {
					const label = resolveLabel(marker.ordinal);
					return (
						<button
							type="button"
							key={marker.key}
							tabIndex={-1}
							title={
								marker.preview ? `#${marker.ordinal} · ${marker.preview}` : `#${marker.ordinal}`
							}
							aria-label={label}
							data-vlist-user-marker={marker.ordinal}
							onClick={() => onJump(marker)}
							style={{
								position: "absolute",
								top: resolveVListUserMarkerTop(marker.fraction, trackHeight, MARKER_HEIGHT),
								right: 0,
								width: MARKER_WIDTH,
								height: MARKER_HEIGHT,
								borderRadius: "3px 0 0 3px",
								backgroundColor: "var(--mantine-color-indigo-4)",
								cursor: "pointer",
								pointerEvents: "auto",
								transition: "width 150ms ease",
								border: "none",
								padding: 0,
							}}
							onMouseEnter={(event) => {
								event.currentTarget.style.width = `${MARKER_HOVER_WIDTH}px`;
							}}
							onMouseLeave={(event) => {
								event.currentTarget.style.width = `${MARKER_WIDTH}px`;
							}}
						/>
					);
				})}
			</div>
		</div>
	);
});
