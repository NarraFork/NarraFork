import { describe, expect, test } from "bun:test";
import {
	parseTurnPauseTiming,
	preserveTurnTimingSubstatus,
	resolveContinueTurnTiming,
	transitionTurnTimingSubstatus,
} from "../narrator-turn-timing";

describe("turn pause substatus transitions", () => {
	test("records a recoverable pause start only once", () => {
		const first = transitionTurnTimingSubstatus([], ["error"], {
			status: "idle",
			nowMs: 10_000,
		});
		const repeated = transitionTurnTimingSubstatus(first, ["error"], {
			status: "idle",
			nowMs: 20_000,
		});

		expect(parseTurnPauseTiming(first)).toEqual({
			pausedMs: 0,
			pauseStartedAtMs: 10_000,
		});
		expect(parseTurnPauseTiming(repeated)).toEqual({
			pausedMs: 0,
			pauseStartedAtMs: 10_000,
		});
	});

	test("preserves timing tags across same-turn substatus updates", () => {
		expect(
			preserveTurnTimingSubstatus(
				["interrupted", "turn_paused_ms:3000", "turn_pause_started_ms:9000"],
				["background_compacting"],
			),
		).toEqual(["background_compacting", "turn_paused_ms:3000", "turn_pause_started_ms:9000"]);
	});

	test("resuming working accumulates the pause and removes its start", () => {
		const resumed = transitionTurnTimingSubstatus(
			["interrupted", "turn_paused_ms:2000", "turn_pause_started_ms:8000"],
			[],
			{ status: "working", nowMs: 13_000, resumeTurn: true },
		);

		expect(resumed).toEqual(["turn_paused_ms:7000"]);
	});

	test("accumulates multiple pause and resume cycles", () => {
		const firstResume = transitionTurnTimingSubstatus(["error", "turn_pause_started_ms:5000"], [], {
			status: "working",
			nowMs: 8000,
			resumeTurn: true,
		});
		const secondPause = transitionTurnTimingSubstatus(firstResume, ["payment_required"], {
			status: "idle",
			nowMs: 12_000,
		});
		const secondResume = transitionTurnTimingSubstatus(secondPause, [], {
			status: "working",
			nowMs: 17_000,
			resumeTurn: true,
		});

		expect(parseTurnPauseTiming(secondResume)).toEqual({
			pausedMs: 8_000,
			pauseStartedAtMs: null,
		});
	});

	test("uses updatedAt fallback for legacy recoverable rows", () => {
		const resumed = transitionTurnTimingSubstatus(["error"], [], {
			status: "working",
			nowMs: 20_000,
			resumeTurn: true,
			fallbackPauseStartedAtMs: 14_000,
		});

		expect(resumed).toEqual(["turn_paused_ms:6000"]);
	});

	test("a new turn clears all internal timing tags", () => {
		expect(
			transitionTurnTimingSubstatus(
				["unread", "turn_paused_ms:4000", "turn_pause_started_ms:9000"],
				[],
				{ status: "working", nowMs: 15_000, setTurnStart: true },
			),
		).toEqual([]);
	});
});

describe("continue turn timing", () => {
	test("preserves the original turn for error and interrupted recovery branches", () => {
		for (const substatus of [
			["error", "turn_pause_started_ms:9000"],
			["interrupted", "turn_pause_started_ms:9000"],
		]) {
			expect(
				resolveContinueTurnTiming({
					substatus,
					turnStartedAt: "2026-01-01T00:00:00.000Z",
					nowMs: 20_000,
				}),
			).toEqual({
				preserveTurnStart: true,
				turnStartedAt: "2026-01-01T00:00:00.000Z",
			});
		}
	});

	test("falls back to now when legacy recovery lacks turnStartedAt", () => {
		expect(
			resolveContinueTurnTiming({
				substatus: ["error"],
				turnStartedAt: null,
				nowMs: 20_000,
			}),
		).toEqual({
			preserveTurnStart: true,
			turnStartedAt: "1970-01-01T00:00:20.000Z",
		});
	});

	test("normal completion starts a new turn even after earlier completed pauses", () => {
		expect(
			resolveContinueTurnTiming({
				substatus: ["unread", "turn_paused_ms:5000"],
				turnStartedAt: "2026-01-01T00:00:00.000Z",
				nowMs: 20_000,
			}),
		).toEqual({
			preserveTurnStart: false,
			turnStartedAt: "1970-01-01T00:00:20.000Z",
		});
	});
});
