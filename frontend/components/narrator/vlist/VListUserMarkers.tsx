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
 * Tooltips are a single in-page element shared by all marks rather than native
 * `title` attributes or one Mantine `Tooltip` per mark: native tooltips carry the
 * OS delay and styling, and a hundred floating instances would be paid for on
 * every scroll frame. Hovering a mark swaps the shared tooltip's text and
 * position, so the cost stays constant no matter how long the conversation is.
 *
 * The tooltip clamps itself INSIDE the track using its own measured height, so
 * a mark at the very top/bottom of the viewport never pushes it under the
 * panel's title bar or composer. Measuring the tooltip (an overlay element we
 * own) touches no document row, so the height-neutrality law above is intact.
 */

import { formatShortMessageTime } from "@frontend/lib/intl-format";
import { memo, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	resolveVListUserMarkerTop,
	shouldShowVListUserMarkers,
	type VListCompactMarker,
	type VListUserMarker,
} from "./vlist-user-markers";
import "./vlist-markers.css";

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

/** Gap between a hovered mark and the shared tooltip's right edge. */
const TOOLTIP_GAP = 6;
/** Keeps the shared tooltip off the very top/bottom edge of the track. */
const TOOLTIP_EDGE_GAP = 10;

/** The one tooltip shown at a time: text lines plus the mark's track offset. */
interface HoveredMarkerTooltip {
	key: string;
	/** "#3 · first words of the turn" — the main line. */
	label: string;
	/** Formatted send time, "" when the row carries no timestamp. */
	timeLabel: string;
	top: number;
}

export interface VListUserMarkersProps {
	markers: readonly VListUserMarker[];
	/** Compact-indicator marks, drawn in the same track with status colours. */
	compactMarkers?: readonly VListCompactMarker[];
	/** Full scrollable height (canvas + footer) the fractions were derived from. */
	documentHeight: number;
	/** Viewport height — the track length, and the "is scrolling useful" test. */
	trackHeight: number;
	/** Scroll the list to a marker's document offset. */
	onJump: (marker: VListUserMarker) => void;
	/** Scroll the list to a compact marker's document offset. */
	onJumpCompact?: (marker: VListCompactMarker) => void;
	/** The scroll viewport, measured for its native scrollbar width. */
	viewportRef: RefObject<HTMLElement | null>;
	/** Localized aria-label builder ("Jump to message #3"). */
	resolveLabel: (ordinal: number) => string;
	/** Localized aria-label builder for compact marks ("Jump to compact marker"). */
	resolveCompactLabel?: (marker: VListCompactMarker) => string;
}

/**
 * Track colours for a compact mark. Failed always reads red — that is the
 * whole point of the index (a failed compact stays visible no matter where the
 * reader scrolls); live/finished marks carry their flavour's colour, matching
 * the timeline indicator (context = orange, segment = teal).
 */
function compactMarkerColor(marker: VListCompactMarker): string {
	if (marker.status === "failed") return "var(--mantine-color-red-4)";
	return marker.flavor === "segment"
		? "var(--mantine-color-teal-4)"
		: "var(--mantine-color-orange-4)";
}

/**
 * Vertical index of user turns, pinned just left of the native scrollbar.
 *
 * Renders nothing when scrolling cannot help (no user turns, or a document that
 * fits the viewport), so a short conversation keeps a clean right edge.
 */
export const VListUserMarkers = memo(function VListUserMarkers({
	markers,
	compactMarkers = [],
	documentHeight,
	trackHeight,
	onJump,
	onJumpCompact,
	viewportRef,
	resolveLabel,
	resolveCompactLabel,
}: VListUserMarkersProps) {
	const [scrollbarWidth, setScrollbarWidth] = useState(0);
	const [hoveredTooltip, setHoveredTooltip] = useState<HoveredMarkerTooltip | null>(null);
	const tooltipRef = useRef<HTMLDivElement | null>(null);
	const [tooltipHeight, setTooltipHeight] = useState(0);

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

	// Measure the tooltip itself so the clamp below keeps its WHOLE box inside
	// the track — a center-anchored tooltip next to a first/last mark would
	// otherwise overflow the viewport edge and slide under the panel chrome.
	// Runs every render (no dep array): the tooltip's height follows its text,
	// which changes on every hover swap, and one offsetHeight read is trivial.
	useLayoutEffect(() => {
		const node = tooltipRef.current;
		const height = node ? node.offsetHeight : 0;
		setTooltipHeight((previous) => (previous === height ? previous : height));
	});

	if (
		!shouldShowVListUserMarkers(markers.length + compactMarkers.length, documentHeight, trackHeight)
	)
		return null;

	const tooltipHalf = tooltipHeight / 2;
	const tooltipMinTop = TOOLTIP_EDGE_GAP + tooltipHalf;
	const tooltipMaxTop = Math.max(tooltipMinTop, trackHeight - TOOLTIP_EDGE_GAP - tooltipHalf);

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
					const top = resolveVListUserMarkerTop(marker.fraction, trackHeight, MARKER_HEIGHT);
					const tooltipLabel = marker.preview
						? `#${marker.ordinal} · ${marker.preview}`
						: `#${marker.ordinal}`;
					return (
						<button
							type="button"
							key={marker.key}
							tabIndex={-1}
							aria-label={label}
							data-vlist-user-marker={marker.ordinal}
							onClick={() => onJump(marker)}
							style={{
								position: "absolute",
								top,
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
								// Formatted on hover, not per render: a long conversation renders a
								// hundred marks, and a hundred Intl.DateTimeFormat calls per render
								// pass would be paid to show one tooltip at a time.
								const timeLabel = marker.createdAt ? formatShortMessageTime(marker.createdAt) : "";
								setHoveredTooltip({ key: marker.key, label: tooltipLabel, timeLabel, top });
							}}
							onMouseLeave={(event) => {
								event.currentTarget.style.width = `${MARKER_WIDTH}px`;
								setHoveredTooltip((current) => (current?.key === marker.key ? null : current));
							}}
						/>
					);
				})}
				{/* Compact marks share the track and render AFTER user marks, so a
				    compact row that collides with a user turn wins the pixels (and the
				    hover): its status is the more transient signal. */}
				{compactMarkers.map((marker) => {
					const top = resolveVListUserMarkerTop(marker.fraction, trackHeight, MARKER_HEIGHT);
					const ariaLabel = resolveCompactLabel?.(marker) ?? marker.tooltip;
					return (
						<button
							type="button"
							key={marker.key}
							tabIndex={-1}
							aria-label={ariaLabel}
							data-vlist-compact-marker={marker.status}
							className={
								marker.status === "compacting" ? "vlist-compact-marker--compacting" : undefined
							}
							onClick={() => onJumpCompact?.(marker)}
							style={{
								position: "absolute",
								top,
								right: 0,
								width: MARKER_WIDTH,
								height: MARKER_HEIGHT,
								borderRadius: "3px 0 0 3px",
								backgroundColor: compactMarkerColor(marker),
								cursor: "pointer",
								pointerEvents: "auto",
								transition: "width 150ms ease",
								border: "none",
								padding: 0,
							}}
							onMouseEnter={(event) => {
								event.currentTarget.style.width = `${MARKER_HOVER_WIDTH}px`;
								setHoveredTooltip({ key: marker.key, label: marker.tooltip, timeLabel: "", top });
							}}
							onMouseLeave={(event) => {
								event.currentTarget.style.width = `${MARKER_WIDTH}px`;
								setHoveredTooltip((current) => (current?.key === marker.key ? null : current));
							}}
						/>
					);
				})}
				{hoveredTooltip && (
					<div
						ref={tooltipRef}
						data-vlist-user-marker-tooltip
						style={{
							position: "absolute",
							right: MARKER_HOVER_WIDTH + TOOLTIP_GAP,
							top: Math.min(Math.max(hoveredTooltip.top, tooltipMinTop), tooltipMaxTop),
							transform: "translateY(-50%)",
							// The track is only MARKER_WIDTH wide; without max-content the
							// shrink-to-fit width collapses to it and the text wraps per
							// character into a vertical strip.
							width: "max-content",
							maxWidth: 260,
							padding: "4px 8px",
							borderRadius: 4,
							backgroundColor: "var(--mantine-color-dark-6)",
							color: "var(--mantine-color-gray-1)",
							fontSize: 12,
							lineHeight: 1.4,
							overflowWrap: "anywhere",
							pointerEvents: "none",
						}}
					>
						{hoveredTooltip.timeLabel && (
							<div
								style={{
									color: "var(--mantine-color-gray-5)",
									fontSize: 11,
									marginBottom: 1,
								}}
							>
								{hoveredTooltip.timeLabel}
							</div>
						)}
						<div style={{ whiteSpace: "pre-wrap" }}>{hoveredTooltip.label}</div>
					</div>
				)}
			</div>
		</div>
	);
});
