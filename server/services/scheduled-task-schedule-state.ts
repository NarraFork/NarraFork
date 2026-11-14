import {
	parseSchedule,
	scheduleFromLegacyCron,
	type TaskSchedule,
} from "@shared/scheduled-task-schedule";
import { ValidationError } from "../lib/errors";
import { countOccurrencesBetween, defaultAnchor, nextOccurrence } from "../lib/schedule-engine";

export interface ScheduleState {
	schedule: TaskSchedule | null;
	cronExpr: string;
	timezone: string | null;
	createdAt: string;
	firedCount: number;
	scheduleCursorAt: string | null;
	nextRunAt: string | null;
}

/** Legacy steps stay cron: UTC anchors are not equivalent in half/quarter-hour zones. */
export function readTaskSchedule(
	task: Pick<ScheduleState, "schedule" | "cronExpr" | "timezone" | "createdAt">,
): TaskSchedule {
	const input =
		task.schedule ??
		(/^\*\/\d+ /.test(task.cronExpr.trim())
			? { kind: "cron", expr: task.cronExpr, end: { type: "never" } }
			: scheduleFromLegacyCron(task.cronExpr));
	const parsed = parseSchedule(input);
	if (!parsed.ok) throw new ValidationError(`Invalid stored schedule: ${parsed.issue.code}`);
	const schedule = parsed.schedule;
	if (schedule.kind === "repeat" && !schedule.anchorAt) {
		schedule.anchorAt = defaultAnchor(task.timezone, new Date(task.createdAt), schedule.startAt);
	}
	return schedule;
}

export function nextTaskOccurrence(task: ScheduleState, after?: Date): string | null {
	return (
		nextOccurrence({
			schedule: readTaskSchedule(task),
			timezone: task.timezone,
			after: after ?? new Date(task.scheduleCursorAt ?? task.createdAt),
			firedCount: task.firedCount,
		})?.toISOString() ?? null
	);
}

/** One bounded catch-up slice. A capped result leaves nextRunAt overdue for the next slice. */
export function missedScheduleSlice(task: ScheduleState, until: Date, cap = 128) {
	if (!task.nextRunAt || task.nextRunAt > until.toISOString()) return null;
	const schedule = readTaskSchedule(task);
	const count = countOccurrencesBetween({
		schedule,
		timezone: task.timezone,
		after: new Date(new Date(task.nextRunAt).getTime() - 1),
		until,
		firedCount: task.firedCount,
		cap,
	});
	if (!count.count || !count.last)
		throw new ValidationError("Stored schedule cannot advance from its due time");
	const firedCount = task.firedCount + count.count;
	const nextRunAt =
		nextOccurrence({
			schedule,
			timezone: task.timezone,
			after: new Date(count.last),
			firedCount,
		})?.toISOString() ?? null;
	return { ...count, firedCount, nextRunAt, scheduleCursorAt: count.last };
}
