import {
	ActionIcon,
	Alert,
	Badge,
	Box,
	Button,
	Code,
	Collapse,
	Drawer,
	Group,
	Indicator,
	Loader,
	Progress,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import type { BackgroundTaskListItem, BackgroundTaskType } from "@shared/background-task-list";
import { isBackgroundTaskActiveStatus } from "@shared/background-task-list";
import { toolBodyId } from "@shared/pretext-layout/tool-detail";
import {
	deriveToolProgress,
	formatProgressBytes,
	formatProgressDuration,
	type ToolProgressPayload,
} from "@shared/tool-progress";
import {
	IconChevronDown,
	IconChevronRight,
	IconExternalLink,
	IconInfoCircle,
	IconRobot,
	IconTerminal2,
	IconTransfer,
	IconX,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNarratorSubagentsCapability } from "../../hooks/usePlatform";
import { api } from "../../lib/api";
import {
	SAFE_AREA_DEFAULT_DRAWER_HEADER_STYLE,
	SAFE_AREA_PADDED_DRAWER_BODY_STYLE,
} from "../../lib/safe-area";
import { ContentViewer } from "./ContentViewer";
import { useNarratorDockContext } from "./dock/NarratorDockContext";
import { ToolCallInspector } from "./tool-call/ToolCallInspector";
import { useBackgroundTaskList } from "./useBackgroundTaskList";

/** Poll interval for the live output tail of a running task. */
const TAIL_POLL_INTERVAL_MS = 1_500;

/**
 * One row as this panel renders it.
 *
 * The unified/legacy normalization that used to happen here (`toUnifiedTasks`)
 * now happens server-side, so this is a thin projection of the wire shape rather
 * than a merge of two different ones.
 */
interface UnifiedTask {
	id: string;
	kind: BackgroundTaskType;
	status: string;
	label: string;
	command: string | null;
	output: string | null;
	exitCode: number | null;
	toolUseId: string | null;
	subagentNarratorId: string | null;
	activeChildTaskCount: number;
	canCancelActiveWork: boolean;
	/** `transfer` rows only: live byte progress, rendered as a real bar. */
	progress?: ToolProgressPayload;
}

export function isBackgroundTaskActive(status: string): boolean {
	return isBackgroundTaskActiveStatus(status);
}

function toUnifiedTask(task: BackgroundTaskListItem): UnifiedTask {
	return {
		id: task.id,
		kind: task.type,
		status: task.effectiveStatus || task.status,
		label: task.title || task.alias || task.command || task.subagentType || "Task",
		command: task.command,
		output: task.output,
		exitCode: task.exitCode,
		toolUseId: task.toolUseId,
		subagentNarratorId: task.subagentNarratorId,
		activeChildTaskCount: task.activeChildTaskCount,
		canCancelActiveWork: task.canCancelActiveWork,
		...(task.progress ? { progress: task.progress } : {}),
	};
}

/**
 * The live progress bar for a background transfer row.
 *
 * A real `Progress` element rather than text: it animates while work continues,
 * and an indeterminate transfer (no known total — an upload's sender knows only
 * what it has sent) must be visibly moving instead of frozen at 0%.
 */
function TransferProgressBar({ progress }: { progress: ToolProgressPayload }) {
	const { ratio, percent, ratePerSecond, etaSeconds } = deriveToolProgress(progress);
	const indeterminate = ratio === null;
	const figures = [
		progress.total != null
			? `${formatProgressBytes(progress.completed)} / ${formatProgressBytes(progress.total)}`
			: formatProgressBytes(progress.completed),
		...(ratePerSecond !== null ? [`${formatProgressBytes(ratePerSecond)}/s`] : []),
		...(etaSeconds !== null ? [`ETA ${formatProgressDuration(etaSeconds)}`] : []),
		...(progress.itemsTotal != null && progress.itemsTotal > 1
			? [`${Math.min((progress.itemsDone ?? 0) + 1, progress.itemsTotal)}/${progress.itemsTotal}`]
			: []),
	];
	return (
		<Stack gap={2} mt={4}>
			<Group gap={6} wrap="nowrap" align="center">
				<Progress
					value={indeterminate ? 100 : Math.min(100, Math.max(0, ratio * 100))}
					color="blue"
					size="sm"
					radius="xl"
					striped
					animated
					style={{ flex: 1, minWidth: 0 }}
				/>
				<Text size="xs" c="dimmed" ff="monospace" style={{ flexShrink: 0 }}>
					{percent != null ? `${percent}%` : "—"}
				</Text>
			</Group>
			<Text size="xs" c="dimmed" ff="monospace" truncate>
				{figures.join("  ·  ")}
			</Text>
		</Stack>
	);
}

function statusColor(status: string): string {
	switch (status) {
		case "running":
		case "continued":
			return "blue";
		case "child_running":
			return "violet";
		case "completed":
			return "green";
		// Yellow, not the failure red: a paused transfer is intact and resumable, and
		// colouring it like an error would push users to discard recoverable work.
		case "paused":
		case "taken_over":
			return "yellow";
		case "cancelled":
			return "orange";
		default:
			return "red";
	}
}

function statusLabel(
	status: string,
	activeChildTaskCount: number,
	t: (key: string, options?: { count?: number }) => string,
): string {
	switch (status) {
		case "running":
			return t("backgroundTasks.statusRunning");
		case "continued":
			return t("backgroundTasks.statusContinued");
		case "child_running":
			return t("backgroundTasks.statusChildRunning", { count: activeChildTaskCount });
		case "completed":
			return t("backgroundTasks.statusCompleted");
		case "paused":
			return t("backgroundTasks.statusPaused");
		case "taken_over":
			return t("subagentTakenOver");
		case "cancelled":
			return t("backgroundTasks.statusCancelled");
		case "failed":
			return t("backgroundTasks.statusFailed");
		case "timeout":
			return t("backgroundTasks.statusTimeout");
		default:
			return status;
	}
}

/**
 * Lightweight state for the toolbar button (support gate + running count).
 *
 * Reads the server-computed `activeCount` rather than counting loaded rows: the
 * badge must be right even when the panel has only loaded the first page, and
 * loading every page just to count them is what made this surface expensive.
 * Shares the panel's query key, so mounting the badge costs no extra request.
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
	const { activeCount } = useBackgroundTaskList(narratorId, supported);
	return { supported, runningCount: activeCount };
}

/**
 * Live output tail for one bash task. Only fetched while the row is expanded, so
 * a collapsed list never polls per-task output. Running tasks are served from the
 * server's in-memory buffer; terminal tasks read a bounded stored tail once.
 */
function useTaskOutputTail(
	narratorId: string,
	taskId: string,
	enabled: boolean,
	isActive: boolean,
) {
	return useQuery({
		queryKey: ["background-task-tail", narratorId, taskId],
		queryFn: () => api.getBackgroundTaskOutputTail(narratorId, taskId),
		enabled,
		refetchInterval: enabled && isActive ? TAIL_POLL_INTERVAL_MS : false,
		gcTime: 30_000,
	});
}

interface BashTaskDetailProps {
	narratorId: string;
	task: UnifiedTask;
	isActive: boolean;
	opened: boolean;
}

/** Expanded body of a bash task row: full command + live output tail. */
function BashTaskDetail({ narratorId, task, isActive, opened }: BashTaskDetailProps) {
	const { t } = useTranslation("narrator");
	const { data, isLoading, isError } = useTaskOutputTail(narratorId, task.id, opened, isActive);
	// While a running task has produced nothing yet, fall back to the list preview
	// so a completed-but-not-yet-fetched row still shows something immediately.
	const tail = data?.tail ?? task.output ?? "";

	return (
		<Stack gap={6} mt={6} data-message-selection-ignore>
			{task.command && (
				<Stack gap={2}>
					<Text size="xs" c="dimmed" fw={600}>
						{t("backgroundTasks.commandLabel")}
					</Text>
					<ContentViewer
						bodyId={toolBodyId(task.toolUseId ?? task.id, "input.command")}
						content={task.command}
						title={t("backgroundTasks.commandLabel")}
						language="shellscript"
						style={{ maxHeight: 160, overflow: "auto", fontSize: 11 }}
					/>
				</Stack>
			)}
			<Stack gap={2}>
				<Group gap={6} justify="space-between" wrap="nowrap">
					<Text size="xs" c="dimmed" fw={600}>
						{t("backgroundTasks.outputLabel")}
					</Text>
					<Group gap={4} wrap="nowrap">
						{data?.live && (
							<Badge size="xs" variant="light" color="blue">
								{t("backgroundTasks.outputLive")}
							</Badge>
						)}
						{data?.truncated && (
							<Badge size="xs" variant="light" color="gray">
								{t("backgroundTasks.outputTailOnly")}
							</Badge>
						)}
						{isLoading && <Loader size={12} />}
					</Group>
				</Group>
				<ContentViewer
					bodyId={toolBodyId(task.toolUseId ?? task.id, "output.main")}
					content={tail}
					title={t("backgroundTasks.outputLabel")}
					style={{ maxHeight: 320, fontSize: 11 }}
					live={isActive && (data?.live ?? true)}
					truncated={data?.truncated}
					revision={tail}
				/>
				{isError ? (
					<Text size="xs" c="red">
						{t("backgroundTasks.outputLoadFailed")}
					</Text>
				) : !tail ? (
					<Text size="xs" c="dimmed">
						{isActive ? t("backgroundTasks.outputWaiting") : t("backgroundTasks.outputEmpty")}
					</Text>
				) : null}
			</Stack>
			{task.exitCode != null && (
				<Text size="xs" c="dimmed">
					exit {task.exitCode}
				</Text>
			)}
		</Stack>
	);
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
	const [expandedTaskIds, setExpandedTaskIds] = useState<ReadonlySet<string>>(() => new Set());
	const navigate = useNavigate();
	// When rendered inside a dock surface (single-narrator page or workspace),
	// open subagent sessions as dockview panels; otherwise fall back to routing.
	const dock = useNarratorDockContext();
	const subagentsCapability = useNarratorSubagentsCapability();
	const backgroundTasksSupported = subagentsCapability.supported && subagentsCapability.background;
	const canOpenSubagentSessions = subagentsCapability.supported && subagentsCapability.detachAttach;
	const showReattachFallback = canOpenSubagentSessions && !subagentsCapability.reattachBlocksParent;
	const reattachFallbackReason =
		subagentsCapability.reattachReason ?? t("backgroundTasks.reattachPartial");

	const { tasks, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage, refresh } =
		useBackgroundTaskList(narratorId, backgroundTasksSupported);

	const allTasks = useMemo(() => tasks.map(toUnifiedTask), [tasks]);

	const handleOpenSubagent = useCallback(
		(subagentNarratorId: string) => {
			if (!canOpenSubagentSessions) return;
			onOpenSubagent?.();
			// Gate on the bridge, not on `dock`: a tool panel torn out onto the
			// story-network canvas HAS a dock context but no secondary area to put a
			// session in, so the bridge is absent while its source node is collapsed.
			// Falling through to the standalone page is a real answer there — unlike
			// `dock.openSubagentPanel(...)` through a `?.`, which would look like it
			// worked and do nothing.
			const openInDock = dock?.openSubagentPanel;
			if (openInDock) {
				openInDock(subagentNarratorId);
			} else {
				navigate({ to: "/narrators/$narratorId", params: { narratorId: subagentNarratorId } });
			}
		},
		[canOpenSubagentSessions, navigate, onOpenSubagent, dock],
	);

	const handleToggleExpanded = useCallback((taskId: string) => {
		setExpandedTaskIds((current) => {
			const next = new Set(current);
			if (next.has(taskId)) next.delete(taskId);
			else next.add(taskId);
			return next;
		});
	}, []);

	const handleCancel = useCallback(
		async (taskId: string) => {
			if (!backgroundTasksSupported) return;
			try {
				await api.cancelBackgroundTask(narratorId, taskId);
				// A cancel also produces a delta, but that is a race against this
				// response; refreshing here makes the local action feel immediate and the
				// delta then arrives as a no-op (same version already applied).
				refresh();
			} catch {
				// ignore
			}
		},
		[backgroundTasksSupported, narratorId, refresh],
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
					const isActive = isBackgroundTaskActive(task.status);
					const canOpenSubagent =
						canOpenSubagentSessions && task.kind === "agent" && !!task.subagentNarratorId;
					const canInspect = task.kind === "bash" && !!task.toolUseId;
					// Only bash tasks own their output here; an agent task's real detail
					// lives in its subagent session, which the row already links to.
					const canExpand = task.kind === "bash";
					const expanded = canExpand && expandedTaskIds.has(task.id);
					const Icon =
						task.kind === "bash"
							? IconTerminal2
							: task.kind === "transfer"
								? IconTransfer
								: IconRobot;
					return (
						<Box
							key={task.id}
							p="xs"
							style={{
								border: "1px solid var(--mantine-color-default-border)",
								borderRadius: "var(--mantine-radius-sm)",
							}}
						>
							{/* Only the header row is clickable, so interacting with the
							    expanded output (select, scroll, copy) can't collapse it. */}
							<Group
								justify="space-between"
								wrap="nowrap"
								gap="xs"
								onClick={() => {
									if (canOpenSubagent && task.subagentNarratorId) {
										handleOpenSubagent(task.subagentNarratorId);
										return;
									}
									if (canExpand) handleToggleExpanded(task.id);
								}}
								style={{ cursor: canOpenSubagent || canExpand ? "pointer" : "default" }}
							>
								<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
									{canExpand &&
										(expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />)}
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
										{statusLabel(task.status, task.activeChildTaskCount, t)}
									</Badge>
									{task.canCancelActiveWork && (
										<ActionIcon
											size="xs"
											variant="subtle"
											color="red"
											onClick={(event) => {
												event.stopPropagation();
												handleCancel(task.id);
											}}
											title={
												task.status === "continued"
													? t("backgroundTasks.cancelContinuation")
													: task.status === "child_running"
														? t("backgroundTasks.cancelChildren")
														: t("backgroundTasks.cancel")
											}
										>
											<IconX size={12} />
										</ActionIcon>
									)}
								</Group>
							</Group>
							{/* Always shown while it exists — a transfer's bar is the row's whole
							    point, and it must not be hidden behind expanding the row. */}
							{task.progress && <TransferProgressBar progress={task.progress} />}
							{/* A paused transfer's `output` holds the reason it stopped (e.g. a
							    restart), which is exactly what the user needs to decide whether
							    to resume. The `!isActive` gate below would hide it, since paused
							    counts as active. */}
							{task.status === "paused" && task.output && (
								<Text size="xs" c="dimmed" mt={4} lineClamp={2}>
									{task.output.slice(0, 200)}
								</Text>
							)}
							{!expanded && !isActive && task.output && (
								<Text size="xs" c="dimmed" mt={4} lineClamp={2}>
									{task.output.slice(0, 200)}
								</Text>
							)}
							{!expanded && !isActive && task.exitCode != null && (
								<Text size="xs" c="dimmed" mt={4}>
									exit {task.exitCode}
								</Text>
							)}
							{canExpand && (
								<Collapse expanded={expanded} keepMounted={false}>
									<BashTaskDetail
										narratorId={narratorId}
										task={task}
										isActive={isActive}
										opened={expanded}
									/>
								</Collapse>
							)}
						</Box>
					);
				})}

				{isLoading && (
					<Group justify="center" py="md">
						<Loader size="sm" />
					</Group>
				)}

				{/* Explicit control rather than scroll-driven auto-paging: older tasks
				    are history, and a user scrolling to read one row should not pull in
				    pages they did not ask for. */}
				{hasNextPage && (
					<Button
						variant="subtle"
						size="xs"
						onClick={fetchNextPage}
						loading={isFetchingNextPage}
						fullWidth
					>
						{t("backgroundTasks.loadOlder")}
					</Button>
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

/**
 * Off-dock host for the background-tasks panel, with open state owned by the
 * CALLER.
 *
 * The self-managed `BackgroundTasksDrawer` below bundles its own trigger button,
 * which the registry-driven header cannot use: the header decides which entries
 * are surfaced and in what order, so an entry that paints its own button would
 * escape both the ordering and the overflow menu. This variant is the drawer
 * without the button.
 */
export function BackgroundTasksDrawerHost({
	narratorId,
	opened,
	onClose,
}: {
	narratorId: string;
	opened: boolean;
	onClose: () => void;
}) {
	const { t } = useTranslation("narrator");
	const { runningCount } = useBackgroundTasksButton(narratorId, opened);

	return (
		<Drawer
			opened={opened}
			onClose={onClose}
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
			styles={{
				header: SAFE_AREA_DEFAULT_DRAWER_HEADER_STYLE,
				body: SAFE_AREA_PADDED_DRAWER_BODY_STYLE,
			}}
		>
			<BackgroundTasksPanel narratorId={narratorId} onOpenSubagent={onClose} />
		</Drawer>
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
				styles={{
					header: SAFE_AREA_DEFAULT_DRAWER_HEADER_STYLE,
					body: SAFE_AREA_PADDED_DRAWER_BODY_STYLE,
				}}
			>
				<BackgroundTasksPanel narratorId={narratorId} onOpenSubagent={close} />
			</Drawer>
		</>
	);
}
