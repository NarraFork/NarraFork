import { Box, Text, Tooltip } from "@mantine/core";

/**
 * Truncated file path display — shows the tail (filename) when space is limited,
 * with a tooltip for the full path.
 *
 * Uses `direction: rtl` + `<bdo dir="ltr">` trick so that CSS `text-overflow: ellipsis`
 * clips from the left (directory prefix) instead of the right (filename).
 */
export function TruncatedPath({ path, fw }: { path: string; fw?: number }) {
	return (
		<Tooltip label={path} openDelay={400} multiline maw={500}>
			<Box style={{ overflow: "hidden", minWidth: 0, flex: 1 }}>
				<Text
					size="xs"
					ff="monospace"
					fw={fw}
					style={{
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap",
						direction: "rtl",
						textAlign: "left",
					}}
				>
					<bdo dir="ltr">{path}</bdo>
				</Text>
			</Box>
		</Tooltip>
	);
}
