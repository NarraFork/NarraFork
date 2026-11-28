import type { PendingPermission } from "@frontend/types/narrator";
import { Alert, Badge, Group, Paper, Stack, Text } from "@mantine/core";
import { parseSchedule } from "@shared/scheduled-task-schedule";
import { useTranslation } from "react-i18next";
import { formatTaskTime, scheduleSummary } from "../../scheduled-tasks/schedule-presentation";

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Only the server-resolved preview is presented as an approval, never model-authored hints. */
export function scheduledTaskApprovalView(
	permission: Pick<PendingPermission, "toolName" | "inputJson">,
) {
	if (permission.toolName !== "ScheduledTask") return null;
	const raw = record(record(permission.inputJson)?._scheduledTaskApproval);
	const task = record(raw?.task);
	if (raw?.version !== 1 || !task || typeof task.timezone !== "string") return null;
	const parsed = parseSchedule(task.schedule);
	if (!parsed.ok) return null;
	return {
		task,
		schedule: parsed.schedule,
		timezone: task.timezone,
		action: typeof raw.action === "string" ? raw.action : "update",
		elevated: raw.elevated === true,
		outsideScope: raw.outsideScope === true,
		before: record(raw.before),
		target: record(raw.target),
		beforeTarget: record(raw.beforeTarget),
		inheritedFields: Array.isArray(raw.inheritedFields)
			? raw.inheritedFields.filter((key): key is string => typeof key === "string").slice(0, 30)
			: [],
		changed: Array.isArray(raw.changed)
			? raw.changed.filter((key): key is string => typeof key === "string").slice(0, 30)
			: [],
		occurrences: Array.isArray(raw.occurrences)
			? raw.occurrences.filter((time): time is string => typeof time === "string").slice(0, 20)
			: [],
		exhausted: raw.exhausted === true,
	};
}

function display(value: unknown): string {
	if (value === undefined || value === null || value === "") return "—";
	return typeof value === "string" ? value : JSON.stringify(value);
}

export function ScheduledTaskApproval({ permission }: { permission: PendingPermission }) {
	const { t, i18n } = useTranslation("narrator");
	const { t: ts } = useTranslation("scheduledTasks");
	const view = scheduledTaskApprovalView(permission);
	if (!view)
		return (
			<Alert color="red" mb="xs">
				{t("scheduledTaskApproval.unavailable")}
			</Alert>
		);
	const { task, schedule, timezone } = view;
	const field = (key: string) => t(`scheduledTaskApproval.fields.${key}`, { defaultValue: key });
	const value = (key: string, item: unknown, before = false) => {
		if (key === "targetNarratorId") {
			const target = before ? view.beforeTarget : view.target;
			return target && target.id === item
				? `${display(target.title)} · ${display(item)}`
				: display(item);
		}
		if (key === "requireReport" && typeof item === "boolean") return ts(item ? "yes" : "no");
		if (key === "onBusy" && typeof item === "string") return ts(`busyPolicy.${item}`);
		if (key === "contextPolicy" && typeof item === "string") return ts(`context.${item}`);
		if (key === "schedule") {
			const parsed = parseSchedule(item);
			if (parsed.ok) return scheduleSummary(parsed.schedule, ts);
		}
		if (
			typeof item === "string" &&
			["permissionMode", "modelPolicy", "onBlocked", "runContext", "narratorMode"].includes(key)
		)
			return t(`scheduledTaskApproval.values.${item}`, { defaultValue: item });
		return display(item);
	};
	return (
		<Paper withBorder p="sm" mb="xs" radius="sm">
			<Stack gap="xs" style={{ overflowWrap: "anywhere" }}>
				<Group gap="xs">
					<Text fw={600}>{t("scheduledTaskApproval.title")}</Text>
					<Badge>
						{t(`scheduledTaskApproval.actions.${view.action}`, { defaultValue: view.action })}
					</Badge>
				</Group>
				<Text fw={600}>{display(task.name)}</Text>
				{view.target && (
					<Text size="sm">
						{field("targetNarratorId")}: {display(view.target.title)} · {display(view.target.id)}
					</Text>
				)}
				{view.inheritedFields.length > 0 && (
					<Text size="xs" c="dimmed">
						{t("scheduledTaskApproval.inherited", {
							fields: view.inheritedFields.map(field).join("、"),
						})}
					</Text>
				)}
				{task.contextPolicy === "clear" && (
					<Alert color="orange">{ts("contextClearWarning")}</Alert>
				)}
				{task.onBusy === "interrupt" && <Alert color="orange">{ts("busyInterruptWarning")}</Alert>}
				{view.elevated && (
					<Alert color="red" title={t("scheduledTaskApproval.elevatedTitle")}>
						{t("scheduledTaskApproval.elevated")}
					</Alert>
				)}
				{view.outsideScope && (
					<Alert color="orange">{t("scheduledTaskApproval.outsideScope")}</Alert>
				)}
				<Text size="sm">{scheduleSummary(schedule, ts)}</Text>
				{schedule.kind === "at" &&
					schedule.times.map((time) => (
						<Text size="xs" key={time}>
							{time.replace("T", " ")}
						</Text>
					))}
				{schedule.kind !== "at" && schedule.end.type === "never" && (
					<Text size="xs">{t("scheduledTaskApproval.noEnd")}</Text>
				)}
				<Text size="sm">
					{field("timezone")}: {timezone}
				</Text>
				<Text size="xs" fw={600}>
					{t("scheduledTaskApproval.nextRuns")}
				</Text>
				{view.occurrences.map((time) => (
					<Text size="xs" key={time}>
						{formatTaskTime(time, timezone, i18n.language)}
					</Text>
				))}
				{!view.occurrences.length && (
					<Text size="xs" c="dimmed">
						{t("scheduledTaskApproval.exhausted")}
					</Text>
				)}
				{[
					"cwd",
					"projectId",
					"runContext",
					"narratorMode",
					"targetNarratorId",
					"contextPolicy",
					"onBusy",
					"busyWaitMinutes",
					"requireReport",
					"permissionMode",
					"model",
					"modelPolicy",
					"onBlocked",
					"blockedWaitMinutes",
					"maxRunMinutes",
				].map((key) => (
					<Text size="xs" key={key}>
						{field(key)}: {value(key, task[key])}
						{view.inheritedFields.includes(key)
							? ` · ${t("scheduledTaskApproval.inheritedValue")}`
							: ""}
					</Text>
				))}
				{view.before && view.changed.length > 0 && (
					<details>
						<summary>{t("scheduledTaskApproval.changes")}</summary>
						<Stack gap="xs" mt="xs">
							{view.changed.map((key) => (
								<div key={key}>
									<Text size="xs" fw={600}>
										{field(key)}
									</Text>
									<Text size="xs" style={{ whiteSpace: "pre-wrap" }}>
										{t("scheduledTaskApproval.before")}: {value(key, view.before?.[key], true)}
									</Text>
									<Text size="xs" style={{ whiteSpace: "pre-wrap" }}>
										{t("scheduledTaskApproval.after")}: {value(key, task[key])}
									</Text>
								</div>
							))}
						</Stack>
					</details>
				)}
				{["prompt", "systemPrompt"].map((key) =>
					task[key] && !view.inheritedFields.includes(key) ? (
						<details key={key}>
							<summary>{field(key)}</summary>
							<Text size="xs" style={{ whiteSpace: "pre-wrap" }}>
								{display(task[key])}
							</Text>
						</details>
					) : null,
				)}
				<Text size="xs" c="dimmed">
					{t("scheduledTaskApproval.notice")}
				</Text>
			</Stack>
		</Paper>
	);
}
