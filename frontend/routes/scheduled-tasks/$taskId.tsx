import {
	ActionIcon,
	Badge,
	Button,
	Container,
	Group,
	Paper,
	Stack,
	Table,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { IconArrowLeft, IconClock, IconExternalLink, IconPlayerPlay } from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
	useRunScheduledTask,
	useScheduledTask,
	useScheduledTaskRuns,
} from "../../hooks/useScheduledTasks";
import type { ScheduledTaskLastStatus, ScheduledTaskRun } from "../../lib/api";
import { formatDurationText } from "../../lib/format";

export const Route = createFileRoute("/scheduled-tasks/$taskId")({
	component: ScheduledTaskDetailPage,
});

function statusColor(status: ScheduledTaskLastStatus): string {
	return status === "success" ? "teal" : status === "skipped" ? "yellow" : "red";
}

function ScheduledTaskDetailPage() {
	const { taskId } = Route.useParams();
	const { t } = useTranslation("scheduledTasks");
	const navigate = useNavigate();

	const { data: task, isLoading } = useScheduledTask(taskId);
	const {
		data: runsData,
		isLoading: runsLoading,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = useScheduledTaskRuns(taskId);
	const runMutation = useRunScheduledTask();

	const runs: ScheduledTaskRun[] = runsData?.pages.flatMap((p) => p.runs) ?? [];

	const goBack = () => navigate({ to: "/scheduled-tasks" });

	if (isLoading) {
		return (
			<Container size="lg" py="lg">
				<Text c="dimmed">{t("loading")}</Text>
			</Container>
		);
	}

	if (!task) {
		return (
			<Container size="lg" py="lg">
				<Stack>
					<Button
						variant="subtle"
						leftSection={<IconArrowLeft size={16} />}
						onClick={goBack}
						w="fit-content"
					>
						{t("backToList")}
					</Button>
					<Text c="dimmed">{t("notFound")}</Text>
				</Stack>
			</Container>
		);
	}

	const nextRun = task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "—";
	const lastRun = task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : "—";

	return (
		<Container size="lg" py="lg">
			<Group justify="space-between" mb="md" align="flex-start" wrap="nowrap">
				<Stack gap={4} style={{ minWidth: 0 }}>
					<Button
						variant="subtle"
						size="compact-sm"
						leftSection={<IconArrowLeft size={14} />}
						onClick={goBack}
						w="fit-content"
						px={4}
					>
						{t("backToList")}
					</Button>
					<Group gap="xs">
						<IconClock size={22} />
						<Title order={2} style={{ wordBreak: "break-word" }}>
							{task.name}
						</Title>
						<Badge size="sm" variant="light" color={task.enabled ? "teal" : "gray"}>
							{task.enabled ? t("statusEnabled") : t("statusDisabled")}
						</Badge>
					</Group>
				</Stack>
				<Button
					leftSection={<IconPlayerPlay size={16} />}
					onClick={() => runMutation.mutate(task.id)}
					loading={runMutation.isPending}
				>
					{t("runNow")}
				</Button>
			</Group>

			{/* Config summary */}
			<Paper withBorder p="md" mb="md">
				<Stack gap="xs">
					<SummaryRow label={t("cronExpr")}>
						<Text size="sm" ff="monospace">
							{task.cronExpr}
							{task.timezone ? ` (${task.timezone})` : ""}
						</Text>
					</SummaryRow>
					<SummaryRow label={t("runContext")}>
						<Badge size="sm" variant="outline" color="indigo">
							{task.runContext === "chapter" ? t("ctxChapter") : t("ctxStandalone")}
						</Badge>
					</SummaryRow>
					<SummaryRow label={t("model")}>
						<Text size="sm">{task.model || t("modelFollowDefault")}</Text>
					</SummaryRow>
					<SummaryRow label={t("permissionMode")}>
						<Text size="sm">{task.permissionMode}</Text>
					</SummaryRow>
					<SummaryRow label={t("nextRun")}>
						<Text size="sm">{nextRun}</Text>
					</SummaryRow>
					<SummaryRow label={t("lastRun")}>
						<Text size="sm">{lastRun}</Text>
					</SummaryRow>
				</Stack>
			</Paper>

			{/* Run history */}
			<Title order={4} mb="sm">
				{t("runHistory")}
			</Title>
			{runsLoading ? (
				<Text c="dimmed">{t("loading")}</Text>
			) : runs.length === 0 ? (
				<Paper withBorder p="xl" ta="center">
					<Text c="dimmed">{t("noRuns")}</Text>
				</Paper>
			) : (
				<>
					<Paper withBorder>
						<Table.ScrollContainer minWidth={640}>
							<Table striped highlightOnHover>
								<Table.Thead>
									<Table.Tr>
										<Table.Th>{t("runTime")}</Table.Th>
										<Table.Th>{t("runTrigger")}</Table.Th>
										<Table.Th>{t("runStatus")}</Table.Th>
										<Table.Th>{t("runNarrator")}</Table.Th>
										<Table.Th>{t("runDuration")}</Table.Th>
										<Table.Th>{t("runError")}</Table.Th>
									</Table.Tr>
								</Table.Thead>
								<Table.Tbody>
									{runs.map((run) => (
										<RunRow key={run.id} run={run} />
									))}
								</Table.Tbody>
							</Table>
						</Table.ScrollContainer>
					</Paper>
					{hasNextPage && (
						<Group justify="center" mt="md">
							<Button variant="light" onClick={() => fetchNextPage()} loading={isFetchingNextPage}>
								{t("loadMore")}
							</Button>
						</Group>
					)}
				</>
			)}
		</Container>
	);
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<Group gap="sm" wrap="nowrap" align="flex-start">
			<Text size="sm" c="dimmed" w={110} style={{ flexShrink: 0 }}>
				{label}
			</Text>
			{children}
		</Group>
	);
}

function RunRow({ run }: { run: ScheduledTaskRun }) {
	const { t } = useTranslation("scheduledTasks");
	const navigate = useNavigate();
	const when = run.createdAt ? new Date(run.createdAt).toLocaleString() : "—";

	return (
		<Table.Tr>
			<Table.Td>
				<Text size="sm">{when}</Text>
			</Table.Td>
			<Table.Td>
				<Badge size="sm" variant="light" color={run.manual ? "grape" : "gray"}>
					{run.manual ? t("triggerManual") : t("triggerScheduled")}
				</Badge>
			</Table.Td>
			<Table.Td>
				<Badge size="sm" variant="light" color={statusColor(run.status)}>
					{t(`last_${run.status}`)}
				</Badge>
			</Table.Td>
			<Table.Td>
				{run.narratorId ? (
					<Tooltip label={t("openNarrator")}>
						<ActionIcon
							variant="subtle"
							size="sm"
							onClick={() =>
								navigate({
									to: "/narrators/$narratorId",
									params: { narratorId: run.narratorId as string },
								})
							}
							aria-label={t("openNarrator")}
						>
							<IconExternalLink size={16} />
						</ActionIcon>
					</Tooltip>
				) : (
					<Text size="sm" c="dimmed">
						—
					</Text>
				)}
			</Table.Td>
			<Table.Td>
				<Text size="sm">
					{formatDurationText(run.durationMs, { style: "precise", fallback: "—" })}
				</Text>
			</Table.Td>
			<Table.Td>
				{run.error ? (
					<Text size="xs" c="red" lineClamp={2} title={run.error}>
						{run.error}
					</Text>
				) : (
					<Text size="sm" c="dimmed">
						—
					</Text>
				)}
			</Table.Td>
		</Table.Tr>
	);
}
