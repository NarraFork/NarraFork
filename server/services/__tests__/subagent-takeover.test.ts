import { afterEach, describe, expect, test } from "bun:test";

const {
	beginSubagentInterruptSuspension,
	clearTakenOver,
	consumePendingStopTakeover,
	isBackgroundTakenOver,
	isPendingStopTakeover,
	isTakenOver,
	isTakenOverForDisplay,
	isTakeoverReleasePending,
	listDisplayTakenOverSubagents,
	listTakenOverSubagents,
	markPendingBackgroundFinalize,
	markPendingStopTakeover,
	markTakenOver,
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

	test("marking a takeover does not invent a pending release", () => {
		markTakenOver(SUBAGENT_ID);

		expect(isTakeoverReleasePending(SUBAGENT_ID)).toBe(false);
		expect(consumePendingStopTakeover(SUBAGENT_ID)).toBe(false);
	});
});

/*
 * Which substatus a subagent-only interrupt suspends as.
 *
 * Exercised through `beginSubagentInterruptSuspension` — the call the runner actually
 * makes — so the sequence a repeated Stop performs is what gets checked, not a
 * restatement of the boolean.
 *
 * The repeated-interrupt case below is a real reported failure: the second Stop of a
 * takeover suspended as `manual_override`, so the takeover UI disappeared while
 * `isTakenOver` still held — leaving the parent blocked with nothing on screen
 * offering to release it. It used to be possible because the decision read a marker
 * that the FIRST suspension had consumed; taking over no longer interrupts at all, so
 * there is no first-interrupt special case left to get wrong.
 */
describe("which substatus a subagent-only interrupt suspends as", () => {
	test("an interrupt during a takeover suspends as taken_over", () => {
		markTakenOver(SUBAGENT_ID);

		expect(beginSubagentInterruptSuspension(SUBAGENT_ID).heldByTakeover).toBe(true);
	});

	test("every LATER interrupt within one takeover still suspends as taken_over", () => {
		markTakenOver(SUBAGENT_ID);

		expect(beginSubagentInterruptSuspension(SUBAGENT_ID).heldByTakeover).toBe(true);
		expect(beginSubagentInterruptSuspension(SUBAGENT_ID).heldByTakeover).toBe(true);
		expect(beginSubagentInterruptSuspension(SUBAGENT_ID).heldByTakeover).toBe(true);
		// Deciding the substatus must not consume the hold: the takeover outlives the
		// turn the user just stopped.
		expect(isTakenOver(SUBAGENT_ID)).toBe(true);
	});

	test("an ordinary interrupt outside any takeover suspends as manual_override", () => {
		expect(beginSubagentInterruptSuspension(SUBAGENT_ID).heldByTakeover).toBe(false);
		// And it must not invent a takeover: doing so would keep the parent blocked
		// after a plain Stop.
		expect(isTakenOver(SUBAGENT_ID)).toBe(false);
	});

	test("after the takeover is stopped, an interrupt is plain again", () => {
		markTakenOver(SUBAGENT_ID);
		clearTakenOver(SUBAGENT_ID);

		expect(beginSubagentInterruptSuspension(SUBAGENT_ID).heldByTakeover).toBe(false);
	});
});

/*
 * Control flow and DISPLAY diverge in one window, and conflating them is a real
 * reported bug: after the user stops a takeover on a still-WORKING subagent, the
 * release is deferred to the loop's end and `clearTakenOver` must NOT run yet (it
 * would wipe the pending-release marker the loop still has to consume). So
 * `isTakenOver` stays true on purpose — and any code that PAINTS the takeover
 * state from it re-lights a badge the user already dismissed on every page load
 * in that window.
 */
describe("display state vs control-flow state after a deferred release", () => {
	test("a deferred foreground release stops the badge while keeping the hold", () => {
		markTakenOver(SUBAGENT_ID);
		markPendingStopTakeover(SUBAGENT_ID);

		// Still held: the loop must consume the marker and hand the result back.
		expect(isTakenOver(SUBAGENT_ID)).toBe(true);
		// But the user has let go, so nothing should claim they are driving.
		expect(isTakeoverReleasePending(SUBAGENT_ID)).toBe(true);
		expect(isTakenOverForDisplay(SUBAGENT_ID)).toBe(false);
		expect(listDisplayTakenOverSubagents()).not.toContain(SUBAGENT_ID);
		// The raw list still reports it — that is the control-flow answer.
		expect(listTakenOverSubagents()).toContain(SUBAGENT_ID);
	});

	test("a deferred background release does the same", () => {
		markTakenOver(SUBAGENT_ID, { background: true });
		markPendingBackgroundFinalize(SUBAGENT_ID);

		expect(isTakenOver(SUBAGENT_ID)).toBe(true);
		expect(isTakenOverForDisplay(SUBAGENT_ID)).toBe(false);
	});

	test("an ACTIVE takeover is displayed (the flag still has to work)", () => {
		markTakenOver(SUBAGENT_ID);

		expect(isTakenOverForDisplay(SUBAGENT_ID)).toBe(true);
		expect(isTakeoverReleasePending(SUBAGENT_ID)).toBe(false);
		expect(listDisplayTakenOverSubagents()).toContain(SUBAGENT_ID);
	});

	test("a subagent that was never taken over is not displayed", () => {
		expect(isTakenOverForDisplay(SUBAGENT_ID)).toBe(false);
		expect(listDisplayTakenOverSubagents()).not.toContain(SUBAGENT_ID);
	});
});
