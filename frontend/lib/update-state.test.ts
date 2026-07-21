import { describe, expect, test } from "bun:test";
import { resolveUpdateCoordinationCounts, shouldShowUpdateScheduleButton } from "./update-state";

describe("update scheduling state", () => {
	test("uses granular coordination counts when available", () => {
		expect(
			resolveUpdateCoordinationCounts({
				pendingExecutionCount: 9,
				pendingBackgroundBashCount: 2,
				pendingOrdinaryExecutionCount: 3,
				resumableExecutionCount: 4,
				pausedToolCount: 5,
			}),
		).toEqual({
			pendingExecutionCount: 9,
			pendingBackgroundBashCount: 2,
			pendingOrdinaryExecutionCount: 3,
			resumableExecutionCount: 4,
			pausedToolCount: 5,
		});
	});

	test("includes resumable executions when deriving the total", () => {
		expect(
			resolveUpdateCoordinationCounts({
				pendingBackgroundBashCount: 2,
				pendingOrdinaryExecutionCount: 3,
				resumableExecutionCount: 4,
			}),
		).toMatchObject({
			pendingExecutionCount: 9,
			resumableExecutionCount: 4,
		});
	});

	test("preserves a legacy total without inventing both phase counts", () => {
		expect(resolveUpdateCoordinationCounts({ pendingExecutionCount: 5 })).toEqual({
			pendingExecutionCount: 5,
			pendingBackgroundBashCount: 0,
			pendingOrdinaryExecutionCount: 0,
			resumableExecutionCount: 0,
			pausedToolCount: 0,
		});
	});

	test("attributes a legacy total only to the active drain phase", () => {
		expect(
			resolveUpdateCoordinationCounts({
				phase: "draining",
				pendingExecutionCount: 5,
			}),
		).toMatchObject({
			pendingExecutionCount: 5,
			pendingBackgroundBashCount: 5,
			pendingOrdinaryExecutionCount: 0,
		});
		expect(
			resolveUpdateCoordinationCounts({
				phase: "quiescing_tools",
				pendingExecutionCount: 3,
			}),
		).toMatchObject({
			pendingExecutionCount: 3,
			pendingBackgroundBashCount: 0,
			pendingOrdinaryExecutionCount: 3,
		});
	});

	test("allows retry after an asynchronous coordination failure", () => {
		expect(
			shouldShowUpdateScheduleButton({
				canRestartIntoUpdate: true,
				applySucceeded: true,
				coordinationFailed: true,
			}),
		).toBe(true);
	});

	test("hides scheduling while a successful attempt is still active", () => {
		expect(
			shouldShowUpdateScheduleButton({
				canRestartIntoUpdate: true,
				applySucceeded: true,
				coordinationFailed: false,
			}),
		).toBe(false);
	});
});
