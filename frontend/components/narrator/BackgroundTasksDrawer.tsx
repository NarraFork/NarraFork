import {
	ActionIcon,
	Alert,
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
import {
	IconExternalLink,
	IconInfoCircle,
	IconRobot,
	IconTerminal2,
	IconX,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNarratorSubagentsCapability } from "../../hooks/usePlatform";
import { api } from "../../lib/api";
import { ToolCallInspector } from "./ToolCallInspector";

const TASK_OUTPUT_PREVIEW_CHARS = 4_000;

function toTaskOutputPreview(output: string | null | undefined): string | null {
	if (!output) return null;
	if (output.length <= TASK_OUTPUT_PREVIEW_CHARS) return output;
	return `${output.slice(0, TASK_OUTPUT_PREVIEW_CHARS)}\n…`;
}

interface UnifiedTask {
	id: string;
	kind: "bash" | "agent";
	status: string;
	label: string;
	command: string | null;
	output: string | null;
	exitCode: number | null;
	toolUseId: string | null;
	subagentNarratorId: string | null;
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

/**
 * Shared background-tasks query. Keyed identically for the panel content and the
 * toolbar button so React Query dedupes them into a single request per narrator.
 */
function useBackgroundTasksQuery(narratorId: string, enabled: boolean, opened: boolean) {
	return useQuery({
		queryKey: ["background-tasks", narratorId],
		queryFn: async () => {
			const tasksData = await api.listBackgroundTasks(narratorId);
			return {
				...tasksData,
				tasks: tasksData.tasks.map((task) => ({
					...task,
					output: toTaskOutputPreview(task.output),
				})),
				legacySubagentTasks: tasksData.legacySubagentTasks.map((task) => ({
					...task,
					backgroundResult: toTaskOutputPreview(task.backgroundResult),
				})),
			};
		},
		enabled,
		refetchInterval: opened ? 3000 : 10000,
		gcTime: 30_000,
	});
}

/** Merge unified tasks + legacy subagent tasks into a single flat list. */
// biome-ignore lint/suspicious/noExplicitAny: query result shape is dynamic JSON
function toUnifiedTasks(data: any): UnifiedTask[] {
	const result: UnifiedTask[] = [];

	// New unified tasks
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON entity
	for (const task of (data?.tasks ?? []) as any[]) {
		result.push({
			id: task.id,
			kind: task.type,
			status: task.status,
			label: task.title || task.alias || task.command || task.subagentType || "Task",
			command: task.command,
			output: task.output,
			exitCode: task.exitCode,
			toolUseId: task.toolUseId,
			subagentNarratorId: task.subagentNarratorId,
		});
	}

	// Legacy subagent tasks (not already in the unified list)
	const unifiedIds = new Set(result.map((t) => t.id));
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON entity
	for (const task of (data?.legacySubagentTasks ?? []) as any[]) {
		if (unifiedIds.has(task.id)) continue;
		result.push({
			id: task.id,
			kind: "agent",
			status: task.backgroundStatus ?? task.status,
			label: task.title || task.subagentType || "Agent",
			command: null,
			output: task.backgroundResult,
			exitCode: null,
			toolUseId: null,
			subagentNarratorId: task.id,
		});
	}

	return result;
}

/**
 * Lightweight state for the toolbar button (support gate + running count).
 * Shares the same query as the panel so no extra request is issued.
 */
export function useBackgroundTasksButton(
	narratorId: string,
	enabled = true,
): {
	supported: boolean;
	runningCount: number;
} {
	const subagentsCapability = useNarratorSubagentsCapability();
	const supported = enabled && subagentsCapability.supported && subagentsCapability.background;
	const { data } = useBackgroundTasksQuery(narratorId, supported, false);
	const runningCount = useMemo(
		() => toUnifiedTasks(data).filter((t) => t.status === "running").length,
		[data],
	);
	return { supported, runningCount };
}

interface BackgroundTasksPanelProps {
	narratorId: string;
	/**
	 * When true (dock surface), suppress this panel's own chrome — the dock's
	 * ToolPanelShell provides the single header. Also renders the empty/loading
	 * states inline rather than hiding the whole panel.
	 */
	chromeless?: boolean;
	/** Called before navigating to a subagent session (Drawer uses this to close). */
	onOpenSubagent?: () => void;
}

/**
 * Pure background-tasks content panel. Rendered chromeless inside the dock (as a
 * dockview sibling of chat) and inside a Drawer on mobile.
 */
export function BackgroundTasksPanel({
	narratorId,
	chromeless = false,
	onOpenSubagent,
}: BackgroundTasksPanelProps) {
	const { t } = useTranslation("narrator");
	const [inspectedToolUseId, setInspectedToolUseId] = useState<string | null>(null);
	const qc = useQueryClient();
	const navigate = useNavigate();
	const subagentsCapability = useNarratorSubagentsCapability();
	const backgroundTasksSupported = subagentsCapability.supported && subagentsCapability.background;
	const canOpenSubagentSessions = subagentsCapability.supported && subagentsCapability.detachAttach;
	const showReattachFallback = canOpenSubagentSessions && !subagentsCapability.reattachBlocksParent;
	const reattachFallbackReason =
		subagentsCapability.reattachReason ?? t("backgroundTasks.reattachPartial");

	const { data, isLoading } = useBackgroundTasksQuery(narratorId, backgroundTasksSupported, true);

	const allTasks = useMemo(() => toUnifiedTasks(data), [data]);

	const handleOpenSubagent = useCallback(
		(subagentNarratorId: string) => {
			if (!canOpenSubagentSessions) return;
			onOpenSubagent?.();
			navigate({ to: "/narrators/$narratorId", params: { narratorId: subagentNarratorId } });
		},
		[canOpenSubagentSessions, navigate, onOpenSubagent],
	);

	const handleCancel = useCallback(
		async (taskId: string) => {
			if (!backgroundTasksSupported) return;
			try {
				await api.cancelBackgroundTask(narratorId, taskId);
				qc.invalidateQueries({ queryKey: ["background-tasks", narratorId] });
			} catch {
				// ignore
			}
		},
		[backgroundTasksSupported, narratorId, qc],
	);

	// When not supported there is nothing to show. In the dock this panel would
	// not normally be openable (the toolbar button is gated too), but guard anyway.
	if (!backgroundTasksSupported) {
		if (chromeless) {
			return (
				<Box p="md">
					<Text size="sm" c="dimmed" ta="center">
						{t("backgroundTasks.empty")}
					</Text>
				</Box>
			);
		}
		return null;
	}

	return (
		<>
			<Stack gap="sm" p={chromeless ? "md" : undefined}>
				{showReattachFallback && (
					<Alert color="yellow" variant="light">
						{reattachFallbackReason}
					</Alert>
				)}
				{allTasks.map((task) => {
					const isRunning = task.status === "running";
					const canOpenSubagent =
						canOpenSubagentSessions && task.kind === "agent" && !!task.subagentNarratorId;
					const canInspect = task.kind === "bash" && !!task.toolUseId;
					const Icon = task.kind === "bash" ? IconTerminal2 : IconRobot;
					return (
						<Box
							key={task.id}
							p="xs"
							onClick={() => {
								if (canOpenSubagent && task.subagentNarratorId) {
									handleOpenSubagent(task.subagentNarratorId);
								}
							}}
							style={{
								border: "1px solid var(--mantine-color-default-border)",
								borderRadius: "var(--mantine-radius-sm)",
								cursor: canOpenSubagent ? "pointer" : "default",
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
									{canInspect && (
										<Tooltip label={t("toolCallInspector.inspect")}>
											<ActionIcon
												size="xs"
												variant="subtle"
												color="gray"
												onClick={(event) => {
													event.stopPropagation();
													setInspectedToolUseId(task.toolUseId);
												}}
											>
												<IconInfoCircle size={12} />
											</ActionIcon>
										</Tooltip>
									)}
									{canOpenSubagent && task.subagentNarratorId && (
										<Tooltip label={t("backgroundTasks.openAgent")}>
											<ActionIcon
												size="xs"
												variant="subtle"
												color="indigo"
												onClick={(event) => {
													event.stopPropagation();
													handleOpenSubagent(task.subagentNarratorId as string);
												}}
											>
												<IconExternalLink size={12} />
											</ActionIcon>
										</Tooltip>
									)}
									<Badge size="xs" variant="light" color={statusColor(task.status)}>
										{statusLabel(task.status, t)}
									</Badge>
									{isRunning && (
										<ActionIcon
											size="xs"
											variant="subtle"
											color="red"
											onClick={(event) => {
												event.stopPropagation();
												handleCancel(task.id);
											}}
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
			<ToolCallInspector
				narratorId={narratorId}
				toolUseId={inspectedToolUseId}
				opened={!!inspectedToolUseId}
				onClose={() => setInspectedToolUseId(null)}
			/>
		</>
	);
}

interface BackgroundTasksDrawerProps {
	narratorId: string;
}

/**
 * Mobile / non-dock fallback: a self-managed right Drawer with a toolbar toggle.
 * On desktop the tasks panel is a dockview sibling instead (see the `tasks`
 * panel type + NarratorPanel's toolbar button).
 */
export function BackgroundTasksDrawer({ narratorId }: BackgroundTasksDrawerProps) {
	const { t } = useTranslation("narrator");
	const [opened, { open, close }] = useDisclosure(false);
	const { supported, runningCount } = useBackgroundTasksButton(narratorId);

	if (!supported) return null;

	return (
		<>
			<Tooltip label={t("backgroundTasks.title")}>
				<Indicator
					inline
					size={8}
					color="blue"
					processing
					disabled={runningCount === 0}
					offset={3}
					zIndex={1}
					style={{ height: "var(--ai-size-sm)", display: "flex", alignItems: "center" }}
				>
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
				<BackgroundTasksPanel narratorId={narratorId} onOpenSubagent={close} />
			</Drawer>
		</>
	);
}
