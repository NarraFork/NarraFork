import { memo, type RefObject, useEffect, useRef, useState } from "react";

interface UserMarkerEntry {
	/** Element index in the flat elements array */
	index: number;
	/** Message ID for key */
	id: string;
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

/**
 * Markers sit immediately to the left of the native scrollbar, extending
 * leftward. The scrollbar width is measured dynamically from the scroll
 * container so the markers always align correctly regardless of OS/browser.
 */
export const ScrollbarUserMarkers = memo(function ScrollbarUserMarkers({
	markers,
	totalCount,
	onJump,
	scrollContainerRef,
}: ScrollbarUserMarkersProps) {
	const [scrollbarWidth, setScrollbarWidth] = useState(0);

	useEffect(() => {
		const el = scrollContainerRef.current;
		if (!el) return;
		const measure = () => {
			const w = el.offsetWidth - el.clientWidth;
			setScrollbarWidth((prev) => (prev !== w ? w : prev));
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [scrollContainerRef]);

	if (markers.length === 0 || totalCount <= 5) return null;

	/* Firefox overlay scrollbar (and some Linux/macOS configs) reports 0 width.
	   Fall back to a small gutter so markers are still visible at the right edge. */
	const gutter = scrollbarWidth || 2;

	return (
		<div
			style={{
				position: "absolute",
				top: 0,
				right: gutter,
				bottom: 0,
				width: 10,
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
						title={`#${i + 1}`}
						onClick={() => onJump(m.index)}
						style={{
							position: "absolute",
							top: `${pct}%`,
							right: 0,
							width: 10,
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
							e.currentTarget.style.width = "16px";
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.width = "10px";
						}}
					/>
				);
			})}
		</div>
	);
});
