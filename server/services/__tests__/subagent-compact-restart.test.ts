import { describe, expect, test } from "bun:test";
import { planSubagentCompactRestart } from "../subagent-executor";

/**
 * `needsRestart` is set by `onCompactDone`, which runs at the end of a detached
 * fire-and-forget chain that races the agent loop it belongs to. These tests pin
 * both orderings of that race so a background compact landing late can never
 * again drive a spurious extra turn.
 */
describe("planSubagentCompactRestart", () => {
	test("finishes when the pass already ended naturally", () => {
		// The regression: compact completed after the model stopped calling tools.
		// Restarting here sent one more request with no new instruction.
		expect(
			planSubagentCompactRestart({
				result: { completedNaturally: true },
				compactConsumedInLoop: false,
				compactDoneFlag: true,
			}),
		).toEqual({ action: "finish", reason: "completed_naturally" });
	});

	test("restarts when the pass ended mid-work", () => {
		// Compact landed between turns: the subagent still has work, so the
		// compacted history must be picked up and driven forward.
		expect(
			planSubagentCompactRestart({
				result: { completedNaturally: false },
				compactConsumedInLoop: false,
				compactDoneFlag: true,
			}),
		).toEqual({ action: "restart" });
	});

	test("finishes when onBeforeTurn already consumed the compact", () => {
		expect(
			planSubagentCompactRestart({
				result: { completedNaturally: false },
				compactConsumedInLoop: true,
				compactDoneFlag: false,
			}),
		).toEqual({ action: "finish", reason: "compact_consumed_in_loop" });
	});

	test("restarts when a newer compact landed after onBeforeTurn consumed one", () => {
		expect(
			planSubagentCompactRestart({
				result: { completedNaturally: false },
				compactConsumedInLoop: true,
				compactDoneFlag: true,
			}),
		).toEqual({ action: "restart" });
	});

	test("restarts on context overflow even when the pass reported natural completion", () => {
		// Overflow means the work was never delivered, so it outranks every other
		// signal — including a `done` observed while draining the failed pass.
		expect(
			planSubagentCompactRestart({
				result: { completedNaturally: true, contextLengthExceeded: true },
				compactConsumedInLoop: true,
				compactDoneFlag: false,
			}),
		).toEqual({ action: "restart" });
	});

	test("treats a missing completedNaturally flag as mid-work", () => {
		// Defensive: an older/partial result object must not be read as "finished".
		expect(
			planSubagentCompactRestart({
				result: {},
				compactConsumedInLoop: false,
				compactDoneFlag: true,
			}),
		).toEqual({ action: "restart" });
	});
});
