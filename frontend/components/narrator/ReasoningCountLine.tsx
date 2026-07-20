import { Box, Group, Text, ThemeIcon } from "@mantine/core";
import { IconBrain, IconChevronRight } from "@tabler/icons-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";

/**
 * ReasoningCountLine — L2 / L1 rendering of a reasoning/thinking block: a
 * single line "🧠 reasoning ×N steps". Clicking expands to the full reasoning
 * view (handled by the caller's override).
 */
export const ReasoningCountLine = memo(function ReasoningCountLine({
	steps,
	onExpand,
}: {
	/** Number of reasoning steps / blocks. */
	steps: number;
	onExpand?: () => void;
}) {
	const { t } = useTranslation("narrator");
	return (
		<Group
			gap={6}
			wrap="nowrap"
			align="center"
			py={2}
			style={{ cursor: onExpand ? "pointer" : "default", userSelect: "none" }}
			onClick={onExpand}
		>
			<ThemeIcon size={16} variant="light" color="grape" radius="sm">
				<IconBrain size={10} />
			</ThemeIcon>
			<Text size="xs" c="dimmed" fw={500}>
				{t("reasoning")}
			</Text>
			<Text size="xs" c="dimmed" style={{ opacity: 0.5 }}>
				{t("reasoningCount", { count: steps })}
			</Text>
			<Box style={{ flex: 1 }} />
			{onExpand ? (
				<IconChevronRight size={12} style={{ color: "var(--mantine-color-dimmed)" }} />
			) : null}
		</Group>
	);
});
