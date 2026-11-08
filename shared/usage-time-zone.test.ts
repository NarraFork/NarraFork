import { describe, expect, test } from "bun:test";
import {
	addBuckets,
	bucketLabelAt,
	countBucketsBetween,
	DEFAULT_USAGE_TIME_ZONE,
	normalizeUsageTimeZone,
	offsetMinutesAt,
	offsetSegments,
	zonedParts,
} from "./usage-time-zone";

describe("normalizeUsageTimeZone", () => {
	test("keeps a valid IANA name and defaults everything else to UTC", () => {
		expect(normalizeUsageTimeZone("Asia/Shanghai")).toBe("Asia/Shanghai");
		expect(normalizeUsageTimeZone("  America/New_York  ")).toBe("America/New_York");
		expect(normalizeUsageTimeZone(undefined)).toBe(DEFAULT_USAGE_TIME_ZONE);
		expect(normalizeUsageTimeZone("")).toBe(DEFAULT_USAGE_TIME_ZONE);
		expect(normalizeUsageTimeZone("Mars/Olympus")).toBe(DEFAULT_USAGE_TIME_ZONE);
	});
});

describe("offsetMinutesAt", () => {
	test("east-of-UTC and west-of-UTC zones", () => {
		const instant = new Date("2026-05-10T12:00:00.000Z");
		expect(offsetMinutesAt(instant, "Asia/Shanghai")).toBe(480);
		expect(offsetMinutesAt(instant, "America/New_York")).toBe(-240);
		expect(offsetMinutesAt(instant, "UTC")).toBe(0);
	});

	test("half-hour offset zone", () => {
		expect(offsetMinutesAt(new Date("2026-05-10T12:00:00.000Z"), "Asia/Kolkata")).toBe(330);
	});

	test("follows DST on the instant, not on the query", () => {
		// 2026 美国春季切换：03-08 07:00Z 之前是 EST(-5)，之后是 EDT(-4)。
		expect(offsetMinutesAt(new Date("2026-03-08T06:59:00.000Z"), "America/New_York")).toBe(-300);
		expect(offsetMinutesAt(new Date("2026-03-08T07:00:00.000Z"), "America/New_York")).toBe(-240);
		// 秋季回退：11-01 06:00Z 之前是 EDT(-4)，之后是 EST(-5)。
		expect(offsetMinutesAt(new Date("2026-11-01T05:59:00.000Z"), "America/New_York")).toBe(-240);
		expect(offsetMinutesAt(new Date("2026-11-01T06:00:00.000Z"), "America/New_York")).toBe(-300);
	});
});

describe("bucketLabelAt", () => {
	test("a record just after local midnight keeps its local date", () => {
		// 本地 11-05 01:00（+08）= 11-04 17:00Z。
		expect(bucketLabelAt(new Date("2026-11-04T17:00:00.000Z"), "day", "Asia/Shanghai")).toBe(
			"2026-11-05T00:00:00.000Z",
		);
		expect(bucketLabelAt(new Date("2026-11-04T17:00:00.000Z"), "day", "UTC")).toBe(
			"2026-11-04T00:00:00.000Z",
		);
	});

	test("west-of-UTC day labels follow the zone, not the server", () => {
		// 本地 01-14 22:00（EST）与本地 07-14 23:00（EDT）。
		expect(bucketLabelAt(new Date("2026-01-15T03:00:00.000Z"), "day", "America/New_York")).toBe(
			"2026-01-14T00:00:00.000Z",
		);
		expect(bucketLabelAt(new Date("2026-07-15T03:00:00.000Z"), "day", "America/New_York")).toBe(
			"2026-07-14T00:00:00.000Z",
		);
	});

	test("both sides of a DST jump stay in the same local day", () => {
		expect(bucketLabelAt(new Date("2026-03-08T06:30:00.000Z"), "day", "America/New_York")).toBe(
			"2026-03-08T00:00:00.000Z",
		);
		expect(bucketLabelAt(new Date("2026-03-08T07:30:00.000Z"), "day", "America/New_York")).toBe(
			"2026-03-08T00:00:00.000Z",
		);
		expect(bucketLabelAt(new Date("2026-03-09T04:30:00.000Z"), "day", "America/New_York")).toBe(
			"2026-03-09T00:00:00.000Z",
		);
	});

	test("half-hour offset hour labels land on the local hour", () => {
		// 本地 05-11 00:15（+05:30）。
		expect(bucketLabelAt(new Date("2026-05-10T18:45:00.000Z"), "hour", "Asia/Kolkata")).toBe(
			"2026-05-11T00:00:00.000Z",
		);
	});

	test("month labels cross the year boundary in the reader's zone", () => {
		expect(bucketLabelAt(new Date("2026-12-31T20:00:00.000Z"), "month", "Asia/Shanghai")).toBe(
			"2027-01-01T00:00:00.000Z",
		);
	});
});

describe("addBuckets", () => {
	test("steps in label space: a DST day is still one calendar day", () => {
		expect(addBuckets("2026-03-08T00:00:00.000Z", 1, "day")).toBe("2026-03-09T00:00:00.000Z");
		expect(addBuckets("2026-03-08T00:00:00.000Z", -1, "day")).toBe("2026-03-07T00:00:00.000Z");
	});

	test("months cross year boundaries", () => {
		expect(addBuckets("2026-12-01T00:00:00.000Z", 1, "month")).toBe("2027-01-01T00:00:00.000Z");
		expect(addBuckets("2027-01-01T00:00:00.000Z", -1, "month")).toBe("2026-12-01T00:00:00.000Z");
	});

	test("hours step one label at a time", () => {
		expect(addBuckets("2026-03-08T06:00:00.000Z", 1, "hour")).toBe("2026-03-08T07:00:00.000Z");
	});
});

describe("countBucketsBetween", () => {
	test("counts local days across a DST month", () => {
		expect(countBucketsBetween("2026-03-01T00:00:00.000Z", "2026-03-31T00:00:00.000Z", "day")).toBe(
			31,
		);
	});

	test("counts months across a year boundary", () => {
		expect(
			countBucketsBetween("2026-11-01T00:00:00.000Z", "2027-02-01T00:00:00.000Z", "month"),
		).toBe(4);
	});

	test("an inverted range counts zero", () => {
		expect(countBucketsBetween("2026-03-31T00:00:00.000Z", "2026-03-01T00:00:00.000Z", "day")).toBe(
			0,
		);
	});
});

describe("offsetSegments", () => {
	test("splits a spring-forward range into two segments", () => {
		const segments = offsetSegments(
			new Date("2026-03-01T00:00:00.000Z"),
			new Date("2026-04-01T00:00:00.000Z"),
			"America/New_York",
		);
		expect(segments.map((segment) => segment.offsetMinutes)).toEqual([-300, -240]);
		expect(new Date(segments[1]?.fromMs ?? 0).toISOString()).toBe("2026-03-08T07:00:00.000Z");
	});

	test("splits a fall-back range and keeps the earlier offset first", () => {
		const segments = offsetSegments(
			new Date("2026-10-15T00:00:00.000Z"),
			new Date("2026-11-15T00:00:00.000Z"),
			"America/New_York",
		);
		expect(segments.map((segment) => segment.offsetMinutes)).toEqual([-240, -300]);
		expect(new Date(segments[1]?.fromMs ?? 0).toISOString()).toBe("2026-11-01T06:00:00.000Z");
	});

	test("a zone without DST yields a single segment", () => {
		const segments = offsetSegments(
			new Date("2026-01-01T00:00:00.000Z"),
			new Date("2027-01-01T00:00:00.000Z"),
			"Asia/Shanghai",
		);
		expect(segments).toHaveLength(1);
		expect(segments[0]?.offsetMinutes).toBe(480);
	});
});

describe("zonedParts", () => {
	test("reports the wall clock of the requested zone", () => {
		expect(zonedParts(new Date("2026-11-05T02:30:00.000Z"), "Asia/Shanghai")).toMatchObject({
			year: 2026,
			month: 11,
			day: 5,
			hour: 10,
			minute: 30,
		});
	});
});
