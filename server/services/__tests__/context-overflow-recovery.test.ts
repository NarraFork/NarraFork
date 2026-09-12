import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the two dependency modules BEFORE importing the unit under test so the
// module-level `import { ... } from "./narrator-session"` in narrator-recovery
// binds to these controllable stubs. Bun's mock.module is process-global, so
// afterAll re-points them back to the real implementations to avoid leaking
// into later-loaded suites.
const realNarratorService = { ...(await import("../narrator-service")) };
const realNarratorSession = { ...(await import("../narrator-session")) };

let latestCompactSeqQueue: Array<number | null>;
let markCompactAsBlockingCalls: number;
let awaitCompactCompletionCalls: number;
let runCustomCompactCalls: number;
let awaitCompactImpl: (narratorId: string, signal?: AbortSignal) => Promise<void>;
let runCustomCompactImpl: () => Promise<boolean>;

function nextLatestCompactSeq(): number | null {
	// Return the head of the queue, keeping the last value sticky for repeated reads.
	return latestCompactSeqQueue.length > 1
		? (latestCompactSeqQueue.shift() ?? null)
		: (latestCompactSeqQueue[0] ?? null);
}

mock.module("../narrator-service", () => ({
	...realNarratorService,
	narratorService: {
		...realNarratorService.narratorService,
		getLatestCompactSeq: mock(async () => nextLatestCompactSeq()),
		getCompactBoundaryMessage: mock(async () => "boundary-msg"),
		getEmergencyCompactBoundaryMessage: mock(async () => null),
	},
}));

mock.module("../narrator-session", () => ({
	...realNarratorSession,
	awaitCompactCompletion: mock((narratorId: string, signal?: AbortSignal) => {
		awaitCompactCompletionCalls++;
		return awaitCompactImpl(narratorId, signal);
	}),
	markCompactAsBlocking: mock(async () => {
		markCompactAsBlockingCalls++;
	}),
	runCustomCompact: mock(() => {
		runCustomCompactCalls++;
		return runCustomCompactImpl();
	}),
}));

const { handleContextOverflow } = await import("../narrator-recovery");
const { compactLocks } = await import("../narrator-session-state");

const NARRATOR_ID = "n-overflow";

function seedInflightBackgroundCompact(compacted: boolean) {
	compactLocks.set(NARRATOR_ID, {
		kind: "history",
		mode: "background",
		promise: Promise.resolve({ kind: "history", compacted, mode: "background" }),
	} as never);
}

beforeEach(() => {
	latestCompactSeqQueue = [null];
	markCompactAsBlockingCalls = 0;
	awaitCompactCompletionCalls = 0;
	runCustomCompactCalls = 0;
	awaitCompactImpl = async () => {};
	runCustomCompactImpl = async () => true;
	compactLocks.clear();
});

afterEach(() => {
	compactLocks.clear();
});

afterAll(() => {
	mock.module("../narrator-service", () => realNarratorService);
	mock.module("../narrator-session", () => realNarratorSession);
	mock.restore();
});

describe("handleContextOverflow — wait for in-flight compact before spending retry quota", () => {
	test("waits for an in-flight background compact even when the retry quota is already exhausted", async () => {
		// The failed request built history at seq -1 (baseline). A background compact
		// is in flight and will land seq 5 by the time we re-check.
		seedInflightBackgroundCompact(true);
		// getLatestCompactSeq: first read (Phase A pre-wait) sees stale -1/null,
		// the post-wait read sees the completed compact at seq 5.
		latestCompactSeqQueue = [null, 5];

		const result = await handleContextOverflow({
			narratorId: NARRATOR_ID,
			locale: "en",
			provider: "anthropic",
			model: "test-model",
			// Already at the ceiling — the OLD code would immediately fail here.
			overflowRetries: 2,
			maxRetries: 2,
			baselineCompactSeq: -1,
		});

		expect(result.action).toBe("retry_compacted");
		// Waiting for a compact must NOT consume the retry quota.
		expect(result.overflowRetries).toBe(2);
		expect(markCompactAsBlockingCalls).toBe(1);
		expect(awaitCompactCompletionCalls).toBe(1);
		// No fresh emergency compact should have been started.
		expect(runCustomCompactCalls).toBe(0);
	});

	test("a compact that already completed (seq advanced) retries without spending quota", async () => {
		// No in-flight lock, but the latest compact seq is already ahead of baseline.
		latestCompactSeqQueue = [7];

		const result = await handleContextOverflow({
			narratorId: NARRATOR_ID,
			locale: "en",
			provider: "anthropic",
			model: "test-model",
			overflowRetries: 2,
			maxRetries: 2,
			baselineCompactSeq: -1,
		});

		expect(result.action).toBe("retry_compacted");
		expect(result.overflowRetries).toBe(2);
		expect(awaitCompactCompletionCalls).toBe(0);
		expect(runCustomCompactCalls).toBe(0);
	});

	test("fails with max_retries_exceeded only when there is no compact to ride on", async () => {
		// No in-flight compact, seq never advances past baseline.
		latestCompactSeqQueue = [null];

		const result = await handleContextOverflow({
			narratorId: NARRATOR_ID,
			locale: "en",
			provider: "anthropic",
			model: "test-model",
			overflowRetries: 2,
			maxRetries: 2,
			baselineCompactSeq: -1,
		});

		expect(result).toEqual({
			action: "failed",
			overflowRetries: 3,
			reason: "max_retries_exceeded",
		});
		// Phase B was reached but immediately tripped the quota — no compact started.
		expect(runCustomCompactCalls).toBe(0);
	});

	test.each([
		"anthropic",
		"codex",
	])("%s starts emergency compact on the first overflow", async (provider) => {
		latestCompactSeqQueue = [null];
		runCustomCompactImpl = async () => true;

		const result = await handleContextOverflow({
			narratorId: NARRATOR_ID,
			locale: "en",
			provider,
			model: "test-model",
			overflowRetries: 0,
			maxRetries: 2,
			baselineCompactSeq: -1,
		});

		expect(result.action).toBe("retry_compacted");
		// A real recovery attempt consumes one unit of quota.
		expect(result.overflowRetries).toBe(1);
		expect(runCustomCompactCalls).toBe(1);
	});

	test("an aborted in-flight compact wait does not fail as compact_noop and reports the interrupt", async () => {
		seedInflightBackgroundCompact(false);
		latestCompactSeqQueue = [null, null];
		const controller = new AbortController();
		// Simulate the wait being interrupted by a user/parent abort.
		awaitCompactImpl = async (_id, signal) => {
			controller.abort();
			const err = new Error("aborted");
			err.name = "AbortError";
			// Reflect the aborted signal the caller passed in.
			void signal;
			throw err;
		};

		const result = await handleContextOverflow({
			narratorId: NARRATOR_ID,
			locale: "en",
			provider: "anthropic",
			model: "test-model",
			overflowRetries: 0,
			maxRetries: 2,
			baselineCompactSeq: -1,
			signal: controller.signal,
		});

		// Interrupted wait is surfaced without starting a fresh emergency compact.
		expect(result.action).toBe("failed");
		expect(runCustomCompactCalls).toBe(0);
	});
});
