import { Box, Stack, Text } from "@mantine/core";
import { IconUpload } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

/**
 * Full-panel highlight shown while a file is dragged over the narrator panel.
 * Absolutely positioned and click-through (`pointerEvents: none`) so it never
 * intercepts the drop itself, which the panel root handles.
 */
export function DropOverlay({ visible }: { visible: boolean }) {
	const { t } = useTranslation("narrator");
	if (!visible) return null;
	return (
		<Box
			style={{
				position: "absolute",
				inset: 0,
				zIndex: 100,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				backgroundColor: "rgba(0, 0, 0, 0.5)",
				border: "2px dashed var(--mantine-color-indigo-5)",
				borderRadius: "var(--mantine-radius-md)",
				pointerEvents: "none",
			}}
		>
			<Stack align="center" gap="xs">
				<IconUpload size={40} color="var(--mantine-color-indigo-4)" />
				<Text size="lg" fw={500} c="white">
					{t("dropFilesHere")}
				</Text>
			</Stack>
		</Box>
	);
}
