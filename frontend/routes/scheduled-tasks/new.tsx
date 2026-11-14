import { TaskForm } from "@frontend/components/scheduled-tasks/TaskForm";
import { TaskPageFrame, useTaskPage } from "@frontend/components/scheduled-tasks/TaskPageFrame";
import {
	parseScheduledTaskNewSearch,
	parseScheduledTaskSearch,
} from "@frontend/lib/scheduled-task-search";
import { Alert, Button, Container, Stack, Title } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/scheduled-tasks/new")({
	validateSearch: parseScheduledTaskNewSearch,
	component: NewScheduledTaskPage,
});

function NewScheduledTaskPage() {
	const { t } = useTranslation("scheduledTasks");
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const back = () =>
		void navigate({ to: "/scheduled-tasks", search: parseScheduledTaskSearch(search) });
	if (search.copyFrom)
		return (
			<TaskPageFrame id={search.copyFrom} onBack={back}>
				<CopyTaskForm />
			</TaskPageFrame>
		);
	return (
		<Container size="xl" py="lg">
			<Stack gap="lg">
				<Button
					variant="subtle"
					w="fit-content"
					size="xs"
					leftSection={<IconArrowLeft size={16} />}
					onClick={back}
				>
					{t("backToList")}
				</Button>
				<Title order={2}>{t("createTask")}</Title>
				<TaskForm
					onCancel={back}
					onSaved={(task) =>
						void navigate({
							to: "/scheduled-tasks/$taskId",
							params: { taskId: task.id },
							search: parseScheduledTaskSearch(search),
						})
					}
				/>
			</Stack>
		</Container>
	);
}

function CopyTaskForm() {
	const { t } = useTranslation("scheduledTasks");
	const task = useTaskPage();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	if (!task.capabilities.canSeePrompt || task.prompt === undefined)
		return <Alert color="yellow">{t("copyNotAllowed")}</Alert>;
	return (
		<Stack>
			<Title order={2}>{t("copyTask")}</Title>
			<TaskForm
				key={task.id}
				task={task}
				copy
				onCancel={() =>
					void navigate({ to: "/scheduled-tasks", search: parseScheduledTaskSearch(search) })
				}
				onSaved={(created) =>
					void navigate({
						to: "/scheduled-tasks/$taskId",
						params: { taskId: created.id },
						search: parseScheduledTaskSearch(search),
					})
				}
			/>
		</Stack>
	);
}
