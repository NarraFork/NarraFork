import { describe, expect, test } from "bun:test";
import {
	isActiveRunStatus,
	isRunOutcome,
	isUnfinishedRunStatus,
	runVerdict,
	SCHEDULED_RUN_STATUSES,
	taskLifecycle,
	verdictNeedsAttention,
} from "../scheduled-task-status";

describe("runVerdict", () => {
	test("a completed run is judged by what the model reported", () => {
		expect(runVerdict("completed", "done")).toBe("succeeded");
		expect(runVerdict("completed", "no_change")).toBe("succeeded");
		expect(runVerdict("completed", "partial")).toBe("incomplete");
		expect(runVerdict("completed", "blocked")).toBe("incomplete");
	});

	test("a completed run nobody reported on is neither a success nor a failure", () => {
		expect(runVerdict("completed", null)).toBe("unconfirmed");
		expect(runVerdict("completed", undefined)).toBe("unconfirmed");
		expect(runVerdict("completed", "something else")).toBe("unconfirmed");
	});

	test("optional reporting preserves observed completion without claiming success", () => {
		expect(runVerdict("completed", null, false)).toBe("completed");
		expect(runVerdict("completed", "done", false)).toBe("succeeded");
		expect(runVerdict("completed", "partial", false)).toBe("incomplete");
		expect(runVerdict("failed", null, false)).toBe("failed");
		expect(verdictNeedsAttention(runVerdict("completed", null, false))).toBe(false);
	});

	test("queued work is unfinished but has no execution or report authority", () => {
		expect(runVerdict("waiting", null)).toBe("waiting");
		expect(isActiveRunStatus("waiting")).toBe(false);
		expect(isUnfinishedRunStatus("waiting")).toBe(true);
		expect(isUnfinishedRunStatus("running")).toBe(true);
		expect(isUnfinishedRunStatus("blocked")).toBe(true);
		expect(isUnfinishedRunStatus("completed")).toBe(false);
		expect(isUnfinishedRunStatus(null)).toBe(false);
		expect(verdictNeedsAttention("waiting")).toBe(false);
	});
	test("what the server observed outranks what the model said", () => {
		// A model that reported "done" and then hit a provider error did not succeed.
		expect(runVerdict("failed", "done")).toBe("failed");
		expect(runVerdict("timed_out", "done")).toBe("timed_out");
		expect(runVerdict("interrupted", "done")).toBe("interrupted");
	});

	test("the legacy status only ever meant the prompt was sent", () => {
		expect(runVerdict("success", null)).toBe("dispatched");
		expect(runVerdict("success", "done")).toBe("dispatched");
		expect(runVerdict(null, null)).toBe("dispatched");
	});

	test("every status maps to a verdict of its own or a named one", () => {
		for (const status of SCHEDULED_RUN_STATUSES) {
			expect(typeof runVerdict(status, null)).toBe("string");
		}
	});
});

describe("attention", () => {
	test("failures, stalls and self-reported shortfalls ask for a look", () => {
		for (const verdict of [
			"failed",
			"timed_out",
			"incomplete",
			"blocked",
			"interrupted",
		] as const) {
			expect(verdictNeedsAttention(verdict)).toBe(true);
		}
	});

	test("an unreported run does not, nor does ordinary progress", () => {
		for (const verdict of [
			"unconfirmed",
			"succeeded",
			"running",
			"skipped",
			"missed",
			"dispatched",
		] as const) {
			expect(verdictNeedsAttention(verdict)).toBe(false);
		}
	});
});

describe("lifecycle", () => {
	test("ended wins over the enabled flag", () => {
		expect(taskLifecycle({ enabled: true, completedAt: "2026-11-30T23:00:00.000Z" })).toBe("ended");
		expect(taskLifecycle({ enabled: false, completedAt: "2026-11-30T23:00:00.000Z" })).toBe(
			"ended",
		);
	});

	test("otherwise the task is active or paused", () => {
		expect(taskLifecycle({ enabled: true, completedAt: null })).toBe("active");
		expect(taskLifecycle({ enabled: false, completedAt: null })).toBe("paused");
	});
});

describe("guards", () => {
	test("only in-flight statuses are active", () => {
		expect(isActiveRunStatus("running")).toBe(true);
		expect(isActiveRunStatus("blocked")).toBe(true);
		expect(isActiveRunStatus("completed")).toBe(false);
		expect(isActiveRunStatus(null)).toBe(false);
	});

	test("outcomes are a closed set", () => {
		expect(isRunOutcome("done")).toBe(true);
		expect(isRunOutcome("finished")).toBe(false);
		expect(isRunOutcome(undefined)).toBe(false);
	});
});
