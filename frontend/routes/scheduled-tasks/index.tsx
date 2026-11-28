import { MobileNavButton } from "@frontend/components/nav/MobileNavButton";
import {
	formatTaskTime,
	scheduleProgress,
	scheduleSummary,
	taskSchedule,
} from "@frontend/components/scheduled-tasks/schedule-presentation";
import { TaskActions } from "@frontend/components/scheduled-tasks/TaskActions";
import { TaskCreator } from "@frontend/components/scheduled-tasks/TaskCreator";
import { TaskFilters } from "@frontend/components/scheduled-tasks/TaskFilters";
import {
	RunVerdictBadge,
	TaskLifecycleBadge,
} from "@frontend/components/scheduled-tasks/TaskStatus";
import { useScheduledTasks } from "@frontend/hooks/useScheduledTasks";
import type { ScheduledTask } from "@frontend/lib/api/scheduled-tasks";
import {
	hasScheduledTaskFilters,
	parseScheduledTaskSearch,
	type ScheduledTaskSearch,
} from "@frontend/lib/scheduled-task-search";
import {
	Alert,
	Badge,
	Box,
	Button,
	Container,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
	Title,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconCalendarClock, IconPlus } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/scheduled-tasks/")({
	validateSearch: parseScheduledTaskSearch,
	component: ScheduledTasksPage,
});

function ScheduledTasksPage() {
	const { t } = useTranslation("scheduledTasks");
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const [querySearch] = useDebouncedValue(search, 250);
	const query = useScheduledTasks(querySearch);
	const filtered = hasScheduledTaskFilters(search);
	const change = (values: Partial<ScheduledTaskSearch>) =>
		void navigate({
			search: parseScheduledTaskSearch({ ...search, ...values }),
			replace: "q" in values,
		});
	return (
		<Container size="xl" py="lg">
			<Stack gap="lg">
				<Group justify="space-between">
					<Group wrap="nowrap">
						<MobileNavButton />
						<Stack gap={4}>
							<Title order={2}>{t("title")}</Title>
							<Text c="dimmed" size="sm">
								{t("subtitle")}
							</Text>
						</Stack>
					</Group>
					<Button
						leftSection={<IconPlus size={16} />}
						onClick={() => void navigate({ to: "/scheduled-tasks/new", search })}
					>
						{t("createTask")}
					</Button>
				</Group>
				<Paper withBorder p="md" radius="md">
					<Box visibleFrom="sm">
						<TaskFilters search={search} onChange={change} />
					</Box>
					<Box hiddenFrom="sm">
						<TaskFilters search={search} onChange={change} mobile />
					</Box>
				</Paper>
				{query.isPending ? (
					<Group justify="center" py="xl">
						<Loader size="sm" />
						<Text c="dimmed">{t("loading")}</Text>
					</Group>
				) : query.error ? (
					<Alert color="red" title={t("loadFailed")}>
						<Stack gap="xs">
							<Text size="sm">{query.error.message}</Text>
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
					<>
						<Group justify="space-between">
							<Text size="sm" c="dimmed">
								{t("taskCount", { count: query.data.length })}
							</Text>
							{query.isFetching && <Loader size="xs" />}
							{filtered && (
								<Button
									size="compact-xs"
									variant="subtle"
									onClick={() => void navigate({ search: {} })}
								>
									{t("clearFilters")}
								</Button>
							)}
						</Group>
						{query.data.length === 0 ? (
							<Paper withBorder radius="md" p="xl">
								<Stack align="center" gap="sm">
									<IconCalendarClock size={32} />
									<Title order={4}>{t(filtered ? "noMatches" : "emptyTitle")}</Title>
									<Text size="sm" c="dimmed" ta="center">
										{t(filtered ? "noMatchesHint" : "empty")}
									</Text>
									{filtered ? (
										<Button variant="light" onClick={() => void navigate({ search: {} })}>
											{t("clearFilters")}
										</Button>
									) : (
										<Group>
											<Button onClick={() => void navigate({ to: "/scheduled-tasks/new", search })}>
												{t("createTask")}
											</Button>
											<Button variant="subtle" onClick={() => change({ lifecycle: "all" })}>
												{t("showAll")}
											</Button>
										</Group>
									)}
								</Stack>
							</Paper>
						) : (
							<Stack gap="sm">
								{query.data.map((task) => (
									<TaskListRow key={task.id} task={task} search={search} />
								))}
							</Stack>
						)}
					</>
				)}
			</Stack>
		</Container>
	);
}

function TaskListRow({ task, search }: { task: ScheduledTask; search: ScheduledTaskSearch }) {
	const { t, i18n } = useTranslation("scheduledTasks");
	const navigate = Route.useNavigate();
	const nextTime =
		task.lifecycle === "active" && task.nextRunAt
			? formatTaskTime(task.nextRunAt, task.timezone, i18n.language)
			: null;
	const relative = task.nextRunAt ? relativeNext(task.nextRunAt, i18n.language) : "";
	return (
		<Paper withBorder p="md" radius="md">
			<Group justify="space-between" align="flex-start" wrap="wrap">
				<UnstyledButton
					style={{ flex: "1 1 260px", minWidth: 0 }}
					onClick={() =>
						void navigate({ to: "/scheduled-tasks/$taskId", params: { taskId: task.id }, search })
					}
				>
					<Stack gap={7}>
						<Group gap="xs">
							<Text fw={600} style={{ overflowWrap: "anywhere" }}>
								{task.name}
							</Text>
							<TaskLifecycleBadge lifecycle={task.lifecycle} />
							{task.pauseReason === "circuit_breaker" && (
								<Badge color="orange" size="xs">
									{t("autoPaused")}
								</Badge>
							)}
						</Group>
						<Text size="sm">{scheduleSummary(taskSchedule(task), t)}</Text>
						<Text size="xs" c="dimmed">
							{scheduleProgress(task, t)} · {task.timezone || t("serverTimezone")}
						</Text>
						<Group gap="md">
							{nextTime ? (
								<Tooltip label={nextTime}>
									<Text size="sm" c="dimmed">
										{t("nextRun")}: {relative}
									</Text>
								</Tooltip>
							) : (
								<Text size="sm" c="dimmed">
									{t(
										task.lifecycle === "ended"
											? "noNextRun"
											: task.lifecycle === "paused"
												? "pausedNextRun"
												: "nextRunPending",
									)}
								</Text>
							)}
							{task.lastStatus ? (
								<RunVerdictBadge
									status={task.lastStatus}
									outcome={task.lastOutcome}
									requireReport={task.lastRequireReport ?? true}
								/>
							) : (
								<Text size="xs" c="dimmed">
									{t("neverRun")}
								</Text>
							)}
						</Group>
					</Stack>
				</UnstyledButton>
				<Stack gap="sm" align="flex-end">
					<TaskCreator task={task} />
					<TaskActions
						task={task}
						compact
						onEdit={() =>
							void navigate({
								to: "/scheduled-tasks/$taskId/edit",
								params: { taskId: task.id },
								search,
							})
						}
						onCopy={() =>
							void navigate({
								to: "/scheduled-tasks/new",
								search: { ...search, copyFrom: task.id },
							})
						}
					/>
				</Stack>
			</Group>
		</Paper>
	);
}

function relativeNext(value: string, locale: string) {
	const minutes = Math.round((new Date(value).getTime() - Date.now()) / 60_000);
	const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
	if (Math.abs(minutes) < 1440) return formatter.format(Math.round(minutes / 60), "hour");
	return formatter.format(Math.round(minutes / 1440), "day");
}
