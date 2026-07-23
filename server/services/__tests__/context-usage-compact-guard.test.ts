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

// Force the "pruning window disabled" path (compactStart <= pruneStart) so that
// percentage >= compactStart synchronously reaches triggerMidTurnCompact without
// awaiting the prune-boundary callback — making the guard's effect deterministic.
mock.module("../../lib/settings", () => ({
	...realSettings,
	getContextThresholds: () => ({ pruneStart: 80, compactStart: 80, hardLimit: 95 }),
}));

const { buildContextManagementHooks } = await import("../narrator-session");

const NARRATOR_ID = "sub-guard-test";

function makeHooks(isCompactDone: () => boolean) {
	return buildContextManagementHooks({
		narratorId: NARRATOR_ID,
		locale: "en",
		isSubagent: true,
		getModel: () => "test-model",
		getProvider: () => "anthropic",
		getPruneBoundary: () => null,
		setPruneBoundary: () => {},
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
