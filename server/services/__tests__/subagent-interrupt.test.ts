import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("../../db", () => ({
	db: {},
	sqlite: {},
}));

const {
	consumeForegroundSubagentHardInterrupt,
	getForegroundAbortControllers,
	interruptForegroundSubagent,
} = await import("../subagent-detach");
const { getManualOverrideMap, waitForManualOverride } = await import("../subagent-manual-override");

const SUBAGENT_ID = "subagent-interrupt-test";

afterEach(() => {
	getForegroundAbortControllers().clear();
	getManualOverrideMap().clear();
	consumeForegroundSubagentHardInterrupt(SUBAGENT_ID);
});

describe("foreground subagent interrupt semantics", () => {
	test("soft interrupt aborts the foreground controller without marking a hard interrupt", () => {
		const ctrl = new AbortController();
		getForegroundAbortControllers().set(SUBAGENT_ID, ctrl);

		expect(interruptForegroundSubagent(SUBAGENT_ID)).toBe(true);

		expect(ctrl.signal.aborted).toBe(true);
		expect(consumeForegroundSubagentHardInterrupt(SUBAGENT_ID)).toBe(false);
	});

	test("hard interrupt marker is consumed exactly once", () => {
		const ctrl = new AbortController();
		getForegroundAbortControllers().set(SUBAGENT_ID, ctrl);

		expect(interruptForegroundSubagent(SUBAGENT_ID, { hard: true })).toBe(true);

		expect(ctrl.signal.aborted).toBe(true);
		expect(consumeForegroundSubagentHardInterrupt(SUBAGENT_ID)).toBe(true);
		expect(consumeForegroundSubagentHardInterrupt(SUBAGENT_ID)).toBe(false);
	});

	test("hard interrupt resolves manual override as interrupted", async () => {
		const parentCtrl = new AbortController();
		const waiting = waitForManualOverride(
			SUBAGENT_ID,
			parentCtrl.signal,
			"parent-narrator",
			"tool-use-id",
		);

		expect(interruptForegroundSubagent(SUBAGENT_ID, { hard: true })).toBe(true);

		await expect(waiting).resolves.toEqual({
			finalText: "Subagent interrupted by user",
			hasError: false,
			interrupted: true,
		});
		expect(getManualOverrideMap().has(SUBAGENT_ID)).toBe(false);
		expect(consumeForegroundSubagentHardInterrupt(SUBAGENT_ID)).toBe(false);
	});
});
