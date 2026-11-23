import { describe, expect, test } from "bun:test";
import { activeWatchesByTarget, watchTargetKey } from "./background-task-filter";
import { watchOutcome, watchTargetName } from "./WatchTaskRow";

describe("watch row", () => {
	test("outcome distinguishes watching, deadline, match, target end, cancel and failure", () => {
		expect(watchOutcome({ status: "running", output: null }, true)).toBe("watching");
		expect(
			watchOutcome(
				{ status: "completed", output: "Watch reached its deadline for agent a" },
				false,
			),
		).toBe("deadline");
		expect(watchOutcome({ status: "completed", output: "Watch bash b: completed." }, true)).toBe(
			"matched",
		);
		expect(watchOutcome({ status: "completed", output: "Watch agent a: completed." }, false)).toBe(
			"ended",
		);
		expect(watchOutcome({ status: "cancelled", output: null }, false)).toBe("cancelled");
		expect(watchOutcome({ status: "failed", output: "x" }, false)).toBe("failed");
	});

	test("target name drops the watch prefix and a terminal title's pattern suffix", () => {
		expect(watchTargetName("watch agent Fix login", undefined)).toBe("Fix login");
		expect(watchTargetName("watch bash build", "done")).toBe("build");
		expect(watchTargetName("watch dev-server: ready on", "ready on")).toBe("dev-server");
		expect(watchTargetName(null, undefined)).toBeNull();
	});

	test("groups only active, parseable watches by their target", () => {
		const watches = [
			{ id: "w1", status: "running", command: '[watch] agent "child" run "r" timeout 1000' },
			{ id: "w2", status: "running", command: '[watch] bash "b1" run null for "ok"' },
			{ id: "w3", status: "completed", command: '[watch] agent "child" run "r"' },
			{ id: "w4", status: "running", command: '[terminal watch] "t"' },
		];
		const grouped = activeWatchesByTarget(watches);
		expect(grouped.get(watchTargetKey("agent", "child"))?.map((w) => w.id)).toEqual(["w1"]);
		expect(grouped.get(watchTargetKey("bash", "b1"))?.map((w) => w.id)).toEqual(["w2"]);
		expect(grouped.size).toBe(2);
	});
});
