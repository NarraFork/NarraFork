import { describe, expect, test } from "bun:test";
import { activeWatchesByTarget, watchTargetKey } from "./background-task-filter";
import { watchOutcome, watchTargetName } from "./WatchTaskRow";

describe("watch row", () => {
	test("outcome distinguishes watching, deadline, match, target end, cancel and failure", () => {
		const agent = { type: "agent" as const };
		const bashFor = { type: "bash" as const, pattern: "ready" };
		const terminalFor = { type: "terminal" as const, pattern: "PASS" };
		expect(watchOutcome({ status: "running", output: null }, agent)).toBe("watching");
		expect(
			watchOutcome(
				{ status: "completed", output: "Watch reached its deadline for agent a" },
				agent,
			),
		).toBe("deadline");
		expect(
			watchOutcome({ status: "completed", output: "Watch bash b: found.\n\nready" }, bashFor),
		).toBe("matched");
		expect(watchOutcome({ status: "completed", output: "Watch agent a: completed." }, agent)).toBe(
			"ended",
		);
		expect(watchOutcome({ status: "completed", output: "PASS seen" }, terminalFor)).toBe("matched");
		expect(watchOutcome({ status: "cancelled", output: null }, agent)).toBe("cancelled");
		expect(watchOutcome({ status: "failed", output: "x" }, agent)).toBe("failed");
	});

	test("a target that ends without the pattern, or is replaced, is not a success", () => {
		const bashFor = { type: "bash" as const, pattern: "ready" };
		const agent = { type: "agent" as const };
		expect(watchOutcome({ status: "completed", output: "Watch bash b: completed." }, bashFor)).toBe(
			"ended",
		);
		expect(watchOutcome({ status: "completed", output: "Watch bash b: failed." }, bashFor)).toBe(
			"stopped",
		);
		expect(watchOutcome({ status: "completed", output: "Watch agent a: superseded." }, agent)).toBe(
			"replaced",
		);
		expect(watchOutcome({ status: "completed", output: "Watch agent a: taken_over." }, agent)).toBe(
			"replaced",
		);
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
