import { describe, expect, test } from "bun:test";
import { subagentRetryRecoveredBroadcast } from "../subagent-executor";

/**
 * A subagent's transient-error retry leaves the parent panel with a client-only
 * `_retryInfo` on the subagent's narrator cache ("retry N/M"). The only
 * frontend cleanup hooks are `subagent_status_changed` and
 * `subagent_conclusion_updated`, which otherwise fire when the subagent
 * FINISHES — so the recovery frame this function produces is what clears the
 * stale badge while the subagent keeps working.
 */
describe("subagentRetryRecoveredBroadcast", () => {
	test("returns null on an ordinary successful pass (no retry preceded it)", () => {
		expect(subagentRetryRecoveredBroadcast(0, "parent-1", "sub-1")).toBeNull();
	});

	test("returns a working-status frame after one or more retries", () => {
		expect(subagentRetryRecoveredBroadcast(1, "parent-1", "sub-1")).toEqual({
			type: "subagent_status_changed",
			narratorId: "parent-1",
			subagentNarratorId: "sub-1",
			status: "working",
		});
		expect(subagentRetryRecoveredBroadcast(3, "parent-1", "sub-1")).toEqual({
			type: "subagent_status_changed",
			narratorId: "parent-1",
			subagentNarratorId: "sub-1",
			status: "working",
		});
	});

	test("routes to the parent narrator while identifying the subagent", () => {
		const frame = subagentRetryRecoveredBroadcast(2, "parent-1", "sub-1");
		// The frame must match the `subagent_status_changed` protocol the panel
		// hook consumes: `narratorId` names the broadcast channel (the PARENT —
		// that is whose subscribers receive it) and `subagentNarratorId` names
		// the narrator whose cached status / `_retryInfo` get patched.
		expect(frame?.narratorId).toBe("parent-1");
		expect(frame?.subagentNarratorId).toBe("sub-1");
		expect(frame?.narratorId).not.toBe(frame?.subagentNarratorId);
	});

	test("never carries a substatus field, so the panel keeps the live one", () => {
		// The panel hook only overwrites substatus when the field is present;
		// omitting it preserves tags like queued/compacting during recovery.
		const frame = subagentRetryRecoveredBroadcast(1, "parent-1", "sub-1");
		expect(frame && "substatus" in frame).toBe(false);
	});

	test("status is exactly working, matching the loop's real state at this point", () => {
		// The executor never left the working state during backoff sleep (no
		// updateStatus happens in the transient-retry path), so the frame must
		// not claim anything else or the panel would desync from the DB.
		for (const retries of [1, 2, 5]) {
			expect(subagentRetryRecoveredBroadcast(retries, "p", "s")?.status).toBe("working");
		}
	});
});
