import { SchedulePreviewPanel } from "@frontend/components/scheduled-tasks/SchedulePreviewPanel";
import {
	formatTaskTime,
	scheduleProgress,
	scheduleSummary,
	taskSchedule,
} from "@frontend/components/scheduled-tasks/schedule-presentation";
import { TaskActions } from "@frontend/components/scheduled-tasks/TaskActions";
import {
	SummaryRow,
	TaskConfigSummary,
} from "@frontend/components/scheduled-tasks/TaskConfigSummary";
import { TaskCreator } from "@frontend/components/scheduled-tasks/TaskCreator";
import { useTaskPage } from "@frontend/components/scheduled-tasks/TaskPageFrame";
import { RunRecord, TaskRunHistory } from "@frontend/components/scheduled-tasks/TaskRunHistory";
import {
	RunVerdictBadge,
	TaskLifecycleBadge,
} from "@frontend/components/scheduled-tasks/TaskStatus";
import { TaskTransfer } from "@frontend/components/scheduled-tasks/TaskTransfer";
import { useScheduledTaskRuns } from "@frontend/hooks/useScheduledTasks";
import { parseScheduledTaskSearch } from "@frontend/lib/scheduled-task-search";
import { Alert, Button, Grid, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/scheduled-tasks/$taskId/")({
	component: ScheduledTaskDetailPage,
});

function ScheduledTaskDetailPage() {
	const { t, i18n } = useTranslation("scheduledTasks");
	const task = useTaskPage();
	const search = Route.useSearch();
	const listSearch = parseScheduledTaskSearch(search);
	const navigate = Route.useNavigate();
	const runs = useScheduledTaskRuns(task.id);
	const latest =
		runs.data?.pages[0]?.runs.find((run) => run.id === task.lastRunId) ??
		runs.data?.pages[0]?.runs[0];
	return (
		<Stack gap="lg">
			<Group justify="space-between" align="flex-start">
				<Stack gap="xs">
					<Group>
						<Title order={2} style={{ overflowWrap: "anywhere" }}>
							{task.name}
						</Title>
						<TaskLifecycleBadge lifecycle={task.lifecycle} />
					</Group>
					<Text size="sm" c="dimmed">
						{task.lifecycle === "active" && task.nextRunAt
							? `${t("nextRun")}: ${formatTaskTime(task.nextRunAt, task.timezone, i18n.language)}`
							: t(
									task.lifecycle === "ended"
										? "noNextRun"
										: task.lifecycle === "paused"
											? "pausedNextRun"
											: "nextRunPending",
								)}
					</Text>
				</Stack>
				<TaskActions
					task={task}
					onEdit={() =>
						void navigate({
							to: "/scheduled-tasks/$taskId/edit",
							params: { taskId: task.id },
							search: listSearch,
						})
					}
					onCopy={() =>
						void navigate({
							to: "/scheduled-tasks/new",
							search: { ...listSearch, copyFrom: task.id },
						})
					}
					onDeleted={() => void navigate({ to: "/scheduled-tasks", search: listSearch })}
				/>
			</Group>
			{task.lifecycle === "ended" && <Alert color="gray">{t("lifecycleHint")}</Alert>}
			{task.pauseReason === "circuit_breaker" && (
				<Alert color="orange">{t("circuitBreakerHint")}</Alert>
			)}
			<Grid gap="lg">
				<Grid.Col span={{ base: 12, md: 8 }}>
					<Stack gap="lg">
						<Paper withBorder p="lg" radius="md">
							<Stack>
								<Title order={3}>{t("overview")}</Title>
								<Text>{scheduleSummary(taskSchedule(task), t)}</Text>
								<Text size="sm" c="dimmed">
									{scheduleProgress(task, t)}
								</Text>
								<SummaryRow label={t("timezone")}>
									{task.timezone || t("serverTimezone")}
								</SummaryRow>
								{task.completedAt && (
									<SummaryRow label={t("completedAt")}>
										{formatTaskTime(task.completedAt, task.timezone, i18n.language)}
									</SummaryRow>
								)}
								<Text size="xs" c="dimmed">
									{t("countHint")}
								</Text>
							</Stack>
						</Paper>
						<Paper withBorder p="lg" radius="md">
							<Stack>
								<Title order={3}>{t("attribution")}</Title>
								<Text size="xs" c="dimmed">
									{t("creator")}
								</Text>
								<TaskCreator task={task} detailed />
								{task.creator.canOpen && task.creator.narratorId && (
									<Button
										renderRoot={(props) => (
											<Link
												{...props}
												to="/narrators/$narratorId"
												params={{ narratorId: task.creator.narratorId ?? "" }}
												hash={task.creator.messageId ? `msg-${task.creator.messageId}` : undefined}
											/>
										)}
										variant="subtle"
										size="xs"
										w="fit-content"
										rightSection={<IconExternalLink size={14} />}
									>
										{t(task.creator.messageId ? "openCreatorMessage" : "openCreator")}
									</Button>
								)}
								<SummaryRow label={t("owner")}>{task.owner?.username || t("unowned")}</SummaryRow>
								<TaskTransfer task={task} />
								<Text size="xs" c="dimmed">
									{t("ownerHint")}
								</Text>
							</Stack>
						</Paper>
						<Stack gap="sm">
							<Title order={3}>{t("latestRun")}</Title>
							{latest ? (
								<RunRecord run={latest} timezone={task.timezone} />
							) : (
								<Paper withBorder p="md">
									<Stack gap="xs">
										{task.lastStatus ? (
											<>
												<RunVerdictBadge
													status={task.lastStatus}
													outcome={task.lastOutcome}
													requireReport={task.lastRequireReport ?? true}
												/>
												{task.lastSummary && <Text size="sm">{task.lastSummary}</Text>}
											</>
										) : (
											<Text size="sm" c="dimmed">
												{t("neverRun")}
											</Text>
										)}
										{runs.error && (
											<Text c="red" size="sm">
												{runs.error.message}
											</Text>
										)}
									</Stack>
								</Paper>
							)}
						</Stack>
						<TaskRunHistory task={task} focusRunId={search.runId} />
					</Stack>
				</Grid.Col>
				<Grid.Col span={{ base: 12, md: 4 }}>
					<Stack gap="lg">
						<SchedulePreviewPanel preview={task.preview} timezone={task.timezone} />
						<TaskConfigSummary task={task} />
					</Stack>
				</Grid.Col>
			</Grid>
		</Stack>
	);
}
