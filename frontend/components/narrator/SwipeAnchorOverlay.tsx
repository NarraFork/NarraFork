import { Box, Text } from "@mantine/core";
import { memo } from "react";
import type { SwipeAnchorInfo } from "./swipeState";

/** Max height (px) for the pinned message preview. */
const MAX_PREVIEW_HEIGHT = 72;

/**
 * When a swiped message scrolls off-screen, this overlay renders a compact
 * text preview pinned to the top or bottom edge of the scroll area. Clicking
 * it scrolls back to the original message.
 *
 * Intentionally avoids cloning the original message DOM: large messages and
 * code blocks can contain huge subtrees, and cloning them would duplicate that
 * memory even though only a small clipped strip is visible.
 */
export const SwipeAnchorOverlay = memo(function SwipeAnchorOverlay({
	info,
}: {
	info: SwipeAnchorInfo;
}) {
	const isTop = info.offScreen === "top";

	return (
		<Box
			style={{
				position: "absolute",
				left: 0,
				right: 0,
				...(isTop ? { top: 0 } : { bottom: 0 }),
				zIndex: 10,
				maxHeight: MAX_PREVIEW_HEIGHT,
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
				px="md"
				py={6}
				style={{
					minHeight: MAX_PREVIEW_HEIGHT,
					display: "flex",
					alignItems: isTop ? "flex-start" : "flex-end",
					background: "var(--mantine-color-body)",
					borderTop: isTop ? undefined : "1px solid var(--mantine-color-default-border)",
					borderBottom: isTop ? "1px solid var(--mantine-color-default-border)" : undefined,
				}}
			>
				<Text size="xs" c="dimmed" lineClamp={2} style={{ width: "100%" }}>
					{info.previewText}
				</Text>
			</Box>
		</Box>
	);
});
