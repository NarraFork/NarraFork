import { describe, expect, test } from "bun:test";
import {
	coerceProgressSnapshot,
	createThrottledProgressReporter,
	type ProgressSnapshot,
	phaseChars,
	shouldShowThinkingChars,
	THINKING_CHARS_MIN_DISPLAY,
} from "../progress-phase";

describe("shouldShowThinkingChars", () => {
	test("hides a count below the display threshold", () => {
		expect(shouldShowThinkingChars(0)).toBe(false);
		expect(shouldShowThinkingChars(THINKING_CHARS_MIN_DISPLAY - 1)).toBe(false);
	});

	test("shows a count at or above the threshold", () => {
		expect(shouldShowThinkingChars(THINKING_CHARS_MIN_DISPLAY)).toBe(true);
		expect(shouldShowThinkingChars(4000)).toBe(true);
	});

	test("treats absent/invalid counts as nothing to show", () => {
		expect(shouldShowThinkingChars(undefined)).toBe(false);
		expect(shouldShowThinkingChars(null)).toBe(false);
		expect(shouldShowThinkingChars(Number.NaN)).toBe(false);
	});
});

describe("coerceProgressSnapshot", () => {
	test("normalizes a payload from an older single-phase server", () => {
		// Pre-two-phase servers send only outputChars — that must degrade to exactly
		// the previous behaviour rather than showing a phantom thinking phase.
		expect(coerceProgressSnapshot({ outputChars: 42 })).toEqual({
			phase: "output",
			thinkingChars: 0,
			outputChars: 42,
		});
	});

	test("floors and clamps counts, and rejects an unknown phase", () => {
		expect(
			coerceProgressSnapshot({ phase: "bogus", thinkingChars: 12.9, outputChars: -5 }),
		).toEqual({ phase: "output", thinkingChars: 12, outputChars: 0 });
	});

	test("keeps a valid thinking phase", () => {
		expect(coerceProgressSnapshot({ phase: "thinking", thinkingChars: 7 })).toEqual({
			phase: "thinking",
			thinkingChars: 7,
			outputChars: 0,
		});
	});
});

describe("phaseChars", () => {
	test("features the count matching the current phase", () => {
		const snapshot: ProgressSnapshot = { phase: "thinking", thinkingChars: 30, outputChars: 5 };
		expect(phaseChars(snapshot)).toBe(30);
		expect(phaseChars({ ...snapshot, phase: "output" })).toBe(5);
	});
});

describe("createThrottledProgressReporter", () => {
	/** Drain the throttle window (the reporter uses setTimeout internally). */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

	test("publishes thinking-phase progress even though outputChars stays 0", async () => {
		// The regression this guards: a de-duplication key of only `outputChars`
		// dropped EVERY thinking-phase update, because that count is 0 for the whole
		// thinking window.
		const seen: ProgressSnapshot[] = [];
		const reporter = createThrottledProgressReporter((s) => seen.push(s), 5);

		reporter.addThinking("a".repeat(50));
		await settle();

		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual({ phase: "thinking", thinkingChars: 50, outputChars: 0 });
		reporter.finish();
	});

	test("flushes a phase switch immediately instead of waiting out the window", async () => {
		const seen: ProgressSnapshot[] = [];
		// A short window so the thinking snapshot actually publishes, then a switch
		// must correct the visible label without waiting for the next tick.
		const reporter = createThrottledProgressReporter((s) => seen.push(s), 5);

		reporter.addThinking("x".repeat(30));
		await settle();
		expect(seen.at(-1)?.phase).toBe("thinking");

		const beforeSwitch = seen.length;
		reporter.addOutput("hello");
		// Synchronous: no await. A displayed "thinking" label must not survive the
		// arrival of real output for a whole throttle window.
		expect(seen).toHaveLength(beforeSwitch + 1);
		expect(seen.at(-1)).toEqual({ phase: "output", thinkingChars: 30, outputChars: 5 });
		reporter.finish();
	});

	test("waits for the normal window when nothing has been published yet", async () => {
		// With no published snapshot there is no stale label to correct, so a phase
		// switch inside the first window does NOT need its own flush — the already
		// scheduled tick publishes the (correct) output phase.
		const seen: ProgressSnapshot[] = [];
		const reporter = createThrottledProgressReporter((s) => seen.push(s), 10_000);

		reporter.addThinking("x".repeat(30));
		reporter.addOutput("hello");
		expect(seen).toHaveLength(0);

		reporter.finish();
		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual({ phase: "output", thinkingChars: 30, outputChars: 5 });
	});

	test("never moves the phase back to thinking once output started", async () => {
		const seen: ProgressSnapshot[] = [];
		const reporter = createThrottledProgressReporter((s) => seen.push(s), 5);

		reporter.addOutput("abc");
		await settle();
		reporter.addThinking("late reasoning delta");
		await settle();
		reporter.finish();

		expect(seen.every((s) => s.phase === "output")).toBe(true);
		// The thinking count still accumulates in the background.
		expect(seen.at(-1)?.thinkingChars).toBe("late reasoning delta".length);
	});

	test("does not republish an unchanged snapshot", async () => {
		const seen: ProgressSnapshot[] = [];
		const reporter = createThrottledProgressReporter((s) => seen.push(s), 5);

		reporter.addOutput("abc");
		await settle();
		const afterFirst = seen.length;
		reporter.addOutput(""); // empty delta → nothing moved
		await settle();
		reporter.finish();

		expect(seen).toHaveLength(afterFirst);
	});

	test("stops publishing after finish()", async () => {
		const seen: ProgressSnapshot[] = [];
		const reporter = createThrottledProgressReporter((s) => seen.push(s), 5);

		reporter.addOutput("abc");
		reporter.finish();
		const afterFinish = seen.length;
		reporter.addOutput("more");
		reporter.finish();
		await settle();

		expect(seen).toHaveLength(afterFinish);
	});

	test("is a no-op without a publish callback", () => {
		const reporter = createThrottledProgressReporter();
		expect(() => {
			reporter.addThinking("a");
			reporter.addOutput("b");
			reporter.finish();
		}).not.toThrow();
	});
});
