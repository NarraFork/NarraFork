/**
 * narrator-compact-watchdog.test.ts — The compact watchdog's contract.
 *
 * The bug this locks down: compact used to be bounded by racing a total-duration
 * timer. When that timer won, the lock was released while the compact kept
 * running, so its `[Compacting]` marker stayed live and the next trigger inserted
 * a SECOND marker over the same stale context (two "compacting · 0 chars" rows
 * side by side, neither shrinking the context). The same total budget also killed
 * healthy multi-chunk compacts of large contexts.
 *
 * So the watchdog must (a) bound INACTIVITY, not total duration, (b) treat chunk
 * boundaries and stream deltas as progress, and (c) abort rather than race, so the
 * caller can await the real settlement before freeing the lock.
 *
 * Aborting instead of racing has its own hazard — the lock is held until the
 * aborted run settles, so a provider that ignores its AbortSignal would silently
 * disable compaction for that narrator. The grace timer makes that loud.
 *
 * Timing note: the windows below are deliberately in the hundreds of
 * milliseconds. Tight 20-40ms windows read the same on paper but a single GC
 * pause is enough to make them flake.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const realNarratorWs = { ...(await import("../../websocket/narrator-ws")) };

let broadcasts: Array<Record<string, unknown>> = [];

mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWs,
	broadcastToNarrator: (_narratorId: string, message: Record<string, unknown>) => {
		broadcasts.push(message);
	},
}));

const { createCompactWatchdog, createCompactProgressReporter } = await import(
	"../narrator-compact"
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Long enough that no timer under test can fire by accident. */
const NEVER = 60_000;

beforeEach(() => {
	broadcasts = [];
});

afterAll(() => {
	mock.module("../../websocket/narrator-ws", () => realNarratorWs);
	mock.restore();
});

describe("compact watchdog", () => {
	test("fires with a stall reason when no progress arrives", async () => {
		const reasons: string[] = [];
		const watchdog = createCompactWatchdog({
			narratorId: "n-watchdog",
			onTimeout: (reason) => reasons.push(reason),
			stallMs: 150,
			maxTotalMs: NEVER,
			abortGraceMs: NEVER,
		});

		await sleep(400);
		watchdog.stop();

		expect(reasons).toHaveLength(1);
		expect(watchdog.firedReason()).toBe(reasons[0]);
		expect(reasons[0]).toContain("no progress");
	});

	test("a slow but advancing compact is never aborted", async () => {
		// This is the healthy multi-chunk cascade the old total-duration budget killed:
		// total runtime far exceeds the stall window, but each beat proves liveness.
		let fired = 0;
		const watchdog = createCompactWatchdog({
			narratorId: "n-watchdog",
			onTimeout: () => fired++,
			stallMs: 200,
			maxTotalMs: NEVER,
			abortGraceMs: NEVER,
		});

		for (let i = 0; i < 6; i++) {
			await sleep(100);
			watchdog.beat();
		}
		await sleep(100);
		watchdog.stop();

		expect(fired).toBe(0);
		expect(watchdog.firedReason()).toBeNull();
	});

	test("the total ceiling still bounds a compact that only trickles", async () => {
		const reasons: string[] = [];
		const watchdog = createCompactWatchdog({
			narratorId: "n-watchdog",
			onTimeout: (reason) => reasons.push(reason),
			stallMs: NEVER,
			maxTotalMs: 150,
			abortGraceMs: NEVER,
		});

		const beater = setInterval(() => watchdog.beat(), 20);
		await sleep(400);
		clearInterval(beater);
		watchdog.stop();

		expect(reasons).toHaveLength(1);
		expect(reasons[0]).toContain("ceiling");
	});

	test("stop() prevents any later firing", async () => {
		let fired = 0;
		const watchdog = createCompactWatchdog({
			narratorId: "n-watchdog",
			onTimeout: () => fired++,
			stallMs: 100,
			maxTotalMs: 150,
			abortGraceMs: 100,
		});
		watchdog.stop();
		// A beat after stop must not re-arm the stall timer.
		watchdog.beat();
		await sleep(400);

		expect(fired).toBe(0);
	});

	test("fires at most once", async () => {
		let fired = 0;
		const watchdog = createCompactWatchdog({
			narratorId: "n-watchdog",
			onTimeout: () => fired++,
			stallMs: 100,
			maxTotalMs: 120,
			abortGraceMs: NEVER,
		});
		await sleep(500);
		watchdog.stop();

		expect(fired).toBe(1);
	});

	test("stream deltas beat the watchdog before the broadcast throttle would", async () => {
		// Liveness must not be tied to the throttled WS broadcast: a compact that
		// streams slower than the throttle window is still making progress.
		let beats = 0;
		const reporter = createCompactProgressReporter({
			narratorId: "n-watchdog",
			messageId: "compact-1",
			mode: "blocking",
			onActivity: () => beats++,
		});

		reporter.onReasoningDelta("thinking");
		reporter.onTextDelta("summary");
		reporter.onTextDelta("");
		reporter.finish();

		expect(beats).toBe(2);
	});

	test("reports a run that never settles after the abort, since the lock stays held", async () => {
		// The provider ignored the AbortSignal, so the compact promise never settles
		// and `stop()` is never reached. Nothing can free the lock here, but the
		// narrator must not lose compaction silently.
		const stuck: Array<{ narratorId: string; reason: string }> = [];
		const watchdog = createCompactWatchdog({
			narratorId: "n-watchdog",
			onTimeout: () => {},
			stallMs: 100,
			maxTotalMs: NEVER,
			abortGraceMs: 150,
			onAbortNotSettled: ({ narratorId, reason }) => stuck.push({ narratorId, reason }),
		});

		await sleep(500);
		watchdog.stop();

		expect(stuck).toHaveLength(1);
		expect(stuck[0].narratorId).toBe("n-watchdog");
		expect(stuck[0].reason).toContain("no progress");
	});

	test("a run that settles promptly after the abort is not reported as stuck", async () => {
		const stuck: string[] = [];
		const watchdog = createCompactWatchdog({
			narratorId: "n-watchdog",
			// The real caller aborts here; the run then rejects and the caller calls
			// stop(). Model that as an immediate stop().
			onTimeout: () => watchdog.stop(),
			stallMs: 100,
			maxTotalMs: NEVER,
			abortGraceMs: 150,
			onAbortNotSettled: ({ reason }) => stuck.push(reason),
		});

		await sleep(500);

		expect(watchdog.firedReason()).toContain("no progress");
		expect(stuck).toHaveLength(0);
	});
});
