import { describe, expect, test } from "bun:test";
import { resolveToolCallTiming, resolveToolDisplayDurationMs } from "../tool-display-duration";

const SCREENSHOT = {
	streamStartedAt: 35_417,
	streamCompletedAt: 40_192,
	executionStartedAt: 40_259,
	completedAt: 48_625,
	durationMs: 13_209,
	outputJson: { _metadata: { execDurationMs: 8_366 } },
};

describe("tool timing phases", () => {
	test("separates the reported 13s lifecycle without moving the real completion", () => {
		expect(resolveToolCallTiming(SCREENSHOT)).toMatchObject({
			totalMs: 13_209,
			streamingMs: 4_775,
			waitMs: 67,
			executionMs: 8_366,
			executionSpanMs: 8_366,
			completed: 48_625,
			fileWaitMs: null,
		});
		expect(resolveToolDisplayDurationMs(SCREENSHOT)).toBe(8_366);
	});

	test("adds measured internal waits, uses measured operation, preserves lifecycle stamps", () => {
		const source = {
			...SCREENSHOT,
			outputJson: {
				_metadata: {
					execDurationMs: 8_366,
					fileChangeTiming: { waitMs: 8_000, executionMs: 300, totalMs: 8_300 },
				},
			},
		};
		expect(resolveToolCallTiming(source)).toMatchObject({
			waitMs: 8_067,
			executionMs: 366,
			executionSpanMs: 8_366,
			completed: 48_625,
			totalMs: 13_209,
		});
		expect(resolveToolDisplayDurationMs(source)).toBe(366);
		// If lifecycle/execute timestamps are absent, the operation receipt is the fallback.
		expect(
			resolveToolDisplayDurationMs({
				fileChangeTiming: source.outputJson._metadata.fileChangeTiming,
			}),
		).toBe(300);
	});

	test("all categories prefer an available execDurationMs", () => {
		for (const category of ["bash", "edit", "write", "read", "structure_edit"]) {
			expect(
				resolveToolDisplayDurationMs({ category, durationMs: 13_209, execDurationMs: 8_366 }),
			).toBe(8_366);
		}
	});

	test("actual completedAt bounds execution, never executionStartedAt plus lifecycle duration", () => {
		const { outputJson: _, ...old } = SCREENSHOT;
		expect(resolveToolDisplayDurationMs(old)).toBe(8_366);
		expect(resolveToolCallTiming(old).fileWaitMs).toBeNull();
		expect(
			resolveToolCallTiming({ durationMs: 13_209, executionStartedAt: 40_259 }).completed,
		).toBeNull();
	});

	test("old total-only records do not guess execution or lock waiting", () => {
		const source = { createdAt: 1_000, durationMs: 13_209 };
		expect(resolveToolCallTiming(source)).toMatchObject({
			totalMs: 13_209,
			waitMs: null,
			executionMs: null,
			completed: null,
		});
		expect(resolveToolDisplayDurationMs(source)).toBe(13_209);
	});

	test("zero timestamps, operation duration and wait are valid measurements", () => {
		const source = {
			streamStartedAt: 0,
			streamCompletedAt: 0,
			executionStartedAt: 0,
			completedAt: 0,
			durationMs: 0,
			fileChangeTiming: { waitMs: 0, executionMs: 0, totalMs: 0 },
		};
		expect(resolveToolCallTiming(source)).toMatchObject({
			totalMs: 0,
			streamingMs: 0,
			waitMs: 0,
			executionMs: 0,
			completed: 0,
		});
		expect(resolveToolDisplayDurationMs(source)).toBe(0);
		expect(resolveToolDisplayDurationMs({})).toBeNull();
	});

	test("invalid and incomplete receipts cannot fabricate lock waits", () => {
		for (const fileChangeTiming of [
			{ waitMs: -1, executionMs: 0, totalMs: 1 },
			{ waitMs: Number.NaN, executionMs: 0, totalMs: 1 },
			{ waitMs: 8_367, executionMs: 0, totalMs: 8_367 },
			{ waitMs: 100, executionMs: 5 },
		]) {
			const phases = resolveToolCallTiming({
				...SCREENSHOT,
				outputJson: { _metadata: { fileChangeTiming } },
			});
			expect(phases.fileWaitMs).toBeNull();
			expect(phases.waitMs).toBe(67);
			expect(phases.executionMs).toBe(8_366);
		}
	});

	test("ISO stamps and permission waiting contribute without double counting", () => {
		const source = {
			streamStartedAt: "2026-01-01T00:00:00.000Z",
			streamCompletedAt: "2026-01-01T00:00:01.000Z",
			permissionStartedAt: "2026-01-01T00:00:01.010Z",
			executionStartedAt: "2026-01-01T00:00:02.000Z",
			completedAt: "2026-01-01T00:00:03.000Z",
		};
		expect(resolveToolCallTiming(source)).toMatchObject({
			streamingMs: 1_000,
			waitMs: 1_000,
			permissionWaitMs: 990,
			executionMs: 1_000,
			totalMs: 3_000,
		});
	});
});
