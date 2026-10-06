import { describe, expect, test } from "bun:test";
import {
	isKimiCustomApiProvider,
	parseKimiUsagesResponse,
} from "../../../server/lib/kimi-usage-cache";

// Real response captured from GET https://api.kimi.com/coding/v1/usages.
const KIMI_COM_RESPONSE = {
	user: { userId: "u1", region: "REGION_CN", membership: { level: "LEVEL_ADVANCED" } },
	usage: { limit: "100", used: "67", remaining: "33", resetTime: "2026-08-27T03:22:01.136395Z" },
	limits: [
		{
			window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
			detail: {
				limit: "100",
				used: "2",
				remaining: "98",
				resetTime: "2026-08-21T13:22:01.136395Z",
			},
		},
	],
};

// Real response captured from GET https://api.kimi.ai/coding/v1/usages.
const KIMI_AI_RESPONSE = {
	user: { userId: "u2", region: "REGION_OVERSEA", membership: { level: "LEVEL_STANDARD" } },
	usage: { limit: "100", used: "34", remaining: "66", resetTime: "2026-08-27T17:35:46.841Z" },
	limits: [
		{
			window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
			detail: { limit: "100", used: "71", remaining: "29", resetTime: "2026-08-21T13:35:46.841Z" },
		},
	],
};

describe("parseKimiUsagesResponse", () => {
	test("parses the kimi.com windowed shape (weekly usage + 5h limit)", () => {
		const parsed = parseKimiUsagesResponse(KIMI_COM_RESPONSE);
		expect(parsed.weekly).toEqual({
			used: 67,
			limit: 100,
			remaining: 33,
			resetTime: "2026-08-27T03:22:01.136395Z",
		});
		expect(parsed.fiveHour).toEqual({
			used: 2,
			limit: 100,
			remaining: 98,
			resetTime: "2026-08-21T13:22:01.136395Z",
		});
		expect(parsed.monthly).toBeNull();
		expect(parsed.extraWindows).toEqual([]);
	});

	test("parses the kimi.ai windowed shape identically", () => {
		const parsed = parseKimiUsagesResponse(KIMI_AI_RESPONSE);
		expect(parsed.weekly?.used).toBe(34);
		expect(parsed.fiveHour?.used).toBe(71);
		expect(parsed.fiveHour?.remaining).toBe(29);
	});

	test("parses the data-list shape with model_name: all as weekly summary", () => {
		const parsed = parseKimiUsagesResponse({
			data: [
				{ model_name: "all", used: 40, limit: 100, resetTime: "2026-08-27T00:00:00Z" },
				{ model_name: "5h", used: 10, limit: 100, resetTime: "2026-08-21T10:00:00Z" },
				{ model_name: "monthly", used: 300, limit: 1000, resetTime: "2026-09-01T00:00:00Z" },
			],
		});
		expect(parsed.weekly?.used).toBe(40);
		expect(parsed.fiveHour?.used).toBe(10);
		expect(parsed.monthly?.used).toBe(300);
		expect(parsed.extraWindows).toEqual([]);
	});

	test("classifies week/month window durations from the limits array", () => {
		const parsed = parseKimiUsagesResponse({
			limits: [
				{
					window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
					detail: { used: 1, limit: 10 },
				},
				{
					window: { duration: 1, timeUnit: "TIME_UNIT_WEEK" },
					detail: { used: 20, limit: 100 },
				},
				{
					window: { duration: 1, timeUnit: "TIME_UNIT_MONTH" },
					detail: { used: 200, limit: 1000 },
				},
			],
		});
		expect(parsed.fiveHour?.used).toBe(1);
		expect(parsed.weekly?.used).toBe(20);
		expect(parsed.monthly?.used).toBe(200);
	});

	test("keeps unrecognized windows in extraWindows with a label", () => {
		const parsed = parseKimiUsagesResponse({
			limits: [
				{
					window: { duration: 30, timeUnit: "TIME_UNIT_MINUTE" },
					detail: { used: 3, limit: 50 },
				},
			],
		});
		expect(parsed.fiveHour).toBeNull();
		expect(parsed.extraWindows).toHaveLength(1);
		expect(parsed.extraWindows[0]?.label).toBe("30min");
		expect(parsed.extraWindows[0]?.used).toBe(3);
	});

	test("keeps unrecognized data-list entries in extraWindows", () => {
		const parsed = parseKimiUsagesResponse({
			data: [{ model_name: "burst", used: 5, limit: 20 }],
		});
		expect(parsed.weekly).toBeNull();
		expect(parsed.extraWindows[0]?.label).toBe("burst");
	});

	test("returns empty payload for garbage input", () => {
		expect(parseKimiUsagesResponse(null)).toEqual({
			fiveHour: null,
			weekly: null,
			monthly: null,
			extraWindows: [],
		});
		expect(parseKimiUsagesResponse({}).extraWindows).toEqual([]);
		expect(parseKimiUsagesResponse("nope").fiveHour).toBeNull();
	});

	test("skips empty window records", () => {
		const parsed = parseKimiUsagesResponse({
			limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: {} }],
		});
		expect(parsed.fiveHour).toBeNull();
		expect(parsed.extraWindows).toEqual([]);
	});
});

describe("isKimiCustomApiProvider", () => {
	test("matches api.kimi.com and api.kimi.ai base URLs", () => {
		expect(isKimiCustomApiProvider({ baseUrl: "https://api.kimi.com/coding/" })).toBe(true);
		expect(isKimiCustomApiProvider({ baseUrl: "https://api.kimi.com/coding/v1" })).toBe(true);
		expect(isKimiCustomApiProvider({ baseUrl: "https://api.kimi.ai/coding/v1" })).toBe(true);
		expect(isKimiCustomApiProvider({ baseUrl: "https://kimi.com" })).toBe(true);
	});

	test("rejects non-kimi hosts, disabled providers and invalid URLs", () => {
		expect(isKimiCustomApiProvider({ baseUrl: "https://api.moonshot.cn/v1" })).toBe(false);
		expect(isKimiCustomApiProvider({ baseUrl: "https://kimi.com.evil.example" })).toBe(false);
		expect(isKimiCustomApiProvider({ baseUrl: "https://api.kimi.com", disabled: true })).toBe(
			false,
		);
		expect(isKimiCustomApiProvider({ baseUrl: "not a url" })).toBe(false);
		expect(isKimiCustomApiProvider({})).toBe(false);
	});
});

/**
 * Bucket assignment must trust the EXPLICIT window over the inferred one.
 *
 * `usage` being the weekly aggregate is an observation of the payloads captured
 * above, not a documented guarantee; a `limits[]` entry states its window outright.
 * Filling `weekly` from `usage` first meant a real weekly limit arrived to find the
 * slot taken and was demoted into `extraWindows` — the card then showed the guess
 * under "Weekly limit" and the authoritative figure as a nameless extra row.
 */
describe("parseKimiUsagesResponse — explicit windows win over the usage aggregate", () => {
	test("a weekly entry in limits[] owns the weekly bucket, not `usage`", () => {
		const parsed = parseKimiUsagesResponse({
			usage: { limit: 100, used: 40 },
			limits: [
				{
					window: { duration: 7, timeUnit: "TIME_UNIT_DAY" },
					detail: { limit: 500, used: 123 },
				},
			],
		});
		expect(parsed.weekly).toEqual({ used: 123, limit: 500, remaining: null, resetTime: null });
		// The inferred duplicate is dropped, not surfaced as an unnamed extra row.
		expect(parsed.extraWindows).toEqual([]);
	});

	test("`usage` still fills the weekly bucket when limits[] says nothing about it", () => {
		const parsed = parseKimiUsagesResponse({
			usage: { limit: 100, used: 67 },
			limits: [
				{
					window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
					detail: { limit: 100, used: 2 },
				},
			],
		});
		expect(parsed.weekly).toEqual({ used: 67, limit: 100, remaining: null, resetTime: null });
		expect(parsed.fiveHour?.used).toBe(2);
	});

	test("a calendar month (28-31 days) still reaches the monthly bucket", () => {
		// MINUTES_PER_MONTH is a 30-day approximation and the match used to be exact,
		// so a 31-day window lost its "Monthly limit" row and became a `4w` extra.
		for (const days of [28, 30, 31]) {
			const parsed = parseKimiUsagesResponse({
				limits: [{ window: { duration: days, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: 9 } }],
			});
			expect(parsed.monthly?.limit, `${days}d must classify as monthly`).toBe(9);
			expect(parsed.extraWindows).toEqual([]);
		}
	});

	test("a 4-week window is NOT silently taken for a month", () => {
		// 28 days is inside the month tolerance, but an explicit WEEK unit is exact:
		// 4 weeks must stay an extra row rather than impersonate the monthly limit.
		const parsed = parseKimiUsagesResponse({
			limits: [{ window: { duration: 2, timeUnit: "TIME_UNIT_WEEK" }, detail: { limit: 9 } }],
		});
		expect(parsed.monthly).toBeNull();
		expect(parsed.extraWindows).toEqual([
			{ label: "2w", used: null, limit: 9, remaining: null, resetTime: null },
		]);
	});
});
