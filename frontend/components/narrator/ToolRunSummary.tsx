import { Group, Text, ThemeIcon } from "@mantine/core";
import { IconTool } from "@tabler/icons-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { ToolRunItem } from "./message-segments";

// ---------------------------------------------------------------------------
// ToolRunCountLine — L1/L2: a single bare line "🔧 Tool calls · N".
//
// Reached only by a tool-run that did NOT go through the activity fold (a run
// whose calls all kept their own cards, e.g. a permission-blocked or pinned one,
// leaves nothing here). The fold turns L1/L2 tool calls into NAMED rows instead,
// because a count line has no rows and must never be the only place a call is
// addressable.
// ---------------------------------------------------------------------------
export const ToolRunCountLine = memo(function ToolRunCountLine({
	items,
}: {
	items: ToolRunItem[];
}) {
	const { t } = useTranslation("narrator");
	return (
		<Group gap={6} wrap="nowrap" align="center" py={2} style={{ userSelect: "none" }}>
			<ThemeIcon size={16} variant="light" color="gray" radius="sm">
				<IconTool size={10} />
			</ThemeIcon>
			<Text size="xs" c="dimmed" fw={500}>
				{t("toolCalls")}
			</Text>
			<Text size="xs" c="dimmed" style={{ opacity: 0.5 }}>
				{t("toolCallsCount", { count: items.length })}
			</Text>
		</Group>
	);
});
