import {
	ActionIcon,
	Badge,
	Box,
	Code,
	Drawer,
	Group,
	Indicator,
	Loader,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconRobot, IconTerminal2, IconX } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

interface BackgroundTasksDrawerProps {
	narratorId: string;
}

export function BackgroundTasksDrawer({ narratorId }: BackgroundTasksDrawerProps) {
	const { t } = useTranslation("narrator");
	const [opened, { open, close }] = useDisclosure(false);
	const qc = useQueryClient();

	const { data, isLoading } = useQuery({
		queryKey: ["background-tasks", narratorId],
		queryFn: () => api.listBackgroundTasks(narratorId),
		refetchInterval: opened ? 3000 : 10000,
	});

	const runningCount =
		(data?.subagentTasks?.filter((t) => t.backgroundStatus === "running").length ?? 0) +
		(data?.bashTasks?.filter((t) => t.status === "running").length ?? 0);

	const handleCancel = useCallback(
		async (taskId: string) => {
			try {
				await api.cancelBackgroundTask(narratorId, taskId);
				qc.invalidateQueries({ queryKey: ["background-tasks", narratorId] });
			} catch {
				// ignore
			}
		},
		[narratorId, qc],
	);

	const hasAnyTasks = (data?.subagentTasks?.length ?? 0) > 0 || (data?.bashTasks?.length ?? 0) > 0;

	if (!hasAnyTasks && !isLoading) return null;

	return (
		<>
			<Tooltip label={t("backgroundTasks.title")}>
				<Indicator size={8} color="blue" processing disabled={runningCount === 0} offset={3}>
					<ActionIcon
						size="sm"
						variant={opened ? "light" : "subtle"}
						color={opened ? "indigo" : "gray"}
						onClick={open}
					>
						<IconRobot size={16} />
					</ActionIcon>
				</Indicator>
			</Tooltip>

			<Drawer
				opened={opened}
				onClose={close}
				title={
					<Group gap="xs">
						<Text fw={600} size="sm">
							{t("backgroundTasks.title")}
						</Text>
						{runningCount > 0 && (
							<Badge size="xs" variant="filled" color="blue">
								{runningCount}
							</Badge>
						)}
					</Group>
				}
				position="right"
				size="sm"
				padding="md"
			>
				<Stack gap="sm">
					{/* Subagent background tasks */}
					{data?.subagentTasks?.map((task) => {
						const isRunning = task.backgroundStatus === "running";
						const statusColor = isRunning
							? "blue"
							: task.backgroundStatus === "completed"
								? "green"
								: task.backgroundStatus === "cancelled"
									? "orange"
									: "red";
						return (
							<Box
								key={task.id}
								p="xs"
								style={{
									border: "1px solid var(--mantine-color-default-border)",
									borderRadius: "var(--mantine-radius-sm)",
								}}
							>
								<Group justify="space-between" wrap="nowrap" gap="xs">
									<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
										<IconRobot size={14} />
										<Text size="xs" fw={500} truncate>
											{task.title || task.subagentType || "Agent"}
										</Text>
									</Group>
									<Group gap={4} wrap="nowrap">
										<Badge size="xs" variant="light" color={statusColor}>
											{task.backgroundStatus ?? task.status}
										</Badge>
										{isRunning && (
											<ActionIcon
												size="xs"
												variant="subtle"
												color="red"
												onClick={() => handleCancel(task.id)}
												title={t("backgroundTasks.cancel")}
											>
												<IconX size={12} />
											</ActionIcon>
										)}
									</Group>
								</Group>
								{task.backgroundResult && !isRunning && (
									<Text size="xs" c="dimmed" mt={4} lineClamp={2}>
										{task.backgroundResult.slice(0, 200)}
									</Text>
								)}
							</Box>
						);
					})}

					{/* Bash background tasks */}
					{data?.bashTasks?.map((task) => {
						const isRunning = task.status === "running";
						const statusColor = isRunning
							? "blue"
							: task.status === "completed"
								? "green"
								: task.status === "cancelled"
									? "orange"
									: "red";
						return (
							<Box
								key={task.id}
								p="xs"
								style={{
									border: "1px solid var(--mantine-color-default-border)",
									borderRadius: "var(--mantine-radius-sm)",
								}}
							>
								<Group justify="space-between" wrap="nowrap" gap="xs">
									<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
										<IconTerminal2 size={14} />
										<Code
											style={{
												fontSize: 11,
												maxWidth: 180,
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap",
												display: "inline-block",
											}}
										>
											{task.command}
										</Code>
									</Group>
									<Group gap={4} wrap="nowrap">
										<Badge size="xs" variant="light" color={statusColor}>
											{task.status}
										</Badge>
										{isRunning && (
											<ActionIcon
												size="xs"
												variant="subtle"
												color="red"
												onClick={() => handleCancel(task.id)}
												title={t("backgroundTasks.cancel")}
											>
												<IconX size={12} />
											</ActionIcon>
										)}
									</Group>
								</Group>
								{task.exitCode != null && (
									<Text size="xs" c="dimmed" mt={4}>
										exit {task.exitCode}
									</Text>
								)}
							</Box>
						);
					})}

					{isLoading && (
						<Group justify="center" py="md">
							<Loader size="sm" />
						</Group>
					)}

					{!isLoading && !hasAnyTasks && (
						<Text size="sm" c="dimmed" ta="center" py="md">
							{t("backgroundTasks.empty")}
						</Text>
					)}
				</Stack>
			</Drawer>
		</>
	);
}
