import { TaskForm } from "@frontend/components/scheduled-tasks/TaskForm";
import { useTaskPage } from "@frontend/components/scheduled-tasks/TaskPageFrame";
import { parseScheduledTaskSearch } from "@frontend/lib/scheduled-task-search";
import { Alert, Button, Stack, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/scheduled-tasks/$taskId/edit")({
	component: EditScheduledTaskPage,
});

function EditScheduledTaskPage() {
	const { t } = useTranslation("scheduledTasks");
	const task = useTaskPage();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const back = () =>
		void navigate({
			to: "/scheduled-tasks/$taskId",
			params: { taskId: task.id },
			search: parseScheduledTaskSearch(search),
		});
	if (!task.capabilities.canEdit || !task.capabilities.canSeePrompt || task.prompt === undefined)
		return (
			<Alert color="yellow">
				<Stack>
					<Title order={4}>{t("readOnly")}</Title>
					<Button variant="light" w="fit-content" onClick={back}>
						{t("backToDetails")}
					</Button>
				</Stack>
			</Alert>
		);
	return (
		<Stack gap="lg">
			<Title order={2}>
				{t("editTask")}: {task.name}
			</Title>
			<TaskForm key={task.id} task={task} onCancel={back} onSaved={back} />
		</Stack>
	);
}
