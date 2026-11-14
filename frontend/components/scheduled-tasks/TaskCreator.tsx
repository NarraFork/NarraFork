import type { ScheduledTask } from "@frontend/lib/api/scheduled-tasks";
import { Avatar, Badge, Group, Indicator, Stack, Text } from "@mantine/core";
import { IconRobot, IconUser } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

export function TaskCreator({
	task,
	detailed = false,
}: {
	task: ScheduledTask;
	detailed?: boolean;
}) {
	const { t } = useTranslation("scheduledTasks");
	const creator = task.creator;
	const name =
		creator.kind === "narrator"
			? creator.narratorTitle || t("unknownNarrator")
			: creator.username || t("deletedUser");
	return (
		<Group gap="xs" wrap="nowrap">
			<Indicator
				disabled={creator.kind !== "narrator"}
				inline
				size={15}
				label={<IconRobot size={11} />}
				offset={2}
			>
				<Avatar size="sm" radius="xl" color={creator.kind === "narrator" ? "indigo" : "gray"}>
					{creator.kind === "narrator" ? <IconRobot size={16} /> : <IconUser size={16} />}
				</Avatar>
			</Indicator>
			<Stack gap={0} style={{ minWidth: 0 }}>
				<Group gap={6}>
					<Text size="sm" truncate>
						{name}
					</Text>
					{creator.deleted && (
						<Badge size="xs" color="gray">
							{t("deletedSource")}
						</Badge>
					)}
				</Group>
				{detailed && creator.kind === "narrator" && (
					<Text size="xs" c="dimmed">
						{t("creatorResponsible", { username: creator.username || t("deletedUser") })}
					</Text>
				)}
			</Stack>
		</Group>
	);
}
