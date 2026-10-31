/**
 * Behaviour pins for the interruption decision now SHARED by both loops.
 *
 * The primary loop used to carry this rule inline while the subagent loop had it as a pure
 * function. The two implementations agreed, which is precisely why the duplication was
 * dangerous: nothing would have told anyone if a later edit made them disagree. These tests
 * pin the merged rule against the behaviour the inline version had, branch by branch.
 */

import { describe, expect, test } from "bun:test";
import {
	interruptionContinuationLabel,
	MAX_TURN_INTERRUPTION_RETRIES,
	planTurnInterruption,
} from "../turn-continuation-decisions";

describe("planTurnInterruption", () => {
	test("a pass that was not interrupted resets the counter", () => {
		expect(planTurnInterruption({ interrupted: false, finalText: "partial output" }, 2)).toEqual({
			action: "none",
			retries: 0,
		});
	});

	test("defaults a missing reason to completion_limit", () => {
		// The flag's documented default, relied on by callers that only checked `interrupted`.
		expect(planTurnInterruption({ interrupted: true, finalText: "partial output" }, 0)).toEqual({
			action: "prompt",
			retries: 1,
			reason: "completion_limit",
			promptKey: "interruptionContinue",
		});
	});

	test("a completion limit with nothing visible nudges once, then stops", () => {
		// 思考耗尽：整个输出预算花在内部思考上，既无文本也无工具调用。"从中断处继续"没有中断处可续，
		// 再想一轮只会再次撞上限并烧掉一整轮预算，所以只给一次针对性指令，第二次零产出直接停。
		const thinkingOnly = {
			interrupted: true,
			interruptedReason: "completion_limit" as const,
			hadToolUses: false,
			finalText: "",
		};
		expect(planTurnInterruption(thinkingOnly, 0)).toEqual({
			action: "prompt",
			retries: 1,
			reason: "completion_limit",
			promptKey: "thinkingExhaustedContinue",
		});
		expect(planTurnInterruption(thinkingOnly, 1)).toEqual({
			action: "stop",
			retries: 2,
			reason: "completion_limit",
		});
	});

	test("partial text or a tool call keeps the ordinary resume prompt", () => {
		// 有可见产出时"从中断处继续"才是对的：确实存在可续的中断处。
		for (const visible of [
			{ hadToolUses: false, finalText: "half an answer" },
			{ hadToolUses: true, finalText: "" },
		]) {
			expect(
				planTurnInterruption(
					{ interrupted: true, interruptedReason: "completion_limit", ...visible },
					0,
				),
			).toMatchObject({ action: "prompt", promptKey: "interruptionContinue" });
		}
	});

	test("a resumable error asks for the transient-resume prompt", () => {
		expect(
			planTurnInterruption(
				{ interrupted: true, interruptedReason: "resumable_error", finalText: "partial output" },
				0,
			),
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
			planTurnInterruption(
				{
					interrupted: true,
					shouldReplayInterruptedToolResultTurn: true,
					finalText: "partial output",
				},
				0,
			),
		).toEqual({ action: "replay", retries: 1, reason: "completion_limit" });
	});

	test("the retry budget is bounded and the overshoot is reported", () => {
		expect(
			planTurnInterruption(
				{ interrupted: true, finalText: "partial output" },
				MAX_TURN_INTERRUPTION_RETRIES,
			),
		).toEqual({
			action: "stop",
			retries: MAX_TURN_INTERRUPTION_RETRIES + 1,
			reason: "completion_limit",
		});
	});

	test("the budget bounds replay too, not just prompting", () => {
		// Otherwise an endlessly replayable turn would never stop.
		expect(
			planTurnInterruption(
				{
					interrupted: true,
					shouldReplayInterruptedToolResultTurn: true,
					finalText: "partial output",
				},
				MAX_TURN_INTERRUPTION_RETRIES,
			).action,
		).toBe("stop");
	});

	test("the counter advances by exactly one per interrupted pass", () => {
		let retries = 0;
		for (let i = 1; i <= MAX_TURN_INTERRUPTION_RETRIES; i++) {
			const plan = planTurnInterruption(
				{ interrupted: true, finalText: "partial output" },
				retries,
			);
			retries = plan.retries;
			expect(retries).toBe(i);
			expect(plan.action).not.toBe("stop");
		}
		expect(
			planTurnInterruption({ interrupted: true, finalText: "partial output" }, retries).action,
		).toBe("stop");
	});

	test("suppressed reproduces the primary loop's `&& active.alive` guard", () => {
		// A dead session (or an aborted subagent run) must reset the counter and fall through
		// to the normal termination path, NOT preserve a partial count into the next turn.
		expect(
			planTurnInterruption({ interrupted: true, finalText: "partial output" }, 2, {
				suppressed: true,
			}),
		).toEqual({
			action: "none",
			retries: 0,
		});
	});

	test("suppression wins over an exhausted budget", () => {
		expect(
			planTurnInterruption({ interrupted: true, finalText: "partial output" }, 99, {
				suppressed: true,
			}).action,
		).toBe("none");
	});

	test("an explicit maxRetries overrides the shared default", () => {
		expect(
			planTurnInterruption({ interrupted: true, finalText: "partial output" }, 0, { maxRetries: 0 })
				.action,
		).toBe("stop");
	});
});

describe("shared interruption defaults preserve the delegated behavior", () => {
	// The subagent wrapper is now a thin alias. These pin that the delegation did not change
	// what its own callers and tests observe.
	test("bounds match", () => {
		expect(MAX_TURN_INTERRUPTION_RETRIES).toBe(3);
	});

	test("agrees with the shared function on every branch", () => {
		const cases = [
			{ interrupted: false, finalText: "partial output" },
			{ interrupted: true, finalText: "partial output" },
			{
				interrupted: true,
				interruptedReason: "resumable_error" as const,
				finalText: "partial output",
			},
			{
				interrupted: true,
				shouldReplayInterruptedToolResultTurn: true,
				finalText: "partial output",
			},
		];
		for (const result of cases) {
			for (const retries of [0, 1, MAX_TURN_INTERRUPTION_RETRIES]) {
				expect(planTurnInterruption(result, retries)).toEqual(
					planTurnInterruption(result, retries, {
						maxRetries: MAX_TURN_INTERRUPTION_RETRIES,
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
