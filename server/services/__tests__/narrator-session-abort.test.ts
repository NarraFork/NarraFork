import { describe, expect, test } from "bun:test";
import { getContextOverflowFailureError } from "../narrator-recovery";
import {
	resolveToolCallConclusionTiming,
	shouldFinalizeAbortBeforeRecovery,
} from "../narrator-session";

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

describe("resolveToolCallConclusionTiming", () => {
	test("refreshes completion timing after retry or continued execution", () => {
		const timing = resolveToolCallConclusionTiming({ streamStartedAt: 1_000 }, 5_000);

		expect(timing).toEqual({ completedAt: 5_000, durationMs: 4_000 });
	});
});

describe("getContextOverflowFailureError", () => {
	test("does not label missing compact boundary as compact failure", () => {
		const failure = getContextOverflowFailureError("no_compact_boundary");

		expect(failure.errorCode).toBe("context_too_long_no_compact_boundary");
		expect(failure.message).not.toContain("compact failed");
	});
});
