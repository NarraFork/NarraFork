import { afterEach, describe, expect, test } from "bun:test";

const {
	beginSubagentInterruptSuspension,
	clearPendingTakeover,
	clearTakenOver,
	consumePendingStopTakeover,
	consumePendingTakeover,
	isBackgroundTakenOver,
	isPendingStopTakeover,
	isTakenOver,
	markPendingStopTakeover,
	markPendingTakeover,
	markTakenOver,
	suspensionIsTakeover,
} = await import("../subagent-takeover");

const SUBAGENT_ID = "subagent-takeover-test";

afterEach(() => {
	clearTakenOver(SUBAGENT_ID);
});

describe("pending stop-takeover marker (settling-window handoff)", () => {
	test("mark then consume returns true exactly once", () => {
		markPendingStopTakeover(SUBAGENT_ID);
		expect(isPendingStopTakeover(SUBAGENT_ID)).toBe(true);

		expect(consumePendingStopTakeover(SUBAGENT_ID)).toBe(true);
		// A second consume must not re-trigger the handoff.
		expect(consumePendingStopTakeover(SUBAGENT_ID)).toBe(false);
		expect(isPendingStopTakeover(SUBAGENT_ID)).toBe(false);
	});

	test("consume without a prior mark returns false", () => {
		expect(consumePendingStopTakeover(SUBAGENT_ID)).toBe(false);
	});

	test("clearTakenOver also clears a pending stop-takeover marker", () => {
		// Simulates the stop-takeover route recording a pending stop during the
		// settling window, then the takeover being cleared through another path.
		markTakenOver(SUBAGENT_ID);
		markPendingStopTakeover(SUBAGENT_ID);
		expect(isPendingStopTakeover(SUBAGENT_ID)).toBe(true);

		clearTakenOver(SUBAGENT_ID);

		expect(isTakenOver(SUBAGENT_ID)).toBe(false);
		expect(isPendingStopTakeover(SUBAGENT_ID)).toBe(false);
		expect(consumePendingStopTakeover(SUBAGENT_ID)).toBe(false);
	});
});

describe("takeover state basics", () => {
	test("foreground takeover is not flagged as background", () => {
		markTakenOver(SUBAGENT_ID);
		expect(isTakenOver(SUBAGENT_ID)).toBe(true);
		expect(isBackgroundTakenOver(SUBAGENT_ID)).toBe(false);
	});

	test("background takeover sets both flags", () => {
		markTakenOver(SUBAGENT_ID, { background: true });
		expect(isTakenOver(SUBAGENT_ID)).toBe(true);
		expect(isBackgroundTakenOver(SUBAGENT_ID)).toBe(true);
	});

	test("pending takeover marker is consumed once", () => {
		markPendingTakeover(SUBAGENT_ID);
		expect(consumePendingTakeover(SUBAGENT_ID)).toBe(true);
		expect(consumePendingTakeover(SUBAGENT_ID)).toBe(false);
		// clearPendingTakeover is idempotent on an already-empty marker.
		clearPendingTakeover(SUBAGENT_ID);
		expect(consumePendingTakeover(SUBAGENT_ID)).toBe(false);
	});
});

/*
 * Which substatus a subagent-only interrupt suspends as.
 *
 * Exercised through `beginSubagentInterruptSuspension` — the call the runner actually
 * makes — rather than through the boolean helper alone. That matters because the bug
 * was never in the boolean: it was in reading a marker that had just been CONSUMED.
 * A test that only feeds flags to `suspensionIsTakeover` passes even if the runner
 * goes back to inspecting the consumed marker, which is the mistake worth pinning.
 *
 * The repeated-interrupt sequence below is the actual reported failure: the second
 * Stop of a takeover suspended as `manual_override`, so the takeover UI disappeared
 * while `isTakenOver` still held — leaving the parent blocked with nothing on screen
 * offering to release it.
 */
describe("which substatus a subagent-only interrupt suspends as", () => {
	test("the interrupt that STARTS a takeover suspends as taken_over", () => {
		markPendingTakeover(SUBAGENT_ID);

		const first = beginSubagentInterruptSuspension(SUBAGENT_ID);

		expect(first.startedTakeover).toBe(true);
		expect(first.heldByTakeover).toBe(true);
		// The takeover is now established, which is what later interrupts rely on.
		expect(isTakenOver(SUBAGENT_ID)).toBe(true);
	});

	test("every LATER interrupt within one takeover still suspends as taken_over", () => {
		markPendingTakeover(SUBAGENT_ID);
		beginSubagentInterruptSuspension(SUBAGENT_ID);
		// The pending marker is gone from here on — consumed by the first suspension.
		expect(consumePendingTakeover(SUBAGENT_ID)).toBe(false);

		const second = beginSubagentInterruptSuspension(SUBAGENT_ID);
		const third = beginSubagentInterruptSuspension(SUBAGENT_ID);

		expect(second.startedTakeover).toBe(false);
		expect(second.heldByTakeover).toBe(true);
		expect(third.heldByTakeover).toBe(true);
		expect(isTakenOver(SUBAGENT_ID)).toBe(true);
	});

	test("an ordinary interrupt outside any takeover suspends as manual_override", () => {
		const plain = beginSubagentInterruptSuspension(SUBAGENT_ID);

		expect(plain.startedTakeover).toBe(false);
		expect(plain.heldByTakeover).toBe(false);
		// And it must not invent a takeover: doing so would keep the parent blocked
		// after a plain Stop.
		expect(isTakenOver(SUBAGENT_ID)).toBe(false);
	});

	test("after the takeover is stopped, an interrupt is plain again", () => {
		markPendingTakeover(SUBAGENT_ID);
		beginSubagentInterruptSuspension(SUBAGENT_ID);
		clearTakenOver(SUBAGENT_ID);

		expect(beginSubagentInterruptSuspension(SUBAGENT_ID).heldByTakeover).toBe(false);
	});

	test("the boolean rule itself, for the record", () => {
		expect(suspensionIsTakeover({ pendingTakeover: true, alreadyTakenOver: false })).toBe(true);
		expect(suspensionIsTakeover({ pendingTakeover: false, alreadyTakenOver: true })).toBe(true);
		expect(suspensionIsTakeover({ pendingTakeover: false, alreadyTakenOver: false })).toBe(false);
	});
});
