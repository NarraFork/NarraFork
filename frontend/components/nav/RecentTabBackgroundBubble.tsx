import { getEffectiveNarratorDisplay, statusRegistry } from "@frontend/lib/status-registry";
import { Box } from "@mantine/core";
import { IconMessageCircle, IconMessageCircleFilled } from "@tabler/icons-react";
/**
 * Diagonally half-filled narrator bubble: FOREGROUND idle + background tasks running.
 *
 * The foreground is hollow when read, or filled green when unread. The upper-left
 * triangle uses working blue, because that half means work is still in
 * flight, just not in the foreground. Two stacked Tabler icons with a CSS clip-path:
 * Tabler ships no diagonal half glyph, and a rotated `IconCircleHalf2` would lose the
 * message-bubble shape this surface's whole state language is built on.
 */
export function RecentTabBackgroundBubble({
	size,
	color,
	foregroundFilled,
}: {
	size: number;
	color?: string;
	foregroundFilled: boolean;
}) {
	const fillColor = statusRegistry.accentVar(getEffectiveNarratorDisplay("working"), 6);
	return (
		<Box component="span" pos="relative" style={{ display: "inline-flex", lineHeight: 0 }}>
			{foregroundFilled ? (
				<IconMessageCircleFilled size={size} color={color} />
			) : (
				<IconMessageCircle size={size} color={color} />
			)}
			<Box
				component="span"
				data-tab-background-active="true"
				style={{
					position: "absolute",
					inset: 0,
					clipPath: "polygon(0 0, 100% 0, 0 100%)",
					pointerEvents: "none",
				}}
			>
				<IconMessageCircleFilled size={size} color={fillColor} />
			</Box>
		</Box>
	);
}
