import { useScheduledTask } from "@frontend/hooks/useScheduledTasks";
import type { ScheduledTask } from "@frontend/lib/api/scheduled-tasks";
import { Alert, Anchor, Stack, Text } from "@mantine/core";
import { IconCalendarClock } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function ManagedTaskBanner({ taskId, model }: { taskId: string; model?: string | null }) {
	const task = useScheduledTask(taskId);
	const [initialModel] = useState(model);
	// Refetch failures may leave old query data. Never show a stale private name after access is lost.
	return (
		<ManagedTaskNotice
			task={task.isSuccess ? task.data : undefined}
			modelChanged={initialModel !== model}
		/>
	);
}

export function ManagedTaskNotice({
	task,
	modelChanged = false,
}: {
	task?: ScheduledTask;
	modelChanged?: boolean;
}) {
	const { t } = useTranslation("scheduledTasks");
	return (
		<Alert
			color="blue"
			radius={0}
			py="xs"
			icon={<IconCalendarClock size={16} />}
			style={{ flexShrink: 0 }}
		>
			<Stack gap={3}>
				<Text size="sm">
					{task ? (
						<>
							{t("managedBy")}{" "}
							<Anchor
								component={Link}
								to="/scheduled-tasks/$taskId"
								params={{ taskId: task.id }}
								size="sm"
							>
								{task.name}
							</Anchor>
						</>
					) : (
						t("managedGeneric")
					)}
				</Text>
				<Text size="xs" c="dimmed">
					{t("managedConfig")}
				</Text>
				{task?.modelPolicy === "sync" && modelChanged && (
					<Text size="xs" role="status">
						{t("managedModelReset")}
					</Text>
				)}
			</Stack>
		</Alert>
	);
}
