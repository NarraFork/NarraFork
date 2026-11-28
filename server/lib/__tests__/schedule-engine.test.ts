import { describe, expect, test } from "bun:test";
import {
	LEGACY_CRON_ANCHOR,
	parseSchedule,
	type RepeatRule,
	type TaskSchedule,
} from "@shared/scheduled-task-schedule";
import {
	checkSchedule,
	countOccurrencesBetween,
	defaultAnchor,
	nextOccurrence,
	previewOccurrences,
	wallToInstant,
} from "../schedule-engine";

/**
 * Every test names its timezone. The process zone differs between a developer's machine
 * and CI, and an engine test that passes only in one of them would be worse than none.
 */
const SHANGHAI = "Asia/Shanghai";
const NEW_YORK = "America/New_York";

const iso = (value: Date | null) => value?.toISOString() ?? null;
const at = (text: string) => new Date(text);

function repeat(
	rule: RepeatRule,
	extra: Partial<Extract<TaskSchedule, { kind: "repeat" }>> = {},
): TaskSchedule {
	return { kind: "repeat", rule, startAt: null, end: { type: "never" }, ...extra };
}

/** The first `count` occurrences after `from`, as ISO instants. */
function walk(schedule: TaskSchedule, timezone: string, from: string, count: number): string[] {
	return previewOccurrences(schedule, timezone, { from: at(from), count }).occurrences;
}

describe("wall-clock conversion", () => {
	test("reads a typed date-time in the task's zone", () => {
		expect(iso(wallToInstant("2026-11-23T08:00", SHANGHAI))).toBe("2026-11-23T00:00:00.000Z");
		expect(iso(wallToInstant("2026-11-23T08:00", "UTC"))).toBe("2026-11-23T08:00:00.000Z");
	});

	test("a time inside a DST gap is shifted past it, as recurring rules are", () => {
		// 02:30 does not exist in New York on 2027-03-14; the clocks go 02:00 → 03:00.
		expect(iso(wallToInstant("2027-03-14T02:30", NEW_YORK))).toBe("2027-03-14T07:30:00.000Z");
	});

	test("a time that occurs twice resolves to its first pass", () => {
		// 01:30 happens twice on 2027-11-07; the first is still on daylight time (UTC-4).
		expect(iso(wallToInstant("2027-11-07T01:30", NEW_YORK))).toBe("2027-11-07T05:30:00.000Z");
	});

	test("an unknown zone yields nothing rather than a guess", () => {
		expect(wallToInstant("2026-11-23T08:00", "Not/AZone")).toBeNull();
	});
});

describe("specific date-times", () => {
	const schedule: TaskSchedule = {
		kind: "at",
		times: ["2026-11-23T08:00", "2026-12-01T11:00"],
	};

	test("fires each time once, soonest first", () => {
		expect(walk(schedule, SHANGHAI, "2026-11-14T00:00:00Z", 5)).toEqual([
			"2026-11-23T00:00:00.000Z",
			"2026-12-01T03:00:00.000Z",
		]);
	});

	test("is strictly after the reference instant", () => {
		const first = at("2026-11-23T00:00:00.000Z");
		expect(iso(nextOccurrence({ schedule, timezone: SHANGHAI, after: first }))).toBe(
			"2026-12-01T03:00:00.000Z",
		);
	});

	test("runs out", () => {
		expect(
			nextOccurrence({ schedule, timezone: SHANGHAI, after: at("2026-12-01T03:00:00Z") }),
		).toBeNull();
	});
});

describe("daily, weekly and monthly rules", () => {
	test("several times a day", () => {
		const schedule = repeat({ unit: "day", interval: 1, times: ["08:00", "20:30"] });
		expect(walk(schedule, SHANGHAI, "2026-11-14T00:00:00Z", 3)).toEqual([
			"2026-11-14T12:30:00.000Z",
			"2026-11-15T00:00:00.000Z",
			"2026-11-15T12:30:00.000Z",
		]);
	});

	test("the times asked for, not the cross product of their hours and minutes", () => {
		// One pattern with lists would also fire at 09:30 and 14:00.
		const schedule = repeat({ unit: "day", interval: 1, times: ["09:00", "14:30"] });
		expect(walk(schedule, "UTC", "2026-11-14T00:00:00Z", 3)).toEqual([
			"2026-11-14T09:00:00.000Z",
			"2026-11-14T14:30:00.000Z",
			"2026-11-15T09:00:00.000Z",
		]);
	});

	test("weekly on chosen days", () => {
		const schedule = repeat({ unit: "week", interval: 1, weekdays: [1], times: ["07:00"] });
		// 2026-11-14 is a Saturday; the next Monday 07:00 Shanghai is 2026-11-15 23:00 UTC.
		expect(walk(schedule, SHANGHAI, "2026-11-14T00:00:00Z", 3)).toEqual([
			"2026-11-15T23:00:00.000Z",
			"2026-11-22T23:00:00.000Z",
			"2026-11-29T23:00:00.000Z",
		]);
	});

	test("monthly on listed days and on the last day", () => {
		const schedule = repeat({
			unit: "month",
			interval: 1,
			monthDays: [1, 15, "last"],
			times: ["09:00"],
		});
		expect(walk(schedule, "UTC", "2026-11-02T00:00:00Z", 4)).toEqual([
			"2026-11-15T09:00:00.000Z",
			"2026-11-30T09:00:00.000Z",
			"2026-12-01T09:00:00.000Z",
			"2026-12-15T09:00:00.000Z",
		]);
	});

	test("a day the month does not have is skipped, not moved", () => {
		const schedule = repeat({ unit: "month", interval: 1, monthDays: [31], times: ["09:00"] });
		expect(walk(schedule, "UTC", "2026-11-01T00:00:00Z", 3)).toEqual([
			"2026-12-31T09:00:00.000Z",
			"2027-01-31T09:00:00.000Z",
			"2027-03-31T09:00:00.000Z",
		]);
	});

	test("hourly at a minute of the hour", () => {
		const schedule = repeat({ unit: "hour", interval: 1, minute: 15 });
		expect(walk(schedule, SHANGHAI, "2026-11-14T00:20:00Z", 2)).toEqual([
			"2026-11-14T01:15:00.000Z",
			"2026-11-14T02:15:00.000Z",
		]);
	});
});

describe("intervals larger than one", () => {
	test("every 3 days counts from the anchor's day", () => {
		const schedule = repeat(
			{ unit: "day", interval: 3, times: ["09:00"] },
			{ anchorAt: "2026-11-14T00:00:00.000Z" },
		);
		expect(walk(schedule, "UTC", "2026-11-14T00:00:00Z", 4)).toEqual([
			"2026-11-14T09:00:00.000Z",
			"2026-11-17T09:00:00.000Z",
			"2026-11-20T09:00:00.000Z",
			"2026-11-23T09:00:00.000Z",
		]);
	});

	test("every 3 days keeps its phase when asked from the middle of a gap", () => {
		const schedule = repeat(
			{ unit: "day", interval: 3, times: ["09:00"] },
			{ anchorAt: "2026-11-14T00:00:00.000Z" },
		);
		expect(walk(schedule, "UTC", "2026-11-18T12:00:00Z", 1)).toEqual(["2026-11-20T09:00:00.000Z"]);
	});

	test("every 2 weeks fires on all chosen days of a counting week, none of the other", () => {
		// Anchor week: Monday 2026-11-09 … Sunday 2026-11-15.
		const schedule = repeat(
			{ unit: "week", interval: 2, weekdays: [1, 3], times: ["07:00"] },
			{ anchorAt: "2026-11-09T00:00:00.000Z" },
		);
		expect(walk(schedule, "UTC", "2026-11-08T00:00:00Z", 5)).toEqual([
			"2026-11-09T07:00:00.000Z",
			"2026-11-11T07:00:00.000Z",
			"2026-11-23T07:00:00.000Z",
			"2026-11-25T07:00:00.000Z",
			"2026-12-07T07:00:00.000Z",
		]);
	});

	test("a week runs Monday to Sunday, so Sunday belongs with the Monday before it", () => {
		const schedule = repeat(
			{ unit: "week", interval: 2, weekdays: [0, 1], times: ["07:00"] },
			{ anchorAt: "2026-11-09T00:00:00.000Z" },
		);
		expect(walk(schedule, "UTC", "2026-11-08T12:00:00Z", 4)).toEqual([
			"2026-11-09T07:00:00.000Z",
			"2026-11-15T07:00:00.000Z",
			"2026-11-23T07:00:00.000Z",
			"2026-11-29T07:00:00.000Z",
		]);
	});

	test("every 2 months", () => {
		const schedule = repeat(
			{ unit: "month", interval: 2, monthDays: [1], times: ["09:00"] },
			{ anchorAt: "2026-11-01T00:00:00.000Z" },
		);
		expect(walk(schedule, "UTC", "2026-11-01T10:00:00Z", 3)).toEqual([
			"2027-01-01T09:00:00.000Z",
			"2027-03-01T09:00:00.000Z",
			"2027-05-01T09:00:00.000Z",
		]);
	});

	test("the period is read in the task's zone, not in UTC", () => {
		// 07:00 Monday in Shanghai is still Sunday in UTC; the week must be Shanghai's.
		const schedule = repeat(
			{ unit: "week", interval: 2, weekdays: [1], times: ["07:00"] },
			{ anchorAt: iso(wallToInstant("2026-11-09T00:00", SHANGHAI)) as string },
		);
		expect(walk(schedule, SHANGHAI, "2026-11-01T00:00:00Z", 3)).toEqual([
			"2026-11-08T23:00:00.000Z",
			"2026-11-22T23:00:00.000Z",
			"2026-12-06T23:00:00.000Z",
		]);
	});

	test("a rule that can never match gives up instead of spinning", () => {
		// Every 12 months counted from a February, on the 30th: February never has one.
		const schedule = repeat(
			{ unit: "month", interval: 12, monthDays: [30], times: ["09:00"] },
			{ anchorAt: "2026-02-01T00:00:00.000Z" },
		);
		expect(
			nextOccurrence({ schedule, timezone: "UTC", after: at("2026-01-01T00:00:00Z") }),
		).toBeNull();
	});
});

describe("fixed intervals", () => {
	test("every 7 minutes does not restart at the top of the hour", () => {
		const schedule = repeat(
			{ unit: "minute", interval: 7 },
			{ anchorAt: "2026-11-14T00:00:00.000Z" },
		);
		// A cron step would give :49, :56, :00. A real interval gives :49, :56, :03.
		expect(walk(schedule, "UTC", "2026-11-14T00:45:00Z", 3)).toEqual([
			"2026-11-14T00:49:00.000Z",
			"2026-11-14T00:56:00.000Z",
			"2026-11-14T01:03:00.000Z",
		]);
	});

	test("every 90 minutes", () => {
		const schedule = repeat(
			{ unit: "minute", interval: 90 },
			{ anchorAt: "2026-11-14T00:00:00.000Z" },
		);
		expect(walk(schedule, "UTC", "2026-11-14T00:00:00Z", 3)).toEqual([
			"2026-11-14T01:30:00.000Z",
			"2026-11-14T03:00:00.000Z",
			"2026-11-14T04:30:00.000Z",
		]);
	});

	test("a schedule converted from a cron step keeps firing on round minutes", () => {
		const schedule = repeat({ unit: "minute", interval: 15 }, { anchorAt: LEGACY_CRON_ANCHOR });
		expect(walk(schedule, SHANGHAI, "2026-11-14T00:07:00Z", 2)).toEqual([
			"2026-11-14T00:15:00.000Z",
			"2026-11-14T00:30:00.000Z",
		]);
	});

	test("every 2 hours lands on the asked minute in a half-hour zone", () => {
		// Kolkata is UTC+5:30. Midnight there is 18:30 UTC, so :15 local is :45 UTC.
		const schedule = repeat(
			{ unit: "hour", interval: 2, minute: 15 },
			{ anchorAt: iso(wallToInstant("2026-11-14T00:00", "Asia/Kolkata")) as string },
		);
		expect(walk(schedule, "Asia/Kolkata", "2026-11-13T18:30:00Z", 3)).toEqual([
			"2026-11-13T18:45:00.000Z",
			"2026-11-13T20:45:00.000Z",
			"2026-11-13T22:45:00.000Z",
		]);
	});

	test("an anchor carrying seconds does not push occurrences off the minute", () => {
		const schedule = repeat(
			{ unit: "minute", interval: 30 },
			{ anchorAt: "2026-11-14T00:00:42.500Z" },
		);
		expect(walk(schedule, "UTC", "2026-11-14T00:00:00Z", 1)).toEqual(["2026-11-14T00:30:00.000Z"]);
	});
});

describe("bounds", () => {
	const weekly: RepeatRule = { unit: "week", interval: 1, weekdays: [1], times: ["07:00"] };

	test("a count ends the series by scheduled occurrences consumed", () => {
		const schedule = repeat(weekly, { end: { type: "count", count: 3 } });
		const from = at("2026-11-14T00:00:00Z");
		expect(
			nextOccurrence({ schedule, timezone: "UTC", after: from, firedCount: 2 }),
		).not.toBeNull();
		expect(nextOccurrence({ schedule, timezone: "UTC", after: from, firedCount: 3 })).toBeNull();
	});

	test("until is inclusive", () => {
		const schedule = repeat(weekly, { end: { type: "until", until: "2026-11-23T07:00" } });
		expect(walk(schedule, "UTC", "2026-11-14T00:00:00Z", 5)).toEqual([
			"2026-11-16T07:00:00.000Z",
			"2026-11-23T07:00:00.000Z",
		]);
	});

	test("nothing fires before the start, and the start itself may", () => {
		const schedule = repeat(
			{ unit: "day", interval: 1, times: ["08:30"] },
			{ startAt: "2026-11-20T08:30", end: { type: "until", until: "2026-11-22T23:59" } },
		);
		expect(walk(schedule, "UTC", "2026-11-14T00:00:00Z", 5)).toEqual([
			"2026-11-20T08:30:00.000Z",
			"2026-11-21T08:30:00.000Z",
			"2026-11-22T08:30:00.000Z",
		]);
	});

	test("bounds apply to cron schedules too", () => {
		const schedule: TaskSchedule = {
			kind: "cron",
			expr: "0 9 * * *",
			startAt: "2026-11-20T00:00",
			end: { type: "count", count: 2 },
		};
		expect(walk(schedule, "UTC", "2026-11-14T00:00:00Z", 5)).toEqual([
			"2026-11-20T09:00:00.000Z",
			"2026-11-21T09:00:00.000Z",
		]);
	});
});

describe("daylight saving", () => {
	test("a daily time in the spring gap fires once, shifted", () => {
		const schedule = repeat({ unit: "day", interval: 1, times: ["02:30"] });
		expect(walk(schedule, NEW_YORK, "2027-03-13T12:00:00Z", 2)).toEqual([
			"2027-03-14T07:30:00.000Z",
			"2027-03-15T06:30:00.000Z",
		]);
	});

	test("a daily time keeps its wall-clock hour across the change", () => {
		const schedule = repeat({ unit: "day", interval: 1, times: ["09:00"] });
		// 09:00 is UTC-5 before the change and UTC-4 after it.
		expect(walk(schedule, NEW_YORK, "2027-03-12T20:00:00Z", 3)).toEqual([
			"2027-03-13T14:00:00.000Z",
			"2027-03-14T13:00:00.000Z",
			"2027-03-15T13:00:00.000Z",
		]);
	});
});

describe("cron schedules", () => {
	test("pass through to croner", () => {
		const schedule: TaskSchedule = {
			kind: "cron",
			expr: "0 9 * * 1#1",
			startAt: null,
			end: { type: "never" },
		};
		expect(walk(schedule, "UTC", "2026-11-14T00:00:00Z", 2)).toEqual([
			"2026-12-07T09:00:00.000Z",
			"2027-01-04T09:00:00.000Z",
		]);
	});

	test("an expression that does not parse never fires", () => {
		const schedule: TaskSchedule = {
			kind: "cron",
			expr: "not a cron",
			startAt: null,
			end: { type: "never" },
		};
		expect(
			nextOccurrence({ schedule, timezone: "UTC", after: at("2026-11-14T00:00:00Z") }),
		).toBeNull();
		expect(
			previewOccurrences(schedule, "UTC", { from: at("2026-11-14T00:00:00Z") }).exhausted,
		).toBe(true);
	});
});

describe("preview", () => {
	test("a count-limited series reports what is left and when it ends", () => {
		const schedule = repeat(
			{ unit: "week", interval: 1, weekdays: [1], times: ["07:00"] },
			{ end: { type: "count", count: 3 } },
		);
		const preview = previewOccurrences(schedule, SHANGHAI, {
			from: at("2026-11-14T00:00:00Z"),
			firedCount: 1,
		});
		expect(preview).toMatchObject({
			finite: true,
			total: 3,
			remaining: 2,
			endsAt: "2026-11-22T23:00:00.000Z",
			exhausted: false,
		});
		expect(preview.occurrences).toEqual(["2026-11-15T23:00:00.000Z", "2026-11-22T23:00:00.000Z"]);
	});

	test("specific date-times report progress through the list", () => {
		const schedule: TaskSchedule = {
			kind: "at",
			times: ["2026-11-23T08:00", "2026-12-01T11:00"],
		};
		const preview = previewOccurrences(schedule, SHANGHAI, { from: at("2026-11-25T00:00:00Z") });
		expect(preview).toMatchObject({
			finite: true,
			total: 2,
			remaining: 1,
			endsAt: "2026-12-01T03:00:00.000Z",
		});
	});

	test("an open-ended schedule has no end", () => {
		const preview = previewOccurrences(
			repeat({ unit: "day", interval: 1, times: ["09:00"] }),
			"UTC",
			{
				from: at("2026-11-14T00:00:00Z"),
				count: 2,
			},
		);
		expect(preview).toMatchObject({ finite: false, total: null, remaining: null, endsAt: null });
		expect(preview.occurrences).toHaveLength(2);
	});

	test("the number of occurrences returned is capped", () => {
		const preview = previewOccurrences(repeat({ unit: "minute", interval: 1 }), "UTC", {
			from: at("2026-11-14T00:00:00Z"),
			count: 500,
		});
		expect(preview.occurrences).toHaveLength(20);
	});
});

describe("counting a range", () => {
	test("a week of every-minute occurrences is counted, not walked", () => {
		const schedule = repeat(
			{ unit: "minute", interval: 1 },
			{ anchorAt: "2026-11-01T00:00:00.000Z" },
		);
		const result = countOccurrencesBetween({
			schedule,
			timezone: "UTC",
			after: at("2026-11-07T00:00:00Z"),
			until: at("2026-11-14T00:00:00Z"),
		});
		expect(result).toEqual({
			count: 7 * 24 * 60,
			first: "2026-11-07T00:01:00.000Z",
			last: "2026-11-14T00:00:00.000Z",
			capped: false,
		});
	});

	test("a count-limited interval stops at what is left", () => {
		const schedule = repeat(
			{ unit: "minute", interval: 30 },
			{ anchorAt: "2026-11-01T00:00:00.000Z", end: { type: "count", count: 10 } },
		);
		const result = countOccurrencesBetween({
			schedule,
			timezone: "UTC",
			after: at("2026-11-07T00:00:00Z"),
			until: at("2026-11-14T00:00:00Z"),
			firedCount: 7,
		});
		expect(result.count).toBe(3);
	});

	test("wall-clock rules are walked, and say so when the cap cut them short", () => {
		const schedule = repeat({ unit: "day", interval: 1, times: ["09:00"] });
		const range = {
			schedule,
			timezone: "UTC",
			after: at("2026-11-01T00:00:00Z"),
			until: at("2026-11-11T00:00:00Z"),
		};
		expect(countOccurrencesBetween(range)).toMatchObject({ count: 10, capped: false });
		expect(countOccurrencesBetween({ ...range, cap: 4 })).toMatchObject({
			count: 4,
			last: "2026-11-04T09:00:00.000Z",
			capped: true,
		});
	});

	test("an empty or inverted range has nothing", () => {
		const schedule = repeat({ unit: "day", interval: 1, times: ["09:00"] });
		expect(
			countOccurrencesBetween({
				schedule,
				timezone: "UTC",
				after: at("2026-11-11T00:00:00Z"),
				until: at("2026-11-01T00:00:00Z"),
			}).count,
		).toBe(0);
	});
});

describe("checkSchedule", () => {
	const now = at("2026-11-14T00:00:00Z");

	test("accepts what parseSchedule produced", () => {
		const parsed = parseSchedule({
			kind: "repeat",
			rule: { unit: "week", weekdays: [1], times: ["07:00"] },
			end: { type: "count", count: 3 },
		});
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(checkSchedule(parsed.schedule, SHANGHAI, { now })).toEqual({ ok: true });
	});

	test("names an unknown timezone", () => {
		const schedule = repeat({ unit: "day", interval: 1, times: ["09:00"] });
		expect(checkSchedule(schedule, "Not/AZone", { now })).toEqual({
			ok: false,
			code: "invalid_timezone",
			path: "timezone",
		});
	});

	test("names an expression that does not parse", () => {
		const schedule: TaskSchedule = {
			kind: "cron",
			expr: "not a cron",
			startAt: null,
			end: { type: "never" },
		};
		expect(checkSchedule(schedule, "UTC", { now })).toMatchObject({
			code: "invalid_cron",
			path: "expr",
		});
	});

	test("refuses a schedule that will never fire again", () => {
		const past: TaskSchedule = { kind: "at", times: ["2026-01-01T00:00"] };
		expect(checkSchedule(past, "UTC", { now })).toMatchObject({ code: "never_fires" });
		// Feb 30th parses as cron and never occurs.
		const impossible: TaskSchedule = {
			kind: "cron",
			expr: "0 0 30 2 *",
			startAt: null,
			end: { type: "never" },
		};
		expect(checkSchedule(impossible, "UTC", { now })).toMatchObject({ code: "never_fires" });
	});

	test("an exhausted schedule is acceptable when a future run is not required", () => {
		const past: TaskSchedule = { kind: "at", times: ["2026-01-01T00:00"] };
		expect(checkSchedule(past, "UTC", { now, requireFuture: false })).toEqual({ ok: true });
	});

	test("refuses a cadence shorter than the minimum", () => {
		const minute = repeat({ unit: "minute", interval: 1 });
		expect(checkSchedule(minute, "UTC", { now, minIntervalMs: 5 * 60_000 })).toMatchObject({
			code: "too_frequent",
		});
		const five = repeat({ unit: "minute", interval: 5 });
		expect(checkSchedule(five, "UTC", { now, minIntervalMs: 5 * 60_000 })).toEqual({ ok: true });
	});

	test("the minimum does not apply to explicitly listed date-times", () => {
		const close: TaskSchedule = { kind: "at", times: ["2026-11-20T08:00", "2026-11-20T08:01"] };
		expect(checkSchedule(close, "UTC", { now, minIntervalMs: 5 * 60_000 })).toEqual({ ok: true });
	});
});

describe("defaultAnchor", () => {
	test("is local midnight of today in the task's zone", () => {
		// 2026-11-14 03:00 UTC is 11:00 in Shanghai; midnight there was 2026-11-13 16:00 UTC.
		expect(defaultAnchor(SHANGHAI, at("2026-11-14T03:00:00Z"))).toBe("2026-11-13T16:00:00.000Z");
	});

	test("follows the start date when the schedule has one", () => {
		expect(defaultAnchor("UTC", at("2026-11-14T03:00:00Z"), "2026-12-01T09:30")).toBe(
			"2026-12-01T00:00:00.000Z",
		);
	});
});
