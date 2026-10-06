import { describe, expect, test } from "bun:test";
import { isValidCron, nextCronRun } from "../cron";

describe("isValidCron", () => {
	test("accepts common valid expressions", () => {
		expect(isValidCron("0 9 * * *")).toBe(true);
		expect(isValidCron("*/30 * * * *")).toBe(true);
		expect(isValidCron("0 9 * * 1")).toBe(true);
		// leap-day pattern still fires (croner rolls forward to the next Feb 29)
		expect(isValidCron("0 0 29 2 *")).toBe(true);
	});

	test("rejects syntactically invalid expressions", () => {
		expect(isValidCron("not a cron")).toBe(false);
		expect(isValidCron("")).toBe(false);
	});

	test("rejects syntactically valid but never-firing expressions", () => {
		// Feb 30th / Feb 31st / Apr 31st never occur. croner parses them without throwing
		// and returns null from nextRun(); isValidCron must treat those as invalid so the
		// Zod refine rejects them up front instead of leaking to the service-level guard.
		expect(isValidCron("0 0 30 2 *")).toBe(false);
		expect(isValidCron("0 0 31 2 *")).toBe(false);
		expect(isValidCron("0 0 31 4 *")).toBe(false);
	});

	test("rejects invalid IANA timezones (lazily validated by croner)", () => {
		expect(isValidCron("0 9 * * *", "Not/AZone")).toBe(false);
		expect(isValidCron("0 9 * * *", "Asia/Shanghai")).toBe(true);
	});
});

describe("nextCronRun", () => {
	test("returns a future ISO timestamp for valid expressions", () => {
		const from = new Date("2026-01-01T00:00:00Z");
		const next = nextCronRun("0 9 * * *", null, from);
		expect(next).toBe("2026-01-01T09:00:00.000Z");
	});

	test("returns null for never-firing or invalid expressions", () => {
		expect(nextCronRun("0 0 30 2 *")).toBeNull();
		expect(nextCronRun("garbage")).toBeNull();
	});

	test("honors an explicit timezone", () => {
		const from = new Date("2026-01-01T00:00:00Z");
		// 09:00 Asia/Shanghai (UTC+8) == 01:00 UTC
		const next = nextCronRun("0 9 * * *", "Asia/Shanghai", from);
		expect(next).toBe("2026-01-01T01:00:00.000Z");
	});
});
