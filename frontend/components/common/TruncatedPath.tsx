import { Box, Text, type TextProps, Tooltip } from "@mantine/core";
import type { CSSProperties, ReactNode } from "react";

/**
 * One-line path (or cwd) text that ellipsizes from the LEFT so the tail stays visible.
 *
 * ── WHY `<bdo dir="ltr">` IS LOAD-BEARING ─────────────────────────────────────
 * The outer `direction: rtl` is only for WHERE the ellipsis lands. Without an LTR
 * isolation wrapper, Unicode Bidi treats a leading `/` as a neutral and reorders it
 * to the other end of the visual line — the path "loses" its root slash. The `bdo`
 * pins character order to LTR while the container still clips from the left.
 * See also `RenderToolRun`'s LiveTailText notes on why `unicode-bidi: plaintext`
 * is the opposite fix and must not be used here.
 */
export function LeftTruncatedPathText({
	path,
	children,
	style,
	...textProps
}: {
	/** Path to display. Ignored when `children` is provided. */
	path?: string;
	/** Override the displayed node (defaults to `path`). */
	children?: ReactNode;
	style?: CSSProperties;
} & Omit<TextProps, "children" | "truncate" | "style">) {
	return (
		<Text
			{...textProps}
			truncate
			style={{
				direction: "rtl",
				textAlign: "left",
				...style,
			}}
		>
			<bdo dir="ltr">{children ?? path}</bdo>
		</Text>
	);
}

/**
 * Truncated file path display — shows the tail (filename) when space is limited,
 * with a tooltip for the full path.
 *
 * Uses `LeftTruncatedPathText` so CSS `text-overflow: ellipsis` clips from the left
 * (directory prefix) instead of the right (filename), without reordering the path.
 */
export function TruncatedPath({ path, fw }: { path: string; fw?: number }) {
	return (
		<Tooltip label={path} openDelay={400} multiline maw={500}>
			<Box style={{ overflow: "hidden", minWidth: 0, flex: 1 }}>
				<LeftTruncatedPathText path={path} size="xs" ff="monospace" fw={fw} />
			</Box>
		</Tooltip>
	);
}
