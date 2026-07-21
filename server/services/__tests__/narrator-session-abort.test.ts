import { describe, expect, test } from "bun:test";
import {
	getContextOverflowFailureError,
	resetContextOverflowRetriesAfterProgress,
} from "../narrator-recovery";
import {
	interruptNarrator,
	registerPlannedUpdateRecoveryController,
	resolveToolCallConclusionTiming,
	shouldFinalizeAbortBeforeRecovery,
} from "../narrator-session";

describe("planned-update recovery interrupt control", () => {
	test("stale unregister cannot remove a newer parent recovery controller", () => {
		const first = new AbortController();
		const second = new AbortController();
		const firstRegistration = registerPlannedUpdateRecoveryController("recovering-parent", first);
		const secondRegistration = registerPlannedUpdateRecoveryController("recovering-parent", second);

		firstRegistration.unregister();
		expect(interruptNarrator("recovering-parent")).toBe(true);
		expect(first.signal.aborted).toBe(false);
		expect(second.signal.aborted).toBe(true);

		secondRegistration.unregister();
		expect(interruptNarrator("recovering-parent")).toBe(false);
	});
});

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

describe("resetContextOverflowRetriesAfterProgress", () => {
	test("starts a new recovery episode after a completed assistant turn", () => {
		expect(resetContextOverflowRetriesAfterProgress(2, true)).toBe(0);
	});

	test("preserves the retry count when compact is followed by an immediate overflow", () => {
		expect(resetContextOverflowRetriesAfterProgress(2, false)).toBe(2);
		expect(resetContextOverflowRetriesAfterProgress(2, undefined)).toBe(2);
	});
});
