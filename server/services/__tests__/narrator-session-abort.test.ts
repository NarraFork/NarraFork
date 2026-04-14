import { describe, expect, test } from "bun:test";
import { shouldFinalizeAbortBeforeRecovery } from "../narrator-session";

describe("shouldFinalizeAbortBeforeRecovery", () => {
	test("returns true for user aborts before recovery runs", () => {
		expect(shouldFinalizeAbortBeforeRecovery(true, false, undefined)).toBe(true);
		expect(shouldFinalizeAbortBeforeRecovery(false, true, undefined)).toBe(true);
	});

	test("returns false for plan-approval abort handoff", () => {
		expect(shouldFinalizeAbortBeforeRecovery(true, true, "continue")).toBe(false);
		expect(shouldFinalizeAbortBeforeRecovery(true, true, "compact")).toBe(false);
	});
});
