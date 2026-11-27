import { useScheduledTaskAssociations } from "@frontend/hooks/useScheduledTasks";
import type { ScheduledTaskAssociation } from "@frontend/lib/api/scheduled-tasks";
import { Alert, Anchor, Badge, Button, Group, Stack, Text } from "@mantine/core";
import { IconCalendarClock } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function ManagedTaskBanner({
	narratorId,
	model,
}: {
	narratorId: string;
	model?: string | null;
}) {
	const query = useScheduledTaskAssociations(narratorId);
	const [initialModel] = useState(model);
	const { t } = useTranslation("scheduledTasks");
	// An error may carry stale query data. It must not reveal private names, links or counts.
	if (query.isError)
		return (
			<Alert color="orange" radius={0} py="xs" style={{ flexShrink: 0 }}>
				<Group justify="space-between" gap="xs">
					<Text size="xs">{t("associationsLoadFailed")}</Text>
					<Button size="compact-xs" variant="subtle" onClick={() => void query.refetch()}>
						{t("retry")}
					</Button>
				</Group>
			</Alert>
		);
	if (!query.isSuccess) return null;
	const unique = new Map(
		query.data.pages.flatMap((page) => page.tasks).map((task) => [task.id, task]),
	);
	const tasks = [...unique.values()].filter(
		(task) => task.lifecycle !== "ended" || task.hasUnfinishedRun,
	);
	if (tasks.length === 0) return null;
	return (
		<Alert
			color="blue"
			radius={0}
			py="xs"
			icon={<IconCalendarClock size={16} />}
			style={{ flexShrink: 0, maxHeight: 180, overflowY: "auto" }}
		>
			<Stack gap="xs">
				{tasks.map((task) => (
					<ManagedTaskNotice key={task.id} task={task} modelChanged={initialModel !== model} />
				))}
				{query.hasNextPage && (
					<Button
						size="compact-xs"
						variant="subtle"
						loading={query.isFetchingNextPage}
						onClick={() => void query.fetchNextPage()}
					>
						{t("loadMore")}
					</Button>
				)}
			</Stack>
		</Alert>
	);
}

export function ManagedTaskNotice({
	task,
	modelChanged = false,
}: {
	task: ScheduledTaskAssociation;
	modelChanged?: boolean;
}) {
	const { t } = useTranslation("scheduledTasks");
	const executing = task.hasUnfinishedRun && task.lastStatus !== "waiting";
	return (
		<Stack gap={3}>
			<Group gap="xs">
				<Anchor
					renderRoot={(props) => (
						<Link {...props} to="/scheduled-tasks/$taskId" params={{ taskId: task.id }} />
					)}
					size="sm"
				>
					{task.name}
				</Anchor>
				<Badge size="xs" color="gray" variant="outline">
					{t(`lifecycle.${task.lifecycle}`)}
				</Badge>
				<Text size="xs">
					{task.total === null
						? t("associationOpen", { count: task.firedCount })
						: `${task.firedCount}/${task.total}`}
				</Text>
				{task.hasUnfinishedRun && (
					<Badge size="xs" variant="light">
						{t(executing ? "associationRunning" : "verdict.waiting")}
					</Badge>
				)}
			</Group>
			{task.modelPolicy === "sync" && modelChanged && (
				<Text size="xs" role="status">
					{t("managedModelReset")}
				</Text>
			)}
		</Stack>
	);
}
