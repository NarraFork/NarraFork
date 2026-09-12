import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Capture real modules before mocking so afterAll can re-point them (Bun's
// mock.module is process-global and mock.restore() does not undo it).
const realNarratorCompact = { ...(await import("../narrator-compact")) };
const realSettings = { ...(await import("../../lib/settings")) };

let triggerMidTurnCompactCalls: number;

mock.module("../narrator-compact", () => ({
	...realNarratorCompact,
	triggerMidTurnCompact: mock(() => {
		triggerMidTurnCompactCalls++;
	}),
}));

// A fixed compact threshold makes direct triggering and guards deterministic.
mock.module("../../lib/settings", () => ({
	...realSettings,
	getContextThresholds: () => ({ compactStart: 80 }),
}));

const { buildContextManagementHooks } = await import("../narrator-session");
const { compactLocks } = await import("../narrator-session-state");

const NARRATOR_ID = "sub-guard-test";

function makeHooks(isCompactDone: () => boolean) {
	return buildContextManagementHooks({
		narratorId: NARRATOR_ID,
		locale: "en",
		isSubagent: true,
		getModel: () => "test-model",
		getProvider: () => "anthropic",
		onCompactDone: () => {},
		isCompactDone,
		clearCompactDone: () => {},
	});
}

beforeEach(() => {
	triggerMidTurnCompactCalls = 0;
});

afterAll(() => {
	mock.module("../narrator-compact", () => realNarratorCompact);
	mock.module("../../lib/settings", () => realSettings);
	mock.restore();
});

describe("onContextUsage compact guard (subagent)", () => {
	test("starts directly at compactStart, never below it", () => {
		const { onContextUsage } = makeHooks(() => false);
		onContextUsage(79.99);
		expect(triggerMidTurnCompactCalls).toBe(0);
		onContextUsage(80);
		expect(triggerMidTurnCompactCalls).toBe(1);
	});

	test("does not start another compact while the compact lock is held", () => {
		compactLocks.set(NARRATOR_ID, { kind: "history", mode: "background" } as never);
		try {
			makeHooks(() => false).onContextUsage(100);
			expect(triggerMidTurnCompactCalls).toBe(0);
		} finally {
			compactLocks.delete(NARRATOR_ID);
		}
	});

	test("suppresses compact when a prior compact finished but history not yet rebuilt", () => {
		// isCompactDone() === true simulates: background compact completed, executor
		// has not restarted/rebuilt history yet. hasPendingHistoryCompact is always
		// false for subagents (not in activeNarrators), so isCompactDone is the only
		// signal that can hold the guard — this is the regression under test.
		const { onContextUsage } = makeHooks(() => true);
		onContextUsage(100);
		expect(triggerMidTurnCompactCalls).toBe(0);
	});

	test("allows compact when no compact is pending (isCompactDone false)", () => {
		const { onContextUsage } = makeHooks(() => false);
		onContextUsage(100);
		// Guard is open → the compactStart branch fires triggerMidTurnCompact.
		expect(triggerMidTurnCompactCalls).toBe(1);
	});
});
