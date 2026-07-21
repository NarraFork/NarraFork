import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { consumeCleanShutdownState, markCleanShutdown, readCleanShutdownState } from "../../db/fts";
import { ShutdownActivityTracker } from "../shutdown-activity";

describe("ShutdownActivityTracker", () => {
	test("is not clean until drain completes even when every step succeeds", () => {
		const tracker = new ShutdownActivityTracker();
		tracker.recordStep("terminals", "ok");
		tracker.recordStep("mcp", "ok");

		expect(tracker.hasDegradedSteps).toBe(false);
		// Requests were never proven drained, so the clean marker must not be written.
		expect(tracker.isCleanShutdown()).toBe(false);
		expect(tracker.summary()).toMatchObject({ clean: false, drainComplete: false });
	});

	test("is clean when drain completes and all steps succeed", () => {
		const tracker = new ShutdownActivityTracker();
		tracker.recordStep("terminals", "ok");
		tracker.recordStep("mcp", "ok");
		tracker.markDrainComplete();

		expect(tracker.isCleanShutdown()).toBe(true);
		expect(tracker.summary()).toMatchObject({
			clean: true,
			drainComplete: true,
			degradedSteps: [],
		});
	});

	test("a timed-out step keeps the shutdown from being clean", () => {
		const tracker = new ShutdownActivityTracker();
		tracker.recordStep("terminals", "ok");
		tracker.recordStep("browser", "timeout");
		tracker.markDrainComplete();

		expect(tracker.hasDegradedSteps).toBe(true);
		expect(tracker.isCleanShutdown()).toBe(false);
		expect(tracker.summary().degradedSteps).toEqual([{ label: "browser", outcome: "timeout" }]);
	});

	test("a failed step keeps the shutdown from being clean", () => {
		const tracker = new ShutdownActivityTracker();
		tracker.recordStep("mcp", "failed");
		tracker.markDrainComplete();

		expect(tracker.hasDegradedSteps).toBe(true);
		expect(tracker.isCleanShutdown()).toBe(false);
		expect(tracker.summary().degradedSteps).toEqual([{ label: "mcp", outcome: "failed" }]);
	});

	test("summary reports every recorded step and only flags the degraded ones", () => {
		const tracker = new ShutdownActivityTracker();
		tracker.recordStep("a", "ok");
		tracker.recordStep("b", "timeout");
		tracker.recordStep("c", "failed");
		tracker.markDrainComplete();

		const summary = tracker.summary();
		expect(summary.steps).toEqual([
			{ label: "a", outcome: "ok" },
			{ label: "b", outcome: "timeout" },
			{ label: "c", outcome: "failed" },
		]);
		expect(summary.degradedSteps.map((step) => step.label)).toEqual(["b", "c"]);
		expect(summary.clean).toBe(false);
	});

	test("an empty tracker with no drain is not clean", () => {
		const tracker = new ShutdownActivityTracker();
		expect(tracker.isCleanShutdown()).toBe(false);
	});
});

describe("clean shutdown marker lifecycle", () => {
	test("startup consumes the marker before later initialization work", () => {
		const sqlite = new Database(":memory:");
		try {
			markCleanShutdown(sqlite);
			expect(readCleanShutdownState(sqlite)).toEqual({ wasClean: true });
			expect(consumeCleanShutdownState(sqlite)).toEqual({ wasClean: true });
			expect(readCleanShutdownState(sqlite)).toEqual({ wasClean: false });
			expect(consumeCleanShutdownState(sqlite)).toEqual({ wasClean: false });
		} finally {
			sqlite.close();
		}
	});
});
