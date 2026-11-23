import { ActionIcon, Badge, Box, Code, Group, Stack, Text, Tooltip } from "@mantine/core";
import { isBackgroundTaskActiveStatus } from "@shared/background-task-list";
import { formatProgressDuration } from "@shared/tool-progress";
import {
	isWatchDeadlineOutput,
	parseWatchCommand,
	type WatchTarget,
	watchResultTargetStatus,
} from "@shared/watch-command";
import {
	IconChevronDown,
	IconChevronRight,
	IconClock,
	IconExternalLink,
	IconEye,
	IconX,
} from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import classes from "./BackgroundTasksDrawer.module.css";

export interface WatchTaskRowTask {
	id: string;
	status: string;
	command: string | null;
	title: string | null;
	output: string | null;
	startedAt: string;
	canCancelActiveWork: boolean;
}

interface WatchTaskRowProps {
	task: WatchTaskRowTask;
	/** Opens the watched subagent; absent when it cannot be opened from here. */
	onOpenAgent?: (subagentNarratorId: string) => void;
	onCancel: (taskId: string) => void;
	/** Full stored output of a finished watch; the list row only carries a preview. */
	renderOutput?: (task: WatchTaskRowTask) => ReactNode;
}

const TITLE_PREFIX = /^watch (?:agent |bash )?/;

const TARGET_LABEL_KEY = {
	agent: "backgroundTasks.watchTargetAgent",
	bash: "backgroundTasks.watchTargetBash",
	terminal: "backgroundTasks.watchTargetTerminal",
} as const;

/** Target name from the row title, without the pattern a terminal title appends. */
export function watchTargetName(title: string | null, pattern: string | undefined): string | null {
	let name = title?.replace(TITLE_PREFIX, "") ?? "";
	if (pattern) {
		const suffix = `: ${pattern.slice(0, 40)}`;
		if (name.endsWith(suffix)) name = name.slice(0, -suffix.length);
	}
	return name || null;
}

type WatchOutcome =
	| "watching"
	| "deadline"
	| "matched"
	| "ended"
	| "replaced"
	| "stopped"
	| "cancelled"
	| "failed";

export function watchOutcome(
	task: Pick<WatchTaskRowTask, "status" | "output">,
	target: Pick<WatchTarget, "type" | "pattern"> | null,
): WatchOutcome {
	if (isBackgroundTaskActiveStatus(task.status)) return "watching";
	if (task.status === "cancelled") return "cancelled";
	if (task.status === "failed") return "failed";
	if (task.status === "timeout" || isWatchDeadlineOutput(task.output)) return "deadline";
	// Agent and bash watches finish "completed" whatever the target did; the
	// target's own status is in the result header.
	const targetStatus = watchResultTargetStatus(task.output);
	if (targetStatus === "found" || targetStatus === "text_matched") return "matched";
	if (targetStatus === "superseded" || targetStatus === "taken_over") return "replaced";
	if (targetStatus && targetStatus !== "completed") return "stopped";
	// A terminal watch completes on its pattern, or on the terminal exiting when it has none.
	return target?.type === "terminal" && target.pattern ? "matched" : "ended";
}

const OUTCOME_COLOR: Record<WatchOutcome, string> = {
	watching: "grape",
	deadline: "gray",
	matched: "green",
	ended: "green",
	replaced: "yellow",
	stopped: "orange",
	cancelled: "gray",
	failed: "red",
};

function outcomeLabel(outcome: WatchOutcome, t: TFunction<"narrator">): string {
	switch (outcome) {
		case "watching":
			return t("backgroundTasks.watchStatusWatching");
		case "deadline":
			return t("backgroundTasks.watchStatusDeadline");
		case "matched":
			return t("backgroundTasks.watchStatusMatched");
		case "ended":
			return t("backgroundTasks.watchStatusTargetEnded");
		case "replaced":
			return t("backgroundTasks.watchStatusTargetReplaced");
		case "stopped":
			return t("backgroundTasks.watchStatusTargetStopped");
		case "cancelled":
			return t("backgroundTasks.statusCancelled");
		case "failed":
			return t("backgroundTasks.statusFailed");
	}
}

/** The observed result, without the "Watch agent X: completed." header line. */
function resultPreview(output: string | null): string | null {
	if (!output) return null;
	const body = output
		.split(/\n\s*\n/)
		.slice(1)
		.join("\n\n")
		.trim();
	return (body || output).slice(0, 200);
}

function useSecondTicker(enabled: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!enabled) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [enabled]);
	return now;
}

/** "Deadline 10m · 3m 12s left"; the countdown ticks only while the watch is active. */
function WatchDeadline({
	timeoutMs,
	startedAt,
	watching,
}: {
	timeoutMs: number;
	startedAt: string;
	watching: boolean;
}) {
	const { t } = useTranslation("narrator");
	const now = useSecondTicker(watching);
	const deadlineAt = Date.parse(startedAt) + timeoutMs;
	const remainingSeconds =
		watching && Number.isFinite(deadlineAt) ? Math.max(0, (deadlineAt - now) / 1_000) : null;
	return (
		<Group gap={4} wrap="nowrap" data-watch-deadline>
			<IconClock size={12} color="var(--mantine-color-dimmed)" style={{ flexShrink: 0 }} />
			<Text size="xs" c="dimmed" truncate>
				{t("backgroundTasks.watchTimeout", {
					duration: formatProgressDuration(timeoutMs / 1_000),
				})}
				{remainingSeconds != null &&
					` · ${t("backgroundTasks.watchRemaining", {
						duration: formatProgressDuration(remainingSeconds),
					})}`}
			</Text>
		</Group>
	);
}

/**
 * The active watches observing one agent or bash row, shown on that row so it is
 * clear the target is being watched, with what pattern and until when.
 */
export function WatchAttachment({ watches }: { watches: readonly WatchTaskRowTask[] }) {
	const { t } = useTranslation("narrator");
	if (watches.length === 0) return null;
	return (
		<Stack gap={2} mt={4} data-watch-attachment>
			{watches.map((watch) => {
				const target = parseWatchCommand(watch.command);
				return (
					<Group key={watch.id} gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
						<IconEye size={12} color="var(--mantine-color-grape-5)" style={{ flexShrink: 0 }} />
						<Text size="xs" c="grape" style={{ flexShrink: 0 }}>
							{t("backgroundTasks.watchedBy")}
						</Text>
						{target?.pattern && (
							<Code style={{ fontSize: 11 }} className={classes.preview}>
								{target.pattern}
							</Code>
						)}
						{target?.timeoutMs != null && (
							<WatchDeadline timeoutMs={target.timeoutMs} startedAt={watch.startedAt} watching />
						)}
					</Group>
				);
			})}
		</Stack>
	);
}

/**
 * A Watch observation row. Watches are not commands: the row names what is
 * observed, the pattern it waits for and its deadline instead of the raw
 * `[watch] …` handle.
 */
export function WatchTaskRow({ task, onOpenAgent, onCancel, renderOutput }: WatchTaskRowProps) {
	const { t } = useTranslation("narrator");
	const target = parseWatchCommand(task.command);
	const outcome = watchOutcome(task, target);
	const watching = outcome === "watching";
	const targetName = watchTargetName(task.title, target?.pattern) || target?.id || task.id;
	const openAgent = target?.type === "agent" && onOpenAgent ? onOpenAgent : undefined;
	const [expanded, setExpanded] = useState(false);
	const output = watching ? null : task.output;
	const preview = resultPreview(output);
	const toggle = () => setExpanded((current) => !current);

	return (
		<Box
			data-watch-task={task.id}
			p="xs"
			style={{
				border: "1px solid var(--mantine-color-default-border)",
				borderRadius: "var(--mantine-radius-sm)",
			}}
		>
			<Box
				className={classes.header}
				onClick={() => (openAgent ? openAgent(target?.id as string) : output && toggle())}
				style={{ cursor: openAgent || output ? "pointer" : "default" }}
			>
				<Group gap={6} wrap="nowrap" className={classes.identity}>
					{output && (
						<ActionIcon
							size="xs"
							variant="transparent"
							color="gray"
							data-watch-toggle
							aria-expanded={expanded}
							onClick={(event) => {
								event.stopPropagation();
								toggle();
							}}
						>
							{expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
						</ActionIcon>
					)}
					<IconEye size={14} />
					<Badge size="xs" variant="light" color="grape">
						{t("backgroundTasks.watchBadge")}
					</Badge>
				</Group>
				<Group gap={6} wrap="wrap" className={classes.summary}>
					{target && (
						<Text size="xs" c="dimmed" component="span">
							{t(TARGET_LABEL_KEY[target.type])}
						</Text>
					)}
					<Text size="xs" fw={500} component="span" className={classes.preview}>
						{targetName}
					</Text>
					{target?.pattern && (
						<Code style={{ fontSize: 11 }} className={classes.preview}>
							{t("backgroundTasks.watchPattern", { pattern: target.pattern })}
						</Code>
					)}
				</Group>
				<Group gap={4} justify="flex-end" className={classes.actions}>
					{openAgent && (
						<Tooltip label={t("backgroundTasks.openAgent")}>
							<ActionIcon
								size="xs"
								variant="subtle"
								color="indigo"
								onClick={(event) => {
									event.stopPropagation();
									openAgent(target?.id as string);
								}}
							>
								<IconExternalLink size={12} />
							</ActionIcon>
						</Tooltip>
					)}
					<Badge size="xs" variant="light" color={OUTCOME_COLOR[outcome]}>
						{outcomeLabel(outcome, t)}
					</Badge>
					{task.canCancelActiveWork && (
						<ActionIcon
							size="xs"
							variant="subtle"
							color="red"
							onClick={(event) => {
								event.stopPropagation();
								onCancel(task.id);
							}}
							title={t("backgroundTasks.watchCancel")}
						>
							<IconX size={12} />
						</ActionIcon>
					)}
				</Group>
			</Box>
			{target?.timeoutMs != null && (
				<Box mt={4}>
					<WatchDeadline
						timeoutMs={target.timeoutMs}
						startedAt={task.startedAt}
						watching={watching}
					/>
				</Box>
			)}
			{output && expanded ? (
				renderOutput ? (
					<Box mt={4} data-watch-output>
						{renderOutput(task)}
					</Box>
				) : (
					<Code
						block
						mt={4}
						data-watch-output
						style={{ fontSize: 11, maxHeight: 240, overflow: "auto" }}
					>
						{output}
					</Code>
				)
			) : (
				preview && (
					<Text size="xs" c="dimmed" mt={4} lineClamp={2} className={classes.preview}>
						{preview}
					</Text>
				)
			)}
		</Box>
	);
}
