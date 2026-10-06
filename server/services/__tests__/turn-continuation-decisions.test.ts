/**
 * Behaviour pins for the interruption decision now SHARED by both loops.
 *
 * The primary loop used to carry this rule inline while the subagent loop had it as a pure
 * function. The two implementations agreed, which is precisely why the duplication was
 * dangerous: nothing would have told anyone if a later edit made them disagree. These tests
 * pin the merged rule against the behaviour the inline version had, branch by branch.
 */

import { describe, expect, test } from "bun:test";
import { MAX_SUBAGENT_INTERRUPTION_RETRIES, planSubagentInterruption } from "../subagent-executor";
import {
	interruptionContinuationLabel,
	MAX_TURN_INTERRUPTION_RETRIES,
	planTurnInterruption,
} from "../turn-continuation-decisions";

describe("planTurnInterruption", () => {
	test("a pass that was not interrupted resets the counter", () => {
		expect(planTurnInterruption({ interrupted: false }, 2)).toEqual({
			action: "none",
			retries: 0,
		});
	});

	test("defaults a missing reason to completion_limit", () => {
		// The flag's documented default, relied on by callers that only checked `interrupted`.
		expect(planTurnInterruption({ interrupted: true }, 0)).toEqual({
			action: "prompt",
			retries: 1,
			reason: "completion_limit",
			promptKey: "interruptionContinue",
		});
	});

	test("a resumable error asks for the transient-resume prompt", () => {
		expect(
			planTurnInterruption({ interrupted: true, interruptedReason: "resumable_error" }, 0),
		).toEqual({
			action: "prompt",
			retries: 1,
			reason: "resumable_error",
			promptKey: "resumeAfterTransientError",
		});
	});

	test("a replayable tool-result turn is replayed rather than prompted", () => {
		// Replaying preserves the original packet shape; a synthetic prompt would change it.
		expect(
			planTurnInterruption({ interrupted: true, shouldReplayInterruptedToolResultTurn: true }, 0),
		).toEqual({ action: "replay", retries: 1, reason: "completion_limit" });
	});

	test("the retry budget is bounded and the overshoot is reported", () => {
		expect(planTurnInterruption({ interrupted: true }, MAX_TURN_INTERRUPTION_RETRIES)).toEqual({
			action: "stop",
			retries: MAX_TURN_INTERRUPTION_RETRIES + 1,
			reason: "completion_limit",
		});
	});

	test("the budget bounds replay too, not just prompting", () => {
		// Otherwise an endlessly replayable turn would never stop.
		expect(
			planTurnInterruption(
				{ interrupted: true, shouldReplayInterruptedToolResultTurn: true },
				MAX_TURN_INTERRUPTION_RETRIES,
			).action,
		).toBe("stop");
	});

	test("the counter advances by exactly one per interrupted pass", () => {
		let retries = 0;
		for (let i = 1; i <= MAX_TURN_INTERRUPTION_RETRIES; i++) {
			const plan = planTurnInterruption({ interrupted: true }, retries);
			retries = plan.retries;
			expect(retries).toBe(i);
			expect(plan.action).not.toBe("stop");
		}
		expect(planTurnInterruption({ interrupted: true }, retries).action).toBe("stop");
	});

	test("suppressed reproduces the primary loop's `&& active.alive` guard", () => {
		// A dead session (or an aborted subagent run) must reset the counter and fall through
		// to the normal termination path, NOT preserve a partial count into the next turn.
		expect(planTurnInterruption({ interrupted: true }, 2, { suppressed: true })).toEqual({
			action: "none",
			retries: 0,
		});
	});

	test("suppression wins over an exhausted budget", () => {
		expect(planTurnInterruption({ interrupted: true }, 99, { suppressed: true }).action).toBe(
			"none",
		);
	});

	test("an explicit maxRetries overrides the shared default", () => {
		expect(planTurnInterruption({ interrupted: true }, 0, { maxRetries: 0 }).action).toBe("stop");
	});
});

describe("planSubagentInterruption stays equivalent after delegation", () => {
	// The subagent wrapper is now a thin alias. These pin that the delegation did not change
	// what its own callers and tests observe.
	test("bounds match", () => {
		expect(MAX_SUBAGENT_INTERRUPTION_RETRIES).toBe(MAX_TURN_INTERRUPTION_RETRIES);
	});

	test("agrees with the shared function on every branch", () => {
		const cases = [
			{ interrupted: false },
			{ interrupted: true },
			{ interrupted: true, interruptedReason: "resumable_error" as const },
			{ interrupted: true, shouldReplayInterruptedToolResultTurn: true },
		];
		for (const result of cases) {
			for (const retries of [0, 1, MAX_SUBAGENT_INTERRUPTION_RETRIES]) {
				expect(planSubagentInterruption(result, retries)).toEqual(
					planTurnInterruption(result, retries, {
						maxRetries: MAX_SUBAGENT_INTERRUPTION_RETRIES,
					}),
				);
			}
		}
	});
});

describe("interruptionContinuationLabel", () => {
	// Reproduced verbatim from the two inline versions so existing log greps keep matching.
	test("primary labels are unchanged", () => {
		expect(interruptionContinuationLabel("completion_limit", "primary")).toBe(
			"Completion-limit continuation",
		);
		expect(interruptionContinuationLabel("resumable_error", "primary")).toBe(
			"Resumable-error continuation",
		);
	});

	test("subagent labels are unchanged", () => {
		expect(interruptionContinuationLabel("completion_limit", "subagent")).toBe(
			"Subagent completion-limit continuation",
		);
		expect(interruptionContinuationLabel("resumable_error", "subagent")).toBe(
			"Subagent resumable-error continuation",
		);
	});
});
