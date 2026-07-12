import { afterEach, describe, expect, test } from "bun:test";

const {
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
