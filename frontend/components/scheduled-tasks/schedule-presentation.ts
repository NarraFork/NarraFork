import type { ScheduledTask } from "@frontend/lib/api/scheduled-tasks";
import { formatLocaleDateTime } from "@frontend/lib/intl-format";
import type { TaskSchedule } from "@shared/scheduled-task-schedule";
import { scheduleFromLegacyCron } from "@shared/scheduled-task-schedule";

type Translate = (key: string, options?: Record<string, unknown>) => string;
export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export function taskSchedule(task: Pick<ScheduledTask, "schedule" | "cronExpr">): TaskSchedule {
	return task.schedule ?? scheduleFromLegacyCron(task.cronExpr);
}

/** Wall values stay strings: never let the browser reinterpret them in its own timezone. */
export function pickerToWall(value: string | null): string {
	return value ? value.replace(" ", "T").slice(0, 16) : "";
}
export function wallToPicker(value: string | null | undefined): string | null {
	return value ? `${value.replace("T", " ").slice(0, 16)}:00` : null;
}

export function scheduleSummary(schedule: TaskSchedule, t: Translate): string {
	if (schedule.kind === "at") {
		return schedule.times.length === 1
			? t("summary.atOne", { time: schedule.times[0].replace("T", " ") })
			: t("summary.atMany", { count: schedule.times.length });
	}
	let main: string;
	if (schedule.kind === "cron") main = t("summary.cron", { expr: schedule.expr });
	else {
		const rule = schedule.rule;
		const values = { interval: rule.interval, times: "times" in rule ? rule.times.join(", ") : "" };
		if (rule.unit === "week")
			main = t("summary.week", {
				...values,
				days: rule.weekdays.map((day) => t(WEEKDAY_KEYS[day])).join(", "),
			});
		else if (rule.unit === "month")
			main = t("summary.month", {
				...values,
				days: rule.monthDays.map((day) => (day === "last" ? t("lastDay") : String(day))).join(", "),
			});
		else
			main = t(`summary.${rule.unit}`, {
				...values,
				minute: rule.unit === "hour" ? String(rule.minute).padStart(2, "0") : "",
			});
	}
	if (schedule.startAt)
		main += ` · ${t("summary.starts", { time: schedule.startAt.replace("T", " ") })}`;
	if (schedule.end.type === "count")
		main += ` · ${t("summary.count", { count: schedule.end.count })}`;
	if (schedule.end.type === "until")
		main += ` · ${t("summary.until", { time: schedule.end.until.replace("T", " ") })}`;
	return main;
}

export function scheduleProgress(
	task: Pick<ScheduledTask, "schedule" | "cronExpr" | "firedCount">,
	t: Translate,
) {
	const schedule = taskSchedule(task);
	const total =
		schedule.kind === "at"
			? schedule.times.length
			: schedule.end.type === "count"
				? schedule.end.count
				: null;
	return total === null
		? t("progressOpen", { count: task.firedCount })
		: t("progressFinite", {
				count: task.firedCount,
				total,
				remaining: Math.max(0, total - task.firedCount),
			});
}

export function formatTaskTime(value: string, timezone: string | null, locale?: string) {
	return formatLocaleDateTime(value, timezone ? { timeZone: timezone } : undefined, locale);
}
