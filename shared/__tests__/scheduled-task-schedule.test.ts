import { describe, expect, test } from "bun:test";
import {
	describeScheduleEn,
	isFiniteSchedule,
	LEGACY_CRON_ANCHOR,
	normalizeWallDateTime,
	normalizeWallTime,
	parseSchedule,
	scheduleFromLegacyCron,
	scheduleSignature,
	scheduleToLegacyCron,
	type TaskSchedule,
} from "../scheduled-task-schedule";

/** The normalized schedule, or the issue code when the input is refused. */
function parsed(input: unknown): TaskSchedule | string {
	const result = parseSchedule(input);
	return result.ok ? result.schedule : `${result.issue.code}@${result.issue.path}`;
}

describe("wall-clock text", () => {
	test("normalizes to minute precision", () => {
		expect(normalizeWallDateTime("2026-11-23T08:00")).toBe("2026-11-23T08:00");
		expect(normalizeWallDateTime(" 2026-11-23T08:00:59 ")).toBe("2026-11-23T08:00");
		expect(normalizeWallTime("7:00")).toBeNull();
		expect(normalizeWallTime("07:00:30")).toBe("07:00");
	});

	test("refuses a date the calendar does not have", () => {
		expect(normalizeWallDateTime("2026-02-30T09:00")).toBeNull();
		expect(normalizeWallDateTime("2026-13-01T09:00")).toBeNull();
		expect(normalizeWallDateTime("2026-11-23T24:00")).toBeNull();
		// 2028 is a leap year; 2026 is not.
		expect(normalizeWallDateTime("2028-02-29T09:00")).toBe("2028-02-29T09:00");
		expect(normalizeWallDateTime("2026-02-29T09:00")).toBeNull();
	});

	test("refuses anything that is not text in the expected shape", () => {
		expect(normalizeWallDateTime(1_700_000_000_000)).toBeNull();
		expect(normalizeWallDateTime("2026-11-23")).toBeNull();
		expect(normalizeWallDateTime("2026-11-23T08:00Z")).toBeNull();
		expect(normalizeWallTime("25:00")).toBeNull();
	});
});

describe("parseSchedule: specific date-times", () => {
	test("sorts and de-duplicates", () => {
		expect(
			parsed({
				kind: "at",
				times: ["2026-12-01T11:00", "2026-11-23T08:00", "2026-12-01T11:00:00"],
			}),
		).toEqual({ kind: "at", times: ["2026-11-23T08:00", "2026-12-01T11:00"] });
	});

	test("needs at least one, and not too many", () => {
		expect(parsed({ kind: "at", times: [] })).toBe("empty_times@times");
		const many = Array.from(
			{ length: 51 },
			(_, i) => `2026-11-${String((i % 28) + 1).padStart(2, "0")}T0${i % 10}:00`,
		);
		expect(parsed({ kind: "at", times: many })).toBe("too_many_times@times");
	});

	test("points at the bad entry", () => {
		expect(parsed({ kind: "at", times: ["2026-11-23T08:00", "tomorrow"] })).toBe(
			"invalid_datetime@times.1",
		);
	});
});

describe("parseSchedule: repeat rules", () => {
	test("fills in what a person leaves unsaid", () => {
		expect(parsed({ kind: "repeat", rule: { unit: "day", times: ["09:00"] } })).toEqual({
			kind: "repeat",
			rule: { unit: "day", interval: 1, times: ["09:00"] },
			startAt: null,
			end: { type: "never" },
		});
		expect(parsed({ kind: "repeat", rule: { unit: "hour" } })).toMatchObject({
			rule: { unit: "hour", interval: 1, minute: 0 },
		});
	});

	test("normalizes lists so equal schedules compare equal", () => {
		expect(
			parsed({
				kind: "repeat",
				rule: {
					unit: "week",
					interval: 2,
					weekdays: [3, 7, 1, 3],
					times: ["20:00", "07:00", "07:00"],
				},
				end: { type: "count", count: 3 },
			}),
		).toEqual({
			kind: "repeat",
			// Cron's 7 is Sunday, stored as 0.
			rule: { unit: "week", interval: 2, weekdays: [0, 1, 3], times: ["07:00", "20:00"] },
			startAt: null,
			end: { type: "count", count: 3 },
		});
		expect(
			parsed({
				kind: "repeat",
				rule: { unit: "month", monthDays: ["last", 15, 1, 15], times: ["09:00"] },
			}),
		).toMatchObject({ rule: { monthDays: [1, 15, "last"] } });
	});

	test("refuses out-of-range intervals per unit", () => {
		expect(parsed({ kind: "repeat", rule: { unit: "minute", interval: 0 } })).toBe(
			"invalid_interval@rule.interval",
		);
		expect(parsed({ kind: "repeat", rule: { unit: "minute", interval: 1441 } })).toBe(
			"invalid_interval@rule.interval",
		);
		expect(
			parsed({
				kind: "repeat",
				rule: { unit: "week", interval: 1.5, weekdays: [1], times: ["07:00"] },
			}),
		).toBe("invalid_interval@rule.interval");
	});

	test("refuses rules missing what their unit needs", () => {
		expect(parsed({ kind: "repeat", rule: { unit: "day" } })).toBe("empty_times@rule.times");
		expect(parsed({ kind: "repeat", rule: { unit: "week", times: ["07:00"] } })).toBe(
			"invalid_weekdays@rule.weekdays",
		);
		expect(
			parsed({ kind: "repeat", rule: { unit: "month", monthDays: [32], times: ["07:00"] } }),
		).toBe("invalid_month_days@rule.monthDays.0");
		expect(parsed({ kind: "repeat", rule: { unit: "hour", minute: 60 } })).toBe(
			"invalid_minute@rule.minute",
		);
		expect(parsed({ kind: "repeat", rule: { unit: "fortnight" } })).toBe("invalid_shape@rule.unit");
	});

	test("validates the end condition", () => {
		const rule = { unit: "day", times: ["09:00"] };
		expect(parsed({ kind: "repeat", rule, end: { type: "count", count: 0 } })).toBe(
			"invalid_count@end.count",
		);
		expect(parsed({ kind: "repeat", rule, end: { type: "until", until: "soon" } })).toBe(
			"invalid_end@end.until",
		);
		expect(parsed({ kind: "repeat", rule, end: { type: "forever" } })).toBe("invalid_end@end.type");
		expect(
			parsed({
				kind: "repeat",
				rule,
				startAt: "2026-12-01T00:00",
				end: { type: "until", until: "2026-11-01T00:00" },
			}),
		).toBe("end_before_start@end.until");
	});

	test("keeps a valid anchor and refuses a broken one", () => {
		const rule = { unit: "minute", interval: 30 };
		expect(parsed({ kind: "repeat", rule, anchorAt: "2026-11-14T00:00:00+08:00" })).toMatchObject({
			anchorAt: "2026-11-13T16:00:00.000Z",
		});
		expect(parsed({ kind: "repeat", rule, anchorAt: "yesterday" })).toBe("invalid_anchor@anchorAt");
	});
});

describe("parseSchedule: cron and shape", () => {
	test("collapses whitespace in the expression", () => {
		expect(parsed({ kind: "cron", expr: "  0   9 * *  1 " })).toEqual({
			kind: "cron",
			expr: "0 9 * * 1",
			startAt: null,
			end: { type: "never" },
		});
	});

	test("refuses an empty or over-long expression", () => {
		expect(parsed({ kind: "cron", expr: "   " })).toBe("invalid_cron@expr");
		expect(parsed({ kind: "cron", expr: "* ".repeat(150) })).toBe("invalid_cron@expr");
	});

	test("refuses anything that is not a schedule", () => {
		expect(parsed(null)).toBe("invalid_shape@");
		expect(parsed("0 9 * * *")).toBe("invalid_shape@");
		expect(parsed({ kind: "sometimes" })).toBe("invalid_kind@kind");
	});
});

describe("legacy cron conversion", () => {
	test("reads the shapes the old presets produced", () => {
		expect(scheduleFromLegacyCron("0 9 * * *")).toMatchObject({
			kind: "repeat",
			rule: { unit: "day", interval: 1, times: ["09:00"] },
		});
		expect(scheduleFromLegacyCron("30 7 * * 1,3")).toMatchObject({
			rule: { unit: "week", interval: 1, weekdays: [1, 3], times: ["07:30"] },
		});
		expect(scheduleFromLegacyCron("15 * * * *")).toMatchObject({
			rule: { unit: "hour", interval: 1, minute: 15 },
		});
		expect(scheduleFromLegacyCron("*/15 * * * *")).toMatchObject({
			rule: { unit: "minute", interval: 15 },
			anchorAt: LEGACY_CRON_ANCHOR,
		});
	});

	test("Sunday written as 7 becomes 0", () => {
		expect(scheduleFromLegacyCron("0 9 * * 7,1")).toMatchObject({ rule: { weekdays: [0, 1] } });
	});

	test("leaves alone anything that would not mean exactly the same", () => {
		// A 7-minute step restarts every hour; a fixed interval does not.
		for (const expr of [
			"*/7 * * * *",
			"0 9 1 * *",
			"0 9 * 6 *",
			"0 9 * * 1-5",
			"30 0 9 * * *",
			"0 9,17 * * *",
		]) {
			expect(scheduleFromLegacyCron(expr)).toEqual({
				kind: "cron",
				expr,
				startAt: null,
				end: { type: "never" },
			});
		}
	});

	test("a converted schedule writes back the expression it came from", () => {
		for (const expr of ["0 9 * * *", "30 7 * * 1,3", "15 * * * *", "*/15 * * * *", "0 9 * * 1#1"]) {
			expect(scheduleToLegacyCron(scheduleFromLegacyCron(expr))).toBe(expr);
		}
	});

	test("schedules with no single-expression equivalent have none", () => {
		expect(scheduleToLegacyCron({ kind: "at", times: ["2026-11-23T08:00"] })).toBeNull();
		const base = { kind: "repeat", startAt: null, end: { type: "never" } } as const;
		expect(scheduleToLegacyCron({ ...base, rule: { unit: "minute", interval: 7 } })).toBeNull();
		expect(
			scheduleToLegacyCron({ ...base, rule: { unit: "day", interval: 3, times: ["09:00"] } }),
		).toBeNull();
		expect(
			scheduleToLegacyCron({
				...base,
				rule: { unit: "day", interval: 1, times: ["09:00", "14:30"] },
			}),
		).toBeNull();
	});
});

describe("comparing and describing", () => {
	const rule = { unit: "minute", interval: 30 } as const;
	const base = { kind: "repeat", rule, startAt: null, end: { type: "never" } } as const;

	test("the signature ignores the anchor and nothing else", () => {
		expect(scheduleSignature({ ...base, anchorAt: "2026-11-14T00:00:00.000Z" })).toBe(
			scheduleSignature({ ...base, anchorAt: "2027-01-01T00:00:00.000Z" }),
		);
		expect(scheduleSignature(base)).not.toBe(
			scheduleSignature({ ...base, end: { type: "count", count: 3 } }),
		);
	});

	test("only schedules that run out are finite", () => {
		expect(isFiniteSchedule({ kind: "at", times: ["2026-11-23T08:00"] })).toBe(true);
		expect(isFiniteSchedule({ ...base, end: { type: "count", count: 3 } })).toBe(true);
		expect(isFiniteSchedule({ ...base, end: { type: "until", until: "2026-12-01T00:00" } })).toBe(
			true,
		);
		expect(isFiniteSchedule(base)).toBe(false);
	});

	test("plain-English rendering", () => {
		expect(
			describeScheduleEn(
				{
					kind: "repeat",
					rule: { unit: "week", interval: 1, weekdays: [1], times: ["07:00"] },
					startAt: null,
					end: { type: "count", count: 3 },
				},
				"Asia/Shanghai",
			),
		).toBe("every week on Mon at 07:00, 3 times in total (Asia/Shanghai)");
		expect(
			describeScheduleEn({ kind: "at", times: ["2026-11-23T08:00", "2026-12-01T11:00"] }),
		).toBe("once at 2026-11-23 08:00, 2026-12-01 11:00");
		expect(
			describeScheduleEn({
				kind: "repeat",
				rule: { unit: "month", interval: 2, monthDays: [1, "last"], times: ["09:00"] },
				startAt: "2026-12-01T00:00",
				end: { type: "until", until: "2027-06-30T23:59" },
			}),
		).toBe(
			"every 2 months on day 1, the last day at 09:00, from 2026-12-01 00:00, until 2027-06-30 23:59",
		);
		expect(describeScheduleEn({ ...base, rule: { unit: "minute", interval: 1 } })).toBe(
			"every minute",
		);
	});
});
