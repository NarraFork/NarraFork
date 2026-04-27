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
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

interface BackgroundTasksDrawerProps {
	narratorId: string;
}

interface UnifiedTask {
	id: string;
	kind: "bash" | "agent";
	status: string;
	label: string;
	command: string | null;
	output: string | null;
	exitCode: number | null;
}

function statusColor(status: string): string {
	switch (status) {
		case "running":
			return "blue";
		case "completed":
			return "green";
		case "cancelled":
			return "orange";
		default:
			return "red";
	}
}

function statusLabel(status: string, t: (key: string) => string): string {
	switch (status) {
		case "running":
			return t("backgroundTasks.statusRunning");
		case "completed":
			return t("backgroundTasks.statusCompleted");
		case "cancelled":
			return t("backgroundTasks.statusCancelled");
		case "failed":
			return t("backgroundTasks.statusFailed");
		default:
			return status;
	}
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

	// Merge unified tasks and legacy subagent tasks into a single list
	const allTasks: UnifiedTask[] = useMemo(() => {
		const result: UnifiedTask[] = [];

		// New unified tasks
		for (const task of data?.tasks ?? []) {
			result.push({
				id: task.id,
				kind: task.type,
				status: task.status,
				label: task.title || task.alias || task.command || task.subagentType || "Task",
				command: task.command,
				output: task.output,
				exitCode: task.exitCode,
			});
		}

		// Legacy subagent tasks (not already in unified list)
		const unifiedIds = new Set(result.map((t) => t.id));
		for (const task of data?.legacySubagentTasks ?? []) {
			if (unifiedIds.has(task.id)) continue;
			result.push({
				id: task.id,
				kind: "agent",
				status: task.backgroundStatus ?? task.status,
				label: task.title || task.subagentType || "Agent",
				command: null,
				output: task.backgroundResult,
				exitCode: null,
			});
		}

		return result;
	}, [data]);

	const runningCount = allTasks.filter((t) => t.status === "running").length;

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

	if (allTasks.length === 0 && !isLoading) return null;

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
					{allTasks.map((task) => {
						const isRunning = task.status === "running";
						const Icon = task.kind === "bash" ? IconTerminal2 : IconRobot;
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
										<Icon size={14} />
										{task.kind === "bash" && task.command ? (
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
										) : (
											<Text size="xs" fw={500} truncate>
												{task.label}
											</Text>
										)}
									</Group>
									<Group gap={4} wrap="nowrap">
										<Badge size="xs" variant="light" color={statusColor(task.status)}>
											{statusLabel(task.status, t)}
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
								{!isRunning && task.output && (
									<Text size="xs" c="dimmed" mt={4} lineClamp={2}>
										{task.output.slice(0, 200)}
									</Text>
								)}
								{!isRunning && task.exitCode != null && (
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

					{!isLoading && allTasks.length === 0 && (
						<Text size="sm" c="dimmed" ta="center" py="md">
							{t("backgroundTasks.empty")}
						</Text>
					)}
				</Stack>
			</Drawer>
		</>
	);
}
