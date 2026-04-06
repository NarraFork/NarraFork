import { Box } from "@mantine/core";
import { memo, useEffect, useRef } from "react";
import type { SwipeAnchorInfo } from "./swipeState";

/** Max height (px) for the cloned message preview. */
const MAX_CLONE_HEIGHT = 72;

/**
 * When a swiped message scrolls off-screen, this overlay renders a cloned
 * preview of the original DOM element pinned to the top or bottom edge of
 * the scroll area. Clicking it scrolls back to the original message.
 *
 * The clone is a shallow `cloneNode(true)` with interactivity stripped
 * (pointer-events: none on children) so it acts as a pure visual preview.
 */
export const SwipeAnchorOverlay = memo(function SwipeAnchorOverlay({
	info,
}: {
	info: SwipeAnchorInfo;
}) {
	const containerRef = useRef<HTMLDivElement>(null);

	// Clone the source element into the overlay container.
	// Re-run whenever the source element or direction changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-clone when offScreen direction changes
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		// Clear previous clone
		container.innerHTML = "";

		const src = info.element;
		if (!src.isConnected) return;

		const clone = src.cloneNode(true) as HTMLElement;
		// Strip interactivity from the clone
		clone.style.pointerEvents = "none";
		// Reset any transform the swipe may have applied (translateX offset)
		clone.style.transform = "none";
		clone.style.transition = "none";
		// Ensure it fills the container width
		clone.style.width = "100%";
		clone.style.maxWidth = "100%";
		clone.style.margin = "0";

		container.appendChild(clone);
	}, [info.element, info.offScreen]);

	const isTop = info.offScreen === "top";

	return (
		<Box
			style={{
				position: "absolute",
				left: 0,
				right: 0,
				...(isTop ? { top: 0 } : { bottom: 0 }),
				zIndex: 10,
				maxHeight: MAX_CLONE_HEIGHT,
				overflow: "hidden",
				cursor: "pointer",
				// Fade-out gradient at the clipped edge
				maskImage: isTop
					? "linear-gradient(to bottom, black 40%, transparent 100%)"
					: "linear-gradient(to top, black 40%, transparent 100%)",
				WebkitMaskImage: isTop
					? "linear-gradient(to bottom, black 40%, transparent 100%)"
					: "linear-gradient(to top, black 40%, transparent 100%)",
			}}
			onClick={() => info.scrollBack()}
		>
			<Box
				ref={containerRef}
				style={{
					padding: "0 var(--mantine-spacing-md)",
					// For bottom overlay, align the clone to the bottom so the
					// visible portion is the tail of the message, not the head.
					...(isTop
						? {}
						: {
								display: "flex",
								flexDirection: "column",
								justifyContent: "flex-end",
								minHeight: MAX_CLONE_HEIGHT,
							}),
				}}
			/>
		</Box>
	);
});
