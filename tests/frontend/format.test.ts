import { describe, expect, test } from "bun:test";
import {
	calculateEffectiveTurnElapsedMs,
	formatColonDuration,
	parseTurnPauseTiming,
} from "../../frontend/lib/format";

describe("formatColonDuration", () => {
	test("formats minute, hour, and day boundaries", () => {
		expect(formatColonDuration(0)).toBe("0:00");
		expect(formatColonDuration(59)).toBe("0:59");
		expect(formatColonDuration(60)).toBe("1:00");
		expect(formatColonDuration(3_600)).toBe("1:00:00");
		expect(formatColonDuration(86_399)).toBe("23:59:59");
		expect(formatColonDuration(86_400)).toBe("1:00:00:00");
		expect(formatColonDuration(93_784)).toBe("1:02:03:04");
	});

	test("keeps large day values and omits zero high fields", () => {
		expect(formatColonDuration(123 * 86_400 + 5)).toBe("123:00:00:05");
		expect(formatColonDuration(3_605)).toBe("1:00:05");
		expect(formatColonDuration(65)).toBe("1:05");
	});

	test("safely normalizes invalid and negative inputs", () => {
		expect(formatColonDuration(-1)).toBe("0:00");
		expect(formatColonDuration(undefined)).toBe("0:00");
		expect(formatColonDuration(null)).toBe("0:00");
		expect(formatColonDuration(Number.NaN)).toBe("0:00");
		expect(formatColonDuration(Number.POSITIVE_INFINITY)).toBe("0:00");
	});
});

describe("turn pause timing", () => {
	test("parses canonical timing tags and ignores malformed values", () => {
		expect(
			parseTurnPauseTiming([
				"error",
				"turn_paused_ms:2500",
				"turn_paused_ms:2000",
				"turn_pause_started_ms:9000",
				"turn_pause_started_ms:10000",
				"turn_paused_ms:not-a-number",
			]),
		).toEqual({ pausedMs: 2500, pauseStartedAtMs: 9000 });
	});

	test("subtracts completed pause time", () => {
		expect(
			calculateEffectiveTurnElapsedMs({
				turnStartedAt: 1_000,
				endAt: 11_000,
				substatus: ["turn_paused_ms:3000"],
			}),
		).toBe(7_000);
	});

	test("freezes an active pause at its start", () => {
		const substatus = ["interrupted", "turn_paused_ms:2000", "turn_pause_started_ms:8000"];
		expect(
			calculateEffectiveTurnElapsedMs({
				turnStartedAt: 1_000,
				nowMs: 20_000,
				substatus,
			}),
		).toBe(5_000);
		expect(
			calculateEffectiveTurnElapsedMs({
				turnStartedAt: 1_000,
				nowMs: 60_000,
				substatus,
			}),
		).toBe(5_000);
	});

	test("returns null when the turn start is unavailable", () => {
		expect(
			calculateEffectiveTurnElapsedMs({
				turnStartedAt: "not-a-date",
				nowMs: 10_000,
			}),
		).toBeNull();
	});
});
