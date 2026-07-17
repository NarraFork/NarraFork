import { describe, expect, test } from "bun:test";
import { shouldShowUpdateScheduleButton } from "./update-state";

describe("update scheduling state", () => {
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
