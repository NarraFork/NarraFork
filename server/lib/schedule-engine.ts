/**
 * schedule-engine.ts — turning a task's schedule into moments in time.
 *
 * Everything here is a pure function of (schedule, timezone, a reference instant, how many
 * occurrences were already consumed). It reads no clock and no database, so the scheduler,
 * the preview shown while a schedule is being edited, and the tool that lets a model
 * create a task all ask the same code and get the same answer.
 *
 * WHO DOES THE CALENDAR ARITHMETIC
 * --------------------------------
 * croner. Wall-clock rules ("09:00 every day", "the last day of the month") go through it
 * so there is one opinion about DST: a time that does not exist on the night the clocks go
 * forward is shifted past the gap, and one that occurs twice fires on its first pass.
 * Converting a typed date-time to an instant uses croner's one-shot form for the same
 * reason — a second, hand-rolled conversion could disagree with the first by an hour on
 * exactly the two days a year nobody tests.
 *
 * What croner cannot express is done here:
 *
 *   - fixed intervals. A cron step restarts at the top of every hour, so "every 7
 *     minutes" written as a step fires at :56 and again at :00. A real interval is plain
 *     arithmetic from an anchor.
 *   - "every N days/weeks/months" for N > 1. Cron has no memory of which week it is, so
 *     candidates are taken from the every-period pattern and kept only when their period
 *     number, counted from the anchor's, is a multiple of N.
 *
 * BOUNDED BY CONSTRUCTION
 * -----------------------
 * This runs on the server's only thread. Nothing loops over occurrences without a cap, and
 * a long stretch of fixed-interval occurrences is counted by division rather than walked.
 */

import {
	type RepeatSchedule,
	ruleCronPatterns,
	type TaskSchedule,
	type WallDateTime,
} from "@shared/scheduled-task-schedule";
import { zonedParts } from "@shared/usage-time-zone";
import { Cron } from "croner";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Period skips tried before giving up on an "every N periods" rule. Each skip lands on the
 * start of a matching period, so two or three settle any real rule; the cap only stops a
 * rule that can never match (the 31st, every 2 months, anchored on a 30-day month's pair)
 * from spinning.
 */
const MAX_PERIOD_JUMPS = 64;
/** Occurrences walked to find when a count-limited schedule ends. */
const MAX_END_SCAN = 400;

export const PREVIEW_DEFAULT_COUNT = 5;
export const PREVIEW_MAX_COUNT = 20;
/** Occurrences counted one by one between two instants before the count is reported as capped. */
export const COUNT_BETWEEN_DEFAULT_CAP = 1000;

/** The IANA name to hand to `Intl`: the task's zone, or the process's when it has none. */
export function resolveTimeZone(timezone: string | null | undefined): string {
	return timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isValidTimeZone(timezone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
		return true;
	} catch {
		return false;
	}
}

/**
 * One evaluation's scratch state: the zone, and the patterns already parsed.
 *
 * Scoped to a call rather than module-wide so that a stream of distinct expressions from
 * the preview endpoint cannot grow a cache without limit.
 */
interface EngineContext {
	zone: string;
	cron(pattern: string): Cron;
	instant(wall: WallDateTime): Date | null;
}

function createContext(timezone: string | null | undefined): EngineContext {
	const options = timezone?.trim() ? { timezone: timezone.trim() } : undefined;
	const crons = new Map<string, Cron>();
	const instants = new Map<string, Date | null>();
	return {
		zone: resolveTimeZone(timezone),
		cron(pattern) {
			let cron = crons.get(pattern);
			if (!cron) {
				cron = new Cron(pattern, options);
				crons.set(pattern, cron);
			}
			return cron;
		},
		instant(wall) {
			if (instants.has(wall)) return instants.get(wall) ?? null;
			let at: Date | null = null;
			try {
				// A one-shot pattern yields its own instant when asked for the run after the epoch.
				at = new Cron(`${wall}:00`, options).nextRun(new Date(0)) ?? null;
			} catch {
				at = null;
			}
			instants.set(wall, at);
			return at;
		},
	};
}

/** A wall-clock date-time as an instant in the given zone; null when it cannot be read. */
export function wallToInstant(
	wall: WallDateTime,
	timezone: string | null | undefined,
): Date | null {
	return createContext(timezone).instant(wall);
}

function mod(value: number, divisor: number): number {
	return ((value % divisor) + divisor) % divisor;
}

function pad(value: number, width = 2): string {
	return String(value).padStart(width, "0");
}

/** Days since the epoch of a local calendar date, as a plain day count. */
function localDayNumber(instant: Date, zone: string): number {
	const parts = zonedParts(instant, zone);
	return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS);
}

type PeriodUnit = "day" | "week" | "month";

/**
 * Which day, week or month an instant falls in, as a number that increases by one per
 * period. Weeks start on Monday: day 4 of the epoch (1970-01-05) was one, hence the shift.
 */
function periodIndex(unit: PeriodUnit, instant: Date, zone: string): number {
	if (unit === "month") {
		const parts = zonedParts(instant, zone);
		return parts.year * 12 + (parts.month - 1);
	}
	const day = localDayNumber(instant, zone);
	return unit === "day" ? day : Math.floor((day - 4) / 7);
}

/** The first instant of the period `ahead` periods after the one `instant` falls in. */
function periodStart(
	ctx: EngineContext,
	unit: PeriodUnit,
	instant: Date,
	ahead: number,
): Date | null {
	const parts = zonedParts(instant, ctx.zone);
	let start: Date;
	if (unit === "month") {
		start = new Date(Date.UTC(parts.year, parts.month - 1 + ahead, 1));
	} else {
		const today = Date.UTC(parts.year, parts.month - 1, parts.day);
		// getUTCDay: 0 = Sunday. Days since this week's Monday.
		const sinceMonday = unit === "week" ? (new Date(today).getUTCDay() + 6) % 7 : 0;
		const span = unit === "week" ? 7 : 1;
		start = new Date(today + (ahead * span - sinceMonday) * DAY_MS);
	}
	const wall = `${pad(start.getUTCFullYear(), 4)}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}T00:00`;
	return ctx.instant(wall);
}

/** The first multiple of `intervalMs` from `anchorMs` that is strictly after `after`. */
function nextFixed(anchorMs: number, intervalMs: number, after: Date): Date {
	const steps = Math.floor((after.getTime() - anchorMs) / intervalMs) + 1;
	return new Date(anchorMs + steps * intervalMs);
}

function anchorOf(schedule: RepeatSchedule): number {
	const parsed = schedule.anchorAt ? Date.parse(schedule.anchorAt) : 0;
	// Whole minutes only: an anchor carrying seconds would fire every occurrence off the minute.
	return Math.floor((Number.isNaN(parsed) ? 0 : parsed) / MINUTE_MS) * MINUTE_MS;
}

/**
 * The fixed interval of a rule and the anchor it is measured from, or null when the rule
 * is a wall-clock one. Hourly rules with an interval of one are wall-clock too: "at :15
 * every hour" should stay at :15 across a half-hour DST shift, which arithmetic would not.
 */
function fixedInterval(
	ctx: EngineContext,
	schedule: RepeatSchedule,
): { anchorMs: number; intervalMs: number } | null {
	const { rule } = schedule;
	const anchorMs = anchorOf(schedule);
	if (rule.unit === "minute") return { anchorMs, intervalMs: rule.interval * MINUTE_MS };
	if (rule.unit !== "hour" || rule.interval === 1) return null;
	// Slide the anchor onto the rule's minute as the task's zone reads it, so a zone with a
	// half-hour offset still fires at the minute that was asked for.
	const anchorMinute = zonedParts(new Date(anchorMs), ctx.zone).minute;
	return {
		anchorMs: anchorMs + (rule.minute - anchorMinute) * MINUTE_MS,
		intervalMs: rule.interval * HOUR_MS,
	};
}

function nextRepeat(ctx: EngineContext, schedule: RepeatSchedule, after: Date): Date | null {
	const { rule } = schedule;
	const fixed = fixedInterval(ctx, schedule);
	if (fixed) return nextFixed(fixed.anchorMs, fixed.intervalMs, after);
	if (rule.unit === "minute") return null;
	if (rule.unit === "hour") return ctx.cron(`${rule.minute} * * * *`).nextRun(after);

	const patterns = ruleCronPatterns(rule).map((pattern) => ctx.cron(pattern));
	const candidateAfter = (cursor: Date): Date | null => {
		let best: Date | null = null;
		for (const pattern of patterns) {
			const next = pattern.nextRun(cursor);
			if (next && (!best || next.getTime() < best.getTime())) best = next;
		}
		return best;
	};
	if (rule.interval === 1) return candidateAfter(after);

	const anchorIndex = periodIndex(rule.unit, new Date(anchorOf(schedule)), ctx.zone);
	let cursor = after;
	for (let jump = 0; jump < MAX_PERIOD_JUMPS; jump++) {
		const candidate = candidateAfter(cursor);
		if (!candidate) return null;
		const offset = mod(periodIndex(rule.unit, candidate, ctx.zone) - anchorIndex, rule.interval);
		if (offset === 0) return candidate;
		// Not this period: resume just before the next one that counts.
		const start = periodStart(ctx, rule.unit, candidate, rule.interval - offset);
		cursor =
			start && start.getTime() - 1 > candidate.getTime()
				? new Date(start.getTime() - 1)
				: candidate;
	}
	return null;
}

function nextWith(
	ctx: EngineContext,
	schedule: TaskSchedule,
	after: Date,
	firedCount: number,
): Date | null {
	if (schedule.kind === "at") {
		let best: Date | null = null;
		for (const wall of schedule.times) {
			const at = ctx.instant(wall);
			if (!at || at.getTime() <= after.getTime()) continue;
			if (!best || at.getTime() < best.getTime()) best = at;
		}
		return best;
	}
	if (schedule.end.type === "count" && firedCount >= schedule.end.count) return null;
	let lower = after;
	if (schedule.startAt) {
		const start = ctx.instant(schedule.startAt);
		if (!start) return null;
		// An occurrence exactly at the start counts, so the bound sits one millisecond before it.
		if (start.getTime() - 1 > lower.getTime()) lower = new Date(start.getTime() - 1);
	}
	const candidate =
		schedule.kind === "cron"
			? ctx.cron(schedule.expr).nextRun(lower)
			: nextRepeat(ctx, schedule, lower);
	if (!candidate) return null;
	if (schedule.end.type === "until") {
		const until = ctx.instant(schedule.end.until);
		if (!until || candidate.getTime() > until.getTime()) return null;
	}
	return candidate;
}

export interface OccurrenceInput {
	schedule: TaskSchedule;
	timezone?: string | null;
	/** The result is strictly after this instant. */
	after: Date;
	/** Scheduled occurrences of this series already consumed, for a count-limited end. */
	firedCount?: number;
}

/**
 * The next time the schedule fires, or null when it never will again.
 *
 * Null covers both "ran out" and "cannot be evaluated" (an unparseable expression, an
 * unknown timezone). Callers that need to tell those apart validate first with
 * `checkSchedule`; the scheduler itself wants exactly this — a task that cannot be
 * evaluated must not fire.
 */
export function nextOccurrence(input: OccurrenceInput): Date | null {
	try {
		return nextWith(
			createContext(input.timezone),
			input.schedule,
			input.after,
			input.firedCount ?? 0,
		);
	} catch {
		return null;
	}
}

export interface SchedulePreview {
	/** The next few occurrences, ISO instants, soonest first. */
	occurrences: string[];
	/** Whether the schedule runs out by itself. */
	finite: boolean;
	/** Occurrences in the whole series, when the schedule states one. */
	total: number | null;
	/** Occurrences still to come, when that is knowable without walking them. */
	remaining: number | null;
	/** When the series stops: its last occurrence, or its `until`. Null if open-ended or far off. */
	endsAt: string | null;
	/** Nothing will fire after `from`. */
	exhausted: boolean;
}

export function previewOccurrences(
	schedule: TaskSchedule,
	timezone: string | null | undefined,
	options: { from?: Date; count?: number; firedCount?: number } = {},
): SchedulePreview {
	const from = options.from ?? new Date();
	const fired = options.firedCount ?? 0;
	const wanted = Math.min(Math.max(options.count ?? PREVIEW_DEFAULT_COUNT, 1), PREVIEW_MAX_COUNT);
	const empty: SchedulePreview = {
		occurrences: [],
		finite: schedule.kind === "at" || schedule.end.type !== "never",
		total: null,
		remaining: null,
		endsAt: null,
		exhausted: true,
	};
	let ctx: EngineContext;
	try {
		ctx = createContext(timezone);
	} catch {
		return empty;
	}
	const walk = (limit: number): Date[] => {
		const found: Date[] = [];
		let cursor = from;
		try {
			while (found.length < limit) {
				const next = nextWith(ctx, schedule, cursor, fired + found.length);
				if (!next) break;
				found.push(next);
				cursor = next;
			}
		} catch {
			// An expression that stops parsing mid-walk yields what was found so far.
		}
		return found;
	};

	const upcoming = walk(wanted);
	const preview: SchedulePreview = {
		...empty,
		occurrences: upcoming.map((at) => at.toISOString()),
		exhausted: upcoming.length === 0,
	};
	if (schedule.kind === "at") {
		const instants = schedule.times
			.map((wall) => ctx.instant(wall))
			.filter((at): at is Date => at !== null);
		preview.total = schedule.times.length;
		preview.remaining = instants.filter((at) => at.getTime() > from.getTime()).length;
		const last = instants.reduce<Date | null>(
			(latest, at) => (!latest || at.getTime() > latest.getTime() ? at : latest),
			null,
		);
		preview.endsAt = last?.toISOString() ?? null;
		return preview;
	}
	if (schedule.end.type === "until") {
		preview.endsAt = ctx.instant(schedule.end.until)?.toISOString() ?? null;
		return preview;
	}
	if (schedule.end.type === "count") {
		preview.total = schedule.end.count;
		preview.remaining = Math.max(0, schedule.end.count - fired);
		if (preview.remaining > 0 && preview.remaining <= MAX_END_SCAN) {
			const all = preview.remaining <= upcoming.length ? upcoming : walk(preview.remaining);
			// A start or until bound can end the series before the count does.
			if (all.length === preview.remaining) {
				preview.endsAt = all[all.length - 1]?.toISOString() ?? null;
			}
		}
	}
	return preview;
}

export interface OccurrenceCount {
	count: number;
	first: string | null;
	last: string | null;
	/** The walk stopped at the cap; there may be more in the range. */
	capped: boolean;
}

/**
 * How many occurrences fall in `(after, until]`.
 *
 * For recording what a task missed while the server was down, where the range can be a
 * week and the schedule "every minute". Fixed intervals are counted by division; anything
 * else is walked up to `cap` and reports whether it stopped early, so a caller never
 * mistakes a truncated count for the real one.
 */
export function countOccurrencesBetween(input: {
	schedule: TaskSchedule;
	timezone?: string | null;
	after: Date;
	until: Date;
	firedCount?: number;
	cap?: number;
}): OccurrenceCount {
	const none: OccurrenceCount = { count: 0, first: null, last: null, capped: false };
	const { schedule, after, until } = input;
	if (until.getTime() <= after.getTime()) return none;
	const fired = input.firedCount ?? 0;
	const cap = Math.max(1, input.cap ?? COUNT_BETWEEN_DEFAULT_CAP);
	try {
		const ctx = createContext(input.timezone);
		const first = nextWith(ctx, schedule, after, fired);
		if (!first || first.getTime() > until.getTime()) return none;

		const fixed = schedule.kind === "repeat" ? fixedInterval(ctx, schedule) : null;
		if (schedule.kind === "repeat" && fixed) {
			let limit = until.getTime();
			if (schedule.end.type === "until") {
				const end = ctx.instant(schedule.end.until);
				if (end) limit = Math.min(limit, end.getTime());
			}
			let count = Math.floor((limit - first.getTime()) / fixed.intervalMs) + 1;
			if (schedule.end.type === "count") count = Math.min(count, schedule.end.count - fired);
			count = Math.max(count, 1);
			return {
				count,
				first: first.toISOString(),
				last: new Date(first.getTime() + (count - 1) * fixed.intervalMs).toISOString(),
				capped: false,
			};
		}

		let count = 1;
		let last = first;
		while (count < cap) {
			const next = nextWith(ctx, schedule, last, fired + count);
			if (!next || next.getTime() > until.getTime()) {
				return { count, first: first.toISOString(), last: last.toISOString(), capped: false };
			}
			count++;
			last = next;
		}
		const beyond = nextWith(ctx, schedule, last, fired + count);
		return {
			count,
			first: first.toISOString(),
			last: last.toISOString(),
			capped: beyond !== null && beyond.getTime() <= until.getTime(),
		};
	} catch {
		return none;
	}
}

export type ScheduleCheckCode =
	| "invalid_timezone"
	| "invalid_cron"
	| "invalid_datetime"
	| "never_fires"
	| "too_frequent";

export type ScheduleCheck = { ok: true } | { ok: false; code: ScheduleCheckCode; path: string };

/**
 * Check what `parseSchedule` cannot: that the timezone exists, that the expression and the
 * dates mean something in it, that the schedule fires at least once more, and that it does
 * not fire more often than allowed.
 *
 * `minIntervalMs` compares the next two occurrences. That is a sample rather than a proof —
 * a cron expression can have one short gap a year — but it is the gap that matters for
 * load, and it is what a schedule submitted by a model in a retry loop will trip.
 */
export function checkSchedule(
	schedule: TaskSchedule,
	timezone: string | null | undefined,
	options: { now?: Date; minIntervalMs?: number; requireFuture?: boolean } = {},
): ScheduleCheck {
	const zone = timezone?.trim();
	if (zone && !isValidTimeZone(zone))
		return { ok: false, code: "invalid_timezone", path: "timezone" };
	const ctx = createContext(zone);
	if (schedule.kind === "at") {
		for (const [index, wall] of schedule.times.entries()) {
			if (!ctx.instant(wall))
				return { ok: false, code: "invalid_datetime", path: `times.${index}` };
		}
	} else {
		if (schedule.startAt && !ctx.instant(schedule.startAt)) {
			return { ok: false, code: "invalid_datetime", path: "startAt" };
		}
		if (schedule.end.type === "until" && !ctx.instant(schedule.end.until)) {
			return { ok: false, code: "invalid_datetime", path: "end.until" };
		}
		if (schedule.kind === "cron") {
			try {
				ctx.cron(schedule.expr);
			} catch {
				return { ok: false, code: "invalid_cron", path: "expr" };
			}
		}
	}

	const now = options.now ?? new Date();
	let first: Date | null;
	try {
		first = nextWith(ctx, schedule, now, 0);
	} catch {
		return {
			ok: false,
			code: schedule.kind === "cron" ? "invalid_cron" : "never_fires",
			path: schedule.kind === "cron" ? "expr" : "",
		};
	}
	if (!first) {
		return options.requireFuture === false
			? { ok: true }
			: { ok: false, code: "never_fires", path: "" };
	}
	if (options.minIntervalMs && schedule.kind !== "at") {
		const second = nextWith(ctx, schedule, first, 1);
		if (second && second.getTime() - first.getTime() < options.minIntervalMs) {
			return { ok: false, code: "too_frequent", path: schedule.kind === "cron" ? "expr" : "rule" };
		}
	}
	return { ok: true };
}

/**
 * The alignment instant for a schedule being saved: local midnight of the day it starts
 * (its `startAt`, else today) in the task's zone.
 *
 * Midnight rather than "now" so that round intervals land on round times — every 30
 * minutes fires on the hour and the half hour, not at :07 and :37 because that was when
 * someone pressed save — and so that "every 2 weeks" counts from a week boundary people
 * can reason about.
 */
export function defaultAnchor(
	timezone: string | null | undefined,
	now: Date,
	startAt?: WallDateTime | null,
): string {
	const ctx = createContext(timezone);
	const day = startAt
		? startAt.slice(0, 10)
		: (() => {
				const parts = zonedParts(now, ctx.zone);
				return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
			})();
	const midnight = ctx.instant(`${day}T00:00`);
	// A zone without a midnight that day falls back to the reference instant, floored.
	const base = midnight ?? new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS);
	return base.toISOString();
}
