/**
 * scheduled-task-schedule.ts — when a scheduled task fires.
 *
 * One schedule is exactly one of three shapes, chosen to match how people think about
 * recurrence in a calendar rather than how cron spells it:
 *
 *   - `at`      a short list of specific date-times, each fired once;
 *   - `repeat`  a rule ("every 2 weeks on Mon, Wed at 07:00") plus an end condition;
 *   - `cron`    a raw expression, the escape hatch for what the rule cannot say.
 *
 * WALL-CLOCK STRINGS, NOT INSTANTS
 * --------------------------------
 * Every date/time a person enters is stored as wall-clock text (`2026-11-23T08:00`,
 * `07:00`) and interpreted in the task's timezone when the schedule is evaluated. Storing
 * instants instead would freeze the UTC offset of the day the task was saved, so "every
 * day at 09:00" would drift by an hour across a DST change — the bug this representation
 * exists to make impossible. The one instant in here is `anchorAt`, which is alignment
 * for fixed intervals and is written by the server, never typed by anyone.
 *
 * This module is structural only: shapes, ranges, normalization, and conversions that need
 * no clock and no timezone database. Anything that has to know what time it is, or what a
 * cron expression means, lives in `server/lib/schedule-engine.ts`.
 */

export const SCHEDULE_KINDS = ["at", "repeat", "cron"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** Wall-clock date-time in the task's timezone: `YYYY-MM-DDTHH:mm`. */
export type WallDateTime = string;
/** Wall-clock time of day in the task's timezone: `HH:mm`. */
export type WallTime = string;

export type ScheduleEnd =
	| { type: "never" }
	/** Total scheduled occurrences. Missed and failed ones count too. */
	| { type: "count"; count: number }
	/** Inclusive: an occurrence exactly at `until` still fires. */
	| { type: "until"; until: WallDateTime };

export type RepeatRule =
	/** A fixed interval measured from the schedule's anchor. */
	| { unit: "minute"; interval: number }
	/** Every N hours, at this minute of the hour. */
	| { unit: "hour"; interval: number; minute: number }
	| { unit: "day"; interval: number; times: WallTime[] }
	/** `weekdays`: 0 = Sunday … 6 = Saturday. */
	| { unit: "week"; interval: number; weekdays: number[]; times: WallTime[] }
	| { unit: "month"; interval: number; monthDays: MonthDay[]; times: WallTime[] };

export type RepeatUnit = RepeatRule["unit"];
/** A day of the month, or the last one whatever its number. */
export type MonthDay = number | "last";

export interface AtSchedule {
	kind: "at";
	times: WallDateTime[];
}

export interface RepeatSchedule {
	kind: "repeat";
	rule: RepeatRule;
	/** No occurrence before this wall-clock moment. */
	startAt?: WallDateTime | null;
	end: ScheduleEnd;
	/**
	 * Alignment instant (ISO). Fixed intervals are measured from it, and "every N
	 * days/weeks/months" counts its periods from the one this falls in. Written by the
	 * server when a schedule is saved, so that editing an unrelated field never shifts
	 * a running cadence.
	 */
	anchorAt?: string;
}

export interface CronSchedule {
	kind: "cron";
	expr: string;
	startAt?: WallDateTime | null;
	end: ScheduleEnd;
}

export type TaskSchedule = AtSchedule | RepeatSchedule | CronSchedule;

export const SCHEDULE_LIMITS = {
	/** Specific date-times in one `at` schedule. */
	maxAtTimes: 50,
	/** Times of day in one day/week/month rule. */
	maxTimesOfDay: 24,
	maxCount: 10_000,
	maxCronLength: 200,
	interval: {
		minute: 1440,
		hour: 168,
		day: 365,
		week: 52,
		month: 24,
	},
} as const;

export type ScheduleIssueCode =
	| "invalid_shape"
	| "invalid_kind"
	| "empty_times"
	| "too_many_times"
	| "invalid_datetime"
	| "invalid_time"
	| "invalid_interval"
	| "invalid_minute"
	| "invalid_weekdays"
	| "invalid_month_days"
	| "invalid_end"
	| "invalid_count"
	| "invalid_start"
	| "end_before_start"
	| "invalid_cron"
	| "invalid_anchor";

export interface ScheduleIssue {
	code: ScheduleIssueCode;
	/** Dotted path of the offending field, e.g. `rule.times.1`. */
	path: string;
}

export type ParsedSchedule =
	| { ok: true; schedule: TaskSchedule }
	| { ok: false; issue: ScheduleIssue };

const WALL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const WALL_TIME = /^(\d{2}):(\d{2})(?::\d{2})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

/**
 * Normalize a wall-clock date-time to minute precision, or null when it is not one.
 *
 * A calendar check on top of the pattern: `2026-02-30T09:00` matches the pattern, and
 * silently accepting it would store a moment that never arrives.
 */
export function normalizeWallDateTime(value: unknown): WallDateTime | null {
	if (typeof value !== "string") return null;
	const match = WALL_DATE_TIME.exec(value.trim());
	if (!match) return null;
	const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
	if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
	// Day 0 of the next month is the last day of this one.
	const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
	if (day < 1 || day > daysInMonth) return null;
	return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}`;
}

/** Normalize a wall-clock time of day to `HH:mm`, or null when it is not one. */
export function normalizeWallTime(value: unknown): WallTime | null {
	if (typeof value !== "string") return null;
	const match = WALL_TIME.exec(value.trim());
	if (!match) return null;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour > 23 || minute > 59) return null;
	return `${pad2(hour)}:${pad2(minute)}`;
}

/** The numeric fields of a wall-clock date-time already known to be valid. */
export function wallDateTimeParts(value: WallDateTime): {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
} {
	const match = WALL_DATE_TIME.exec(value);
	if (!match) throw new RangeError(`Not a wall-clock date-time: ${value}`);
	const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
	return { year, month, day, hour, minute };
}

function fail(code: ScheduleIssueCode, path: string): ParsedSchedule {
	return { ok: false, issue: { code, path } };
}

function parseTimesOfDay(value: unknown, path: string): WallTime[] | ScheduleIssue {
	if (!Array.isArray(value) || value.length === 0) return { code: "empty_times", path };
	if (value.length > SCHEDULE_LIMITS.maxTimesOfDay) return { code: "too_many_times", path };
	const times = new Set<WallTime>();
	for (const [index, raw] of value.entries()) {
		const time = normalizeWallTime(raw);
		if (!time) return { code: "invalid_time", path: `${path}.${index}` };
		times.add(time);
	}
	return [...times].sort();
}

function parseEnd(value: unknown, path: string): ScheduleEnd | ScheduleIssue {
	// An omitted end is the common case for a plain recurring task.
	if (value === undefined || value === null) return { type: "never" };
	if (!isRecord(value)) return { code: "invalid_end", path };
	if (value.type === "never") return { type: "never" };
	if (value.type === "count") {
		if (!isIntegerIn(value.count, 1, SCHEDULE_LIMITS.maxCount)) {
			return { code: "invalid_count", path: `${path}.count` };
		}
		return { type: "count", count: value.count };
	}
	if (value.type === "until") {
		const until = normalizeWallDateTime(value.until);
		if (!until) return { code: "invalid_end", path: `${path}.until` };
		return { type: "until", until };
	}
	return { code: "invalid_end", path: `${path}.type` };
}

function isIssue(value: unknown): value is ScheduleIssue {
	return isRecord(value) && typeof value.code === "string" && typeof value.path === "string";
}

function parseRule(value: unknown): RepeatRule | ScheduleIssue {
	if (!isRecord(value)) return { code: "invalid_shape", path: "rule" };
	const unit = value.unit;
	if (
		unit !== "minute" &&
		unit !== "hour" &&
		unit !== "day" &&
		unit !== "week" &&
		unit !== "month"
	) {
		return { code: "invalid_shape", path: "rule.unit" };
	}
	// An omitted interval means "every one", which is what a person leaves unsaid.
	const interval = value.interval === undefined ? 1 : value.interval;
	if (!isIntegerIn(interval, 1, SCHEDULE_LIMITS.interval[unit])) {
		return { code: "invalid_interval", path: "rule.interval" };
	}
	if (unit === "minute") return { unit, interval };
	if (unit === "hour") {
		const minute = value.minute === undefined ? 0 : value.minute;
		if (!isIntegerIn(minute, 0, 59)) return { code: "invalid_minute", path: "rule.minute" };
		return { unit, interval, minute };
	}
	const times = parseTimesOfDay(value.times, "rule.times");
	if (isIssue(times)) return times;
	if (unit === "day") return { unit, interval, times };
	if (unit === "week") {
		if (!Array.isArray(value.weekdays) || value.weekdays.length === 0) {
			return { code: "invalid_weekdays", path: "rule.weekdays" };
		}
		const weekdays = new Set<number>();
		for (const [index, raw] of value.weekdays.entries()) {
			// Cron writes Sunday as both 0 and 7; accept either and store 0.
			if (!isIntegerIn(raw, 0, 7)) {
				return { code: "invalid_weekdays", path: `rule.weekdays.${index}` };
			}
			weekdays.add(raw % 7);
		}
		return { unit, interval, weekdays: [...weekdays].sort((a, b) => a - b), times };
	}
	if (!Array.isArray(value.monthDays) || value.monthDays.length === 0) {
		return { code: "invalid_month_days", path: "rule.monthDays" };
	}
	const days = new Set<number>();
	let last = false;
	for (const [index, raw] of value.monthDays.entries()) {
		if (raw === "last") last = true;
		else if (isIntegerIn(raw, 1, 31)) days.add(raw);
		else return { code: "invalid_month_days", path: `rule.monthDays.${index}` };
	}
	const monthDays: MonthDay[] = [...days].sort((a, b) => a - b);
	if (last) monthDays.push("last");
	return { unit, interval, monthDays, times };
}

function parseStart(value: unknown): WallDateTime | null | ScheduleIssue {
	if (value === undefined || value === null || value === "") return null;
	const start = normalizeWallDateTime(value);
	return start ?? { code: "invalid_start", path: "startAt" };
}

/**
 * Validate and normalize a schedule of unknown provenance.
 *
 * Normalizing here — sorted, de-duplicated, fixed formats — is what lets two schedules be
 * compared as text (`scheduleSignature`), which is how the service decides whether an
 * edit changed the cadence and the run count has to restart.
 *
 * Structural only: a cron expression is checked for being a short non-empty string, not
 * for meaning anything. The engine does that, with the timezone in hand.
 */
export function parseSchedule(input: unknown): ParsedSchedule {
	if (!isRecord(input)) return fail("invalid_shape", "");
	if (input.kind === "at") {
		if (!Array.isArray(input.times) || input.times.length === 0) {
			return fail("empty_times", "times");
		}
		if (input.times.length > SCHEDULE_LIMITS.maxAtTimes) return fail("too_many_times", "times");
		const times = new Set<WallDateTime>();
		for (const [index, raw] of input.times.entries()) {
			const time = normalizeWallDateTime(raw);
			if (!time) return fail("invalid_datetime", `times.${index}`);
			times.add(time);
		}
		// Fixed-width text sorts chronologically.
		return { ok: true, schedule: { kind: "at", times: [...times].sort() } };
	}
	if (input.kind !== "repeat" && input.kind !== "cron") return fail("invalid_kind", "kind");

	const startAt = parseStart(input.startAt);
	if (isIssue(startAt)) return { ok: false, issue: startAt };
	const end = parseEnd(input.end, "end");
	if (isIssue(end)) return { ok: false, issue: end };
	if (startAt && end.type === "until" && end.until < startAt) {
		return fail("end_before_start", "end.until");
	}

	if (input.kind === "cron") {
		const expr = typeof input.expr === "string" ? input.expr.trim().replace(/\s+/g, " ") : "";
		if (!expr || expr.length > SCHEDULE_LIMITS.maxCronLength) return fail("invalid_cron", "expr");
		return { ok: true, schedule: { kind: "cron", expr, startAt, end } };
	}

	const rule = parseRule(input.rule);
	if (isIssue(rule)) return { ok: false, issue: rule };
	let anchorAt: string | undefined;
	if (input.anchorAt !== undefined && input.anchorAt !== null) {
		const parsed = typeof input.anchorAt === "string" ? Date.parse(input.anchorAt) : Number.NaN;
		if (Number.isNaN(parsed)) return fail("invalid_anchor", "anchorAt");
		anchorAt = new Date(parsed).toISOString();
	}
	return {
		ok: true,
		schedule: { kind: "repeat", rule, startAt, end, ...(anchorAt ? { anchorAt } : {}) },
	};
}

/** Whether the schedule runs out by itself. Only these can ever be "ended". */
export function isFiniteSchedule(schedule: TaskSchedule): boolean {
	return schedule.kind === "at" || schedule.end.type !== "never";
}

/**
 * The cadence of a schedule as comparable text, ignoring `anchorAt`.
 *
 * The anchor is excluded on purpose: it is derived state the server rewrites, and counting
 * it as a change would restart the run count every time anything was saved.
 */
export function scheduleSignature(schedule: TaskSchedule): string {
	if (schedule.kind !== "repeat") return JSON.stringify(schedule);
	const { anchorAt: _anchor, ...cadence } = schedule;
	return JSON.stringify(cadence);
}

function cronTime(time: WallTime): { hour: number; minute: number } {
	const [hour, minute] = time.split(":").map(Number);
	return { hour, minute };
}

/**
 * The cron patterns whose union is a day/week/month rule's time-of-day candidates.
 *
 * One pattern per time of day rather than one pattern with hour and minute lists: cron
 * takes the cross product of its fields, so `0,30 9,14` would fire at 09:30 and 14:00 as
 * well as the two times that were asked for.
 */
export function ruleCronPatterns(
	rule: Extract<RepeatRule, { unit: "day" | "week" | "month" }>,
): string[] {
	const dayOfMonth =
		rule.unit === "month" ? rule.monthDays.map((d) => (d === "last" ? "L" : d)).join(",") : "*";
	const dayOfWeek = rule.unit === "week" ? rule.weekdays.join(",") : "*";
	return rule.times.map((time) => {
		const { hour, minute } = cronTime(time);
		return `${minute} ${hour} ${dayOfMonth} * ${dayOfWeek}`;
	});
}

/**
 * A single cron expression equal to this schedule, or null when there is none.
 *
 * Feeds the legacy `cron_expr` column, which predates structured schedules and is kept
 * so that anything still reading it sees something true. It is never read back to decide
 * when a task fires.
 */
export function scheduleToLegacyCron(schedule: TaskSchedule): string | null {
	if (schedule.kind === "cron") return schedule.expr;
	if (schedule.kind === "at") return null;
	const { rule } = schedule;
	if (rule.unit === "minute") {
		// `*/N` restarts at every hour, so it equals a fixed interval only when N divides 60.
		return 60 % rule.interval === 0 ? `*/${rule.interval} * * * *` : null;
	}
	if (rule.interval !== 1) return null;
	if (rule.unit === "hour") return `${rule.minute} * * * *`;
	const patterns = ruleCronPatterns(rule);
	return patterns.length === 1 ? patterns[0] : null;
}

/**
 * Alignment for a schedule converted from a legacy cron expression.
 *
 * A cron step of 15 minutes fires on the quarter hours. A fixed interval measured from
 * the Unix epoch lands on the same minutes in every timezone whose offset is a whole
 * number of `interval` minutes, which covers the hourly and half-hourly offsets in use.
 */
export const LEGACY_CRON_ANCHOR = "1970-01-01T00:00:00.000Z";

/**
 * Read a legacy cron expression as a structured schedule.
 *
 * Only shapes that mean EXACTLY the same thing are converted; everything else stays a
 * `cron` schedule and keeps firing as before. That is why a 7-minute step is left alone:
 * cron restarts the step at the top of each hour, a fixed 7-minute interval does not, and
 * converting it would quietly change when an existing task runs.
 */
export function scheduleFromLegacyCron(expression: string): TaskSchedule {
	const expr = expression.trim().replace(/\s+/g, " ");
	const asCron: CronSchedule = { kind: "cron", expr, startAt: null, end: { type: "never" } };
	const fields = expr.split(" ");
	if (fields.length !== 5) return asCron;
	const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
	const isNumber = (value: string) => /^\d+$/.test(value);
	const repeat = (rule: RepeatRule, anchorAt?: string): RepeatSchedule => ({
		kind: "repeat",
		rule,
		startAt: null,
		end: { type: "never" },
		...(anchorAt ? { anchorAt } : {}),
	});
	if (month !== "*" || dayOfMonth !== "*") return asCron;

	const step = /^\*\/(\d+)$/.exec(minute);
	if (step && hour === "*" && dayOfWeek === "*") {
		const interval = Number(step[1]);
		if (interval >= 1 && interval <= 59 && 60 % interval === 0) {
			return repeat({ unit: "minute", interval }, LEGACY_CRON_ANCHOR);
		}
		return asCron;
	}
	if (!isNumber(minute) || Number(minute) > 59) return asCron;
	if (hour === "*" && dayOfWeek === "*") {
		return repeat({ unit: "hour", interval: 1, minute: Number(minute) });
	}
	if (!isNumber(hour) || Number(hour) > 23) return asCron;
	const time = `${pad2(Number(hour))}:${pad2(Number(minute))}`;
	if (dayOfWeek === "*") return repeat({ unit: "day", interval: 1, times: [time] });
	if (!/^\d+(,\d+)*$/.test(dayOfWeek)) return asCron;
	const weekdays = dayOfWeek.split(",").map(Number);
	if (weekdays.some((day) => day > 7)) return asCron;
	const unique = [...new Set(weekdays.map((day) => day % 7))].sort((a, b) => a - b);
	return repeat({ unit: "week", interval: 1, weekdays: unique, times: [time] });
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function describeEnd(end: ScheduleEnd): string {
	if (end.type === "count") return `, ${end.count} time${end.count === 1 ? "" : "s"} in total`;
	if (end.type === "until") return `, until ${end.until.replace("T", " ")}`;
	return "";
}

function every(interval: number, unit: string): string {
	return interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`;
}

/**
 * A schedule in plain English.
 *
 * For text a model or a log reads — tool results, audit lines. The interface builds its
 * own wording from the structured schedule through i18n, so this is deliberately not
 * localized: one fixed rendering keeps tool output stable across the locale of whoever
 * happens to be driving the session.
 */
export function describeScheduleEn(schedule: TaskSchedule, timezone?: string | null): string {
	const zone = timezone ? ` (${timezone})` : "";
	if (schedule.kind === "at") {
		const times = schedule.times.map((time) => time.replace("T", " "));
		return `once at ${times.join(", ")}${zone}`;
	}
	const start = schedule.startAt ? `, from ${schedule.startAt.replace("T", " ")}` : "";
	const tail = `${start}${describeEnd(schedule.end)}${zone}`;
	if (schedule.kind === "cron") return `cron "${schedule.expr}"${tail}`;
	const { rule } = schedule;
	if (rule.unit === "minute") return `${every(rule.interval, "minute")}${tail}`;
	if (rule.unit === "hour") {
		return `${every(rule.interval, "hour")} at minute ${pad2(rule.minute)}${tail}`;
	}
	const at = ` at ${rule.times.join(", ")}`;
	if (rule.unit === "day") return `${every(rule.interval, "day")}${at}${tail}`;
	if (rule.unit === "week") {
		const days = rule.weekdays.map((day) => WEEKDAY_NAMES[day]).join(", ");
		return `${every(rule.interval, "week")} on ${days}${at}${tail}`;
	}
	const days = rule.monthDays.map((day) => (day === "last" ? "the last day" : day)).join(", ");
	return `${every(rule.interval, "month")} on day ${days}${at}${tail}`;
}
