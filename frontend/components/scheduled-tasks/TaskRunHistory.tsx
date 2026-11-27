import { useScheduledTaskRuns } from "@frontend/hooks/useScheduledTasks";
import type { ScheduledTask, ScheduledTaskRun } from "@frontend/lib/api/scheduled-tasks";
import { formatDurationText } from "@frontend/lib/format";
import { RUN_VERDICTS } from "@frontend/lib/scheduled-task-search";
import { Alert, Button, Group, Loader, Paper, Select, Stack, Text, Title } from "@mantine/core";
import { type RunVerdict, runVerdict } from "@shared/scheduled-task-status";
import { IconExternalLink } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatTaskTime } from "./schedule-presentation";
import { RunAxes, RunVerdictBadge } from "./TaskStatus";

export function TaskRunHistory({ task, focusRunId }: { task: ScheduledTask; focusRunId?: string }) {
	const { t } = useTranslation("scheduledTasks");
	const [result, setResult] = useState<RunVerdict | undefined>();
	const query = useScheduledTaskRuns(task.id, result);
	const runs = useMemo(() => {
		const seen = new Set<string>();
		return (query.data?.pages.flatMap((page) => page.runs) ?? []).filter((run) => {
			if (seen.has(run.id)) return false;
			seen.add(run.id);
			return true;
		});
	}, [query.data]);
	const focused = useRef<string | null>(null);
	useEffect(() => {
		if (!focusRunId || focused.current === focusRunId || !runs.some((run) => run.id === focusRunId))
			return;
		document.getElementById(`run-${focusRunId}`)?.scrollIntoView({ block: "center" });
		focused.current = focusRunId;
	}, [focusRunId, runs]);
	return (
		<Stack gap="sm">
			<Group justify="space-between">
				<Title order={3}>{t("runHistory")}</Title>
				<Select
					aria-label={t("filterResult")}
					placeholder={t("anyResult")}
					clearable
					value={result ?? null}
					data={RUN_VERDICTS.map((value) => ({ value, label: t(`verdict.${value}`) }))}
					onChange={(value) => setResult((value as RunVerdict) || undefined)}
				/>
			</Group>
			{focusRunId && !runs.some((run) => run.id === focusRunId) && !query.isPending && (
				<Alert color="blue">{t("focusedRunNotLoaded")}</Alert>
			)}
			{query.isPending ? (
				<Loader size="sm" />
			) : query.error ? (
				<Alert color="red">
					<Stack gap="xs">
						{query.error.message}
						<Button size="xs" variant="light" onClick={() => void query.refetch()}>
							{t("retry")}
						</Button>
					</Stack>
				</Alert>
			) : runs.length === 0 ? (
				<Paper p="lg" withBorder>
					<Text size="sm" c="dimmed">
						{t(result ? "noMatchingRuns" : "noRuns")}
					</Text>
				</Paper>
			) : (
				runs.map((run) => (
					<RunRecord
						key={run.id}
						anchorId={`run-${run.id}`}
						run={run}
						timezone={task.timezone}
						highlighted={run.id === focusRunId}
					/>
				))
			)}
			{query.hasNextPage && (
				<Group justify="center">
					<Button
						variant="light"
						loading={query.isFetchingNextPage}
						onClick={() => void query.fetchNextPage()}
					>
						{t("loadMore")}
					</Button>
				</Group>
			)}
		</Stack>
	);
}

export function RunRecord({
	run,
	timezone,
	highlighted = false,
	anchorId,
}: {
	run: ScheduledTaskRun;
	timezone: string | null;
	highlighted?: boolean;
	anchorId?: string;
}) {
	const { t, i18n } = useTranslation("scheduledTasks");
	const verdict = run.verdict ?? runVerdict(run.status, run.outcome, run.requireReport ?? true);
	return (
		<Paper
			id={anchorId}
			withBorder
			radius="md"
			p="md"
			style={highlighted ? { borderColor: "var(--mantine-color-indigo-6)" } : undefined}
		>
			<Stack gap="xs">
				<Group justify="space-between" align="flex-start">
					<Group gap="xs">
						<RunVerdictBadge verdict={verdict} />
						<Text size="xs" c="dimmed">
							{t(run.trigger === "manual" || run.manual ? "triggerManual" : "triggerScheduled")}
						</Text>
						<Text size="sm">
							{formatTaskTime(run.scheduledFor ?? run.createdAt, timezone, i18n.language)}
						</Text>
					</Group>
					{run.narratorId && (
						<Button
							renderRoot={(props) => (
								<Link
									{...props}
									to="/narrators/$narratorId"
									params={{ narratorId: run.narratorId ?? "" }}
									hash={run.triggerMessageId ? `msg-${run.triggerMessageId}` : undefined}
								/>
							)}
							size="compact-xs"
							variant="subtle"
							rightSection={<IconExternalLink size={12} />}
						>
							{t(verdict === "blocked" ? "handleBlock" : "openNarrator")}
						</Button>
					)}
				</Group>
				<RunAxes status={run.status} outcome={run.outcome} />
				{run.outcomeSummary && (
					<Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
						{run.outcomeSummary}
					</Text>
				)}
				{run.error && (
					<Text size="sm" c="red" style={{ overflowWrap: "anywhere" }}>
						{run.error}
					</Text>
				)}
				{run.blockReason && (
					<Text size="xs" c="orange">
						{t("blockReason")}: {t(`block.${run.blockReason}`, { defaultValue: run.blockReason })}
					</Text>
				)}
				<Group gap="lg">
					<Text size="xs" c="dimmed">
						{t("runDuration")}: {run.durationMs != null ? formatDurationText(run.durationMs) : "—"}
					</Text>
					<Text size="xs" c="dimmed">
						{t("model")}: {run.model || t("modelUnknown")}
					</Text>
					{run.missedCount != null && (
						<Text size="xs" c="dimmed">
							{t("missedCount", { count: run.missedCount })}
						</Text>
					)}
				</Group>
			</Stack>
		</Paper>
	);
}
