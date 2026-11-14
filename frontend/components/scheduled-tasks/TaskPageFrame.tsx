import { useScheduledTask } from "@frontend/hooks/useScheduledTasks";
import { ApiError } from "@frontend/lib/api/client";
import type { ScheduledTask } from "@frontend/lib/api/scheduled-tasks";
import { Alert, Button, Container, Group, Loader, Stack, Text } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import { createContext, type ReactNode, useContext } from "react";
import { useTranslation } from "react-i18next";

const TaskContext = createContext<ScheduledTask | null>(null);
export function useTaskPage() {
	const task = useContext(TaskContext);
	if (!task) throw new Error("TaskPageFrame is required");
	return task;
}

export function TaskPageFrame({
	id,
	children,
	onBack,
}: {
	id: string;
	children: ReactNode;
	onBack: () => void;
}) {
	const { t } = useTranslation("scheduledTasks");
	const query = useScheduledTask(id);
	const missing = query.error instanceof ApiError && [403, 404].includes(query.error.status);
	return (
		<Container size="xl" py="lg">
			<Stack gap="lg">
				<Group>
					<Button
						variant="subtle"
						size="xs"
						leftSection={<IconArrowLeft size={16} />}
						onClick={onBack}
					>
						{t("backToList")}
					</Button>
				</Group>
				{query.isPending ? (
					<Group>
						<Loader size="sm" />
						<Text c="dimmed">{t("loading")}</Text>
					</Group>
				) : query.error || !query.data ? (
					<Alert color={missing ? "gray" : "red"} title={t(missing ? "notFound" : "loadFailed")}>
						<Stack gap="xs">
							{!missing && <Text size="sm">{query.error?.message}</Text>}
							<Button
								variant="light"
								size="xs"
								w="fit-content"
								onClick={() => void query.refetch()}
							>
								{t("retry")}
							</Button>
						</Stack>
					</Alert>
				) : (
					<TaskContext.Provider value={query.data}>{children}</TaskContext.Provider>
				)}
			</Stack>
		</Container>
	);
}
