import { formatShortMessageTime } from "@frontend/lib/intl-format";
import { memo, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

interface UserMarkerEntry {
	/** Element index in the flat elements array */
	index: number;
	/** Message ID for key */
	id: string;
	/** Message timestamp shown in the tooltip (null when the row carries none) */
	createdAt: string | null;
}

interface ScrollbarUserMarkersProps {
	/** User message positions */
	markers: UserMarkerEntry[];
	/** Total number of elements in the list */
	totalCount: number;
	/** Called when a marker is clicked */
	onJump: (elementIndex: number) => void;
	/** Ref to the scroll container — used to measure native scrollbar width */
	scrollContainerRef: RefObject<HTMLElement | null>;
}

const MARKER_WIDTH = 10;
const MARKER_HOVER_WIDTH = 16;
/** Gap between a hovered mark and the shared tooltip's right edge. */
const TOOLTIP_GAP = 6;
/** Keeps the shared tooltip off the very top/bottom edge of the track. */
const TOOLTIP_EDGE_GAP = 10;

/**
 * Markers sit immediately to the left of the native scrollbar, extending
 * leftward. The scrollbar width is measured dynamically from the scroll
 * container so the markers always align correctly regardless of OS/browser.
 *
 * Tooltips are a single in-page element shared by all marks rather than native
 * `title` attributes: hover swaps the shared tooltip's text and position, so
 * there is no OS tooltip delay and no per-mark floating instance to pay for.
 * The tooltip clamps itself inside the track using its own measured height, so
 * a mark at the very top/bottom of the viewport never pushes it under the
 * panel's title bar or composer.
 */
export const ScrollbarUserMarkers = memo(function ScrollbarUserMarkers({
	markers,
	totalCount,
	onJump,
	scrollContainerRef,
}: ScrollbarUserMarkersProps) {
	const [scrollbarWidth, setScrollbarWidth] = useState(0);
	/** Track length (px) — the scroll viewport's client height, for the tooltip clamp. */
	const [trackHeight, setTrackHeight] = useState(0);
	const [hoveredTooltip, setHoveredTooltip] = useState<{
		id: string;
		label: string;
		timeLabel: string;
		pct: number;
	} | null>(null);
	const tooltipRef = useRef<HTMLDivElement | null>(null);
	const [tooltipHeight, setTooltipHeight] = useState(0);

	useEffect(() => {
		const el = scrollContainerRef.current;
		if (!el) return;
		const measure = () => {
			const w = el.offsetWidth - el.clientWidth;
			setScrollbarWidth((prev) => (prev !== w ? w : prev));
			setTrackHeight((prev) => (prev !== el.clientHeight ? el.clientHeight : prev));
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [scrollContainerRef]);

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

	if (markers.length === 0 || totalCount <= 5) return null;

	/* Firefox overlay scrollbar (and some Linux/macOS configs) reports 0 width.
	   Fall back to a small gutter so markers are still visible at the right edge. */
	const gutter = scrollbarWidth || 2;

	const tooltipHalf = tooltipHeight / 2;
	const tooltipMinTop = TOOLTIP_EDGE_GAP + tooltipHalf;
	const tooltipMaxTop = Math.max(
		tooltipMinTop,
		(trackHeight || Number.POSITIVE_INFINITY) - TOOLTIP_EDGE_GAP - tooltipHalf,
	);

	return (
		<div
			style={{
				position: "absolute",
				top: 0,
				right: gutter,
				bottom: 0,
				width: MARKER_WIDTH,
				zIndex: 5,
				pointerEvents: "none",
			}}
		>
			{markers.map((m, i) => {
				const pct = (m.index / (totalCount - 1)) * 100;
				return (
					<button
						type="button"
						key={m.id}
						tabIndex={-1}
						aria-label={`#${i + 1}`}
						onClick={() => onJump(m.index)}
						style={{
							position: "absolute",
							top: `${pct}%`,
							right: 0,
							width: MARKER_WIDTH,
							height: 6,
							borderRadius: "3px 0 0 3px",
							backgroundColor: "var(--mantine-color-indigo-4)",
							cursor: "pointer",
							pointerEvents: "auto",
							transition: "width 150ms ease",
							border: "none",
							padding: 0,
						}}
						onMouseEnter={(e) => {
							e.currentTarget.style.width = `${MARKER_HOVER_WIDTH}px`;
							// Formatted on hover, not per render: a long conversation renders a
							// hundred marks, and a hundred Intl.DateTimeFormat calls per render
							// pass would be paid to show one tooltip at a time.
							const timeLabel = m.createdAt ? formatShortMessageTime(m.createdAt) : "";
							setHoveredTooltip({ id: m.id, label: `#${i + 1}`, timeLabel, pct });
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.width = `${MARKER_WIDTH}px`;
							setHoveredTooltip((current) => (current?.id === m.id ? null : current));
						}}
					/>
				);
			})}
			{hoveredTooltip && (
				<div
					ref={tooltipRef}
					data-scrollbar-user-marker-tooltip
					style={{
						position: "absolute",
						right: MARKER_HOVER_WIDTH + TOOLTIP_GAP,
						top: Math.min(
							Math.max((hoveredTooltip.pct / 100) * trackHeight, tooltipMinTop),
							tooltipMaxTop,
						),
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
	);
});
